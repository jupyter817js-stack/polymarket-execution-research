import {
  AssetType,
  OrderType,
  Side,
  type ClobClient
} from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { OrderBookStore } from "../polymarket/orderbook-store.js";
import { UserWsTracker } from "../polymarket/user-ws.js";
import { calculateSellFill } from "../strategy/vwap.js";
import type {
  BinaryMarket,
  OrderResolution,
  PostedOrderResponse
} from "../types.js";
import { clampPrice, getExecutableTickSize, roundDownToTick, sleep } from "../utils.js";
import { config } from "../config.js";

export type RiskReductionCandidate = {
  market: BinaryMarket;
  tokenId: string;
  outcome: string;
  maxReductionShares?: number;
  // Optional absolute minimum sell price. When set, the executor refuses to
  // post a SELL whose limit price would fall below this floor — e.g.
  // avgCost + exitMinProfitTicks × tickSize for the operator-mandated
  // "no sub-cost selling" rule. Not enforced when undefined (legacy callers).
  minSellPrice?: number;
};

export type RiskReductionResult = {
  marketSlug: string;
  tokenId: string;
  outcome: string;
  requestedShares: number;
  status:
    | "reduced"
    | "skipped_no_inventory"
    | "skipped_allowance_unavailable"
    | "skipped_missing_book"
    | "skipped_below_min_size"
    | "skipped_no_bid_liquidity"
    | "skipped_below_profit_floor"
    | "sell_failed";
  reducedShares?: number;
  proceedsUsdc?: number;
  price?: number;
  proceedsSource?: "venue_notional" | "venue_price" | "limit_price" | "book_vwap";
  observedBalance?: number;
  observedAllowance?: number;
  observedSellableShares?: number;
  waitedMs?: number;
  detail: string;
};

export type RiskReductionSummary = {
  reason: string;
  candidateCount: number;
  reducedCount: number;
  reducedShares: number;
  totalProceedsUsdc: number;
  results: RiskReductionResult[];
};

const EPSILON = 1e-9;
const INVENTORY_SETTLEMENT_WAIT_MS = 10_000;
const INVENTORY_SETTLEMENT_POLL_MS = 500;
const CONDITIONAL_SHARES_PRECISION = 1_000_000;

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

const asPositiveNumber = (value: string | number | undefined): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const normalizeConditionalShareAmount = (rawAmount: number | undefined): number => {
  if (!Number.isFinite(rawAmount) || rawAmount === undefined) {
    return 0;
  }

  return rawAmount / CONDITIONAL_SHARES_PRECISION;
};

const asActualFilledSize = (
  response: PostedOrderResponse | undefined,
  fallbackSize: number
): number => asPositiveNumber(response?.makingAmount) ?? fallbackSize;

const asActualFilledNotional = (
  response: PostedOrderResponse | undefined
): number | undefined => asPositiveNumber(response?.takingAmount);

const summarizeResponse = (response: PostedOrderResponse | undefined) => ({
  success: response?.success,
  orderID: response?.orderID,
  status: response?.status,
  tradeIDs: response?.tradeIDs,
  takingAmount: response?.takingAmount,
  makingAmount: response?.makingAmount,
  errorMsg: response?.errorMsg
});

export class RiskReductionExecutor {
  constructor(
    private readonly client: ClobClient,
    private readonly store: OrderBookStore,
    private readonly logger: Logger,
    private readonly userTracker?: UserWsTracker
  ) {}

  async reduceCandidates(
    candidates: readonly RiskReductionCandidate[],
    reason: string
  ): Promise<RiskReductionSummary> {
    const results: RiskReductionResult[] = [];

    for (const candidate of candidates) {
      results.push(await this.reduceCandidate(candidate, reason));
    }

    return {
      reason,
      candidateCount: candidates.length,
      reducedCount: results.filter((result) => result.status === "reduced").length,
      reducedShares: results.reduce((total, result) => total + (result.reducedShares ?? 0), 0),
      totalProceedsUsdc: results.reduce((total, result) => total + (result.proceedsUsdc ?? 0), 0),
      results
    };
  }

