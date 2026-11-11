import { AssetType, OrderType, Side, type ClobClient } from "@polymarket/clob-client-v2";
import type { SignedOrder } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";
import type { QuoteDisplacementTracker } from "../core/quote-displacement-tracker.js";
import { isLiveMarket } from "../core/live-market-detector.js";
import type { PositionManager } from "../core/position-manager.js";
import type { RiskManagerLike } from "../core/types.js";
import type { BinaryMarket, PostedOrderResponse } from "../types.js";
import { clampPrice } from "../utils.js";
import type { MarketMakerPlan, QuoteInstruction } from "../strategy/market-maker.js";

export type ActiveQuote = QuoteInstruction & {
  orderId: string;
  conditionId: string;
  marketSlug: string;
  category?: string;
  /** Timestamp of the MarketMakerPlan that triggered this order (proxy for intent creation). */
  intentCreatedAtMs: number;
  /** Timestamp when the order was successfully posted to the book. */
  openedAtMs: number;
  /** Timestamp of the first partial fill received for this order. */
  firstFillAtMs?: number;
  /** Number of incremental fill events received (each partial or full fill increments this). */
  partialFillCount: number;
  /** Number of times this quote slot has been re-quoted since first posted. */
  requoteCount: number;
};

type QuoteExecutorHooks = {
  onQuoteCancelled?: (quote: ActiveQuote, reason: string) => void;
  onQuotePosted?: (quote: ActiveQuote) => void;
  onQuotePostRejected?: (
    market: BinaryMarket,
    quote: QuoteInstruction,
    error?: string
  ) => void;
};

export type TokenBalanceSnapshot = {
  balance: number;
  allowance: number;
  refreshedAtMs: number;
};

type RewardScoringSnapshot = {
  isScoring: boolean;
  observedAtMs: number;
};

type CategoryExposureSnapshot = {
  inventoryNotionalUsdc: number;
  activeBuyNotionalUsdc: number;
  capUsdc: number;
};

type RecentlyResolvedQuote = ActiveQuote & {
  resolvedAtMs: number;
  resolution: "cancelled" | "filled";
};

type QuotePostRejectCategory =
  | "aggressive_liquidity_miss"
  | "sell_inventory_overcommit"
  | "min_size"
  | "post_only_cross"
  | "other";

type SellQuotePostSuppression = {
  untilMs: number;
  maxSuppressedSize: number;
  reason: string;
};

const RECENTLY_RESOLVED_QUOTE_TTL_MS = Math.max(
  60_000,
  config.marketMaker.balanceRefreshMs * 2,
  config.ws.userOrderTimeoutMs * 2
);
const EPSILON = 1e-9;
const POLYMARKET_MIN_ORDER_SIZE = 5;
const STRUCTURAL_REJECT_DEDUPE_WINDOW_MS = Math.max(
  30_000,
  config.marketMaker.sellRepostCooldownMs * 3,
  config.marketMaker.balanceRefreshMs
);
// Suppression window after a min_size rejection. Kept tight (10s) so that when a
// position crosses back above the minimum via a fresh fill or rebalance, the bot
// re-tries SELL quickly instead of sitting out for a full 30s.
const MIN_SIZE_REJECT_SUPPRESSION_MS = Math.max(
  10_000,
  config.marketMaker.sellRepostCooldownMs * 2
);

// HTTP error classification and backoff tables
type HttpErrorCategory =
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "venue_reject"
  | "unknown";

const asErrorStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const response = (error as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === "number" && Number.isFinite(response.status)) {
    return response.status;
  }
  return undefined;
};

const asErrorMessage = (error: unknown): string => {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const classifyHttpError = (error: unknown): HttpErrorCategory => {
  const status = asErrorStatusCode(error);
  if (status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500 && status < 600) return "server_error";
  const msg = asErrorMessage(error).toLowerCase();
  if (
    status === 400 &&
    (
      msg.includes("order_version_mismatch") ||
      msg.includes("order version mismatch")
    )
  ) {
    return "venue_reject";
  }
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("aborted")) {
    return "timeout";
  }
  if (msg.includes("econnreset") || msg.includes("econnrefused") || msg.includes("network")) {
    return "network";
  }
  return "unknown";
};

/** Backoff duration in ms by error category. Rate-limited = longest to respect the venue. */
const HTTP_BACKOFF_MS: Record<HttpErrorCategory, number> = {
  rate_limited: 60_000,
  server_error: 15_000,
  timeout: 10_000,
  network: 10_000,
  venue_reject: 120_000,
  unknown: 5_000
};

/** Per-order retry cap — prevents runaway retries on pathological failures. */
const PER_QUOTE_MAX_RETRIES = 3;

const asPostedResponses = (payload: unknown): PostedOrderResponse[] => {
  if (Array.isArray(payload)) {
    return payload as PostedOrderResponse[];
  }

  if (payload && typeof payload === "object" && "orders" in payload) {
    const candidate = (payload as { orders?: unknown }).orders;
    return Array.isArray(candidate) ? (candidate as PostedOrderResponse[]) : [];
  }

  if (payload && typeof payload === "object" && "success" in payload) {
    return [payload as PostedOrderResponse];
  }

  return [];
};

type CancelResolution = {
  confirmedIds: Set<string>;
  rejectedIds: Set<string>;
  assumedAllCancelled: boolean;
};

const CANCEL_CONFIRMED_KEYS = new Set([
  "canceled",
  "cancelled",
  "canceled_orders",
  "cancelled_orders",
  "canceledOrders",
  "cancelledOrders"
]);
const CANCEL_REJECTED_KEYS = new Set([
  "not_canceled",
  "not_cancelled",
  "notCanceled",
  "notCancelled",
  "failed",
  "failures",
  "errors"
]);

const collectKnownOrderIds = (
  value: unknown,
  knownIds: ReadonlySet<string>,
  output: Set<string>
): void => {
  if (typeof value === "string") {
    if (knownIds.has(value)) {
      output.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectKnownOrderIds(item, knownIds, output);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (knownIds.has(key)) {
      output.add(key);
    }
    collectKnownOrderIds(nested, knownIds, output);
  }
};

const isTerminalCancelRejectionMessage = (value: unknown): boolean => {
  const normalized = String(value ?? "").toLowerCase();

  return (
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes("already filled") ||
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found") ||
    normalized.includes("not found")
  );
};

const collectCancelRejectedOrderIds = (
  value: unknown,
  knownIds: ReadonlySet<string>,
  confirmedIds: Set<string>,
  rejectedIds: Set<string>
): void => {
  if (typeof value === "string") {
    if (knownIds.has(value)) {
      rejectedIds.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectCancelRejectedOrderIds(item, knownIds, confirmedIds, rejectedIds);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (knownIds.has(key)) {
      if (isTerminalCancelRejectionMessage(nested)) {
        confirmedIds.add(key);
      } else {
        rejectedIds.add(key);
      }
      continue;
    }

    collectCancelRejectedOrderIds(nested, knownIds, confirmedIds, rejectedIds);
  }
};

const resolveCancelOrdersResponse = (
  payload: unknown,
  requestedOrderIds: readonly string[]
): CancelResolution => {
  const knownIds = new Set(requestedOrderIds);
  const confirmedIds = new Set<string>();
  const rejectedIds = new Set<string>();

  if (payload === undefined || payload === null) {
    return {
      confirmedIds: new Set(requestedOrderIds),
      rejectedIds,
      assumedAllCancelled: true
    };
  }

  if (Array.isArray(payload)) {
    collectKnownOrderIds(payload, knownIds, confirmedIds);
    if (confirmedIds.size === 0) {
      return {
        confirmedIds: new Set(requestedOrderIds),
        rejectedIds,
        assumedAllCancelled: true
      };
    }
    return {
      confirmedIds,
      rejectedIds,
      assumedAllCancelled: confirmedIds.size === 0
    };
  }

  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (CANCEL_CONFIRMED_KEYS.has(key)) {
        collectKnownOrderIds(value, knownIds, confirmedIds);
        continue;
      }

      if (CANCEL_REJECTED_KEYS.has(key)) {
        collectCancelRejectedOrderIds(value, knownIds, confirmedIds, rejectedIds);
        continue;
      }

      if (!knownIds.has(key)) {
        continue;
      }

      const normalized = String(value ?? "").toLowerCase();
      if (
        value === true ||
        normalized.includes("cancelled") ||
        normalized.includes("canceled") ||
        normalized.includes("success")
      ) {
        confirmedIds.add(key);
      } else {
        rejectedIds.add(key);
      }
    }
  }

  for (const rejectedId of rejectedIds) {
    confirmedIds.delete(rejectedId);
  }

  if (confirmedIds.size === 0 && rejectedIds.size === 0) {
    return {
      confirmedIds: new Set(requestedOrderIds),
      rejectedIds,
      assumedAllCancelled: true
    };
  }

  return {
    confirmedIds,
    rejectedIds,
    assumedAllCancelled: false
  };
};

const quoteKey = (tokenId: string, side: Side, quoteSlot?: string): string =>
  `${tokenId}:${side}:${quoteSlot ?? "primary"}`;

const resolvePassiveBuyRefreshAgeMs = (
  activeQuote: ActiveQuote | QuoteInstruction,
  desiredQuote?: QuoteInstruction
): number | undefined => {
  const candidate =
    desiredQuote?.side === Side.BUY
      ? desiredQuote.maxRestingAgeMs
      : activeQuote.side === Side.BUY
        ? activeQuote.maxRestingAgeMs
        : undefined;

  return typeof candidate === "number" && candidate > 0 ? candidate : undefined;
};

const sameQuote = (left: QuoteInstruction, right: QuoteInstruction): boolean =>
  left.side === right.side &&
  left.tokenId === right.tokenId &&
  left.quoteSlot === right.quoteSlot &&
  Math.abs(left.price - right.price) < 1e-9 &&
  Math.abs(left.size - right.size) < 1e-9 &&
  left.orderType === right.orderType &&
  left.postOnly === right.postOnly &&
  left.executionStyle === right.executionStyle &&
  left.expiration === right.expiration;

