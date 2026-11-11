import {
  AssetType,
  Side,
  type ClobClient
} from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";
import type { TrackedInventoryPosition } from "../core/inventory-lot-tracker.js";
import { readMaxAllowanceRaw } from "../polymarket/balance-allowance.js";
import { pollConditionalBalanceUntilSufficient } from "../polymarket/balance-poller.js";
import type { EventGroupRegistry } from "../polymarket/event-group-registry.js";
import { OrderBookStore } from "../polymarket/orderbook-store.js";
import { UserWsTracker } from "../polymarket/user-ws.js";
import type {
  NegativeRiskExitLeg,
  NegativeRiskLeg,
  NegativeRiskNoConversionOpportunity,
  NegativeRiskOpportunity,
  NegativeRiskYesBasketOpportunity
} from "../strategy/negative-risk.js";
import { calculateSellFill } from "../strategy/vwap.js";
import type { OrderResolution, PostedOrderResponse } from "../types.js";
import { clampPrice, roundDownToTick, sleep } from "../utils.js";
import { reconcileExpectedConditionalBalances } from "./execution-state-reconciler.js";
import {
  NegativeRiskConversionBridge,
  type NegativeRiskConversionBridgeLike
} from "./negative-risk-conversion-bridge.js";
import {
  getAggressiveEntryTif,
  getAggressiveExitTif,
  toSdkOrderType
} from "./order-type-policy.js";

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

const rawUsdcToDecimal = (rawBalance: string): number => Number(rawBalance) / 1_000_000;
const asErrorMessage = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined;

const asPositiveNumber = (value: string | number | undefined): number | undefined => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
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

const summarizeResponse = (response: PostedOrderResponse | undefined) => ({
  success: response?.success,
  orderID: response?.orderID,
  status: response?.status,
  tradeIDs: response?.tradeIDs,
  takingAmount: response?.takingAmount,
  makingAmount: response?.makingAmount,
  errorMsg: response?.errorMsg
});

type SellLeg = NegativeRiskLeg | NegativeRiskExitLeg;

export interface NegativeRiskExecutionSummary {
  status:
    | "skipped_non_live_path"
    | "skipped_open_exposure"
    | "skipped_insufficient_cash"
    | "skipped_disabled"
    | "fully_filled"
    | "fully_filled_pending_resolution"
    | "no_fill"
    | "emergency_unwind"
    | "residual_exposure";
  realizedPnlUsdc?: number;
  // Fix B: yes-basket has no immediate conversion path (Adapter convertPositions only
  // burns NO and outputs YES+collateral). Yes-basket profits are realized only after
  // event resolution, so we report expected PnL separately from realized.
  expectedRealizedPnlUsdc?: number;
  detail?: string;
  stateMismatchDetail?: string;
  openedPositions?: TrackedInventoryPosition[];
}

export class NegativeRiskExecutor {
  private readonly conversionBridge?: NegativeRiskConversionBridgeLike;
  private readonly eventGroupRegistry?: EventGroupRegistry;

  constructor(
    private readonly client: ClobClient,
    private readonly store: OrderBookStore,
    private readonly logger: Logger,
    private readonly userTracker?: UserWsTracker,
    options?: {
      conversionBridge?: NegativeRiskConversionBridgeLike;
      eventGroupRegistry?: EventGroupRegistry;
      makerAddress?: string;
    }
  ) {
    this.conversionBridge =
      options?.conversionBridge ??
      (config.negativeRisk.enableLiveConversionBridge
        ? new NegativeRiskConversionBridge(client, logger, options?.makerAddress)
        : undefined);
    this.eventGroupRegistry = options?.eventGroupRegistry;
  }

  // Fix F: expose holder verification for bot startup pre-flight.
  async verifyHolder(): Promise<{
    status: "ok" | "mismatch" | "unsupported_signer" | "no_bridge";
    detail?: string;
    holderAddress?: string;
    routeKind?: string;
  }> {
    if (!this.conversionBridge) {
      return {
        status: "no_bridge",
        detail: "Conversion bridge not configured; holder verification is not applicable."
      };
    }
    if (typeof this.conversionBridge.verifyHolder !== "function") {
      return {
        status: "no_bridge",
        detail: "Configured conversion bridge does not support holder verification."
      };
    }
    const result = await this.conversionBridge.verifyHolder();
    if (result.status === "ok") {
      return {
        status: "ok",
        holderAddress: result.holderAddress,
        routeKind: result.routeKind
      };
    }
    return result;
  }

