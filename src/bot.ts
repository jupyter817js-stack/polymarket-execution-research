import type { ClobClient } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "./config.js";
import type { AlertDispatcher } from "./core/alert-dispatcher.js";
import {
  blendCapitalSignalScores,
  blendScopedCapitalSignals,
  buildMarketScopedCapitalSignals,
  buildScopedPerformanceCapitalSignals,
  buildSameMarketArbCapitalSignal,
  buildStrategyPerformanceCapitalSignal
} from "./core/capital-allocation-signals.js";
import { buildRiskExecutionThrottleSnapshot } from "./core/degraded-execution-policy.js";
import { ExecutionEngine } from "./core/execution-engine.js";
import { InventoryLotTracker } from "./core/inventory-lot-tracker.js";
import { buildInventoryValuationSnapshot } from "./core/inventory-valuation.js";
import { createSeededInventoryLotTracker } from "./core/inventory-lot-seed.js";
import { InventorySnapshotService } from "./core/inventory-snapshot-service.js";
import { recordInventoryCloseResult } from "./core/inventory-pnl.js";
import {
  filterMarketsForSelectionEligibility,
  rankMarketsForSelection,
  type RankedMarketSelection
} from "./core/market-selection.js";
import {
  buildMarketSelectionSignals,
  buildSelectionSignalSubscriptionAssetIds
} from "./core/market-selection-signals.js";
import { PositionManager } from "./core/position-manager.js";
import { RuntimeCheckpointService } from "./core/runtime-checkpoint-service.js";
import { SelectionCooldownState } from "./core/selection-cooldown.js";
import { deriveExecutionNetPnlBreakdown } from "./core/net-pnl.js";
import { PnLEngine } from "./core/pnl-engine.js";
import { buildRiskReductionCandidatesFromMarkets } from "./core/risk-reduction-candidates.js";
import { RiskManager } from "./core/risk-manager.js";
import { buildSameMarketArbIntents } from "./core/same-market-arb-intents.js";
import { StrategyCoordinator } from "./core/strategy-coordinator.js";
import type {
  PnLEngineLike,
  RiskManagerLike,
  RiskStatusSnapshot,
  StrategyName
} from "./core/types.js";
import { PaperTradingSessionService } from "./paper-trading/session-service.js";
import { assessSameMarketPaperFillConfidence } from "./paper-trading/fill-confidence.js";
import { summarizeObservedVenueLatency } from "./paper-trading/observed-venue-latency.js";
import { fetchBinaryMarketsWithDiagnostics } from "./polymarket/gamma.js";
import { RealizedTradingSessionService } from "./session-report/realized-session-service.js";
import { MarketWsManager } from "./polymarket/market-ws.js";
import { OrderBookStore } from "./polymarket/orderbook-store.js";
import { UserWsTracker } from "./polymarket/user-ws.js";
import {
  buildSameMarketOpportunitySnapshot,
  getEffectiveOrderMinSize,
  inspectSameMarketEvaluation
} from "./strategy/arb.js";
import { ArbitrageExecutor } from "./trading/executor.js";
import { RiskReductionExecutor, type RiskReductionCandidate } from "./trading/risk-reduction-executor.js";
import type {
  BinaryMarket,
  SameMarketEvaluation,
  SameMarketOpportunity
} from "./types.js";
import { formatUsd } from "./utils.js";

interface SameMarketRejectionSummaryWindow {
  windowStartedAtMs: number;
  totalRejectedEvaluations: number;
  reasonCounts: Map<string, number>;
  latestReason?: string;
  latestReasonDetail?: string;
}