const isNonCriticalAggressiveLiquidityMiss = (
  quote: QuoteInstruction,
  error?: string
): boolean =>
  !quote.postOnly &&
  quote.orderType === OrderType.FOK &&
  typeof error === "string" &&
  /couldn't be fully filled/i.test(error);

const classifyQuotePostReject = (
  quote: QuoteInstruction,
  error?: string
): QuotePostRejectCategory => {
  if (isNonCriticalAggressiveLiquidityMiss(quote, error)) {
    return "aggressive_liquidity_miss";
  }

  if (
    quote.side === Side.SELL &&
    typeof error === "string" &&
    /not enough balance|balance is not enough|insufficient.*(?:balance|allowance)/i.test(error)
  ) {
    return "sell_inventory_overcommit";
  }

  if (
    typeof error === "string" &&
    /size\s*\([^)]*\)\s*lower than the minimum|below min(?:imum)? order size|invalid amounts?/i.test(
      error
    )
  ) {
    return "min_size";
  }

  if (
    quote.postOnly &&
    typeof error === "string" &&
    /invalid post-only order|crosses book/i.test(error)
  ) {
    return "post_only_cross";
  }

  return "other";
};

const buildQuoteRejectSignature = (
  market: BinaryMarket,
  quote: QuoteInstruction,
  category: QuotePostRejectCategory,
  error?: string
): string => {
  const normalizedError =
    category === "other" && typeof error === "string" ? error.trim().toLowerCase() : category;
  return [
    market.conditionId,
    quote.tokenId,
    quote.side,
    quote.quoteSlot ?? "primary",
    quote.size.toFixed(4),
    quote.price.toFixed(4),
    normalizedError
  ].join(":");
};

const isPassiveSellTrackingCandidate = (
  activeQuote: ActiveQuote | QuoteInstruction,
  desiredQuote: QuoteInstruction
): boolean =>
  config.marketMaker.enablePassiveSellTracking &&
  activeQuote.side === Side.SELL &&
  desiredQuote.side === Side.SELL &&
  activeQuote.tokenId === desiredQuote.tokenId &&
  activeQuote.postOnly &&
  desiredQuote.postOnly &&
  activeQuote.executionStyle !== "one-side-aggressive-exit" &&
  desiredQuote.executionStyle !== "one-side-aggressive-exit";

const getPassiveSellTrackingTriggerDistance = (desiredQuote: QuoteInstruction): number => {
  let triggerDistance = Number.POSITIVE_INFINITY;

  if (config.marketMaker.passiveSellTrackingTriggerAbsolute > EPSILON) {
    triggerDistance = Math.min(
      triggerDistance,
      config.marketMaker.passiveSellTrackingTriggerAbsolute
    );
  }

  if (config.marketMaker.passiveSellTrackingTriggerBps > EPSILON) {
    triggerDistance = Math.min(
      triggerDistance,
      desiredQuote.price * (config.marketMaker.passiveSellTrackingTriggerBps / 10_000)
    );
  }

  if (!Number.isFinite(triggerDistance)) {
    triggerDistance = desiredQuote.tickSize;
  }

  return Math.max(desiredQuote.tickSize, triggerDistance);
};

const shouldForcePassiveSellTrackingRefresh = (
  activeQuote: ActiveQuote | QuoteInstruction,
  desiredQuote: QuoteInstruction,
  nowMs?: number
): boolean => {
  if (!isPassiveSellTrackingCandidate(activeQuote, desiredQuote)) {
    return false;
  }

  // Price-displacement trigger.
  if (
    Math.abs(activeQuote.price - desiredQuote.price) + EPSILON >=
    getPassiveSellTrackingTriggerDistance(desiredQuote)
  ) {
    return true;
  }

  // Independent age-based trigger: a SELL that has rested past the max-age threshold
  // gets forcibly refreshed even if the market hasn't moved. This catches the case
  // where the book is stationary but our quote is sitting outside the touch — without
  // this, a stale SELL could rest forever on a slow-moving book.
  if (
    typeof nowMs === "number" &&
    "openedAtMs" in activeQuote &&
    typeof activeQuote.openedAtMs === "number" &&
    config.marketMaker.passiveSellMaxAgeMs > 0 &&
    nowMs - activeQuote.openedAtMs >= config.marketMaker.passiveSellMaxAgeMs
  ) {
    return true;
  }

  return false;
};

const resolveUnchangedPassiveQuoteRefreshAgeMs = (
  activeQuote: ActiveQuote,
  desiredQuote: QuoteInstruction,
  passiveRefreshProtectionMs: number
): number | undefined => {
  if (!sameQuote(activeQuote, desiredQuote) || !activeQuote.postOnly || !desiredQuote.postOnly) {
    return undefined;
  }

  // Keep same-price passive BUYs resting on the book. Refreshing them at a
  // fixed timer needlessly forfeits queue priority even though nothing about
  // the desired order has changed. The exception is when the strategy attaches
  // an explicit freshness lease to the passive BUY.
  if (activeQuote.side === Side.BUY) {
    return resolvePassiveBuyRefreshAgeMs(activeQuote, desiredQuote);
  }

  const refreshCandidates = [
    passiveRefreshProtectionMs,
    config.marketMaker.staleRequoteAfterMs
  ];

  if (config.marketMaker.passiveSellMaxAgeMs > 0) {
    refreshCandidates.push(config.marketMaker.passiveSellMaxAgeMs);
  }

  const refreshAgeMs = Math.max(...refreshCandidates.filter((value) => value > 0));
  return Number.isFinite(refreshAgeMs) && refreshAgeMs > 0 ? refreshAgeMs : undefined;
};

const canKeepPassiveQuoteResting = (
  activeQuote: ActiveQuote | QuoteInstruction,
  desiredQuote: QuoteInstruction,
  nowMs: number,
  passiveRefreshProtectionMs: number = config.marketMaker.passiveRefreshMinRestMs
): boolean => {
  const activeQuoteAgeMs =
    "openedAtMs" in activeQuote && typeof activeQuote.openedAtMs === "number"
      ? Math.max(0, nowMs - activeQuote.openedAtMs)
      : 0;
  const passiveBuyRefreshAgeMs = resolvePassiveBuyRefreshAgeMs(activeQuote, desiredQuote);

  if (sameQuote(activeQuote, desiredQuote)) {
    if (
      activeQuote.side === Side.BUY &&
      typeof passiveBuyRefreshAgeMs === "number" &&
      activeQuoteAgeMs + 1e-9 >= passiveBuyRefreshAgeMs
    ) {
      return false;
    }

    return true;
  }

  if (
    !activeQuote.postOnly ||
    !desiredQuote.postOnly ||
    activeQuote.side !== desiredQuote.side ||
    activeQuote.tokenId !== desiredQuote.tokenId ||
    Math.abs(activeQuote.size - desiredQuote.size) >= 1e-9 ||
    activeQuote.orderType !== desiredQuote.orderType ||
    activeQuote.expiration !== desiredQuote.expiration
  ) {
    return false;
  }

  const tickSize = Math.max(activeQuote.tickSize, desiredQuote.tickSize, Number.EPSILON);
  const priceDelta = activeQuote.price - desiredQuote.price;

  // 🔒 Hard lifetime cap: a passive quote that has been live longer than this
  // must be replaced regardless of safer-drift protection. Without this, a
  // SELL anchored at 0.30 stays parked while bestAsk drops to 0.27 — that
  // quote is "safer" (selling higher) but stale and never executes.
  const maxLifetimeMs = config.marketMaker.passiveQuoteMaxLifetimeMs;
  if (maxLifetimeMs > 0 && activeQuoteAgeMs >= maxLifetimeMs) {
    return false;
  }

  const saferDriftTicks =
    activeQuoteAgeMs + 1e-9 < passiveRefreshProtectionMs
      ? config.marketMaker.passiveRefreshMaxSaferDriftTicks
      : 1;
  const maxSaferDrift = Math.max(0, saferDriftTicks) * tickSize;

  if (activeQuote.side === Side.BUY) {
    return priceDelta <= 1e-9 && priceDelta >= -maxSaferDrift - 1e-9;
  }

  return priceDelta >= -1e-9 && priceDelta <= maxSaferDrift + 1e-9;
};

export class QuoteExecutor {
  private readonly activeQuotes = new Map<string, ActiveQuote>();
  private readonly recentlyResolvedQuotesByOrderId = new Map<string, RecentlyResolvedQuote>();
  private readonly balanceCache = new Map<string, TokenBalanceSnapshot>();
  private readonly rewardScoringByOrderId = new Map<string, RewardScoringSnapshot>();
  private readonly lastRequoteAt = new Map<string, number>();
  private readonly marketByTokenId = new Map<string, BinaryMarket>();
  private readonly referencePriceByTokenId = new Map<string, number>();
  private readonly recentQuoteRejectAtBySignature = new Map<string, number>();
  private readonly sellQuotePostSuppressionByTokenId = new Map<
    string,
    SellQuotePostSuppression
  >();
  /** Global API backoff — when set, ALL quote posts pause until this timestamp.
   * Triggered by 429 (rate-limited) errors to respect venue rate limits. */
  private globalApiBackoffUntilMs = 0;
  /** Per-market backoff from HTTP 5xx/timeout errors. */
  private readonly marketBackoffUntilMsByCondition = new Map<string, number>();
  /** Per-quote retry counter (quoteKey → attempts). Reset on success. */
  private readonly quoteRetryCountByKey = new Map<string, number>();
  private readonly cancelInFlightOrderIds = new Set<string>();

  constructor(
    private readonly client: ClobClient,
    private readonly logger: Logger,
    private readonly positionManager?: PositionManager,
    private readonly riskManager?: RiskManagerLike,
    private readonly hooks?: QuoteExecutorHooks,
    private readonly displacementTracker?: QuoteDisplacementTracker
  ) {}