  private async reduceCandidate(
    candidate: RiskReductionCandidate,
    reason: string
  ): Promise<RiskReductionResult> {
    const book = await this.getReductionBook(candidate);

    if (!book) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares: 0,
        status: "skipped_missing_book",
        detail: "Orderbook was unavailable for risk reduction."
      };
    }

    const { balance, allowance, allowanceAvailable, waitedMs } =
      await this.waitForSellableInventory(candidate.tokenId);

    if (!allowanceAvailable && balance > EPSILON) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares: 0,
        status: "skipped_allowance_unavailable",
        observedBalance: balance,
        waitedMs,
        detail: `Sell allowance could not be determined. balance=${balance.toFixed(4)} waitedMs=${waitedMs}`
      };
    }

    const sellableShares = Math.min(balance, allowance);

    if (!(sellableShares > EPSILON)) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares: 0,
        status: "skipped_no_inventory",
        observedBalance: balance,
        observedAllowance: allowance,
        observedSellableShares: sellableShares,
        waitedMs,
        detail: `No sellable inventory remained. balance=${balance.toFixed(4)} allowance=${allowance.toFixed(4)} waitedMs=${waitedMs}`
      };
    }

    const bidDepthShares = book.bids.reduce((total, level) => total + level.size, 0);

    if (!(bidDepthShares > EPSILON)) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares: 0,
        status: "skipped_no_bid_liquidity",
        detail: "Bid depth was unavailable for a risk reduction sell."
      };
    }

    let requestedShares = Math.min(
      sellableShares,
      bidDepthShares,
      candidate.maxReductionShares ?? Number.POSITIVE_INFINITY
    );
    const minimumOrderSize = Math.max(candidate.market.orderMinSize, book.minOrderSize);

    const remainingSellableShares = Math.max(0, sellableShares - requestedShares);
    const partialReductionWouldLeaveDust =
      remainingSellableShares > EPSILON &&
      remainingSellableShares + EPSILON < minimumOrderSize;

    if (partialReductionWouldLeaveDust) {
      const candidateAllowsFullClose =
        candidate.maxReductionShares === undefined ||
        candidate.maxReductionShares + EPSILON >= sellableShares;

      if (candidateAllowsFullClose && bidDepthShares + EPSILON >= sellableShares) {
        requestedShares = sellableShares;
      } else {
        return {
          marketSlug: candidate.market.slug,
          tokenId: candidate.tokenId,
          outcome: candidate.outcome,
          requestedShares,
          status: "skipped_below_min_size",
          observedBalance: balance,
          observedAllowance: allowance,
          observedSellableShares: sellableShares,
          waitedMs,
          detail: `Partial reduction size ${requestedShares.toFixed(4)} would leave residual dust ${remainingSellableShares.toFixed(4)} below min order size ${minimumOrderSize.toFixed(4)}.`
        };
      }
    }

    if (requestedShares + EPSILON < minimumOrderSize) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares,
        status: "skipped_below_min_size",
        observedBalance: balance,
        observedAllowance: allowance,
        observedSellableShares: sellableShares,
        waitedMs,
        detail: `Requested reduction size ${requestedShares.toFixed(4)} was below min order size ${minimumOrderSize.toFixed(4)}.`
      };
    }

    const sellFill = calculateSellFill(book.bids, requestedShares);

    if (!sellFill) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares,
        status: "skipped_no_bid_liquidity",
        detail: "Bid depth was insufficient for a marketable reduction sell."
      };
    }

    const executionTickSize = getExecutableTickSize(
      book.tickSize,
      candidate.market.orderPriceMinTickSize
    );
    const limitPrice = clampPrice(
      roundDownToTick(
        sellFill.worstPrice - config.execution.emergencySellPriceBuffer,
        executionTickSize
      ),
      executionTickSize
    );

    // 🔒 Profit-floor refusal. When the caller passes `minSellPrice` (the bot
    // computes this as avgCost + exitMinProfitTicks × tickSize), refuse to
    // post a SELL whose limit would violate it. Prevents the stuck-sweep path
    // from dumping freshly-bought inventory below cost.
    if (
      typeof candidate.minSellPrice === "number" &&
      Number.isFinite(candidate.minSellPrice) &&
      limitPrice + EPSILON < candidate.minSellPrice
    ) {
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares,
        status: "skipped_below_profit_floor",
        detail: `Risk-reduction limit price ${limitPrice.toFixed(4)} would breach the per-token profit floor ${candidate.minSellPrice.toFixed(4)} — sale skipped to honor no-sub-cost rule.`
      };
    }

    try {
      const order = await this.client.createOrder(
        {
          tokenID: candidate.tokenId,
          price: limitPrice,
          size: requestedShares,
          side: Side.SELL
        },
        {
          tickSize: this.toTickString(executionTickSize)
        }
      );
      const response = asPostedResponses(
        await this.client.postOrders([{ order, orderType: OrderType.GTC }])
      )[0];
      const resolution = await this.resolveOrder(
        response,
        requestedShares,
        candidate.market.slug,
        candidate.outcome
      );

      if (resolution.size > EPSILON) {
        const filledSellProceeds = this.getFilledSellProceeds(
          limitPrice,
          sellFill.totalProceeds,
          requestedShares,
          resolution
        );
        const { proceedsUsdc } = filledSellProceeds;
        const wasPartialFill = resolution.size + EPSILON < requestedShares;
        this.logger.warn(
          {
            market: candidate.market.slug,
            outcome: candidate.outcome,
            tokenId: candidate.tokenId,
            reason,
            requestedShares,
            reducedShares: resolution.size,
            proceedsUsdc,
            price: filledSellProceeds.price,
            proceedsSource: filledSellProceeds.source,
            resolutionState: resolution.state
          },
          "Risk reduction sell completed."
        );
        return {
          marketSlug: candidate.market.slug,
          tokenId: candidate.tokenId,
          outcome: candidate.outcome,
          requestedShares,
          status: "reduced",
          reducedShares: resolution.size,
          proceedsUsdc,
          price: filledSellProceeds.price,
          proceedsSource: filledSellProceeds.source,
          detail: wasPartialFill
            ? `Risk reduction sell partially filled for ${resolution.size.toFixed(4)} of ${requestedShares.toFixed(4)} shares.`
            : `Risk reduction sell filled for ${resolution.size.toFixed(4)} shares.`
        };
      }

      this.logger.error(
        {
          market: candidate.market.slug,
          outcome: candidate.outcome,
          tokenId: candidate.tokenId,
          reason,
          requestedShares,
          response: summarizeResponse(response),
          resolution
        },
        "Risk reduction sell did not fill."
      );
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares,
        status: "sell_failed",
        detail: `Risk reduction sell ended in ${resolution.state} state.`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          err: error,
          market: candidate.market.slug,
          outcome: candidate.outcome,
          tokenId: candidate.tokenId,
          reason,
          requestedShares
        },
        "Risk reduction sell request failed."
      );
      return {
        marketSlug: candidate.market.slug,
        tokenId: candidate.tokenId,
        outcome: candidate.outcome,
        requestedShares,
        status: "sell_failed",
        detail
      };
    }
  }

  private async getReductionBook(
    candidate: RiskReductionCandidate
  ): Promise<ReturnType<OrderBookStore["get"]> | undefined> {
    const cachedBook = this.store.get(candidate.tokenId);

    if (cachedBook) {
      return cachedBook;
    }

    try {
      const snapshot = await this.client.getOrderBook(candidate.tokenId);
      return this.store.upsertSnapshot({
        asset_id: snapshot.asset_id,
        market: snapshot.market,
        bids: snapshot.bids,
        asks: snapshot.asks,
        timestamp: snapshot.timestamp,
        hash: snapshot.hash,
        tick_size: snapshot.tick_size,
        min_order_size: snapshot.min_order_size,
        neg_risk: snapshot.neg_risk,
        last_trade_price: snapshot.last_trade_price
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          market: candidate.market.slug,
          outcome: candidate.outcome,
          tokenId: candidate.tokenId
        },
        "Failed to fetch a fallback orderbook for risk reduction."
      );
      return undefined;
    }
  }

  private async waitForSellableInventory(tokenId: string): Promise<{
    balance: number;
    allowance: number;
    allowanceAvailable: boolean;
    waitedMs: number;
  }> {
    const startedAtMs = Date.now();
    let balance = 0;
    let allowance = 0;
    let allowanceAvailable = false;

    while (true) {
      const snapshot = await this.readConditionalBalanceAllowance(tokenId);
      balance = snapshot.balance;
      allowance = snapshot.allowance;
      allowanceAvailable = snapshot.allowanceAvailable;

      if (allowanceAvailable && Math.min(balance, allowance) > EPSILON) {
        return {
          balance,
          allowance,
          allowanceAvailable,
          waitedMs: Date.now() - startedAtMs
        };
      }

      if (Date.now() - startedAtMs + EPSILON >= INVENTORY_SETTLEMENT_WAIT_MS) {
        return {
          balance,
          allowance,
          allowanceAvailable,
          waitedMs: Date.now() - startedAtMs
        };
      }

      await sleep(INVENTORY_SETTLEMENT_POLL_MS);
    }
  }

  private async readConditionalBalanceAllowance(tokenId: string): Promise<{
    balance: number;
    allowance: number;
    allowanceAvailable: boolean;
  }> {
    const balanceAllowance = (await this.client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId
    })) as unknown as {
      balance?: string;
      allowance?: string;
      allowances?: Record<string, string>;
    };
    const balanceRaw = Number(balanceAllowance.balance);
    let maxAllowanceRaw: number | undefined;

    if (balanceAllowance.allowances && typeof balanceAllowance.allowances === "object") {
      for (const value of Object.values(balanceAllowance.allowances)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && (maxAllowanceRaw === undefined || parsed > maxAllowanceRaw)) {
          maxAllowanceRaw = parsed;
        }
      }
    } else if (balanceAllowance.allowance !== undefined) {
      const parsed = Number(balanceAllowance.allowance);
      if (Number.isFinite(parsed)) {
        maxAllowanceRaw = parsed;
      }
    }

    return {
      balance: normalizeConditionalShareAmount(balanceRaw),
      allowance: normalizeConditionalShareAmount(maxAllowanceRaw),
      allowanceAvailable: maxAllowanceRaw !== undefined
    };
  }

  private async resolveOrder(
    response: PostedOrderResponse | undefined,
    fallbackSize: number,
    marketSlug: string,
    outcome: string
  ): Promise<OrderResolution> {
    if (!response?.success) {
      return {
        state: "failed",
        size: 0,
        source: "response_status"
      };
    }

    if (isImmediateFill(response)) {
      const size = asActualFilledSize(response, fallbackSize);
      const notional = asActualFilledNotional(response);

      return {
        state: "filled",
        size,
        price: typeof notional === "number" && size > 0 ? notional / size : undefined,
        notional,
        source: "immediate"
      };
    }

    if (response.orderID) {
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
            return {
              ...maybeUserResolution.resolution,
              source: maybeUserResolution.source
            };
          }
        }

        const polled = await this.pollOrderResolution(response.orderID, fallbackSize);

        if (polled) {
          return {
            ...polled,
            source: "rest_poll"
          };
        }
      }

      await this.cancelOutstandingOrder(response.orderID, {
        marketSlug,
        outcome,
        reason: "risk reduction sell timeout"
      });
      const postCancel = await this.pollOrderResolution(response.orderID, fallbackSize);

      if (postCancel) {
        return {
          ...postCancel,
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

  private async cancelOutstandingOrder(
    orderId: string,
    context: { marketSlug: string; outcome: string; reason: string }
  ): Promise<void> {
    try {
      await this.client.cancelOrder({ orderID: orderId });
      this.logger.warn(
        {
          orderId,
          market: context.marketSlug,
          outcome: context.outcome,
          reason: context.reason
        },
        "Cancelled outstanding risk reduction order."
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          orderId,
          market: context.marketSlug,
          outcome: context.outcome,
          reason: context.reason
        },
        "Risk reduction order cancel failed."
      );
    }
  }

  private getFilledSellProceeds(
    limitPrice: number,
    fallbackProceeds: number,
    requestedShares: number,
    resolution: OrderResolution
  ): {
    proceedsUsdc: number;
    price?: number;
    source: "venue_notional" | "venue_price" | "limit_price" | "book_vwap";
  } {
    if (typeof resolution.notional === "number" && Number.isFinite(resolution.notional)) {
      return {
        proceedsUsdc: resolution.notional,
        price:
          resolution.size > EPSILON && Number.isFinite(resolution.size)
            ? resolution.notional / resolution.size
            : undefined,
        source: "venue_notional"
      };
    }

    if (
      typeof resolution.price === "number" &&
      Number.isFinite(resolution.price) &&
      Number.isFinite(resolution.size)
    ) {
      return {
        proceedsUsdc: resolution.price * resolution.size,
        price: resolution.price,
        source: "venue_price"
      };
    }

    if (Number.isFinite(limitPrice) && limitPrice > 0 && Number.isFinite(resolution.size)) {
      return {
        proceedsUsdc: limitPrice * resolution.size,
        price: limitPrice,
        source: "limit_price"
      };
    }

    const proceedsUsdc =
      requestedShares > EPSILON ? fallbackProceeds * (resolution.size / requestedShares) : 0;
    return {
      proceedsUsdc,
      price:
        resolution.size > EPSILON && Number.isFinite(resolution.size)
          ? proceedsUsdc / resolution.size
          : undefined,
      source: "book_vwap"
    };
  }

  private toTickString(tickSize: number): "0.1" | "0.01" | "0.001" | "0.0001" {
    if (tickSize === 0.1 || tickSize === 0.01 || tickSize === 0.001 || tickSize === 0.0001) {
      return String(tickSize) as "0.1" | "0.01" | "0.001" | "0.0001";
    }

    throw new Error(`Unsupported tick size for SDK order builder: ${tickSize}`);
  }
}