export class Polybot1 {
  private readonly orderBookStore = new OrderBookStore();
  private readonly tokenToMarket = new Map<string, BinaryMarket>();
  private readonly feeRates = new Map<string, number>();
  private readonly lastSignalAt = new Map<string, number>();
  private readonly lastVerboseLogAt = new Map<string, number>();
  private readonly lastRejectionSummaryLogAt = new Map<string, number>();
  private readonly rejectionSummaryByMarketId = new Map<
    string,
    SameMarketRejectionSummaryWindow
  >();
  private readonly manualTestTriggered = new Set<string>();
  private readonly evaluationLocks = new Set<string>();
  private readonly executionLocks = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly selectionCooldown = new SelectionCooldownState();
  private readonly executionEngine: ExecutionEngine;
  private readonly positionManager: PositionManager;
  private readonly riskManager: RiskManagerLike;
  private readonly pnlEngine: PnLEngineLike;
  private readonly inventoryTracker: InventoryLotTracker;
  private readonly inventorySnapshotService?: InventorySnapshotService;
  private readonly runtimeCheckpointService?: RuntimeCheckpointService;
  private readonly paperTradingSessionService?: PaperTradingSessionService;
  private readonly realizedTradingSessionService?: RealizedTradingSessionService;
  private readonly coordinator: StrategyCoordinator;
  private readonly marketWs: MarketWsManager;
  private readonly executor?: ArbitrageExecutor;
  private readonly riskReductionExecutor?: RiskReductionExecutor;
  private readonly preemptConditionOrders?: (
    conditionId: string,
    incomingStrategy: StrategyName,
    incomingPriority: number
  ) => Promise<void>;
  private readonly alertDispatcher?: AlertDispatcher;
  private lastOpportunityAlertAtMs = 0;
  private latestSelectionCapitalSignalScore = 0.5;
  private latestSelectedEntries: readonly RankedMarketSelection[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly readonlyClient: ClobClient,
    private readonly logger: Logger,
    tradingClient?: ClobClient,
    private readonly userTracker?: UserWsTracker,
    dependencies?: {
      executionEngine?: ExecutionEngine;
      positionManager?: PositionManager;
      riskManager?: RiskManagerLike;
      pnlEngine?: PnLEngineLike;
      inventoryTracker?: InventoryLotTracker;
      paperTradingSessionService?: PaperTradingSessionService;
      preemptConditionOrders?: (
        conditionId: string,
        incomingStrategy: StrategyName,
        incomingPriority: number
      ) => Promise<void>;
      alertDispatcher?: AlertDispatcher;
    }
  ) {
    this.alertDispatcher = dependencies?.alertDispatcher;
    this.executionEngine = dependencies?.executionEngine ?? new ExecutionEngine();
    this.positionManager = dependencies?.positionManager ?? new PositionManager();
    this.riskManager = dependencies?.riskManager ?? new RiskManager(logger);
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
        runtime: "same-market-arb"
      });
      this.runtimeCheckpointService = new RuntimeCheckpointService({
        executionEngine: this.executionEngine,
        pnlEngine: this.pnlEngine,
        riskManager: this.riskManager,
        inventoryTracker: this.inventoryTracker,
        logger,
        runtime: "same-market-arb"
      });
    }
    this.paperTradingSessionService =
      dependencies?.paperTradingSessionService ??
      (config.mode === "dry-run"
        ? new PaperTradingSessionService({
            logger,
            runtime: "same-market-arb"
          })
        : undefined);
    this.realizedTradingSessionService =
      !dependencies?.pnlEngine && config.mode === "live"
        ? new RealizedTradingSessionService({
            logger,
            pnlEngine: this.pnlEngine,
            runtime: "same-market-arb"
          })
        : undefined;
    // Fix N: prune dust lots at startup. Lots below the dust threshold cannot be
    // unwound (Polymarket order min size) and otherwise keep the bot in DEGRADED.
    const dustThreshold = config.inventory.dustThresholdShares;
    if (dustThreshold > 0) {
      const removed = this.inventoryTracker.pruneDustLots(dustThreshold);
      if (removed.length > 0) {
        logger.warn(
          {
            removedCount: removed.length,
            removedLots: removed.map((lot) => ({
              lotId: lot.lotId,
              tokenId: lot.tokenId,
              outcome: lot.outcome,
              sharesRemaining: lot.sharesRemaining,
              totalCostRemainingUsdc: lot.totalCostRemainingUsdc
            })),
            dustThresholdShares: dustThreshold
          },
          "Pruned dust inventory lots at startup."
        );
      }
    }
    this.syncTrackedInventoryLots();
    this.positionManager.setRiskState(this.riskManager.getState?.() ?? "RUNNING");
    const initialRiskSnapshot = this.riskManager.getSnapshot?.();
    if (initialRiskSnapshot) {
      this.positionManager.setRiskSnapshot(initialRiskSnapshot);
    }
    this.coordinator = new StrategyCoordinator({
      executionEngine: this.executionEngine,
      riskManager: this.riskManager,
      positionManager: this.positionManager
    });
    this.preemptConditionOrders = dependencies?.preemptConditionOrders;

    if (
      this.paperTradingSessionService &&
      "subscribe" in this.riskManager &&
      typeof this.riskManager.subscribe === "function"
    ) {
      this.riskManager.subscribe((snapshot: RiskStatusSnapshot) => {
        this.paperTradingSessionService?.noteRiskSnapshot(snapshot);
      });
    }

    if (this.runtimeCheckpointService && this.paperTradingSessionService) {
      this.runtimeCheckpointService.subscribe((snapshot) => {
        this.paperTradingSessionService?.noteCheckpointSnapshot(snapshot);
      });
    }

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

    this.marketWs = new MarketWsManager(this.orderBookStore, logger, (tokenId) => {
      void this.handleTokenUpdate(tokenId);
    });

    if (config.mode === "live" && tradingClient) {
      this.executor = new ArbitrageExecutor(
        tradingClient,
        this.orderBookStore,
        logger,
        this.userTracker
      );
      this.riskReductionExecutor = new RiskReductionExecutor(
        tradingClient,
        this.orderBookStore,
        logger,
        this.userTracker
      );
    }
  }

  async start(): Promise<void> {
    try {
      await this.refreshUniverse();
    } catch (error) {
      this.riskManager.noteApiError?.(
        "same-market-arb.refresh-universe",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshUniverse().catch((error) => {
        this.riskManager.noteApiError?.(
          "same-market-arb.refresh-universe",
          error instanceof Error ? error.message : String(error)
        );
        this.logger.error({ err: error }, "Same-market arbitrage universe refresh failed.");
      });
    }, config.marketUniverse.refreshMs);
    this.inventorySnapshotService?.start();
    this.runtimeCheckpointService?.start();
    this.paperTradingSessionService?.start();
    this.realizedTradingSessionService?.start();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    this.marketWs.closeAll();
    this.inventorySnapshotService?.stop();
    this.runtimeCheckpointService?.stop();
    this.paperTradingSessionService?.stop();
    this.realizedTradingSessionService?.stop();
    this.userTracker?.close();
  }

  getMarkPriceForToken(tokenId: string): number | undefined {
    const bestBid = this.orderBookStore.get(tokenId)?.bids[0]?.price;
    return typeof bestBid === "number" && Number.isFinite(bestBid) ? bestBid : undefined;
  }

  private buildOpenInventoryValuationSnapshot() {
    return buildInventoryValuationSnapshot({
      inventoryTracker: this.inventoryTracker,
      getMarkPriceForToken: (tokenId) => this.getMarkPriceForToken(tokenId)
    });
  }

  getRiskReductionCandidates(): RiskReductionCandidate[] {
    const uniqueMarkets = new Map<string, BinaryMarket>();

    for (const market of this.tokenToMarket.values()) {
      uniqueMarkets.set(market.conditionId, market);
    }

    return buildRiskReductionCandidatesFromMarkets([...uniqueMarkets.values()]);
  }

  async reduceInventoryRisk(reason = "risk halt"): Promise<void> {
    await this.reduceInventoryRiskCandidates(this.getRiskReductionCandidates(), reason);
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
            status: result.status
          }))
      },
      "Completed same-market-arb inventory risk reduction pass."
    );
  }

  private async refreshUniverse(): Promise<void> {
    this.logger.info(
      {
        scanCap: config.marketUniverse.scanCap,
        pageSize: config.marketUniverse.pageSize,
        maxMarkets: config.marketUniverse.maxMarkets
      },
      "Refreshing same-market arbitrage universe."
    );

    const previousConditionIds = new Set(
      [...this.tokenToMarket.values()].map((market) => market.conditionId)
    );
    const { markets, diagnostics } = await fetchBinaryMarketsWithDiagnostics();
    const signalsByConditionId = buildMarketSelectionSignals(
      markets,
      this.orderBookStore.get.bind(this.orderBookStore),
      this.orderBookStore.getSelectionTelemetry.bind(this.orderBookStore)
    );
    const eligibleMarkets = filterMarketsForSelectionEligibility(markets, {
      signalsByConditionId,
      profile: "same-market-arb"
    });
    const selection = rankMarketsForSelection(eligibleMarkets, {
      profile: "same-market-arb",
      maxMarkets: config.marketUniverse.maxMarkets,
      topLogCount: config.marketUniverse.selectionLogTopN,
      signalsByConditionId,
      preferredConditionIds: previousConditionIds
    });
    const cooldown = this.selectionCooldown.apply(
      selection.rankedMarkets.map((entry) => ({
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
    const selectedEntries = selection.rankedMarkets.filter((entry) =>
      cooldown.selected.some((market) => market.conditionId === entry.market.conditionId)
    );
    this.latestSelectedEntries = selectedEntries;
    const capitalSignal = buildSameMarketArbCapitalSignal(selectedEntries);
    this.latestSelectionCapitalSignalScore = capitalSignal.score;
    const selectionScopedCapitalSignals = buildMarketScopedCapitalSignals(selectedEntries);
    const retainedCount = cooldown.retainedIds.length;
    const newConditionIds = cooldown.newIds;
    const droppedConditionIds = cooldown.droppedIds;
    this.tokenToMarket.clear();

    for (const market of selectedMarkets) {
      this.tokenToMarket.set(market.tokenIds[0], market);
      this.tokenToMarket.set(market.tokenIds[1], market);
      this.seedFeeRate(market.tokenIds[0], market);
      this.seedFeeRate(market.tokenIds[1], market);
    }

    this.positionManager.setMarketUniverse(selectedMarkets, "same-market-arb");
    this.refreshDynamicCapitalSignalFromPerformance();
    this.refreshScopedCapitalSignalsFromPerformance();

    const executionAssetIds = [...this.tokenToMarket.keys()];
    const selectionSignalAssetIds = buildSelectionSignalSubscriptionAssetIds(
      eligibleMarkets,
      selectedMarkets
    );
    this.marketWs.replaceSubscriptions(selectionSignalAssetIds);

    if (config.mode === "live" && this.userTracker) {
      this.userTracker.connect(
        [...new Set(selectedMarkets.map((market) => market.conditionId))],
        "market_universe_refresh"
      );
    }

    this.logger.info(
      {
        candidateMarkets: markets.length,
        eligibleMarkets: eligibleMarkets.length,
        markets: selectedMarkets.length,
        retainedMarkets: retainedCount,
        newMarkets: newConditionIds.length,
        droppedMarkets: droppedConditionIds.length,
        forcedHeldMarkets: cooldown.forcedHoldIds.length,
        blockedReentries: cooldown.blockedReentryIds.length,
        capitalSignal,
        scopedCapitalSignalCounts: {
          conditions: selectionScopedCapitalSignals.byConditionId.size,
          events: selectionScopedCapitalSignals.byEventId.size
        },
        marketsWithSelectionSignals: signalsByConditionId.size,
        assets: selectionSignalAssetIds.length,
        executionAssets: executionAssetIds.length,
        selectionSignalMarkets: eligibleMarkets.length,
        minMarketLiquidity: config.marketUniverse.minMarketLiquidity,
        universeFetch: diagnostics,
        marketSelection: selection.diagnostics,
        mode: config.mode
      },
      "Market universe refreshed."
    );
  }

  private async handleTokenUpdate(tokenId: string): Promise<void> {
    const market = this.tokenToMarket.get(tokenId);

    if (!market) {
      return;
    }

    const bookA = this.orderBookStore.get(market.tokenIds[0]);
    const bookB = this.orderBookStore.get(market.tokenIds[1]);

    if (!bookA || !bookB) {
      return;
    }

    const now = Date.now();
    const cooldownUntil = this.cooldownUntil.get(market.conditionId) ?? 0;

    if (cooldownUntil > now) {
      return;
    }

    if (this.executionLocks.has(market.conditionId) || this.evaluationLocks.has(market.conditionId)) {
      return;
    }

    this.evaluationLocks.add(market.conditionId);

    try {
      const feeRateA = await this.resolveFeeRate(market.tokenIds[0], market.feesEnabled);
      const feeRateB = await this.resolveFeeRate(market.tokenIds[1], market.feesEnabled);
      const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, feeRateA, feeRateB);

      this.maybeLogVerboseEvaluation(evaluation, now);
      this.maybeLogRejectionSummary(evaluation, now);

      if (evaluation.status !== "opportunity") {
        const forced = await this.maybeRunManualTest(
          market,
          bookA,
          bookB,
          feeRateA,
          feeRateB,
          now
        );

        if (forced) {
          return;
        }
      }

      if (evaluation.status !== "opportunity") {
        return;
      }

      const opportunity = evaluation.opportunity;
      const signalCooldownMs = this.getEffectiveSignalCooldownMs();
      const executionCooldownMs = this.getEffectiveExecutionCooldownMs();

      const lastSignalAt = this.lastSignalAt.get(market.conditionId) ?? 0;

      if (now - lastSignalAt < signalCooldownMs) {
        return;
      }

      this.lastSignalAt.set(market.conditionId, now);

      if (config.mode === "dry-run") {
        this.logOpportunity(opportunity);
        this.recordPaperOpportunity(opportunity);
        return;
      }

      if (!this.executor) {
        return;
      }

      this.executionLocks.add(market.conditionId);
      this.cooldownUntil.set(market.conditionId, now + executionCooldownMs);

      try {
        await this.tryExecuteOpportunity(opportunity);
      } catch (error) {
        this.riskManager.noteOrderFailure?.(
          "same-market-arb.execute",
          `${market.slug}:${error instanceof Error ? error.message : String(error)}`
        );
        this.logger.error({ err: error, market: market.slug }, "Arbitrage execution failed.");
      } finally {
        this.executionLocks.delete(market.conditionId);
      }
    } finally {
      this.evaluationLocks.delete(market.conditionId);
    }
  }

  private async maybeRunManualTest(
    market: BinaryMarket,
    bookA: NonNullable<ReturnType<OrderBookStore["get"]>>,
    bookB: NonNullable<ReturnType<OrderBookStore["get"]>>,
    feeRateA: number,
    feeRateB: number,
    now: number
  ): Promise<boolean> {
    if (!config.manualTest.forceOpportunity) {
      return false;
    }

    if (!config.manualTest.marketSlug || config.manualTest.marketSlug !== market.slug) {
      return false;
    }

    if (config.manualTest.runOnce && this.manualTestTriggered.has(market.conditionId)) {
      return false;
    }

    const opportunity = buildSameMarketOpportunitySnapshot(market, bookA, bookB, feeRateA, feeRateB);
    const effectiveOrderMinSize = getEffectiveOrderMinSize(market, bookA, bookB);

    if (!opportunity) {
      this.logger.warn(
        {
          market: market.slug,
          question: market.question,
          configuredTargetShares: config.strategy.targetShares,
          targetOrderNotionalUsdc: config.strategy.targetOrderNotionalUsdc,
          marketOrderMinSize: market.orderMinSize,
          bookOrderMinSizeA: bookA.minOrderSize,
          bookOrderMinSizeB: bookB.minOrderSize,
          effectiveOrderMinSize
        },
        "Manual test mode matched this market, but the books are still not executable at the target size."
      );
      return false;
    }

    this.manualTestTriggered.add(market.conditionId);
    this.cooldownUntil.set(market.conditionId, now + this.getEffectiveExecutionCooldownMs());

    this.logger.warn(
      {
        market: market.slug,
        question: market.question,
        grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
        grossEdge: opportunity.grossEdge.toFixed(4),
        netEdge: opportunity.netEdge.toFixed(4),
        allowLiveExecution: config.manualTest.allowLiveExecution,
        maxGrossCostPerShare: config.manualTest.maxGrossCostPerShare.toFixed(4)
      },
      "Manual test mode forced this market into the execution path."
    );

    if (config.mode === "dry-run" || !config.manualTest.allowLiveExecution) {
      this.logOpportunity(opportunity);
      this.recordPaperOpportunity(opportunity);
      this.logger.warn(
        {
          market: market.slug
        },
        "Manual test stopped before live posting because the bot is in dry-run mode or live execution is not explicitly allowed."
      );
      return true;
    }

    if (!this.executor) {
      return true;
    }

    if (opportunity.grossCostPerShare > config.manualTest.maxGrossCostPerShare) {
      this.logger.error(
        {
          market: market.slug,
          grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
          maxGrossCostPerShare: config.manualTest.maxGrossCostPerShare.toFixed(4)
        },
        "Manual live execution was blocked by the configured gross cost safety cap."
      );
      return true;
    }

    this.executionLocks.add(market.conditionId);

    try {
      await this.tryExecuteOpportunity(opportunity);
    } catch (error) {
      this.riskManager.noteOrderFailure?.(
        "same-market-arb.manual-test",
        `${market.slug}:${error instanceof Error ? error.message : String(error)}`
      );
      this.logger.error({ err: error, market: market.slug }, "Manual test execution failed.");
    } finally {
      this.executionLocks.delete(market.conditionId);
    }

    return true;
  }

  private recordPaperOpportunity(opportunity: SameMarketOpportunity): void {
    if (!this.paperTradingSessionService) {
      return;
    }

    const intents = buildSameMarketArbIntents(opportunity);
    const coordination = this.coordinator.coordinate(intents);
    const fullyApproved = coordination.approvedIntents.length === intents.length;
    const pnlBreakdown = deriveExecutionNetPnlBreakdown({
      grossRealizedPnlUsdc: opportunity.grossEdge,
      expectedGrossEdgeUsdc: opportunity.grossEdge,
      feeCostUsdc: opportunity.feeCost,
      completion: "fully-filled"
    });
    const fillAssessment = assessSameMarketPaperFillConfidence(
      opportunity,
      new Map(
        opportunity.legs.flatMap((leg) => {
          const book = this.orderBookStore.get(leg.tokenId);
          return book ? ([[leg.tokenId, book]] as const) : [];
        })
      )
    );
    const observedVenueLatency = summarizeObservedVenueLatency({
      detectedAtMs: opportunity.detectedAtMs,
      books: opportunity.legs.map((leg) => this.orderBookStore.get(leg.tokenId))
    });
    const rejectionReason = fullyApproved
      ? "dry_run_coordinator_approved"
      : [
          ...new Set(
            coordination.rejected.map((rejected) => rejected.reason)
          )
        ].join(",");

    this.paperTradingSessionService.recordTrade({
      id: `same-market-arb:paper:${opportunity.market.conditionId}:${opportunity.detectedAtMs}`,
      strategy: "same-market-arb",
      marketScope: opportunity.market.slug,
      conditionId: opportunity.market.conditionId,
      status: fullyApproved ? "filled" : "not_filled",
      expectedRealizedPnlUsdc: Number(pnlBreakdown.realizedPnlUsdc.toFixed(8)),
      expectedGrossEdgeUsdc: Number(opportunity.grossEdge.toFixed(8)),
      realizedPnlUsdc: fullyApproved ? Number(pnlBreakdown.realizedPnlUsdc.toFixed(8)) : undefined,
      grossRealizedPnlUsdc: fullyApproved ? Number(opportunity.grossEdge.toFixed(8)) : undefined,
      feeCostUsdc: Number(opportunity.feeCost.toFixed(8)),
      simulatedFillLatencyMs: 0,
      observedVenueLatencyMs: observedVenueLatency.observedVenueLatencyMs,
      observedBookSkewMs: observedVenueLatency.observedBookSkewMs,
      depthCoverageRatio: fillAssessment.depthCoverageRatio,
      fillConfidence: fillAssessment.fillConfidence,
      shares: opportunity.shares,
      reason: rejectionReason,
      tags: ["dry-run-runtime", "same-market-arb"]
    });
  }

  private getEffectiveSignalCooldownMs(): number {
    const throttle = buildRiskExecutionThrottleSnapshot(this.riskManager.getSnapshot?.());
    return Math.max(
      1,
      Math.round(config.execution.signalCooldownMs * throttle.signalCooldownMultiplier)
    );
  }

  private getEffectiveExecutionCooldownMs(): number {
    const throttle = buildRiskExecutionThrottleSnapshot(this.riskManager.getSnapshot?.());
    return Math.max(
      1,
      Math.round(config.execution.executionCooldownMs * throttle.executionCooldownMultiplier)
    );
  }

  private logOpportunity(opportunity: SameMarketOpportunity): void {
    this.logger.info(
      {
        market: opportunity.market.slug,
        question: opportunity.market.question,
        configuredTargetShares: config.strategy.targetShares,
        shares: opportunity.shares,
        sharesAutoAdjusted: opportunity.shares > config.strategy.targetShares,
        targetOrderNotionalUsdc: config.strategy.targetOrderNotionalUsdc,
        legA: {
          outcome: opportunity.legs[0].outcome,
          averagePrice: opportunity.legs[0].fill.averagePrice.toFixed(4),
          worstPrice: opportunity.legs[0].limitPrice.toFixed(4)
        },
        legB: {
          outcome: opportunity.legs[1].outcome,
          averagePrice: opportunity.legs[1].fill.averagePrice.toFixed(4),
          worstPrice: opportunity.legs[1].limitPrice.toFixed(4)
        },
        grossCost: formatUsd(opportunity.grossCost),
        grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
        feeCost: formatUsd(opportunity.feeCost),
        netEdge: formatUsd(opportunity.netEdge),
        netEdgeBpsOnPar: opportunity.netEdgeBpsOnPar.toFixed(2)
      },
      config.mode === "dry-run" ? "Arbitrage opportunity detected." : "Arbitrage opportunity accepted."
    );

    // 텔레그램 실시간 알림 — arb opportunity 발견 (60초 cooldown 으로 noise 제어)
    const nowMs = Date.now();
    if (this.alertDispatcher && nowMs - this.lastOpportunityAlertAtMs > 60_000) {
      this.lastOpportunityAlertAtMs = nowMs;
      const isDryRun = config.mode === "dry-run";
      const titlePrefix = isDryRun ? "🟡 [DRY-RUN]" : "🎯";
      const isSingleLevel = (avg: number, worst: number) => Math.abs(avg - worst) < 1e-6;
      const legAsingle = isSingleLevel(opportunity.legs[0].fill.averagePrice, opportunity.legs[0].fill.worstPrice);
      const legBsingle = isSingleLevel(opportunity.legs[1].fill.averagePrice, opportunity.legs[1].fill.worstPrice);
      const singleCount = (legAsingle ? 1 : 0) + (legBsingle ? 1 : 0);
      const depthLabel =
        singleCount === 2
          ? "DEEP ✓ (2/2 단일레벨)"
          : `THIN ⚠ (${singleCount}/2 단일레벨)`;
      void this.alertDispatcher.dispatch({
        schemaVersion: 1,
        category: "arb_opportunity",
        severity: "info",
        title: `${titlePrefix} Same-market arb 기회`,
        summary:
          `${opportunity.market.slug.slice(0, 50)}\n` +
          `· ${opportunity.shares}주 × $${opportunity.grossCostPerShare.toFixed(4)}\n` +
          `· 투입 $${opportunity.grossCost.toFixed(2)} → 회수 $${opportunity.shares.toFixed(2)} → 차익 $${opportunity.netEdge.toFixed(4)} (${opportunity.netEdgeBpsOnPar.toFixed(0)} bps)\n` +
          `· 물량: ${depthLabel}`,
        occurredAtMs: nowMs,
        runtime: "same-market-arb",
        tags: ["same-market-arb", "opportunity", isDryRun ? "dry-run" : "live"],
        details: {
          market: opportunity.market.slug,
          question: opportunity.market.question,
          shares: opportunity.shares,
          legA: {
            outcome: opportunity.legs[0].outcome,
            averagePrice: opportunity.legs[0].fill.averagePrice,
            worstPrice: opportunity.legs[0].fill.worstPrice,
            singleLevel: legAsingle
          },
          legB: {
            outcome: opportunity.legs[1].outcome,
            averagePrice: opportunity.legs[1].fill.averagePrice,
            worstPrice: opportunity.legs[1].fill.worstPrice,
            singleLevel: legBsingle
          },
          depth: { totalLegs: 2, singleLevelLegs: singleCount, multiLevelLegs: 2 - singleCount },
          grossCostUsdc: opportunity.grossCost,
          netEdgeUsdc: opportunity.netEdge,
          netEdgeBpsOnPar: opportunity.netEdgeBpsOnPar
        }
      }).catch((err) => {
        this.logger.debug({ err }, "Failed to dispatch arb opportunity alert.");
      });
    }
  }

  private async tryExecuteOpportunity(opportunity: SameMarketOpportunity): Promise<void> {
    if (!this.executor) {
      return;
    }

    const intents = buildSameMarketArbIntents(opportunity);
    const incomingPriority = intents[0]?.priority ?? 0;
    const lowerPriorityOrders = this.executionEngine
      .getActiveOrdersForCondition(opportunity.market.conditionId)
      .filter(
        (order) =>
          order.strategy !== "same-market-arb" && order.priority < incomingPriority
      );

    if (lowerPriorityOrders.length > 0) {
      if (!this.preemptConditionOrders) {
        this.logger.warn(
          {
            market: opportunity.market.slug,
            conditionId: opportunity.market.conditionId,
            blockingStrategies: [...new Set(lowerPriorityOrders.map((order) => order.strategy))]
          },
          "Skipped arbitrage execution because lower-priority orders existed but no preemption hook was available."
        );
        return;
      }

      await this.preemptConditionOrders(
        opportunity.market.conditionId,
        "same-market-arb",
        incomingPriority
      );
    }

    const coordination = this.coordinator.coordinate(intents);

    if (coordination.approvedIntents.length !== intents.length) {
      this.logger.warn(
        {
          market: opportunity.market.slug,
          conditionId: opportunity.market.conditionId,
          approvedIntents: coordination.approvedIntents.length,
          totalIntents: intents.length,
          rejected: coordination.rejected.map((rejected) => ({
            tokenId: rejected.intent.tokenId,
            side: rejected.intent.side,
            reason: rejected.reason,
            detail: rejected.detail
          }))
        },
        "Skipped arbitrage execution because one or more entry intents were not approved by the coordinator."
      );
      return;
    }

    this.logOpportunity(opportunity);
    const summary = await this.executor.execute(opportunity);
    this.trackOpenedPositions(summary, opportunity);

    if (typeof summary.realizedPnlUsdc === "number") {
      const pnlBreakdown = deriveExecutionNetPnlBreakdown({
        grossRealizedPnlUsdc: summary.realizedPnlUsdc,
        expectedGrossEdgeUsdc: opportunity.grossEdge,
        feeCostUsdc: opportunity.feeCost,
        completion:
          summary.status === "fully_filled"
            ? "fully-filled"
            : summary.status === "recovered_pair"
              ? "recovered-pair"
              : summary.status === "emergency_unwind"
                ? "emergency-unwind"
                : "residual-exposure"
      });
      this.pnlEngine.recordTrade({
        id: `same-market-arb:${opportunity.market.conditionId}:${opportunity.detectedAtMs}:${summary.status}`,
        strategy: "same-market-arb",
        marketScope: opportunity.market.slug,
        conditionId: opportunity.market.conditionId,
        realizedPnlUsdc: pnlBreakdown.realizedPnlUsdc,
        grossRealizedPnlUsdc: pnlBreakdown.grossRealizedPnlUsdc,
        feeCostUsdc: pnlBreakdown.feeCostUsdc,
        rebateUsdc: pnlBreakdown.rebateUsdc,
        rewardUsdc: pnlBreakdown.rewardUsdc,
        slippageCostUsdc: pnlBreakdown.slippageCostUsdc,
        unfilledCostUsdc: pnlBreakdown.unfilledCostUsdc,
        gasCostUsdc: pnlBreakdown.gasCostUsdc,
        expectedEdgeUsdc: opportunity.netEdge,
        shares: opportunity.shares,
        openedAtMs: opportunity.detectedAtMs,
        closedAtMs: Date.now(),
        createdAtMs: opportunity.detectedAtMs,
        firstFillAtMs: summary.firstFillAtMs,
        partialFillCount: summary.partialFillCount,
        failureReason: summary.status === "emergency_unwind" || summary.status === "residual_exposure"
          ? summary.detail
          : undefined,
        detail: summary.detail,
        tags: ["same-market-arb", summary.status],
        metadata: {
          eventId: opportunity.market.eventId,
          category: opportunity.market.category,
          grossCostPerShare: Number(opportunity.grossCostPerShare.toFixed(6)),
          netEdgeBpsOnPar: Number(opportunity.netEdgeBpsOnPar.toFixed(4)),
          expectedGrossEdgeUsdc: Number(opportunity.grossEdge.toFixed(6))
        }
      });
      this.refreshDynamicCapitalSignalFromPerformance();
      this.refreshScopedCapitalSignalsFromPerformance();
      this.riskManager.noteTradeClosed?.(
        pnlBreakdown.realizedPnlUsdc,
        "same-market-arb.execution",
        `${opportunity.market.slug}:${summary.status}`
      );
    }

    if (summary.stateMismatchDetail) {
      this.riskManager.noteStateMismatch?.(
        "same-market-arb.balance-reconciliation",
        `${opportunity.market.slug}:${summary.stateMismatchDetail}`
      );
    }

    if (summary.status === "residual_exposure") {
      this.riskManager.noteStateMismatch?.(
        "same-market-arb.execution",
        `${opportunity.market.slug}:${summary.detail ?? "Residual exposure remained after recovery flow."}`
      );
    }
  }

  private trackOpenedPositions(
    summary: Awaited<ReturnType<ArbitrageExecutor["execute"]>>,
    opportunity: SameMarketOpportunity
  ): void {
    let inventoryChanged = false;

    for (const [index, position] of (summary.openedPositions ?? []).entries()) {
      this.inventoryTracker.addLot({
        lotId: `same-market-arb:${opportunity.market.conditionId}:${opportunity.detectedAtMs}:${position.tokenId}:${index}`,
        strategy: "same-market-arb",
        tokenId: position.tokenId,
        marketScope: position.marketScope,
        conditionId: position.conditionId,
        outcome: position.outcome,
        shares: position.shares,
        totalCostUsdc: position.totalCostUsdc,
        openedAtMs: position.openedAtMs,
        metadata: {
          executionSource: "same-market-arb",
          marketSlug: opportunity.market.slug
        }
      });
      inventoryChanged = true;
    }

    if (inventoryChanged) {
      this.syncTrackedInventoryLots();
    }
  }

  private recordRiskReductionSummary(
    summary: Awaited<ReturnType<RiskReductionExecutor["reduceCandidates"]>>,
    reason: string
  ): void {
    let inventoryChanged = false;

    for (const result of summary.results) {
      if (result.status !== "reduced" || !result.reducedShares || !result.proceedsUsdc) {
        continue;
      }

      const closeResult = this.inventoryTracker.closeLots({
        tokenId: result.tokenId,
        shares: result.reducedShares,
        proceedsUsdc: result.proceedsUsdc,
        closedAtMs: Date.now(),
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
      inventoryChanged = true;
    }

    if (inventoryChanged) {
      this.syncTrackedInventoryLots();
      this.refreshDynamicCapitalSignalFromPerformance();
      this.refreshScopedCapitalSignalsFromPerformance();
    }
  }

  private syncTrackedInventoryLots(): void {
    this.positionManager.syncTrackedInventoryLots(this.inventoryTracker.exportOpenLots());
  }

  private refreshDynamicCapitalSignalFromPerformance(): void {
    const performanceSignal = buildStrategyPerformanceCapitalSignal([
      this.pnlEngine.getStrategySnapshot("same-market-arb")
    ]);
    const blendedSignalScore = blendCapitalSignalScores(
      this.latestSelectionCapitalSignalScore,
      performanceSignal.score
    );

    this.positionManager.setStrategyCapitalSignal("same-market-arb", blendedSignalScore);
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
      relevantStrategies: ["same-market-arb"],
      conditionToEventId,
      conditionToCategory
    });
    const blendedSignals = blendScopedCapitalSignals(selectionSignals, performanceSignals);

    this.positionManager.setConditionCapitalSignals(
      blendedSignals.byConditionId,
      "same-market-arb"
    );
    this.positionManager.setEventCapitalSignals(
      blendedSignals.byEventId,
      "same-market-arb"
    );
  }

  private describeRejectionReason(evaluation: SameMarketEvaluation): string | undefined {
    if (evaluation.status !== "rejected") {
      return undefined;
    }

    const { diagnostics, reason } = evaluation;

    switch (reason) {
      case "stale_book_leg_a":
        return `${diagnostics.legA.outcome} bookAgeMs(${diagnostics.legA.bookAgeMs}) > maxBookStalenessMs(${diagnostics.maxBookStalenessMs})`;
      case "stale_book_leg_b":
        return `${diagnostics.legB.outcome} bookAgeMs(${diagnostics.legB.bookAgeMs}) > maxBookStalenessMs(${diagnostics.maxBookStalenessMs})`;
      case "book_timestamp_skew_too_wide":
        return `bookTimestampSkewMs(${diagnostics.bookTimestampSkewMs}) > maxBookSkewMs(${diagnostics.maxBookSkewMs})`;
      case "target_shares_below_order_min_size":
        return `targetShares(${diagnostics.shares}) < effectiveOrderMinSize(${diagnostics.effectiveOrderMinSize})`;
      case "insufficient_depth_leg_a":
        return `${diagnostics.legA.outcome} side has insufficient ask depth for ${diagnostics.shares} shares`;
      case "insufficient_depth_leg_b":
        return `${diagnostics.legB.outcome} side has insufficient ask depth for ${diagnostics.shares} shares`;
      case "entry_depth_ratio_too_shallow_leg_a":
        return `${diagnostics.legA.outcome} executableDepthAtLimit(${diagnostics.legA.executableDepthAtLimit?.toFixed(4) ?? "n/a"}) < requiredDepthAtLimit(${diagnostics.legA.requiredDepthAtLimit?.toFixed(4) ?? "n/a"})`;
      case "entry_depth_ratio_too_shallow_leg_b":
        return `${diagnostics.legB.outcome} executableDepthAtLimit(${diagnostics.legB.executableDepthAtLimit?.toFixed(4) ?? "n/a"}) < requiredDepthAtLimit(${diagnostics.legB.requiredDepthAtLimit?.toFixed(4) ?? "n/a"})`;
      case "gross_cost_above_entry_cap":
        return `grossCostPerShare(${diagnostics.grossCostPerShare?.toFixed(4) ?? "n/a"}) > maxEntryGrossCostPerShare(${diagnostics.maxEntryGrossCostPerShare.toFixed(4)})`;
      case "gross_edge_non_positive":
        return `grossEdge(${diagnostics.grossEdge?.toFixed(4) ?? "n/a"}) <= 0`;
      case "marketable_buy_min_notional_leg_a":
        return `${diagnostics.legA.outcome} orderNotional(${diagnostics.legA.orderNotional?.toFixed(4) ?? "n/a"}) < marketableBuyMinNotional(1.0000)`;
      case "marketable_buy_min_notional_leg_b":
        return `${diagnostics.legB.outcome} orderNotional(${diagnostics.legB.orderNotional?.toFixed(4) ?? "n/a"}) < marketableBuyMinNotional(1.0000)`;
      case "marketable_buy_precision_invalid_leg_a":
        return `${diagnostics.legA.outcome} order would exceed marketable BUY precision constraints at limitPrice(${diagnostics.legA.limitPrice?.toFixed(4) ?? "n/a"})`;
      case "marketable_buy_precision_invalid_leg_b":
        return `${diagnostics.legB.outcome} order would exceed marketable BUY precision constraints at limitPrice(${diagnostics.legB.limitPrice?.toFixed(4) ?? "n/a"})`;
      case "net_edge_below_min_usdc":
        return `netEdge(${diagnostics.netEdge?.toFixed(4) ?? "n/a"}) < minNetEdgeUsdc(${config.strategy.minNetEdgeUsdc})`;
      case "net_edge_below_min_bps":
        return `netEdgeBpsOnPar(${diagnostics.netEdgeBpsOnPar?.toFixed(2) ?? "n/a"}) < minNetEdgeBps(${config.strategy.minNetEdgeBps})`;
      default:
        return reason;
    }
  }

  private maybeLogRejectionSummary(evaluation: SameMarketEvaluation, now: number): void {
    if (config.observability.verboseMarketLogs || evaluation.status !== "rejected") {
      return;
    }

    const market = evaluation.diagnostics.market;
    const marketId = market.conditionId;
    let summary = this.rejectionSummaryByMarketId.get(marketId);

    if (!summary) {
      summary = {
        windowStartedAtMs: now,
        totalRejectedEvaluations: 0,
        reasonCounts: new Map()
      };
      this.rejectionSummaryByMarketId.set(marketId, summary);
      this.lastRejectionSummaryLogAt.set(marketId, now);
    }

    summary.totalRejectedEvaluations += 1;
    summary.reasonCounts.set(
      evaluation.reason,
      (summary.reasonCounts.get(evaluation.reason) ?? 0) + 1
    );
    summary.latestReason = evaluation.reason;
    summary.latestReasonDetail = this.describeRejectionReason(evaluation);

    const lastLoggedAt = this.lastRejectionSummaryLogAt.get(marketId) ?? now;

    if (now - lastLoggedAt < config.observability.verboseMarketLogIntervalMs) {
      return;
    }

    const reasonCounts = [...summary.reasonCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([reason, count]) => ({ reason, count }));

    this.logger.info(
      {
        market: market.slug,
        question: market.question,
        windowMs: now - summary.windowStartedAtMs,
        totalRejectedEvaluations: summary.totalRejectedEvaluations,
        rejectionReasons: reasonCounts,
        latestRejectionReason: summary.latestReason,
        latestRejectionReasonDetail: summary.latestReasonDetail
      },
      "Same-market arbitrage evaluation summary."
    );

    this.lastRejectionSummaryLogAt.set(marketId, now);
    this.rejectionSummaryByMarketId.set(marketId, {
      windowStartedAtMs: now,
      totalRejectedEvaluations: 0,
      reasonCounts: new Map()
    });
  }

  private maybeLogVerboseEvaluation(evaluation: SameMarketEvaluation, now: number): void {
    if (!config.observability.verboseMarketLogs) {
      return;
    }

    const marketId = evaluation.diagnostics.market.conditionId;
    const lastLoggedAt = this.lastVerboseLogAt.get(marketId) ?? 0;

    if (now - lastLoggedAt < config.observability.verboseMarketLogIntervalMs) {
      return;
    }

    this.lastVerboseLogAt.set(marketId, now);

    const { diagnostics } = evaluation;
    this.logger.info(
        {
          market: diagnostics.market.slug,
          question: diagnostics.market.question,
          configuredTargetShares: diagnostics.configuredTargetShares,
          shares: diagnostics.shares,
          sharesAutoAdjusted: diagnostics.sharesAutoAdjusted,
          marketOrderMinSize: diagnostics.marketOrderMinSize,
          bookOrderMinSizeA: diagnostics.bookOrderMinSizeA,
          bookOrderMinSizeB: diagnostics.bookOrderMinSizeB,
        effectiveOrderMinSize: diagnostics.effectiveOrderMinSize,
        comparedOutcomes: `${diagnostics.legA.outcome} vs ${diagnostics.legB.outcome}`,
        topOfBookSum:
          diagnostics.topOfBookSum !== undefined
            ? diagnostics.topOfBookSum.toFixed(4)
            : undefined,
        threshold: {
          maxBookStalenessMs: diagnostics.maxBookStalenessMs,
          maxBookSkewMs: diagnostics.maxBookSkewMs,
          maxEntryGrossCostPerShare: diagnostics.maxEntryGrossCostPerShare,
          entryMinDepthRatio: diagnostics.entryMinDepthRatio,
          targetOrderNotionalUsdc: diagnostics.targetOrderNotionalUsdc,
          minNetEdgeUsdc: config.strategy.minNetEdgeUsdc,
          minNetEdgeBps: config.strategy.minNetEdgeBps
        },
        bookTimestampSkewMs: diagnostics.bookTimestampSkewMs,
        legA: {
          outcome: diagnostics.legA.outcome,
          updatedAtMs: diagnostics.legA.updatedAtMs,
          bookAgeMs: diagnostics.legA.bookAgeMs,
          bestAsk: diagnostics.legA.bestAsk?.toFixed(4),
          availableDepth: diagnostics.legA.availableDepth?.toFixed(4),
          averagePrice: diagnostics.legA.averagePrice?.toFixed(4),
          worstPrice: diagnostics.legA.worstPrice?.toFixed(4),
          limitPrice: diagnostics.legA.limitPrice?.toFixed(4),
          executableDepthAtLimit: diagnostics.legA.executableDepthAtLimit?.toFixed(4),
          requiredDepthAtLimit: diagnostics.legA.requiredDepthAtLimit?.toFixed(4),
          feeRateBps: diagnostics.legA.feeRateBps
        },
        legB: {
          outcome: diagnostics.legB.outcome,
          updatedAtMs: diagnostics.legB.updatedAtMs,
          bookAgeMs: diagnostics.legB.bookAgeMs,
          bestAsk: diagnostics.legB.bestAsk?.toFixed(4),
          availableDepth: diagnostics.legB.availableDepth?.toFixed(4),
          averagePrice: diagnostics.legB.averagePrice?.toFixed(4),
          worstPrice: diagnostics.legB.worstPrice?.toFixed(4),
          limitPrice: diagnostics.legB.limitPrice?.toFixed(4),
          executableDepthAtLimit: diagnostics.legB.executableDepthAtLimit?.toFixed(4),
          requiredDepthAtLimit: diagnostics.legB.requiredDepthAtLimit?.toFixed(4),
          feeRateBps: diagnostics.legB.feeRateBps
        },
        grossCost: diagnostics.grossCost !== undefined ? formatUsd(diagnostics.grossCost) : undefined,
        grossCostPerShare:
          diagnostics.grossCostPerShare !== undefined
            ? diagnostics.grossCostPerShare.toFixed(4)
            : undefined,
        grossEdge: diagnostics.grossEdge !== undefined ? formatUsd(diagnostics.grossEdge) : undefined,
        feeCost: diagnostics.feeCost !== undefined ? formatUsd(diagnostics.feeCost) : undefined,
        netEdge: diagnostics.netEdge !== undefined ? formatUsd(diagnostics.netEdge) : undefined,
        netEdgeBpsOnPar:
          diagnostics.netEdgeBpsOnPar !== undefined
            ? diagnostics.netEdgeBpsOnPar.toFixed(2)
            : undefined,
        evaluationStatus: evaluation.status,
        rejectionReason: evaluation.status === "rejected" ? evaluation.reason : undefined,
        rejectionReasonDetail: this.describeRejectionReason(evaluation)
      },
      evaluation.status === "opportunity"
        ? "Verbose market comparison: opportunity passed all conditions."
        : "Verbose market comparison: rejected."
    );
  }

  private seedFeeRate(tokenId: string, market: BinaryMarket): void {
    if (this.feeRates.has(tokenId)) {
      return;
    }

    if (typeof config.strategy.feeRateOverrideBps === "number") {
      this.feeRates.set(tokenId, config.strategy.feeRateOverrideBps);
      return;
    }

    if (!market.feesEnabled) {
      this.feeRates.set(tokenId, 0);
    }
  }

  private async resolveFeeRate(tokenId: string, feesEnabled: boolean): Promise<number> {
    const cached = this.feeRates.get(tokenId);

    if (typeof cached === "number") {
      return cached;
    }

    if (!feesEnabled) {
      this.feeRates.set(tokenId, 0);
      return 0;
    }

    const feeRate = await this.readonlyClient.getFeeRateBps(tokenId);
    this.feeRates.set(tokenId, feeRate);
    return feeRate;
  }
}