  private async postSignedQuoteOrders(
    signedOrders: readonly SignedOrder[],
    quotes: readonly QuoteInstruction[]
  ): Promise<PostedOrderResponse[]> {
    if (signedOrders.length !== quotes.length) {
      throw new Error("Signed order count does not match quote count.");
    }

    const firstPostOnly = quotes[0]?.postOnly ?? false;
    const canBatch = quotes.every((quote) => (quote.postOnly ?? false) === firstPostOnly);
    if (canBatch) {
      return asPostedResponses(
        await this.client.postOrders(
          signedOrders.map((order, index) => ({
            order,
            orderType: quotes[index]!.orderType
          })),
          firstPostOnly
        )
      );
    }

    const responses: PostedOrderResponse[] = [];
    for (const [index, order] of signedOrders.entries()) {
      const quote = quotes[index]!;
      responses.push(
        ...asPostedResponses(
          await this.client.postOrder(order, quote.orderType, quote.postOnly ?? false)
        )
      );
    }
    return responses;
  }

  setMarketUniverse(markets: readonly BinaryMarket[]): void {
    this.marketByTokenId.clear();

    for (const market of markets) {
      this.marketByTokenId.set(market.tokenIds[0], market);
      this.marketByTokenId.set(market.tokenIds[1], market);
    }

    this.positionManager?.setMarketUniverse(markets);
  }

  private pruneRejectTracking(nowMs: number = Date.now()): void {
    for (const [signature, occurredAtMs] of this.recentQuoteRejectAtBySignature.entries()) {
      if (nowMs - occurredAtMs > STRUCTURAL_REJECT_DEDUPE_WINDOW_MS) {
        this.recentQuoteRejectAtBySignature.delete(signature);
      }
    }

    for (const [tokenId, suppression] of this.sellQuotePostSuppressionByTokenId.entries()) {
      if (nowMs >= suppression.untilMs) {
        this.sellQuotePostSuppressionByTokenId.delete(tokenId);
      }
    }
  }

  private rememberRecentStructuralReject(signature: string, nowMs: number): boolean {
    const previousAtMs = this.recentQuoteRejectAtBySignature.get(signature);
    this.recentQuoteRejectAtBySignature.set(signature, nowMs);
    return (
      typeof previousAtMs === "number" &&
      nowMs - previousAtMs < STRUCTURAL_REJECT_DEDUPE_WINDOW_MS
    );
  }

  private rememberSellQuotePostSuppression(
    tokenId: string,
    size: number,
    reason: string,
    nowMs: number,
    durationMs: number = MIN_SIZE_REJECT_SUPPRESSION_MS
  ): void {
    const existing = this.sellQuotePostSuppressionByTokenId.get(tokenId);
    this.sellQuotePostSuppressionByTokenId.set(tokenId, {
      untilMs: Math.max(existing?.untilMs ?? 0, nowMs + Math.max(1, durationMs)),
      maxSuppressedSize: Math.max(existing?.maxSuppressedSize ?? 0, size),
      reason
    });
  }

  suppressSellQuotesForToken(
    tokenId: string,
    reason: string,
    nowMs: number = Date.now(),
    durationMs: number = Math.max(
      5_000,
      config.marketMaker.sellRepostCooldownMs,
      config.marketMaker.balanceRefreshMs
    )
  ): void {
    this.rememberSellQuotePostSuppression(
      tokenId,
      Number.POSITIVE_INFINITY,
      reason,
      nowMs,
      durationMs
    );
  }

  private getSellQuotePostSuppression(
    tokenId: string,
    size: number,
    nowMs: number
  ): SellQuotePostSuppression | undefined {
    const suppression = this.sellQuotePostSuppressionByTokenId.get(tokenId);

    if (!suppression) {
      return undefined;
    }

    if (nowMs >= suppression.untilMs) {
      this.sellQuotePostSuppressionByTokenId.delete(tokenId);
      return undefined;
    }

    return size <= suppression.maxSuppressedSize + 1e-9 ? suppression : undefined;
  }

  async syncPositionManager(plan: MarketMakerPlan): Promise<void> {
    if (!this.positionManager) {
      return;
    }

    for (const tokenPlan of plan.tokenPlans) {
      this.positionManager.updateReferencePrice(tokenPlan.tokenId, tokenPlan.midpoint);
      const snapshot = await this.getConditionalBalance(tokenPlan.tokenId);
      this.positionManager.updateTokenInventory(tokenPlan.tokenId, snapshot);
    }
  }

