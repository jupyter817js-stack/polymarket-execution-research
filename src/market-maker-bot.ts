import { AssetType, Side, type ClobClient, type MarketReward, type Trade } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "./config.js";
import {
  createConfiguredAlertDispatcher,
  type AlertDispatcher
} from "./core/alert-dispatcher.js";
import {
  buildOperatorStatusAlert,
  buildOrderFillAlert,
  buildQuotePostedAlert,
  buildQuotePostRejectedAlert,
  buildTimeBasedUnwindAlert
} from "./core/alert-events.js";
import {
  blendCapitalSignalScores,
  blendScopedCapitalSignals,
  buildMarketMakingCapitalSignal,
  buildMarketScopedCapitalSignals,
  buildScopedPerformanceCapitalSignals,
  buildStrategyPerformanceCapitalSignal
} from "./core/capital-allocation-signals.js";
import { buildRiskExecutionThrottleSnapshot } from "./core/degraded-execution-policy.js";
import { ExecutionEngine } from "./core/execution-engine.js";
import {
  InventoryLotTracker,
  type TrackedInventoryPosition
} from "./core/inventory-lot-tracker.js";
import { buildInventoryValuationSnapshot } from "./core/inventory-valuation.js";
import { createSeededInventoryLotTracker } from "./core/inventory-lot-seed.js";
import { restoreRiskRecoveryFromCheckpoint } from "./core/risk-manager-seed.js";
import { InventorySnapshotService } from "./core/inventory-snapshot-service.js";
import { recordInventoryCloseResult, type ExecutionQualityRecord } from "./core/inventory-pnl.js";
import {
  filterMarketsForSelectionEligibility,
  rankMarketsForSelection,
  type RankedMarketSelection
} from "./core/market-selection.js";
import {
  buildMarketSelectionSignal,
  estimateExpectedExitSeconds,
  estimateMarketableExitNotionalUsdc,
  estimatePassiveExitQueueAheadShares,
  buildMarketSelectionSignals,
  resolveSelectionTargetShares,
  buildSelectionSignalSubscriptionAssetIds
} from "./core/market-selection-signals.js";
import { isLiveMarket } from "./core/live-market-detector.js";
import { MarketCompetitionMonitor } from "./core/market-competition-monitor.js";
import { OperatorControl } from "./core/operator-control.js";
import { QuoteDisplacementTracker } from "./core/quote-displacement-tracker.js";
import {
  RuntimeCheckpointService,
  type RuntimeCheckpointSummary
} from "./core/runtime-checkpoint-service.js";
import { SelectionCooldownState } from "./core/selection-cooldown.js";
import {
  applyOneSideFillResponseToMarketMakerPlan,
  applyOneSideInventoryHardGateToMarketMakerPlan,
  applyAgeBasedUnwindToMarketMakerPlan,
  applyInventoryCapToMarketMakerPlan,
  applyInventoryExitGuardToMarketMakerPlan,
  applyMaxHoldHardExitToMarketMakerPlan,
  applyNetPairExitToMarketMakerPlan,
  applyPassiveToAggressiveTransitionToMarketMakerPlan,
  applyTakeProfitToMarketMakerPlan,
  buildMarketMakerPairInventoryState,
  resolveMarketMakerMaxHoldHardExitState,
  type MarketMakerOneSideFillRecoveryContext,
  resolveMarketMakerOneSideFillResponseState,
  resolveMarketMakerNetPairExitMode,
  resolveBoundedLossExitPriceForPosition,
  resolveMinimumExitPriceForPosition,
  buildRetainedMarketMakingIntents,
  activeQuoteToActiveOrder,
  buildMarketMakingIntents,
  filterMarketMakerPlanByBuySuppression,
  filterMarketMakerPlanByPassiveBuyPriceBand,
  expandSellQuotesToLayers,
  filterMarketMakerPlanByApprovedIntents,
  filterMarketMakerPlanBySellRepostCooldown,
  filterMarketMakerPlanByTrackedInventory
} from "./core/market-making-intents.js";
import { PnLEngine } from "./core/pnl-engine.js";
import { PositionManager } from "./core/position-manager.js";
import {
  buildMaxHoldRiskReductionBatchesFromOpenLots,
  buildRiskReductionCandidatesFromMarkets
} from "./core/risk-reduction-candidates.js";
import { RiskManager } from "./core/risk-manager.js";
import { StrategyCoordinator } from "./core/strategy-coordinator.js";
import type {
  PnLEngineLike,
  PortfolioPnlSnapshot,
  RiskManagerLike,
  RiskState,
  RiskStatusSnapshot,
  StrategyPnlSnapshot
} from "./core/types.js";
import { readMaxAllowanceRaw } from "./polymarket/balance-allowance.js";
import { fetchBinaryMarketsWithDiagnostics, mergeMarketsWithRewards } from "./polymarket/gamma.js";
import { MarketWsManager } from "./polymarket/market-ws.js";
import { OrderBookStore } from "./polymarket/orderbook-store.js";
import { UserWsTracker } from "./polymarket/user-ws.js";
import type { UserOrderFillProgressEvent } from "./polymarket/user-ws.js";
import {
  evaluateMarketMakerPlan,
  type MarketMakerFillRateFeedback,
  type MarketMakerEvaluation,
  type MarketMakerPlan,
  type QuoteInstruction
} from "./strategy/market-maker.js";
import { OrderHeartbeat } from "./trading/heartbeat.js";
import { QuoteExecutor } from "./trading/quote-executor.js";
import { RebateMonitor } from "./trading/rebate-monitor.js";
import type { MakerFillRecord } from "./trading/rebate-monitor.js";
import { ResolvedMarketClaimService } from "./trading/resolved-market-claim-service.js";
import { RiskReductionExecutor, type RiskReductionCandidate } from "./trading/risk-reduction-executor.js";
import { RewardMonitor } from "./trading/reward-monitor.js";
import { RealizedTradingSessionService } from "./session-report/realized-session-service.js";
import type { BinaryMarket } from "./types.js";
import { clampPrice, roundDownToTick, sleep } from "./utils.js";

type MakerFillAlertContext = {
  positionBeforeShares: number;
  positionAfterShares: number;
  averageCostUsdcPerShare?: number;
  currentPriceUsdc?: number;
  unrealizedPnlUsdc?: number;
  totalNetPnlUsdc?: number;
  positionBiasPct?: number;
  reason?: string;
  expectedPriceUsdc?: number;
  slippageUsdcPerShare?: number;
  orderType: "maker";
};

type MakerFillAlertRecord = MakerFillRecord & {
  expectedPriceUsdc?: number;
  executionQuality?: ExecutionQualityRecord;
  quotePostedAtMs?: number;
  quoteAgeMs?: number;
  quoteMaxRestingAgeMs?: number;
};

const rawUsdcToDecimal = (rawBalance: string | number): number => Number(rawBalance) / 1_000_000;

const isFilledMakerTradeStatus = (status: unknown): boolean =>
  ["MATCHED", "MINED", "CONFIRMED"].includes(String(status ?? "").toUpperCase());

type FillRateSample = {
  orderId: string;
  occurredAtMs: number;
};

type KnownQuoteOrderObservation = {
  orderId: string;
  conditionId: string;
  marketSlug: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;
  postedAtMs?: number;
  maxRestingAgeMs?: number;
  seenAtMs: number;
};

type TerminallyHandledQuoteOrder = KnownQuoteOrderObservation & {
  resolvedAtMs: number;
  matchedSize: number;
};

type RecentConfirmedInventoryCloseGuard = {
  tokenId: string;
  conditionId?: string;
  marketSlug: string;
  closedAtMs: number;
  closedShares: number;
  remainingSharesAfterClose: number;
};

type PostBuySellFeasibilityBlockedToken = {
  tokenId: string;
  recentTradeEvents: number;
  requiredRecentTradeEvents: number;
  bestBidNotionalUsdc?: number;
  requiredBestBidNotionalUsdc: number;
  marketableExitNotionalUsdc?: number;
  requiredMarketableExitNotionalUsdc: number;
  expectedExitSeconds?: number;
  requiredMaxExitSeconds: number;
  reasons: string[];
};

type PostBuySellFeasibilityBlock = {
  conditionId: string;
  observedAtMs: number;
  untilMs: number;
  reasons: string[];
  conditionRecentTradeEvents: number;
  requiredConditionRecentTradeEvents: number;
  expectedExitSeconds?: number;
  requiredMaxExitSeconds: number;
  blockedTokens: PostBuySellFeasibilityBlockedToken[];
};

type PassiveBuyFreshnessLease = {
  maxRestingAgeMs: number;
  recentTradeEvents?: number;
  expectedExitSeconds?: number;
  marketableExitNotionalUsdc?: number;
  bestBidNotionalUsdc?: number;
  bestBidSupportShares?: number;
  targetExitQueueAheadShares?: number;
  midpointRange?: number;
  weakenedReasons: string[];
  severeReasons: string[];
};

type AgedInventoryExitLadderState = {
  openedAtMs: number;
  attemptedStage: number;
  lastAttemptedAtMs?: number;
};

const KNOWN_QUOTE_ORDER_OBSERVATION_TTL_MS = Math.max(
  30 * 60_000,
  config.ws.userOrderTimeoutMs * 20,
  config.marketMaker.balanceRefreshMs * 24
);
const DUPLICATE_TERMINAL_FILL_IGNORE_WINDOW_MS = Math.max(
  10 * 60_000,
  config.ws.userOrderTimeoutMs * 10,
  config.marketMaker.balanceRefreshMs * 12
);
const RECENT_CONFIRMED_CLOSE_GUARD_MS = Math.max(
  30 * 60_000,
  config.ws.userOrderTimeoutMs * 12,
  config.marketMaker.balanceRefreshMs * 120
);
const QUOTE_POSTED_ALERT_STATE_TTL_MS = Math.max(
  15 * 60_000,
  config.alerting.quotePostedMinIntervalMs * 4
);
const PASSIVE_BUY_FRESHNESS_SKIP_LOG_INTERVAL_MS = 120_000;
const RISK_REDUCTION_REENTRY_SUPPRESSION_LOG_INTERVAL_MS = 120_000;
const SELL_COVERAGE_DUST_LOG_INTERVAL_MS = 5 * 60_000;

export class MarketMakerBot {
  private readonly orderBookStore = new OrderBookStore();
  private cachedRewards: MarketReward[] | undefined;
  private cachedRewardsAtMs = 0;
  private rewardFetchInFlight: Promise<void> | undefined;
  private readonly tokenToMarket = new Map<string, BinaryMarket>();
  private readonly conditionToMarket = new Map<string, BinaryMarket>();
  private readonly selectedConditionIds = new Set<string>();
  private readonly knownConditionToMarket = new Map<string, BinaryMarket>();
  private readonly knownSlugToMarket = new Map<string, BinaryMarket>();
  private readonly lastPlanLogAt = new Map<string, number>();
  private readonly lastRejectedPlanLogAtByConditionId = new Map<string, number>();
  private readonly lastRejectedPlanLogSignatureByConditionId = new Map<string, string>();
  private readonly lastInventoryDiagnosticLogAtByConditionId = new Map<string, number>();
  private readonly lastInventoryDiagnosticSignatureByConditionId = new Map<string, string>();
  private readonly lastInventoryOnlyManagementLogAtByConditionId = new Map<string, number>();
  private readonly lastVenueInventoryReconciliationAtByConditionId = new Map<string, number>();
  private readonly consecutiveStuckInventoryCyclesByConditionId = new Map<string, number>();
  private readonly lastStuckInventorySweepAtByConditionId = new Map<string, number>();
  /** Count of consecutive failed stuck-sweeps per condition. Used for progressive backoff
   * and for declaring an inventory mismatch (local has it, venue doesn't) → purge. */
  private readonly consecutiveFailedStuckSweepsByConditionId = new Map<string, number>();
  /** When a market has reached max stuck-sweep attempts, pause it until this timestamp
   * before allowing any new quote evaluation. Prevents runaway retries. */
  private readonly stuckSweepDeactivateUntilMsByConditionId = new Map<string, number>();
  private readonly riskReductionReentryCooldownUntilMsByConditionId = new Map<string, number>();
  private readonly evaluationLocks = new Set<string>();
  private readonly pendingImmediateReevaluationConditionIds = new Set<string>();
  private readonly selectionCooldown = new SelectionCooldownState();
  private readonly lastBuyFillAtByTokenId = new Map<string, number>();
  private readonly lastSellFillAtByTokenId = new Map<string, number>();
  private readonly consecutiveSellCoverageWatchdogGapsByConditionId = new Map<string, number>();
  private readonly sellCoverageEscalationCooldownUntilMsByConditionId = new Map<string, number>();
  private readonly haltedSellCoverageCleanupAttemptedConditionIds = new Set<string>();
  // 📊 #14 정상 MM 검증 지표. 세션 동안 BUY/SELL 체결 이벤트를 카운트해서
  // "매수 체결 후 매도 체결 비율", "평균 hold 시간" 등을 집계. 텔레그램 알림에 노출.
  private sessionMmBuyFillCount = 0;
  private sessionMmSellFillCount = 0;
  private sessionMmTotalHoldMs = 0;
  private sessionMmHoldSampleCount = 0;
  private lastOperatorStatusAlertAtMs = 0;
  private lastOperatorStatusFingerprint?: string;
  private lastObservedCashBalanceUsdc?: number;
  private lastObservedCashTradeCount = 0;
  private startupCapitalUsdc?: number;
  private startupAtMs?: number;
  // Per-condition activity tracking for dead-market auto-deactivation. Updated
  // on every maker fill (BUY or SELL) and when a market is first selected;
  // checked on a periodic timer (deadMarketCheckIntervalMs).
  private readonly lastFillAtByConditionId = new Map<string, number>();
  private readonly autoDisabledAtByConditionId = new Map<string, number>();
  private readonly watchOnlyConditionIds = new Set<string>();
  // 🔒 Condition-level BUY suppression. Set on ANY BUY fill (either YES or NO
  // side of that condition). Blocks new BUYs on BOTH sides until the condition
  // is cleared. The token-level `lastBuyFillAtByTokenId` / buyReentryAfterFill
  // only covers the specific filled token. This map covers the entire pair,
  // preventing the bot from immediately buying the OPPOSITE outcome on a
  // recently-filled condition (which would flip into a directional bet rather
  // than a balanced MM position).
  private readonly lastBuyFillAtByConditionId = new Map<string, number>();
  private readonly postBuySellFeasibilityBlocksByConditionId = new Map<
    string,
    PostBuySellFeasibilityBlock
  >();
  private deadMarketCheckTimer: NodeJS.Timeout | undefined;
  // 🔔 #7 SELL 커버리지 감시자 타이머. 재고가 있는데 active SELL이 없는
  // 상태를 주기적으로 감지해서 warning을 기록하고 다음 사이클에 재평가를
  // 강제 트리거. 기본 30초 주기.
  private sellCoverageWatchdogTimer: NodeJS.Timeout | undefined;
  private passiveBuyAgeWatchdogTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private readonly lastSellQuoteReleaseAtByTokenId = new Map<string, number>();
  private readonly postedQuoteSamplesByConditionId = new Map<string, FillRateSample[]>();
  private readonly filledQuoteSamplesByConditionId = new Map<string, FillRateSample[]>();
  private readonly lastMaxHoldHardExitAttemptAtByConditionId = new Map<string, number>();
  private readonly lastMaxHoldHardExitLogSignatureByConditionId = new Map<string, string>();
  private readonly agedInventoryExitLadderStateByTokenId = new Map<
    string,
    AgedInventoryExitLadderState
  >();
  /** Tracks when a price shock was detected per condition, used to enforce cooldown. */
  private readonly priceShockPauseUntilMsByConditionId = new Map<string, number>();
  private readonly thinTopBookRejectCountByConditionId = new Map<string, number>();
  private readonly thinTopBookRejectCooldownUntilMsByConditionId = new Map<string, number>();
  private readonly thinTopBookRejectCooldownLevelByConditionId = new Map<string, number>();
  private readonly oneSideFillRecoveryByConditionId = new Map<
    string,
    MarketMakerOneSideFillRecoveryContext
  >();
  private readonly oneSideAggressiveExitRejectCountByTokenId = new Map<string, number>();
  private readonly knownQuoteOrderObservationsByOrderId = new Map<
    string,
    KnownQuoteOrderObservation
  >();
  private readonly handledMakerFillKeys = new Map<string, number>();
  private readonly terminallyHandledQuoteOrdersByOrderId = new Map<
    string,
    TerminallyHandledQuoteOrder
  >();
  private readonly recentConfirmedInventoryCloseGuardsByTokenId = new Map<
    string,
    RecentConfirmedInventoryCloseGuard
  >();
  private readonly lastQuotePostedAlertAtBySlotKey = new Map<string, number>();
  private readonly lastPassiveBuyFreshnessSkipLogAtByKey = new Map<string, number>();
  private readonly lastPassiveBuyFreshnessSkipSignatureByKey = new Map<string, string>();
  private readonly lastRiskReductionReentrySuppressionLogAtByConditionId = new Map<
    string,
    number
  >();
  private readonly lastSellCoverageDustLogAtByTokenId = new Map<string, number>();
  private readonly executionEngine: ExecutionEngine;
  private readonly positionManager: PositionManager;
  private readonly riskManager: RiskManagerLike;
  private readonly pnlEngine: PnLEngineLike;
  private readonly inventoryTracker: InventoryLotTracker;
  private readonly inventorySnapshotService?: InventorySnapshotService;
  private readonly runtimeCheckpointService?: RuntimeCheckpointService;
  private readonly realizedTradingSessionService?: RealizedTradingSessionService;
  private readonly coordinator: StrategyCoordinator;
  private readonly marketWs: MarketWsManager;
  private readonly alertDispatcher: AlertDispatcher;
  private readonly displacementTracker = new QuoteDisplacementTracker();
  private readonly competitionMonitor = new MarketCompetitionMonitor(
    (conditionId) => this.displacementTracker.getDisplacementRate(conditionId),
    (conditionId) => {
      if (!this.userTracker) return undefined;
      const market = this.knownConditionToMarket.get(conditionId);
      if (!market) return undefined;
      const windowMs = config.marketMaker.fillShareWindowMs;
      const myShares = market.tokenIds.reduce(
        (sum, tid) => sum + this.userTracker!.getMyFillShares(tid, windowMs),
        0
      );
      const totalShares = market.tokenIds.reduce(
        (sum, tid) => sum + this.orderBookStore.getTotalFillVolume(tid, windowMs),
        0
      );
      return { myShares, totalShares };
    }
  );
  readonly operatorControl = new OperatorControl();
  private readonly quoteExecutor?: QuoteExecutor;
  private readonly orderHeartbeat?: OrderHeartbeat;
  private readonly rewardMonitor?: RewardMonitor;
  private readonly rebateMonitor?: RebateMonitor;
  private readonly riskReductionExecutor?: RiskReductionExecutor;
  private readonly resolvedMarketClaimService?: ResolvedMarketClaimService;
  private latestSelectionCapitalSignalScore = 0.5;
  private latestSelectedEntries: readonly RankedMarketSelection[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private selectionWarmupRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly readonlyClient: ClobClient,
    private readonly logger: Logger,
    private readonly tradingClient?: ClobClient,
    private readonly userTracker?: UserWsTracker,
    private readonly makerAddress?: string,
    dependencies?: {
      executionEngine?: ExecutionEngine;
      positionManager?: PositionManager;
      riskManager?: RiskManagerLike;
      pnlEngine?: PnLEngineLike;
      inventoryTracker?: InventoryLotTracker;
    }
  ) {
    this.executionEngine = dependencies?.executionEngine ?? new ExecutionEngine();
    this.positionManager = dependencies?.positionManager ?? new PositionManager();
    this.riskManager = dependencies?.riskManager ?? new RiskManager(logger);
    // Restore RECOVERY cooldown from previous session's checkpoint if present.
    if (!dependencies?.riskManager && this.riskManager instanceof RiskManager) {
      restoreRiskRecoveryFromCheckpoint(this.riskManager, logger);
    }
    this.inventoryTracker =
      dependencies?.inventoryTracker ?? createSeededInventoryLotTracker(logger);
    this.pnlEngine =
      dependencies?.pnlEngine ??
      new PnLEngine(logger, {
        inventoryValuationProvider: () => this.buildOpenInventoryValuationSnapshot()
      });
    if (!dependencies?.inventoryTracker) {
      this.inventorySnapshotService = new InventorySnapshotService({
        tracker: this.inventoryTracker,
        logger,
        runtime: "market-maker"
      });
      this.runtimeCheckpointService = new RuntimeCheckpointService({
        executionEngine: this.executionEngine,
        pnlEngine: this.pnlEngine,
        riskManager: this.riskManager,
        inventoryTracker: this.inventoryTracker,
        logger,
        runtime: "market-maker"
      });
    }
    this.realizedTradingSessionService =
      !dependencies?.pnlEngine && config.mode === "live"
        ? new RealizedTradingSessionService({
            logger,
            pnlEngine: this.pnlEngine,
            runtime: "market-maker"
          })
        : undefined;
    this.syncTrackedInventoryLots();
    this.positionManager.setRiskState(this.riskManager.getState?.() ?? "RUNNING");
    const initialRiskSnapshot = this.riskManager.getSnapshot?.();
    if (initialRiskSnapshot) {
      this.positionManager.setRiskSnapshot(initialRiskSnapshot);
    }
    this.coordinator = new StrategyCoordinator({
      executionEngine: this.executionEngine,
      positionManager: this.positionManager,
      riskManager: this.riskManager
    });
    this.alertDispatcher = createConfiguredAlertDispatcher(logger);

    if (
      this.realizedTradingSessionService &&
      "subscribe" in this.riskManager &&
      typeof this.riskManager.subscribe === "function"
    ) {
      this.riskManager.subscribe((snapshot: RiskStatusSnapshot) => {
        this.realizedTradingSessionService?.noteRiskSnapshot(snapshot);
      });
    }

    if ("subscribe" in this.riskManager && typeof this.riskManager.subscribe === "function") {
      this.riskManager.subscribe((snapshot: RiskStatusSnapshot) => {
        this.positionManager.setRiskSnapshot(snapshot);
        this.positionManager.setRiskState(snapshot.state);
      });
    }

    this.runtimeCheckpointService?.subscribe((snapshot) => {
      void this.maybeDispatchOperatorStatusAlert(snapshot);
    });

    this.marketWs = new MarketWsManager(this.orderBookStore, logger, (tokenId) => {
      void this.handleTokenUpdate(tokenId);
    });

    if (config.mode === "live" && tradingClient) {
      this.quoteExecutor = new QuoteExecutor(
        tradingClient,
        logger,
        this.positionManager,
        this.riskManager,
        {
          onQuoteCancelled: (quote, reason) => {
            this.noteKnownQuoteOrderObservation({
              orderId: quote.orderId,
              conditionId: quote.conditionId,
              marketSlug: quote.marketSlug,
              tokenId: quote.tokenId,
              side: quote.side,
              size: quote.size,
              postedAtMs: quote.openedAtMs,
              maxRestingAgeMs: quote.maxRestingAgeMs
            });
            this.maybeLogOneSideRecoveryQuoteExecutionEvent({
              eventType: "cancelled",
              conditionId: quote.conditionId,
              marketSlug: quote.marketSlug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderId: quote.orderId,
              reason,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            });

            if (quote.side !== Side.SELL) {
              return;
            }

            this.noteSellQuoteReleased(quote.tokenId);
          },
          onQuotePosted: (quote) => {
            this.noteQuotePosted(quote.conditionId, quote.orderId);
            this.noteKnownQuoteOrderObservation({
              orderId: quote.orderId,
              conditionId: quote.conditionId,
              marketSlug: quote.marketSlug,
              tokenId: quote.tokenId,
              side: quote.side,
              size: quote.size,
              postedAtMs: quote.openedAtMs,
              maxRestingAgeMs: quote.maxRestingAgeMs,
              seenAtMs: quote.openedAtMs
            });
            this.maybeLogOneSideRecoveryQuoteExecutionEvent({
              eventType: "posted",
              conditionId: quote.conditionId,
              marketSlug: quote.marketSlug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderId: quote.orderId,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            });
            this.maybeDispatchQuotePostedAlert(quote);
          },
          onQuotePostRejected: (market, quote, error) => {
            this.maybeLogOneSideRecoveryQuoteExecutionEvent({
              eventType: "post-rejected",
              conditionId: market.conditionId,
              marketSlug: market.slug,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              error,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            });

            if (quote.side !== Side.SELL) {
              void this.alertDispatcher.dispatch(
                buildQuotePostRejectedAlert({
                  runtime: "market-maker",
                  strategy: "market-making",
                  market: market.slug,
                  outcome: quote.outcome,
                  side: quote.side,
                  size: quote.size,
                  price: quote.price,
                  error,
                  occurredAtMs: Date.now(),
                  nextRetryAfterMs: config.marketMaker.requoteCooldownMs
                })
              );
              return;
            }

            if (quote.executionStyle === "one-side-aggressive-exit") {
              this.noteOneSideAggressiveExitRejected(quote.tokenId);
            }

            this.noteSellQuoteReleased(quote.tokenId);
            void this.alertDispatcher.dispatch(
              buildQuotePostRejectedAlert({
                runtime: "market-maker",
                strategy: "market-making",
                market: market.slug,
                outcome: quote.outcome,
                side: quote.side,
                size: quote.size,
                price: quote.price,
                error,
                occurredAtMs: Date.now(),
                nextRetryAfterMs: Math.max(
                  config.marketMaker.requoteCooldownMs,
                  config.marketMaker.sellRepostCooldownMs
                )
              })
            );
          }
        },
        this.displacementTracker
      );
      this.riskReductionExecutor = new RiskReductionExecutor(
        tradingClient,
        this.orderBookStore,
        logger,
        this.userTracker
      );
      this.orderHeartbeat = new OrderHeartbeat(tradingClient, logger);
      this.rewardMonitor = new RewardMonitor(
        tradingClient,
        this.quoteExecutor,
        logger,
        (delta) => {
          const recordedAtMs = Date.now();

          for (const marketDelta of delta.marketDeltas) {
            const market = this.conditionToMarket.get(marketDelta.conditionId);

            this.competitionMonitor.updateRewardData(
              marketDelta.conditionId,
              marketDelta.marketSlug,
              marketDelta.earningPercentage,
              marketDelta.marketCompetitiveness
            );

            this.pnlEngine.recordTrade({
              id: `reward-credit:${delta.date}:${marketDelta.conditionId}:${marketDelta.totalEstimatedEarningsUsdc.toFixed(8)}`,
              dayKey: delta.date,
              strategy: "liquidity-rewards",
              marketScope: market?.slug ?? marketDelta.marketSlug,
              conditionId: marketDelta.conditionId,
              grossRealizedPnlUsdc: 0,
              rewardUsdc: marketDelta.deltaRewardUsdc,
              closedAtMs: recordedAtMs,
              detail: "Daily reward earnings delta published by RewardMonitor.",
              tags: ["liquidity-rewards", "reward-credit", "daily-snapshot-delta"],
              metadata: {
                eventId: market?.eventId,
                category: market?.category,
                totalEstimatedEarningsUsdc: Number(
                  marketDelta.totalEstimatedEarningsUsdc.toFixed(8)
                ),
                earningPercentage: Number(marketDelta.earningPercentage.toFixed(8)),
                marketCompetitiveness: Number(
                  marketDelta.marketCompetitiveness.toFixed(8)
                ),
                marketCount: delta.marketCount
              }
            });
          }

          this.refreshDynamicCapitalSignalFromPerformance();
          this.refreshScopedCapitalSignalsFromPerformance();
        }
      );
      if (makerAddress) {
        this.rebateMonitor = new RebateMonitor(
          tradingClient,
          makerAddress,
          logger,
          (conditionId) =>
            this.conditionToMarket.get(conditionId) ??
            this.knownConditionToMarket.get(conditionId),
          (delta) => {
            const recordedAtMs = Date.now();

            for (const marketDelta of delta.marketDeltas) {
              const market = marketDelta.conditionId
                ? this.conditionToMarket.get(marketDelta.conditionId)
                : undefined;

              this.pnlEngine.recordTrade({
                id: `rebate-credit:${delta.date}:${marketDelta.conditionId ?? marketDelta.marketSlug ?? "unknown"}:${marketDelta.totalActualRebatedUsdc.toFixed(8)}`,
                dayKey: delta.date,
                strategy: "maker-rebates",
                marketScope: market?.slug ?? marketDelta.marketSlug ?? "daily-rebate-summary",
                conditionId: marketDelta.conditionId,
                grossRealizedPnlUsdc: 0,
                rebateUsdc: marketDelta.deltaRebateUsdc,
                closedAtMs: recordedAtMs,
                detail: "Daily maker rebate delta published by RebateMonitor.",
                tags: ["maker-rebates", "rebate-credit", "daily-snapshot-delta"],
                metadata: {
                  eventId: market?.eventId,
                  category: market?.category ?? marketDelta.category,
                  totalActualRebatedUsdc: Number(
                    marketDelta.totalActualRebatedUsdc.toFixed(8)
                  ),
                  fillCount: delta.fillCount
                }
              });
            }

            this.refreshDynamicCapitalSignalFromPerformance();
            this.refreshScopedCapitalSignalsFromPerformance();
          },
          (fill) => {
            this.handleRebateMonitorMakerFill(fill);
          }
        );
      }

      this.resolvedMarketClaimService = new ResolvedMarketClaimService({
        client: tradingClient,
        logger,
        inventoryTracker: this.inventoryTracker,
        pnlEngine: this.pnlEngine,
        riskManager: this.riskManager,
        onInventoryChanged: () => {
          this.syncTrackedInventoryLots();
          this.refreshDynamicCapitalSignalFromPerformance();
          this.refreshScopedCapitalSignalsFromPerformance();
        }
      });

      if (this.userTracker) {
        this.userTracker.subscribeOrderFillProgress((event) => {
          this.handleUserOrderFillProgress(event);
        });
        // Register backfill handler: on every reconnect, fetch recent trades from
        // REST API for the downtime window so no fills are permanently lost.
        this.userTracker.setReconnectBackfillHandler(async (disconnectAtMs, reconnectAtMs) => {
          await this.backfillMissedFillsFromRest(disconnectAtMs, reconnectAtMs);
        });
      }
    }
  }

  /** Price shock circuit breaker: if either token's observed midpoint range within
   * the volatility window exceeds the configured absolute threshold, cancel all
   * quotes on this market and pause for the configured cooldown. Returns true when
   * the market is paused (caller should skip quote evaluation). */
  private async checkAndHandlePriceShock(market: BinaryMarket): Promise<boolean> {
    const threshold = config.marketMaker.priceShockAbsThreshold;
    const cooldownMs = config.marketMaker.priceShockCooldownMs;
    if (threshold <= 0 || cooldownMs <= 0) return false;

    const nowMs = Date.now();
    const pauseUntilMs = this.priceShockPauseUntilMsByConditionId.get(market.conditionId) ?? 0;
    if (pauseUntilMs > nowMs) return true;

    let maxRange = 0;
    for (const tokenId of market.tokenIds) {
      const tele = this.orderBookStore.getSelectionTelemetry(tokenId);
      const range = tele?.midpointRange;
      if (typeof range === "number" && Number.isFinite(range) && range > maxRange) {
        maxRange = range;
      }
    }

    if (maxRange < threshold) return false;

    // Shock detected — cancel all quotes on this market and pause.
    this.priceShockPauseUntilMsByConditionId.set(market.conditionId, nowMs + cooldownMs);
    this.logger.warn(
      {
        market: market.slug,
        conditionId: market.conditionId,
        observedRange: maxRange,
        threshold,
        cooldownMs,
        pauseUntilMs: nowMs + cooldownMs
      },
      "Price shock detected — cancelling all quotes and pausing market."
    );

    if (this.quoteExecutor) {
      await this.quoteExecutor.cancelMarketQuotes(market.conditionId);
      this.syncExecutionEngineWithActiveQuotes();
    }
    return true;
  }

