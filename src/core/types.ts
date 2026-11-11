export type StrategyName =
  | "market-making"
  | "liquidity-rewards"
  | "maker-rebates"
  | "negative-risk"
  | "same-market-arb"
  | "risk-reduction";

export type OrderIntentSide = "BUY" | "SELL";
export type OrderIntentTimeInForce = "GTC" | "GTD" | "IOC" | "FOK";
export type ExecutionAction = "create" | "replace" | "keep";
export type RiskState = "RUNNING" | "WARNING" | "DEGRADED" | "RECOVERY" | "HALTED";

export type RejectedIntentReason =
  | "duplicate_intent"
  | "higher_priority_active_order"
  | "active_order_already_matches"
  | "condition_preempted_by_higher_priority_strategy"
  | "risk_blocked"
  | "position_blocked";

export interface OrderIntentMetadata {
  [key: string]: string | number | boolean | null | undefined;
}

export interface OrderIntent {
  id: string;
  strategy: StrategyName;
  priority: number;
  conditionId: string;
  tokenId: string;
  side: OrderIntentSide;
  quoteSlot?: string;
  price: number;
  size: number;
  tif: OrderIntentTimeInForce;
  postOnly: boolean;
  createdAtMs: number;
  reason: string;
  tags: string[];
  metadata?: OrderIntentMetadata;
}

export interface ActiveOrderState {
  orderId: string;
  strategy: StrategyName;
  priority: number;
  conditionId: string;
  tokenId: string;
  side: OrderIntentSide;
  quoteSlot?: string;
  price: number;
  size: number;
  tif: OrderIntentTimeInForce;
  postOnly: boolean;
  openedAtMs: number;
  intentId?: string;
}

export interface ExecutionPlanItem {
  action: ExecutionAction;
  intent: OrderIntent;
  reason: string;
  orderToCancel?: ActiveOrderState;
}

export interface RejectedIntent {
  intent: OrderIntent;
  reason: RejectedIntentReason;
  detail: string;
  blockingOrderId?: string;
  blockingStrategy?: StrategyName;
}

export interface ExecutionPlan {
  accepted: ExecutionPlanItem[];
  rejected: RejectedIntent[];
}

export interface RiskGateDecision {
  allowed: boolean;
  state: RiskState;
  reason?: string;
  detail?: string;
}

export interface RiskStatusSnapshot {
  state: RiskState;
  dayKey: string;
  dailyRealizedPnlUsdc: number;
  dailyLossUsdc: number;
  consecutiveLosses: number;
  apiErrors: number;
  orderFailures: number;
  stateMismatches: number;
  lastEventAtMs: number;
  haltReason?: string;
  haltDetail?: string;
  warnReason?: string;
  recoveryUntilMs?: number;
}

export interface PnlTradeRecord {
  id: string;
  dayKey: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  realizedPnlUsdc: number;
  grossRealizedPnlUsdc: number;
  feeCostUsdc: number;
  rebateUsdc: number;
  rewardUsdc: number;
  slippageCostUsdc: number;
  unfilledCostUsdc: number;
  gasCostUsdc: number;
  expectedEdgeUsdc?: number;
  shares?: number;
  openedAtMs?: number;
  closedAtMs: number;
  /** Timestamp when the triggering order was first submitted (intent/order creation). */
  createdAtMs?: number;
  /** Timestamp of the first fill event received for this order (partial or full). */
  firstFillAtMs?: number;
  /** Number of times this quote slot was cancel-replaced before this fill. */
  requoteCount?: number;
  /** Number of incremental fill events received (1 for a single fill, >1 for partials). */
  partialFillCount?: number;
  /** Populated for failed or cancelled orders that produce a PnL record (e.g. arb one-side recovery). */
  failureReason?: string;
  detail?: string;
  tags: string[];
  metadata?: OrderIntentMetadata;
}

export interface PnlTradeRecordInput
  extends Omit<
    PnlTradeRecord,
    | "dayKey"
    | "realizedPnlUsdc"
    | "grossRealizedPnlUsdc"
    | "feeCostUsdc"
    | "rebateUsdc"
    | "rewardUsdc"
    | "slippageCostUsdc"
    | "unfilledCostUsdc"
    | "gasCostUsdc"
  > {
  dayKey?: string;
  realizedPnlUsdc?: number;
  grossRealizedPnlUsdc?: number;
  feeCostUsdc?: number;
  rebateUsdc?: number;
  rewardUsdc?: number;
  slippageCostUsdc?: number;
  unfilledCostUsdc?: number;
  gasCostUsdc?: number;
}