  async reconcile(plan: MarketMakerPlan): Promise<void> {
    for (const tokenPlan of plan.tokenPlans) {
      this.referencePriceByTokenId.set(tokenPlan.tokenId, tokenPlan.midpoint);
    }

    this.pruneRejectTracking();

    // Pre-emptively cancel any passive sell-layer quotes for tokens that are about to receive
    // aggressive-exit orders. This ensures the venue's sum_of_matched_orders for those tokens
    // is cleared BEFORE we post the aggressive-exit, preventing "not enough balance" rejections
    // that occur when both sell-layers and aggressive-exit orders are simultaneously active.
    await this.cancelSellLayersBeforeAggressiveExit(plan);

    const desiredQuotes = await this.filterQuotesByInventory(plan.market, plan.quotes);
    const activeForMarket = [...this.activeQuotes.values()].filter(
      (quote) => quote.conditionId === plan.market.conditionId
    );
    const desiredMap = new Map<string, QuoteInstruction>(
      desiredQuotes.map((quote) => [quoteKey(quote.tokenId, quote.side, quote.quoteSlot), quote])
    );
    const now = Date.now();
    const staleRefreshQuoteKeys = new Set<string>();
    const passiveSellTrackingRefreshTokenIds = new Set<string>();

    const getPassiveRefreshProtectionMs = (
      activeQuote: ActiveQuote,
      desiredQuote: QuoteInstruction
    ): number => {
      let protectionMs = config.marketMaker.passiveRefreshMinRestMs;
      const scoringSnapshot = this.rewardScoringByOrderId.get(activeQuote.orderId);

      if (
        scoringSnapshot &&
        !scoringSnapshot.isScoring &&
        activeQuote.side === Side.BUY &&
        activeQuote.postOnly &&
        desiredQuote.postOnly
      ) {
        protectionMs = Math.max(
          protectionMs,
          config.marketMaker.passiveToAggressiveAfterMs
        );
      }

      return protectionMs;
    };

    for (const activeQuote of activeForMarket) {
      const desiredQuote = desiredMap.get(
        quoteKey(activeQuote.tokenId, activeQuote.side, activeQuote.quoteSlot)
      );

      if (!desiredQuote || !desiredQuote.postOnly || !activeQuote.postOnly) {
        continue;
      }

      const passiveRefreshProtectionMs = getPassiveRefreshProtectionMs(
        activeQuote,
        desiredQuote
      );
      const unchangedRefreshAgeMs = resolveUnchangedPassiveQuoteRefreshAgeMs(
        activeQuote,
        desiredQuote,
        passiveRefreshProtectionMs
      );

      if (
        unchangedRefreshAgeMs === undefined ||
        now - activeQuote.openedAtMs + 1e-9 < unchangedRefreshAgeMs
      ) {
        continue;
      }

      staleRefreshQuoteKeys.add(
        quoteKey(activeQuote.tokenId, activeQuote.side, activeQuote.quoteSlot)
      );
    }

    for (const activeQuote of activeForMarket) {
      const desiredQuote = desiredMap.get(
        quoteKey(activeQuote.tokenId, activeQuote.side, activeQuote.quoteSlot)
      );

      if (!desiredQuote) {
        continue;
      }

      if (!shouldForcePassiveSellTrackingRefresh(activeQuote, desiredQuote, now)) {
        continue;
      }

      passiveSellTrackingRefreshTokenIds.add(activeQuote.tokenId);
    }

    const quotesToCancel = activeForMarket.filter((activeQuote) => {
      const key = quoteKey(activeQuote.tokenId, activeQuote.side, activeQuote.quoteSlot);
      const desiredQuote = desiredMap.get(key);
      const passiveRefreshProtectionMs = desiredQuote
        ? getPassiveRefreshProtectionMs(activeQuote, desiredQuote)
        : config.marketMaker.passiveRefreshMinRestMs;
      const forcePassiveSellTrackingRefresh =
        activeQuote.side === Side.SELL &&
        passiveSellTrackingRefreshTokenIds.has(activeQuote.tokenId);
      return (
        forcePassiveSellTrackingRefresh ||
        staleRefreshQuoteKeys.has(key) ||
        !desiredQuote ||
        !canKeepPassiveQuoteResting(
          activeQuote,
          desiredQuote,
          now,
          passiveRefreshProtectionMs
        )
      );
    });
    const sellTokensBeingReleased = new Set(
      quotesToCancel
        .filter((quote) => quote.side === Side.SELL)
        .map((quote) => quote.tokenId)
    );
    const quotesToPost = desiredQuotes.filter((desiredQuote) => {
      const key = quoteKey(desiredQuote.tokenId, desiredQuote.side, desiredQuote.quoteSlot);
      const activeQuote = this.activeQuotes.get(key);
      const passiveRefreshProtectionMs = activeQuote
        ? getPassiveRefreshProtectionMs(activeQuote, desiredQuote)
        : config.marketMaker.passiveRefreshMinRestMs;
      const forcePassiveSellTrackingRefresh =
        desiredQuote.side === Side.SELL &&
        passiveSellTrackingRefreshTokenIds.has(desiredQuote.tokenId);
      return (
        forcePassiveSellTrackingRefresh ||
        staleRefreshQuoteKeys.has(key) ||
        !activeQuote ||
        activeQuote.conditionId !== plan.market.conditionId ||
        !canKeepPassiveQuoteResting(
          activeQuote,
          desiredQuote,
          now,
          passiveRefreshProtectionMs
        )
      );
    });
    const filteredQuotesToPost = quotesToPost.filter((desiredQuote) => {
      if (desiredQuote.side !== Side.SELL) {
        return true;
      }

      const key = quoteKey(desiredQuote.tokenId, desiredQuote.side, desiredQuote.quoteSlot);
      const forcePassiveSellTrackingRefresh =
        passiveSellTrackingRefreshTokenIds.has(desiredQuote.tokenId);
      if (
        !forcePassiveSellTrackingRefresh &&
        !staleRefreshQuoteKeys.has(key) &&
        sellTokensBeingReleased.has(desiredQuote.tokenId)
      ) {
        return false;
      }

      const suppression = this.getSellQuotePostSuppression(
        desiredQuote.tokenId,
        desiredQuote.size,
        now
      );

      if (!suppression) {
        return true;
      }

      this.logger.debug(
        {
          market: plan.market.slug,
          tokenId: desiredQuote.tokenId,
          outcome: desiredQuote.outcome,
          price: desiredQuote.price,
          size: desiredQuote.size,
          suppressedUntilMs: suppression.untilMs,
          suppressionReason: suppression.reason
        },
        "Suppressed SELL repost because the venue recently rejected the same residual size."
      );
      return false;
    });

    if (filteredQuotesToPost.length !== quotesToPost.length) {
      this.logger.debug(
        {
          market: plan.market.slug,
          suppressedSellTokens: [...sellTokensBeingReleased],
          originalQuoteCount: quotesToPost.length,
          filteredQuoteCount: filteredQuotesToPost.length
        },
        "Suppressed immediate SELL reposts for tokens whose passive SELL quotes were being refreshed."
      );
    }

    if (passiveSellTrackingRefreshTokenIds.size > 0) {
      this.logger.debug(
        {
          market: plan.market.slug,
          tokenIds: [...passiveSellTrackingRefreshTokenIds],
          triggerBps: config.marketMaker.passiveSellTrackingTriggerBps,
          triggerAbsolute: config.marketMaker.passiveSellTrackingTriggerAbsolute
        },
        "Refreshing passive SELL ladder at the current market tracking anchor."
      );
    }

    if (staleRefreshQuoteKeys.size > 0) {
      this.logger.debug(
        {
          market: plan.market.slug,
          staleRequoteAfterMs: config.marketMaker.staleRequoteAfterMs,
          passiveSellMaxAgeMs: config.marketMaker.passiveSellMaxAgeMs,
          passiveRefreshMinRestMs: config.marketMaker.passiveRefreshMinRestMs,
          staleQuoteKeys: [...staleRefreshQuoteKeys]
        },
        "Refreshing stale passive quotes at the current top-of-book target."
      );
    }

    if (quotesToCancel.length === 0 && filteredQuotesToPost.length === 0) {
      return;
    }

    const lastRequoteAt = this.lastRequoteAt.get(plan.market.conditionId) ?? 0;
    const effectiveRequoteCooldownMs = isLiveMarket(plan.market, now)
      ? Math.min(config.marketMaker.requoteCooldownMs, config.marketMaker.liveRequoteCooldownMs)
      : config.marketMaker.requoteCooldownMs;
    const isInsideRequoteCooldown =
      now - lastRequoteAt < effectiveRequoteCooldownMs;
    const bypassRequoteCooldownForStaleRefresh = staleRefreshQuoteKeys.size > 0;

    if (isInsideRequoteCooldown && !bypassRequoteCooldownForStaleRefresh) {
      this.logger.debug(
        {
          market: plan.market.slug,
          now,
          lastRequoteAt,
          requoteCooldownMs: config.marketMaker.requoteCooldownMs
        },
        "Skipped quote refresh because the market is still inside the requote cooldown."
      );
      return;
    }

    if (isInsideRequoteCooldown && bypassRequoteCooldownForStaleRefresh) {
      this.logger.debug(
        {
          market: plan.market.slug,
          now,
          lastRequoteAt,
          requoteCooldownMs: config.marketMaker.requoteCooldownMs,
          staleQuoteKeys: [...staleRefreshQuoteKeys]
        },
        "Bypassed requote cooldown to refresh stale passive quotes."
      );
    }

    this.lastRequoteAt.set(plan.market.conditionId, now);

    // Capture requoteCounts and detect price-displacement events BEFORE cancellation
    // so we can carry the counter forward and track competition pressure.
    const inheritedRequoteCounts = new Map<string, number>();
    for (const cancelled of quotesToCancel) {
      const key = quoteKey(cancelled.tokenId, cancelled.side, cancelled.quoteSlot);
      inheritedRequoteCounts.set(key, cancelled.requoteCount);

      const isStaleRefresh = staleRefreshQuoteKeys.has(key);
      const desiredQuote = desiredMap.get(key);

      if (
        !isStaleRefresh &&
        desiredQuote &&
        cancelled.postOnly &&
        desiredQuote.postOnly &&
        !sameQuote(cancelled, desiredQuote)
      ) {
        this.displacementTracker?.recordPriceDisplacement(cancelled.conditionId);
      }
    }

    await this.cancelQuotesByOrderIds(
      quotesToCancel.map((quote) => quote.orderId),
      "quote refresh"
    );

    if (filteredQuotesToPost.length === 0) {
      return;
    }

    // Pre-submission cross-book price guard for post-only quotes.
    // The venue rejects post-only orders whose price would immediately match (cross) the
    // opposite side, counting each rejection as an orderFailure. We detect these cases here
    // using the live bestBid/bestAsk from the plan's tokenPlans and pull the price one tick
    // inside the book so the order stays passive. This avoids spurious orderFailure increments
    // that would otherwise push the bot toward DEGRADED/HALTED prematurely.
    const tokenPlanByTokenId = new Map(plan.tokenPlans.map((tp) => [tp.tokenId, tp]));
    const quotesToSubmit = filteredQuotesToPost.map((quote): QuoteInstruction => {
      if (!quote.postOnly) return quote;
      const tp = tokenPlanByTokenId.get(quote.tokenId);
      if (!tp) return quote;

      if (quote.side === Side.BUY && quote.price + EPSILON >= tp.bestAsk) {
        const adjusted = clampPrice(tp.bestAsk - quote.tickSize, quote.tickSize);
        if (adjusted + EPSILON < quote.price) {
          this.logger.info(
            {
              market: plan.market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: "BUY",
              originalPrice: quote.price,
              adjustedPrice: adjusted,
              bestAsk: tp.bestAsk,
              quoteSlot: quote.quoteSlot ?? "primary"
            },
            "Pre-submission price adjusted: post-only BUY would cross ask; pulled 1 tick inside."
          );
          return { ...quote, price: adjusted };
        }
      }

      if (quote.side === Side.SELL && quote.price <= tp.bestBid + EPSILON) {
        const adjusted = clampPrice(tp.bestBid + quote.tickSize, quote.tickSize);
        if (adjusted > quote.price + EPSILON) {
          this.logger.info(
            {
              market: plan.market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: "SELL",
              originalPrice: quote.price,
              adjustedPrice: adjusted,
              bestBid: tp.bestBid,
              quoteSlot: quote.quoteSlot ?? "primary"
            },
            "Pre-submission price adjusted: post-only SELL would cross bid; pushed 1 tick inside."
          );
          return { ...quote, price: adjusted };
        }
      }

      return quote;
    });

    // Backoff checks must happen before signing. createOrder may call venue
    // metadata endpoints, so skipping here avoids extra traffic while a market
    // is cooling down after a structural reject.
    if (this.globalApiBackoffUntilMs > now) {
      this.logger.info(
        { market: plan.market.slug, untilMs: this.globalApiBackoffUntilMs, remainingMs: this.globalApiBackoffUntilMs - now },
        "Skipping quote post — global API backoff active."
      );
      return;
    }

    const marketBackoffUntilMs = this.marketBackoffUntilMsByCondition.get(plan.market.conditionId) ?? 0;
    if (marketBackoffUntilMs > now) {
      this.logger.info(
        { market: plan.market.slug, remainingMs: marketBackoffUntilMs - now },
        "Skipping quote post — per-market backoff active."
      );
      return;
    }

    const orderVersionDisagreements = quotesToSubmit.filter(
      (quote) => typeof quote.negRisk === "boolean" && quote.negRisk !== plan.market.negRisk
    );
    if (orderVersionDisagreements.length > 0) {
      this.logger.info(
        {
          market: plan.market.slug,
          marketNegRisk: plan.market.negRisk,
          quoteOrderVersions: orderVersionDisagreements.map((quote) => ({
            tokenId: quote.tokenId,
            side: quote.side,
            quoteSlot: quote.quoteSlot ?? "primary",
            bookNegRisk: quote.negRisk
          }))
        },
        "Market metadata and order-book negRisk differ; letting CLOB client resolve the order version."
      );
    }

    const signedOrders = await Promise.all(
      quotesToSubmit.map((quote) =>
        this.client.createOrder(
          {
            tokenID: quote.tokenId,
            price: quote.price,
            size: quote.size,
            side: quote.side,
            expiration: quote.expiration
          },
          {
            tickSize: this.toTickString(quote.tickSize)
          }
        )
      )
    );

    let responses: PostedOrderResponse[];
    try {
      responses = await this.postSignedQuoteOrders(signedOrders, quotesToSubmit);
    } catch (postError) {
      // HTTP-level failure (429 / 5xx / timeout / network) — apply backoff by category.
      const category = classifyHttpError(postError);
      const backoffMs = HTTP_BACKOFF_MS[category];
      const errorStatus = asErrorStatusCode(postError);
      const errorMessage = asErrorMessage(postError);

      if (category === "rate_limited") {
        // Global pause — the venue is throttling us, stop everything.
        this.globalApiBackoffUntilMs = now + backoffMs;
        this.logger.warn(
          { market: plan.market.slug, category, backoffMs, errorStatus, errorMessage },
          "postOrders rate-limited (429) — applying GLOBAL backoff to all markets."
        );
      } else if (category === "venue_reject") {
        // Market/order-shape reject (for example order_version_mismatch) is not a
        // wallet/API outage. Back off this market, but do not halt the whole bot.
        this.marketBackoffUntilMsByCondition.set(plan.market.conditionId, now + backoffMs);
        this.logger.warn(
          { market: plan.market.slug, category, backoffMs, errorStatus, errorMessage },
          "postOrders venue rejected this market/order version — applying per-market backoff without global API risk."
        );
      } else {
        // Per-market pause for 5xx/timeout/network.
        this.marketBackoffUntilMsByCondition.set(plan.market.conditionId, now + backoffMs);
        this.logger.warn(
          { market: plan.market.slug, category, backoffMs, errorStatus, errorMessage },
          "postOrders failed — applying per-market backoff."
        );
      }

      // Bump per-quote retry counter and hard-cap it.
      for (const quote of quotesToSubmit) {
        const retryKey = quoteKey(quote.tokenId, quote.side, quote.quoteSlot);
        const prevRetries = this.quoteRetryCountByKey.get(retryKey) ?? 0;
        this.quoteRetryCountByKey.set(retryKey, prevRetries + 1);
        if (prevRetries + 1 >= PER_QUOTE_MAX_RETRIES) {
          this.logger.warn(
            { market: plan.market.slug, tokenId: quote.tokenId, side: quote.side, retries: prevRetries + 1 },
            "Per-quote retry cap hit — this quote will be suppressed until next reconcile cycle."
          );
        }
      }

      if (category !== "venue_reject") {
        this.riskManager?.noteApiError?.(`postOrders.${category}:${plan.market.slug}`);
      }
      return;
    }

    for (const [index, quote] of quotesToSubmit.entries()) {
      const response = responses[index];

      if (response?.success && response.orderID) {
        const key = quoteKey(quote.tokenId, quote.side, quote.quoteSlot);
        // Reset retry counter and clear any per-market backoff on successful post.
        this.quoteRetryCountByKey.delete(key);
        this.marketBackoffUntilMsByCondition.delete(plan.market.conditionId);
        const inheritedCount = inheritedRequoteCounts.get(key) ?? -1;
        const activeQuote: ActiveQuote = {
          ...quote,
          conditionId: plan.market.conditionId,
          marketSlug: plan.market.slug,
          category: plan.market.category,
          orderId: response.orderID,
          intentCreatedAtMs: plan.generatedAtMs,
          openedAtMs: now,
          firstFillAtMs: undefined,
          partialFillCount: 0,
          requoteCount: inheritedCount + 1
        };
        this.activeQuotes.set(key, activeQuote);

        if (quote.postOnly) {
          this.displacementTracker?.recordQuotePosted(plan.market.conditionId);
        }

        this.hooks?.onQuotePosted?.(activeQuote);
        continue;
      }

      this.logger.warn(
        {
          market: plan.market.slug,
          tokenId: quote.tokenId,
          outcome: quote.outcome,
          side: quote.side,
          price: quote.price,
          size: quote.size,
          error: response?.errorMsg
        },
        "Quote post failed or was rejected."
      );
      this.hooks?.onQuotePostRejected?.(plan.market, quote, response?.errorMsg);
      // Emit a quality log stub for rejected posts (no orderId yet — use a placeholder).
      this.logger.info(
        {
          market: plan.market.slug,
          outcome: quote.outcome,
          side: quote.side,
          quoteSlot: quote.quoteSlot ?? "primary",
          price: quote.price,
          size: quote.size,
          intentCreatedAtMs: plan.generatedAtMs,
          postedAtMs: now,
          resolvedAtMs: now,
          timeOnBookMs: 0,
          partialFillCount: 0,
          requoteCount: (inheritedRequoteCounts.get(quoteKey(quote.tokenId, quote.side, quote.quoteSlot)) ?? -1) + 1,
          resolution: "post-rejected",
          reason: response?.errorMsg
        },
        "Order lifecycle complete."
      );

      const rejectCategory = classifyQuotePostReject(quote, response?.errorMsg);

      if (rejectCategory === "aggressive_liquidity_miss") {
        this.logger.info(
          {
            market: plan.market.slug,
            tokenId: quote.tokenId,
            outcome: quote.outcome,
            side: quote.side,
            price: quote.price,
            size: quote.size,
            orderType: quote.orderType,
            executionStyle: quote.executionStyle
          },
          "Aggressive quote missed available liquidity without a full fill. Skipping risk failure increment."
        );
        continue;
      }

      if (rejectCategory === "sell_inventory_overcommit") {
        this.invalidateConditionalBalance(quote.tokenId);
        this.suppressSellQuotesForToken(
          quote.tokenId,
          response?.errorMsg ?? "sell inventory over-commit rejected",
          now
        );
        this.logger.info(
          {
            market: plan.market.slug,
            tokenId: quote.tokenId,
            outcome: quote.outcome,
            side: quote.side,
            price: quote.price,
            size: quote.size,
            orderType: quote.orderType,
            executionStyle: quote.executionStyle,
            error: response?.errorMsg
          },
          "SELL post rejected because venue inventory was already committed. Skipping risk failure increment."
        );
        continue;
      }

      if (quote.side === Side.SELL && rejectCategory === "min_size") {
        this.rememberSellQuotePostSuppression(
          quote.tokenId,
          quote.size,
          response?.errorMsg ?? "below minimum order size",
          now
        );
      }

      // post_only_cross: attempt one immediate retry with a safer price before
      // falling through to the structural-reject dedup path.
      if (rejectCategory === "post_only_cross" && quote.postOnly) {
        const tp = tokenPlanByTokenId.get(quote.tokenId);
        if (tp) {
          const saferPrice =
            quote.side === Side.BUY
              ? clampPrice(tp.bestAsk - quote.tickSize * 2, quote.tickSize)
              : clampPrice(tp.bestBid + quote.tickSize * 2, quote.tickSize);
          const priceImproved =
            quote.side === Side.BUY
              ? saferPrice + EPSILON < quote.price
              : saferPrice > quote.price + EPSILON;

          if (priceImproved) {
            this.logger.info(
              {
                market: plan.market.slug,
                tokenId: quote.tokenId,
                side: quote.side,
                originalPrice: quote.price,
                retryPrice: saferPrice,
                quoteSlot: quote.quoteSlot ?? "primary"
              },
              "post_only_cross rejected — retrying once with 2-tick safer price."
            );
            try {
              const retryQuote: QuoteInstruction = { ...quote, price: saferPrice };
              const retrySignedOrder = await this.client.createOrder(
                {
                  tokenID: retryQuote.tokenId,
                  price: retryQuote.price,
                  size: retryQuote.size,
                  side: retryQuote.side,
                  expiration: retryQuote.expiration
                },
                {
                  tickSize: this.toTickString(retryQuote.tickSize)
                }
              );
              const retryResponses = asPostedResponses(
                await this.client.postOrders(
                  [
                    {
                      order: retrySignedOrder,
                      orderType: retryQuote.orderType
                    }
                  ],
                  retryQuote.postOnly ?? false
                )
              );
              const retryResponse = retryResponses[0];
              if (retryResponse?.success && retryResponse.orderID) {
                const retryKey = quoteKey(retryQuote.tokenId, retryQuote.side, retryQuote.quoteSlot);
                this.activeQuotes.set(retryKey, {
                  ...retryQuote,
                  conditionId: plan.market.conditionId,
                  marketSlug: plan.market.slug,
                  category: plan.market.category,
                  orderId: retryResponse.orderID,
                  intentCreatedAtMs: plan.generatedAtMs,
                  openedAtMs: now,
                  firstFillAtMs: undefined,
                  partialFillCount: 0,
                  requoteCount: (inheritedRequoteCounts.get(retryKey) ?? 0) + 1
                });
                if (retryQuote.postOnly) {
                  this.displacementTracker?.recordQuotePosted(plan.market.conditionId);
                }
                continue; // retry succeeded — skip failure tracking
              }
            } catch {
              // retry failed — fall through to normal failure handling
            }
          }
        }
      }

      if (rejectCategory === "min_size" || rejectCategory === "post_only_cross") {
        const rejectSignature = buildQuoteRejectSignature(
          plan.market,
          quote,
          rejectCategory,
          response?.errorMsg
        );

        if (this.rememberRecentStructuralReject(rejectSignature, now)) {
          this.logger.info(
            {
              market: plan.market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              price: quote.price,
              size: quote.size,
              rejectCategory,
              error: response?.errorMsg
            },
            "Skipped duplicate structural quote rejection to avoid over-counting order failures."
          );
          continue;
        }
      }

      this.riskManager?.noteOrderFailure?.(
        "market-making.quote-post",
        `${plan.market.slug}:${quote.tokenId}:${quote.side}:${quote.quoteSlot ?? "primary"}${
          response?.errorMsg ? `:${response.errorMsg}` : ""
        }`
      );
    }
  }