  /** Fetch recent trades from REST and replay any that were missed during WS downtime.
   * Called by UserWsTracker after a successful reconnect. Dedups against already-seen
   * trade IDs by checking the PnL engine's trade history. */
  private async backfillMissedFillsFromRest(
    disconnectAtMs: number,
    reconnectAtMs: number
  ): Promise<void> {
    if (!this.tradingClient || !this.makerAddress) {
      return;
    }

    const downtimeMs = reconnectAtMs - disconnectAtMs;
    // Scan trades from slightly before disconnect (buffer for clock skew) to now.
    const lookbackMs = downtimeMs + 30_000;
    const earliestAtMs = disconnectAtMs - 15_000;

    try {
      const response = await this.tradingClient.getTradesPaginated(
        { user: this.makerAddress } as unknown as Parameters<
          typeof this.tradingClient.getTradesPaginated
        >[0]
      );
      const trades = Array.isArray(response?.trades) ? response.trades : [];
      let recovered = 0;
      for (const trade of [...trades].sort((left, right) => {
        const leftAt = this.resolveRestTradeMatchedAtMs(left);
        const rightAt = this.resolveRestTradeMatchedAtMs(right);
        return leftAt - rightAt;
      })) {
        const tradeAtMs = this.resolveRestTradeMatchedAtMs(trade);
        if (!Number.isFinite(tradeAtMs) || tradeAtMs < earliestAtMs) continue;
        if (tradeAtMs > reconnectAtMs + 5000) continue;

        const fill = this.buildMakerFillFromRestTrade(trade);
        if (!fill) continue;

        this.handleRebateMonitorMakerFill(fill);
        recovered += 1;
      }
      this.logger.info(
        { downtimeMs, lookbackMs, tradesScanned: trades.length, recovered },
        "user-ws backfill completed."
      );
    } catch (err) {
      this.logger.warn({ err, downtimeMs }, "user-ws backfill request failed.");
    }
  }

  private resolveRestTradeMatchedAtMs(trade: Pick<Trade, "match_time">): number {
    const raw = trade.match_time;

    if (typeof raw !== "string") {
      return 0;
    }

    const numeric = Number(raw);
    if (Number.isFinite(numeric) && raw.trim() !== "") {
      return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private buildMakerFillFromRestTrade(trade: Trade): MakerFillRecord | undefined {
    if (!isFilledMakerTradeStatus(trade.status)) {
      return undefined;
    }

    const makerOrders = Array.isArray(trade.maker_orders) ? trade.maker_orders : [];
    const makerOrder =
      makerOrders.find(
        (order) =>
          typeof order.maker_address === "string" &&
          order.maker_address.toLowerCase() === this.makerAddress?.toLowerCase()
      ) ?? makerOrders[0];

    if (!makerOrder) {
      return undefined;
    }

    const matchedAtMs = this.resolveRestTradeMatchedAtMs(trade);
    if (!Number.isFinite(matchedAtMs) || matchedAtMs <= 0) {
      return undefined;
    }

    const shares = Number(makerOrder.matched_amount || trade.size);
    const price = Number(makerOrder.price || trade.price);

    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0) {
      return undefined;
    }

    const market = this.resolveKnownMarket(trade.market, trade.market);

    return {
      tradeId: trade.id,
      orderId: makerOrder.order_id,
      date: new Date(matchedAtMs).toISOString().slice(0, 10),
      matchedAt: new Date(matchedAtMs).toISOString(),
      conditionId: trade.market,
      marketSlug: market?.slug ?? trade.market,
      category: market?.category,
      feesEnabled: market?.feesEnabled ?? false,
      assetId: makerOrder.asset_id,
      outcome: makerOrder.outcome,
      side: makerOrder.side,
      shares,
      price,
      notionalUsdc: Number((shares * price).toFixed(8)),
      feeEquivalentUsdc: 0,
      maxPotentialRebateUsdc: 0,
      makerRebatePct: 0
    };
  }

  getCompetitionSummaryForLog(): unknown[] {
    return this.competitionMonitor.getSummaryForLog();
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.startupAtMs = Date.now();
    await this.dispatchLifecycleAlert(
      "🟢 봇 시작 중",
      "마켓메이킹 봇이 시장 스캔, 웹소켓 연결, 주문 감시, 상태 체크포인트를 초기화하고 있습니다.",
      "starting",
      this.startupAtMs
    );
    await this.captureStartupCapitalSnapshot();

    if (config.control.port) {
      const { startControlServer } = await import("./server/control-server.js");
      startControlServer(
        config.control.port,
        this.operatorControl,
        async () => {
          await this.cancelAllQuotes("operator flatten");
          await this.reduceInventoryRisk("operator flatten");
        },
        this.logger
      );
    }

    try {
      await this.refreshUniverse();
    } catch (error) {
      this.riskManager.noteApiError?.(
        "market-making.refresh-universe",
        error instanceof Error ? error.message : String(error)
      );
      // 첫 universe refresh 실패해도 봇은 계속 살아있도록. interval timer 가
      // 시작되면 다음 cycle (2분 후) 에 재시도. 폴리마켓 gamma 일시 장애 (5xx /
      // timeout) 가 봇 시작을 영구 차단하지 않게.
      this.logger.error(
        { err: error },
        "Initial universe refresh failed. Bot will continue and retry on next refresh interval."
      );
      await this.dispatchLifecycleAlert(
        "⚠️ 봇 시작 — 첫 시장 갱신 실패",
        "첫 시장 목록 갱신이 실패했지만 봇은 계속 실행됩니다. 다음 자동 갱신(2분 뒤)에 재시도합니다. 폴리마켓 gamma API 일시 장애 가능.",
        "startup-degraded",
        Date.now(),
        "warning"
      );
      // throw 안 함 — 봇 계속 실행
    }
    this.orderHeartbeat?.start();
    this.rewardMonitor?.start();
    this.rebateMonitor?.start();
    this.resolvedMarketClaimService?.start();
    this.inventorySnapshotService?.start();
    this.runtimeCheckpointService?.start();
    this.realizedTradingSessionService?.start();
    this.refreshTimer = setInterval(() => {
      void this.refreshUniverse().catch((error) => {
        this.riskManager.noteApiError?.(
          "market-making.refresh-universe",
          error instanceof Error ? error.message : String(error)
        );
        this.logger.error({ err: error }, "Market-making universe refresh failed.");
      });
    }, config.marketUniverse.refreshMs);

    // 🔒 Dead-market sweep: auto-disable conditions with no fill activity for
    // `deadMarketDeactivationMs`, and auto-re-enable them after
    // `deadMarketReactivationMs`. Disabled = 0 disables the whole sweep.
    if (config.marketMaker.deadMarketDeactivationMs > 0) {
      this.deadMarketCheckTimer = setInterval(() => {
        this.checkDeadMarkets();
      }, config.marketMaker.deadMarketCheckIntervalMs);
    }

    // 🔔 SELL coverage watchdog: detect "inventory > 0 but 0 active SELL"
    // states and log warning. Ensures the operator's #7 rule "매수 체결 후
    // 반드시 SELL 활성 유지" is observable and self-healing.
    if (config.marketMaker.sellCoverageWatchdogIntervalMs > 0) {
      this.sellCoverageWatchdogTimer = setInterval(() => {
        void this.checkSellCoverage();
      }, config.marketMaker.sellCoverageWatchdogIntervalMs);
    }

    if (this.quoteExecutor && config.marketMaker.passiveBuyMaxAgeMs > 0) {
      const passiveBuyAgeWatchdogIntervalMs = Math.max(
        1_000,
        Math.min(
          10_000,
          ...[
            config.marketMaker.passiveBuyNoTradeMaxAgeMs,
            config.marketMaker.passiveBuyWeakSignalMaxAgeMs,
            config.marketMaker.passiveBuyMaxAgeMs
          ].filter((value) => value > 0)
        )
      );
      this.passiveBuyAgeWatchdogTimer = setInterval(() => {
        void this.checkPassiveBuyAgeWatchdog().catch((error) => {
          this.logger.warn(
            { err: error },
            "Passive BUY age watchdog failed while checking active quotes."
          );
        });
      }, passiveBuyAgeWatchdogIntervalMs);
    }

    await this.dispatchLifecycleAlert(
      "🟢 봇 시작 완료",
      "마켓메이킹 봇이 정상 실행 중입니다. 이후 상태 체크포인트 기준으로 운영 현황 알림이 전송됩니다.",
      "started",
      Date.now()
    );
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.selectionWarmupRefreshTimer) {
      clearTimeout(this.selectionWarmupRefreshTimer);
      this.selectionWarmupRefreshTimer = undefined;
    }

    if (this.deadMarketCheckTimer) {
      clearInterval(this.deadMarketCheckTimer);
      this.deadMarketCheckTimer = undefined;
    }

    if (this.sellCoverageWatchdogTimer) {
      clearInterval(this.sellCoverageWatchdogTimer);
      this.sellCoverageWatchdogTimer = undefined;
    }

    if (this.passiveBuyAgeWatchdogTimer) {
      clearInterval(this.passiveBuyAgeWatchdogTimer);
      this.passiveBuyAgeWatchdogTimer = undefined;
    }

    this.orderHeartbeat?.stop();
    this.rewardMonitor?.stop();
    this.rebateMonitor?.stop();
    this.resolvedMarketClaimService?.stop();
    try {
      await this.cancelAllQuotes("shutdown");
    } catch (error) {
      this.logger.error({ err: error }, "Failed to cancel market-making quotes during shutdown.");
    }
    this.inventorySnapshotService?.stop();
    this.runtimeCheckpointService?.stop();
    this.realizedTradingSessionService?.stop();
    this.marketWs.closeAll();
    this.userTracker?.close();
    await this.dispatchLifecycleAlert(
      "🔴 봇 종료",
      "마켓메이킹 봇이 종료되었습니다. 활성 주문 취소를 시도했고 백그라운드 서비스가 중단되었습니다.",
      "stopped",
      Date.now()
    );
  }

  // Exposes the venue-known share count (from QuoteExecutor's balance cache) so
  // upstream callers (e.g. IntegratedBot's portfolio valuation) can prefer
  // venue-truth over local lot counts when reconciling against the Polymarket
  // site. Returns undefined if no snapshot exists yet (cold start).
  getKnownVenueShares(tokenId: string): number | undefined {
    return this.quoteExecutor?.getKnownVenueShares?.(tokenId);
  }

  // 📊 #14 MM 품질 지표. 세션 동안 BUY/SELL fill 카운트와 평균 hold 시간
  // 샘플을 반환한다. IntegratedBot의 operator-status alert가 텔레그램에 표시.
  getMarketMakingQualityMetrics(): {
    buyFillCount: number;
    sellFillCount: number;
    buyToSellRatio: number | undefined;
    averageHoldMs: number | undefined;
    holdSampleCount: number;
  } {
    const avgHold =
      this.sessionMmHoldSampleCount > 0
        ? this.sessionMmTotalHoldMs / this.sessionMmHoldSampleCount
        : undefined;
    const ratio =
      this.sessionMmBuyFillCount > 0
        ? this.sessionMmSellFillCount / this.sessionMmBuyFillCount
        : undefined;
    return {
      buyFillCount: this.sessionMmBuyFillCount,
      sellFillCount: this.sessionMmSellFillCount,
      buyToSellRatio: ratio,
      averageHoldMs: avgHold,
      holdSampleCount: this.sessionMmHoldSampleCount
    };
  }

  getMarkPriceForToken(tokenId: string): number | undefined {
    // Use midpoint (avg of bid/ask) for mark-to-market valuation, NOT best bid alone.
    // Best bid alone equals our maker BUY price exactly → unrealized PnL always = 0.
    // Midpoint reflects fair market value and shows real PnL movement.
    const book = this.orderBookStore.get(tokenId);
    const bestBid = book?.bids[0]?.price;
    const bestAsk = book?.asks[0]?.price;

    if (
      typeof bestBid === "number" && Number.isFinite(bestBid) &&
      typeof bestAsk === "number" && Number.isFinite(bestAsk)
    ) {
      return Number(((bestBid + bestAsk) / 2).toFixed(8));
    }

    // Fallback to best bid only (or opposing token's best ask via 1-x mirror)
    return this.getCurrentBestBid(tokenId, this.tokenToMarket.get(tokenId));
  }

  private async dispatchLifecycleAlert(
    title: string,
    summary: string,
    tag: string,
    occurredAtMs = Date.now(),
    severity: "info" | "warning" | "critical" = "info"
  ): Promise<void> {
    if (!this.alertDispatcher?.hasSinks?.()) {
      return;
    }

    try {
      await this.alertDispatcher.dispatch({
        schemaVersion: 1,
        category: "bot_lifecycle",
        severity,
        title,
        summary,
        occurredAtMs,
        runtime: "market-maker",
        tags: ["lifecycle", tag]
      });
    } catch (error) {
      this.logger.warn({ err: error, tag }, "Market-maker lifecycle alert dispatch failed.");
    }
  }

  private async captureStartupCapitalSnapshot(): Promise<void> {
    if (typeof config.startupCapitalOverrideUsdc === "number") {
      this.startupCapitalUsdc = config.startupCapitalOverrideUsdc;
      // Wallet balance 도 함께 fetch 해서 첫 5분 알림 전부터 cashBalance 표시 가능하게.
      // 실패해도 startup capital override 는 유지.
      try {
        const balance = await this.readCollateralBalanceSnapshot();
        this.logger.info(
          {
            startupCapitalUsdc: this.startupCapitalUsdc,
            currentCashBalanceUsdc: balance.cashBalanceUsdc,
            source: "env-override"
          },
          "Using POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE for startup capital; live cash balance also captured."
        );
      } catch {
        this.logger.info(
          { startupCapitalUsdc: this.startupCapitalUsdc, source: "env-override" },
          "Using POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE for startup capital."
        );
      }
      return;
    }

    const balance = await this.readCollateralBalanceSnapshot();
    if (typeof balance.cashBalanceUsdc !== "number") {
      return;
    }

    this.startupCapitalUsdc = balance.cashBalanceUsdc;
    this.logger.info(
      { startupCapitalUsdc: this.startupCapitalUsdc, source: "live-balance" },
      "Captured market-maker startup capital from live balance."
    );
  }