export interface StrategyPnlSnapshot {
  strategy: StrategyName;
  dayKey: string;
  dailyRealizedPnlUsdc: number;
  lifetimeRealizedPnlUsdc: number;
  dailyGrossRealizedPnlUsdc: number;
  lifetimeGrossRealizedPnlUsdc: number;
  dailyFeeCostUsdc: number;
  lifetimeFeeCostUsdc: number;
  dailyRebateUsdc: number;
  lifetimeRebateUsdc: number;
  dailyRewardUsdc: number;
  lifetimeRewardUsdc: number;
  dailySlippageCostUsdc: number;
  lifetimeSlippageCostUsdc: number;
  dailyUnfilledCostUsdc: number;
  lifetimeUnfilledCostUsdc: number;
  dailyGasCostUsdc: number;
  lifetimeGasCostUsdc: number;
  dailyTradeCount: number;
  lifetimeTradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  // 📌 #13 청산 품질 — daily 단위 win/loss/flat 카운트. 전략별 분리 추적.
  dailyWinningTrades: number;
  dailyLosingTrades: number;
  dailyFlatTrades: number;
  lastTradeAtMs?: number;
}

export interface InventoryValuationSnapshot {
  openInventoryCostUsdc: number;
  openInventoryMarkValueUsdc: number;
  openInventoryUnrealizedPnlUsdc: number;
  pricedOpenTokenCount: number;
  unpricedOpenTokenCount: number;
  // 🔄 Local-vs-venue drift diagnostics. Populated when the valuation builder
  // is given a venue-share getter; zero/0 when not. Used by the operator-status
  // alert to flag sync drift between the bot's lot tracker and the venue.
  venueDriftTokenCount?: number;
  venueDriftAbsValueUsdc?: number;
  venueDriftSignedShares?: number;
}

export interface PortfolioPnlSnapshot {
  dayKey: string;
  dailyRealizedPnlUsdc: number;
  lifetimeRealizedPnlUsdc: number;
  dailyGrossRealizedPnlUsdc: number;
  lifetimeGrossRealizedPnlUsdc: number;
  dailyFeeCostUsdc: number;
  lifetimeFeeCostUsdc: number;
  dailyRebateUsdc: number;
  lifetimeRebateUsdc: number;
  dailyRewardUsdc: number;
  lifetimeRewardUsdc: number;
  dailySlippageCostUsdc: number;
  lifetimeSlippageCostUsdc: number;
  dailyUnfilledCostUsdc: number;
  lifetimeUnfilledCostUsdc: number;
  dailyGasCostUsdc: number;
  lifetimeGasCostUsdc: number;
  dailyTradeCount: number;
  lifetimeTradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  lastTradeAtMs?: number;
  dailyNetPnlUsdc?: number;
  lifetimeNetPnlUsdc?: number;
  openInventoryCostUsdc?: number;
  openInventoryMarkValueUsdc?: number;
  openInventoryUnrealizedPnlUsdc?: number;
  pricedOpenTokenCount?: number;
  unpricedOpenTokenCount?: number;
  byStrategy: Partial<Record<StrategyName, StrategyPnlSnapshot>>;
}

export interface RecordedTradePnl {
  trade: PnlTradeRecord;
  strategySnapshot: StrategyPnlSnapshot;
  portfolioSnapshot: PortfolioPnlSnapshot;
}

export interface PositionGateDecision {
  allowed: boolean;
  reason?: string;
  detail?: string;
  projectedExposureUsdc?: number;
  imbalanceScore?: number;
}

export interface RiskManagerLike {
  evaluateIntent(intent: OrderIntent): RiskGateDecision;
  getState?(): RiskState;
  getSnapshot?(): RiskStatusSnapshot;
  noteApiError?(source: string, detail?: string): RiskGateDecision;
  noteOrderFailure?(source: string, detail?: string): RiskGateDecision;
  noteStateMismatch?(source: string, detail?: string): RiskGateDecision;
  noteTradeClosed?(realizedPnlUsdc: number, source: string, detail?: string): RiskGateDecision;
}

export interface PnLEngineLike {
  recordTrade(record: PnlTradeRecordInput): RecordedTradePnl;
  getStrategySnapshot(strategy: StrategyName): StrategyPnlSnapshot;
  getPortfolioSnapshot(): PortfolioPnlSnapshot;
  getRecentTrades(limit?: number): PnlTradeRecord[];
  exportTrades(limit?: number): PnlTradeRecord[];
}

export interface PositionManagerLike {
  evaluateIntent(intent: OrderIntent): PositionGateDecision;
  beginBatch?(): void;
  commitApprovedIntent?(intent: OrderIntent): void;
  endBatch?(): void;
  deductTokenInventoryShares?(tokenId: string, shares: number, atMs?: number): void;
}

export interface CoordinationResult {
  approvedIntents: OrderIntent[];
  executionPlan: ExecutionPlan;
  rejected: RejectedIntent[];
}

export const STRATEGY_PRIORITY: Record<StrategyName, number> = {
  "negative-risk": 400,
  "same-market-arb": 400,
  "risk-reduction": 300,
  "market-making": 200,
  "maker-rebates": 150,
  "liquidity-rewards": 100
};

export const getDefaultStrategyPriority = (strategy: StrategyName): number =>
  STRATEGY_PRIORITY[strategy];