  async cancelMarketQuotes(conditionId: string): Promise<void> {
    const activeForMarket = [...this.activeQuotes.values()].filter(
      (quote) => quote.conditionId === conditionId
    );

    await this.cancelQuotesByOrderIds(
      activeForMarket.map((quote) => quote.orderId),
      "market quote refresh or withdrawal"
    );
  }

  async cancelQuotesBySide(side: Side, reason: string): Promise<void> {
    const activeForSide = [...this.activeQuotes.values()].filter((quote) => quote.side === side);

    await this.cancelQuotesByOrderIds(
      activeForSide.map((quote) => quote.orderId),
      reason
    );
  }

  // 🔒 Cancels all BUY quotes on a specific condition. Used after a BUY fill
  // arrives to prevent cascade partial-fills: the next reconcile cycle would
  // otherwise re-post BUY based on stale inventory and accept another fill
  // before the inventory-cap logic catches up (observed: 60 shares filled in
  // 10 seconds on Hormuz NO despite 42-share cap).
  async cancelConditionBuyQuotes(conditionId: string, reason: string): Promise<void> {
    const activeBuysForCondition = [...this.activeQuotes.values()].filter(
      (quote) => quote.conditionId === conditionId && quote.side === Side.BUY
    );

    if (activeBuysForCondition.length === 0) return;

    await this.cancelQuotesByOrderIds(
      activeBuysForCondition.map((quote) => quote.orderId),
      reason
    );
  }

