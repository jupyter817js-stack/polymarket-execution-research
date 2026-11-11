import {
  AssetType,
  Side,
  type ClobClient
} from "@polymarket/clob-client-v2";

import type { Logger } from "pino";

import { config } from "../config.js";
import type {
  BinaryMarket,
  NormalizedOrderBook,
  OpportunityLeg,
  OrderResolution,
  PostedOrderResponse,
  SameMarketOpportunity
} from "../types.js";
import { clampPrice, getExecutableTickSize, roundDownToTick, roundUpToTick, sleep } from "../utils.js";
import { readMaxAllowanceRaw } from "../polymarket/balance-allowance.js";
import { pollConditionalBalanceUntilSufficient } from "../polymarket/balance-poller.js";
import { OrderBookStore } from "../polymarket/orderbook-store.js";
import { UserWsTracker } from "../polymarket/user-ws.js";
import { calculateBuyFill, calculateSellFill } from "../strategy/vwap.js";
import { reconcileExpectedConditionalBalances } from "./execution-state-reconciler.js";
import type { TrackedInventoryPosition } from "../core/inventory-lot-tracker.js";
import {
  getAggressiveEntryTif,
  getAggressiveExitTif,
  toSdkOrderType
} from "./order-type-policy.js";

const asPostedResponses = (payload: unknown): PostedOrderResponse[] => {
  if (Array.isArray(payload)) {
    return payload as PostedOrderResponse[];
  }

  if (payload && typeof payload === "object" && "orders" in payload) {
    const candidate = (payload as { orders?: unknown }).orders;
    return Array.isArray(candidate) ? (candidate as PostedOrderResponse[]) : [];
  }

  return [];
};

const isImmediateFill = (response: PostedOrderResponse): boolean => {
  const status = response.status?.toLowerCase();
  return Boolean(response.success) && (status === "matched" || (response.tradeIDs?.length ?? 0) > 0);
};

const asErrorStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || !error || !("status" in error)) {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

const summarizeResponse = (response: PostedOrderResponse | undefined) => ({
  success: response?.success,
  orderID: response?.orderID,
  status: response?.status,
  tradeIDs: response?.tradeIDs,
  takingAmount: response?.takingAmount,
  makingAmount: response?.makingAmount,
  errorMsg: response?.errorMsg
});

const rawUsdcToDecimal = (rawBalance: string): number => Number(rawBalance) / 1_000_000;
const asErrorMessage = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined;
const asPositiveNumber = (value: string | number | undefined): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const asActualFilledSize = (
  response: PostedOrderResponse | undefined,
  side: Side,
  fallbackSize: number
): number => {
  const rawSize = side === Side.BUY ? response?.takingAmount : response?.makingAmount;
  return asPositiveNumber(rawSize) ?? fallbackSize;
};

const asActualFilledNotional = (
  response: PostedOrderResponse | undefined,
  side: Side
): number | undefined => {
  const rawNotional = side === Side.BUY ? response?.makingAmount : response?.takingAmount;
  return asPositiveNumber(rawNotional);
};

const FULL_SET_PAYOUT_PER_SHARE = 1;
const EPSILON = 1e-9;

type EmergencySellResult = {
  soldShares: number;
  proceedsUsdc: number;
};

const resolutionHasExposure = (
  resolution: OrderResolution | undefined
): resolution is OrderResolution =>
  Boolean(
    resolution &&
      resolution.size > EPSILON &&
      (resolution.state === "filled" || resolution.state === "partially_filled")
  );

const normalizeResolution = (
  resolution: OrderResolution,
  requestedSize: number
): OrderResolution => {
  if (
    resolution.state === "filled" &&
    requestedSize > EPSILON &&
    resolution.size + EPSILON < requestedSize
  ) {
    return {
      ...resolution,
      state: "partially_filled"
    };
  }

  return resolution;
};

type OrderExecutionSnapshot = {
  leg: OpportunityLeg;
  response: PostedOrderResponse | undefined;
};

type PendingResolution = {
  index: 0 | 1;
  resolution: OrderResolution;
};

type InitialOrderAssessment =
  | {
      resolution: OrderResolution;
      delayedOrderId?: undefined;
    }
  | {
      resolution?: undefined;
      delayedOrderId: string;
    };

export interface ArbitrageExecutionSummary {
  status:
    | "skipped_open_exposure"
    | "skipped_insufficient_cash"
    | "fully_filled"
    | "no_fill"
    | "recovered_pair"
    | "emergency_unwind"
    | "residual_exposure";
  realizedPnlUsdc?: number;
  detail?: string;
  stateMismatchDetail?: string;
  openedPositions?: TrackedInventoryPosition[];
  /** Timestamp of the first fill received (YES or NO leg). */
  firstFillAtMs?: number;
  /** Total number of partial fill events across both legs. */
  partialFillCount?: number;
}

export class ArbitrageExecutor {
  constructor(
    private readonly client: ClobClient,
    private readonly store: OrderBookStore,
    private readonly logger: Logger,
    private readonly userTracker?: UserWsTracker
  ) {}

  async execute(opportunity: SameMarketOpportunity): Promise<ArbitrageExecutionSummary> {
    const [legA, legB] = opportunity.legs;
    const hasOpenExposure = await this.hasOpenMarketExposure(opportunity.market);

    if (hasOpenExposure) {
      return {
        status: "skipped_open_exposure",
        detail: "Market already had open conditional-token balances."
      };
    }

    const hasEnoughCash = await this.hasEnoughCashForOrder(opportunity);

    if (!hasEnoughCash) {
      return {
        status: "skipped_insufficient_cash",
        detail: "Collateral balance was below the configured pre-trade threshold."
      };
    }

    this.logger.info(
      {
        market: opportunity.market.slug,
        grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
        netEdge: opportunity.netEdge.toFixed(4),
        shares: opportunity.shares
      },
      "Executing same-market arbitrage."
    );

    const responses = await this.postEntryOrdersInParallel(opportunity);
    // Record when the exchange acknowledged the orders — immediate fills happened at this point.
    const postsCompletedAtMs = Date.now();

    this.logger.info(
      {
        market: opportunity.market.slug,
        legA: {
          outcome: legA.outcome,
          ...summarizeResponse(responses[0])
        },
        legB: {
          outcome: legB.outcome,
          ...summarizeResponse(responses[1])
        }
      },
      "Posted arbitrage orders in a single batch request."
    );

    const attempts: [OrderExecutionSnapshot, OrderExecutionSnapshot] = [
      { leg: legA, response: responses[0] },
      { leg: legB, response: responses[1] }
    ];
    const resolutions: [OrderResolution | undefined, OrderResolution | undefined] = [
      undefined,
      undefined
    ];
    const delayedResolutions = new Map<0 | 1, Promise<PendingResolution>>();
    // Tracks the actual moment the first leg fill was confirmed.
    let firstFillAtMs: number | undefined;

    for (const index of [0, 1] as const) {
      const assessment = this.assessPostedOrder(
        attempts[index].response,
        opportunity.shares,
        attempts[index].leg.outcome,
        Side.BUY
      );

      if (assessment.resolution) {
        resolutions[index] = assessment.resolution;
        // Immediate fill — exchange confirmed at postsCompletedAtMs.
        firstFillAtMs ??= postsCompletedAtMs;
        continue;
      }

      delayedResolutions.set(
        index,
        this.awaitDelayedOrderResolution(assessment.delayedOrderId, opportunity.shares).then(
          (resolution) => ({
            index,
            resolution
          })
        )
      );
    }

    if (resolutions[0] && resolutions[1]) {
      return this.finalizePairExecution(opportunity, attempts, [
        resolutions[0],
        resolutions[1]
      ], firstFillAtMs ?? postsCompletedAtMs);
    }

    const earlyFilledIndex = resolutionHasExposure(resolutions[0])
      ? 0
      : resolutionHasExposure(resolutions[1])
        ? 1
        : undefined;

    if (earlyFilledIndex !== undefined) {
      firstFillAtMs ??= postsCompletedAtMs;
      const otherIndex = earlyFilledIndex === 0 ? 1 : 0;
      resolutions[otherIndex] =
        resolutions[otherIndex] ??
        (await this.stabilizeCounterOrderAfterSingleFill(
          opportunity.market.slug,
          attempts[otherIndex],
          opportunity.shares
        ));

      return this.finalizePairExecution(opportunity, attempts, [
        resolutions[0] as OrderResolution,
        resolutions[1] as OrderResolution
      ], firstFillAtMs);
    }

    while (delayedResolutions.size > 0) {
      const next = await Promise.race([...delayedResolutions.values()]);
      delayedResolutions.delete(next.index);
      resolutions[next.index] = next.resolution;

      if (resolutionHasExposure(next.resolution)) {
        // First delayed fill arrived — record the moment.
        firstFillAtMs ??= Date.now();
        const otherIndex = next.index === 0 ? 1 : 0;

        if (!resolutions[otherIndex]) {
          resolutions[otherIndex] = await this.stabilizeCounterOrderAfterSingleFill(
            opportunity.market.slug,
            attempts[otherIndex],
            opportunity.shares
          );
        }

        return this.finalizePairExecution(opportunity, attempts, [
          resolutions[0] as OrderResolution,
          resolutions[1] as OrderResolution
        ], firstFillAtMs);
      }

      if (resolutions[0] && resolutions[1]) {
        return this.finalizePairExecution(opportunity, attempts, [
          resolutions[0],
          resolutions[1]
        ], firstFillAtMs);
      }
    }

    return {
      status: "no_fill",
      detail: "Execution loop ended without a terminal filled pair."
    };
  }

  private async postEntryOrdersInParallel(
    opportunity: SameMarketOpportunity
  ): Promise<[PostedOrderResponse | undefined, PostedOrderResponse | undefined]> {
    const [orderA, orderB] = await Promise.all([
      this.client.createOrder(
        {
          tokenID: opportunity.legs[0].tokenId,
          price: opportunity.legs[0].limitPrice,
          size: opportunity.shares,
          side: Side.BUY,
          feeRateBps: opportunity.legs[0].feeRateBps
        },
        {
          tickSize: this.toTickString(opportunity.legs[0].tickSize)
        }
      ),
      this.client.createOrder(
        {
          tokenID: opportunity.legs[1].tokenId,
          price: opportunity.legs[1].limitPrice,
          size: opportunity.shares,
          side: Side.BUY,
          feeRateBps: opportunity.legs[1].feeRateBps
        },
        {
          tickSize: this.toTickString(opportunity.legs[1].tickSize)
        }
      )
    ]);

    try {
      const aggressiveEntryOrderType = toSdkOrderType(getAggressiveEntryTif());
      const responses = asPostedResponses(
        await this.client.postOrders([
          { order: orderA, orderType: aggressiveEntryOrderType },
          { order: orderB, orderType: aggressiveEntryOrderType }
        ])
      );
      return [responses[0], responses[1]];
    } catch (error) {
      this.logger.error(
        {
          err: error,
          market: opportunity.market.slug,
          outcomes: opportunity.legs.map((leg) => leg.outcome)
        },
        "Batch entry order request threw before responses could be classified."
      );
      const failureResponse: PostedOrderResponse = {
        success: false,
        errorMsg: asErrorMessage(error) ?? "batch entry order request threw"
      };
      return [failureResponse, failureResponse];
    }
  }

  private assessPostedOrder(
    response: PostedOrderResponse | undefined,
    fallbackSize: number,
    outcomeLabel: string,
    side: Side
  ): InitialOrderAssessment {
    if (!response?.success) {
      this.logger.error(
        {
          outcome: outcomeLabel,
          ...summarizeResponse(response)
        },
        "Order post failed before execution."
      );
      return {
        resolution: {
          state: "failed",
          size: 0,
          source: "response_status"
        }
      };
    }

    if (isImmediateFill(response)) {
      const size = asActualFilledSize(response, side, fallbackSize);
      const notional = asActualFilledNotional(response, side);
      return {
        resolution: normalizeResolution(
          {
            state: "filled",
            size,
            price:
              typeof notional === "number" && size > 0 ? notional / size : undefined,
            notional,
            source: "immediate"
          },
          fallbackSize
        )
      };
    }

    if (response.status?.toLowerCase() === "delayed" && response.orderID) {
      this.logger.warn(
        {
          orderID: response.orderID,
          outcome: outcomeLabel,
          timeoutMs: config.ws.userOrderTimeoutMs,
          pollIntervalMs: config.ws.orderPollIntervalMs
        },
        "Delayed order detected. Waiting on user websocket with REST polling fallback."
      );
      return {
        delayedOrderId: response.orderID
      };
    }

    this.logger.warn(
      {
        outcome: outcomeLabel,
        ...summarizeResponse(response)
      },
      "Order response did not indicate an immediate fill. Treating it as cancelled/unmatched."
    );
    return {
      resolution: {
        state: "cancelled",
        size: 0,
        source: "response_status"
      }
    };
  }

  private async stabilizeCounterOrderAfterSingleFill(
    market: string,
    attempt: OrderExecutionSnapshot,
    requestedSize: number
  ): Promise<OrderResolution> {
    const orderId = attempt.response?.orderID;

    if (!orderId) {
      return { state: "failed", size: 0, source: "response_status" };
    }

    this.logger.warn(
      {
        market,
        orderID: orderId,
        outcome: attempt.leg.outcome
      },
      "One leg filled first. Forcing the opposite order into a final state before recovery."
    );

    const cachedResolution = this.userTracker?.peekOrderOutcome(orderId);

    if (cachedResolution) {
      this.logger.info(
        { market, orderID: orderId, state: cachedResolution.state, source: "user_ws_cache" },
        "Recovered the opposite leg outcome from cached user websocket data."
      );
      return {
        ...cachedResolution,
        source: cachedResolution.source ?? "user_ws"
      };
    }

    const preCancelResolution = await this.pollOrderResolution(orderId, requestedSize);

    if (preCancelResolution) {
      this.logger.info(
        { market, orderID: orderId, state: preCancelResolution.state, source: "rest_poll" },
        "Recovered the opposite leg outcome via immediate REST check."
      );
      return {
        ...preCancelResolution,
        source: "rest_poll"
      };
    }

    const cancelIssued = await this.cancelOutstandingOrder(orderId, {
      market,
      outcome: attempt.leg.outcome,
      reason: "opposite leg filled; forcing counter-leg resolution"
    });
    const settleDeadline = Date.now() + Math.min(1_000, config.ws.orderPollIntervalMs * 2);

    while (Date.now() < settleDeadline) {
      const remainingMs = settleDeadline - Date.now();
      const knownResolution = this.userTracker?.peekOrderOutcome(orderId);

      if (knownResolution) {
        this.logger.info(
          { market, orderID: orderId, state: knownResolution.state, source: "user_ws_cache" },
          "Recovered the opposite leg outcome from cached user websocket data after cancel."
        );
        return {
          ...knownResolution,
          source: knownResolution.source ?? "user_ws"
        };
      }

      const polledResolution = await this.pollOrderResolution(orderId, requestedSize);

      if (polledResolution) {
        this.logger.info(
          { market, orderID: orderId, state: polledResolution.state, source: "rest_poll" },
          "Recovered the opposite leg outcome after explicit cancel."
        );
        return {
          ...polledResolution,
          source: "rest_poll"
        };
      }

      await sleep(Math.min(100, remainingMs));
    }

    if (cancelIssued) {
      this.logger.warn(
        { market, orderID: orderId, outcome: attempt.leg.outcome },
        "Counter order was cancelled before recovery because it did not settle in time."
      );
      return { state: "cancelled", size: 0, source: "timeout" };
    }

    this.logger.warn(
      { market, orderID: orderId, outcome: attempt.leg.outcome },
      "Counter order remained unresolved after forced cancel and short settlement checks."
    );
    return { state: "timed_out", size: 0, source: "timeout" };
  }

  private async finalizePairExecution(
    opportunity: SameMarketOpportunity,
    attempts: readonly [OrderExecutionSnapshot, OrderExecutionSnapshot],
    resolutions: readonly [OrderResolution, OrderResolution],
    firstFillAtMs?: number
  ): Promise<ArbitrageExecutionSummary> {
    await Promise.all([
      this.cancelResidualOrderIfNeeded(
        opportunity.market.slug,
        attempts[0].leg.outcome,
        attempts[0].response,
        resolutions[0],
        "post-resolution cleanup"
      ),
      this.cancelResidualOrderIfNeeded(
        opportunity.market.slug,
        attempts[1].leg.outcome,
        attempts[1].response,
        resolutions[1],
        "post-resolution cleanup"
      )
    ]);

    this.logger.info(
      {
        market: opportunity.market.slug,
        legA: {
          outcome: attempts[0].leg.outcome,
          state: resolutions[0].state,
          size: resolutions[0].size,
          price: resolutions[0].price,
          notional: resolutions[0].notional,
          source: resolutions[0].source
        },
        legB: {
          outcome: attempts[1].leg.outcome,
          state: resolutions[1].state,
          size: resolutions[1].size,
          price: resolutions[1].price,
          notional: resolutions[1].notional,
          source: resolutions[1].source
        }
      },
      "Resolved arbitrage order outcomes."
    );

    if (resolutions[0].state === "filled" && resolutions[1].state === "filled") {
      const realizedPnlUsdc =
        Math.min(resolutions[0].size, resolutions[1].size) -
        this.getFilledBuyCost(attempts[0].leg, resolutions[0]) -
        this.getFilledBuyCost(attempts[1].leg, resolutions[1]);
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        [
          {
            tokenId: attempts[0].leg.tokenId,
            expectedBalance: resolutions[0].size,
            label: `${opportunity.market.slug}:${attempts[0].leg.outcome}`
          },
          {
            tokenId: attempts[1].leg.tokenId,
            expectedBalance: resolutions[1].size,
            label: `${opportunity.market.slug}:${attempts[1].leg.outcome}`
          }
        ],
        opportunity.market.slug,
        "fully_filled"
      );
      this.logger.info(
        {
          market: opportunity.market.slug,
          shares: opportunity.shares,
          realizedPnlUsdc: realizedPnlUsdc.toFixed(4)
        },
        "Arbitrage pair filled successfully."
      );
      return {
        status: "fully_filled",
        realizedPnlUsdc,
        stateMismatchDetail,
        firstFillAtMs,
        partialFillCount: 1,
        openedPositions: [
          {
            tokenId: attempts[0].leg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: attempts[0].leg.outcome,
            shares: resolutions[0].size,
            totalCostUsdc: this.getFilledBuyCost(attempts[0].leg, resolutions[0]),
            openedAtMs: opportunity.detectedAtMs
          },
          {
            tokenId: attempts[1].leg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: attempts[1].leg.outcome,
            shares: resolutions[1].size,
            totalCostUsdc: this.getFilledBuyCost(attempts[1].leg, resolutions[1]),
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    const legAHasExposure = resolutionHasExposure(resolutions[0]);
    const legBHasExposure = resolutionHasExposure(resolutions[1]);

    if (!legAHasExposure && !legBHasExposure) {
      this.logger.info({ market: opportunity.market.slug }, "Arbitrage attempt did not fill.");
      return {
        status: "no_fill"
      };
    }

    if (legAHasExposure && legBHasExposure) {
      const pairedShares = Math.min(resolutions[0].size, resolutions[1].size);
      const imbalanceShares = Math.abs(resolutions[0].size - resolutions[1].size);
      const legACost = this.getFilledBuyCost(attempts[0].leg, resolutions[0]);
      const legBCost = this.getFilledBuyCost(attempts[1].leg, resolutions[1]);

      if (imbalanceShares <= EPSILON) {
        const realizedPnlUsdc = pairedShares - (legACost + legBCost);
        const stateMismatchDetail = await this.reconcileExpectedBalances(
          [
            {
              tokenId: attempts[0].leg.tokenId,
              expectedBalance: resolutions[0].size,
              label: `${opportunity.market.slug}:${attempts[0].leg.outcome}`
            },
            {
              tokenId: attempts[1].leg.tokenId,
              expectedBalance: resolutions[1].size,
              label: `${opportunity.market.slug}:${attempts[1].leg.outcome}`
            }
          ],
          opportunity.market.slug,
          "recovered_pair"
        );
        return {
          status: "recovered_pair",
          realizedPnlUsdc,
          detail: "Both arbitrage legs reached a matched partial fill size under the unified non-FOK policy.",
          stateMismatchDetail,
          openedPositions: [
            {
              tokenId: attempts[0].leg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: attempts[0].leg.outcome,
              shares: resolutions[0].size,
              totalCostUsdc: legACost,
              openedAtMs: opportunity.detectedAtMs
            },
            {
              tokenId: attempts[1].leg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: attempts[1].leg.outcome,
              shares: resolutions[1].size,
              totalCostUsdc: legBCost,
              openedAtMs: opportunity.detectedAtMs
            }
          ]
        };
      }

      this.logger.error(
        {
          market: opportunity.market.slug,
          legAState: resolutions[0].state,
          legASize: resolutions[0].size,
          legBState: resolutions[1].state,
          legBSize: resolutions[1].size
        },
        "Arbitrage entry legs filled asymmetrically under the non-FOK policy."
      );
      return {
        status: "residual_exposure",
        detail: "Entry legs filled asymmetrically and left unmatched exposure after partial execution.",
        openedPositions: [
          {
            tokenId: attempts[0].leg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: attempts[0].leg.outcome,
            shares: resolutions[0].size,
            totalCostUsdc: legACost,
            openedAtMs: opportunity.detectedAtMs
          },
          {
            tokenId: attempts[1].leg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: attempts[1].leg.outcome,
            shares: resolutions[1].size,
            totalCostUsdc: legBCost,
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    const filledIndex = legAHasExposure ? 0 : 1;
    return this.handleSingleLegFill(opportunity, resolutions, filledIndex);
  }

  private async handleSingleLegFill(
    opportunity: SameMarketOpportunity,
    resolutions: readonly [OrderResolution, OrderResolution],
    filledIndex: 0 | 1
  ): Promise<ArbitrageExecutionSummary> {
    const filledResolution = resolutions[filledIndex];
    const filledLeg = opportunity.legs[filledIndex];
    const missingIndex = filledIndex === 0 ? 1 : 0;
    const missingLeg = opportunity.legs[missingIndex];
    const missingResolution = resolutions[missingIndex];
    const filledCost = this.getFilledBuyCost(filledLeg, filledResolution);

    this.logger.warn(
      {
        market: opportunity.market.slug,
        filledSize: filledResolution.size,
        filledNotional: filledResolution.notional,
        filledCost: filledCost.toFixed(4),
        filledOutcome: filledLeg.outcome,
        missingOutcome: missingLeg.outcome,
        missingState: missingResolution.state,
        missingSource: missingResolution.source
      },
      "Only one leg filled. Starting immediate recovery flow."
    );

    const recovery = await this.tryFillMissingLeg(
      opportunity.market,
      missingLeg,
      filledResolution.size,
      filledCost
    );

    if (recovery.recovered) {
      const realizedPnlUsdc = filledResolution.size - (filledCost + (recovery.recoveredCost ?? 0));
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        [
          {
            tokenId: filledLeg.tokenId,
            expectedBalance: filledResolution.size,
            label: `${opportunity.market.slug}:${filledLeg.outcome}`
          },
          {
            tokenId: missingLeg.tokenId,
            expectedBalance: recovery.recoveredSize ?? filledResolution.size,
            label: `${opportunity.market.slug}:${missingLeg.outcome}`
          }
        ],
        opportunity.market.slug,
        "recovered_pair"
      );
      return {
        status: "recovered_pair",
        realizedPnlUsdc,
        detail: "Single-leg fill was completed by an immediate recovery buy.",
        stateMismatchDetail,
        openedPositions: [
          {
            tokenId: filledLeg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: filledLeg.outcome,
            shares: filledResolution.size,
            totalCostUsdc: filledCost,
            openedAtMs: opportunity.detectedAtMs
          },
          {
            tokenId: missingLeg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: missingLeg.outcome,
            shares: recovery.recoveredSize ?? filledResolution.size,
            totalCostUsdc: recovery.recoveredCost ?? 0,
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    if ((recovery.recoveredSize ?? 0) > EPSILON) {
      const recoveredSize = recovery.recoveredSize ?? 0;
      const recoveredCost = recovery.recoveredCost ?? 0;
      const excessShares = Math.max(0, filledResolution.size - recoveredSize);

      if (!config.execution.enableEmergencySell) {
        return {
          status: "residual_exposure",
          detail: "Recovery buy only partially filled and emergency sell was disabled.",
          openedPositions: [
            {
              tokenId: filledLeg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: filledLeg.outcome,
              shares: filledResolution.size,
              totalCostUsdc: filledCost,
              openedAtMs: opportunity.detectedAtMs
            },
            {
              tokenId: missingLeg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: missingLeg.outcome,
              shares: recoveredSize,
              totalCostUsdc: recoveredCost,
              openedAtMs: opportunity.detectedAtMs
            }
          ]
        };
      }

      const excessSell =
        excessShares > EPSILON
          ? await this.tryEmergencySell(opportunity.market, filledLeg, excessShares)
          : undefined;

      if ((excessSell?.soldShares ?? 0) + EPSILON >= excessShares) {
        const pairedFilledCost = filledCost * (recoveredSize / filledResolution.size);
        const realizedPnlUsdc =
          recoveredSize -
          (pairedFilledCost + recoveredCost) +
          ((excessSell?.proceedsUsdc ?? 0) - (filledCost - pairedFilledCost));
        const stateMismatchDetail = await this.reconcileExpectedBalances(
          [
            {
              tokenId: filledLeg.tokenId,
              expectedBalance: recoveredSize,
              label: `${opportunity.market.slug}:${filledLeg.outcome}`
            },
            {
              tokenId: missingLeg.tokenId,
              expectedBalance: recoveredSize,
              label: `${opportunity.market.slug}:${missingLeg.outcome}`
            }
          ],
          opportunity.market.slug,
          "recovered_pair"
        );
        return {
          status: "recovered_pair",
          realizedPnlUsdc,
          detail: "Recovery buy partially filled and the excess leg was trimmed with an emergency sell.",
          stateMismatchDetail,
          openedPositions: [
            {
              tokenId: filledLeg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: filledLeg.outcome,
              shares: recoveredSize,
              totalCostUsdc: pairedFilledCost,
              openedAtMs: opportunity.detectedAtMs
            },
            {
              tokenId: missingLeg.tokenId,
              conditionId: opportunity.market.conditionId,
              marketScope: opportunity.market.slug,
              outcome: missingLeg.outcome,
              shares: recoveredSize,
              totalCostUsdc: recoveredCost,
              openedAtMs: opportunity.detectedAtMs
            }
          ]
        };
      }

      // Fix M: residual after partial emergency sell. Cost basis must be proportional
      // to the shares actually remaining; otherwise the tracker carries the full
      // original cost on a tiny dust position (e.g., 0.006 shares with $2.74 cost)
      // and PnL accounting reports phantom losses.
      const filledResidualShares =
        filledResolution.size - Math.min(excessSell?.soldShares ?? 0, excessShares);
      const filledResidualCost =
        filledResolution.size > EPSILON
          ? filledCost * (filledResidualShares / filledResolution.size)
          : 0;
      return {
        status: "residual_exposure",
        detail: "Recovery buy only partially filled and the excess leg could not be fully unwound.",
        openedPositions: [
          {
            tokenId: filledLeg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: filledLeg.outcome,
            shares: filledResidualShares,
            totalCostUsdc: filledResidualCost,
            openedAtMs: opportunity.detectedAtMs
          },
          {
            tokenId: missingLeg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: missingLeg.outcome,
            shares: recoveredSize,
            totalCostUsdc: recoveredCost,
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    if (!config.execution.enableEmergencySell) {
      this.logger.error(
        { market: opportunity.market.slug, outcome: filledLeg.outcome },
        "Recovery buy failed and emergency sell is disabled."
      );
      return {
        status: "residual_exposure",
        detail: "Recovery buy failed and emergency sell was disabled.",
        openedPositions: [
          {
            tokenId: filledLeg.tokenId,
            conditionId: opportunity.market.conditionId,
            marketScope: opportunity.market.slug,
            outcome: filledLeg.outcome,
            shares: filledResolution.size,
            totalCostUsdc: filledCost,
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    const emergencySellProceeds = await this.tryEmergencySell(
      opportunity.market,
      filledLeg,
      filledResolution.size
    );

    if ((emergencySellProceeds?.soldShares ?? 0) + EPSILON >= filledResolution.size) {
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        [
          {
            tokenId: filledLeg.tokenId,
            expectedBalance: 0,
            label: `${opportunity.market.slug}:${filledLeg.outcome}`
          },
          {
            tokenId: missingLeg.tokenId,
            expectedBalance: 0,
            label: `${opportunity.market.slug}:${missingLeg.outcome}`
          }
        ],
        opportunity.market.slug,
        "emergency_unwind"
      );
      return {
        status: "emergency_unwind",
        realizedPnlUsdc: (emergencySellProceeds?.proceedsUsdc ?? 0) - filledCost,
        detail: "Single-leg fill was closed with an emergency sell.",
        stateMismatchDetail
      };
    }

    // Fix M: emergency sell partially covered the filled leg. Carry residual cost
    // proportional to remaining shares so the lot tracker doesn't keep the full
    // pre-unwind cost on a dust position.
    const residualSingleLegShares =
      filledResolution.size -
      Math.min(emergencySellProceeds?.soldShares ?? 0, filledResolution.size);
    const residualSingleLegCost =
      filledResolution.size > EPSILON
        ? filledCost * (residualSingleLegShares / filledResolution.size)
        : 0;
    return {
      status: "residual_exposure",
      detail: "Recovery buy and emergency sell both failed, leaving residual exposure.",
      openedPositions: [
        {
          tokenId: filledLeg.tokenId,
          conditionId: opportunity.market.conditionId,
          marketScope: opportunity.market.slug,
          outcome: filledLeg.outcome,
          shares: residualSingleLegShares,
          totalCostUsdc: residualSingleLegCost,
          openedAtMs: opportunity.detectedAtMs
        }
      ]
    };
  }

  private async hasEnoughCashForOrder(opportunity: SameMarketOpportunity): Promise<boolean> {
    const collateral = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const cashBalance = rawUsdcToDecimal(collateral.balance);
    const requiredCash = opportunity.grossCost * config.execution.minCashMultipleForOrder;

    if (cashBalance >= requiredCash) {
      this.logger.info(
        {
          market: opportunity.market.slug,
          cashBalance: cashBalance.toFixed(4),
          grossCost: opportunity.grossCost.toFixed(4),
          minCashMultipleForOrder: config.execution.minCashMultipleForOrder,
          requiredCash: requiredCash.toFixed(4)
        },
        "Cash pre-check passed for order creation."
      );
      return true;
    }

    this.logger.warn(
      {
        market: opportunity.market.slug,
        cashBalance: cashBalance.toFixed(4),
        grossCost: opportunity.grossCost.toFixed(4),
        minCashMultipleForOrder: config.execution.minCashMultipleForOrder,
        requiredCash: requiredCash.toFixed(4)
      },
      "Skipped order creation because available cash was below the configured multiple of gross cost."
    );
    return false;
  }

  private async hasOpenMarketExposure(market: BinaryMarket): Promise<boolean> {
    const [balanceA, balanceB] = await Promise.all([
      this.client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: market.tokenIds[0]
      }),
      this.client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: market.tokenIds[1]
      })
    ]);

    const hasBalanceA = Number(balanceA.balance) > 0;
    const hasBalanceB = Number(balanceB.balance) > 0;

    if (!hasBalanceA && !hasBalanceB) {
      return false;
    }

    this.logger.warn(
      {
        market: market.slug,
        legA: {
          outcome: market.outcomes[0],
          balance: balanceA.balance
        },
        legB: {
          outcome: market.outcomes[1],
          balance: balanceB.balance
        }
      },
      "Skipped order creation because the market already has an open conditional-token balance."
    );
    return true;
  }

  private async resolveOrder(
    response: PostedOrderResponse | undefined,
    fallbackSize: number,
    outcomeLabel: string,
    side: Side
  ): Promise<OrderResolution> {
    const assessment = this.assessPostedOrder(response, fallbackSize, outcomeLabel, side);

    if (assessment.resolution) {
      return assessment.resolution;
    }

    return this.awaitDelayedOrderResolution(assessment.delayedOrderId, fallbackSize);
  }

  private async awaitDelayedOrderResolution(
    orderId: string,
    requestedSize: number
  ): Promise<OrderResolution> {
    const cachedResolution = this.userTracker?.peekOrderOutcome(orderId);

    if (cachedResolution) {
      this.logger.info(
        { orderID: orderId, state: cachedResolution.state },
        "Resolved delayed order from cached user websocket outcome."
      );
      return normalizeResolution(
        {
          ...cachedResolution,
          source: cachedResolution.source ?? "user_ws"
        },
        requestedSize
      );
    }

    const deadline = Date.now() + config.ws.userOrderTimeoutMs;
    const userResolutionPromise = this.userTracker
      ? this.userTracker.waitForOrderOutcome(orderId, config.ws.userOrderTimeoutMs).then((resolution) => ({
          source: "user_ws" as const,
          resolution
        }))
      : undefined;

    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();

      if (userResolutionPromise) {
        const raced = await Promise.race([
          userResolutionPromise,
          sleep(Math.min(config.ws.orderPollIntervalMs, remainingMs)).then(() => ({
            source: "tick" as const
          }))
        ]);

        if (raced.source === "user_ws") {
          this.logger.info(
            { orderID: orderId, state: raced.resolution.state },
            "Resolved delayed order via user websocket."
          );
          return normalizeResolution(
            {
              ...raced.resolution,
              source: "user_ws"
            },
            requestedSize
          );
        }
      } else {
        await sleep(Math.min(config.ws.orderPollIntervalMs, remainingMs));
      }

      const polled = await this.pollOrderResolution(orderId, requestedSize);

      if (polled) {
        this.logger.info(
          { orderID: orderId, state: polled.state, size: polled.size, price: polled.price },
          "Resolved delayed order via REST polling fallback."
        );
        return normalizeResolution(
          {
            ...polled,
            source: "rest_poll"
          },
          requestedSize
        );
      }
    }

    if (userResolutionPromise) {
      const maybeUserResolution = await Promise.race([
        userResolutionPromise,
        Promise.resolve(undefined)
      ]);

      if (maybeUserResolution?.source === "user_ws") {
        this.logger.info(
          { orderID: orderId, state: maybeUserResolution.resolution.state },
          "Resolved delayed order via user websocket at timeout boundary."
        );
        return normalizeResolution(
          {
            ...maybeUserResolution.resolution,
            source: "user_ws"
          },
          requestedSize
        );
      }
    }

    this.logger.warn(
      { orderID: orderId },
      "Delayed order timed out after websocket and polling checks. Attempting explicit cancel."
    );

    const cancelIssued = await this.cancelOutstandingOrder(orderId, {
      reason: "delayed order timeout"
    });
    const postCancelResolution = await this.pollOrderResolution(orderId, requestedSize);

    if (postCancelResolution) {
      this.logger.info(
        {
          orderID: orderId,
          state: postCancelResolution.state,
          size: postCancelResolution.size,
          price: postCancelResolution.price
        },
        "Resolved delayed order after explicit cancel attempt."
      );
      return {
        ...normalizeResolution(postCancelResolution, requestedSize),
        source: "rest_poll"
      };
    }

    if (cancelIssued) {
      return { state: "cancelled", size: 0, source: "timeout" };
    }

    this.logger.warn(
      { orderID: orderId },
      "Delayed order remained unresolved after explicit cancel attempt."
    );
    return { state: "timed_out", size: 0, source: "timeout" };
  }

  private async pollOrderResolution(
    orderId: string,
    requestedSize: number
  ): Promise<OrderResolution | undefined> {
    try {
      const order = await this.client.getOrder(orderId);
      const status = order.status.toLowerCase();
      const matchedSize = Number(order.size_matched);
      const originalSize = Number(order.original_size);
      const effectiveTargetSize =
        Number.isFinite(originalSize) && originalSize > 0 ? originalSize : requestedSize;

      if (matchedSize >= effectiveTargetSize) {
        const price = Number(order.price);
        return {
          state: "filled",
          size: matchedSize,
          price,
          notional:
            Number.isFinite(price) && Number.isFinite(matchedSize)
              ? price * matchedSize
              : undefined
        };
      }

      if (matchedSize > EPSILON) {
        const price = Number(order.price);
        return {
          state: "partially_filled",
          size: matchedSize,
          price,
          notional:
            Number.isFinite(price) && Number.isFinite(matchedSize)
              ? price * matchedSize
              : undefined
        };
      }

      if (status === "unmatched" || status === "canceled" || status === "cancelled") {
        return { state: "cancelled", size: matchedSize };
      }

      if (status === "failed") {
        return { state: "failed", size: matchedSize };
      }

      return undefined;
    } catch (error) {
      const status = asErrorStatus(error);

      if (status === 404) {
        return undefined;
      }

      this.logger.warn(
        { orderID: orderId, err: error },
        "REST polling could not fetch delayed order status."
      );
      return undefined;
    }
  }

  private async tryFillMissingLeg(
    market: BinaryMarket,
    missingLeg: OpportunityLeg,
    shares: number,
    filledCost: number
  ): Promise<{ recovered: boolean; recoveredCost?: number; recoveredSize?: number }> {
    const missingBook = this.store.get(missingLeg.tokenId);

    if (!missingBook) {
      this.logger.error({ market: market.slug }, "Recovery failed because the latest books are missing.");
      return { recovered: false };
    }

    const executionTickSize = getExecutableTickSize(
      missingBook.tickSize,
      market.orderPriceMinTickSize
    );
    const missingFill = this.getBuyFill(
      missingBook,
      shares,
      executionTickSize,
      config.strategy.buyPriceBuffer
    );

    if (!missingFill) {
      return { recovered: false };
    }

    const combinedGrossCostPerShare =
      (filledCost + missingFill.fill.totalCost) / shares;
    // Fix P: the hard cap is FULL_SET_PAYOUT_PER_SHARE ($1.00) plus a small overpay
    // buffer. Within the buffer the bot accepts a guaranteed micro-loss at resolution
    // because it's almost always smaller than the alternative (emergency SELL slippage
    // on the just-filled leg). Set RECOVERY_MAX_OVERPAY_PER_SHARE=0 to revert.
    const overpayBuffer = config.strategy.recoveryMaxOverpayPerShare;
    const hardCapPerShare = FULL_SET_PAYOUT_PER_SHARE + overpayBuffer;
    const effectiveRecoveryGrossCostCapPerShare = Math.min(
      config.strategy.hedgeMaxGrossCostPerShare,
      hardCapPerShare
    );

    if (
      combinedGrossCostPerShare > hardCapPerShare ||
      combinedGrossCostPerShare > effectiveRecoveryGrossCostCapPerShare
    ) {
      this.logger.warn(
        {
          market: market.slug,
          filledCost: filledCost.toFixed(4),
          missingCost: missingFill.fill.totalCost.toFixed(4),
          combinedGrossCostPerShare: combinedGrossCostPerShare.toFixed(4),
          configuredRecoveryGrossCostCapPerShare:
            config.strategy.hedgeMaxGrossCostPerShare.toFixed(4),
          effectiveRecoveryGrossCostCapPerShare:
            effectiveRecoveryGrossCostCapPerShare.toFixed(4),
          fullSetPayoutPerShare: FULL_SET_PAYOUT_PER_SHARE.toFixed(4),
          recoveryMaxOverpayPerShare: overpayBuffer.toFixed(4)
        },
        "Recovery buy skipped because the combined cost cap was exceeded."
      );
      return { recovered: false };
    }

    const order = await this.client.createOrder(
      {
        tokenID: missingLeg.tokenId,
        price: missingFill.limitPrice,
        size: shares,
        side: Side.BUY,
        feeRateBps: missingLeg.feeRateBps
      },
      { tickSize: this.toTickString(missingFill.tickSize) }
    );

    const result = asPostedResponses(
      await this.client.postOrders([
        { order, orderType: toSdkOrderType(getAggressiveEntryTif()) }
      ])
    )[0];
    const resolution = await this.resolveOrder(result, shares, missingLeg.outcome, Side.BUY);

    if (resolution.state === "filled") {
      this.logger.warn({ market: market.slug }, "Recovery buy filled the missing leg.");
      return {
        recovered: true,
        recoveredCost: this.getFilledBuyCost(missingLeg, resolution),
        recoveredSize: resolution.size
      };
    }

    if (resolutionHasExposure(resolution)) {
      this.logger.warn(
        { market: market.slug, recoveredSize: resolution.size },
        "Recovery buy only partially filled the missing leg."
      );
      return {
        recovered: false,
        recoveredCost: this.getFilledBuyCost(missingLeg, resolution),
        recoveredSize: resolution.size
      };
    }

    this.logger.error({ market: market.slug }, "Recovery buy did not fill.");
    return { recovered: false };
  }

  private getFilledBuyCost(
    filledLeg: OpportunityLeg,
    filledResolution: OrderResolution
  ): number {
    if (typeof filledResolution.notional === "number" && Number.isFinite(filledResolution.notional)) {
      return filledResolution.notional;
    }

    if (
      typeof filledResolution.price === "number" &&
      Number.isFinite(filledResolution.price) &&
      Number.isFinite(filledResolution.size)
    ) {
      return filledResolution.price * filledResolution.size;
    }

    if (filledLeg.fill.shares > 0) {
      return filledLeg.fill.totalCost * (filledResolution.size / filledLeg.fill.shares);
    }

    return filledLeg.fill.totalCost;
  }

  private async tryEmergencySell(
    market: BinaryMarket,
    filledLeg: OpportunityLeg,
    shares: number
  ): Promise<EmergencySellResult | undefined> {
    const book = this.store.get(filledLeg.tokenId);

    if (!book) {
      this.logger.error({ market: market.slug }, "Emergency sell failed because the orderbook is missing.");
      return undefined;
    }

    // Fix J: Poll balance until Polymarket's backend reflects the just-bought tokens.
    // Without this, the SELL order is rejected at acceptance with "balance: 0" because
    // the REST balance API has not yet caught up to the BUY that filled milliseconds ago.
    const balancePoll = await pollConditionalBalanceUntilSufficient(this.client, this.logger, {
      tokenId: filledLeg.tokenId,
      requiredShares: shares,
      timeoutMs: config.execution.emergencySellBalancePollTimeoutMs,
      forceUpdate: config.execution.emergencySellBalancePollForceUpdate
    });

    if (balancePoll.status !== "sufficient") {
      this.logger.error(
        {
          market: market.slug,
          outcome: filledLeg.outcome,
          requiredShares: shares,
          observedBalance: balancePoll.observedBalance,
          pollCount: balancePoll.pollCount,
          elapsedMs: balancePoll.elapsedMs
        },
        "Emergency sell aborted because the Polymarket backend balance never reached the required share count."
      );
      return undefined;
    }

    const allowance = await this.client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: filledLeg.tokenId
    });

    const allowanceRaw = readMaxAllowanceRaw(allowance);
    if (allowanceRaw === undefined || allowanceRaw < shares) {
      this.logger.error(
        {
          market: market.slug,
          outcome: filledLeg.outcome,
          allowanceRaw: allowanceRaw !== undefined ? String(allowanceRaw) : null,
          required: shares
        },
        "Emergency sell skipped because the conditional token allowance is too low."
      );
      return undefined;
    }

    const sellFill = calculateSellFill(book.bids, shares);

    if (!sellFill) {
      this.logger.error({ market: market.slug }, "Emergency sell failed because bid depth is insufficient.");
      return undefined;
    }

    const executionTickSize = getExecutableTickSize(book.tickSize, market.orderPriceMinTickSize);
    const limitPrice = clampPrice(
      roundDownToTick(
        sellFill.worstPrice - config.execution.emergencySellPriceBuffer,
        executionTickSize
      ),
      executionTickSize
    );
    const order = await this.client.createOrder(
      {
        tokenID: filledLeg.tokenId,
        price: limitPrice,
        size: shares,
        side: Side.SELL
      },
      { tickSize: this.toTickString(executionTickSize) }
    );
    const result = asPostedResponses(
      await this.client.postOrders([
        { order, orderType: toSdkOrderType(getAggressiveExitTif()) }
      ])
    )[0];
    const resolution = await this.resolveOrder(result, shares, filledLeg.outcome, Side.SELL);

    if (resolutionHasExposure(resolution)) {
      this.logger.warn({ market: market.slug }, "Emergency sell completed.");
      return {
        soldShares: resolution.size,
        proceedsUsdc: this.getFilledSellProceeds(sellFill.totalProceeds, resolution)
      };
    }

    this.logger.error({ market: market.slug }, "Emergency sell did not fill.");
    return undefined;
  }

  private getFilledSellProceeds(
    fallbackProceeds: number,
    resolution: OrderResolution
  ): number {
    if (typeof resolution.notional === "number" && Number.isFinite(resolution.notional)) {
      return resolution.notional;
    }

    if (
      typeof resolution.price === "number" &&
      Number.isFinite(resolution.price) &&
      Number.isFinite(resolution.size)
    ) {
      return resolution.price * resolution.size;
    }

    return fallbackProceeds;
  }

  private async reconcileExpectedBalances(
    expectations: Array<{ tokenId: string; expectedBalance: number; label: string }>,
    market: string,
    phase: string
  ): Promise<string | undefined> {
    if (!this.userTracker) {
      return undefined;
    }

    const reconciliation = await reconcileExpectedConditionalBalances(
      this.client,
      expectations
    );

    if (reconciliation.matched) {
      this.logger.info(
        {
          market,
          phase,
          balances: reconciliation.snapshots
        },
        "Execution balance reconciliation passed."
      );
      return undefined;
    }

    this.logger.error(
      {
        market,
        phase,
        detail: reconciliation.detail,
        balances: reconciliation.snapshots
      },
      "Execution balance reconciliation detected a mismatch."
    );
    return reconciliation.detail;
  }

  private async cancelResidualOrderIfNeeded(
    market: string,
    outcome: string,
    response: PostedOrderResponse | undefined,
    resolution: OrderResolution,
    reason: string
  ): Promise<void> {
    if (!response?.orderID) {
      return;
    }

    if (resolution.state === "filled" || resolution.state === "cancelled" || resolution.state === "failed") {
      return;
    }

    await this.cancelOutstandingOrder(response.orderID, { market, outcome, reason });
  }

  private async cancelOutstandingOrder(
    orderId: string,
    context: {
      market?: string;
      outcome?: string;
      reason: string;
    }
  ): Promise<boolean> {
    try {
      const response = await this.client.cancelOrder({ orderID: orderId });
      this.logger.warn(
        {
          orderID: orderId,
          market: context.market,
          outcome: context.outcome,
          reason: context.reason,
          cancelResponse: response
        },
        "Issued explicit cancel for an outstanding order."
      );
      return true;
    } catch (error) {
      const status = asErrorStatus(error);
      const message = asErrorMessage(error);

      if (
        status === 404 ||
        (typeof message === "string" &&
          (message.toLowerCase().includes("not found") ||
            message.toLowerCase().includes("already cancelled") ||
            message.toLowerCase().includes("already canceled")))
      ) {
        this.logger.info(
          {
            orderID: orderId,
            market: context.market,
            outcome: context.outcome,
            reason: context.reason,
            status
          },
          "Outstanding order was already absent before explicit cancel."
        );
        return false;
      }

      this.logger.error(
        {
          err: error,
          orderID: orderId,
          market: context.market,
          outcome: context.outcome,
          reason: context.reason
        },
        "Explicit cancel request failed for an outstanding order."
      );
      return false;
    }
  }

  private getBuyFill(
    book: NormalizedOrderBook,
    shares: number,
    tickSize = book.tickSize,
    priceBuffer = 0
  ): { fill: { totalCost: number }; limitPrice: number; tickSize: number } | undefined {
    const fill = calculateBuyFill(book.asks, shares);

    if (!fill) {
      return undefined;
    }

    return {
      fill: { totalCost: fill.totalCost },
      limitPrice: clampPrice(roundUpToTick(fill.worstPrice + priceBuffer, tickSize), tickSize),
      tickSize
    };
  }

  private toTickString(tickSize: number): "0.1" | "0.01" | "0.001" | "0.0001" {
    if (tickSize === 0.1 || tickSize === 0.01 || tickSize === 0.001 || tickSize === 0.0001) {
      return String(tickSize) as "0.1" | "0.01" | "0.001" | "0.0001";
    }

    throw new Error(`Unsupported tick size for SDK order builder: ${tickSize}`);
  }
}