  async execute(opportunity: NegativeRiskOpportunity): Promise<NegativeRiskExecutionSummary> {
    // Fix C: requireConversionBridge — block ANY negative-risk arb if bridge isn't
    // configured. This prevents both:
    //   - no-to-yes-conversion entry without bridge → entry fills then conversion fails
    //     → residual NO exposure (operator manual unwind required)
    //   - yes-basket fills without group safety → capital locked until resolution,
    //     but at least Fix A guarantees the group is complete first
    if (config.negativeRisk.requireConversionBridge && !this.conversionBridge) {
      return {
        status: "skipped_disabled",
        detail:
          "Negative-risk execution refused because POLYBOT_NEG_RISK_REQUIRE_CONVERSION_BRIDGE is true but the conversion bridge is not configured. Set POLYBOT_NEG_RISK_ENABLE_LIVE_CONVERSION_BRIDGE=true and provide builder credentials."
      };
    }

    if (opportunity.kind === "yes-basket" && !config.negativeRisk.enableYesBasket) {
      return {
        status: "skipped_disabled",
        detail:
          "Yes-basket execution refused because POLYBOT_NEG_RISK_ENABLE_YES_BASKET=false (capital would lock until resolution)."
      };
    }

    const hasOpenExposure = await this.hasOpenGroupExposure(opportunity);

    if (hasOpenExposure) {
      return {
        status: "skipped_open_exposure",
        detail: "Event group already had open conditional-token balances."
      };
    }

    const hasEnoughCash = await this.hasEnoughCashForOrder(opportunity);

    if (!hasEnoughCash) {
      return {
        status: "skipped_insufficient_cash",
        detail: "Collateral balance was below the configured pre-trade threshold."
      };
    }

    if (opportunity.kind === "yes-basket") {
      return this.executeYesBasket(opportunity);
    }

    return this.executeNoConversion(opportunity);
  }

  private async executeYesBasket(
    opportunity: NegativeRiskYesBasketOpportunity
  ): Promise<NegativeRiskExecutionSummary> {
    const responses = await this.postEntryOrders(opportunity);

    this.logger.info(
      {
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        legs: opportunity.legs.map((leg, index) => ({
          market: leg.market.slug,
          outcomeTitle: leg.outcomeTitle,
          ...summarizeResponse(responses[index])
        }))
      },
      "Posted Negative Risk arbitrage orders in a single batch request."
    );

    const resolutions = await Promise.all(
      opportunity.legs.map((leg, index) =>
        this.resolveOrder(responses[index], opportunity.shares, leg.outcomeTitle, Side.BUY)
      )
    );
    const allInitialFillsComplete = resolutions.every((resolution) => resolution.state === "filled");

    const filledLegs = opportunity.legs
      .map((leg, index) => ({
        leg,
        resolution: resolutions[index]
      }))
      .filter(
        (
          item
        ): item is {
          leg: NegativeRiskLeg;
          resolution: OrderResolution;
        } => resolutionHasExposure(item.resolution)
      );

    if (allInitialFillsComplete) {
      const totalCost = filledLegs.reduce(
        (total, item) => total + this.getFilledBuyCost(item.leg, item.resolution),
        0
      );
      // Fix B: yes-basket profit is realized only at event resolution (one outcome wins
      // and pays $1, others pay $0; total payout = shares × $1). The Adapter has no
      // function to convert YES-of-all to collateral pre-resolution, so the bot must
      // hold these positions until the event resolves.
      const realizedPnlUsdc = 0;
      const expectedRealizedPnlUsdc = opportunity.shares - totalCost;
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        filledLegs.map((item) => ({
          tokenId: item.leg.tokenId,
          expectedBalance: item.resolution.size,
          label: `${opportunity.group.eventSlug}:${item.leg.outcomeTitle}`
        })),
        opportunity.group.eventSlug,
        "fully_filled_pending_resolution"
      );

      this.logger.warn(
        {
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug,
          legs: opportunity.legs.map((leg) => leg.outcomeTitle),
          shares: opportunity.shares,
          grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
          netEdge: opportunity.netEdge.toFixed(4),
          expectedRealizedPnlUsdc: expectedRealizedPnlUsdc.toFixed(4),
          realizedPnlUsdc: realizedPnlUsdc.toFixed(4),
          note: "Yes-basket positions held until resolution; no immediate conversion path."
        },
        "Negative Risk yes-basket fully filled — awaiting event resolution to realize PnL."
      );

      return {
        status: "fully_filled_pending_resolution",
        realizedPnlUsdc,
        expectedRealizedPnlUsdc,
        stateMismatchDetail,
        detail:
          "Yes-basket positions held until resolution; Adapter does not support immediate YES→collateral conversion.",
        openedPositions: filledLegs.map((item) => ({
          tokenId: item.leg.tokenId,
          conditionId: item.leg.market.conditionId,
          marketScope: `${item.leg.market.slug}:negRiskYesBasket`,
          outcome: item.leg.outcomeTitle,
          shares: item.resolution.size,
          totalCostUsdc: this.getFilledBuyCost(item.leg, item.resolution),
          openedAtMs: opportunity.detectedAtMs
        }))
      };
    }