  async cancelExpiredPassiveBuyQuotes(
    nowMs: number = Date.now(),
    reason = "passive buy max age watchdog"
  ): Promise<ActiveQuote[]> {
    const expiredQuotes = [...this.activeQuotes.values()].filter((quote) => {
      if (quote.side !== Side.BUY || !quote.postOnly) {
        return false;
      }

      if (quote.executionStyle === "one-side-aggressive-exit") {
        return false;
      }

      const maxRestingAgeMs =
        typeof quote.maxRestingAgeMs === "number" && quote.maxRestingAgeMs > 0
          ? quote.maxRestingAgeMs
          : config.marketMaker.passiveBuyMaxAgeMs;

      return nowMs - quote.openedAtMs + EPSILON >= Math.max(1_000, maxRestingAgeMs);
    });

    if (expiredQuotes.length === 0) {
      return [];
    }

    const snapshots = expiredQuotes.map((quote) => ({ ...quote }));

    await this.cancelQuotesByOrderIds(
      expiredQuotes.map((quote) => quote.orderId),
      reason
    );

    this.logger.info(
      {
        orderCount: expiredQuotes.length,
        reason,
        quotes: expiredQuotes.map((quote) => ({
          market: quote.marketSlug,
          orderId: quote.orderId,
          tokenId: quote.tokenId,
          outcome: quote.outcome,
          quoteSlot: quote.quoteSlot ?? "primary",
          ageMs: Math.max(0, nowMs - quote.openedAtMs),
          maxRestingAgeMs:
            typeof quote.maxRestingAgeMs === "number" && quote.maxRestingAgeMs > 0
              ? quote.maxRestingAgeMs
              : config.marketMaker.passiveBuyMaxAgeMs
        }))
      },
      "Cancelled expired passive BUY quotes by global age watchdog."
    );

    return snapshots;
  }

  async cancelTokenSellQuotes(
    tokenId: string,
    conditionId: string | undefined,
    reason: string
  ): Promise<void> {
    const activeSellsForToken = [...this.activeQuotes.values()].filter(
      (quote) =>
        quote.tokenId === tokenId &&
        quote.side === Side.SELL &&
        (!conditionId || quote.conditionId === conditionId)
    );

    if (activeSellsForToken.length === 0) return;

    await this.cancelQuotesByOrderIds(
      activeSellsForToken.map((quote) => quote.orderId),
      reason
    );
  }

  getActiveQuotes(): ActiveQuote[] {
    return [...this.activeQuotes.values()].map((quote) => ({ ...quote }));
  }

  getActiveQuote(tokenId: string, side: Side, quoteSlot?: string): ActiveQuote | undefined {
    const activeQuote = this.activeQuotes.get(quoteKey(tokenId, side, quoteSlot));
    return activeQuote ? { ...activeQuote } : undefined;
  }

  getActiveQuoteByOrderId(orderId: string): ActiveQuote | undefined {
    const activeQuote = [...this.activeQuotes.values()].find((quote) => quote.orderId === orderId);
    return activeQuote ? { ...activeQuote } : undefined;
  }

  getTrackedQuoteByOrderId(orderId: string): ActiveQuote | undefined {
    this.pruneRecentlyResolvedQuotes();
    const activeQuote = this.getActiveQuoteByOrderId(orderId);

    if (activeQuote) {
      return activeQuote;
    }

    const recentQuote = this.recentlyResolvedQuotesByOrderId.get(orderId);
    return recentQuote ? { ...recentQuote } : undefined;
  }

  updateRewardScoring(scoring: Record<string, boolean>): void {
    const nowMs = Date.now();
    const activeOrderIds = new Set(
      [...this.activeQuotes.values()].map((quote) => quote.orderId)
    );

    for (const orderId of [...this.rewardScoringByOrderId.keys()]) {
      if (!activeOrderIds.has(orderId) || !(orderId in scoring)) {
        this.rewardScoringByOrderId.delete(orderId);
      }
    }

    for (const orderId of activeOrderIds) {
      if (!(orderId in scoring)) {
        continue;
      }

      this.rewardScoringByOrderId.set(orderId, {
        isScoring: Boolean(scoring[orderId]),
        observedAtMs: nowMs
      });
    }
  }

  /** Read the most recently cached sellable shares for a token without refresh.
   * Returns undefined if no snapshot exists. Used by phantom-inventory detection. */
  getKnownVenueShares(tokenId: string): number | undefined {
    const cached = this.balanceCache.get(tokenId);
    if (!cached) return undefined;
    return Math.min(cached.balance, cached.allowance);
  }

  invalidateConditionalBalance(tokenId?: string): void {
    if (tokenId) {
      this.balanceCache.delete(tokenId);
      return;
    }

    this.balanceCache.clear();
  }

  async getConditionalBalanceSnapshot(
    tokenId: string,
    options?: {
      forceRefresh?: boolean;
    }
  ): Promise<TokenBalanceSnapshot> {
    return this.getConditionalBalance(tokenId, options);
  }

  removeActiveQuoteByOrderId(orderId: string): ActiveQuote | undefined {
    for (const [key, activeQuote] of this.activeQuotes.entries()) {
      if (activeQuote.orderId !== orderId) {
        continue;
      }

      this.activeQuotes.delete(key);
      this.rewardScoringByOrderId.delete(orderId);
      return { ...activeQuote };
    }

    return undefined;
  }

  removeTrackedQuoteByOrderId(orderId: string): ActiveQuote | undefined {
    const activeQuote = this.removeActiveQuoteByOrderId(orderId);

    if (activeQuote) {
      return activeQuote;
    }

    const recentQuote = this.recentlyResolvedQuotesByOrderId.get(orderId);

    if (!recentQuote) {
      return undefined;
    }

    this.recentlyResolvedQuotesByOrderId.delete(orderId);
    return { ...recentQuote };
  }

  async cancelQuotesByOrderIds(orderIds: readonly string[], reason: string): Promise<void> {
    const uniqueOrderIds = [...new Set(orderIds)]
      .filter(Boolean)
      .filter((orderId) => !this.cancelInFlightOrderIds.has(orderId));

    if (uniqueOrderIds.length === 0) {
      return;
    }

    for (const orderId of uniqueOrderIds) {
      this.cancelInFlightOrderIds.add(orderId);
    }

    try {
      const activeQuotes = [...this.activeQuotes.values()];
      const quotes = uniqueOrderIds
        .map((orderId) => activeQuotes.find((quote) => quote.orderId === orderId))
        .filter((quote): quote is ActiveQuote => Boolean(quote));

      if (uniqueOrderIds.length > 1) {
        try {
          const cancelResponse = await this.client.cancelOrders(uniqueOrderIds);
          const cancelResolution = resolveCancelOrdersResponse(cancelResponse, uniqueOrderIds);
          const confirmedQuotes = quotes.filter((quote) =>
            cancelResolution.confirmedIds.has(quote.orderId)
          );
          const rejectedQuotes = quotes.filter((quote) =>
            cancelResolution.rejectedIds.has(quote.orderId)
          );

          for (const quote of confirmedQuotes) {
            this.rememberRecentlyResolvedQuote(quote, "cancelled", Date.now());
            this.activeQuotes.delete(quoteKey(quote.tokenId, quote.side, quote.quoteSlot));
            this.rewardScoringByOrderId.delete(quote.orderId);
            this.hooks?.onQuoteCancelled?.(quote, reason);
          }

          this.logger.info(
            {
              orderCount: uniqueOrderIds.length,
              confirmedCount: confirmedQuotes.length,
              rejectedCount: rejectedQuotes.length,
              assumedAllCancelled: cancelResolution.assumedAllCancelled,
              reason
            },
            "Cancelled quotes in batch."
          );

          if (rejectedQuotes.length > 0) {
            this.logger.warn(
              {
                orderCount: uniqueOrderIds.length,
                rejectedOrderIds: rejectedQuotes.map((quote) => quote.orderId),
                reason,
                cancelResponse
              },
              "Batch quote cancel returned not-cancelled orders; keeping them tracked for fill recovery."
            );
          }

          return;
        } catch (error) {
          this.logger.warn(
            { err: error, orderCount: uniqueOrderIds.length, reason },
            "Batch quote cancel failed. Falling back to single-order cancels."
          );
        }
      }

      for (const quote of quotes) {
        await this.cancelQuote(quote, reason);
      }
    } finally {
      for (const orderId of uniqueOrderIds) {
        this.cancelInFlightOrderIds.delete(orderId);
      }
    }
  }

  /**
   * Before posting aggressive-exit quotes, cancel any passive sell-layer quotes for the same
   * token that remain active at the venue. Without this step, both sell-layers and
   * aggressive-exit quotes would simultaneously reserve inventory at the venue, causing
   * "not enough balance / allowance" rejections from the CLOB.
   *
   * After cancellation we also invalidate the balance cache so that filterQuotesByInventory
   * fetches a fresh snapshot that no longer counts the cancelled orders as committed.
   */
  private async cancelSellLayersBeforeAggressiveExit(plan: MarketMakerPlan): Promise<void> {
    // Collect tokenIds that will receive aggressive-exit orders in this plan.
    const aggressiveExitTokenIds = new Set(
      plan.quotes
        .filter((q) => q.executionStyle === "one-side-aggressive-exit")
        .map((q) => q.tokenId)
    );

    if (aggressiveExitTokenIds.size === 0) {
      return;
    }

    // Find active sell orders for those tokens that are NOT themselves aggressive-exit orders.
    // These are passive sell-layers that need to be cleared from the venue first.
    const sellLayersToCancel = [...this.activeQuotes.values()].filter(
      (q) =>
        aggressiveExitTokenIds.has(q.tokenId) &&
        q.side === Side.SELL &&
        q.executionStyle !== "one-side-aggressive-exit"
    );

    if (sellLayersToCancel.length === 0) {
      return;
    }

    this.logger.info(
      {
        market: plan.market.slug,
        cancellingLayers: sellLayersToCancel.map((q) => ({
          quoteSlot: q.quoteSlot ?? "primary",
          orderId: q.orderId,
          price: q.price,
          size: q.size
        }))
      },
      "Pre-cancelling passive sell-layers before posting aggressive-exit orders."
    );

    await this.cancelQuotesByOrderIds(
      sellLayersToCancel.map((q) => q.orderId),
      "pre-aggressive-exit sell-layer clearance"
    );

    // Invalidate the balance cache for affected tokens so the subsequent
    // filterQuotesByInventory call fetches a fresh post-cancel balance.
    for (const tokenId of aggressiveExitTokenIds) {
      this.invalidateConditionalBalance(tokenId);
    }
  }