  private async readCollateralBalanceSnapshot(
    portfolioSnapshot?: PortfolioPnlSnapshot
  ): Promise<{
    cashBalanceUsdc?: number;
    cashAllowanceUsdc?: number;
    cashBalanceMayBeStale?: boolean;
  }> {
    if (!this.tradingClient) {
      return {};
    }

    let cashBalanceUsdc: number | undefined;
    let cashAllowanceUsdc: number | undefined;
    let cashBalanceMayBeStale = false;

    try {
      const collateral = await this.tradingClient.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL
      });
      cashBalanceUsdc = rawUsdcToDecimal(collateral.balance);
      const allowanceRaw = readMaxAllowanceRaw(collateral);
      cashAllowanceUsdc = allowanceRaw !== undefined ? rawUsdcToDecimal(allowanceRaw) : undefined;
    } catch (error) {
      this.logger.debug({ err: error }, "Operator status alert could not refresh collateral balance.");
      return {};
    }

    if (portfolioSnapshot && typeof cashBalanceUsdc === "number") {
      const looksStale =
        typeof this.lastObservedCashBalanceUsdc === "number" &&
        portfolioSnapshot.lifetimeTradeCount > this.lastObservedCashTradeCount &&
        Math.abs(cashBalanceUsdc - this.lastObservedCashBalanceUsdc) <= Number.EPSILON;

      if (looksStale) {
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 750));
          const refreshed = await this.tradingClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL
          });
          const refreshedCash = rawUsdcToDecimal(refreshed.balance);
          if (Math.abs(refreshedCash - cashBalanceUsdc) > Number.EPSILON) {
            cashBalanceUsdc = refreshedCash;
            const refreshedAllowanceRaw = readMaxAllowanceRaw(refreshed);
            cashAllowanceUsdc =
              refreshedAllowanceRaw !== undefined ? rawUsdcToDecimal(refreshedAllowanceRaw) : undefined;
          } else {
            cashBalanceMayBeStale = true;
          }
        } catch (error) {
          cashBalanceMayBeStale = true;
          this.logger.debug({ err: error }, "Stale-cache balance retry failed.");
        }
      }

      this.lastObservedCashBalanceUsdc = cashBalanceUsdc;
      this.lastObservedCashTradeCount = portfolioSnapshot.lifetimeTradeCount;
    }

    return {
      cashBalanceUsdc,
      cashAllowanceUsdc,
      cashBalanceMayBeStale
    };
  }

  private async maybeDispatchOperatorStatusAlert(
    snapshot: RuntimeCheckpointSummary
  ): Promise<void> {
    if (
      !this.alertDispatcher.hasSinks() ||
      config.alerting.operatorStatusAlertIntervalMs <= 0
    ) {
      return;
    }

    const portfolioSnapshot = this.pnlEngine.getPortfolioSnapshot();
    const marketMakingSnapshot = this.pnlEngine.getStrategySnapshot("market-making");
    const sameMarketArbSnapshot = this.pnlEngine.getStrategySnapshot("same-market-arb");
    const operatorStatusFingerprint = JSON.stringify({
      riskState: snapshot.riskState,
      activeOrderCount: snapshot.activeOrderCount,
      openLotCount: snapshot.openLotCount,
      openShares: Number(snapshot.openShares.toFixed(5)),
      openCostUsdc: Number(snapshot.openCostUsdc.toFixed(8)),
      dailyTradeCount: portfolioSnapshot.dailyTradeCount,
      dailyRealizedPnlUsdc: Number(portfolioSnapshot.dailyRealizedPnlUsdc.toFixed(8))
    });
    const hasMaterialChange = operatorStatusFingerprint !== this.lastOperatorStatusFingerprint;

    if (
      !hasMaterialChange &&
      snapshot.generatedAtMs - this.lastOperatorStatusAlertAtMs <
        config.alerting.operatorStatusAlertIntervalMs
    ) {
      return;
    }

    this.lastOperatorStatusAlertAtMs = snapshot.generatedAtMs;
    this.lastOperatorStatusFingerprint = operatorStatusFingerprint;

    const inventoryValuation = this.buildOpenInventoryValuationSnapshot();
    const qualityMetrics = this.getMarketMakingQualityMetrics();
    const cashSnapshot = await this.readCollateralBalanceSnapshot(portfolioSnapshot);
    const totalNetPnlUsdc =
      portfolioSnapshot.lifetimeNetPnlUsdc ?? portfolioSnapshot.lifetimeRealizedPnlUsdc;

    await this.alertDispatcher.dispatch(
      buildOperatorStatusAlert({
        runtime: "market-maker",
        checkpoint: snapshot,
        cashBalanceUsdc: cashSnapshot.cashBalanceUsdc,
        cashAllowanceUsdc: cashSnapshot.cashAllowanceUsdc,
        cashBalanceMayBeStale: cashSnapshot.cashBalanceMayBeStale,
        initialCapitalUsdc: this.startupCapitalUsdc ?? config.alerting.initialCapitalUsdc,
        dailyRealizedPnlUsdc: portfolioSnapshot.dailyRealizedPnlUsdc,
        dailyTradeCount: portfolioSnapshot.dailyTradeCount,
        lifetimeRealizedPnlUsdc: portfolioSnapshot.lifetimeRealizedPnlUsdc,
        marketMakingDailyPnlUsdc: marketMakingSnapshot.dailyRealizedPnlUsdc,
        marketMakingLifetimePnlUsdc: marketMakingSnapshot.lifetimeRealizedPnlUsdc,
        marketMakingDailyWinCount: marketMakingSnapshot.dailyWinningTrades,
        marketMakingDailyLossCount: marketMakingSnapshot.dailyLosingTrades,
        marketMakingDailyFlatCount: marketMakingSnapshot.dailyFlatTrades,
        marketMakingLifetimeWinCount: marketMakingSnapshot.winningTrades,
        marketMakingLifetimeLossCount: marketMakingSnapshot.losingTrades,
        marketMakingLifetimeFlatCount: marketMakingSnapshot.flatTrades,
        marketMakingSessionBuyFills: qualityMetrics.buyFillCount,
        marketMakingSessionSellFills: qualityMetrics.sellFillCount,
        marketMakingSessionBuyToSellRatio: qualityMetrics.buyToSellRatio,
        marketMakingSessionAverageHoldMs: qualityMetrics.averageHoldMs,
        sameMarketArbDailyPnlUsdc: sameMarketArbSnapshot.dailyRealizedPnlUsdc,
        sameMarketArbLifetimePnlUsdc: sameMarketArbSnapshot.lifetimeRealizedPnlUsdc,
        rewardIncomeUsdc: portfolioSnapshot.dailyRewardUsdc,
        rebateIncomeUsdc: portfolioSnapshot.dailyRebateUsdc,
        lifetimeRewardIncomeUsdc: portfolioSnapshot.lifetimeRewardUsdc,
        lifetimeRebateIncomeUsdc: portfolioSnapshot.lifetimeRebateUsdc,
        lifetimeTradeCount: portfolioSnapshot.lifetimeTradeCount,
        winningTradeCount: portfolioSnapshot.winningTrades,
        losingTradeCount: portfolioSnapshot.losingTrades,
        totalNetPnlUsdc,
        openPositionValueUsdc: inventoryValuation.openInventoryMarkValueUsdc,
        openUnrealizedPnlUsdc: inventoryValuation.openInventoryUnrealizedPnlUsdc,
        pricedOpenTokenCount: inventoryValuation.pricedOpenTokenCount,
        unpricedOpenTokenCount: inventoryValuation.unpricedOpenTokenCount,
        venueDriftTokenCount: inventoryValuation.venueDriftTokenCount,
        venueDriftAbsValueUsdc: inventoryValuation.venueDriftAbsValueUsdc,
        venueDriftSignedShares: inventoryValuation.venueDriftSignedShares,
        topInventoryPositions: this.buildTopInventoryPositions(3),
        operatorStartedAtMs: this.startupAtMs
      })
    );
  }

  private buildOpenInventoryValuationSnapshot() {
    return buildInventoryValuationSnapshot({
      inventoryTracker: this.inventoryTracker,
      getMarkPriceForToken: (tokenId) => this.getMarkPriceForToken(tokenId),
      getKnownVenueShares: (tokenId) => this.quoteExecutor?.getKnownVenueShares?.(tokenId)
    });
  }

  private buildTopInventoryPositions(limit: number) {
    const openLots = this.inventoryTracker.exportOpenLots();
    const byToken = new Map<
      string,
      {
        shares: number;
        costUsdc: number;
        markValueUsdc?: number;
        market: string;
        outcome: string;
      }
    >();

    for (const lot of openLots) {
      const market =
        (lot.conditionId
          ? this.conditionToMarket.get(lot.conditionId) ??
            this.knownConditionToMarket.get(lot.conditionId)
          : undefined) ??
        this.tokenToMarket.get(lot.tokenId) ??
        this.knownSlugToMarket.get(lot.marketScope);
      const outcomeIndex = market?.tokenIds.indexOf(lot.tokenId) ?? -1;
      const outcome =
        lot.outcome ??
        (outcomeIndex >= 0 ? market?.outcomes[outcomeIndex] : undefined) ??
        lot.tokenId.slice(0, 8);
      const marketLabel =
        market?.slug ?? lot.marketScope ?? lot.conditionId ?? lot.tokenId.slice(0, 12);
      const markPrice = this.getMarkPriceForToken(lot.tokenId);
      const markValue =
        typeof markPrice === "number" && Number.isFinite(markPrice)
          ? lot.shares * markPrice
          : undefined;
      const existing = byToken.get(lot.tokenId);

      if (existing) {
        existing.shares += lot.shares;
        existing.costUsdc += lot.totalCostUsdc;
        if (typeof markValue === "number") {
          existing.markValueUsdc = (existing.markValueUsdc ?? 0) + markValue;
        }
        continue;
      }

      byToken.set(lot.tokenId, {
        shares: lot.shares,
        costUsdc: lot.totalCostUsdc,
        markValueUsdc: markValue,
        market: marketLabel,
        outcome
      });
    }

    return [...byToken.values()]
      .sort((a, b) => b.costUsdc - a.costUsdc)
      .slice(0, limit)
      .map((position) => ({
        market: position.market,
        outcome: position.outcome,
        shares: position.shares,
        costUsdc: position.costUsdc,
        unrealizedPnlUsdc:
          typeof position.markValueUsdc === "number"
            ? position.markValueUsdc - position.costUsdc
            : undefined
      }));
  }

  async cancelQuotesForCondition(
    conditionId: string,
    reason = "higher-priority strategy preemption"
  ): Promise<void> {
    if (!this.quoteExecutor) {
      return;
    }

    await this.quoteExecutor.cancelMarketQuotes(conditionId);
    this.syncExecutionEngineWithActiveQuotes();
    this.logger.info(
      {
        conditionId,
        reason
      },
      "Cancelled market-making quotes for a condition."
    );
  }

  async cancelAllQuotes(reason = "risk halt"): Promise<void> {
    if (!this.quoteExecutor) {
      return;
    }

    const orderIds = this.quoteExecutor.getActiveQuotes().map((quote) => quote.orderId);
    await this.quoteExecutor.cancelQuotesByOrderIds(orderIds, reason);
    this.syncExecutionEngineWithActiveQuotes();
    this.logger.warn(
      {
        orderCount: orderIds.length,
        reason
      },
      "Cancelled all market-making quotes."
    );
  }

  async cancelBuyQuotes(reason = "risk degraded"): Promise<void> {
    if (!this.quoteExecutor) {
      return;
    }

    const activeBuyQuotes = this.quoteExecutor
      .getActiveQuotes()
      .filter((quote) => quote.side === Side.BUY);
    await this.quoteExecutor.cancelQuotesBySide(Side.BUY, reason);
    this.syncExecutionEngineWithActiveQuotes();
    this.logger.warn(
      {
        orderCount: activeBuyQuotes.length,
        reason
      },
      "Cancelled market-making BUY quotes."
    );
  }

  async reduceInventoryRisk(reason = "risk halt"): Promise<void> {
    await this.reduceInventoryRiskCandidates(this.getRiskReductionCandidates(), reason);
  }

  getRiskReductionCandidates(): RiskReductionCandidate[] {
    return buildRiskReductionCandidatesFromMarkets([...this.conditionToMarket.values()]);
  }

  async reduceInventoryRiskCandidates(
    candidates: readonly RiskReductionCandidate[],
    reason = "risk halt"
  ): Promise<void> {
    if (!this.riskReductionExecutor) {
      return;
    }

    const summary = await this.riskReductionExecutor.reduceCandidates(candidates, reason);
    this.recordRiskReductionSummary(summary, reason);

    this.logger.warn(
      {
        reason,
        candidateCount: summary.candidateCount,
        reducedCount: summary.reducedCount,
        reducedShares: Number(summary.reducedShares.toFixed(4)),
        totalProceedsUsdc: Number(summary.totalProceedsUsdc.toFixed(4)),
        reducedMarkets: summary.results
          .filter((result) => result.status === "reduced")
          .map((result) => ({
            market: result.marketSlug,
            outcome: result.outcome,
            reducedShares: result.reducedShares,
            proceedsUsdc: result.proceedsUsdc
          })),
        skipped: summary.results
          .filter((result) => result.status !== "reduced")
          .map((result) => ({
            market: result.marketSlug,
            outcome: result.outcome,
            status: result.status,
            observedBalance: result.observedBalance,
            observedAllowance: result.observedAllowance,
            observedSellableShares: result.observedSellableShares,
            waitedMs: result.waitedMs,
            detail: result.detail
          }))
      },
      "Completed market-making inventory risk reduction pass."
    );
  }

  private handleRebateMonitorMakerFill(fill: MakerFillRecord): void {
    const matchedAtMs = Date.parse(fill.matchedAt);
    const effectiveMatchedAtMs = Number.isFinite(matchedAtMs) ? matchedAtMs : Date.now();
    const trackedQuote = fill.orderId
      ? this.quoteExecutor?.getTrackedQuoteByOrderId(fill.orderId)
      : undefined;
    const knownOrder = fill.orderId
      ? this.getKnownQuoteOrderObservation(fill.orderId, effectiveMatchedAtMs)
      : undefined;
    const market = this.resolveKnownMarket(fill.conditionId, fill.marketSlug);
    const isCurrentSessionFill =
      typeof this.startupAtMs === "number" &&
      effectiveMatchedAtMs + 5_000 >= this.startupAtMs;

    if (!trackedQuote && !knownOrder && !isCurrentSessionFill) {
      this.logger.debug(
        {
          tradeId: fill.tradeId,
          orderId: fill.orderId,
          market: fill.marketSlug,
          conditionId: fill.conditionId,
          matchedAt: fill.matchedAt
        },
        "Skipped historical REST maker fill that is not tied to a current bot quote."
      );
      return;
    }

    if (!market && !trackedQuote && !knownOrder) {
      this.logger.debug(
        {
          tradeId: fill.tradeId,
          orderId: fill.orderId,
          market: fill.marketSlug,
          conditionId: fill.conditionId
        },
        "Skipped REST maker fill because the bot cannot resolve its market context."
      );
      return;
    }

    const quotePostedAtMs = trackedQuote?.openedAtMs ?? knownOrder?.postedAtMs;
    const quoteAgeMs =
      typeof quotePostedAtMs === "number"
        ? Math.max(0, effectiveMatchedAtMs - quotePostedAtMs)
        : undefined;

    this.handleMakerFill({
      ...fill,
      marketSlug: market?.slug ?? fill.marketSlug,
      category: fill.category ?? market?.category,
      feesEnabled: fill.feesEnabled || Boolean(market?.feesEnabled),
      expectedPriceUsdc: trackedQuote?.price ?? fill.price,
      quotePostedAtMs,
      quoteAgeMs,
      quoteMaxRestingAgeMs: trackedQuote?.maxRestingAgeMs ?? knownOrder?.maxRestingAgeMs,
      executionQuality: trackedQuote
        ? {
            createdAtMs: trackedQuote.intentCreatedAtMs,
            firstFillAtMs: trackedQuote.firstFillAtMs,
            requoteCount: trackedQuote.requoteCount,
            partialFillCount: trackedQuote.partialFillCount
          }
        : undefined
    });

    if (fill.orderId && trackedQuote && fill.shares + Number.EPSILON >= trackedQuote.size) {
      this.noteTerminallyHandledQuoteOrder(
        trackedQuote,
        {
          orderId: fill.orderId,
          market: fill.conditionId,
          assetId: fill.assetId,
          side: fill.side.toUpperCase() === "SELL" ? "SELL" : "BUY",
          price: fill.price,
          originalSize: trackedQuote.size,
          matchedSize: fill.shares,
          deltaMatchedSize: fill.shares,
          status: "REST_BACKFILL",
          isTerminal: true
        },
        effectiveMatchedAtMs
      );
      this.quoteExecutor?.removeTrackedQuoteByOrderId(fill.orderId);
      this.syncExecutionEngineWithActiveQuotes();
    }
  }

  private shouldProcessMakerFill(fill: MakerFillAlertRecord, occurredAtMs: number): boolean {
    const key = this.resolveMakerFillDedupKey(fill);
    if (!key || !this.handledMakerFillKeys) {
      return true;
    }

    this.pruneHandledMakerFillKeys(occurredAtMs);

    if (this.handledMakerFillKeys.has(key)) {
      this.logger.debug(
        {
          tradeId: fill.tradeId,
          orderId: fill.orderId,
          market: fill.marketSlug,
          assetId: fill.assetId,
          side: fill.side,
          shares: fill.shares,
          price: fill.price
        },
        "Skipped duplicate maker fill already handled through another fill channel."
      );
      return false;
    }

    this.handledMakerFillKeys.set(key, occurredAtMs);
    return true;
  }

  private resolveMakerFillDedupKey(fill: MakerFillAlertRecord): string | undefined {
    if (fill.tradeId) {
      return `trade:${fill.tradeId}`;
    }

    if (fill.orderId) {
      return [
        "order-fill",
        fill.orderId,
        fill.assetId,
        fill.side.toUpperCase(),
        fill.shares.toFixed(8),
        fill.price.toFixed(8)
      ].join(":");
    }

    return undefined;
  }

  private pruneHandledMakerFillKeys(nowMs: number): void {
    const ttlMs = Math.max(
      6 * 60 * 60_000,
      config.rebates.tradesRefreshMs * 10,
      KNOWN_QUOTE_ORDER_OBSERVATION_TTL_MS
    );

    for (const [key, seenAtMs] of this.handledMakerFillKeys.entries()) {
      if (nowMs - seenAtMs > ttlMs) {
        this.handledMakerFillKeys.delete(key);
      }
    }
  }

  private handleMakerFill(fill: MakerFillAlertRecord): void {
    const matchedAtMs = Date.parse(fill.matchedAt);
    const side = fill.side.toUpperCase();
    const effectiveMatchedAtMs = Number.isFinite(matchedAtMs) ? matchedAtMs : Date.now();

    if (!this.shouldProcessMakerFill(fill, effectiveMatchedAtMs)) {
      return;
    }

    const positionBeforeFill = this.inventoryTracker.getOpenPosition(fill.assetId);
    const positionBeforeShares = positionBeforeFill?.shares ?? 0;

    if (side === "BUY") {
      this.lastBuyFillAtByTokenId.set(fill.assetId, effectiveMatchedAtMs);
      this.lastBuyFillAtByConditionId.set(fill.conditionId, effectiveMatchedAtMs);
      this.lastFillAtByConditionId.set(fill.conditionId, effectiveMatchedAtMs);
      this.agedInventoryExitLadderStateByTokenId?.delete(fill.assetId);
      this.sessionMmBuyFillCount += 1;
      // 🔒 Immediate cascade-protection: cancel ALL remaining BUY quotes on
      // this condition so a rapid taker dump cannot stack multiple fills past
      // our inventory cap before the next reconcile cycle detects the breach.
      // Observed failure mode: 60 shares Hormuz NO filled in 10 seconds vs.
      // 42-share cap. Without this, the 2nd and 3rd 20-share fills slipped in
      // on re-posted BUY quotes built from stale (pre-fill) inventory snapshots.
      if (this.quoteExecutor?.cancelConditionBuyQuotes) {
        void this.quoteExecutor
          .cancelConditionBuyQuotes(fill.conditionId, "post-buy-fill-cascade-protection")
          .catch((err) => {
            this.logger.debug(
              { err, conditionId: fill.conditionId },
              "cancelConditionBuyQuotes failed post-fill."
            );
          });
      }
      this.oneSideAggressiveExitRejectCountByTokenId.delete(fill.assetId);
      this.clearRecentConfirmedInventoryCloseGuard(fill.assetId);
      this.quoteExecutor?.invalidateConditionalBalance(fill.assetId);
      this.inventoryTracker.consumeVenueSyncShares(fill.assetId, fill.shares);
      this.inventoryTracker.addLot({
        lotId: `maker-fill:${fill.tradeId}`,
        strategy: "market-making",
        tokenId: fill.assetId,
        marketScope: fill.marketSlug,
        conditionId: fill.conditionId,
        outcome: fill.outcome,
        shares: fill.shares,
        totalCostUsdc: fill.notionalUsdc,
        openedAtMs: effectiveMatchedAtMs,
        metadata: {
          executionSource: "maker-fill",
          tradeId: fill.tradeId
        }
      });
      this.oneSideFillRecoveryByConditionId.set(fill.conditionId, {
        conditionId: fill.conditionId,
        filledTokenId: fill.assetId,
        activatedAtMs: effectiveMatchedAtMs
      });
      this.syncTrackedInventoryLots();
      const fillMarket =
        this.conditionToMarket.get(fill.conditionId) ??
        this.knownConditionToMarket.get(fill.conditionId) ??
        this.knownSlugToMarket.get(fill.marketSlug) ??
        this.tokenToMarket.get(fill.assetId);
      if (fillMarket) {
        const postBuySellFeasibilityBlock = this.refreshPostBuySellFeasibilityBlock(
          fillMarket,
          Date.now(),
          [fill.assetId]
        );

        if (postBuySellFeasibilityBlock) {
          this.logger.warn(
            {
              market: fill.marketSlug,
              conditionId: fill.conditionId,
              filledTokenId: fill.assetId,
              untilMs: postBuySellFeasibilityBlock.untilMs,
              reasons: postBuySellFeasibilityBlock.reasons,
              blockedTokens: postBuySellFeasibilityBlock.blockedTokens.map((token) => ({
                tokenId: token.tokenId,
                recentTradeEvents: token.recentTradeEvents,
                requiredRecentTradeEvents: token.requiredRecentTradeEvents,
                bestBidNotionalUsdc: token.bestBidNotionalUsdc,
                requiredBestBidNotionalUsdc: token.requiredBestBidNotionalUsdc,
                marketableExitNotionalUsdc: token.marketableExitNotionalUsdc,
                requiredMarketableExitNotionalUsdc: token.requiredMarketableExitNotionalUsdc,
                expectedExitSeconds: token.expectedExitSeconds,
                requiredMaxExitSeconds: token.requiredMaxExitSeconds,
                reasons: token.reasons
              })),
              conditionRecentTradeEvents:
                postBuySellFeasibilityBlock.conditionRecentTradeEvents,
              requiredConditionRecentTradeEvents:
                postBuySellFeasibilityBlock.requiredConditionRecentTradeEvents,
              expectedExitSeconds: postBuySellFeasibilityBlock.expectedExitSeconds,
              requiredMaxExitSeconds: postBuySellFeasibilityBlock.requiredMaxExitSeconds
            },
            "Blocked new BUY re-entry after maker BUY fill: SELL feasibility is not yet verified."
          );
        }

        this.requestImmediateConditionReevaluation(fillMarket.conditionId);
      }
      const positionAfterFill = this.inventoryTracker.getOpenPosition(fill.assetId);
      const alertContext = this.buildMakerFillAlertContext({
        tokenId: fill.assetId,
        side: "BUY",
        positionBeforeShares,
        positionAfterShares: positionAfterFill?.shares ?? 0,
        averageCostUsdcPerShare:
          positionAfterFill && positionAfterFill.shares > 0
            ? positionAfterFill.totalCostUsdc / positionAfterFill.shares
            : undefined,
        expectedPriceUsdc: fill.expectedPriceUsdc,
        actualPriceUsdc: fill.price,
        realizedPnlUsdc: undefined,
        defaultReason: "spread_capture"
      });
      void this.alertDispatcher.dispatch(
        buildOrderFillAlert({
          runtime: "market-maker",
          strategy: "market-making",
          market: fill.marketSlug,
          outcome: fill.outcome,
          side: "BUY",
          shares: fill.shares,
          price: fill.price,
          notionalUsdc: fill.notionalUsdc,
          occurredAtMs: effectiveMatchedAtMs,
          quotePostedAtMs: fill.quotePostedAtMs,
          quoteAgeMs: fill.quoteAgeMs,
          quoteMaxRestingAgeMs: fill.quoteMaxRestingAgeMs,
          ...alertContext,
          tags: ["maker-fill"]
        })
      );
      return;
    }

    if (side !== "SELL") {
      return;
    }

    this.quoteExecutor?.invalidateConditionalBalance(fill.assetId);
    const closeResult = this.inventoryTracker.closeLots({
      tokenId: fill.assetId,
      shares: fill.shares,
      proceedsUsdc: fill.notionalUsdc,
      closedAtMs: effectiveMatchedAtMs,
      metadata: {
        executionSource: "maker-fill",
        tradeId: fill.tradeId
      }
    });

    recordInventoryCloseResult({
      closeResult,
      pnlEngine: this.pnlEngine,
      riskManager: this.riskManager,
      logger: this.logger,
      closeReason: `Maker SELL fill closed inventory in ${fill.marketSlug}.`,
      executionSource: "maker-fill",
      executionQuality: fill.executionQuality
    });
    this.lastSellFillAtByTokenId.set(
      fill.assetId,
      effectiveMatchedAtMs
    );
    this.lastFillAtByConditionId.set(fill.conditionId, effectiveMatchedAtMs);
    this.sessionMmSellFillCount += 1;
    // #14 평균 hold 시간 샘플 — 이 SELL이 FIFO-매칭한 lot의 openedAtMs를
    // 대략적으로 가장 오래된 열린 lot로 취급. 완벽하진 않지만 세션 수준
    // 관측 지표로는 충분.
    const lastBuyAt = this.lastBuyFillAtByTokenId.get(fill.assetId);
    if (typeof lastBuyAt === "number" && lastBuyAt > 0 && lastBuyAt <= effectiveMatchedAtMs) {
      this.sessionMmTotalHoldMs += effectiveMatchedAtMs - lastBuyAt;
      this.sessionMmHoldSampleCount += 1;
    }
    // Immediately deduct the sold shares from the PositionManager's cached balance so that
    // any plan evaluation firing before the next periodic balance refresh sees a correct
    // balance and cannot approve over-sized aggressive-exit sells against a stale snapshot.
    // Without this, the venue rejects with "sum of matched orders" still counting the
    // just-filled sell-layers, causing spurious orderFailure increments → DEGRADED.
    this.positionManager.deductTokenInventoryShares?.(fill.assetId, fill.shares, effectiveMatchedAtMs);
    this.oneSideAggressiveExitRejectCountByTokenId.delete(fill.assetId);
    const positionAfterFill = this.inventoryTracker.getOpenPosition(fill.assetId);
    this.noteRecentConfirmedInventoryClose(
      fill.assetId,
      fill.marketSlug,
      fill.conditionId,
      closeResult.closedKnownShares,
      positionAfterFill?.shares ?? 0,
      effectiveMatchedAtMs
    );

    if ((positionAfterFill?.shares ?? 0) <= 1e-9) {
      this.lastBuyFillAtByTokenId.delete(fill.assetId);
      this.agedInventoryExitLadderStateByTokenId?.delete(fill.assetId);
      const recoveryContext = this.oneSideFillRecoveryByConditionId.get(fill.conditionId);
      if (recoveryContext?.filledTokenId === fill.assetId) {
        this.oneSideFillRecoveryByConditionId.delete(fill.conditionId);
      }
      this.quoteExecutor?.suppressSellQuotesForToken?.(
        fill.assetId,
        "post-sell-fill-inventory-closed",
        effectiveMatchedAtMs
      );
      const cancelStaleSellQuotes = this.quoteExecutor?.cancelTokenSellQuotes?.(
        fill.assetId,
        fill.conditionId,
        "post-sell-fill-inventory-closed"
      );
      if (cancelStaleSellQuotes) {
        void cancelStaleSellQuotes
          .then(() => this.syncExecutionEngineWithActiveQuotes())
          .catch((err) => {
            this.logger.debug(
              { err, conditionId: fill.conditionId, tokenId: fill.assetId },
              "cancelTokenSellQuotes failed after full SELL close."
            );
          });
      }
    }

    this.syncTrackedInventoryLots();
    this.refreshDynamicCapitalSignalFromPerformance();
    this.refreshScopedCapitalSignalsFromPerformance();
    const sellFillMarket =
      this.conditionToMarket.get(fill.conditionId) ??
      this.knownConditionToMarket.get(fill.conditionId) ??
      this.knownSlugToMarket.get(fill.marketSlug);
    if (sellFillMarket) {
      this.refreshPostBuySellFeasibilityBlock(sellFillMarket, Date.now());
      this.requestImmediateConditionReevaluation(sellFillMarket.conditionId);
    }

    const realizedPnlUsdc = closeResult.pieces.reduce(
      (total, piece) => total + piece.realizedPnlUsdc,
      0
    );
    const exitReason =
      realizedPnlUsdc > 0
        ? "profit_take"
        : (positionAfterFill?.shares ?? 0) > 0
          ? "inventory_reduce"
          : "inventory_close";
    const alertContext = this.buildMakerFillAlertContext({
      tokenId: fill.assetId,
      side: "SELL",
      positionBeforeShares,
      positionAfterShares: positionAfterFill?.shares ?? 0,
      averageCostUsdcPerShare:
        closeResult.closedKnownShares > 0
          ? closeResult.recognizedCostBasisUsdc / closeResult.closedKnownShares
          : undefined,
      expectedPriceUsdc: fill.expectedPriceUsdc,
      actualPriceUsdc: fill.price,
      realizedPnlUsdc,
      defaultReason: exitReason
    });
    void this.alertDispatcher.dispatch(
        buildOrderFillAlert({
          runtime: "market-maker",
          strategy: "market-making",
          market: fill.marketSlug,
        outcome: fill.outcome,
        side: "SELL",
        shares: fill.shares,
          price: fill.price,
          notionalUsdc: fill.notionalUsdc,
          occurredAtMs: effectiveMatchedAtMs,
          quotePostedAtMs: fill.quotePostedAtMs,
          quoteAgeMs: fill.quoteAgeMs,
          quoteMaxRestingAgeMs: fill.quoteMaxRestingAgeMs,
          ...alertContext,
          realizedPnlUsdc,
          tags: ["maker-fill", "inventory-close"]
      })
    );
  }

  private handleUserOrderFillProgress(event: UserOrderFillProgressEvent): void {
    if (this.stopping || !this.quoteExecutor || !(event.deltaMatchedSize > 0)) {
      return;
    }

    const trackedQuote = this.quoteExecutor.getActiveQuoteByOrderId(event.orderId);

    if (!trackedQuote) {
      const nowMs = Date.now();
      const terminallyHandledOrder = this.getTerminallyHandledQuoteOrder(event.orderId, nowMs);

      if (terminallyHandledOrder) {
        this.logger.debug(
          {
            orderId: event.orderId,
            market: event.market,
            assetId: event.assetId,
            side: event.side,
            matchedSize: event.matchedSize,
            deltaMatchedSize: event.deltaMatchedSize,
            resolvedAtMs: terminallyHandledOrder.resolvedAtMs,
            knownConditionId: terminallyHandledOrder.conditionId
          },
          "Ignored duplicate user-ws fill progress for a recently completed order."
        );
        return;
      }

      const knownOrder = this.getKnownQuoteOrderObservation(event.orderId, nowMs);
      const untrackedFillAssessment = knownOrder
        ? this.assessUntrackedFillProgressRecovery(event, knownOrder)
        : {
            shouldRecover: false,
            ignoredReason: "unknown_order_id"
          };
      const recoveryMarket =
        knownOrder && untrackedFillAssessment.shouldRecover
          ? this.resolveKnownMarket(knownOrder.conditionId, knownOrder.marketSlug) ??
            this.resolveMarketForUntrackedFillProgress(event)
          : undefined;
      const logPayload = {
        orderId: event.orderId,
        market: event.market,
        assetId: event.assetId,
        side: event.side,
        matchedSize: event.matchedSize,
        deltaMatchedSize: event.deltaMatchedSize,
        status: event.status,
        knownOrder: Boolean(knownOrder),
        knownConditionId: knownOrder?.conditionId,
        knownOrderSize: knownOrder?.size,
        recoveryScheduled: Boolean(recoveryMarket),
        recoveredConditionId: recoveryMarket?.conditionId,
        ignoredReason: untrackedFillAssessment.ignoredReason
      };
      if (
        recoveryMarket ||
        knownOrder ||
        untrackedFillAssessment.ignoredReason !== "unknown_order_id"
      ) {
        this.logger.info(
          logPayload,
          "Received user-ws fill progress for an order that is no longer tracked locally."
        );
      } else {
        this.logger.debug(logPayload, "Ignored user-ws fill progress for an unknown order.");
      }

      if (recoveryMarket) {
        this.recoverFromUntrackedFillProgress(event, recoveryMarket);
      }
      return;
    }

    const trackedOrderSize = Math.max(trackedQuote.size, 0);
    const rawPreviousMatchedSize = Math.max(0, event.matchedSize - event.deltaMatchedSize);
    const boundedPreviousMatchedSize = Math.min(rawPreviousMatchedSize, trackedOrderSize);
    const boundedMatchedSize = Math.min(event.matchedSize, trackedOrderSize);
    const boundedDeltaMatchedSize = boundedMatchedSize - boundedPreviousMatchedSize;
    const isFullyMatched =
      trackedOrderSize > 0 && boundedMatchedSize + 1e-9 >= trackedOrderSize;
    const normalizedEvent =
      boundedMatchedSize + 1e-9 < event.matchedSize ||
      boundedDeltaMatchedSize + 1e-9 < event.deltaMatchedSize ||
      (isFullyMatched && !event.isTerminal)
        ? {
            ...event,
            matchedSize: boundedMatchedSize,
            deltaMatchedSize: Math.max(0, boundedDeltaMatchedSize),
            isTerminal: event.isTerminal || isFullyMatched
          }
        : event;

    if (normalizedEvent !== event) {
      this.logger.warn(
        {
          orderId: event.orderId,
          market: event.market,
          assetId: event.assetId,
          side: event.side,
          trackedOrderSize,
          rawMatchedSize: event.matchedSize,
          rawDeltaMatchedSize: event.deltaMatchedSize,
          boundedMatchedSize: normalizedEvent.matchedSize,
          boundedDeltaMatchedSize: normalizedEvent.deltaMatchedSize,
          status: event.status
        },
        "Clamped user-ws fill progress that exceeded the tracked order size."
      );
    }

    if (!(normalizedEvent.deltaMatchedSize > 0)) {
      return;
    }

    this.noteQuoteFilled(trackedQuote.conditionId, event.orderId);
    const handledAtMs = Date.now();
    this.quoteExecutor.notifyOrderFillProgress(
      event.orderId,
      normalizedEvent.isTerminal,
      handledAtMs
    );

    if (normalizedEvent.isTerminal) {
      this.noteTerminallyHandledQuoteOrder(trackedQuote, normalizedEvent, handledAtMs);
      this.quoteExecutor.removeTrackedQuoteByOrderId(event.orderId);
    }

    const market = this.tokenToMarket.get(trackedQuote.tokenId);
    const fillPrice =
      Number.isFinite(normalizedEvent.price) && normalizedEvent.price > 0
        ? normalizedEvent.price
        : trackedQuote.price;
    const matchedAt = new Date().toISOString();

    const executionQuality: ExecutionQualityRecord = {
      createdAtMs: trackedQuote.intentCreatedAtMs,
      firstFillAtMs: trackedQuote.firstFillAtMs,
      requoteCount: trackedQuote.requoteCount,
      partialFillCount: trackedQuote.partialFillCount
    };

    this.handleMakerFill({
      tradeId: event.tradeId ?? `user-ws:${event.orderId}:${normalizedEvent.matchedSize.toFixed(8)}`,
      orderId: event.orderId,
      date: matchedAt.slice(0, 10),
      matchedAt,
      conditionId: trackedQuote.conditionId,
      marketSlug: trackedQuote.marketSlug,
      category: trackedQuote.category,
      feesEnabled: market?.feesEnabled ?? false,
      assetId: trackedQuote.tokenId,
      outcome: trackedQuote.outcome,
      side: trackedQuote.side,
      shares: normalizedEvent.deltaMatchedSize,
      price: fillPrice,
      expectedPriceUsdc: trackedQuote.price,
      quotePostedAtMs: trackedQuote.openedAtMs,
      quoteAgeMs: Math.max(0, handledAtMs - trackedQuote.openedAtMs),
      quoteMaxRestingAgeMs: trackedQuote.maxRestingAgeMs,
      notionalUsdc: Number((normalizedEvent.deltaMatchedSize * fillPrice).toFixed(8)),
      feeEquivalentUsdc: 0,
      maxPotentialRebateUsdc: 0,
      makerRebatePct: 0,
      executionQuality
    });

    this.requestImmediateConditionReevaluation(trackedQuote.conditionId);
  }

  private resolveMarketForUntrackedFillProgress(
    event: UserOrderFillProgressEvent
  ): BinaryMarket | undefined {
    return (
      this.tokenToMarket.get(event.assetId) ??
      this.resolveKnownMarket(event.market, event.market)
    );
  }

  private recoverFromUntrackedFillProgress(
    event: UserOrderFillProgressEvent,
    market: BinaryMarket | undefined
  ): void {
    if (this.stopping || !market) {
      return;
    }

    void (async () => {
      try {
        if (this.stopping) {
          return;
        }

        await this.reconcileVenueInventoryForMarket(market, Date.now(), true);

        if (this.stopping) {
          return;
        }

        this.requestImmediateConditionReevaluation(market.conditionId);
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            orderId: event.orderId,
            market: event.market,
            assetId: event.assetId,
            recoveredConditionId: market.conditionId
          },
          "Failed to recover from user-ws fill progress for an untracked order."
        );
      }
    })();
  }

  private noteKnownQuoteOrderObservation(input: {
    orderId: string;
    conditionId: string;
    marketSlug: string;
    tokenId: string;
    side: string;
    size: number;
    postedAtMs?: number;
    maxRestingAgeMs?: number;
    seenAtMs?: number;
  }): void {
    if (!input.orderId) {
      return;
    }

    const normalizedSide = input.side.toUpperCase();
    if ((normalizedSide !== "BUY" && normalizedSide !== "SELL") || !(input.size > 0)) {
      return;
    }

    const seenAtMs = input.seenAtMs ?? Date.now();
    this.pruneKnownQuoteOrderObservations(seenAtMs);
    this.knownQuoteOrderObservationsByOrderId.set(input.orderId, {
      orderId: input.orderId,
      conditionId: input.conditionId,
      marketSlug: input.marketSlug,
      tokenId: input.tokenId,
      side: normalizedSide,
      size: input.size,
      postedAtMs: input.postedAtMs,
      maxRestingAgeMs: input.maxRestingAgeMs,
      seenAtMs
    });
  }

  private noteTerminallyHandledQuoteOrder(
    quote: {
      orderId: string;
      conditionId: string;
      marketSlug: string;
      tokenId: string;
      side: string;
      size: number;
    },
    event: UserOrderFillProgressEvent,
    resolvedAtMs: number
  ): void {
    this.noteKnownQuoteOrderObservation({
      orderId: quote.orderId,
      conditionId: quote.conditionId,
      marketSlug: quote.marketSlug,
      tokenId: quote.tokenId,
      side: quote.side,
      size: quote.size,
      seenAtMs: resolvedAtMs
    });
    const knownOrder = this.knownQuoteOrderObservationsByOrderId.get(quote.orderId);

    if (!knownOrder) {
      return;
    }

    this.terminallyHandledQuoteOrdersByOrderId.set(quote.orderId, {
      ...knownOrder,
      resolvedAtMs,
      matchedSize: event.matchedSize
    });
  }

  private pruneKnownQuoteOrderObservations(nowMs: number = Date.now()): void {
    for (const [orderId, observation] of this.knownQuoteOrderObservationsByOrderId.entries()) {
      if (nowMs - observation.seenAtMs > KNOWN_QUOTE_ORDER_OBSERVATION_TTL_MS) {
        this.knownQuoteOrderObservationsByOrderId.delete(orderId);
      }
    }

    for (const [orderId, observation] of this.terminallyHandledQuoteOrdersByOrderId.entries()) {
      if (nowMs - observation.resolvedAtMs > DUPLICATE_TERMINAL_FILL_IGNORE_WINDOW_MS) {
        this.terminallyHandledQuoteOrdersByOrderId.delete(orderId);
      }
    }
  }

  private getKnownQuoteOrderObservation(
    orderId: string,
    nowMs: number = Date.now()
  ): KnownQuoteOrderObservation | undefined {
    this.pruneKnownQuoteOrderObservations(nowMs);
    return this.knownQuoteOrderObservationsByOrderId.get(orderId);
  }

  private getTerminallyHandledQuoteOrder(
    orderId: string,
    nowMs: number = Date.now()
  ): TerminallyHandledQuoteOrder | undefined {
    this.pruneKnownQuoteOrderObservations(nowMs);
    return this.terminallyHandledQuoteOrdersByOrderId.get(orderId);
  }

  private assessUntrackedFillProgressRecovery(
    event: UserOrderFillProgressEvent,
    knownOrder: KnownQuoteOrderObservation
  ): {
    shouldRecover: boolean;
    ignoredReason?: string;
  } {
    if (event.assetId !== knownOrder.tokenId) {
      return {
        shouldRecover: false,
        ignoredReason: "asset_id_mismatch"
      };
    }

    if (event.side !== knownOrder.side) {
      return {
        shouldRecover: false,
        ignoredReason: "side_mismatch"
      };
    }

    if (Number.isFinite(event.originalSize) && event.originalSize > knownOrder.size + 1e-6) {
      return {
        shouldRecover: false,
        ignoredReason: "original_size_exceeds_known_order"
      };
    }

    if (Number.isFinite(event.matchedSize) && event.matchedSize > knownOrder.size + 1e-6) {
      return {
        shouldRecover: false,
        ignoredReason: "matched_size_exceeds_known_order"
      };
    }

    return {
      shouldRecover: true
    };
  }

  private getCurrentBestBid(tokenId: string, market: BinaryMarket | undefined): number | undefined {
    const book = this.orderBookStore.get(tokenId);
    const bestBid = book?.bids[0]?.price;

    if (typeof bestBid === "number" && Number.isFinite(bestBid)) {
      return bestBid;
    }

    if (!market) {
      return undefined;
    }

    const tokenIndex = market.tokenIds.indexOf(tokenId);
    const opposingTokenId =
      tokenIndex === 0 ? market.tokenIds[1] : tokenIndex === 1 ? market.tokenIds[0] : undefined;

    if (opposingTokenId) {
      const opposingBook = this.orderBookStore.get(opposingTokenId);
      const opposingBestAsk = opposingBook?.asks[0]?.price;

      if (typeof opposingBestAsk === "number" && Number.isFinite(opposingBestAsk)) {
        return Number((1 - opposingBestAsk).toFixed(8));
      }
    }

    return undefined;
  }

  private buildMakerFillAlertContext(input: {
    tokenId: string;
    side: "BUY" | "SELL";
    positionBeforeShares: number;
    positionAfterShares: number;
    averageCostUsdcPerShare?: number;
    expectedPriceUsdc?: number;
    actualPriceUsdc: number;
    realizedPnlUsdc?: number;
    defaultReason: string;
  }): MakerFillAlertContext {
    const market = this.tokenToMarket.get(input.tokenId);
    const currentPosition = this.inventoryTracker.getOpenPosition(input.tokenId);
    const currentPriceUsdc = this.getCurrentBestBid(input.tokenId, market);
    const unrealizedPnlUsdc =
      currentPosition && typeof currentPriceUsdc === "number"
        ? currentPriceUsdc * currentPosition.shares - currentPosition.totalCostUsdc
        : undefined;

    let totalNetPnlUsdc: number | undefined;
    let positionBiasPct: number | undefined;

    if (market) {
      const [tokenA, tokenB] = market.tokenIds;
      const positionA = this.inventoryTracker.getOpenPosition(tokenA);
      const positionB = this.inventoryTracker.getOpenPosition(tokenB);
      const sharesA = positionA?.shares ?? 0;
      const sharesB = positionB?.shares ?? 0;
      const totalShares = sharesA + sharesB;
      const bestBidA = this.getCurrentBestBid(tokenA, market);
      const bestBidB = this.getCurrentBestBid(tokenB, market);

      if (typeof bestBidA === "number" && typeof bestBidB === "number") {
        const totalCost = (positionA?.totalCostUsdc ?? 0) + (positionB?.totalCostUsdc ?? 0);
        const totalMarkValue = sharesA * bestBidA + sharesB * bestBidB;
        totalNetPnlUsdc = totalMarkValue - totalCost;
      }

      if (totalShares > 0) {
        positionBiasPct = Math.abs(sharesA - sharesB) / totalShares * 100;
      }
    }

    return {
      positionBeforeShares: input.positionBeforeShares,
      positionAfterShares: input.positionAfterShares,
      averageCostUsdcPerShare: input.averageCostUsdcPerShare,
      currentPriceUsdc,
      unrealizedPnlUsdc,
      totalNetPnlUsdc,
      positionBiasPct,
      reason: input.defaultReason,
      expectedPriceUsdc: input.expectedPriceUsdc,
      slippageUsdcPerShare:
        typeof input.expectedPriceUsdc === "number"
          ? input.actualPriceUsdc - input.expectedPriceUsdc
          : undefined,
      orderType: "maker"
    };
  }

  private buildPassiveBuyFreshnessLease(
    market: BinaryMarket,
    quote: QuoteInstruction,
    nowMs: number
  ): PassiveBuyFreshnessLease {
    const book = this.orderBookStore.get(quote.tokenId);
    const telemetry = this.orderBookStore.getSelectionTelemetry(quote.tokenId);
    const bestBid = book?.bids[0];
    const bestAsk = book?.asks[0];
    const maxBookStalenessMs = Math.max(config.strategy.maxBookStalenessMs, 1);
    const bookAgeMs =
      book && typeof book.updatedAtMs === "number"
        ? Math.max(0, nowMs - book.updatedAtMs)
        : Number.POSITIVE_INFINITY;
    const targetShares = Math.max(
      quote.size,
      resolveSelectionTargetShares(market),
      market.orderMinSize,
      1
    );
    const recentTradeEvents = Math.max(0, telemetry?.recentTradeEvents ?? 0);
    const midpointRange = telemetry?.midpointRange;
    const expectedExitSeconds = estimateExpectedExitSeconds(book, targetShares);
    const marketableExitNotionalUsdc = estimateMarketableExitNotionalUsdc(book, targetShares);
    const bestBidNotionalUsdc =
      bestBid && bestBid.price > 0 && bestBid.size > 0 ? bestBid.price * bestBid.size : undefined;
    const bestBidSupportShares =
      bestBid && bestBid.size > 0 && Number.isFinite(bestBid.size) ? bestBid.size : undefined;
    const targetExitPrice = clampPrice(
      Math.max(
        quote.price + quote.tickSize,
        (bestBid?.price ?? quote.price) + quote.tickSize
      ),
      quote.tickSize
    );
    const targetExitQueueAheadShares = estimatePassiveExitQueueAheadShares(book, targetExitPrice);
    const quoteNotionalUsdc = Math.max(quote.price * quote.size, quote.tickSize * quote.size, 0);
    const minimumBestBidSupportShares =
      quote.size * config.marketMaker.passiveBuyMinBestBidSupportMultiplier;
    const maximumTargetExitQueueAheadShares =
      quote.size * config.marketMaker.passiveBuyMaxTargetExitQueueMultiplier;
    const weakenedReasons: string[] = [];
    const severeReasons: string[] = [];
    let maxRestingAgeMs = config.marketMaker.passiveBuyMaxAgeMs;

    if (
      !book ||
      !bestBid ||
      !bestAsk ||
      !Number.isFinite(bookAgeMs) ||
      bookAgeMs > maxBookStalenessMs
    ) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyNoTradeMaxAgeMs
      );
      weakenedReasons.push("stale_book");
      severeReasons.push("stale_book");
    }

    const requiredRecentTrades = Math.max(
      1,
      config.marketUniverse.minRecentTradeEvents
    );
    if (!telemetry) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyNoTradeMaxAgeMs
      );
      weakenedReasons.push("missing_live_trade_signal");
      severeReasons.push("missing_live_trade_signal");
    }

    if (recentTradeEvents <= 0) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyNoTradeMaxAgeMs
      );
      weakenedReasons.push("no_recent_trades");
      severeReasons.push("no_recent_trades");
    } else if (recentTradeEvents < requiredRecentTrades) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyWeakSignalMaxAgeMs
      );
      weakenedReasons.push("thin_recent_trades");
    }

    if (typeof expectedExitSeconds !== "number" || !Number.isFinite(expectedExitSeconds)) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyWeakSignalMaxAgeMs
      );
      weakenedReasons.push("missing_exit_velocity");
    } else if (expectedExitSeconds > config.marketMaker.passiveBuyMaxExpectedExitSeconds) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyWeakSignalMaxAgeMs
      );
      weakenedReasons.push("slow_expected_exit");

      if (
        expectedExitSeconds >
        config.marketMaker.passiveBuyMaxExpectedExitSeconds * 2
      ) {
        severeReasons.push("very_slow_expected_exit");
      }
    }

    if (quoteNotionalUsdc > 0) {
      if (
        typeof marketableExitNotionalUsdc !== "number" ||
        !Number.isFinite(marketableExitNotionalUsdc)
      ) {
        maxRestingAgeMs = Math.min(
          maxRestingAgeMs,
          config.marketMaker.passiveBuyWeakSignalMaxAgeMs
        );
        weakenedReasons.push("missing_marketable_exit");
      } else if (marketableExitNotionalUsdc + 1e-9 < quoteNotionalUsdc * 0.9) {
        maxRestingAgeMs = Math.min(
          maxRestingAgeMs,
          config.marketMaker.passiveBuyWeakSignalMaxAgeMs
        );
        weakenedReasons.push("shallow_marketable_exit");

        if (marketableExitNotionalUsdc + 1e-9 < quoteNotionalUsdc * 0.5) {
          severeReasons.push("very_shallow_marketable_exit");
        }
      }

      if (
        typeof bestBidNotionalUsdc === "number" &&
        Number.isFinite(bestBidNotionalUsdc) &&
        bestBidNotionalUsdc + 1e-9 < quoteNotionalUsdc * 0.75
      ) {
        maxRestingAgeMs = Math.min(
          maxRestingAgeMs,
          config.marketMaker.passiveBuyWeakSignalMaxAgeMs
        );
        weakenedReasons.push("thin_best_bid");

        if (bestBidNotionalUsdc + 1e-9 < quoteNotionalUsdc * 0.4) {
          severeReasons.push("very_thin_best_bid");
        }
      }
    }

    if (
      typeof bestBidSupportShares !== "number" ||
      !Number.isFinite(bestBidSupportShares) ||
      bestBidSupportShares + Number.EPSILON < minimumBestBidSupportShares
    ) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyWeakSignalMaxAgeMs
      );
      weakenedReasons.push("weak_best_bid_support");

      if (
        typeof bestBidSupportShares !== "number" ||
        !Number.isFinite(bestBidSupportShares) ||
        bestBidSupportShares + Number.EPSILON < minimumBestBidSupportShares * 0.5
      ) {
        severeReasons.push("very_weak_best_bid_support");
      }
    }

    if (
      typeof targetExitQueueAheadShares === "number" &&
      Number.isFinite(targetExitQueueAheadShares) &&
      targetExitQueueAheadShares - Number.EPSILON > maximumTargetExitQueueAheadShares
    ) {
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyWeakSignalMaxAgeMs
      );
      weakenedReasons.push("crowded_target_exit_queue");

      if (
        targetExitQueueAheadShares - Number.EPSILON >
        maximumTargetExitQueueAheadShares * 2
      ) {
        severeReasons.push("very_crowded_target_exit_queue");
      }
    }

    if (
      typeof midpointRange === "number" &&
      Number.isFinite(midpointRange) &&
      midpointRange + Number.EPSILON >=
        quote.tickSize * config.marketMaker.passiveBuyMaxAdverseMidpointRangeTicks
    ) {
      const severeMidpointRange =
        midpointRange + Number.EPSILON >=
        quote.tickSize * config.marketMaker.passiveBuyMaxAdverseMidpointRangeTicks * 2;
      maxRestingAgeMs = Math.min(
        maxRestingAgeMs,
        config.marketMaker.passiveBuyNoTradeMaxAgeMs
      );
      weakenedReasons.push("adverse_midpoint_range");
      if (severeMidpointRange) {
        severeReasons.push("adverse_midpoint_range");
      }
    }

    if (
      weakenedReasons.includes("no_recent_trades") &&
      [
        "slow_expected_exit",
        "missing_marketable_exit",
        "shallow_marketable_exit",
        "thin_best_bid",
        "weak_best_bid_support",
        "crowded_target_exit_queue"
      ].some((reason) => weakenedReasons.includes(reason))
    ) {
      severeReasons.push("no_recent_trades_with_weak_exitability");
    }

    return {
      maxRestingAgeMs: Math.max(1_000, Math.round(maxRestingAgeMs)),
      recentTradeEvents,
      expectedExitSeconds,
      marketableExitNotionalUsdc,
      bestBidNotionalUsdc,
      bestBidSupportShares:
        typeof bestBidSupportShares === "number" && Number.isFinite(bestBidSupportShares)
          ? Number(bestBidSupportShares.toFixed(4))
          : undefined,
      targetExitQueueAheadShares:
        typeof targetExitQueueAheadShares === "number" && Number.isFinite(targetExitQueueAheadShares)
          ? Number(targetExitQueueAheadShares.toFixed(4))
          : undefined,
      midpointRange:
        typeof midpointRange === "number" && Number.isFinite(midpointRange)
          ? Number(midpointRange.toFixed(8))
          : undefined,
      weakenedReasons,
      severeReasons: Array.from(new Set(severeReasons))
    };
  }

  private shouldLogPassiveBuyFreshnessSkip(
    market: BinaryMarket,
    quote: QuoteInstruction,
    lease: PassiveBuyFreshnessLease,
    nowMs: number
  ): boolean {
    const key = `${market.conditionId}:${quote.tokenId}:${quote.quoteSlot ?? "primary"}`;
    const signature = JSON.stringify({
      severeReasons: lease.severeReasons,
      weakenedReasons: lease.weakenedReasons,
      maxRestingAgeMs: lease.maxRestingAgeMs,
      recentTradeBucket:
        typeof lease.recentTradeEvents === "number"
          ? lease.recentTradeEvents <= 0
            ? "0"
            : lease.recentTradeEvents < config.marketUniverse.minRecentTradeEvents
              ? "below_min"
              : "ok"
          : "unknown"
    });
    const lastSignature = this.lastPassiveBuyFreshnessSkipSignatureByKey?.get(key);
    const lastLoggedAt = this.lastPassiveBuyFreshnessSkipLogAtByKey?.get(key) ?? 0;

    if (
      lastSignature === signature &&
      nowMs - lastLoggedAt < PASSIVE_BUY_FRESHNESS_SKIP_LOG_INTERVAL_MS
    ) {
      return false;
    }

    this.lastPassiveBuyFreshnessSkipSignatureByKey?.set(key, signature);
    this.lastPassiveBuyFreshnessSkipLogAtByKey?.set(key, nowMs);
    return true;
  }

  private shouldLogRiskReductionReentrySuppression(
    conditionId: string,
    nowMs: number = Date.now()
  ): boolean {
    const lastLoggedAt =
      this.lastRiskReductionReentrySuppressionLogAtByConditionId.get(conditionId) ?? 0;

    if (
      lastLoggedAt > 0 &&
      nowMs - lastLoggedAt < RISK_REDUCTION_REENTRY_SUPPRESSION_LOG_INTERVAL_MS
    ) {
      return false;
    }

    this.lastRiskReductionReentrySuppressionLogAtByConditionId.set(conditionId, nowMs);
    return true;
  }

  private applyPassiveBuyFreshnessLeaseToPlan(
    market: BinaryMarket,
    plan: MarketMakerPlan,
    nowMs: number
  ): MarketMakerPlan {
    const quoteLeaseByKey = new Map<string, PassiveBuyFreshnessLease>();
    const suppressedBuyKeys = new Set<string>();

    for (const quote of plan.quotes) {
      if (
        quote.side !== Side.BUY ||
        !quote.postOnly ||
        quote.executionStyle === "one-side-aggressive-exit"
      ) {
        continue;
      }

      const lease = this.buildPassiveBuyFreshnessLease(market, quote, nowMs);
      const key = `${quote.tokenId}:${quote.quoteSlot ?? "primary"}`;
      quoteLeaseByKey.set(key, lease);

      const activeQuote = this.quoteExecutor?.getActiveQuote(
        quote.tokenId,
        Side.BUY,
        quote.quoteSlot
      );
      const activeQuoteAgeMs =
        activeQuote && typeof activeQuote.openedAtMs === "number"
          ? Math.max(0, nowMs - activeQuote.openedAtMs)
          : undefined;
      // ALLOWED_SLUGS 모드 (운영자 명시 시장) 에선 freshness lease 의 severe 게이트 우회.
      // 정치 장기 시장은 5분 trade 0건이 정상 — 사장님 가이드의 "유동성 점유율 싸움"
      // 으로 quote 박는 게 reward 적립 핵심. 거래 없는 시장도 quote 게시 허용.
      const allowlistedMode = config.marketUniverse.allowedSlugs.length > 0;
      const shouldWithdrawAgedBuy =
        !allowlistedMode &&
        typeof activeQuoteAgeMs === "number" &&
        activeQuoteAgeMs >= lease.maxRestingAgeMs &&
        lease.weakenedReasons.length > 0;
      const shouldSuppressFreshPost =
        !allowlistedMode &&
        !activeQuote &&
        lease.severeReasons.length > 0;

      if (shouldWithdrawAgedBuy || shouldSuppressFreshPost) {
        suppressedBuyKeys.add(key);
        const shouldLog =
          shouldWithdrawAgedBuy ||
          this.shouldLogPassiveBuyFreshnessSkip(market, quote, lease, nowMs);
        if (shouldLog) {
          this.logger.info(
            {
              market: market.slug,
              conditionId: market.conditionId,
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              quoteSlot: quote.quoteSlot ?? "primary",
              activeQuoteAgeMs,
              maxRestingAgeMs: lease.maxRestingAgeMs,
              recentTradeEvents: lease.recentTradeEvents,
              expectedExitSeconds: lease.expectedExitSeconds,
              marketableExitNotionalUsdc: lease.marketableExitNotionalUsdc,
              bestBidNotionalUsdc: lease.bestBidNotionalUsdc,
              bestBidSupportShares: lease.bestBidSupportShares,
              targetExitQueueAheadShares: lease.targetExitQueueAheadShares,
              midpointRange: lease.midpointRange,
              weakenedReasons: lease.weakenedReasons,
              severeReasons: lease.severeReasons
            },
            shouldWithdrawAgedBuy
              ? "Cancelled stale passive BUY because its freshness lease expired under weaker market conditions."
              : "Skipped passive BUY because the market's freshness/exitability lease was already violated at posting time."
          );
        }
      }
    }

    const withLease = (quote: QuoteInstruction): QuoteInstruction => {
      if (
        quote.side !== Side.BUY ||
        !quote.postOnly ||
        quote.executionStyle === "one-side-aggressive-exit"
      ) {
        return quote;
      }

      const lease = quoteLeaseByKey.get(`${quote.tokenId}:${quote.quoteSlot ?? "primary"}`);
      return lease ? { ...quote, maxRestingAgeMs: lease.maxRestingAgeMs } : quote;
    };

    const quotes = plan.quotes
      .filter((quote) => !suppressedBuyKeys.has(`${quote.tokenId}:${quote.quoteSlot ?? "primary"}`))
      .map(withLease);
    const tokenPlans = plan.tokenPlans.map((tokenPlan) => ({
      ...tokenPlan,
      quotes: tokenPlan.quotes.map(withLease) as unknown as typeof tokenPlan.quotes
    })) as unknown as typeof plan.tokenPlans;

    return {
      ...plan,
      quotes,
      tokenPlans
    };
  }

  private requestImmediateConditionReevaluation(conditionId: string): void {
    if (this.stopping) {
      return;
    }

    const market =
      this.conditionToMarket.get(conditionId) ??
      this.knownConditionToMarket.get(conditionId);

    if (!market) {
      return;
    }

    this.rememberManagedMarket(market);

    if (this.evaluationLocks.has(conditionId)) {
      this.pendingImmediateReevaluationConditionIds.add(conditionId);
      return;
    }

    void this.handleTokenUpdate(market.tokenIds[0]);
  }

  private pruneFillRateSamples(conditionId: string, now = Date.now()): void {
    const cutoff = now - config.marketMaker.fillRateFeedbackWindowMs;
    const postedSamples = this.postedQuoteSamplesByConditionId.get(conditionId) ?? [];
    const prunedPostedSamples = postedSamples.filter((sample) => sample.occurredAtMs >= cutoff);

    if (prunedPostedSamples.length > 0) {
      this.postedQuoteSamplesByConditionId.set(conditionId, prunedPostedSamples);
    } else {
      this.postedQuoteSamplesByConditionId.delete(conditionId);
    }

    const activePostedOrderIds = new Set(prunedPostedSamples.map((sample) => sample.orderId));
    const filledSamples = this.filledQuoteSamplesByConditionId.get(conditionId) ?? [];
    const prunedFilledSamples = filledSamples.filter(
      (sample) => sample.occurredAtMs >= cutoff && activePostedOrderIds.has(sample.orderId)
    );

    if (prunedFilledSamples.length > 0) {
      this.filledQuoteSamplesByConditionId.set(conditionId, prunedFilledSamples);
    } else {
      this.filledQuoteSamplesByConditionId.delete(conditionId);
    }
  }

  private noteQuotePosted(conditionId: string, orderId: string, occurredAtMs = Date.now()): void {
    const samples = this.postedQuoteSamplesByConditionId.get(conditionId) ?? [];
    samples.push({ orderId, occurredAtMs });
    this.postedQuoteSamplesByConditionId.set(conditionId, samples);
    this.pruneFillRateSamples(conditionId, occurredAtMs);
  }

  private buildQuotePostedAlertKey(quote: QuoteInstruction): string {
    return [
      quote.tokenId,
      quote.side,
      quote.quoteSlot ?? "primary",
      quote.postOnly ? "maker" : "aggressive"
    ].join(":");
  }

  private pruneQuotePostedAlertTracking(nowMs: number = Date.now()): void {
    for (const [key, occurredAtMs] of this.lastQuotePostedAlertAtBySlotKey.entries()) {
      if (nowMs - occurredAtMs > QUOTE_POSTED_ALERT_STATE_TTL_MS) {
        this.lastQuotePostedAlertAtBySlotKey.delete(key);
      }
    }
  }

  private shouldDispatchQuotePostedAlert(quote: QuoteInstruction, nowMs: number = Date.now()): boolean {
    if (!config.alerting.enableQuotePosted) {
      return false;
    }

    const isEligibleSide =
      quote.side === Side.BUY ||
      !quote.postOnly ||
      (quote.side === Side.SELL && config.alerting.quotePostedIncludePassiveSells);

    if (!isEligibleSide) {
      return false;
    }

    this.pruneQuotePostedAlertTracking(nowMs);
    const alertKey = this.buildQuotePostedAlertKey(quote);
    const previousAtMs = this.lastQuotePostedAlertAtBySlotKey.get(alertKey);

    if (
      typeof previousAtMs === "number" &&
      nowMs - previousAtMs < config.alerting.quotePostedMinIntervalMs
    ) {
      return false;
    }

    this.lastQuotePostedAlertAtBySlotKey.set(alertKey, nowMs);
    return true;
  }

  private maybeDispatchQuotePostedAlert(quote: QuoteInstruction & { marketSlug: string; orderId: string; openedAtMs: number }): void {
    const occurredAtMs = quote.openedAtMs || Date.now();

    if (!this.shouldDispatchQuotePostedAlert(quote, occurredAtMs)) {
      return;
    }

    void this.alertDispatcher.dispatch(
      buildQuotePostedAlert({
        runtime: "market-maker",
        strategy: "market-making",
        market: quote.marketSlug,
        outcome: quote.outcome,
        side: quote.side,
        size: quote.size,
        price: quote.price,
        occurredAtMs,
        orderId: quote.orderId,
        quoteSlot: quote.quoteSlot,
        orderType: String(quote.orderType),
        executionStyle: quote.executionStyle,
        postOnly: quote.postOnly,
        maxRestingAgeMs: quote.maxRestingAgeMs
      })
    );
  }

  private noteQuoteFilled(conditionId: string, orderId: string, occurredAtMs = Date.now()): void {
    this.pruneFillRateSamples(conditionId, occurredAtMs);
    const postedSamples = this.postedQuoteSamplesByConditionId.get(conditionId) ?? [];

    if (!postedSamples.some((sample) => sample.orderId === orderId)) {
      return;
    }

    const filledSamples = this.filledQuoteSamplesByConditionId.get(conditionId) ?? [];

    if (filledSamples.some((sample) => sample.orderId === orderId)) {
      return;
    }

    filledSamples.push({ orderId, occurredAtMs });
    this.filledQuoteSamplesByConditionId.set(conditionId, filledSamples);
    this.pruneFillRateSamples(conditionId, occurredAtMs);
  }

  private getFillRateFeedback(conditionId: string): MarketMakerFillRateFeedback | undefined {
    if (!config.marketMaker.enableFillRateFeedback) {
      return undefined;
    }

    this.pruneFillRateSamples(conditionId);
    const postedSamples = this.postedQuoteSamplesByConditionId.get(conditionId) ?? [];
    const filledSamples = this.filledQuoteSamplesByConditionId.get(conditionId) ?? [];
    const postedQuoteCount = postedSamples.length;

    if (postedQuoteCount < config.marketMaker.fillRateFeedbackMinPostedQuotes) {
      return undefined;
    }

    const filledQuoteCount = Math.min(filledSamples.length, postedQuoteCount);
    const fillRate = Math.max(0, Math.min(1, filledQuoteCount / postedQuoteCount));
    const threshold = config.marketMaker.fillRateFeedbackTarget;

    if (fillRate + 1e-9 >= threshold || config.marketMaker.fillRateFeedbackMaxInwardTicks <= 0) {
      return {
        postedQuoteCount,
        filledQuoteCount,
        fillRate,
        inwardTicks: 0
      };
    }

    const fillRateGapRatio =
      threshold > 0 ? Math.max(0, (threshold - fillRate) / threshold) : 1;
    const inwardTicks = Math.max(
      1,
      Math.min(
        config.marketMaker.fillRateFeedbackMaxInwardTicks,
        Math.ceil(fillRateGapRatio * config.marketMaker.fillRateFeedbackMaxInwardTicks)
      )
    );

    return {
      postedQuoteCount,
      filledQuoteCount,
      fillRate,
      inwardTicks
    };
  }

  private async executeMaxHoldHardExitIfNeeded(
    market: BinaryMarket,
    plan: MarketMakerPlan,
    nowMs: number = Date.now()
  ): Promise<void> {
    if (!this.quoteExecutor || !this.riskReductionExecutor || !config.marketMaker.enableMaxHoldHardExit) {
      return;
    }

    const hardExitState = resolveMarketMakerMaxHoldHardExitState(
      plan,
      (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId),
      nowMs
    );

    if (!hardExitState) {
      this.lastMaxHoldHardExitAttemptAtByConditionId.delete(market.conditionId);
      this.lastMaxHoldHardExitLogSignatureByConditionId.delete(market.conditionId);
      return;
    }

    const lastAttemptAtMs = this.lastMaxHoldHardExitAttemptAtByConditionId.get(market.conditionId) ?? 0;

    if (
      nowMs - lastAttemptAtMs + Number.EPSILON <
      config.marketMaker.maxHoldHardExitRetryCooldownMs
    ) {
      return;
    }

    const candidates = hardExitState.agedTokenIds
      .map((tokenId) => {
        const outcomeIndex = market.tokenIds.indexOf(tokenId);
        const outcome = outcomeIndex >= 0 ? market.outcomes[outcomeIndex] : undefined;

        if (!outcome) {
          return undefined;
        }

        return {
          market,
          tokenId,
          outcome
        };
      })
      .filter((candidate): candidate is RiskReductionCandidate => Boolean(candidate));
    const boundedCandidates = candidates.map((candidate) =>
      this.withBoundedRiskReductionFloor(candidate)
    );

    if (boundedCandidates.length === 0) {
      return;
    }

    this.lastMaxHoldHardExitAttemptAtByConditionId.set(market.conditionId, nowMs);
    await this.quoteExecutor.cancelMarketQuotes(market.conditionId);
    this.syncExecutionEngineWithActiveQuotes();
    if (config.marketMaker.maxHoldHardExitPostCancelSettlementMs > 0) {
      await sleep(config.marketMaker.maxHoldHardExitPostCancelSettlementMs);
    }
    const summary = await this.riskReductionExecutor.reduceCandidates(
      boundedCandidates,
      "max-hold hard exit"
    );
    this.recordRiskReductionSummary(summary, "max-hold hard exit");

    if (summary.reducedCount > 0) {
      this.requestImmediateConditionReevaluation(market.conditionId);
    }
  }

  private async executeScheduledMaxHoldHardExitSweep(
    selectedConditionIds: ReadonlySet<string>,
    nowMs: number = Date.now()
  ): Promise<void> {
    if (!this.quoteExecutor || !this.riskReductionExecutor || !config.marketMaker.enableMaxHoldHardExit) {
      return;
    }

    const batches = buildMaxHoldRiskReductionBatchesFromOpenLots(
      this.inventoryTracker.exportOpenLots(),
      (conditionId, marketScope) => this.resolveKnownMarket(conditionId, marketScope),
      {
        nowMs,
        maxHoldAfterMs: config.marketMaker.maxHoldHardExitAfterMs,
        conditionalExitOverweightRatio: config.marketMaker.conditionalExitOverweightRatio,
        maxTokenExposureShares: config.marketMaker.maxTokenExposureShares
      }
    );

    for (const batch of batches) {
      const lastAttemptAtMs =
        this.lastMaxHoldHardExitAttemptAtByConditionId.get(batch.conditionId) ?? 0;

      if (
        nowMs - lastAttemptAtMs + Number.EPSILON <
        config.marketMaker.maxHoldHardExitRetryCooldownMs
      ) {
        continue;
      }

      if (
        this.shouldLogMaxHoldHardExitActivation(batch.conditionId, batch.agedTokenIds)
      ) {
        const inSelectedUniverse = selectedConditionIds.has(batch.conditionId);
        this.logger.warn(
          {
            market: batch.market.slug,
            conditionId: batch.conditionId,
            inSelectedUniverse,
            agedTokenIds: batch.agedTokenIds,
            oldestPositionAgeMs: batch.oldestPositionAgeMs,
            candidateCount: batch.candidates.length
          },
          inSelectedUniverse
            ? "Activated scheduled max-hold hard-exit adjustments for aged selected market-making inventory."
            : "Activated scheduled max-hold hard-exit adjustments for aged off-universe market-making inventory."
        );
      }

      this.lastMaxHoldHardExitAttemptAtByConditionId.set(batch.conditionId, nowMs);

      // Dispatch time-based unwind alerts for each aged token.
      for (const candidate of batch.candidates) {
        const openPos = this.inventoryTracker.getOpenPosition(candidate.tokenId);
        if (openPos) {
          void this.alertDispatcher.dispatch(
            buildTimeBasedUnwindAlert({
              runtime: "market-maker",
              market: batch.market.slug,
              outcome: candidate.outcome,
              tokenId: candidate.tokenId,
              shares: openPos.shares,
              holdDurationMs: batch.oldestPositionAgeMs,
              mode: "hard-exit",
              occurredAtMs: nowMs
            })
          );
        }
      }

      await this.quoteExecutor.cancelMarketQuotes(batch.conditionId);
      this.syncExecutionEngineWithActiveQuotes();

      if (config.marketMaker.maxHoldHardExitPostCancelSettlementMs > 0) {
        await sleep(config.marketMaker.maxHoldHardExitPostCancelSettlementMs);
      }

      const boundedCandidates = batch.candidates.map((candidate) =>
        this.withBoundedRiskReductionFloor(candidate)
      );
      const summary = await this.riskReductionExecutor.reduceCandidates(
        boundedCandidates,
        "max-hold hard exit"
      );
      this.recordRiskReductionSummary(summary, "max-hold hard exit");
    }
  }

  private resolveBoundedRiskReductionMinSellPrice(
    market: BinaryMarket,
    tokenId: string
  ): number | undefined {
    const position = this.inventoryTracker.getOpenPosition(tokenId);

    if (!position || position.shares <= Number.EPSILON) {
      return undefined;
    }

    const book = this.orderBookStore.get(tokenId);
    const tickSize = Math.max(
      book?.tickSize ?? market.orderPriceMinTickSize,
      market.orderPriceMinTickSize || book?.tickSize || 0.01
    );

    return resolveBoundedLossExitPriceForPosition(position, tickSize);
  }

  private resolveSellCoverageForcedReductionMinSellPrice(
    market: BinaryMarket,
    tokenId: string,
    maxReductionShares: number | undefined
  ): number | undefined {
    const position = this.inventoryTracker.getOpenPosition(tokenId);

    if (!position || position.shares <= Number.EPSILON) {
      return undefined;
    }

    const boundedFloor = this.resolveBoundedRiskReductionMinSellPrice(market, tokenId);
    const maxLossTicks = config.marketMaker.sellCoverageForceExitMaxLossTicks;
    const maxLossUsdc = config.marketMaker.sellCoverageForceExitMaxLossUsdc;

    if (maxLossTicks <= 0 && maxLossUsdc <= 0) {
      return boundedFloor;
    }

    const sharesToReduce = Math.max(
      Number.EPSILON,
      Math.min(position.shares, maxReductionShares ?? position.shares)
    );
    const averageCostPerShare = position.totalCostUsdc / position.shares;
    const book = this.orderBookStore.get(tokenId);
    const tickSize = Math.max(
      book?.tickSize ?? market.orderPriceMinTickSize,
      market.orderPriceMinTickSize || book?.tickSize || 0.01
    );
    const allowedLossesPerShare = [
      maxLossTicks > 0 ? maxLossTicks * tickSize : undefined,
      maxLossUsdc > 0 ? maxLossUsdc / sharesToReduce : undefined
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
    );

    if (allowedLossesPerShare.length === 0) {
      return boundedFloor;
    }

    const allowedLossPerShare = Math.min(...allowedLossesPerShare);
    const relaxedFloor = clampPrice(
      roundDownToTick(averageCostPerShare - allowedLossPerShare, tickSize),
      tickSize
    );

    return typeof boundedFloor === "number" && Number.isFinite(boundedFloor)
      ? Math.min(boundedFloor, relaxedFloor)
      : relaxedFloor;
  }

  private withBoundedRiskReductionFloor(
    candidate: RiskReductionCandidate
  ): RiskReductionCandidate {
    const minSellPrice = this.resolveBoundedRiskReductionMinSellPrice(
      candidate.market,
      candidate.tokenId
    );

    return typeof minSellPrice === "number" && Number.isFinite(minSellPrice)
      ? {
          ...candidate,
          minSellPrice
        }
      : candidate;
  }

  private resolveAgedInventoryExitLadderStage(positionAgeMs: number): number {
    const hardExitAfterMs = config.marketMaker.maxHoldHardExitAfterMs;
    const ladderStartCandidates = [
      config.marketMaker.ageBasedUnwindAfterMs,
      config.marketMaker.staleBreakEvenUnwindAfterMs,
      config.marketMaker.breakEvenExitAfterMs
    ].filter((value) => value > 0 && value + Number.EPSILON < hardExitAfterMs);
    const ladderStartMs =
      ladderStartCandidates.length > 0
        ? Math.min(...ladderStartCandidates)
        : 0;

    if (
      hardExitAfterMs <= 0 ||
      ladderStartMs <= 0 ||
      ladderStartMs + Number.EPSILON >= hardExitAfterMs ||
      positionAgeMs + Number.EPSILON < ladderStartMs
    ) {
      return 0;
    }

    const ladderWindowMs = hardExitAfterMs - ladderStartMs;
    const stage2AtMs = ladderStartMs + ladderWindowMs * 0.35;
    const stage3AtMs = ladderStartMs + ladderWindowMs * 0.7;

    if (positionAgeMs + Number.EPSILON >= stage3AtMs) {
      return 3;
    }

    if (positionAgeMs + Number.EPSILON >= stage2AtMs) {
      return 2;
    }

    return 1;
  }

  private resolveAgedInventoryExitLadderRetryCooldownMs(): number {
    const configuredCooldowns = [
      config.marketMaker.sellCoverageForceExitCooldownMs,
      config.marketMaker.maxHoldHardExitRetryCooldownMs
    ].filter((value) => value > 0 && Number.isFinite(value));

    return configuredCooldowns.length > 0
      ? Math.max(30_000, Math.min(...configuredCooldowns))
      : 30_000;
  }

  private resolveAgedInventoryExitLadderTargetShares(
    openShares: number,
    minimumOrderSize: number,
    stage: number
  ): number | undefined {
    const stageFraction = stage >= 3 ? 1 : stage === 2 ? 0.8 : 0.4;
    const targetShares = Math.min(
      openShares,
      Math.max(minimumOrderSize, openShares * stageFraction)
    );

    return this.resolveDustSafeReductionShares(openShares, targetShares, minimumOrderSize);
  }

  private resolveDustSafeReductionShares(
    openShares: number,
    requestedShares: number,
    minimumOrderSize: number
  ): number | undefined {
    if (!(openShares > Number.EPSILON) || !(requestedShares > Number.EPSILON)) {
      return undefined;
    }

    const boundedShares = Math.min(openShares, requestedShares);
    const remainingShares = Math.max(0, openShares - boundedShares);
    const dustThreshold = Math.max(minimumOrderSize, 0);
    const dustSafeShares =
      remainingShares > Number.EPSILON &&
      remainingShares + Number.EPSILON < dustThreshold
        ? openShares
        : boundedShares;

    return dustSafeShares > Number.EPSILON
      ? Number(dustSafeShares.toFixed(8))
      : undefined;
  }

  private resolveAgedInventoryExitLadderMinSellPrice(
    position: TrackedInventoryPosition,
    tickSize: number,
    stage: number,
    _nowMs: number
  ): number | undefined {
    const profitFloor = resolveMinimumExitPriceForPosition(
      position,
      tickSize,
      position.openedAtMs
    );

    if (profitFloor === undefined) {
      return undefined;
    }

    if (stage <= 1) {
      return profitFloor;
    }

    const maxLossTicks = Math.max(0, config.marketMaker.breakEvenExitMaxLossTicks);
    const stagedLossTicks =
      stage >= 3 ? maxLossTicks : Math.ceil(maxLossTicks / 2);

    if (stagedLossTicks <= 0) {
      return profitFloor;
    }

    const boundedLossFloor = resolveBoundedLossExitPriceForPosition(
      position,
      tickSize,
      stagedLossTicks
    );

    if (boundedLossFloor === undefined) {
      return profitFloor;
    }

    return boundedLossFloor;
  }

  private buildAgedInventoryExitLadderCandidates(
    market: BinaryMarket,
    nowMs: number = Date.now()
  ): Array<
    RiskReductionCandidate & {
      stage: number;
      positionAgeMs: number;
    }
  > {
    const candidates: Array<
      RiskReductionCandidate & {
        stage: number;
        positionAgeMs: number;
      }
    > = [];
    const minimumOrderSize = Math.max(market.orderMinSize, config.marketMaker.minSellShares, 1);

    for (const [index, tokenId] of market.tokenIds.entries()) {
      const position = this.inventoryTracker.getOpenPosition(tokenId);

      if (!position || position.shares <= Number.EPSILON) {
        this.agedInventoryExitLadderStateByTokenId.delete(tokenId);
        continue;
      }

      const positionAgeMs = Math.max(0, nowMs - position.openedAtMs);
      const stage = this.resolveAgedInventoryExitLadderStage(positionAgeMs);

      if (stage <= 0) {
        this.agedInventoryExitLadderStateByTokenId.delete(tokenId);
        continue;
      }

      const previousState = this.agedInventoryExitLadderStateByTokenId.get(tokenId);
      if (
        previousState &&
        previousState.openedAtMs === position.openedAtMs &&
        previousState.attemptedStage >= stage
      ) {
        const lastAttemptedAtMs = previousState.lastAttemptedAtMs;
        if (
          typeof lastAttemptedAtMs !== "number" ||
          nowMs - lastAttemptedAtMs + Number.EPSILON <
            this.resolveAgedInventoryExitLadderRetryCooldownMs()
        ) {
          continue;
        }
      }

      const maxReductionShares = this.resolveAgedInventoryExitLadderTargetShares(
        position.shares,
        minimumOrderSize,
        stage
      );

      if (!(maxReductionShares && maxReductionShares > Number.EPSILON)) {
        continue;
      }

      const book = this.orderBookStore.get(tokenId);
      const tickSize = Math.max(
        book?.tickSize ?? market.orderPriceMinTickSize,
        market.orderPriceMinTickSize || book?.tickSize || 0.01
      );
      const outcome = market.outcomes[index];

      if (!outcome) {
        continue;
      }

      candidates.push({
        market,
        tokenId,
        outcome,
        maxReductionShares,
        minSellPrice: this.resolveAgedInventoryExitLadderMinSellPrice(
          position,
          tickSize,
          stage,
          nowMs
        ),
        stage,
        positionAgeMs
      });
    }

    return candidates;
  }

  private async executeAgedInventoryExitLadderIfNeeded(
    market: BinaryMarket,
    nowMs: number = Date.now()
  ): Promise<boolean> {
    if (!this.quoteExecutor || !this.riskReductionExecutor || !config.marketMaker.enableMaxHoldHardExit) {
      return false;
    }

    const candidates = this.buildAgedInventoryExitLadderCandidates(market, nowMs);

    if (candidates.length === 0) {
      return false;
    }

    await this.quoteExecutor.cancelMarketQuotes(market.conditionId);
    this.syncExecutionEngineWithActiveQuotes();

    const reason = "aged inventory exit ladder";
    this.logger.warn(
      {
        market: market.slug,
        conditionId: market.conditionId,
        candidates: candidates.map((candidate) => ({
          tokenId: candidate.tokenId,
          outcome: candidate.outcome,
          stage: candidate.stage,
          positionAgeMs: candidate.positionAgeMs,
          maxReductionShares: candidate.maxReductionShares,
          minSellPrice: candidate.minSellPrice
        }))
      },
      "Activated staged aged-inventory exit ladder before max-hold hard exit."
    );
    const summary = await this.riskReductionExecutor.reduceCandidates(candidates, reason);

    for (const candidate of candidates) {
      const position = this.inventoryTracker.getOpenPosition(candidate.tokenId);
      this.agedInventoryExitLadderStateByTokenId.set(candidate.tokenId, {
        openedAtMs: position?.openedAtMs ?? nowMs,
        attemptedStage: candidate.stage,
        lastAttemptedAtMs: nowMs
      });
    }

    this.recordRiskReductionSummary(summary, reason);

    if (summary.reducedCount > 0) {
      this.requestImmediateConditionReevaluation(market.conditionId);
      return true;
    }

    return false;
  }

  private buildMaxHoldHardExitLogSignature(agedTokenIds: readonly string[]): string {
    return [...agedTokenIds].sort().join(",");
  }

  private shouldLogMaxHoldHardExitActivation(
    conditionId: string,
    agedTokenIds: readonly string[]
  ): boolean {
    const signature = this.buildMaxHoldHardExitLogSignature(agedTokenIds);
    const lastSignature = this.lastMaxHoldHardExitLogSignatureByConditionId.get(conditionId);

    if (lastSignature === signature) {
      return false;
    }

    this.lastMaxHoldHardExitLogSignatureByConditionId.set(conditionId, signature);
    return true;
  }

  private pruneThinTopBookRejectCooldowns(nowMs: number = Date.now()): void {
    for (const [conditionId, cooldownUntilMs] of this.thinTopBookRejectCooldownUntilMsByConditionId.entries()) {
      if (cooldownUntilMs <= nowMs + Number.EPSILON) {
        this.thinTopBookRejectCooldownUntilMsByConditionId.delete(conditionId);
      }
    }
  }

  private isInsideThinTopBookRejectCooldown(
    conditionId: string,
    nowMs: number = Date.now()
  ): boolean {
    const cooldownUntilMs =
      this.thinTopBookRejectCooldownUntilMsByConditionId.get(conditionId) ?? 0;
    return cooldownUntilMs > nowMs + Number.EPSILON;
  }

  private resetThinTopBookRejectState(conditionId: string): void {
    this.thinTopBookRejectCountByConditionId.delete(conditionId);
    this.thinTopBookRejectCooldownLevelByConditionId.delete(conditionId);
  }

  private noteThinTopBookReject(
    conditionId: string,
    nowMs: number = Date.now()
  ): {
    count: number;
    cooldownUntilMs?: number;
    activated: boolean;
  } {
    const threshold = config.marketMaker.thinTopBookRejectionThreshold;
    const cooldownMs = config.marketMaker.thinTopBookRejectionCooldownMs;
    const activeCooldownUntilMs =
      this.thinTopBookRejectCooldownUntilMsByConditionId.get(conditionId) ?? 0;

    if (activeCooldownUntilMs > nowMs + Number.EPSILON) {
      return {
        count: 0,
        cooldownUntilMs: activeCooldownUntilMs,
        activated: false
      };
    }

    const nextCount = (this.thinTopBookRejectCountByConditionId.get(conditionId) ?? 0) + 1;
    this.thinTopBookRejectCountByConditionId.set(conditionId, nextCount);

    if (threshold <= 0 || cooldownMs <= 0 || nextCount < threshold) {
      return {
        count: nextCount,
        activated: false
      };
    }

    const cooldownLevel =
      (this.thinTopBookRejectCooldownLevelByConditionId.get(conditionId) ?? 0) + 1;
    const cooldownMultiplier = Math.min(4, 2 ** Math.max(0, cooldownLevel - 1));
    const cooldownUntilMs = nowMs + cooldownMs * cooldownMultiplier;
    this.thinTopBookRejectCooldownUntilMsByConditionId.set(conditionId, cooldownUntilMs);
    this.thinTopBookRejectCountByConditionId.set(conditionId, 0);
    this.thinTopBookRejectCooldownLevelByConditionId.set(conditionId, cooldownLevel);
    return {
      count: nextCount,
      cooldownUntilMs,
      activated: true
    };
  }

  private shouldLogInventoryOnlyManagement(
    conditionId: string,
    nowMs: number = Date.now()
  ): boolean {
    const lastLoggedAt =
      this.lastInventoryOnlyManagementLogAtByConditionId.get(conditionId);
    const logIntervalMs = Math.max(
      60_000,
      config.observability.verboseMarketLogIntervalMs
    );

    if (
      typeof lastLoggedAt === "number" &&
      nowMs - lastLoggedAt < logIntervalMs
    ) {
      return false;
    }

    this.lastInventoryOnlyManagementLogAtByConditionId.set(conditionId, nowMs);
    return true;
  }

  private rememberKnownMarkets(markets: readonly BinaryMarket[]): void {
    for (const market of markets) {
      this.knownConditionToMarket.set(market.conditionId, market);
      this.knownSlugToMarket.set(market.slug, market);
    }
  }

  private resolveKnownMarket(
    conditionId: string,
    marketScope: string
  ): BinaryMarket | undefined {
    return this.knownConditionToMarket.get(conditionId) ?? this.knownSlugToMarket.get(marketScope);
  }

  private rememberManagedMarket(market: BinaryMarket): void {
    this.tokenToMarket.set(market.tokenIds[0], market);
    this.tokenToMarket.set(market.tokenIds[1], market);
    this.conditionToMarket.set(market.conditionId, market);
  }

  private replaceManagedMarketMaps(markets: readonly BinaryMarket[]): void {
    this.tokenToMarket.clear();
    this.conditionToMarket.clear();

    for (const market of markets) {
      this.rememberManagedMarket(market);
    }
  }

  private hasTrackedInventoryForMarket(market: BinaryMarket): boolean {
    return market.tokenIds.some(
      (tokenId) => this.inventoryTracker.getOpenShares(tokenId) > Number.EPSILON
    );
  }

  private collectInventoryOnlyManagedMarkets(
    selectedMarkets: readonly BinaryMarket[]
  ): BinaryMarket[] {
    const selectedConditionIds = new Set(selectedMarkets.map((market) => market.conditionId));
    const inventoryOnlyMarketsByConditionId = new Map<string, BinaryMarket>();

    for (const lot of this.inventoryTracker.exportOpenLots()) {
      if (!(lot.shares > Number.EPSILON)) {
        continue;
      }

      const market =
        this.tokenToMarket.get(lot.tokenId) ??
        (lot.conditionId ? this.knownConditionToMarket.get(lot.conditionId) : undefined) ??
        this.knownSlugToMarket.get(lot.marketScope);

      if (!market || selectedConditionIds.has(market.conditionId)) {
        continue;
      }

      if (!this.hasTrackedInventoryForMarket(market)) {
        continue;
      }

      inventoryOnlyMarketsByConditionId.set(market.conditionId, market);
    }

    return [...inventoryOnlyMarketsByConditionId.values()];
  }

  private collectActiveQuoteManagedMarkets(
    selectedMarkets: readonly BinaryMarket[],
    alreadyManagedMarkets: readonly BinaryMarket[] = []
  ): BinaryMarket[] {
    if (!this.quoteExecutor) {
      return [];
    }

    const managedConditionIds = new Set([
      ...selectedMarkets.map((market) => market.conditionId),
      ...alreadyManagedMarkets.map((market) => market.conditionId)
    ]);
    const activeQuoteOnlyMarketsByConditionId = new Map<string, BinaryMarket>();

    for (const quote of this.quoteExecutor.getActiveQuotes()) {
      if (managedConditionIds.has(quote.conditionId)) {
        continue;
      }

      const market =
        this.knownConditionToMarket.get(quote.conditionId) ??
        this.knownSlugToMarket.get(quote.marketSlug);

      if (!market) {
        continue;
      }

      activeQuoteOnlyMarketsByConditionId.set(market.conditionId, market);
      managedConditionIds.add(market.conditionId);
    }

    return [...activeQuoteOnlyMarketsByConditionId.values()];
  }

  private isInventoryOnlyManagedCondition(conditionId: string): boolean {
    if (this.selectedConditionIds.has(conditionId)) {
      return false;
    }

    const market = this.conditionToMarket.get(conditionId);
    return Boolean(market && this.hasTrackedInventoryForMarket(market));
  }

  private buildManagedSelectionSignalAssetIds(
    eligibleMarkets: readonly BinaryMarket[],
    selectedMarkets: readonly BinaryMarket[],
    inventoryOnlyMarkets: readonly BinaryMarket[]
  ): string[] {
    const assetIds = new Set(
      buildSelectionSignalSubscriptionAssetIds(eligibleMarkets, selectedMarkets)
    );

    for (const market of inventoryOnlyMarkets) {
      for (const tokenId of market.tokenIds) {
        assetIds.add(tokenId);
      }
    }

    return [...assetIds].sort();
  }

  private buildManagedUserTrackerConditionIds(
    selectedMarkets: readonly BinaryMarket[],
    inventoryOnlyMarkets: readonly BinaryMarket[]
  ): string[] {
    const conditionIds = new Set<string>();

    for (const market of selectedMarkets) {
      conditionIds.add(market.conditionId);
    }

    for (const market of inventoryOnlyMarkets) {
      conditionIds.add(market.conditionId);
    }

    return [...conditionIds].sort();
  }

  private resolveConditionIdForRiskReductionResult(result: {
    tokenId: string;
    marketSlug: string;
  }): string | undefined {
    return (
      this.tokenToMarket.get(result.tokenId)?.conditionId ??
      this.knownSlugToMarket.get(result.marketSlug)?.conditionId
    );
  }

  private pruneRiskReductionReentryCooldowns(nowMs: number = Date.now()): void {
    for (const [conditionId, cooldownUntilMs] of this.riskReductionReentryCooldownUntilMsByConditionId.entries()) {
      if (cooldownUntilMs <= nowMs + Number.EPSILON) {
        this.riskReductionReentryCooldownUntilMsByConditionId.delete(conditionId);
      }
    }
  }

  private noteRiskReductionReentryCooldown(
    conditionId: string | undefined,
    nowMs: number = Date.now()
  ): void {
    if (
      !conditionId ||
      config.marketMaker.postRiskReductionReentryCooldownMs <= 0
    ) {
      return;
    }

    this.pruneRiskReductionReentryCooldowns(nowMs);
    const cooldownUntilMs = nowMs + config.marketMaker.postRiskReductionReentryCooldownMs;
    const previousCooldownUntilMs =
      this.riskReductionReentryCooldownUntilMsByConditionId.get(conditionId) ?? 0;
    this.riskReductionReentryCooldownUntilMsByConditionId.set(
      conditionId,
      Math.max(previousCooldownUntilMs, cooldownUntilMs)
    );
  }

  private isInsideRiskReductionReentryCooldown(
    conditionId: string,
    nowMs: number = Date.now()
  ): boolean {
    this.pruneRiskReductionReentryCooldowns(nowMs);
    const cooldownUntilMs =
      this.riskReductionReentryCooldownUntilMsByConditionId.get(conditionId) ?? 0;
    return cooldownUntilMs > nowMs + Number.EPSILON;
  }

  private recordRiskReductionSummary(
    summary: Awaited<ReturnType<RiskReductionExecutor["reduceCandidates"]>>,
    reason: string
  ): void {
    let inventoryChanged = false;

    for (const result of summary.results) {
      const conditionId = this.resolveConditionIdForRiskReductionResult(result);

      if (result.status === "skipped_no_inventory") {
        const trackedShares = this.inventoryTracker.getOpenShares(result.tokenId);

        if (trackedShares > 1e-9) {
          const market = this.tokenToMarket.get(result.tokenId);
          this.logger.warn(
            {
              reason,
              market: result.marketSlug,
              tokenId: result.tokenId,
              outcome: result.outcome,
              trackedShares: Number(trackedShares.toFixed(8)),
              observedBalance: result.observedBalance,
              observedAllowance: result.observedAllowance,
              observedSellableShares: result.observedSellableShares,
              waitedMs: result.waitedMs,
              detail: result.detail
            },
            "Risk reduction found local inventory but no sellable venue inventory."
          );

          if (market) {
            void this.reconcileVenueInventoryForMarket(market, Date.now(), true);
          }
        }
      }

      if (result.status === "skipped_allowance_unavailable") {
        const trackedShares = this.inventoryTracker.getOpenShares(result.tokenId);

        if (trackedShares > 1e-9) {
          const market = this.tokenToMarket.get(result.tokenId);
          this.logger.warn(
            {
              reason,
              market: result.marketSlug,
              tokenId: result.tokenId,
              outcome: result.outcome,
              trackedShares: Number(trackedShares.toFixed(8)),
              observedBalance: result.observedBalance,
              observedAllowance: result.observedAllowance,
              observedSellableShares: result.observedSellableShares,
              waitedMs: result.waitedMs,
              detail: result.detail
            },
            "Risk reduction could not determine venue sell allowance for local inventory."
          );

          if (market) {
            void this.reconcileVenueInventoryForMarket(market, Date.now(), true);
          }
        }
      }

      if (result.status !== "reduced" || !result.reducedShares || !result.proceedsUsdc) {
        continue;
      }

      const closedAtMs = Date.now();
      const positionBeforeClose = this.inventoryTracker.getOpenPosition(result.tokenId);
      const closeResult = this.inventoryTracker.closeLots({
        tokenId: result.tokenId,
        shares: result.reducedShares,
        proceedsUsdc: result.proceedsUsdc,
        closedAtMs,
        metadata: {
          executionSource: "risk-reduction",
          marketSlug: result.marketSlug,
          outcome: result.outcome
        }
      });

      recordInventoryCloseResult({
        closeResult,
        pnlEngine: this.pnlEngine,
        riskManager: this.riskManager,
        logger: this.logger,
        closeReason: `Risk reduction sell closed inventory in ${result.marketSlug}. reason=${reason}`,
        executionSource: "risk-reduction"
      });
      const positionAfterCloseShares = this.inventoryTracker.getOpenShares(result.tokenId);
      const realizedPnlUsdc = closeResult.pieces.reduce(
        (total, piece) => total + piece.realizedPnlUsdc,
        0
      );
      const executionPriceUsdc =
        typeof result.price === "number" && Number.isFinite(result.price)
          ? result.price
          : result.proceedsUsdc / result.reducedShares;
      const exitReason = positionAfterCloseShares > 1e-9 ? "inventory_reduce" : "inventory_close";
      const alertContext = this.buildMakerFillAlertContext({
        tokenId: result.tokenId,
        side: "SELL",
        positionBeforeShares: positionBeforeClose?.shares ?? result.reducedShares,
        positionAfterShares: positionAfterCloseShares,
        averageCostUsdcPerShare:
          closeResult.closedKnownShares > 0
            ? closeResult.recognizedCostBasisUsdc / closeResult.closedKnownShares
            : undefined,
        actualPriceUsdc: executionPriceUsdc,
        realizedPnlUsdc,
        defaultReason: exitReason
      });
      void this.alertDispatcher.dispatch(
        buildOrderFillAlert({
          runtime: "market-maker",
          strategy: "market-making",
          market: result.marketSlug,
          outcome: result.outcome,
          side: "SELL",
          shares: result.reducedShares,
          price: executionPriceUsdc,
          notionalUsdc: result.proceedsUsdc,
          occurredAtMs: closedAtMs,
          ...alertContext,
          realizedPnlUsdc,
          tags: ["risk-reduction", "inventory-close"]
        })
      );
      this.lastSellFillAtByTokenId.set(result.tokenId, closedAtMs);
      if (conditionId) {
        this.lastFillAtByConditionId.set(conditionId, closedAtMs);
      }
      this.sessionMmSellFillCount += 1;
      const lastBuyAt = this.lastBuyFillAtByTokenId.get(result.tokenId);
      if (typeof lastBuyAt === "number" && lastBuyAt > 0 && lastBuyAt <= closedAtMs) {
        this.sessionMmTotalHoldMs += closedAtMs - lastBuyAt;
        this.sessionMmHoldSampleCount += 1;
      } else if (
        positionBeforeClose &&
        positionBeforeClose.openedAtMs > 0 &&
        positionBeforeClose.openedAtMs <= closedAtMs
      ) {
        this.sessionMmTotalHoldMs += closedAtMs - positionBeforeClose.openedAtMs;
        this.sessionMmHoldSampleCount += 1;
      }
      this.noteRecentConfirmedInventoryClose(
        result.tokenId,
        result.marketSlug,
        conditionId,
        result.reducedShares,
        positionAfterCloseShares,
        closedAtMs
      );
      if (positionAfterCloseShares <= 1e-9) {
        this.lastBuyFillAtByTokenId.delete(result.tokenId);
        this.agedInventoryExitLadderStateByTokenId?.delete(result.tokenId);
      }
      this.noteRiskReductionReentryCooldown(conditionId, closedAtMs);
      inventoryChanged = true;
    }

    if (inventoryChanged) {
      this.syncTrackedInventoryLots();
      this.refreshDynamicCapitalSignalFromPerformance();
      this.refreshScopedCapitalSignalsFromPerformance();
    }
  }

  private async reconcileVenueInventoryForMarket(
    market: BinaryMarket,
    nowMs: number,
    force = false
  ): Promise<void> {
    if (!this.quoteExecutor) {
      return;
    }

    const refreshCooldownMs =
      config.marketMaker.balanceRefreshMs > 0
        ? Math.min(config.marketMaker.balanceRefreshMs, 5_000)
        : 5_000;
    const lastReconciledAtMs =
      this.lastVenueInventoryReconciliationAtByConditionId.get(market.conditionId) ?? 0;

    if (!force && nowMs - lastReconciledAtMs + Number.EPSILON < refreshCooldownMs) {
      return;
    }

    this.lastVenueInventoryReconciliationAtByConditionId.set(market.conditionId, nowMs);

    let inventoryChanged = false;
    const reconciledTokens: Array<{
      tokenId: string;
      outcome: string;
      venueBalance: number;
      effectiveVenueBalance: number;
      trackedSharesBefore: number;
      trackedSharesAfter: number;
      suppressedByRecentClose?: boolean;
    }> = [];

    for (const [index, tokenId] of market.tokenIds.entries()) {
      try {
        const trackedSharesBefore = this.inventoryTracker.getOpenShares(tokenId);
        const snapshot = await this.quoteExecutor.getConditionalBalanceSnapshot(tokenId, {
          forceRefresh: true
        });
        const estimatedAverageCostUsdcPerShare = Math.max(
          this.getCurrentBestBid(tokenId, market) ?? 0.5,
          Number.EPSILON
        );
        // Treat sub-threshold balances as zero so dust positions are never tracked.
        const effectiveVenueBalance =
          snapshot.balance >= config.marketMaker.minSellShares ? snapshot.balance : 0;
        const recentCloseGuard = this.applyRecentConfirmedInventoryCloseGuard({
          tokenId,
          market,
          trackedSharesBefore,
          venueBalance: effectiveVenueBalance,
          nowMs
        });
        this.positionManager.updateTokenInventory(tokenId, {
          ...snapshot,
          balance: recentCloseGuard.venueBalance
        });
        const didChange = this.inventoryTracker.reconcileVenuePosition({
          tokenId,
          marketScope: market.slug,
          conditionId: market.conditionId,
          outcome: market.outcomes[index],
          venueBalance: recentCloseGuard.venueBalance,
          estimatedAverageCostUsdcPerShare,
          reconciledAtMs: nowMs,
          strategy: "market-making",
          metadata: {
            allowance: Number(snapshot.allowance.toFixed(8)),
            refreshedAtMs: snapshot.refreshedAtMs
          }
        });
        const trackedSharesAfter = this.inventoryTracker.getOpenShares(tokenId);

        inventoryChanged = inventoryChanged || didChange;
        reconciledTokens.push({
          tokenId,
          outcome: market.outcomes[index] ?? tokenId,
          venueBalance: Number(snapshot.balance.toFixed(8)),
          effectiveVenueBalance: Number(recentCloseGuard.venueBalance.toFixed(8)),
          trackedSharesBefore: Number(trackedSharesBefore.toFixed(8)),
          trackedSharesAfter: Number(trackedSharesAfter.toFixed(8)),
          suppressedByRecentClose: recentCloseGuard.suppressed
        });
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            market: market.slug,
            tokenId
          },
          "Venue inventory reconciliation failed for a selected market-making token."
        );
      }
    }

    const [tokenA, tokenB] = market.tokenIds;
    const sharesA = this.inventoryTracker.getOpenShares(tokenA);
    const sharesB = this.inventoryTracker.getOpenShares(tokenB);

    if (sharesA > 1e-9 && sharesB <= 1e-9) {
      this.oneSideFillRecoveryByConditionId.set(market.conditionId, {
        conditionId: market.conditionId,
        filledTokenId: tokenA,
        activatedAtMs:
          this.oneSideFillRecoveryByConditionId.get(market.conditionId)?.activatedAtMs ?? nowMs
      });
    } else if (sharesB > 1e-9 && sharesA <= 1e-9) {
      this.oneSideFillRecoveryByConditionId.set(market.conditionId, {
        conditionId: market.conditionId,
        filledTokenId: tokenB,
        activatedAtMs:
          this.oneSideFillRecoveryByConditionId.get(market.conditionId)?.activatedAtMs ?? nowMs
      });
    }

    if (!inventoryChanged) {
      return;
    }

    this.syncTrackedInventoryLots();

    this.logger.info(
      {
        market: market.slug,
        conditionId: market.conditionId,
        reconciledTokens
      },
      "Reconciled selected market-making inventory against fresh venue balances."
    );

    // Send BUY fill alert for any token whose inventory was discovered for the first time via
    // venue-sync (i.e., it was not previously tracked by the bot's WS fill handler).
    for (const token of reconciledTokens) {
      if (token.trackedSharesBefore < 1e-9 && token.trackedSharesAfter > 1e-9) {
        const estimatedPrice = this.getCurrentBestBid(token.tokenId, market) ?? 0.5;
        const notionalUsdc = token.trackedSharesAfter * estimatedPrice;
        void this.alertDispatcher.dispatch(
          buildOrderFillAlert({
            runtime: "market-maker",
            strategy: "market-making",
            market: market.slug,
            outcome: token.outcome,
            side: "BUY",
            shares: token.trackedSharesAfter,
            price: estimatedPrice,
            notionalUsdc,
            occurredAtMs: nowMs,
            positionBeforeShares: token.trackedSharesBefore,
            positionAfterShares: token.trackedSharesAfter,
            averageCostUsdcPerShare: estimatedPrice,
            tags: ["venue-sync"]
          })
        );
      }
    }
  }

  private applyRecentConfirmedInventoryCloseGuard(params: {
    tokenId: string;
    market: BinaryMarket;
    trackedSharesBefore: number;
    venueBalance: number;
    nowMs: number;
  }): {
    venueBalance: number;
    suppressed: boolean;
  } {
    this.pruneRecentConfirmedInventoryCloseGuards(params.nowMs);
    const guard = this.recentConfirmedInventoryCloseGuardsByTokenId.get(params.tokenId);

    if (!guard || guard.marketSlug !== params.market.slug) {
      return {
        venueBalance: params.venueBalance,
        suppressed: false
      };
    }

    const trustedTrackedSharesFloor = Math.max(
      0,
      params.trackedSharesBefore,
      guard.remainingSharesAfterClose
    );
    const resurrectionDelta = Math.max(0, params.venueBalance - trustedTrackedSharesFloor);
    const maxSuppressedResurrectionShares =
      guard.closedShares + config.marketMaker.minSellShares;

    if (
      params.venueBalance > trustedTrackedSharesFloor + Number.EPSILON &&
      resurrectionDelta <= maxSuppressedResurrectionShares + Number.EPSILON
    ) {
      this.logger.debug(
        {
          market: params.market.slug,
          tokenId: params.tokenId,
          trackedSharesBefore: params.trackedSharesBefore,
          venueBalance: params.venueBalance,
          trustedTrackedSharesFloor,
          resurrectionDelta,
          guardClosedShares: guard.closedShares,
          guardRemainingSharesAfterClose: guard.remainingSharesAfterClose,
          guardAgeMs: params.nowMs - guard.closedAtMs
        },
        "Suppressed venue inventory resurrection immediately after a confirmed SELL close."
      );
      return {
        venueBalance: trustedTrackedSharesFloor,
        suppressed: true
      };
    }

    return {
      venueBalance: params.venueBalance,
      suppressed: false
    };
  }

  private getTrustedTrackedOpenSharesForSellPlanning(
    market: BinaryMarket,
    tokenId: string,
    nowMs: number = Date.now()
  ): number {
    this.pruneRecentConfirmedInventoryCloseGuards(nowMs);
    const trackedShares = this.inventoryTracker.getOpenShares(tokenId);
    const guard = this.recentConfirmedInventoryCloseGuardsByTokenId.get(tokenId);

    if (!guard || guard.marketSlug !== market.slug) {
      return trackedShares;
    }

    const trustedTrackedShares = Math.max(
      0,
      Math.min(trackedShares, guard.remainingSharesAfterClose)
    );

    if (trustedTrackedShares + Number.EPSILON < trackedShares) {
      this.logger.debug(
        {
          market: market.slug,
          tokenId,
          trackedShares,
          trustedTrackedShares,
          guardRemainingSharesAfterClose: guard.remainingSharesAfterClose,
          guardAgeMs: nowMs - guard.closedAtMs
        },
        "Clamped tracked SELL-planning shares immediately after a confirmed inventory close."
      );
    }

    return trustedTrackedShares;
  }

  private pruneRecentConfirmedInventoryCloseGuards(nowMs: number = Date.now()): void {
    for (const [tokenId, guard] of this.recentConfirmedInventoryCloseGuardsByTokenId.entries()) {
      if (nowMs - guard.closedAtMs > RECENT_CONFIRMED_CLOSE_GUARD_MS) {
        this.recentConfirmedInventoryCloseGuardsByTokenId.delete(tokenId);
      }
    }
  }

  private noteRecentConfirmedInventoryClose(
    tokenId: string,
    marketSlug: string,
    conditionId: string | undefined,
    closedShares: number,
    remainingSharesAfterClose: number,
    closedAtMs: number
  ): void {
    if (!(closedShares > 0)) {
      return;
    }

    this.pruneRecentConfirmedInventoryCloseGuards(closedAtMs);
    const existingGuard = this.recentConfirmedInventoryCloseGuardsByTokenId.get(tokenId);
    this.recentConfirmedInventoryCloseGuardsByTokenId.set(tokenId, {
      tokenId,
      marketSlug,
      conditionId,
      closedAtMs,
      closedShares:
        existingGuard?.marketSlug === marketSlug
          ? existingGuard.closedShares + closedShares
          : closedShares,
      remainingSharesAfterClose
    });
  }

  private clearRecentConfirmedInventoryCloseGuard(tokenId: string): void {
    this.recentConfirmedInventoryCloseGuardsByTokenId.delete(tokenId);
  }

  private syncTrackedInventoryLots(): void {
    this.positionManager.syncTrackedInventoryLots(this.inventoryTracker.exportOpenLots());
  }

  private refreshDynamicCapitalSignalFromPerformance(): void {
    const performanceSignal = buildStrategyPerformanceCapitalSignal([
      this.pnlEngine.getStrategySnapshot("market-making"),
      this.pnlEngine.getStrategySnapshot("liquidity-rewards"),
      this.pnlEngine.getStrategySnapshot("maker-rebates")
    ]);
    const blendedSignalScore = blendCapitalSignalScores(
      this.latestSelectionCapitalSignalScore,
      performanceSignal.score
    );

    this.positionManager.setStrategyCapitalSignal("market-making", blendedSignalScore);
  }

  private refreshScopedCapitalSignalsFromPerformance(): void {
    const selectionSignals = buildMarketScopedCapitalSignals(this.latestSelectedEntries);
    const conditionToEventId = new Map<string, string>();
    const conditionToCategory = new Map<string, string>();

    for (const entry of this.latestSelectedEntries) {
      if (entry.market.eventId) {
        conditionToEventId.set(entry.market.conditionId, entry.market.eventId);
      }

      const normalizedCategory = entry.market.category?.trim().toLowerCase();

      if (normalizedCategory) {
        conditionToCategory.set(entry.market.conditionId, normalizedCategory);
      }
    }

    const performanceSignals = buildScopedPerformanceCapitalSignals({
      trades: this.pnlEngine.exportTrades(),
      relevantStrategies: ["market-making", "liquidity-rewards", "maker-rebates"],
      conditionToEventId,
      conditionToCategory
    });
    const blendedSignals = blendScopedCapitalSignals(selectionSignals, performanceSignals);

    this.positionManager.setConditionCapitalSignals(
      blendedSignals.byConditionId,
      "market-maker"
    );
    this.positionManager.setEventCapitalSignals(blendedSignals.byEventId, "market-maker");
    this.positionManager.setCategoryCapitalSignals(
      blendedSignals.byCategory,
      "market-maker"
    );
  }

  /**
   * Auto-deactivate markets with no fill activity for `deadMarketDeactivationMs`,
   * and auto-re-enable markets that were auto-disabled long enough ago to retry.
   * Manual disables (set without `autoDisabledAtByConditionId` entry) are never
   * touched — operator intent always wins.
   */
  private checkDeadMarkets(): void {
    const deactivationMs = config.marketMaker.deadMarketDeactivationMs;
    const reactivationMs = config.marketMaker.deadMarketReactivationMs;
    if (deactivationMs <= 0) return;
    const now = Date.now();

    for (const [conditionId, lastActivityMs] of this.lastFillAtByConditionId) {
      if (this.operatorControl.isMarketDisabled(conditionId)) continue;
      if (now - lastActivityMs <= deactivationMs) continue;
      this.operatorControl.disableMarket(conditionId);
      this.autoDisabledAtByConditionId.set(conditionId, now);
      this.logger.warn(
        { conditionId, idleMs: now - lastActivityMs, deactivationMs },
        "Auto-disabled dead market — no fills within deactivation window."
      );
    }

    let reenabledCount = 0;
    if (reactivationMs > 0) {
      for (const [conditionId, disabledAtMs] of this.autoDisabledAtByConditionId) {
        if (now - disabledAtMs <= reactivationMs) continue;
        this.operatorControl.enableMarket(conditionId);
        this.autoDisabledAtByConditionId.delete(conditionId);
        // Reset activity so the next dead-check has a full grace window.
        this.lastFillAtByConditionId.set(conditionId, now);
        reenabledCount += 1;
        this.logger.info(
          { conditionId, downtimeMs: now - disabledAtMs },
          "Auto-re-enabled previously dead market — eligibility retry."
        );
      }
    }

    if (reenabledCount > 0 && !this.stopping) {
      void this.refreshUniverse().catch((error) => {
        this.logger.warn(
          { err: error, reenabledCount },
          "Failed to refresh market-making universe after dead-market reactivation."
        );
      });
    }
  }

  /**
   * 🔔 SELL coverage watchdog — detects when a tracked position has no active
   * SELL quote at the venue. This violates the operator's #7 rule "매수 체결
   * 후 반드시 매도 호가 유지". On detection we log a warning with the reason
   * (cooldown / hard-gate / floor-blocked / other) and queue an immediate
   * re-evaluation so the next quote cycle can heal the gap.
   *
   * ⚠️ False-positive mitigation: Polymarket SELL orders sometimes close via a
   * sequence of partial user-ws fills without an explicit terminal flag, which
   * causes our `activeQuotes` map to lag reality. We add a 30-second "recently
   * resolved" grace period: if a SELL on this tokenId resolved within the last
   * 30s, treat that as coverage existing (even if map is empty) and skip the
   * gap alert. Prevents the ~200 watchdog warnings observed per session that
   * were actually artifacts of the terminal-flag race.
   */
  private async checkPassiveBuyAgeWatchdog(): Promise<void> {
    if (!this.quoteExecutor || this.stopping) {
      return;
    }

    const cancelledQuotes = await this.quoteExecutor.cancelExpiredPassiveBuyQuotes(Date.now());

    if (cancelledQuotes.length === 0) {
      return;
    }

    this.syncExecutionEngineWithActiveQuotes();

    for (const conditionId of new Set(cancelledQuotes.map((quote) => quote.conditionId))) {
      this.requestImmediateConditionReevaluation(conditionId);
    }
  }

  private async checkSellCoverage(): Promise<void> {
    if (!this.quoteExecutor) return;
    const riskState = this.getCurrentRiskState();
    if (riskState !== "HALTED") {
      this.haltedSellCoverageCleanupAttemptedConditionIds?.clear();
    }

    const openPositions = this.inventoryTracker.exportOpenLots();
    const positionTokens = new Map<string, { shares: number; conditionId?: string }>();
    for (const lot of openPositions) {
      const existing = positionTokens.get(lot.tokenId);
      if (existing) {
        existing.shares += lot.shares;
      } else {
        positionTokens.set(lot.tokenId, {
          shares: lot.shares,
          conditionId: lot.conditionId
        });
      }
    }

    if (positionTokens.size === 0) {
      this.consecutiveSellCoverageWatchdogGapsByConditionId.clear();
      this.sellCoverageEscalationCooldownUntilMsByConditionId.clear();
      this.haltedSellCoverageCleanupAttemptedConditionIds?.clear();
      return;
    }

    const activeQuotes = this.quoteExecutor.getActiveQuotes?.() ?? [];
    const activeSellByToken = new Set<string>();
    for (const quote of activeQuotes) {
      if (quote.side === Side.SELL) activeSellByToken.add(quote.tokenId);
    }
    // 🛡️ False-positive guard: treat a very recent SELL fill as coverage.
    // If lastSellFillAt on this token is within 30s, the SELL order is either
    // actively resolving or was just filled — no stuck state.
    const recentSellFillWindowMs = 30_000;
    const nowForGrace = Date.now();
    const recentlySoldTokens = new Set<string>();
    for (const [tokenId] of positionTokens) {
      const lastSellAt = this.lastSellFillAtByTokenId.get(tokenId);
      if (lastSellAt && nowForGrace - lastSellAt < recentSellFillWindowMs) {
        recentlySoldTokens.add(tokenId);
      }
    }

    const nowMs = Date.now();
    const watchedConditionIds = new Set<string>();
    const gapConditionIds = new Set<string>();
    const gaps: Array<{ tokenId: string; shares: number; conditionId?: string; reasons: string[] }> = [];
    for (const [tokenId, info] of positionTokens) {
      if (info.conditionId) {
        watchedConditionIds.add(info.conditionId);
      }
      if (info.shares <= Number.EPSILON) continue;
      if (activeSellByToken.has(tokenId)) continue;
      if (recentlySoldTokens.has(tokenId)) continue;  // within 30s grace window

      const market = info.conditionId
        ? this.conditionToMarket.get(info.conditionId) ??
          this.knownConditionToMarket.get(info.conditionId)
        : this.tokenToMarket.get(tokenId);
      const book = this.orderBookStore.get(tokenId);
      const minimumSellShares = Math.max(
        market?.orderMinSize ?? 0,
        book?.minOrderSize ?? 0,
        config.marketMaker.minSellShares,
        1
      );
      if (info.shares + Number.EPSILON < minimumSellShares) {
        const lastLoggedAt = this.lastSellCoverageDustLogAtByTokenId?.get(tokenId) ?? 0;
        if (nowMs - lastLoggedAt >= SELL_COVERAGE_DUST_LOG_INTERVAL_MS) {
          this.lastSellCoverageDustLogAtByTokenId?.set(tokenId, nowMs);
          this.logger.info(
            {
              tokenId,
              conditionId: info.conditionId,
              shares: info.shares,
              minimumSellShares
            },
            "SELL coverage watchdog ignored below-minimum dust inventory."
          );
        }
        continue;
      }

      const reasons: string[] = [];
      if (this.isSellTemporarilySuppressed(tokenId)) reasons.push("temporarily_suppressed");
      const bestBid = book?.bids?.[0]?.price;
      const tickSize = book?.tickSize ?? 0.01;
      if (typeof bestBid === "number" && Number.isFinite(bestBid)) {
        const position = this.inventoryTracker.getOpenPosition(tokenId);
        if (position && position.shares > Number.EPSILON) {
          const floor = resolveMinimumExitPriceForPosition(position, tickSize);
          if (
            typeof floor === "number" &&
            bestBid + tickSize + Number.EPSILON < floor
          ) {
            reasons.push("blocked_by_profit_floor");
          }
        }
      }
      if (reasons.length === 0) reasons.push("unknown");

      gaps.push({
        tokenId,
        shares: info.shares,
        conditionId: info.conditionId,
        reasons
      });

      if (info.conditionId) {
        gapConditionIds.add(info.conditionId);
        this.requestImmediateConditionReevaluation(info.conditionId);
      }
    }

    this.updateSellCoverageEscalationState(watchedConditionIds, gapConditionIds);

    if (gaps.length > 0) {
      this.logger.warn(
        { gapCount: gaps.length, gaps },
        "SELL coverage watchdog: inventory without active SELL quote — queued immediate re-evaluation."
      );
    }

    const forcedConditions = this.buildSellCoverageForcedReductionConditions(
      gaps,
      gapConditionIds,
      nowMs,
      riskState
    );

    for (const forcedCondition of forcedConditions) {
      await this.triggerSellCoverageForcedReduction(forcedCondition);
    }
  }

  private getCurrentRiskState(): RiskState {
    return (
      this.riskManager?.getState?.() ??
      this.riskManager?.getSnapshot?.().state ??
      "RUNNING"
    );
  }

  private updateSellCoverageEscalationState(
    watchedConditionIds: ReadonlySet<string>,
    gapConditionIds: ReadonlySet<string>
  ): void {
    for (const conditionId of watchedConditionIds) {
      if (gapConditionIds.has(conditionId)) {
        const nextGapCount =
          (this.consecutiveSellCoverageWatchdogGapsByConditionId.get(conditionId) ?? 0) + 1;
        this.consecutiveSellCoverageWatchdogGapsByConditionId.set(conditionId, nextGapCount);
        continue;
      }

      this.consecutiveSellCoverageWatchdogGapsByConditionId.delete(conditionId);
      this.sellCoverageEscalationCooldownUntilMsByConditionId.delete(conditionId);
    }

    for (const conditionId of [...this.consecutiveSellCoverageWatchdogGapsByConditionId.keys()]) {
      if (!watchedConditionIds.has(conditionId)) {
        this.consecutiveSellCoverageWatchdogGapsByConditionId.delete(conditionId);
        this.sellCoverageEscalationCooldownUntilMsByConditionId.delete(conditionId);
      }
    }
  }

  private buildSellCoverageForcedReductionConditions(
    gaps: ReadonlyArray<{
      tokenId: string;
      shares: number;
      conditionId?: string;
      reasons: string[];
    }>,
    gapConditionIds: ReadonlySet<string>,
    nowMs: number,
    riskState: RiskState = this.getCurrentRiskState()
  ): Array<{
    market: BinaryMarket;
    conditionId: string;
    consecutiveGapCount: number;
    gaps: Array<{
      tokenId: string;
      shares: number;
      reasons: string[];
    }>;
    candidates: RiskReductionCandidate[];
  }> {
    if (
      !this.riskReductionExecutor ||
      !this.quoteExecutor ||
      config.marketMaker.sellCoverageForceExitAfterGapCount <= 0 ||
      config.marketMaker.sellCoverageForceExitMaxReductionShares <= 0
    ) {
      return [];
    }

    const gapsByConditionId = new Map<
      string,
      Array<{
        tokenId: string;
        shares: number;
        reasons: string[];
      }>
    >();

    for (const gap of gaps) {
      if (!gap.conditionId) {
        continue;
      }

      const conditionGaps = gapsByConditionId.get(gap.conditionId) ?? [];
      conditionGaps.push({
        tokenId: gap.tokenId,
        shares: gap.shares,
        reasons: gap.reasons
      });
      gapsByConditionId.set(gap.conditionId, conditionGaps);
    }

    const forcedConditions: Array<{
      market: BinaryMarket;
      conditionId: string;
      consecutiveGapCount: number;
      gaps: Array<{
        tokenId: string;
        shares: number;
        reasons: string[];
      }>;
      candidates: RiskReductionCandidate[];
    }> = [];

    for (const conditionId of gapConditionIds) {
      const consecutiveGapCount =
        this.consecutiveSellCoverageWatchdogGapsByConditionId.get(conditionId) ?? 0;
      if (consecutiveGapCount < config.marketMaker.sellCoverageForceExitAfterGapCount) {
        continue;
      }

      if (
        riskState === "HALTED" &&
        this.haltedSellCoverageCleanupAttemptedConditionIds?.has(conditionId)
      ) {
        continue;
      }

      const cooldownUntilMs =
        this.sellCoverageEscalationCooldownUntilMsByConditionId.get(conditionId) ?? 0;
      if (cooldownUntilMs > nowMs + Number.EPSILON) {
        continue;
      }

      const market =
        this.conditionToMarket.get(conditionId) ?? this.knownConditionToMarket.get(conditionId);
      if (!market) {
        continue;
      }

      const conditionGaps = gapsByConditionId.get(conditionId) ?? [];
      const gapTokenIds = new Set(conditionGaps.map((gap) => gap.tokenId));
      if (gapTokenIds.size === 0) {
        continue;
      }

      const baseCandidates = buildRiskReductionCandidatesFromMarkets([market]).filter((candidate) =>
        gapTokenIds.has(candidate.tokenId)
      );
      const candidates = baseCandidates
        .map((candidate) => {
          const position = this.inventoryTracker.getOpenPosition(candidate.tokenId);
          if (!position || position.shares <= Number.EPSILON) {
            return undefined;
          }

          const forcedCandidate: RiskReductionCandidate = {
            ...candidate,
            maxReductionShares: this.resolveDustSafeReductionShares(
              position.shares,
              config.marketMaker.sellCoverageForceExitMaxReductionShares,
              Math.max(market.orderMinSize, config.marketMaker.minSellShares, 1)
            )
          };

          if (!(forcedCandidate.maxReductionShares && forcedCandidate.maxReductionShares > 0)) {
            return undefined;
          }

          forcedCandidate.minSellPrice =
            this.resolveSellCoverageForcedReductionMinSellPrice(
              market,
              candidate.tokenId,
              forcedCandidate.maxReductionShares
            );

          return forcedCandidate;
        })
        .filter((candidate): candidate is RiskReductionCandidate => candidate !== undefined);

      if (candidates.length === 0) {
        continue;
      }

      forcedConditions.push({
        market,
        conditionId,
        consecutiveGapCount,
        gaps: conditionGaps,
        candidates
      });
    }

    return forcedConditions;
  }

  private async triggerSellCoverageForcedReduction(params: {
    market: BinaryMarket;
    conditionId: string;
    consecutiveGapCount: number;
    gaps: Array<{
      tokenId: string;
      shares: number;
      reasons: string[];
    }>;
    candidates: RiskReductionCandidate[];
  }): Promise<void> {
    if (!this.quoteExecutor || !this.riskReductionExecutor) {
      return;
    }

    const nowMs = Date.now();
    if (this.getCurrentRiskState() === "HALTED") {
      this.haltedSellCoverageCleanupAttemptedConditionIds?.add(params.conditionId);
    }

    this.sellCoverageEscalationCooldownUntilMsByConditionId.set(
      params.conditionId,
      nowMs + config.marketMaker.sellCoverageForceExitCooldownMs
    );

    this.logger.warn(
      {
        market: params.market.slug,
        conditionId: params.conditionId,
        consecutiveGapCount: params.consecutiveGapCount,
        cooldownMs: config.marketMaker.sellCoverageForceExitCooldownMs,
        gaps: params.gaps,
        candidates: params.candidates.map((candidate) => ({
          tokenId: candidate.tokenId,
          outcome: candidate.outcome,
          maxReductionShares: candidate.maxReductionShares,
          minSellPrice: candidate.minSellPrice
        }))
      },
      "SELL coverage watchdog escalated into a forced partial risk-reduction SELL."
    );

    await this.quoteExecutor.cancelMarketQuotes(params.conditionId);
    this.syncExecutionEngineWithActiveQuotes();
    await this.reduceInventoryRiskCandidates(params.candidates, "sell coverage forced escalation");
    this.requestImmediateConditionReevaluation(params.conditionId);
  }

  private async refreshUniverse(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.logger.info(
      {
        scanCap: config.marketUniverse.scanCap,
        pageSize: config.marketUniverse.pageSize,
        maxMarkets: config.marketUniverse.maxMarkets
      },
      "Refreshing market-making universe."
    );

    const previousConditionIds = new Set(this.selectedConditionIds);
    const traceStartedAt = Date.now();
    this.logger.info({ stage: "fetch_gamma" }, "[refreshUniverse] starting gamma fetch.");
    const { markets, diagnostics } = await fetchBinaryMarketsWithDiagnostics();
    this.logger.info(
      { stage: "fetch_gamma_done", elapsedMs: Date.now() - traceStartedAt, markets: markets.length },
      "[refreshUniverse] gamma fetch done."
    );
    const rewardStartedAt = Date.now();
    const hydratedMarkets = await this.attachRewardMetadata(markets);
    this.logger.info(
      { stage: "fetch_rewards_done", elapsedMs: Date.now() - rewardStartedAt },
      "[refreshUniverse] reward metadata done."
    );
    this.rememberKnownMarkets(hydratedMarkets);
    const signalsByConditionId = buildMarketSelectionSignals(
      hydratedMarkets,
      this.orderBookStore.get.bind(this.orderBookStore),
      this.orderBookStore.getSelectionTelemetry.bind(this.orderBookStore),
      this.displacementTracker.getDisplacementRate.bind(this.displacementTracker)
    );
    if (this.stopping) {
      return;
    }

    const eligibleMarkets = filterMarketsForSelectionEligibility(hydratedMarkets, {
      signalsByConditionId,
      profile: "market-making"
    });
    this.pruneThinTopBookRejectCooldowns();
    const selectionCandidateMarkets = eligibleMarkets.filter(
      (market) => !this.isInsideThinTopBookRejectCooldown(market.conditionId)
    );
    // Selection signal 강제 항상 안 함. ALLOWED_SLUGS 모드 + Fill 모드 둘 다 적용.
    // Signal 없는 시장은 quote 게시 단계에서 자연스럽게 book data 부재로 차단됨.
    // 이 게이트가 cycle 2 부터 missing_live_execution_signal 로 모두 reject 시키는
    // 진짜 원인이었음. 이전 fix 가 ALLOWED_SLUGS 모드에만 적용되어 fill 모드에서 재발.
    const requireLiveExecutionSignals = false;
    const selection = rankMarketsForSelection(selectionCandidateMarkets, {
      profile: "market-making",
      maxMarkets: config.marketUniverse.maxMarkets,
      topLogCount: config.marketUniverse.selectionLogTopN,
      signalsByConditionId,
      preferredConditionIds: previousConditionIds,
      requireLiveExecutionSignals
    });
    const diversifiedRankedMarkets = this.diversifyRankedMarketSelections(
      selection.rankedMarkets,
      config.marketUniverse.maxMarkets
    );
    const cooldown = this.selectionCooldown.apply(
      diversifiedRankedMarkets.map((entry) => ({
        id: entry.market.conditionId,
        score: entry.breakdown.total,
        value: entry.market
      })),
      {
        currentSelectedIds: previousConditionIds,
        maxSelectedWeight: config.marketUniverse.maxMarkets,
        minHoldMs: config.marketUniverse.selectionMinHoldMs,
        reentryCooldownMs: config.marketUniverse.selectionReentryCooldownMs
      }
    );
    const selectedMarkets = cooldown.selected;
    const startupWatchOnlyConditionIds = new Set(
      selection.diagnostics.usedMandatoryFallback && signalsByConditionId.size === 0
        ? selectedMarkets.map((market) => market.conditionId)
        : []
    );
    const nextConditionIds = new Set(selectedMarkets.map((market) => market.conditionId));
    const inventoryOnlyManagedMarkets = this.collectInventoryOnlyManagedMarkets(selectedMarkets);
    const activeQuoteManagedMarkets = this.collectActiveQuoteManagedMarkets(
      selectedMarkets,
      inventoryOnlyManagedMarkets
    );
    const managedMarkets = [
      ...selectedMarkets,
      ...inventoryOnlyManagedMarkets,
      ...activeQuoteManagedMarkets
    ];
    const nonSelectedManagedMarkets = [
      ...inventoryOnlyManagedMarkets,
      ...activeQuoteManagedMarkets
    ];
    const selectedEntries = diversifiedRankedMarkets.filter((entry) =>
      nextConditionIds.has(entry.market.conditionId)
    );
    this.latestSelectedEntries = selectedEntries;
    const capitalSignal = buildMarketMakingCapitalSignal(selectedEntries);
    this.latestSelectionCapitalSignalScore = capitalSignal.score;
    const scopedCapitalSignals = buildMarketScopedCapitalSignals(selectedEntries);
    const retainedCount = cooldown.retainedIds.length;
    const newConditionIds = cooldown.newIds;
    const droppedConditionIds = cooldown.droppedIds;

    this.selectedConditionIds.clear();
    this.watchOnlyConditionIds.clear();
    for (const market of selectedMarkets) {
      this.selectedConditionIds.add(market.conditionId);
      if (startupWatchOnlyConditionIds.has(market.conditionId)) {
        this.watchOnlyConditionIds.add(market.conditionId);
      }
    }

    this.replaceManagedMarketMaps(managedMarkets);

    this.quoteExecutor?.setMarketUniverse(managedMarkets);
    this.positionManager.setMarketUniverse(selectedMarkets, "market-maker-selected");
    this.positionManager.setMarketUniverse(
      nonSelectedManagedMarkets,
      "market-maker-inventory"
    );
    this.refreshDynamicCapitalSignalFromPerformance();
    this.refreshScopedCapitalSignalsFromPerformance();

    const executionAssetIds = [...this.tokenToMarket.keys()];
    const selectionSignalAssetIds = this.buildManagedSelectionSignalAssetIds(
      eligibleMarkets,
      selectedMarkets,
      nonSelectedManagedMarkets
    );
    this.logger.info(
      { stage: "ws_subscribe", assets: selectionSignalAssetIds.length },
      "[refreshUniverse] subscribing market-ws."
    );
    this.marketWs.replaceSubscriptions(selectionSignalAssetIds);

    if (config.mode === "live" && this.userTracker) {
      const managedUserTrackerConditionIds = this.buildManagedUserTrackerConditionIds(
        selectedMarkets,
        nonSelectedManagedMarkets
      );
      this.logger.info(
        { stage: "user_ws_connect", conditions: managedUserTrackerConditionIds.length },
        "[refreshUniverse] connecting user-ws."
      );
      if (managedUserTrackerConditionIds.length > 0) {
        this.userTracker.connect(managedUserTrackerConditionIds, "market_universe_refresh");
      } else {
        this.userTracker.close();
      }
    }

    if (this.quoteExecutor) {
      this.logger.info(
        { stage: "cancel_dropped", dropped: droppedConditionIds.length },
        "[refreshUniverse] cancelling dropped quotes."
      );
      for (const conditionId of droppedConditionIds) {
        await this.quoteExecutor.cancelMarketQuotes(conditionId);
      }

      this.syncExecutionEngineWithActiveQuotes();
    }

    this.maybeScheduleSelectionWarmupRefresh();

    this.logger.info({ stage: "max_hold_sweep" }, "[refreshUniverse] starting max-hold sweep.");
    await this.executeScheduledMaxHoldHardExitSweep(nextConditionIds);
    this.logger.info({ stage: "max_hold_sweep_done" }, "[refreshUniverse] max-hold sweep done.");

    for (const market of inventoryOnlyManagedMarkets) {
      this.pendingImmediateReevaluationConditionIds.add(market.conditionId);
      queueMicrotask(() => {
        void this.handleTokenUpdate(market.tokenIds[0]);
      });
    }

    this.logger.info(
      {
        strategyMode: config.strategyMode,
        candidateMarkets: hydratedMarkets.length,
        eligibleMarkets: eligibleMarkets.length,
        thinTopBookCooldownBlockedMarkets:
          eligibleMarkets.length - selectionCandidateMarkets.length,
        thinTopBookCooldownsActive:
          this.thinTopBookRejectCooldownUntilMsByConditionId.size,
        markets: selectedMarkets.length,
        watchOnlyMarkets: this.watchOnlyConditionIds.size,
        managedInventoryOnlyMarkets: inventoryOnlyManagedMarkets.length,
        managedActiveQuoteOnlyMarkets: activeQuoteManagedMarkets.length,
        managedMarkets: managedMarkets.length,
        retainedMarkets: retainedCount,
        newMarkets: newConditionIds.length,
        droppedMarkets: droppedConditionIds.length,
        forcedHeldMarkets: cooldown.forcedHoldIds.length,
        blockedReentries: cooldown.blockedReentryIds.length,
        capitalSignal,
        scopedCapitalSignalCounts: {
          conditions: scopedCapitalSignals.byConditionId.size,
          events: scopedCapitalSignals.byEventId.size,
          categories: scopedCapitalSignals.byCategory.size
        },
        marketsWithSelectionSignals: signalsByConditionId.size,
        assets: selectionSignalAssetIds.length,
        executionAssets: executionAssetIds.length,
        selectionSignalMarkets: eligibleMarkets.length,
        rewardEnabledMarkets: selectedMarkets.filter(
          (market) => (market.rewardRatePerDay ?? 0) > 0
        ).length,
        categories: [...new Set(selectedMarkets.map((market) => market.category).filter(Boolean))],
        diversifiedTopSelections: diversifiedRankedMarkets
          .slice(0, config.marketUniverse.selectionLogTopN)
          .map((entry) => ({
            slug: entry.market.slug,
            category: entry.market.category,
            event: entry.market.eventSlug ?? entry.market.eventId,
            score: entry.breakdown.total
          })),
        universeFetch: diagnostics,
        marketSelection: selection.diagnostics
      },
      "Market-making universe refreshed."
    );
  }

  private diversifyRankedMarketSelections(
    entries: readonly RankedMarketSelection[],
    maxMarkets: number
  ): RankedMarketSelection[] {
    if (entries.length <= 1 || maxMarkets <= 1) {
      return [...entries];
    }

    const firstPerEvent: RankedMarketSelection[] = [];
    const repeatedEventEntries: RankedMarketSelection[] = [];
    const seenEventKeys = new Set<string>();

    for (const entry of entries) {
      const eventKey = this.resolveMarketDiversityEventKey(entry.market);
      if (seenEventKeys.has(eventKey)) {
        repeatedEventEntries.push(entry);
        continue;
      }

      seenEventKeys.add(eventKey);
      firstPerEvent.push(entry);
    }

    return [
      ...this.roundRobinRankedSelectionsByCategory(firstPerEvent),
      ...this.roundRobinRankedSelectionsByCategory(repeatedEventEntries)
    ];
  }

  private resolveMarketDiversityEventKey(market: BinaryMarket): string {
    return (
      market.eventId ??
      market.eventSlug ??
      market.groupItemTitle ??
      market.slug ??
      market.conditionId
    ).toLowerCase();
  }

  private roundRobinRankedSelectionsByCategory(
    entries: readonly RankedMarketSelection[]
  ): RankedMarketSelection[] {
    const categoryOrder: string[] = [];
    const byCategory = new Map<string, RankedMarketSelection[]>();

    for (const entry of entries) {
      const categoryKey = (entry.market.category ?? "uncategorized").trim().toLowerCase();
      if (!byCategory.has(categoryKey)) {
        byCategory.set(categoryKey, []);
        categoryOrder.push(categoryKey);
      }
      byCategory.get(categoryKey)?.push(entry);
    }

    const diversified: RankedMarketSelection[] = [];
    let added = true;

    while (added) {
      added = false;

      for (const categoryKey of categoryOrder) {
        const bucket = byCategory.get(categoryKey);
        const next = bucket?.shift();
        if (!next) {
          continue;
        }

        diversified.push(next);
        added = true;
      }
    }

    return diversified;
  }

  private maybeScheduleSelectionWarmupRefresh(): void {
    if (
      this.stopping ||
      this.watchOnlyConditionIds.size === 0 ||
      this.selectionWarmupRefreshTimer
    ) {
      return;
    }

    const delayMs = Math.max(30_000, Math.min(120_000, Math.floor(config.marketUniverse.refreshMs / 5)));
    this.selectionWarmupRefreshTimer = setTimeout(() => {
      this.selectionWarmupRefreshTimer = undefined;
      if (this.stopping) {
        return;
      }

      void this.refreshUniverse().catch((error) => {
        this.riskManager.noteApiError?.(
          "market-making.selection-warmup-refresh",
          error instanceof Error ? error.message : String(error)
        );
        this.logger.warn({ err: error }, "Market-making warmup universe refresh failed.");
      });
    }, delayMs);

    this.logger.info(
      {
        delayMs,
        watchOnlyMarkets: this.watchOnlyConditionIds.size
      },
      "Scheduled warmup market-selection refresh for startup watch-only markets."
    );
  }

  private async attachRewardMetadata(markets: readonly BinaryMarket[]): Promise<BinaryMarket[]> {
    // V2 cutover 후 getCurrentRewards() 가 운영 환경에서 일관되게 timeout 됨.
    // gamma 응답이 이미 rewardsMaxSpread/rewardsMinSize/makerBaseFee 를 포함하므로
    // 이 호출은 운영 안정성 위해 default 로 skip. config 로 다시 켤 수 있음.
    if (config.marketMaker.disableRewardMetadataFetch) {
      return [...markets];
    }
    // Kick off (or join) a background fetch so universe refresh is never blocked
    // beyond a short bound waiting on the reward endpoint, which can take 60s+
    // on V2. The background promise updates the cache when it eventually
    // completes — subsequent universe cycles benefit from the fresh data even
    // if this cycle had to fall back.
    if (!this.rewardFetchInFlight) {
      this.rewardFetchInFlight = (async () => {
        try {
          const rewards = (await Promise.race([
            this.readonlyClient.getCurrentRewards(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("getCurrentRewards timed out after 180s")),
                180_000
              )
            )
          ])) as MarketReward[];
          this.cachedRewards = rewards;
          this.cachedRewardsAtMs = Date.now();
        } catch (error) {
          this.logger.warn(
            { err: error },
            "Background reward metadata fetch failed; cache unchanged."
          );
        } finally {
          this.rewardFetchInFlight = undefined;
        }
      })();
    }

    // Wait at most 8 seconds on the background fetch this cycle. If it does
    // not finish in time, fall back to the cached rewards (or empty) and let
    // subsequent cycles use whatever the background fetch eventually returns.
    const waitForFreshFetch = new Promise<"fresh" | "timeout">((resolve) => {
      let settled = false;
      this.rewardFetchInFlight?.finally(() => {
        if (!settled) {
          settled = true;
          resolve("fresh");
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve("timeout");
        }
      }, 8000);
    });

    const outcome = await waitForFreshFetch;
    const cacheAgeMs = Date.now() - this.cachedRewardsAtMs;

    if (outcome === "fresh" && this.cachedRewards) {
      return mergeMarketsWithRewards(markets, this.cachedRewards);
    }

    if (this.cachedRewards && cacheAgeMs < 1_800_000) {
      this.logger.warn(
        { cacheAgeMs, outcome },
        "Reward metadata not ready this cycle. Using cached rewards (under 30 minutes old)."
      );
      return mergeMarketsWithRewards(markets, this.cachedRewards);
    }

    this.logger.warn(
      { outcome },
      "Reward metadata not ready and no fresh cache available. Background fetch still running; this cycle proceeds without reward annotations."
    );
    return [...markets];
  }

  private async handleTokenUpdate(tokenId: string): Promise<void> {
    if (this.stopping) {
      return;
    }

    const market = this.tokenToMarket.get(tokenId);

    if (!market) {
      return;
    }

    if (this.evaluationLocks.has(market.conditionId)) {
      return;
    }

    const inventoryOnlyManagement = this.isInventoryOnlyManagedCondition(market.conditionId);

    // Operator gates: pause always wins, but inventory-only exit management is
    // allowed to keep running even after the market drops out of the selected
    // universe or gets auto-disabled for new quoting.
    if (this.operatorControl.isPaused()) {
      return;
    }

    if (!inventoryOnlyManagement && !this.operatorControl.isMarketAllowed(market)) {
      return;
    }

    if (!this.selectedConditionIds.has(market.conditionId) && !inventoryOnlyManagement) {
      await this.quoteExecutor?.cancelMarketQuotes(market.conditionId);
      this.syncExecutionEngineWithActiveQuotes();
      return;
    }

    if (!inventoryOnlyManagement && this.watchOnlyConditionIds.has(market.conditionId)) {
      await this.quoteExecutor?.cancelConditionBuyQuotes(
        market.conditionId,
        "startup fallback watch-only"
      );
      this.syncExecutionEngineWithActiveQuotes();
      return;
    }

    // Seed activity timestamp on first sight of this condition so a freshly
    // selected market gets the full deactivation grace period before being
    // judged "dead".
    if (!this.lastFillAtByConditionId.has(market.conditionId)) {
      this.lastFillAtByConditionId.set(market.conditionId, Date.now());
    }

    const bookA = this.orderBookStore.get(market.tokenIds[0]);
    const bookB = this.orderBookStore.get(market.tokenIds[1]);

    if (!bookA || !bookB) {
      return;
    }

    this.evaluationLocks.add(market.conditionId);

    try {
      if (this.quoteExecutor) {
        await this.reconcileVenueInventoryForMarket(market, Date.now());
      }

      const baseThrottle = buildRiskExecutionThrottleSnapshot(
        this.riskManager.getSnapshot?.()
      );
      // Apply tighter parameters for in-play sports markets.
      const executionThrottle = baseThrottle && isLiveMarket(market)
        ? {
            ...baseThrottle,
            quoteSizeMultiplier: Math.min(
              baseThrottle.quoteSizeMultiplier,
              config.marketMaker.liveQuoteSizeMultiplier
            ),
            quoteHalfSpreadTicksMultiplier: Math.max(
              baseThrottle.quoteHalfSpreadTicksMultiplier,
              config.marketMaker.liveSpreadTicksMultiplier
            ),
            signalCooldownMultiplier: Number(
              (baseThrottle.signalCooldownMultiplier * config.marketMaker.liveCooldownMultiplier).toFixed(8)
            ),
            executionCooldownMultiplier: Number(
              (baseThrottle.executionCooldownMultiplier * config.marketMaker.liveCooldownMultiplier).toFixed(8)
            )
          }
        : baseThrottle;
      const inventoryPositionsByTokenId = new Map(
        market.tokenIds.map((marketTokenId) => [
          marketTokenId,
          this.inventoryTracker.getOpenPosition(marketTokenId)
        ])
      );
      const fillRateFeedback = this.getFillRateFeedback(market.conditionId);

      // Price shock circuit breaker: if either book's midpoint moved more than the
      // configured threshold within the volatility window, cancel all our quotes on
      // this market and pause until cooldown expires.
      const shockPaused = await this.checkAndHandlePriceShock(market);
      if (shockPaused) {
        return;
      }

      // Stuck-sweep deactivation: if this market hit max failed sweeps, pause it.
      const stuckPauseUntilMs =
        this.stuckSweepDeactivateUntilMsByConditionId.get(market.conditionId) ?? 0;
      if (stuckPauseUntilMs > Date.now()) {
        return;
      }

      const evaluation = evaluateMarketMakerPlan(
        market,
        bookA,
        bookB,
        executionThrottle,
        inventoryPositionsByTokenId,
        fillRateFeedback
      );

      if (evaluation.status === "rejected") {
        await this.handleRejectedEvaluation(market, evaluation);
        await this.executeAgedInventoryExitLadderIfNeeded(market, Date.now());
        return;
      }

      this.resetThinTopBookRejectState(market.conditionId);

      if (config.mode === "dry-run") {
        this.logPlan(evaluation.plan);
        return;
      }

      if (!this.quoteExecutor) {
        return;
      }

      try {
        const planNowMs = Date.now();
        const oneSideFillRecoveryContext = this.oneSideFillRecoveryByConditionId.get(
          market.conditionId
        );
        const oneSideFillResponseState = resolveMarketMakerOneSideFillResponseState(
          evaluation.plan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId),
          oneSideFillRecoveryContext
        );

        if (!oneSideFillResponseState && oneSideFillRecoveryContext) {
          this.oneSideAggressiveExitRejectCountByTokenId.delete(
            oneSideFillRecoveryContext.filledTokenId
          );
          this.oneSideFillRecoveryByConditionId.delete(market.conditionId);
        }

        const oneSideFillAdjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
          evaluation.plan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId),
          oneSideFillRecoveryContext,
          planNowMs,
          (tokenId) => this.getOneSideAggressiveExitRejectCount(tokenId)
        );
        const oneSideHardGatedPlan = applyOneSideInventoryHardGateToMarketMakerPlan(
          oneSideFillAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const pairExitAdjustedPlan = applyNetPairExitToMarketMakerPlan(
          oneSideHardGatedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const takeProfitAdjustedPlan = applyTakeProfitToMarketMakerPlan(
          pairExitAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const ageAdjustedPlan = applyAgeBasedUnwindToMarketMakerPlan(
          takeProfitAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const maxHoldAdjustedPlan = applyMaxHoldHardExitToMarketMakerPlan(
          ageAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const trackedInventoryFilteredPlan = filterMarketMakerPlanByTrackedInventory(
          maxHoldAdjustedPlan,
          (tokenId) => this.getTrustedTrackedOpenSharesForSellPlanning(market, tokenId, planNowMs),
          // 🔒 Pass venue-known balance so layered SELLs total ≤ exchange holdings.
          // Prevents the "post 5+5+10 SELL when venue only has 20" race that
          // produced "not enough balance" rejects and DEGRADED escalations.
          (tokenId) => this.quoteExecutor?.getKnownVenueShares?.(tokenId)
        );
        const effectiveSellLayers = isLiveMarket(market)
          ? Math.min(config.marketMaker.sellLayers, config.marketMaker.liveMaxActiveSellLayers)
          : config.marketMaker.sellLayers;
        const sellLayerExpandedPlan = expandSellQuotesToLayers(
          trackedInventoryFilteredPlan,
          effectiveSellLayers,
          config.marketMaker.sellLayerTickSpacing,
          config.marketMaker.sellLayerWeights
        );
        const temporarilySuppressedSellTokenIds = new Set(
          sellLayerExpandedPlan.quotes
            .filter((quote) => quote.side === Side.SELL && this.isSellTemporarilySuppressed(quote.tokenId))
            .map((quote) => quote.tokenId)
        );
        const sellCooldownFilteredPlan = filterMarketMakerPlanBySellRepostCooldown(
          sellLayerExpandedPlan,
          (tokenId) => temporarilySuppressedSellTokenIds.has(tokenId)
        );
        const passiveToAggressiveAdjustedPlan =
          applyPassiveToAggressiveTransitionToMarketMakerPlan(
            sellCooldownFilteredPlan,
            (trackedTokenId, side) => this.quoteExecutor?.getActiveQuote(trackedTokenId, side),
            Date.now()
          );
        // 🔒 Inventory cap MUST run before applyInventoryExitGuard so the
        // ExitGuard's profit floor wins on the trim SELL price (cap pushes
        // SELL inward, ExitGuard then clamps it back up to avgCost+floor).
        const inventoryCapAdjustedPlan = applyInventoryCapToMarketMakerPlan(
          passiveToAggressiveAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const inventoryExitGuardedPlan = applyInventoryExitGuardToMarketMakerPlan(
          inventoryCapAdjustedPlan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const reentryCooldownActive = this.isInsideRiskReductionReentryCooldown(market.conditionId);
        const buyReentryFilteredPlan = reentryCooldownActive
          ? filterMarketMakerPlanByBuySuppression(
              inventoryExitGuardedPlan,
              () => true
            )
          : inventoryExitGuardedPlan;
        const inventoryOnlyManagedPlan = inventoryOnlyManagement
          ? filterMarketMakerPlanByBuySuppression(
              buyReentryFilteredPlan,
              () => true
            )
          : buyReentryFilteredPlan;
        const thinTopBookExitOnly =
          this.hasOpenInventoryOnCondition(market) &&
          this.hasThinTopBookOnCondition(market);
        const entryGateFilteredPlan = thinTopBookExitOnly
          ? filterMarketMakerPlanByBuySuppression(
              inventoryOnlyManagedPlan,
              () => true
            )
          : inventoryOnlyManagedPlan;
        const postBuySellFeasibilityBlock = this.refreshPostBuySellFeasibilityBlock(market);
        // 🔒 Condition-level BUY suppression: if ANY BUY on this condition
        // filled recently (either YES or NO), block BUYs on BOTH sides to avoid
        // flipping into a directional bet right after a one-sided pick-off.
        const conditionBuySuppressed = this.isBuySuppressedByConditionFill(market.conditionId);
        // 📌 Pair imbalance 양방향 처리:
        //   overweight 쪽 → BUY 차단 (방향성 편향 방지)
        //   underweight 쪽 → BUY inward boost (균형 회복 적극 추구)
        const imbalanceTokens = this.resolveImbalanceTokens(market);
        const imbalanceOverweightTokenIds = imbalanceTokens.overweight;
        const imbalanceUnderweightTokenIds = imbalanceTokens.underweight;
        // Underweight 쪽 BUY 호가를 1틱 위로 끌어올려 체결 확률 증가 — 페어
        // 균형 회복용. 가격 = 기존 BUY + 1tick (더 경쟁력 있는 매수).
        let imbalanceBalancedPlan = entryGateFilteredPlan;
        if (
          !inventoryOnlyManagement &&
          !thinTopBookExitOnly &&
          imbalanceUnderweightTokenIds.size > 0
        ) {
          imbalanceBalancedPlan = {
            ...entryGateFilteredPlan,
            quotes: entryGateFilteredPlan.quotes.map((quote) => {
              if (quote.side !== Side.BUY) return quote;
              if (!imbalanceUnderweightTokenIds.has(quote.tokenId)) return quote;
              const boostedPrice = Math.min(
                quote.price + quote.tickSize,
                // 반대편 best ask 넘지 않게 안전장치 (cross 방지)
                (function () {
                  const counterpart = entryGateFilteredPlan.tokenPlans.find(
                    (tp) => tp.tokenId === quote.tokenId
                  );
                  return counterpart ? counterpart.bestAsk - quote.tickSize : quote.price + quote.tickSize;
                })()
              );
              return Math.abs(boostedPrice - quote.price) <= 1e-9
                ? quote
                : { ...quote, price: boostedPrice };
            })
          };
        }
        const entryPriceFilteredPlan =
          filterMarketMakerPlanByPassiveBuyPriceBand(imbalanceBalancedPlan);
        const buyFillCooldownSuppressedTokenIds = new Set(
          entryPriceFilteredPlan.quotes
            .filter(
              (quote) =>
                quote.side === Side.BUY &&
                (conditionBuySuppressed ||
                  postBuySellFeasibilityBlock !== undefined ||
                  this.isBuyReentrySuppressedAfterFill(quote.tokenId) ||
                  imbalanceOverweightTokenIds.has(quote.tokenId))
            )
            .map((quote) => quote.tokenId)
        );
        const buyFillCooldownFilteredPlan =
          buyFillCooldownSuppressedTokenIds.size > 0
            ? filterMarketMakerPlanByBuySuppression(
                entryPriceFilteredPlan,
                (tokenId) => buyFillCooldownSuppressedTokenIds.has(tokenId)
              )
            : entryPriceFilteredPlan;
        const passiveBuyFreshnessLeaseAdjustedPlan = this.applyPassiveBuyFreshnessLeaseToPlan(
          market,
          buyFillCooldownFilteredPlan,
          Date.now()
        );

        if (oneSideFillAdjustedPlan !== evaluation.plan) {
          this.logger.debug(
            {
              market: market.slug,
              responseState: oneSideFillResponseState
                ? {
                    mode: oneSideFillResponseState.mode,
                    filledTokenId: oneSideFillResponseState.filledTokenId,
                    opposingTokenId: oneSideFillResponseState.opposingTokenId,
                    ageMs: oneSideFillResponseState.ageMs,
                    imbalanceShares: Number(
                      oneSideFillResponseState.imbalanceShares.toFixed(4)
                    ),
                    filledInventoryShares: Number(
                      oneSideFillResponseState.filledInventoryShares.toFixed(4)
                    ),
                    opposingInventoryShares: Number(
                      oneSideFillResponseState.opposingInventoryShares.toFixed(4)
                    )
                  }
                : undefined,
              originalQuotes: evaluation.plan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                quoteSlot: quote.quoteSlot,
                price: quote.price,
                size: quote.size
              })),
              adjustedQuotes: oneSideFillAdjustedPlan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                quoteSlot: quote.quoteSlot,
                price: quote.price,
                size: quote.size
              }))
            },
            "Applied one-side fill recovery adjustments to market-making quotes."
          );
        }

        if (oneSideHardGatedPlan !== oneSideFillAdjustedPlan) {
          this.logger.debug(
            {
              market: market.slug,
              originalQuotes: oneSideFillAdjustedPlan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                quoteSlot: quote.quoteSlot,
                price: quote.price,
                size: quote.size
              })),
              adjustedQuotes: oneSideHardGatedPlan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                quoteSlot: quote.quoteSlot,
                price: quote.price,
                size: quote.size
              }))
            },
            "Applied one-side inventory hard gate adjustments to market-making quotes."
          );
        }

        if (pairExitAdjustedPlan !== oneSideHardGatedPlan) {
          const pairInventoryState = buildMarketMakerPairInventoryState(
            oneSideHardGatedPlan,
            (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
          );
          this.logger.debug(
            {
              market: market.slug,
              exitMode: resolveMarketMakerNetPairExitMode(
                oneSideHardGatedPlan,
                pairInventoryState
              ),
              pairInventoryState: pairInventoryState
                ? {
                    matchedShares: Number(pairInventoryState.matchedShares.toFixed(4)),
                    matchedNetPnlUsdc: Number(pairInventoryState.matchedNetPnlUsdc.toFixed(4)),
                    matchedNetEdgeBps: Number(pairInventoryState.matchedNetEdgeBps.toFixed(2)),
                    imbalanceShares: Number(pairInventoryState.imbalanceShares.toFixed(4))
                  }
                : undefined,
              originalSellQuotes: oneSideHardGatedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  quoteSlot: quote.quoteSlot,
                  price: quote.price,
                  size: quote.size
                })),
              adjustedSellQuotes: pairExitAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  quoteSlot: quote.quoteSlot,
                  price: quote.price,
                  size: quote.size
                }))
            },
            "Applied net pair exit adjustment to market-making SELL quotes."
          );
        }

        if (takeProfitAdjustedPlan !== pairExitAdjustedPlan) {
          this.logger.debug(
            {
              market: market.slug,
              originalSellQuotes: pairExitAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  quoteSlot: quote.quoteSlot,
                  price: quote.price,
                  size: quote.size
                })),
              adjustedSellQuotes: takeProfitAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  quoteSlot: quote.quoteSlot,
                  price: quote.price,
                  size: quote.size
                }))
            },
            "Applied take-profit unwind adjustment to market-making SELL quotes."
          );
        }

        if (ageAdjustedPlan !== takeProfitAdjustedPlan) {
          this.logger.debug(
            {
              market: market.slug,
              originalSellQuotes: takeProfitAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  price: quote.price,
                  size: quote.size
                })),
              adjustedSellQuotes: ageAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  price: quote.price,
                  size: quote.size
                })),
              ageBasedUnwindAfterMs: config.marketMaker.ageBasedUnwindAfterMs,
              ageBasedUnwindStepMs: config.marketMaker.ageBasedUnwindStepMs,
              ageBasedUnwindMaxInwardTicks: config.marketMaker.ageBasedUnwindMaxInwardTicks
            },
            "Applied age-based unwind adjustment to market-making SELL quotes."
          );
        }

        if (maxHoldAdjustedPlan !== ageAdjustedPlan) {
          const hardExitState = resolveMarketMakerMaxHoldHardExitState(
            ageAdjustedPlan,
            (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
          );
          if (
            hardExitState &&
            this.shouldLogMaxHoldHardExitActivation(
              market.conditionId,
              hardExitState.agedTokenIds
            )
          ) {
            this.logger.warn(
              {
                market: market.slug,
                hardExitState,
                adjustedQuotes: maxHoldAdjustedPlan.quotes.map((quote) => ({
                  tokenId: quote.tokenId,
                  side: quote.side,
                  price: quote.price,
                  size: quote.size
                }))
              },
              "Activated max-hold hard-exit adjustments for aged market-making inventory."
            );
          }
        } else {
          this.lastMaxHoldHardExitLogSignatureByConditionId.delete(market.conditionId);
        }

        if (trackedInventoryFilteredPlan.quotes.length !== maxHoldAdjustedPlan.quotes.length) {
          this.logger.debug(
            {
              market: market.slug,
              originalQuoteCount: maxHoldAdjustedPlan.quotes.length,
              filteredQuoteCount: trackedInventoryFilteredPlan.quotes.length
            },
            "Suppressed market-making SELL quotes because tracked inventory was unavailable."
          );
        }

        if (sellCooldownFilteredPlan.quotes.length !== trackedInventoryFilteredPlan.quotes.length) {
          this.logger.debug(
            {
              market: market.slug,
              trackedInventoryQuoteCount: trackedInventoryFilteredPlan.quotes.length,
              filteredQuoteCount: sellCooldownFilteredPlan.quotes.length,
              sellRepostCooldownMs: config.marketMaker.sellRepostCooldownMs,
              buyFillSettlementCooldownMs: config.marketMaker.buyFillSettlementCooldownMs
            },
            "Suppressed market-making SELL quotes because the token was still inside a recent post-fill settlement cooldown."
          );
        }

        if (passiveToAggressiveAdjustedPlan !== sellCooldownFilteredPlan) {
          this.logger.debug(
            {
              market: market.slug,
              originalQuotes: sellCooldownFilteredPlan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                price: quote.price,
                size: quote.size,
                orderType: quote.orderType,
                postOnly: quote.postOnly
              })),
              adjustedQuotes: passiveToAggressiveAdjustedPlan.quotes.map((quote) => ({
                tokenId: quote.tokenId,
                side: quote.side,
                price: quote.price,
                size: quote.size,
                orderType: quote.orderType,
                postOnly: quote.postOnly
              })),
              passiveToAggressiveAfterMs: config.marketMaker.passiveToAggressiveAfterMs,
              passiveToAggressivePriceBufferTicks:
                config.marketMaker.passiveToAggressivePriceBufferTicks
            },
            "Applied passive-to-aggressive transition to stale market-making quotes."
          );
        }

        if (inventoryExitGuardedPlan !== passiveToAggressiveAdjustedPlan) {
          this.logger.debug(
            {
              market: market.slug,
              originalSellQuotes: passiveToAggressiveAdjustedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  price: quote.price,
                  size: quote.size
                })),
              guardedSellQuotes: inventoryExitGuardedPlan.quotes
                .filter((quote) => quote.side === "SELL")
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  price: quote.price,
                  size: quote.size
                })),
              exitMinSpreadTicks: config.marketMaker.exitMinSpreadTicks,
              exitMinProfitTicks: config.marketMaker.exitMinProfitTicks,
              conditionalExitMaxLossBps: config.marketMaker.conditionalExitMaxLossBps,
              conditionalExitOverweightRatio: config.marketMaker.conditionalExitOverweightRatio
            },
            "Applied inventory exit price guard to prevent inverted or loss-only SELL quotes."
          );
        }

        if (
          buyReentryFilteredPlan !== inventoryExitGuardedPlan &&
          this.shouldLogRiskReductionReentrySuppression(market.conditionId)
        ) {
          this.logger.info(
            {
              market: market.slug,
              conditionId: market.conditionId,
              suppressedBuyQuoteCount: inventoryExitGuardedPlan.quotes.filter(
                (quote) => quote.side === Side.BUY
              ).length,
              reentryCooldownMs: config.marketMaker.postRiskReductionReentryCooldownMs
            },
            "Temporarily suppressed new BUY quotes after a recent risk-reduction exit."
          );
        }

        if (entryPriceFilteredPlan !== imbalanceBalancedPlan) {
          this.logger.debug(
            {
              market: market.slug,
              conditionId: market.conditionId,
              minPassiveBuyPrice: config.marketMaker.minPassiveBuyPrice,
              maxPassiveBuyPrice: config.marketMaker.maxPassiveBuyPrice,
              removedBuyQuotes: imbalanceBalancedPlan.quotes
                .filter((quote) => quote.side === Side.BUY)
                .filter(
                  (quote) =>
                    !entryPriceFilteredPlan.quotes.some(
                      (kept) =>
                        kept.tokenId === quote.tokenId &&
                        kept.side === quote.side &&
                        (kept.quoteSlot ?? "primary") === (quote.quoteSlot ?? "primary")
                    )
                )
                .map((quote) => ({
                  tokenId: quote.tokenId,
                  outcome: quote.outcome,
                  price: quote.price,
                  quoteSlot: quote.quoteSlot ?? "primary"
                }))
            },
            "Suppressed passive BUY quotes outside the configured entry price band."
          );
        }

        if (
          inventoryOnlyManagement &&
          inventoryOnlyManagedPlan !== buyReentryFilteredPlan &&
          this.shouldLogInventoryOnlyManagement(market.conditionId)
        ) {
          this.logger.info(
            {
              market: market.slug,
              conditionId: market.conditionId,
              suppressedBuyQuoteCount: buyReentryFilteredPlan.quotes.filter(
                (quote) => quote.side === Side.BUY
              ).length
            },
            "Managed off-universe inventory in SELL-only mode."
          );
        }

        if (buyFillCooldownSuppressedTokenIds.size > 0) {
          this.logger.info(
            {
              market: market.slug,
              suppressedTokenIds: [...buyFillCooldownSuppressedTokenIds],
              cooldownMs: config.marketMaker.buyReentryAfterFillCooldownMs
            },
            "Suppressed BUY re-entry: waiting for SELL fill before posting new BUY quotes."
          );
        }

        this.syncExecutionEngineWithActiveQuotes();
        await this.quoteExecutor.syncPositionManager(passiveBuyFreshnessLeaseAdjustedPlan);
        const coordination = this.coordinator.coordinate(
          buildMarketMakingIntents(passiveBuyFreshnessLeaseAdjustedPlan)
        );
        const retainedIntents = buildRetainedMarketMakingIntents(
          coordination.approvedIntents,
          coordination.rejected
        );
        const approvedPlan = filterMarketMakerPlanByApprovedIntents(
          passiveBuyFreshnessLeaseAdjustedPlan,
          retainedIntents
        );

        const trackedInventoryPositions = passiveBuyFreshnessLeaseAdjustedPlan.tokenPlans
          .map((tokenPlan) => {
            const openPosition = this.inventoryTracker.getOpenPosition(tokenPlan.tokenId);

            if (!openPosition || openPosition.shares <= 0) {
              return undefined;
            }

            return {
              tokenId: tokenPlan.tokenId,
              outcome: tokenPlan.outcome,
              shares: Number(openPosition.shares.toFixed(4)),
              totalCostUsdc: Number(openPosition.totalCostUsdc.toFixed(4))
            };
          })
          .filter((position): position is NonNullable<typeof position> => position !== undefined);
        const trackedInventoryTokenIds = new Set(
          trackedInventoryPositions.map((position) => position.tokenId)
        );
        const minimumSellQuoteSize = Math.max(
          config.marketMaker.minSellShares,
          market.orderMinSize,
          5,
          Number.EPSILON
        );
        const originalPairInventoryState = buildMarketMakerPairInventoryState(
          evaluation.plan,
          (trackedTokenId) => this.inventoryTracker.getOpenPosition(trackedTokenId)
        );
        const responseStateSummary = oneSideFillResponseState
          ? {
              mode: oneSideFillResponseState.mode,
              filledTokenId: oneSideFillResponseState.filledTokenId,
              opposingTokenId: oneSideFillResponseState.opposingTokenId,
              ageMs: oneSideFillResponseState.ageMs,
              imbalanceShares: Number(oneSideFillResponseState.imbalanceShares.toFixed(4)),
              filledInventoryShares: Number(
                oneSideFillResponseState.filledInventoryShares.toFixed(4)
              ),
              opposingInventoryShares: Number(
                oneSideFillResponseState.opposingInventoryShares.toFixed(4)
              )
            }
          : undefined;
        const diagnostics: string[] = [];
        const preCoordinationSellQuotes = passiveBuyFreshnessLeaseAdjustedPlan.quotes.filter(
          (quote) => trackedInventoryTokenIds.has(quote.tokenId) && quote.side === Side.SELL
        );
        const approvedSellQuotes = approvedPlan.quotes.filter(
          (quote) => trackedInventoryTokenIds.has(quote.tokenId) && quote.side === Side.SELL
        );
        const preCoordinationSellCoverageByTokenId = this.buildTrackedInventorySellCoverage(
          market.conditionId,
          trackedInventoryTokenIds,
          preCoordinationSellQuotes
        );
        const approvedSellCoverageByTokenId = this.buildTrackedInventorySellCoverage(
          market.conditionId,
          trackedInventoryTokenIds,
          approvedSellQuotes
        );
        const cooldownSuppressedTrackedPositions = trackedInventoryPositions.filter((position) =>
          temporarilySuppressedSellTokenIds.has(position.tokenId)
        );
        const unsuppressedTrackedPositions = trackedInventoryPositions.filter(
          (position) => !temporarilySuppressedSellTokenIds.has(position.tokenId)
        );
        const rejectedInventoryIntents = coordination.rejected
          .filter((rejected) => trackedInventoryTokenIds.has(rejected.intent.tokenId))
          .map((rejected) => ({
            tokenId: rejected.intent.tokenId,
            side: rejected.intent.side,
            quoteSlot: rejected.intent.quoteSlot,
            price: rejected.intent.price,
            size: rejected.intent.size,
            reason: rejected.reason,
            detail: rejected.detail
          }));

        if (oneSideFillRecoveryContext && !oneSideFillResponseState) {
          diagnostics.push("recovery_context_without_response_state");
        }

        if (
          reentryCooldownActive &&
          inventoryExitGuardedPlan.quotes.some((quote) => quote.side === Side.BUY)
        ) {
          diagnostics.push("buy_reentry_temporarily_suppressed_after_risk_reduction");
        }

        if (buyFillCooldownSuppressedTokenIds.size > 0) {
          diagnostics.push("buy_reentry_suppressed_until_sell_fill");
        }

        if (inventoryOnlyManagement) {
          diagnostics.push("inventory_only_exit_management");
        }

        if (postBuySellFeasibilityBlock) {
          diagnostics.push("buy_reentry_suppressed_by_sell_feasibility");
        }

        if (
          cooldownSuppressedTrackedPositions.length > 0 &&
          this.hasMeaningfulUncoveredInventory(
            cooldownSuppressedTrackedPositions,
            preCoordinationSellCoverageByTokenId,
            minimumSellQuoteSize
          )
        ) {
          diagnostics.push("inventory_sell_temporarily_suppressed_by_cooldown");
        }

        if (
          unsuppressedTrackedPositions.length > 0 &&
          this.hasMeaningfulUncoveredInventory(
            unsuppressedTrackedPositions,
            preCoordinationSellCoverageByTokenId,
            minimumSellQuoteSize
          )
        ) {
          diagnostics.push("inventory_present_but_no_sell_before_coordination");
        }

        if (
          unsuppressedTrackedPositions.length > 0 &&
          this.hasMeaningfulUncoveredInventory(
            unsuppressedTrackedPositions,
            approvedSellCoverageByTokenId,
            minimumSellQuoteSize
          )
        ) {
          diagnostics.push("inventory_present_but_no_sell_after_coordination");
        }

        if (
          trackedInventoryPositions.some(
            (position) => position.shares > 0 && position.shares + Number.EPSILON < minimumSellQuoteSize
          )
        ) {
          diagnostics.push("inventory_dust_below_min_sell_size");
        }

        if (
          oneSideFillResponseState &&
          approvedPlan.quotes.some(
            (quote) =>
              quote.tokenId === oneSideFillResponseState.filledTokenId && quote.side === Side.BUY
          )
        ) {
          diagnostics.push("filled_side_buy_survived_after_inventory_controls");
        }

        if (rejectedInventoryIntents.length > 0) {
          diagnostics.push("inventory_intents_rejected_by_coordinator");
        }

        this.maybeLogTrackedInventoryExecutionDiagnostics({
          market,
          trackedInventoryPositions,
          diagnostics,
          recoveryContext: oneSideFillRecoveryContext
            ? {
                filledTokenId: oneSideFillRecoveryContext.filledTokenId,
                activatedAtMs: oneSideFillRecoveryContext.activatedAtMs
              }
            : undefined,
          responseState: responseStateSummary,
          pairInventoryState: originalPairInventoryState
            ? {
                matchedShares: Number(originalPairInventoryState.matchedShares.toFixed(4)),
                matchedNetPnlUsdc: Number(
                  originalPairInventoryState.matchedNetPnlUsdc.toFixed(4)
                ),
                matchedNetEdgeBps: Number(
                  originalPairInventoryState.matchedNetEdgeBps.toFixed(2)
                ),
                imbalanceShares: Number(originalPairInventoryState.imbalanceShares.toFixed(4)),
                sideA: {
                  tokenId: originalPairInventoryState.sideA.tokenId,
                  outcome: originalPairInventoryState.sideA.outcome,
                  shares: Number(originalPairInventoryState.sideA.shares.toFixed(4))
                },
                sideB: {
                  tokenId: originalPairInventoryState.sideB.tokenId,
                  outcome: originalPairInventoryState.sideB.outcome,
                  shares: Number(originalPairInventoryState.sideB.shares.toFixed(4))
                }
              }
            : undefined,
          stageQuotes: {
            original: evaluation.plan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            })),
            oneSideFillAdjusted: oneSideFillAdjustedPlan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            })),
            oneSideHardGated: oneSideHardGatedPlan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            })),
            inventoryExitGuarded: inventoryExitGuardedPlan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            })),
            buyFillCooldownFiltered: buyFillCooldownFilteredPlan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            })),
            approved: approvedPlan.quotes.map((quote) => ({
              tokenId: quote.tokenId,
              outcome: quote.outcome,
              side: quote.side,
              quoteSlot: quote.quoteSlot,
              price: quote.price,
              size: quote.size,
              orderType: quote.orderType,
              postOnly: quote.postOnly,
              executionStyle: quote.executionStyle
            }))
          },
          rejectedInventoryIntents
        });

        if (
          await this.maybeSweepStuckInventory({
            market,
            trackedInventoryPositions,
            sellCoverageByTokenId: approvedSellCoverageByTokenId,
            temporarilySuppressedSellTokenIds,
            diagnostics,
            minimumSellQuoteSize
          })
        ) {
          return;
        }

        if (await this.executeAgedInventoryExitLadderIfNeeded(market, Date.now())) {
          return;
        }

        if (coordination.rejected.length > 0) {
          this.logger.debug(
            {
              market: market.slug,
              acceptedQuotes: approvedPlan.quotes.length,
              rejectedIntents: coordination.rejected.map((rejected) => ({
                tokenId: rejected.intent.tokenId,
                side: rejected.intent.side,
                reason: rejected.reason,
                detail: rejected.detail
              }))
            },
            "Market-making coordination filtered one or more quote intents."
          );
        }

        if (this.stopping) {
          return;
        }

        await this.quoteExecutor.reconcile(approvedPlan);
        this.syncExecutionEngineWithActiveQuotes();
        await this.executeMaxHoldHardExitIfNeeded(market, maxHoldAdjustedPlan);
        this.logPlan(approvedPlan);
      } catch (error) {
        this.riskManager.noteOrderFailure?.(
          "market-making.quote-reconcile",
          `${market.slug}:${error instanceof Error ? error.message : String(error)}`
        );
        this.logger.error(
          { err: error, market: market.slug },
          "Market-making quote reconciliation failed."
        );
      }
    } finally {
      this.evaluationLocks.delete(market.conditionId);

      if (
        !this.stopping &&
        this.pendingImmediateReevaluationConditionIds.delete(market.conditionId)
      ) {
        queueMicrotask(() => {
          void this.handleTokenUpdate(market.tokenIds[0]);
        });
      }
    }
  }

  private async handleRejectedEvaluation(
    market: BinaryMarket,
    evaluation: Extract<MarketMakerEvaluation, { status: "rejected" }>
  ): Promise<void> {
    const hasOpenInventory = this.hasOpenInventoryOnCondition(market);
    const activeQuoteCountBeforeCancel = this.quoteExecutor
      ? this.quoteExecutor.getActiveQuotes().filter((quote) => quote.conditionId === market.conditionId)
          .length
      : 0;
    const activeSellQuoteCountBeforeCancel = this.quoteExecutor
      ? this.quoteExecutor
          .getActiveQuotes()
          .filter(
            (quote) =>
              quote.conditionId === market.conditionId && quote.side === Side.SELL
          ).length
      : 0;

    if (this.quoteExecutor) {
      if (hasOpenInventory) {
        await this.quoteExecutor.cancelConditionBuyQuotes(
          market.conditionId,
          `market evaluation rejected: ${evaluation.reason}`
        );
      } else {
        await this.quoteExecutor.cancelMarketQuotes(market.conditionId);
      }
      this.syncExecutionEngineWithActiveQuotes();
    }

    const now = Date.now();
    const thinTopBookCooldownState =
      evaluation.reason === "top_book_liquidity_too_thin"
        ? this.noteThinTopBookReject(market.conditionId, now)
        : (this.resetThinTopBookRejectState(market.conditionId),
          { count: 0, activated: false as const, cooldownUntilMs: undefined });
    const rejectionSignature = `${evaluation.reason}:${evaluation.detail}`;
    const lastLoggedAt =
      this.lastRejectedPlanLogAtByConditionId.get(market.conditionId) ?? 0;
    const lastSignature =
      this.lastRejectedPlanLogSignatureByConditionId.get(market.conditionId);
    const shouldLogRejection =
      thinTopBookCooldownState.activated ||
      rejectionSignature !== lastSignature ||
      now - lastLoggedAt >= config.observability.verboseMarketLogIntervalMs;

    if (!shouldLogRejection) {
      return;
    }

    this.lastRejectedPlanLogAtByConditionId.set(market.conditionId, now);
    this.lastRejectedPlanLogSignatureByConditionId.set(
      market.conditionId,
      rejectionSignature
    );
    const logPayload = {
      market: market.slug,
      question: market.question,
      reason: evaluation.reason,
      detail: evaluation.detail,
      activeQuoteCountBeforeCancel,
      activeSellQuoteCountBeforeCancel,
      preservedSellQuotesForInventory: hasOpenInventory
        ? activeSellQuoteCountBeforeCancel
        : 0,
      verboseMarketLogs: config.observability.verboseMarketLogs,
      thinTopBookRejectCount:
        evaluation.reason === "top_book_liquidity_too_thin"
          ? thinTopBookCooldownState.count
          : undefined,
      thinTopBookCooldownUntilMs: thinTopBookCooldownState.cooldownUntilMs
    };

    if (thinTopBookCooldownState.activated) {
      this.logger.warn(
        logPayload,
        "Paused market-making market after repeated thin top-book execution rejects."
      );
      return;
    }

    this.logger.info(logPayload, "Market-making plan rejected.");
  }

  private logPlan(plan: MarketMakerPlan): void {
    if (!config.observability.verboseMarketLogs) {
      return;
    }

    const now = Date.now();
    const lastLoggedAt = this.lastPlanLogAt.get(plan.market.conditionId) ?? 0;

    if (now - lastLoggedAt < config.observability.verboseMarketLogIntervalMs) {
      return;
    }

    this.lastPlanLogAt.set(plan.market.conditionId, now);
    const pairInventoryState = buildMarketMakerPairInventoryState(
      plan,
      (tokenId) => this.inventoryTracker.getOpenPosition(tokenId)
    );
    this.logger.info(
      {
        market: plan.market.slug,
        category: plan.market.category,
        question: plan.market.question,
        rewardRatePerDay: plan.market.rewardRatePerDay,
        rewardsMaxSpread: plan.market.rewardsMaxSpread,
        rewardsMinSize: plan.market.rewardsMinSize,
        rewardActive: plan.rewardActive,
        executionThrottle: plan.executionThrottle,
        fillRateFeedback: plan.fillRateFeedback
          ? {
              postedQuoteCount: plan.fillRateFeedback.postedQuoteCount,
              filledQuoteCount: plan.fillRateFeedback.filledQuoteCount,
              fillRate: Number(plan.fillRateFeedback.fillRate.toFixed(4)),
              inwardTicks: plan.fillRateFeedback.inwardTicks
            }
          : undefined,
        tokenPlans: plan.tokenPlans.map((tokenPlan) => ({
          outcome: tokenPlan.outcome,
          midpoint: tokenPlan.midpoint.toFixed(4),
          bestBid: tokenPlan.bestBid.toFixed(4),
          bestAsk: tokenPlan.bestAsk.toFixed(4),
          observedSpread: tokenPlan.observedSpread.toFixed(4),
          observedSpreadTicks: tokenPlan.observedSpreadTicks,
          topBookLiquidityUsdc: tokenPlan.topBookLiquidityUsdc.toFixed(2),
          rewardEligible: tokenPlan.rewardEligible,
          rebateEfficiencyScore: tokenPlan.rebateEfficiencyScore.toFixed(4),
          rebatePrioritySide: tokenPlan.rebatePrioritySide,
          rebateInwardTicks: tokenPlan.rebateInwardTicks,
          inventoryShares: tokenPlan.inventoryShares,
          opposingInventoryShares: tokenPlan.opposingInventoryShares,
          inventorySkewRatio: tokenPlan.inventorySkewRatio.toFixed(4),
          inventoryBuyAdjustmentTicks: tokenPlan.inventoryBuyAdjustmentTicks,
          inventorySellAdjustmentTicks: tokenPlan.inventorySellAdjustmentTicks,
          fillRateFeedbackInwardTicks: tokenPlan.fillRateFeedbackInwardTicks,
          tapePressureBiasSide: tokenPlan.tapePressureBiasSide,
          tapePressureBiasTicks: tokenPlan.tapePressureBiasTicks,
          tapePressureScore:
            typeof tokenPlan.tapePressureScore === "number"
              ? Number(tokenPlan.tapePressureScore.toFixed(4))
              : undefined,
          tapePressureTradesPerMinute:
            typeof tokenPlan.tapePressureTradesPerMinute === "number"
              ? Number(tokenPlan.tapePressureTradesPerMinute.toFixed(4))
              : undefined
        })),
        pairInventoryState: pairInventoryState
          ? {
              matchedShares: Number(pairInventoryState.matchedShares.toFixed(4)),
              matchedCostUsdc: Number(pairInventoryState.matchedCostUsdc.toFixed(4)),
              matchedMarkValueUsdc: Number(pairInventoryState.matchedMarkValueUsdc.toFixed(4)),
              matchedNetPnlUsdc: Number(pairInventoryState.matchedNetPnlUsdc.toFixed(4)),
              matchedNetEdgeBps: Number(pairInventoryState.matchedNetEdgeBps.toFixed(2)),
              totalCostUsdc: Number(pairInventoryState.totalCostUsdc.toFixed(4)),
              totalMarkValueUsdc: Number(pairInventoryState.totalMarkValueUsdc.toFixed(4)),
              totalNetPnlUsdc: Number(pairInventoryState.totalNetPnlUsdc.toFixed(4)),
              imbalanceShares: Number(pairInventoryState.imbalanceShares.toFixed(4)),
              overweightTokenId: pairInventoryState.overweightTokenId
            }
          : undefined,
        quotes: plan.quotes.map((quote) => ({
          outcome: quote.outcome,
          side: quote.side,
          price: quote.price.toFixed(4),
          size: quote.size,
          orderType: quote.orderType,
          postOnly: quote.postOnly
        }))
      },
      config.mode === "dry-run"
        ? "Market-making quote plan generated."
        : "Market-making quote plan reconciled."
    );
  }

  private async maybeSweepStuckInventory(params: {
    market: BinaryMarket;
    trackedInventoryPositions: Array<{
      tokenId: string;
      outcome: string;
      shares: number;
      totalCostUsdc: number;
    }>;
    sellCoverageByTokenId: ReadonlyMap<string, number>;
    temporarilySuppressedSellTokenIds: ReadonlySet<string>;
    diagnostics: string[];
    minimumSellQuoteSize: number;
  }): Promise<boolean> {
    if (!this.quoteExecutor || !this.riskReductionExecutor) {
      return false;
    }

    const nowMs = Date.now();
    // 🔒 Profit-floor exclusion: a position whose bestBid sits below the
    // currently effective exit floor is not "stuck" — it is still waiting for
    // the market to reach a permissible exit price. The effective floor already
    // includes the time-based break-even relaxation, so genuinely stale lots can
    // eventually graduate into the stuck-sweep path instead of being trapped
    // forever behind the original entry-profit requirement.
    const isBlockedByProfitFloor = (position: { tokenId: string; totalCostUsdc: number; shares: number }): boolean => {
      if (position.shares <= Number.EPSILON) return false;
      const book = this.orderBookStore?.get?.(position.tokenId);
      const bestBid = book?.bids?.[0]?.price;
      if (typeof bestBid !== "number" || !Number.isFinite(bestBid)) return false;
      const tickSize = book?.tickSize ?? 0.01;
      const openPosition = this.inventoryTracker.getOpenPosition(position.tokenId);
      const profitFloor = resolveMinimumExitPriceForPosition(openPosition, tickSize, nowMs);
      if (profitFloor === undefined) return false;
      // bestBid is the most a passive SELL would clear at — if even bestBid+tick
      // can't reach the floor, the SELL is correctly held back, not stuck.
      return bestBid + tickSize + Number.EPSILON < profitFloor;
    };

    const resolveStuckPositions = () =>
      params.trackedInventoryPositions.filter(
        (position) => {
          if (params.temporarilySuppressedSellTokenIds.has(position.tokenId)) {
            return false;
          }

          if (isBlockedByProfitFloor(position)) {
            return false;
          }

          const coveredShares = params.sellCoverageByTokenId.get(position.tokenId) ?? 0;
          const uncoveredShares = Math.max(0, position.shares - coveredShares);

          return (
            position.shares + Number.EPSILON >= params.minimumSellQuoteSize &&
            uncoveredShares + Number.EPSILON >=
              Math.min(position.shares, params.minimumSellQuoteSize)
          );
        }
      );
    let stuckPositions = resolveStuckPositions();

    if (stuckPositions.length === 0) {
      this.consecutiveStuckInventoryCyclesByConditionId.delete(params.market.conditionId);
      return false;
    }

    const nextCycleCount =
      (this.consecutiveStuckInventoryCyclesByConditionId.get(params.market.conditionId) ?? 0) + 1;
    this.consecutiveStuckInventoryCyclesByConditionId.set(
      params.market.conditionId,
      nextCycleCount
    );

    const triggerCycleCount = 3;
    const baseSweepCooldownMs = Math.max(
      30_000,
      config.marketMaker.balanceRefreshMs * 2,
      config.marketMaker.sellRepostCooldownMs * 3
    );
    // Progressive backoff: each consecutive failed sweep doubles the cooldown up to 10 min.
    // Prevents the WARN-flood we saw in the 20:00–20:30 window where the same sweep fired
    // every 30s for 30 minutes without resolving the venue/local inventory mismatch.
    const consecutiveFailures =
      this.consecutiveFailedStuckSweepsByConditionId.get(params.market.conditionId) ?? 0;
    const sweepCooldownMs = Math.min(
      baseSweepCooldownMs * Math.pow(2, Math.min(consecutiveFailures, 5)),
      10 * 60_000
    );
    const lastSweptAtMs =
      this.lastStuckInventorySweepAtByConditionId.get(params.market.conditionId) ?? 0;

    if (
      nextCycleCount < triggerCycleCount ||
      nowMs - lastSweptAtMs + Number.EPSILON < sweepCooldownMs
    ) {
      return false;
    }

    await this.reconcileVenueInventoryForMarket(params.market, nowMs, true);

    // After reconciliation, if the venue truly has 0 sellable shares for all tokens in this
    // market but our local tracker has SIGNIFICANTLY MORE shares, those excess lots are
    // orphaned (venue cleared them somehow — past session trades, missed user-ws fills).
    // Detect both full-orphan (venue=0) and partial-orphan (venue<<local) cases.
    const PARTIAL_MISMATCH_RATIO = 0.5; // local > venue × 2 → partial mismatch
    const hasInventoryMismatch = params.market.tokenIds.some((tokenId) => {
      const position = this.inventoryTracker.getOpenPosition(tokenId);
      if (!position || position.shares < Number.EPSILON) return false;
      const venueShares = this.quoteExecutor?.getKnownVenueShares?.(tokenId) ?? undefined;
      if (typeof venueShares !== "number") return false;
      // Full orphan
      if (venueShares < Number.EPSILON) return true;
      // Partial mismatch: local has MORE than 2x what venue actually holds
      if (venueShares + Number.EPSILON < position.shares * PARTIAL_MISMATCH_RATIO) return true;
      return false;
    });

    if (consecutiveFailures >= 3 && hasInventoryMismatch) {
      // Three failed sweeps + venue/local mismatch → our lot tracker is wrong.
      // Reduce local lots down to actual venue balance (instead of full purge).
      for (const tokenId of params.market.tokenIds) {
        const position = this.inventoryTracker.getOpenPosition(tokenId);
        if (!position || position.shares < Number.EPSILON) continue;
        const venueShares = this.quoteExecutor?.getKnownVenueShares?.(tokenId) ?? undefined;
        if (typeof venueShares !== "number") continue;
        const sharesToRemove = Math.max(0, position.shares - venueShares);
        if (sharesToRemove < Number.EPSILON) continue;
        if (venueShares < Number.EPSILON) {
          this.logger.warn(
            {
              market: params.market.slug,
              tokenId,
              phantomShares: position.shares,
              phantomCost: position.totalCostUsdc,
              venueShares,
              consecutiveFailures
            },
            "Purging phantom local inventory — venue has no sellable shares after repeated reconciliation."
          );
          this.inventoryTracker.purgeTokenLots?.(tokenId, "phantom_inventory_stuck_sweep");
        } else {
          this.logger.warn(
            {
              market: params.market.slug,
              tokenId,
              localShares: position.shares,
              venueShares,
              sharesToRemove,
              consecutiveFailures
            },
            "Reducing local inventory to match venue — partial mismatch detected."
          );
          // Trim local lots down to venue level. We re-purge then re-add the venue level.
          this.inventoryTracker.purgeTokenLots?.(tokenId, "partial_mismatch_stuck_sweep");
          // Note: next reconcileVenuePosition call will re-add the actual venue balance
          // as a venue-sync lot, so we end up correctly aligned.
        }
      }
      this.consecutiveFailedStuckSweepsByConditionId.delete(params.market.conditionId);
      this.consecutiveStuckInventoryCyclesByConditionId.delete(params.market.conditionId);
      this.lastStuckInventorySweepAtByConditionId.set(params.market.conditionId, nowMs);
      // Force one more reconciliation to re-establish the venue-sync lot at the correct level
      await this.reconcileVenueInventoryForMarket(params.market, Date.now(), true);
      return true;
    }
    stuckPositions = params.market.tokenIds
      .map((tokenId, index) => {
        if (params.temporarilySuppressedSellTokenIds.has(tokenId)) {
          return undefined;
        }

        const openPosition = this.inventoryTracker.getOpenPosition(tokenId);

        if (!openPosition || openPosition.shares + Number.EPSILON < params.minimumSellQuoteSize) {
          return undefined;
        }

        const coveredShares = params.sellCoverageByTokenId.get(tokenId) ?? 0;
        const uncoveredShares = Math.max(0, openPosition.shares - coveredShares);

        if (
          uncoveredShares + Number.EPSILON <
          Math.min(openPosition.shares, params.minimumSellQuoteSize)
        ) {
          return undefined;
        }

        return {
          tokenId,
          outcome: params.market.outcomes[index] ?? tokenId,
          shares: Number(openPosition.shares.toFixed(4)),
          totalCostUsdc: Number(openPosition.totalCostUsdc.toFixed(4))
        };
      })
      .filter((position): position is NonNullable<typeof position> => position !== undefined);

    if (stuckPositions.length === 0) {
      this.consecutiveStuckInventoryCyclesByConditionId.delete(params.market.conditionId);
      this.consecutiveFailedStuckSweepsByConditionId.delete(params.market.conditionId);
      return false;
    }

    const candidateTokenIds = new Set(stuckPositions.map((position) => position.tokenId));
    // 🔒 Stamp the currently effective exit floor onto each candidate so the
    // risk-reduction executor stays aligned with the quote-plan logic. This
    // includes the time-based break-even relaxation for genuinely stale lots.
    const candidates = buildRiskReductionCandidatesFromMarkets([params.market])
      .filter((candidate) => candidateTokenIds.has(candidate.tokenId))
      .map((candidate) => {
        const position = this.inventoryTracker.getOpenPosition(candidate.tokenId);
        if (!position || position.shares <= Number.EPSILON) return candidate;
        const book = this.orderBookStore.get(candidate.tokenId);
        const tickSize = book?.tickSize ?? 0.01;
        const minSellPrice = resolveMinimumExitPriceForPosition(position, tickSize, nowMs);
        return {
          ...candidate,
          minSellPrice
        };
      });

    if (candidates.length === 0) {
      // Still have stuck positions but no candidates → count this as a failed sweep
      this.consecutiveFailedStuckSweepsByConditionId.set(
        params.market.conditionId,
        (this.consecutiveFailedStuckSweepsByConditionId.get(params.market.conditionId) ?? 0) + 1
      );
      this.lastStuckInventorySweepAtByConditionId.set(params.market.conditionId, nowMs);
      return false;
    }

    this.lastStuckInventorySweepAtByConditionId.set(params.market.conditionId, nowMs);
    this.consecutiveStuckInventoryCyclesByConditionId.set(params.market.conditionId, 0);
    // Increment failure counter — will be reset on next successful SELL post (in post loop).
    const nextFailureCount =
      (this.consecutiveFailedStuckSweepsByConditionId.get(params.market.conditionId) ?? 0) + 1;
    this.consecutiveFailedStuckSweepsByConditionId.set(
      params.market.conditionId,
      nextFailureCount
    );

    // If we've failed 5+ times, deactivate this market for 30 minutes.
    // The repeated sweep-reduce cycle is clearly not resolving — back off.
    if (nextFailureCount >= 5) {
      const deactivateUntilMs = nowMs + 30 * 60_000;
      this.stuckSweepDeactivateUntilMsByConditionId.set(
        params.market.conditionId,
        deactivateUntilMs
      );
      this.logger.warn(
        {
          market: params.market.slug,
          conditionId: params.market.conditionId,
          consecutiveFailures: nextFailureCount,
          deactivateUntilMs,
          deactivateMinutes: 30
        },
        "Stuck inventory sweep failed 5+ times — deactivating market for 30 minutes."
      );
    }
    this.logger.warn(
      {
        market: params.market.slug,
        conditionId: params.market.conditionId,
        cycleCount: nextCycleCount,
        sweepCooldownMs,
        minimumSellQuoteSize: params.minimumSellQuoteSize,
        diagnostics: params.diagnostics,
        stuckPositions,
        candidateCount: candidates.length
      },
      "Triggered stuck inventory sweep after repeated cycles without approved SELL quotes."
    );

    await this.quoteExecutor.cancelMarketQuotes(params.market.conditionId);
    this.syncExecutionEngineWithActiveQuotes();
    await this.reduceInventoryRiskCandidates(candidates, "stuck inventory sweep");
    return true;
  }

  private buildTrackedInventorySellCoverage(
    conditionId: string,
    trackedInventoryTokenIds: ReadonlySet<string>,
    supplementalSellQuotes: readonly QuoteInstruction[] = []
  ): Map<string, number> {
    const slotCoverage = new Map<string, { tokenId: string; size: number }>();
    const noteCoverage = (tokenId: string, quoteSlot: string | undefined, size: number): void => {
      if (!trackedInventoryTokenIds.has(tokenId) || !(size > 0)) {
        return;
      }

      const slotKey = `${tokenId}:${quoteSlot ?? "primary"}`;
      const existing = slotCoverage.get(slotKey);

      if (!existing || size > existing.size + Number.EPSILON) {
        slotCoverage.set(slotKey, {
          tokenId,
          size
        });
      }
    };

    for (const activeQuote of this.quoteExecutor?.getActiveQuotes() ?? []) {
      if (activeQuote.conditionId !== conditionId || activeQuote.side !== Side.SELL) {
        continue;
      }

      noteCoverage(activeQuote.tokenId, activeQuote.quoteSlot, activeQuote.size);
    }

    for (const quote of supplementalSellQuotes) {
      if (quote.side !== Side.SELL) {
        continue;
      }

      noteCoverage(quote.tokenId, quote.quoteSlot, quote.size);
    }

    const coverageByTokenId = new Map<string, number>();
    for (const { tokenId, size } of slotCoverage.values()) {
      coverageByTokenId.set(tokenId, (coverageByTokenId.get(tokenId) ?? 0) + size);
    }

    return coverageByTokenId;
  }

  private hasMeaningfulUncoveredInventory(
    positions: readonly { tokenId: string; shares: number }[],
    sellCoverageByTokenId: ReadonlyMap<string, number>,
    minimumSellQuoteSize: number
  ): boolean {
    return positions.some((position) => {
      const coveredShares = sellCoverageByTokenId.get(position.tokenId) ?? 0;
      const uncoveredShares = Math.max(0, position.shares - coveredShares);
      return uncoveredShares + Number.EPSILON >= Math.min(position.shares, minimumSellQuoteSize);
    });
  }

  private maybeLogTrackedInventoryExecutionDiagnostics(params: {
    market: BinaryMarket;
    trackedInventoryPositions: Array<{
      tokenId: string;
      outcome: string;
      shares: number;
      totalCostUsdc: number;
    }>;
    diagnostics: string[];
    recoveryContext?: {
      filledTokenId: string;
      activatedAtMs: number;
    };
    responseState?: {
      mode: string;
      filledTokenId: string;
      opposingTokenId: string;
      ageMs: number;
      imbalanceShares: number;
      filledInventoryShares: number;
      opposingInventoryShares: number;
    };
    pairInventoryState?: {
      matchedShares: number;
      matchedNetPnlUsdc: number;
      matchedNetEdgeBps: number;
      imbalanceShares: number;
      sideA: { tokenId: string; outcome: string; shares: number };
      sideB: { tokenId: string; outcome: string; shares: number };
    };
    stageQuotes: {
      original: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
      oneSideFillAdjusted: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
      oneSideHardGated: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
      inventoryExitGuarded: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
      buyFillCooldownFiltered: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
      approved: Array<{
        tokenId: string;
        outcome: string;
        side: Side;
        quoteSlot?: string;
        price: number;
        size: number;
        orderType: string;
        postOnly: boolean;
        executionStyle?: string;
      }>;
    };
    rejectedInventoryIntents: Array<{
      tokenId: string;
      side: string;
      quoteSlot?: string;
      price: number;
      size: number;
      reason: string;
      detail?: string;
    }>;
  }): void {
    if (
      params.trackedInventoryPositions.length === 0 &&
      !params.recoveryContext &&
      !params.responseState
    ) {
      return;
    }

    const now = Date.now();
    const signature = JSON.stringify({
      diagnostics: params.diagnostics,
      trackedInventoryPositions: params.trackedInventoryPositions,
      recoveryContext: params.recoveryContext,
      responseState: params.responseState,
      pairInventoryState: params.pairInventoryState,
      approved: params.stageQuotes.approved,
      rejectedInventoryIntents: params.rejectedInventoryIntents
    });
    const lastSignature = this.lastInventoryDiagnosticSignatureByConditionId.get(
      params.market.conditionId
    );
    const lastLoggedAt =
      this.lastInventoryDiagnosticLogAtByConditionId.get(params.market.conditionId) ?? 0;
    const logIntervalMs = params.diagnostics.length > 0 ? 5_000 : 30_000;

    if (lastSignature === signature && now - lastLoggedAt < logIntervalMs) {
      return;
    }

    this.lastInventoryDiagnosticSignatureByConditionId.set(params.market.conditionId, signature);
    this.lastInventoryDiagnosticLogAtByConditionId.set(params.market.conditionId, now);
    this.logger.info(
      {
        market: params.market.slug,
        diagnostics:
          params.diagnostics.length > 0 ? params.diagnostics : ["tracked_inventory_path_active"],
        trackedInventoryPositions: params.trackedInventoryPositions,
        recoveryContext: params.recoveryContext,
        responseState: params.responseState,
        pairInventoryState: params.pairInventoryState,
        stageQuotes: params.stageQuotes,
        rejectedInventoryIntents: params.rejectedInventoryIntents
      },
      "Tracked market-making inventory execution diagnostics."
    );
  }

  private syncExecutionEngineWithActiveQuotes(): void {
    if (!this.quoteExecutor) {
      this.executionEngine.clear();
      return;
    }

    this.executionEngine.clear();

    for (const activeQuote of this.quoteExecutor.getActiveQuotes()) {
      this.executionEngine.upsertActiveOrder(activeQuoteToActiveOrder(activeQuote));
    }

    this.positionManager.syncActiveOrders(this.executionEngine.getActiveOrders());
  }

  private isInsideSellRepostCooldown(tokenId: string): boolean {
    const lastSellFillAtMs = this.lastSellFillAtByTokenId.get(tokenId);
    const lastSellQuoteReleaseAtMs = this.lastSellQuoteReleaseAtByTokenId.get(tokenId);
    const mostRecentSellSettlementAtMs = Math.max(
      lastSellFillAtMs ?? 0,
      lastSellQuoteReleaseAtMs ?? 0
    );

    if (!(mostRecentSellSettlementAtMs > 0) || config.marketMaker.sellRepostCooldownMs <= 0) {
      return false;
    }

    return Date.now() - mostRecentSellSettlementAtMs < config.marketMaker.sellRepostCooldownMs;
  }

  private isSellTemporarilySuppressed(tokenId: string): boolean {
    return (
      this.isInsideSellRepostCooldown(tokenId) ||
      this.isInsideBuyFillSettlementCooldown(tokenId)
    );
  }

  private isInsideBuyFillSettlementCooldown(tokenId: string): boolean {
    const lastBuyFillAtMs = this.lastBuyFillAtByTokenId.get(tokenId);

    if (!lastBuyFillAtMs || config.marketMaker.buyFillSettlementCooldownMs <= 0) {
      return false;
    }

    return Date.now() - lastBuyFillAtMs < config.marketMaker.buyFillSettlementCooldownMs;
  }

  private isBuyReentrySuppressedAfterFill(tokenId: string): boolean {
    const lastBuyFillAtMs = this.lastBuyFillAtByTokenId.get(tokenId);

    if (!lastBuyFillAtMs || config.marketMaker.buyReentryAfterFillCooldownMs <= 0) {
      return false;
    }

    const position = this.inventoryTracker.getOpenPosition(tokenId);
    if (!position || position.shares <= 1e-9) {
      return false;
    }

    return Date.now() - lastBuyFillAtMs < config.marketMaker.buyReentryAfterFillCooldownMs;
  }

  // 🔒 Condition-level BUY suppression. Returns true when ANY BUY on that
  // condition (either YES or NO) filled recently. Blocks BUY on BOTH sides.
  // Separate from tokenId-level suppression so that filling YES also blocks
  // a compensating NO BUY, which would flip the bot into a directional bet.
  private isBuySuppressedByConditionFill(conditionId: string): boolean {
    const cooldownMs = config.marketMaker.conditionBuySuppressionMs;
    if (cooldownMs <= 0) return false;
    const lastFillAtMs = this.lastBuyFillAtByConditionId.get(conditionId);
    if (!lastFillAtMs) return false;
    return Date.now() - lastFillAtMs < cooldownMs;
  }

  private getPostBuySellFeasibilityWindowMs(): number {
    return Math.max(
      config.marketMaker.conditionBuySuppressionMs,
      config.marketMaker.buyReentryAfterFillCooldownMs,
      config.marketUniverse.activityWindowMs,
      config.marketMaker.balanceRefreshMs
    );
  }

  private hasOpenInventoryOnCondition(market: BinaryMarket): boolean {
    return market.tokenIds.some((tokenId) => {
      const position = this.inventoryTracker.getOpenPosition(tokenId);
      return Boolean(position && position.shares > 1e-9);
    });
  }

  private hasThinTopBookOnCondition(market: BinaryMarket): boolean {
    return market.tokenIds.some((tokenId) => {
      const book = this.orderBookStore.get(tokenId);
      const bestBid = book?.bids[0];
      const bestAsk = book?.asks[0];

      if (!bestBid || !bestAsk) {
        return false;
      }

      const topBookLiquidityUsdc =
        bestBid.price * bestBid.size + bestAsk.price * bestAsk.size;

      return (
        Number.isFinite(topBookLiquidityUsdc) &&
        topBookLiquidityUsdc + Number.EPSILON <
          config.marketMaker.minTopBookLiquidityUsdc
      );
    });
  }

  private evaluatePostBuySellFeasibilityBlock(
    market: BinaryMarket,
    nowMs: number = Date.now(),
    tokenIds: readonly string[] = market.tokenIds
  ): Omit<PostBuySellFeasibilityBlock, "observedAtMs" | "untilMs"> | undefined {
    const relevantTokenIds = tokenIds.filter((tokenId) => {
      const position = this.inventoryTracker.getOpenPosition(tokenId);
      return Boolean(position && position.shares > 1e-9);
    });

    if (relevantTokenIds.length === 0) {
      return undefined;
    }

    const selectionSignal = buildMarketSelectionSignal(
      market,
      this.orderBookStore.get.bind(this.orderBookStore),
      this.orderBookStore.getSelectionTelemetry.bind(this.orderBookStore),
      this.displacementTracker?.getDisplacementRate?.bind(this.displacementTracker)
    );
    const requiredConditionRecentTradeEvents = Math.max(
      0,
      config.marketUniverse.minRecentTradeEvents
    );
    const conditionRecentTradeEvents = Math.max(
      0,
      selectionSignal?.recentTradeEventsInWindow ?? 0
    );
    const requiredMaxExitSeconds = Math.max(
      60,
      Math.round((config.marketUniverse.activityWindowMs / 1_000) * 1.5)
    );
    const requiredTokenRecentTradeEvents =
      requiredConditionRecentTradeEvents > 0
        ? Math.max(
            1,
            Math.ceil(requiredConditionRecentTradeEvents / Math.max(1, market.tokenIds.length))
          )
        : 0;
    const requiredBestBidNotionalUsdc = Math.max(
      config.marketUniverse.minBestBidNotionalUsdc,
      config.marketUniverse.minExitDepthMultiplier > 0
        ? config.marketMaker.quoteSize * config.marketUniverse.minExitDepthMultiplier * 0.5
        : 0
    );
    const conditionExpectedExitSeconds = selectionSignal?.expectedExitSeconds;
    const conditionReasons: string[] = [];

    if (
      requiredConditionRecentTradeEvents > 0 &&
      conditionRecentTradeEvents + Number.EPSILON < requiredConditionRecentTradeEvents
    ) {
      conditionReasons.push("condition_recent_trade_flow_below_threshold");
    }

    if (
      typeof conditionExpectedExitSeconds === "number" &&
      conditionExpectedExitSeconds - Number.EPSILON > requiredMaxExitSeconds
    ) {
      conditionReasons.push("condition_expected_exit_too_slow");
    }

    const blockedTokens = relevantTokenIds
      .map<PostBuySellFeasibilityBlockedToken | undefined>((tokenId) => {
        const tokenReasons = [...conditionReasons];
        const telemetry = this.orderBookStore.getSelectionTelemetry(tokenId);
        const recentTradeEvents = Math.max(0, telemetry?.recentTradeEvents ?? 0);
        const book = this.orderBookStore.get(tokenId);
        const openPosition = this.inventoryTracker.getOpenPosition(tokenId);
        const targetExitShares = Math.max(
          openPosition?.shares ?? 0,
          resolveSelectionTargetShares(market)
        );
        const bestBid = book?.bids[0];
        const bestBidNotionalUsdc =
          bestBid && Number.isFinite(bestBid.price) && Number.isFinite(bestBid.size)
            ? Number((bestBid.price * bestBid.size).toFixed(8))
            : undefined;
        const marketableExitNotionalUsdc = estimateMarketableExitNotionalUsdc(
          book,
          targetExitShares
        );
        const requiredMarketableExitNotionalUsdc = Math.max(
          0,
          targetExitShares * Math.max(bestBid?.price ?? 0, 0) * 0.8
        );
        const expectedExitSeconds = estimateExpectedExitSeconds(book, targetExitShares);
        const bookAgeMs =
          book && Number.isFinite(book.updatedAtMs) ? Math.max(0, nowMs - book.updatedAtMs) : undefined;

        if (requiredTokenRecentTradeEvents > 0 && recentTradeEvents < requiredTokenRecentTradeEvents) {
          tokenReasons.push("token_recent_trade_flow_below_threshold");
        }

        if (!bestBid || !Number.isFinite(bestBid.price) || bestBid.price <= 0) {
          tokenReasons.push("missing_best_bid");
        } else if (
          requiredBestBidNotionalUsdc > 0 &&
          (bestBidNotionalUsdc ?? 0) + Number.EPSILON < requiredBestBidNotionalUsdc
        ) {
          tokenReasons.push("best_bid_depth_below_threshold");
        }

        if (
          requiredMarketableExitNotionalUsdc > 0 &&
          (typeof marketableExitNotionalUsdc !== "number" ||
            marketableExitNotionalUsdc + Number.EPSILON < requiredMarketableExitNotionalUsdc)
        ) {
          tokenReasons.push("marketable_exit_depth_below_threshold");
        }

        if (typeof expectedExitSeconds !== "number") {
          tokenReasons.push("missing_exit_velocity");
        } else if (expectedExitSeconds - Number.EPSILON > requiredMaxExitSeconds) {
          tokenReasons.push("expected_exit_too_slow");
        }

        if (
          typeof bookAgeMs === "number" &&
          bookAgeMs - Number.EPSILON > config.strategy.maxBookStalenessMs
        ) {
          tokenReasons.push("stale_orderbook");
        }

        if (tokenReasons.length === 0) {
          return undefined;
        }

        return {
          tokenId,
          recentTradeEvents,
          requiredRecentTradeEvents: requiredTokenRecentTradeEvents,
          bestBidNotionalUsdc,
          requiredBestBidNotionalUsdc,
          marketableExitNotionalUsdc,
          requiredMarketableExitNotionalUsdc,
          expectedExitSeconds,
          requiredMaxExitSeconds,
          reasons: [...new Set(tokenReasons)]
        };
      })
      .filter((token): token is PostBuySellFeasibilityBlockedToken => token !== undefined);

    if (blockedTokens.length === 0 && conditionReasons.length === 0) {
      return undefined;
    }

    return {
      conditionId: market.conditionId,
      reasons: [
        ...new Set([
          ...conditionReasons,
          ...blockedTokens.flatMap((token) => token.reasons)
        ])
      ],
      conditionRecentTradeEvents,
      requiredConditionRecentTradeEvents,
      expectedExitSeconds: conditionExpectedExitSeconds,
      requiredMaxExitSeconds,
      blockedTokens
    };
  }

  private refreshPostBuySellFeasibilityBlock(
    market: BinaryMarket,
    nowMs: number = Date.now(),
    tokenIds?: readonly string[]
  ): PostBuySellFeasibilityBlock | undefined {
    const blockWindowMs = this.getPostBuySellFeasibilityWindowMs();
    const existingBlock = this.postBuySellFeasibilityBlocksByConditionId.get(market.conditionId);
    const lastBuyFillAtMs = this.lastBuyFillAtByConditionId.get(market.conditionId);
    const hasRecentBuyContext =
      typeof lastBuyFillAtMs === "number" && nowMs - lastBuyFillAtMs < blockWindowMs;

    if (!this.hasOpenInventoryOnCondition(market)) {
      this.postBuySellFeasibilityBlocksByConditionId.delete(market.conditionId);
      return undefined;
    }

    if (!existingBlock && !hasRecentBuyContext && !tokenIds) {
      return undefined;
    }

    const nextBlock = this.evaluatePostBuySellFeasibilityBlock(market, nowMs, tokenIds);

    if (!nextBlock) {
      this.postBuySellFeasibilityBlocksByConditionId.delete(market.conditionId);
      return undefined;
    }

    const persistedBlock: PostBuySellFeasibilityBlock = {
      ...nextBlock,
      observedAtMs: nowMs,
      untilMs: Math.max(existingBlock?.untilMs ?? 0, nowMs + blockWindowMs)
    };
    this.postBuySellFeasibilityBlocksByConditionId.set(market.conditionId, persistedBlock);
    return persistedBlock;
  }

  // 📌 Pair imbalance — 양방향 처리:
  //   (a) overweight 쪽 tokenId를 `overweight` set으로 반환 → BUY 차단
  //   (b) underweight 쪽 tokenId를 `underweight` set으로 반환 → BUY inward boost
  // (a)만 있으면 "YES 많이 보유 + NO=0" 상황에서 NO BUY가 소극적이라 실제 balance
  // 복원 안 됨. (b)를 추가해 underweight 쪽을 적극 매수하게 만듦.
  private resolveImbalanceTokens(market: BinaryMarket): {
    overweight: Set<string>;
    underweight: Set<string>;
  } {
    const threshold = config.marketMaker.maxPairImbalanceShares;
    const overweight = new Set<string>();
    const underweight = new Set<string>();
    if (!(threshold > 0)) return { overweight, underweight };
    if (market.tokenIds.length < 2) return { overweight, underweight };
    const [tokenA, tokenB] = market.tokenIds;
    const sharesA = this.inventoryTracker.getOpenShares(tokenA) ?? 0;
    const sharesB = this.inventoryTracker.getOpenShares(tokenB) ?? 0;
    const diff = sharesA - sharesB;
    if (diff >= threshold) {
      overweight.add(tokenA);
      underweight.add(tokenB);
    } else if (-diff >= threshold) {
      overweight.add(tokenB);
      underweight.add(tokenA);
    }
    return { overweight, underweight };
  }

  // Legacy wrapper (keeps old call sites compiling).
  private resolveOverweightTokensForImbalance(market: BinaryMarket): Set<string> {
    return this.resolveImbalanceTokens(market).overweight;
  }

  private noteSellQuoteReleased(tokenId: string, atMs: number = Date.now()): void {
    this.lastSellQuoteReleaseAtByTokenId.set(tokenId, atMs);
    this.quoteExecutor?.invalidateConditionalBalance(tokenId);
  }

  private noteOneSideAggressiveExitRejected(tokenId: string): void {
    const nextCount = (this.oneSideAggressiveExitRejectCountByTokenId.get(tokenId) ?? 0) + 1;
    this.oneSideAggressiveExitRejectCountByTokenId.set(tokenId, nextCount);
  }

  private maybeLogOneSideRecoveryQuoteExecutionEvent(params: {
    eventType: "posted" | "cancelled" | "post-rejected";
    conditionId: string;
    marketSlug: string;
    tokenId: string;
    outcome: string;
    side: Side;
    quoteSlot?: string;
    price: number;
    size: number;
    orderId?: string;
    reason?: string;
    error?: string;
    postOnly?: boolean;
    executionStyle?: string;
  }): void {
    const recoveryContext = this.oneSideFillRecoveryByConditionId.get(params.conditionId);
    const market = this.conditionToMarket.get(params.conditionId);

    if (!recoveryContext || !market) {
      return;
    }

    const opposingTokenId = market.tokenIds.find(
      (tokenId) => tokenId !== recoveryContext.filledTokenId
    );

    if (!opposingTokenId) {
      return;
    }

    let relation: "filled-side-sell" | "opposing-side-buy" | undefined;

    if (params.side === Side.SELL && params.tokenId === recoveryContext.filledTokenId) {
      relation = "filled-side-sell";
    } else if (params.side === Side.BUY && params.tokenId === opposingTokenId) {
      relation = "opposing-side-buy";
    }

    if (!relation) {
      return;
    }

    this.logger.info(
      {
        market: params.marketSlug,
        eventType: params.eventType,
        relation,
        filledTokenId: recoveryContext.filledTokenId,
        opposingTokenId,
        tokenId: params.tokenId,
        outcome: params.outcome,
        side: params.side,
        quoteSlot: params.quoteSlot ?? "primary",
        price: params.price,
        size: params.size,
        orderId: params.orderId,
        postOnly: params.postOnly,
        executionStyle: params.executionStyle,
        reason: params.reason,
        error: params.error
      },
      "Tracked one-side recovery quote execution event."
    );
  }

  private getOneSideAggressiveExitRejectCount(tokenId: string): number {
    return this.oneSideAggressiveExitRejectCountByTokenId.get(tokenId) ?? 0;
  }
}