    await Promise.all(
      responses.map((response, index) =>
        this.cancelResidualOrderIfNeeded(
          opportunity.group.eventSlug,
          opportunity.legs[index]?.outcomeTitle ?? `leg-${index}`,
          response,
          resolutions[index] ?? { state: "failed", size: 0, source: "timeout" }
        )
      )
    );

    if (filledLegs.length === 0) {
      this.logger.warn(
        {
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug
        },
        "Negative Risk basket did not fill."
      );
      return {
        status: "no_fill"
      };
    }

    if (!config.execution.enableEmergencySell) {
      return {
        status: "residual_exposure",
        detail: "Partial basket fill remained open because emergency unwind was disabled.",
        openedPositions: filledLegs.map((item) => ({
          tokenId: item.leg.tokenId,
          conditionId: item.leg.market.conditionId,
          marketScope: item.leg.market.slug,
          outcome: item.leg.outcomeTitle,
          shares: item.resolution.size,
          totalCostUsdc: this.getFilledBuyCost(item.leg, item.resolution),
          openedAtMs: opportunity.detectedAtMs
        }))
      };
    }

    const unwindResults = await Promise.all(
      filledLegs.map(async (item) => ({
        leg: item.leg,
        resolution: item.resolution,
        cost: this.getFilledBuyCost(item.leg, item.resolution),
        proceeds: await this.tryEmergencySell(item.leg, item.resolution.size)
      }))
    );

    if (
      unwindResults.every(
        (result) => (result.proceeds?.soldShares ?? 0) + EPSILON >= result.resolution.size
      )
    ) {
      const realizedPnlUsdc =
        unwindResults.reduce((total, result) => total + (result.proceeds?.proceedsUsdc ?? 0), 0) -
        unwindResults.reduce((total, result) => total + result.cost, 0);
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        opportunity.legs.map((leg) => ({
          tokenId: leg.tokenId,
          expectedBalance: 0,
          label: `${opportunity.group.eventSlug}:${leg.outcomeTitle}`
        })),
        opportunity.group.eventSlug,
        "emergency_unwind"
      );