  private async filterQuotesByInventory(
    market: BinaryMarket,
    quotes: readonly QuoteInstruction[]
  ): Promise<QuoteInstruction[]> {
    const filtered: QuoteInstruction[] = [];
    const reservedCategoryBuyNotionalUsdc = new Map<string, number>();
    const reservedSellSizeByTokenId = new Map<string, number>();
    const tokenActiveBuyNotionalUsdcByTokenId = new Map<string, number>();
    const getTokenActiveBuyNotionalUsdc = (tokenId: string): number => {
      const cached = tokenActiveBuyNotionalUsdcByTokenId.get(tokenId);

      if (typeof cached === "number") {
        return cached;
      }

      const activeBuyNotionalUsdc = [...this.activeQuotes.values()]
        .filter((activeQuote) => activeQuote.tokenId === tokenId && activeQuote.side === Side.BUY)
        .reduce((total, activeQuote) => total + activeQuote.price * activeQuote.size, 0);

      tokenActiveBuyNotionalUsdcByTokenId.set(tokenId, activeBuyNotionalUsdc);
      return activeBuyNotionalUsdc;
    };

    for (const quote of quotes) {
      if (quote.side === Side.BUY) {
        const minimumBuyQuoteSize = Math.max(
          market.orderMinSize,
          POLYMARKET_MIN_ORDER_SIZE,
          1e-9
        );

        if (quote.size + 1e-9 < minimumBuyQuoteSize) {
          this.logger.debug(
            {
              market: market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              size: quote.size,
              minimumBuyQuoteSize
            },
            "Suppressed buy quote because the requested size was below the venue minimum."
          );
          continue;
        }
      }

      if (quote.side === Side.SELL) {
        const minimumSellQuoteSize = Math.max(
          config.marketMaker.minSellShares,
          market.orderMinSize,
          POLYMARKET_MIN_ORDER_SIZE,
          1e-9
        );

        if (quote.size + 1e-9 < minimumSellQuoteSize) {
          this.logger.debug(
            {
              market: market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              size: quote.size,
              minimumSellQuoteSize
            },
            "Suppressed sell quote because the requested size was below the venue minimum."
          );
          continue;
        }

        const snapshot = await this.getConditionalBalance(quote.tokenId, {
          forceRefresh: true
        });
        const venueBalance = Math.min(snapshot.balance, snapshot.allowance);
        const managedSnapshot = this.positionManager?.getTokenInventorySnapshot(
          quote.tokenId
        );
        const managedSellableSize = managedSnapshot
          ? Math.min(managedSnapshot.balance, managedSnapshot.allowance)
          : undefined;
        // Subtract the committed size of any active SELL orders for this token whose
        // quoteSlots are NOT present in the current desired batch. Such orders are NOT
        // being replaced in this reconcile cycle — they remain live at the venue and
        // tie up inventory. This prevents double-committing when e.g. multiple SELL
        // paths coexist during a transition (sell-layers → aggressive-exit).
        const desiredSellSlots = new Set(
          quotes
            .filter((q) => q.tokenId === quote.tokenId && q.side === Side.SELL)
            .map((q) => q.quoteSlot ?? "primary")
        );
        const unreplacedActiveSellSize = [...this.activeQuotes.values()]
          .filter(
            (aq) =>
              aq.tokenId === quote.tokenId &&
              aq.side === Side.SELL &&
              !desiredSellSlots.has(aq.quoteSlot ?? "primary")
          )
          .reduce((sum, aq) => sum + aq.size, 0);
        const sellableSize = Math.max(
          0,
          Math.min(
            venueBalance,
            typeof managedSellableSize === "number" &&
              Number.isFinite(managedSellableSize)
              ? managedSellableSize
              : venueBalance
          ) - unreplacedActiveSellSize
        );
        const projectedReservedSellSize =
          (reservedSellSizeByTokenId.get(quote.tokenId) ?? 0) + quote.size;

        if (sellableSize + 1e-9 < projectedReservedSellSize) {
          if (snapshot.allowance < 1e-9 && snapshot.balance > 1e-9) {
            this.logger.warn(
              {
                market: market.slug,
                tokenId: quote.tokenId,
                outcome: quote.outcome,
                balance: snapshot.balance,
                allowance: snapshot.allowance
              },
              "SELL suppressed: CTF Exchange allowance is zero. Call setApprovalForAll on the Polymarket CTF Exchange contract for this wallet."
            );
          } else {
            this.logger.debug(
              {
                market: market.slug,
                tokenId: quote.tokenId,
                outcome: quote.outcome,
                balance: snapshot.balance,
                allowance: snapshot.allowance,
                managedBalance: managedSnapshot?.balance,
                managedAllowance: managedSnapshot?.allowance,
                sellableSize,
                projectedReservedSellSize
              },
              "Suppressed sell quote because inventory or allowance was insufficient."
            );
          }
          continue;
        }

        reservedSellSizeByTokenId.set(quote.tokenId, projectedReservedSellSize);
        filtered.push(quote);
        continue;
      }

      const snapshot = await this.getConditionalBalance(quote.tokenId);
      const existingActiveQuote = this.activeQuotes.get(
        quoteKey(quote.tokenId, quote.side, quote.quoteSlot)
      );
      const existingBuyNotionalUsdc =
        existingActiveQuote?.conditionId === market.conditionId &&
        existingActiveQuote.side === Side.BUY
          ? existingActiveQuote.price * existingActiveQuote.size
          : 0;
      const incrementalBuyNotionalUsdc = Math.max(
        0,
        quote.price * quote.size - existingBuyNotionalUsdc
      );
      const isRecoveryOpposingBuy = this.isRecoveryOpposingBuyQuote(market, quote);

      if (snapshot.balance >= config.marketMaker.maxTokenExposureShares) {
        this.logRecoveryOpposingBuySuppression(market, quote, isRecoveryOpposingBuy, {
          reasonCode: "max_token_exposure_shares",
          currentBalance: snapshot.balance,
          maxTokenExposureShares: config.marketMaker.maxTokenExposureShares
        });
        this.logger.debug(
          {
            market: market.slug,
            tokenId: quote.tokenId,
            outcome: quote.outcome,
            currentBalance: snapshot.balance,
            maxTokenExposureShares: config.marketMaker.maxTokenExposureShares
          },
          "Suppressed buy quote because token exposure was already above the configured cap."
        );
        continue;
      }

      if (
        config.marketMaker.maxTokenExposurePortfolioRatio > 0 &&
        incrementalBuyNotionalUsdc > 0
      ) {
        const referencePrice = this.referencePriceByTokenId.get(quote.tokenId) ?? 0.5;
        const inventoryNotionalUsdc = snapshot.balance * referencePrice;
        const activeBuyNotionalUsdc = getTokenActiveBuyNotionalUsdc(quote.tokenId);
        const portfolioReferenceUsdc = Math.max(
          config.capital.marketMakingBudgetUsdc,
          inventoryNotionalUsdc + activeBuyNotionalUsdc,
          1
        );
        const tokenExposureCapUsdc =
          portfolioReferenceUsdc * config.marketMaker.maxTokenExposurePortfolioRatio;
        const projectedTokenExposureUsdc =
          inventoryNotionalUsdc + activeBuyNotionalUsdc + incrementalBuyNotionalUsdc;

        if (projectedTokenExposureUsdc > tokenExposureCapUsdc + 1e-9) {
          this.logRecoveryOpposingBuySuppression(market, quote, isRecoveryOpposingBuy, {
            reasonCode: "token_exposure_portfolio_ratio",
            projectedTokenExposureUsdc,
            inventoryNotionalUsdc,
            activeBuyNotionalUsdc,
            incrementalBuyNotionalUsdc,
            tokenExposureCapUsdc,
            maxTokenExposurePortfolioRatio:
              config.marketMaker.maxTokenExposurePortfolioRatio,
            portfolioReferenceUsdc
          });
          this.logger.debug(
            {
              market: market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              projectedTokenExposureUsdc,
              inventoryNotionalUsdc,
              activeBuyNotionalUsdc,
              incrementalBuyNotionalUsdc,
              tokenExposureCapUsdc,
              maxTokenExposurePortfolioRatio:
                config.marketMaker.maxTokenExposurePortfolioRatio,
              portfolioReferenceUsdc
            },
            "Suppressed buy quote because token exposure would exceed the configured portfolio ratio cap."
          );
          continue;
        }
      }

      const normalizedCategory = market.category?.trim().toLowerCase();

      if (
        normalizedCategory &&
        config.marketMaker.maxCategoryExposureUsdc > 0
      ) {
        const categoryExposure = await this.getCategoryExposureSnapshot(normalizedCategory);
        const reservedBuyNotionalUsdc =
          reservedCategoryBuyNotionalUsdc.get(normalizedCategory) ?? 0;
        const projectedCategoryExposureUsdc =
          categoryExposure.inventoryNotionalUsdc +
          categoryExposure.activeBuyNotionalUsdc +
          reservedBuyNotionalUsdc +
          incrementalBuyNotionalUsdc;

        if (
          incrementalBuyNotionalUsdc > 0 &&
          projectedCategoryExposureUsdc >
            config.marketMaker.maxCategoryExposureUsdc + 1e-9
        ) {
          this.logRecoveryOpposingBuySuppression(market, quote, isRecoveryOpposingBuy, {
            reasonCode: "category_exposure_cap",
            category: market.category,
            projectedCategoryExposureUsdc,
            inventoryNotionalUsdc: categoryExposure.inventoryNotionalUsdc,
            activeBuyNotionalUsdc: categoryExposure.activeBuyNotionalUsdc,
            incrementalBuyNotionalUsdc,
            maxCategoryExposureUsdc: config.marketMaker.maxCategoryExposureUsdc
          });
          this.logger.debug(
            {
              market: market.slug,
              category: market.category,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              projectedCategoryExposureUsdc,
              inventoryNotionalUsdc: categoryExposure.inventoryNotionalUsdc,
              activeBuyNotionalUsdc: categoryExposure.activeBuyNotionalUsdc,
              incrementalBuyNotionalUsdc,
              maxCategoryExposureUsdc: config.marketMaker.maxCategoryExposureUsdc
            },
            "Suppressed buy quote because category exposure would exceed the configured cap."
          );
          continue;
        }

        reservedCategoryBuyNotionalUsdc.set(
          normalizedCategory,
          reservedBuyNotionalUsdc + incrementalBuyNotionalUsdc
        );
      }

      filtered.push(quote);
    }

    return filtered;
  }

  private isRecoveryOpposingBuyQuote(
    market: BinaryMarket,
    quote: QuoteInstruction
  ): boolean {
    if (quote.side !== Side.BUY) {
      return false;
    }

    return [...this.activeQuotes.values()].some(
      (activeQuote) =>
        activeQuote.conditionId === market.conditionId &&
        activeQuote.side === Side.SELL &&
        activeQuote.executionStyle === "one-side-aggressive-exit" &&
        activeQuote.tokenId !== quote.tokenId
    );
  }

  private logRecoveryOpposingBuySuppression(
    market: BinaryMarket,
    quote: QuoteInstruction,
    shouldLog: boolean,
    details: Record<string, number | string | undefined>
  ): void {
    if (!shouldLog) {
      return;
    }

    const activeRecoverySellQuotes = [...this.activeQuotes.values()]
      .filter(
        (activeQuote) =>
          activeQuote.conditionId === market.conditionId &&
          activeQuote.side === Side.SELL &&
          activeQuote.executionStyle === "one-side-aggressive-exit"
      )
      .map((activeQuote) => ({
        tokenId: activeQuote.tokenId,
        outcome: activeQuote.outcome,
        quoteSlot: activeQuote.quoteSlot ?? "primary",
        price: activeQuote.price,
        size: activeQuote.size,
        postOnly: activeQuote.postOnly
      }));

    this.logger.info(
      {
        market: market.slug,
        conditionId: market.conditionId,
        tokenId: quote.tokenId,
        outcome: quote.outcome,
        side: quote.side,
        price: quote.price,
        size: quote.size,
        orderType: quote.orderType,
        postOnly: quote.postOnly,
        activeRecoverySellQuotes,
        ...details
      },
      "Suppressed recovery opposing-side BUY before posting."
    );
  }

  private async getCategoryExposureSnapshot(
    normalizedCategory: string
  ): Promise<CategoryExposureSnapshot> {
    const categoryTokenIds = [...this.marketByTokenId.entries()]
      .filter(
        ([, market]) => market.category?.trim().toLowerCase() === normalizedCategory
      )
      .map(([tokenId]) => tokenId);
    let inventoryNotionalUsdc = 0;

    for (const tokenId of categoryTokenIds) {
      const snapshot = await this.getConditionalBalance(tokenId);
      const referencePrice = this.referencePriceByTokenId.get(tokenId) ?? 0.5;
      inventoryNotionalUsdc += snapshot.balance * referencePrice;
    }

    const activeBuyNotionalUsdc = [...this.activeQuotes.values()]
      .filter(
        (quote) => quote.side === Side.BUY && quote.category?.trim().toLowerCase() === normalizedCategory
      )
      .reduce((total, quote) => total + quote.price * quote.size, 0);

    return {
      inventoryNotionalUsdc,
      activeBuyNotionalUsdc,
      capUsdc: config.marketMaker.maxCategoryExposureUsdc
    };
  }

  private async getConditionalBalance(
    tokenId: string,
    options?: {
      forceRefresh?: boolean;
    }
  ): Promise<TokenBalanceSnapshot> {
    const cached = this.balanceCache.get(tokenId);

    if (
      !options?.forceRefresh &&
      cached &&
      Date.now() - cached.refreshedAtMs < config.marketMaker.balanceRefreshMs
    ) {
      return cached;
    }

    const balanceAllowance = (await this.client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId
    })) as unknown as {
      balance?: string;
      allowance?: string;
      allowances?: Record<string, string>;
    };
    // Polymarket CTF conditional tokens are returned in raw on-chain units (1 share = 1,000,000).
    // Normalize to human-readable shares so comparisons against quote.size work correctly.
    const CONDITIONAL_SHARES_PRECISION = 1_000_000;
    const rawBalance = Number(balanceAllowance.balance) / CONDITIONAL_SHARES_PRECISION;

    // The CLOB API actually returns `allowances` as an object keyed by exchange-contract
    // address (CTF Exchange, Neg Risk CTF Exchange, Neg Risk Adapter), not a single
    // `allowance` string as the clob-client types claim. Take the max across all keys
    // so that whichever exchange routes the order has a valid allowance. Fall back to
    // the legacy singular field if ever present.
    let maxAllowanceRaw = 0;
    if (balanceAllowance.allowances && typeof balanceAllowance.allowances === "object") {
      for (const value of Object.values(balanceAllowance.allowances)) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > maxAllowanceRaw) {
          maxAllowanceRaw = parsed;
        }
      }
    } else if (balanceAllowance.allowance !== undefined) {
      const parsed = Number(balanceAllowance.allowance);
      if (Number.isFinite(parsed)) {
        maxAllowanceRaw = parsed;
      }
    }
    const rawAllowance = maxAllowanceRaw / CONDITIONAL_SHARES_PRECISION;
    const snapshot = {
      balance: Number.isFinite(rawBalance) ? rawBalance : 0,
      allowance: Number.isFinite(rawAllowance) ? rawAllowance : 0,
      refreshedAtMs: Date.now()
    };

    this.balanceCache.set(tokenId, snapshot);
    return snapshot;
  }

  /** Called by the fill-event handler in market-maker-bot whenever a fill event arrives. */
  notifyOrderFillProgress(orderId: string, isTerminal: boolean, nowMs: number = Date.now()): void {
    // Find the mutable object in the map directly so we can mutate it in place.
    for (const activeQuote of this.activeQuotes.values()) {
      if (activeQuote.orderId !== orderId) continue;

      activeQuote.partialFillCount += 1;
      if (activeQuote.firstFillAtMs === undefined) {
        activeQuote.firstFillAtMs = nowMs;
      }

      if (isTerminal) {
        this.emitOrderQualityLog(activeQuote, nowMs, "filled");
      }
      return;
    }

    const recentQuote = this.recentlyResolvedQuotesByOrderId.get(orderId);

    if (!recentQuote) {
      return;
    }

    if (recentQuote.firstFillAtMs === undefined) {
      recentQuote.firstFillAtMs = nowMs;
    }

    recentQuote.partialFillCount += 1;
  }

  private emitOrderQualityLog(
    quote: ActiveQuote,
    resolvedAtMs: number,
    resolution: "filled" | "cancelled" | "post-rejected",
    reason?: string
  ): void {
    const timeOnBookMs = resolvedAtMs - quote.openedAtMs;
    const timeToFirstFillMs =
      quote.firstFillAtMs !== undefined ? quote.firstFillAtMs - quote.openedAtMs : undefined;

    this.logger.info(
      {
        orderId: quote.orderId,
        market: quote.marketSlug,
        outcome: quote.outcome,
        side: quote.side,
        quoteSlot: quote.quoteSlot ?? "primary",
        price: quote.price,
        size: quote.size,
        intentCreatedAtMs: quote.intentCreatedAtMs,
        postedAtMs: quote.openedAtMs,
        firstFillAtMs: quote.firstFillAtMs,
        resolvedAtMs,
        timeOnBookMs,
        timeToFirstFillMs,
        partialFillCount: quote.partialFillCount,
        requoteCount: quote.requoteCount,
        resolution,
        reason
      },
      "Order lifecycle complete."
    );
  }

  private async cancelQuote(activeQuote: ActiveQuote, reason = "quote refresh"): Promise<void> {
    try {
      const cancelResponse = await this.client.cancelOrder({ orderID: activeQuote.orderId });
      const cancelResolution = resolveCancelOrdersResponse(cancelResponse, [activeQuote.orderId]);

      if (cancelResolution.rejectedIds.has(activeQuote.orderId)) {
        this.logger.warn(
          {
            market: activeQuote.marketSlug,
            orderId: activeQuote.orderId,
            tokenId: activeQuote.tokenId,
            outcome: activeQuote.outcome,
            side: activeQuote.side,
            reason,
            cancelResponse
          },
          "Quote cancel was not confirmed by the venue; keeping it tracked for fill recovery."
        );
        return;
      }

      this.logger.info(
        {
          market: activeQuote.marketSlug,
          orderId: activeQuote.orderId,
          tokenId: activeQuote.tokenId,
          outcome: activeQuote.outcome,
          side: activeQuote.side,
          reason
        },
        "Cancelled active quote."
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          market: activeQuote.marketSlug,
          orderId: activeQuote.orderId,
          tokenId: activeQuote.tokenId,
          side: activeQuote.side,
          reason
        },
        "Quote cancel failed."
      );
      this.riskManager?.noteOrderFailure?.(
        "market-making.quote-cancel",
        `${activeQuote.marketSlug}:${activeQuote.orderId}`
      );
      return;
    }

    const resolvedAtMs = Date.now();
    this.emitOrderQualityLog(activeQuote, resolvedAtMs, "cancelled", reason);
    this.rememberRecentlyResolvedQuote(activeQuote, "cancelled", resolvedAtMs);
    this.activeQuotes.delete(quoteKey(activeQuote.tokenId, activeQuote.side, activeQuote.quoteSlot));
    this.rewardScoringByOrderId.delete(activeQuote.orderId);
    this.hooks?.onQuoteCancelled?.(activeQuote, reason);
  }

  private rememberRecentlyResolvedQuote(
    quote: ActiveQuote,
    resolution: "cancelled" | "filled",
    resolvedAtMs: number
  ): void {
    this.pruneRecentlyResolvedQuotes(resolvedAtMs);
    this.recentlyResolvedQuotesByOrderId.set(quote.orderId, {
      ...quote,
      resolvedAtMs,
      resolution
    });
  }

  private pruneRecentlyResolvedQuotes(nowMs: number = Date.now()): void {
    for (const [orderId, quote] of this.recentlyResolvedQuotesByOrderId.entries()) {
      if (nowMs - quote.resolvedAtMs > RECENTLY_RESOLVED_QUOTE_TTL_MS) {
        this.recentlyResolvedQuotesByOrderId.delete(orderId);
      }
    }
  }

  private toTickString(tickSize: number): "0.1" | "0.01" | "0.001" | "0.0001" {
    if (tickSize === 0.1 || tickSize === 0.01 || tickSize === 0.001 || tickSize === 0.0001) {
      return String(tickSize) as "0.1" | "0.01" | "0.001" | "0.0001";
    }

    throw new Error(`Unsupported tick size for SDK order builder: ${tickSize}`);
  }
}