      return {
        status: "emergency_unwind",
        realizedPnlUsdc,
        detail: "Partial basket fill was closed with emergency sells.",
        stateMismatchDetail
      };
    }

    return {
      status: "residual_exposure",
      detail: "One or more emergency unwind sells did not fill.",
      openedPositions: unwindResults
        .filter(
          (result) => (result.proceeds?.soldShares ?? 0) + EPSILON < result.resolution.size
        )
        .map((result) => ({
          tokenId: result.leg.tokenId,
          conditionId: result.leg.market.conditionId,
          marketScope: result.leg.market.slug,
          outcome: result.leg.outcomeTitle,
          shares:
            result.resolution.size -
            Math.min(result.proceeds?.soldShares ?? 0, result.resolution.size),
          totalCostUsdc: result.cost,
          openedAtMs: opportunity.detectedAtMs
        }))
    };
  }

  private async executeNoConversion(
    opportunity: NegativeRiskNoConversionOpportunity
  ): Promise<NegativeRiskExecutionSummary> {
    if (!this.conversionBridge) {
      return {
        status: "skipped_non_live_path",
        detail:
          "Opportunity requires NO-to-YES conversion but POLYBOT_NEG_RISK_ENABLE_LIVE_CONVERSION_BRIDGE is disabled."
      };
    }

    const entryResponse = await this.postSingleEntryOrder(opportunity.entry, opportunity.shares);
    const entryResolution = await this.resolveOrder(
      entryResponse,
      opportunity.shares,
      opportunity.entry.outcomeTitle,
      Side.BUY
    );

    await this.cancelResidualOrderIfNeeded(
      opportunity.group.eventSlug,
      opportunity.entry.outcomeTitle,
      entryResponse,
      entryResolution
    );

    if (entryResolution.state !== "filled") {
      if (entryResolution.size > EPSILON) {
        return this.handleFailedConversionEntry(
          opportunity,
          entryResolution,
          "NO conversion entry only partially filled."
        );
      }

      return {
        status: "no_fill",
        detail: "NO conversion entry did not fill."
      };
    }

    const entryCost = this.getFilledBuyCost(opportunity.entry, entryResolution);
    const conversionResult = await this.conversionBridge.execute(opportunity);

    if (conversionResult.status !== "converted") {
      return this.handleFailedConversionEntry(
        opportunity,
        entryResolution,
        conversionResult.detail
      );
    }

    const exitResponses = await this.postExitOrders(opportunity);
    const exitResolutions = await Promise.all(
      opportunity.exitLegs.map((leg, index) =>
        this.resolveOrder(
          exitResponses[index],
          opportunity.convertedSharesPerLeg,
          leg.outcomeTitle,
          Side.SELL
        )
      )
    );

    await Promise.all(
      exitResponses.map((response, index) =>
        this.cancelResidualOrderIfNeeded(
          opportunity.group.eventSlug,
          opportunity.exitLegs[index]?.outcomeTitle ?? `exit-${index}`,
          response,
          exitResolutions[index] ?? { state: "failed", size: 0, source: "timeout" }
        )
      )
    );

    const costByTokenId = this.allocateConversionEntryCost(opportunity, entryCost);
    const exitResults = opportunity.exitLegs.map((leg, index) => ({
      leg,
      resolution: exitResolutions[index]
    }));
    const allInitialExitsFilled = exitResults.every(
      (result) => result.resolution?.state === "filled"
    );

    if (allInitialExitsFilled) {
      const grossExitProceeds = exitResults.reduce(
        (total, result) =>
          total +
          this.getFilledSellProceeds(
            result.leg.fill.totalProceeds,
            result.resolution ?? { state: "failed", size: 0 }
          ),
        0
      );
      // Fix D: subtract conversion gas reserve from realized PnL. The Adapter
      // convertPositions transaction (and possibly setApprovalForAll on first run) costs
      // MATIC gas. Strategy gate (Fix I) already required edge > gasReserve, so this
      // post-trade subtraction reflects the same conservative assumption.
      const gasReserveUsdc = config.negativeRisk.conversionGasReserveUsdc;
      const realizedPnlUsdc = grossExitProceeds - entryCost - gasReserveUsdc;
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        this.buildZeroBalanceExpectations(opportunity),
        opportunity.group.eventSlug,
        "converted_and_closed"
      );

      return {
        status: "fully_filled",
        realizedPnlUsdc,
        detail: `NO-to-YES conversion bridge completed via ${conversionResult.txHash}; gas reserve $${gasReserveUsdc.toFixed(4)} subtracted.`,
        stateMismatchDetail
      };
    }

    if (!config.execution.enableEmergencySell) {
      return {
        status: "residual_exposure",
        detail: "Converted YES exits did not fully fill and emergency sell is disabled.",
        openedPositions: this.buildResidualExitPositions(
          opportunity,
          exitResults
            .filter((result) => (result.resolution?.size ?? 0) + EPSILON < opportunity.convertedSharesPerLeg)
            .map((result) => ({
              leg: result.leg,
              remainingShares: Math.max(
                0,
                opportunity.convertedSharesPerLeg - (result.resolution?.size ?? 0)
              )
            })),
          costByTokenId
        )
      };
    }

    const emergencyExitResults = await Promise.all(
      exitResults.map(async (result) => {
        if (result.resolution?.state === "filled") {
          return {
            leg: result.leg,
            remainingShares: 0,
            proceeds: {
              soldShares: result.resolution.size,
              proceedsUsdc: this.getFilledSellProceeds(
                result.leg.fill.totalProceeds,
                result.resolution
              )
            }
          };
        }

        const remainingShares = Math.max(
          0,
          opportunity.convertedSharesPerLeg - (result.resolution?.size ?? 0)
        );

        return {
          leg: result.leg,
          remainingShares,
          proceeds:
            remainingShares > EPSILON
              ? await this.tryEmergencySell(result.leg, remainingShares)
              : undefined
        };
      })
    );

    const residualLegs = emergencyExitResults
      .filter((result) => (result.proceeds?.soldShares ?? 0) + EPSILON < result.remainingShares)
      .map((result) => ({
        leg: result.leg,
        remainingShares:
          result.remainingShares - Math.min(result.proceeds?.soldShares ?? 0, result.remainingShares)
      }));

    if (residualLegs.length === 0) {
      const grossEmergencyProceeds = emergencyExitResults.reduce(
        (total, result) => total + (result.proceeds?.proceedsUsdc ?? 0),
        0
      );
      // Fix D: gas reserve was already paid for the convertPositions tx that completed
      // before this emergency unwind path; subtract it so realized PnL is honest.
      const gasReserveUsdc = config.negativeRisk.conversionGasReserveUsdc;
      const realizedPnlUsdc = grossEmergencyProceeds - entryCost - gasReserveUsdc;
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        this.buildZeroBalanceExpectations(opportunity),
        opportunity.group.eventSlug,
        "conversion_emergency_unwind"
      );

      return {
        status: "emergency_unwind",
        realizedPnlUsdc,
        detail: `Conversion bridge exit legs needed emergency sells after ${conversionResult.txHash}; gas reserve $${gasReserveUsdc.toFixed(4)} subtracted.`,
        stateMismatchDetail
      };
    }

    return {
      status: "residual_exposure",
      detail: "One or more converted YES exits remained open after the emergency unwind flow.",
      openedPositions: this.buildResidualExitPositions(opportunity, residualLegs, costByTokenId)
    };
  }

  private async handleFailedConversionEntry(
    opportunity: NegativeRiskNoConversionOpportunity,
    entryResolution: OrderResolution,
    detail: string
  ): Promise<NegativeRiskExecutionSummary> {
    const entryCost = this.getFilledBuyCost(opportunity.entry, entryResolution);

    if (!config.execution.enableEmergencySell) {
      return {
        status: "residual_exposure",
        detail: `Conversion bridge failed after the NO entry filled. ${detail}`,
        openedPositions: [
          {
            tokenId: opportunity.entry.tokenId,
            conditionId: opportunity.entry.market.conditionId,
            marketScope: opportunity.entry.market.slug,
            outcome: opportunity.entry.outcomeTitle,
            shares: entryResolution.size,
            totalCostUsdc: entryCost,
            openedAtMs: opportunity.detectedAtMs
          }
        ]
      };
    }

    const unwindProceeds = await this.tryEmergencySell(opportunity.entry, entryResolution.size);

    if ((unwindProceeds?.soldShares ?? 0) + EPSILON >= entryResolution.size) {
      const stateMismatchDetail = await this.reconcileExpectedBalances(
        [
          {
            tokenId: opportunity.entry.tokenId,
            expectedBalance: 0,
            label: `${opportunity.group.eventSlug}:${opportunity.entry.outcomeTitle}`
          }
        ],
        opportunity.group.eventSlug,
        "conversion_entry_unwind"
      );

      return {
        status: "emergency_unwind",
        realizedPnlUsdc: (unwindProceeds?.proceedsUsdc ?? 0) - entryCost,
        detail: `Conversion bridge failed after entry fill and the NO leg was emergency sold. ${detail}`,
        stateMismatchDetail
      };
    }

    return {
      status: "residual_exposure",
      detail: `Conversion bridge failed after the NO entry filled and the NO leg could not be unwound. ${detail}`,
      openedPositions: [
        {
          tokenId: opportunity.entry.tokenId,
          conditionId: opportunity.entry.market.conditionId,
          marketScope: opportunity.entry.market.slug,
          outcome: opportunity.entry.outcomeTitle,
          shares:
            entryResolution.size -
            Math.min(unwindProceeds?.soldShares ?? 0, entryResolution.size),
          totalCostUsdc: entryCost,
          openedAtMs: opportunity.detectedAtMs
        }
      ]
    };
  }

  private async hasEnoughCashForOrder(opportunity: NegativeRiskOpportunity): Promise<boolean> {
    const collateral = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const cashBalance = rawUsdcToDecimal(collateral.balance);
    // Fix E: required cash = grossCost × multiple PLUS conversion gas reserve. If we
    // entered without the gas reserve, conversion would fail post-fill and leave NO
    // tokens stranded in the wallet.
    const gasReserveUsdc = config.negativeRisk.conversionGasReserveUsdc;
    const requiredCash =
      opportunity.grossCost * config.execution.minCashMultipleForOrder + gasReserveUsdc;

    if (cashBalance >= requiredCash) {
      return true;
    }

    this.logger.warn(
      {
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        cashBalance: cashBalance.toFixed(4),
        grossCost: opportunity.grossCost.toFixed(4),
        minCashMultipleForOrder: config.execution.minCashMultipleForOrder,
        gasReserveUsdc: gasReserveUsdc.toFixed(4),
        requiredCash: requiredCash.toFixed(4)
      },
      "Skipped Negative Risk execution because available cash was below the configured multiple + gas reserve."
    );
    return false;
  }

  private async hasOpenGroupExposure(opportunity: NegativeRiskOpportunity): Promise<boolean> {
    // Fix C: combine local-subset tokenIds with the full event's tokenIds from the
    // registry. Without this, residual positions in markets outside the bot's current
    // universe filter (e.g. left over from a prior partial fill) would not be detected,
    // and the bot could re-enter on top of stale exposure.
    const localTokenIds = opportunity.group.markets.flatMap((market) => [...market.tokenIds]);
    const registryTokenIds = this.eventGroupRegistry
      ? (await this.eventGroupRegistry.get(opportunity.group.eventId))?.tokenIds
      : undefined;
    const combinedTokenIds = [
      ...new Set([...localTokenIds, ...(registryTokenIds ?? [])])
    ];
    const balances = await Promise.all(
      combinedTokenIds.map((tokenId) =>
        this.client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: tokenId
        })
      )
    );
    const hasOpenExposure = balances.some((balance) => Number(balance.balance) > 0);

    if (!hasOpenExposure) {
      return false;
    }

    this.logger.warn(
      {
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        localTokenCount: localTokenIds.length,
        registryTokenCount: registryTokenIds?.size ?? 0,
        tokens: combinedTokenIds.map((tokenId, index) => ({
          tokenId,
          balance: balances[index]?.balance
        }))
      },
      "Skipped Negative Risk execution because the event group already has open conditional-token balances."
    );
    return true;
  }

  private async postEntryOrders(
    opportunity: NegativeRiskYesBasketOpportunity
  ): Promise<Array<PostedOrderResponse | undefined>> {
    const signedOrders = await Promise.all(
      opportunity.legs.map((leg) =>
        this.client.createOrder(
          {
            tokenID: leg.tokenId,
            price: leg.limitPrice,
            size: opportunity.shares,
            side: Side.BUY,
            feeRateBps: leg.feeRateBps
          },
          {
            tickSize: this.toTickString(leg.tickSize)
          }
        )
      )
    );

    try {
      const aggressiveEntryOrderType = toSdkOrderType(getAggressiveEntryTif());
      return asPostedResponses(
        await this.client.postOrders(
          signedOrders.map((order) => ({ order, orderType: aggressiveEntryOrderType }))
        )
      );
    } catch (error) {
      this.logger.error(
        {
          err: error,
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug
        },
        "Negative Risk batch entry request threw before responses could be classified."
      );
      const failureResponse: PostedOrderResponse = {
        success: false,
        errorMsg: asErrorMessage(error) ?? "negative risk batch order request threw"
      };
      return opportunity.legs.map(() => failureResponse);
    }
  }

  private async postSingleEntryOrder(
    leg: NegativeRiskLeg,
    shares: number
  ): Promise<PostedOrderResponse | undefined> {
    try {
      const order = await this.client.createOrder(
        {
          tokenID: leg.tokenId,
          price: leg.limitPrice,
          size: shares,
          side: Side.BUY,
          feeRateBps: leg.feeRateBps
        },
        {
          tickSize: this.toTickString(leg.tickSize)
        }
      );

      return asPostedResponses(
        await this.client.postOrders([
          { order, orderType: toSdkOrderType(getAggressiveEntryTif()) }
        ])
      )[0];
    } catch (error) {
      this.logger.error(
        {
          err: error,
          market: leg.market.slug,
          outcomeTitle: leg.outcomeTitle
        },
        "Negative Risk conversion entry request failed before responses could be classified."
      );
      return {
        success: false,
        errorMsg: asErrorMessage(error) ?? "negative risk conversion entry request threw"
      };
    }
  }

  private async postExitOrders(
    opportunity: NegativeRiskNoConversionOpportunity
  ): Promise<Array<PostedOrderResponse | undefined>> {
    const signedOrders = await Promise.all(
      opportunity.exitLegs.map((leg) =>
        this.client.createOrder(
          {
            tokenID: leg.tokenId,
            price: leg.limitPrice,
            size: opportunity.convertedSharesPerLeg,
            side: Side.SELL,
            feeRateBps: leg.feeRateBps
          },
          {
            tickSize: this.toTickString(leg.tickSize)
          }
        )
      )
    );

    try {
      const aggressiveExitOrderType = toSdkOrderType(getAggressiveExitTif());
      return asPostedResponses(
        await this.client.postOrders(
          signedOrders.map((order) => ({ order, orderType: aggressiveExitOrderType }))
        )
      );
    } catch (error) {
      this.logger.error(
        {
          err: error,
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug
        },
        "Negative Risk conversion exit batch request failed before responses could be classified."
      );
      const failureResponse: PostedOrderResponse = {
        success: false,
        errorMsg: asErrorMessage(error) ?? "negative risk conversion exit request threw"
      };
      return opportunity.exitLegs.map(() => failureResponse);
    }
  }

  private async resolveOrder(
    response: PostedOrderResponse | undefined,
    fallbackSize: number,
    outcomeTitle: string,
    side: Side
  ): Promise<OrderResolution> {
    if (!response?.success) {
      return {
        state: "failed",
        size: 0,
        source: "response_status"
      };
    }

    if (isImmediateFill(response)) {
      const size = asActualFilledSize(response, side, fallbackSize);
      const notional = asActualFilledNotional(response, side);

      return normalizeResolution(
        {
          state: "filled",
          size,
          price: typeof notional === "number" && size > 0 ? notional / size : undefined,
          notional,
          source: "immediate"
        },
        fallbackSize
      );
    }

    if (response.status?.toLowerCase() === "delayed" && response.orderID) {
      const userResolutionPromise = this.userTracker
        ? this.userTracker.waitForOrderOutcome(response.orderID, config.ws.userOrderTimeoutMs)
        : undefined;
      const startedAtMs = Date.now();

      while (Date.now() - startedAtMs < config.ws.userOrderTimeoutMs) {
        if (userResolutionPromise) {
          const maybeUserResolution = await Promise.race([
            userResolutionPromise.then((resolution) => ({
              resolution,
              source: "user_ws" as const
            })),
            sleep(config.ws.orderPollIntervalMs).then(() => undefined)
          ]);

          if (maybeUserResolution?.resolution) {
            return normalizeResolution(
              {
                ...maybeUserResolution.resolution,
                source: maybeUserResolution.source
              },
              fallbackSize
            );
          }
        }

        const polled = await this.pollOrderResolution(response.orderID, fallbackSize);

        if (polled) {
          return normalizeResolution(
            {
              ...polled,
              source: "rest_poll"
            },
            fallbackSize
          );
        }
      }

      await this.cancelOutstandingOrder(response.orderID, {
        outcomeTitle,
        reason: "delayed negative risk order timeout"
      });
      const postCancel = await this.pollOrderResolution(response.orderID, fallbackSize);

      if (postCancel) {
        return {
          ...normalizeResolution(postCancel, fallbackSize),
          source: "rest_poll"
        };
      }

      return {
        state: "timed_out",
        size: 0,
        source: "timeout"
      };
    }

    return {
      state: "cancelled",
      size: 0,
      source: "response_status"
    };
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
    } catch {
      return undefined;
    }

    return undefined;
  }

  private async cancelResidualOrderIfNeeded(
    eventSlug: string,
    outcomeTitle: string,
    response: PostedOrderResponse | undefined,
    resolution: OrderResolution
  ): Promise<void> {
    if (!response?.orderID) {
      return;
    }

    if (
      resolution.state === "filled" ||
      resolution.state === "cancelled" ||
      resolution.state === "failed"
    ) {
      return;
    }

    await this.cancelOutstandingOrder(response.orderID, {
      eventSlug,
      outcomeTitle,
      reason: "negative risk cleanup"
    });
  }

  private async cancelOutstandingOrder(
    orderId: string,
    context: {
      eventSlug?: string;
      outcomeTitle?: string;
      reason: string;
    }
  ): Promise<void> {
    try {
      await this.client.cancelOrder({ orderID: orderId });
      this.logger.warn(
        {
          orderID: orderId,
          eventSlug: context.eventSlug,
          outcomeTitle: context.outcomeTitle,
          reason: context.reason
        },
        "Issued explicit cancel for a Negative Risk order."
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          orderID: orderId,
          eventSlug: context.eventSlug,
          outcomeTitle: context.outcomeTitle,
          reason: context.reason
        },
        "Explicit cancel request failed for a Negative Risk order."
      );
    }
  }

  private getFilledBuyCost(leg: NegativeRiskLeg, resolution: OrderResolution): number {
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

    if (leg.fill.shares > 0) {
      return leg.fill.totalCost * (resolution.size / leg.fill.shares);
    }

    return leg.fill.totalCost;
  }

  private getFilledSellProceeds(fallbackProceeds: number, resolution: OrderResolution): number {
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

  private allocateConversionEntryCost(
    opportunity: NegativeRiskNoConversionOpportunity,
    entryCost: number
  ): Map<string, number> {
    const map = new Map<string, number>();
    const totalExpectedExitProceeds = opportunity.exitLegs.reduce(
      (total, leg) => total + leg.fill.totalProceeds,
      0
    );

    if (totalExpectedExitProceeds <= EPSILON) {
      const equalCost = entryCost / Math.max(opportunity.exitLegs.length, 1);
      for (const leg of opportunity.exitLegs) {
        map.set(leg.tokenId, equalCost);
      }
      return map;
    }

    for (const leg of opportunity.exitLegs) {
      map.set(leg.tokenId, entryCost * (leg.fill.totalProceeds / totalExpectedExitProceeds));
    }

    return map;
  }

  private buildResidualExitPositions(
    opportunity: NegativeRiskNoConversionOpportunity,
    residualLegs: ReadonlyArray<{
      leg: NegativeRiskExitLeg;
      remainingShares: number;
    }>,
    costByTokenId: ReadonlyMap<string, number>
  ): TrackedInventoryPosition[] {
    return residualLegs.map(({ leg, remainingShares }) => ({
      tokenId: leg.tokenId,
      conditionId: leg.market.conditionId,
      marketScope: leg.market.slug,
      outcome: leg.outcomeTitle,
      shares: remainingShares,
      totalCostUsdc:
        (costByTokenId.get(leg.tokenId) ?? 0) *
        (remainingShares / opportunity.convertedSharesPerLeg),
      openedAtMs: opportunity.detectedAtMs
    }));
  }

  private buildZeroBalanceExpectations(
    opportunity: NegativeRiskNoConversionOpportunity
  ): Array<{ tokenId: string; expectedBalance: number; label: string }> {
    return [
      {
        tokenId: opportunity.entry.tokenId,
        expectedBalance: 0,
        label: `${opportunity.group.eventSlug}:${opportunity.entry.outcomeTitle}`
      },
      ...opportunity.exitLegs.map((leg) => ({
        tokenId: leg.tokenId,
        expectedBalance: 0,
        label: `${opportunity.group.eventSlug}:${leg.outcomeTitle}`
      }))
    ];
  }

  private async tryEmergencySell(
    leg: SellLeg,
    shares: number
  ): Promise<EmergencySellResult | undefined> {
    const book = this.store.get(leg.tokenId);

    if (!book) {
      this.logger.error(
        { market: leg.market.slug, outcomeTitle: leg.outcomeTitle },
        "Negative Risk emergency sell failed because the orderbook is missing."
      );
      return undefined;
    }

    // Fix J: poll for backend balance reflection. After a BUY fills, Polymarket's REST
    // balance API can lag and reject SELLs with "balance: 0" until it catches up.
    const balancePoll = await pollConditionalBalanceUntilSufficient(this.client, this.logger, {
      tokenId: leg.tokenId,
      requiredShares: shares,
      timeoutMs: config.execution.emergencySellBalancePollTimeoutMs,
      forceUpdate: config.execution.emergencySellBalancePollForceUpdate
    });

    if (balancePoll.status !== "sufficient") {
      this.logger.error(
        {
          market: leg.market.slug,
          outcomeTitle: leg.outcomeTitle,
          requiredShares: shares,
          observedBalance: balancePoll.observedBalance,
          pollCount: balancePoll.pollCount,
          elapsedMs: balancePoll.elapsedMs
        },
        "Negative Risk emergency sell aborted because the Polymarket backend balance never reached the required share count."
      );
      return undefined;
    }

    const allowance = await this.client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: leg.tokenId
    });

    const allowanceRaw = readMaxAllowanceRaw(allowance);
    if (allowanceRaw === undefined || allowanceRaw < shares) {
      this.logger.error(
        {
          market: leg.market.slug,
          outcomeTitle: leg.outcomeTitle,
          allowanceRaw: allowanceRaw !== undefined ? String(allowanceRaw) : null,
          required: shares
        },
        "Negative Risk emergency sell skipped because allowance was too low."
      );
      return undefined;
    }

    const sellFill = calculateSellFill(book.bids, shares);

    if (!sellFill) {
      this.logger.error(
        { market: leg.market.slug, outcomeTitle: leg.outcomeTitle },
        "Negative Risk emergency sell failed because bid depth was insufficient."
      );
      return undefined;
    }

    const limitPrice = clampPrice(
      roundDownToTick(
        sellFill.worstPrice - config.execution.emergencySellPriceBuffer,
        leg.tickSize
      ),
      leg.tickSize
    );
    const order = await this.client.createOrder(
      {
        tokenID: leg.tokenId,
        price: limitPrice,
        size: shares,
        side: Side.SELL
      },
      {
        tickSize: this.toTickString(leg.tickSize)
      }
    );
    const response = asPostedResponses(
      await this.client.postOrders([
        { order, orderType: toSdkOrderType(getAggressiveExitTif()) }
      ])
    )[0];
    const resolution = await this.resolveOrder(response, shares, leg.outcomeTitle, Side.SELL);

    if (resolutionHasExposure(resolution)) {
      this.logger.warn(
        { market: leg.market.slug, outcomeTitle: leg.outcomeTitle, size: resolution.size },
        "Negative Risk emergency sell completed."
      );
      return {
        soldShares: resolution.size,
        proceedsUsdc: this.getFilledSellProceeds(sellFill.totalProceeds, resolution)
      };
    }

    this.logger.error(
      { market: leg.market.slug, outcomeTitle: leg.outcomeTitle },
      "Negative Risk emergency sell did not fill."
    );
    return undefined;
  }

  private async reconcileExpectedBalances(
    expectations: Array<{ tokenId: string; expectedBalance: number; label: string }>,
    eventSlug: string,
    phase: string
  ): Promise<string | undefined> {
    if (!this.userTracker) {
      return undefined;
    }

    const reconciliation = await reconcileExpectedConditionalBalances(this.client, expectations);

    if (reconciliation.matched) {
      this.logger.info(
        {
          eventSlug,
          phase,
          balances: reconciliation.snapshots
        },
        "Negative Risk balance reconciliation passed."
      );
      return undefined;
    }

    this.logger.error(
      {
        eventSlug,
        phase,
        detail: reconciliation.detail,
        balances: reconciliation.snapshots
      },
      "Negative Risk balance reconciliation detected a mismatch."
    );
    return reconciliation.detail;
  }

  private toTickString(tickSize: number): "0.1" | "0.01" | "0.001" | "0.0001" {
    if (tickSize === 0.1 || tickSize === 0.01 || tickSize === 0.001 || tickSize === 0.0001) {
      return String(tickSize) as "0.1" | "0.01" | "0.001" | "0.0001";
    }

    throw new Error(`Unsupported tick size for SDK order builder: ${tickSize}`);
  }
}
