import type { ClobClient } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "./config.js";
import type { AlertDispatcher } from "./core/alert-dispatcher.js";
import {
  blendCapitalSignalScores,
  blendScopedCapitalSignals,
  buildNegativeRiskCapitalSignal,
  buildNegativeRiskScopedCapitalSignals,
  buildScopedPerformanceCapitalSignals,
  buildStrategyPerformanceCapitalSignal
} from "./core/capital-allocation-signals.js";
import { buildRiskExecutionThrottleSnapshot } from "./core/degraded-execution-policy.js";
import { ExecutionEngine } from "./core/execution-engine.js";
import { InventoryLotTracker } from "./core/inventory-lot-tracker.js";
import { buildInventoryValuationSnapshot } from "./core/inventory-valuation.js";
import { createSeededInventoryLotTracker } from "./core/inventory-lot-seed.js";
import { InventorySnapshotService } from "./core/inventory-snapshot-service.js";
import { recordInventoryCloseResult } from "./core/inventory-pnl.js";
import { RuntimeCheckpointService } from "./core/runtime-checkpoint-service.js";
import {
  buildNegativeRiskIntents,
  getNegativeRiskConditionIds
} from "./core/negative-risk-intents.js";
import { deriveExecutionNetPnlBreakdown } from "./core/net-pnl.js";
import {
  filterMarketsForSelectionEligibility,
  rankNegativeRiskGroupsForSelection,
  type RankedNegativeRiskGroupSelection
} from "./core/market-selection.js";
import {
  buildMarketSelectionSignals,
  buildSelectionSignalSubscriptionAssetIds
} from "./core/market-selection-signals.js";
import { PositionManager } from "./core/position-manager.js";
import { PnLEngine } from "./core/pnl-engine.js";
import { buildRiskReductionCandidatesFromNegativeRiskGroups } from "./core/risk-reduction-candidates.js";
import { RiskManager } from "./core/risk-manager.js";
import { StrategyCoordinator } from "./core/strategy-coordinator.js";
import { SelectionCooldownState } from "./core/selection-cooldown.js";
import type {
  PnLEngineLike,
  RiskManagerLike,
  RiskStatusSnapshot,
  StrategyName
} from "./core/types.js";
import { PaperTradingSessionService } from "./paper-trading/session-service.js";
import { assessNegativeRiskPaperFillConfidence } from "./paper-trading/fill-confidence.js";
import { summarizeObservedVenueLatency } from "./paper-trading/observed-venue-latency.js";
import { EventGroupRegistry } from "./polymarket/event-group-registry.js";
import { fetchBinaryMarketsWithDiagnostics } from "./polymarket/gamma.js";
import { RealizedTradingSessionService } from "./session-report/realized-session-service.js";
import { MarketWsManager } from "./polymarket/market-ws.js";
import { OrderBookStore } from "./polymarket/orderbook-store.js";
import { UserWsTracker } from "./polymarket/user-ws.js";
import {
  buildNegativeRiskGroups,
  evaluateNegativeRiskOpportunity,
  type NegativeRiskGroup,
  type NegativeRiskOpportunity
} from "./strategy/negative-risk.js";
import { NegativeRiskExecutor } from "./trading/negative-risk-executor.js";
import { RiskReductionExecutor, type RiskReductionCandidate } from "./trading/risk-reduction-executor.js";
import type { BinaryMarket, NormalizedOrderBook } from "./types.js";
import { formatUsd } from "./utils.js";

const getYesTokenId = (market: BinaryMarket): string | undefined => {
  const yesIndex = market.outcomes.findIndex(
    (outcome) => outcome.trim().toLowerCase() === "yes"
  );
  return yesIndex >= 0 ? market.tokenIds[yesIndex] : undefined;
};

const getNoTokenId = (market: BinaryMarket): string | undefined => {
  const noIndex = market.outcomes.findIndex(
    (outcome) => outcome.trim().toLowerCase() === "no"
  );
  return noIndex >= 0 ? market.tokenIds[noIndex] : undefined;
};

export class NegativeRiskBot {
  private readonly orderBookStore = new OrderBookStore();
  private readonly trackedTokenToEventId = new Map<string, string>();
  private readonly groupsByEventId = new Map<string, NegativeRiskGroup>();
  private readonly eventGroupRegistry: EventGroupRegistry;
  private readonly feeRates = new Map<string, number>();
  private readonly lastSignalAt = new Map<string, number>();
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
  private readonly executor?: NegativeRiskExecutor;
  private readonly riskReductionExecutor?: RiskReductionExecutor;
  private readonly preemptConditionOrders?: (
    conditionIds: readonly string[],
    incomingStrategy: StrategyName,
    incomingPriority: number
  ) => Promise<void>;
  private readonly alertDispatcher?: AlertDispatcher;
  private lastOpportunityAlertAtMs = 0;
  private latestSelectionCapitalSignalScore = 0.5;
  private latestSelectedEntries: readonly RankedNegativeRiskGroupSelection[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly readonlyClient: ClobClient,
    private readonly logger: Logger,
    tradingClient?: ClobClient,
    private readonly userTracker?: UserWsTracker,
    makerAddress?: string,
    dependencies?: {
      executionEngine?: ExecutionEngine;
      positionManager?: PositionManager;
      riskManager?: RiskManagerLike;
      pnlEngine?: PnLEngineLike;
      inventoryTracker?: InventoryLotTracker;
      paperTradingSessionService?: PaperTradingSessionService;
      preemptConditionOrders?: (
        conditionIds: readonly string[],
        incomingStrategy: StrategyName,
        incomingPriority: number
      ) => Promise<void>;
      alertDispatcher?: AlertDispatcher;
    }
  ) {
    this.alertDispatcher = dependencies?.alertDispatcher;
    this.eventGroupRegistry = new EventGroupRegistry(logger, {
      ttlMs: config.negativeRisk.groupMetadataTtlMs
    });
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
        runtime: "negative-risk"
      });
      this.runtimeCheckpointService = new RuntimeCheckpointService({
        executionEngine: this.executionEngine,
        pnlEngine: this.pnlEngine,
        riskManager: this.riskManager,
        inventoryTracker: this.inventoryTracker,
        logger,
        runtime: "negative-risk"
      });
    }
    this.paperTradingSessionService =
      dependencies?.paperTradingSessionService ??
      (config.mode === "dry-run"
        ? new PaperTradingSessionService({
            logger,
            runtime: "negative-risk"
          })
        : undefined);
    this.realizedTradingSessionService =
      !dependencies?.pnlEngine && config.mode === "live"
        ? new RealizedTradingSessionService({
            logger,
            pnlEngine: this.pnlEngine,
            runtime: "negative-risk"
          })
        : undefined;
    // Fix N: prune dust lots at startup so DEGRADED-from-residual doesn't carry over.
    {
      const dustThreshold = config.inventory.dustThresholdShares;
      if (dustThreshold > 0) {
        const removed = this.inventoryTracker.pruneDustLots(dustThreshold);
        if (removed.length > 0) {
          logger.warn(
            {
              removedCount: removed.length,
              dustThresholdShares: dustThreshold,
              removedLots: removed.map((lot) => ({
                lotId: lot.lotId,
                outcome: lot.outcome,
                sharesRemaining: lot.sharesRemaining
              }))
            },
            "Pruned negative-risk dust inventory lots at startup."
          );
        }
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
      this.executor = new NegativeRiskExecutor(
        tradingClient,
        this.orderBookStore,
        logger,
        this.userTracker,
        {
          makerAddress,
          eventGroupRegistry: this.eventGroupRegistry
        }
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
    // Fix F: signer/holder pre-flight. Refuse to start if the configured signer cannot
    // reach the funder/proxy holder via any relayer route. This prevents every
    // conversion attempt from silently failing with funder_mismatch downstream.
    if (
      config.mode === "live" &&
      config.negativeRisk.verifyHolderAtStartup &&
      this.executor &&
      config.negativeRisk.enableLiveConversionBridge
    ) {
      const verification = await this.executor.verifyHolder();
      if (verification.status === "mismatch" || verification.status === "unsupported_signer") {
        const detail = verification.detail ?? verification.status;
        this.logger.error(
          { verification },
          "Negative Risk conversion bridge holder verification failed at startup; refusing to start."
        );
        throw new Error(
          `Negative Risk holder verification failed: ${detail}. Set POLYBOT_NEG_RISK_VERIFY_HOLDER_AT_STARTUP=false only if you have manually validated the relayer can reach funderAddress.`
        );
      }
      this.logger.info(
        { verification },
        "Negative Risk holder verification passed at startup."
      );
    }

    try {
      await this.refreshUniverse();
    } catch (error) {
      this.riskManager.noteApiError?.(
        "negative-risk.refresh-universe",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshUniverse().catch((error) => {
        this.riskManager.noteApiError?.(
          "negative-risk.refresh-universe",
          error instanceof Error ? error.message : String(error)
        );
        this.logger.error({ err: error }, "Negative Risk universe refresh failed.");
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
    return buildRiskReductionCandidatesFromNegativeRiskGroups([...this.groupsByEventId.values()]);
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
      "Completed Negative Risk inventory risk reduction pass."
    );
  }

  private async refreshUniverse(): Promise<void> {
    this.logger.info(
      {
        scanCap: config.marketUniverse.scanCap,
        pageSize: config.marketUniverse.pageSize,
        maxMarkets: config.marketUniverse.maxMarkets,
        maxGroupMarkets: config.negativeRisk.maxGroupMarkets
      },
      "Refreshing Negative Risk universe."
    );

    const previousEventIds = new Set(this.groupsByEventId.keys());
    const { markets, diagnostics } = await fetchBinaryMarketsWithDiagnostics();
    const signalsByConditionId = buildMarketSelectionSignals(
      markets,
      this.orderBookStore.get.bind(this.orderBookStore),
      this.orderBookStore.getSelectionTelemetry.bind(this.orderBookStore)
    );
    // Fix K: use the negative-risk eligibility profile, not same-market-arb. The
    // same-market-arb profile required two-sided depth and recent trade activity on
    // every individual market, which dropped most long-tail negRisk outcomes after the
    // first refresh and prevented complete groups from being formed.
    const eligibleMarkets = filterMarketsForSelectionEligibility(markets, {
      signalsByConditionId,
      profile: "negative-risk"
    });
    const candidateGroups = buildNegativeRiskGroups(eligibleMarkets);
    const eligibleGroups = candidateGroups.filter(
      (group) =>
        group.markets.length >= 2 && group.markets.length <= config.negativeRisk.maxGroupMarkets
    );
    const selection = rankNegativeRiskGroupsForSelection(eligibleGroups, {
      maxMarkets: config.marketUniverse.maxMarkets,
      topLogCount: config.marketUniverse.selectionLogTopN,
      signalsByConditionId,
      preferredEventIds: previousEventIds
    });
    const cooldown = this.selectionCooldown.apply(
      selection.rankedGroups.map((entry) => ({
        id: entry.group.eventId,
        score: entry.breakdown.total,
        value: entry.group,
        weight: entry.group.markets.length
      })),
      {
        currentSelectedIds: previousEventIds,
        maxSelectedWeight: config.marketUniverse.maxMarkets,
        minHoldMs: config.marketUniverse.selectionMinHoldMs,
        reentryCooldownMs: config.marketUniverse.selectionReentryCooldownMs
      }
    );
    const selectedGroupsRaw = cooldown.selected;

    // Fix A: enrich each selected group with gamma event metadata so the evaluator
    // can verify completeness (group.markets.length === expectedActiveMarketCount and
    // every expectedQuestionId is present in the local subset).
    const eventMetadataMap = await this.eventGroupRegistry.getMany(
      selectedGroupsRaw.map((group) => group.eventId)
    );
    const negRiskGroups = selectedGroupsRaw.map((group) => {
      const meta = eventMetadataMap.get(group.eventId);
      if (!meta) {
        return group;
      }
      return {
        ...group,
        expectedActiveMarketCount: meta.activeMarketCount,
        expectedQuestionIds: meta.questionIds,
        metadataFetchedAtMs: meta.fetchedAtMs
      };
    });

    const completenessSummary = negRiskGroups.map((group) => ({
      eventSlug: group.eventSlug,
      have: group.markets.length,
      expected: group.expectedActiveMarketCount,
      complete:
        group.expectedActiveMarketCount !== undefined &&
        group.markets.length >= group.expectedActiveMarketCount
    }));
    const incompleteGroups = completenessSummary.filter(
      (entry) => entry.expected !== undefined && !entry.complete
    );
    const missingMetadataGroups = completenessSummary.filter(
      (entry) => entry.expected === undefined
    );
    const completeGroups = completenessSummary.filter((entry) => entry.complete);

    // Universe health summary — operator-tracked metrics for the 24h verification run
    // after the universe expansion. Logged structured so the analyze-neg-risk-run script
    // can ingest these fields directly.
    const groupSizeStats = (() => {
      if (negRiskGroups.length === 0) return { min: 0, max: 0, avg: 0 };
      const sizes = negRiskGroups.map((group) => group.markets.length);
      return {
        min: Math.min(...sizes),
        max: Math.max(...sizes),
        avg: Number((sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2))
      };
    })();
    const universeHealth = {
      type: "negative-risk-universe-health",
      candidateGroupCount: candidateGroups.length,
      eligibleGroupCount: eligibleGroups.length,
      selectedGroupCount: negRiskGroups.length,
      completeGroupCount: completeGroups.length,
      incompleteGroupCount: incompleteGroups.length,
      missingMetadataGroupCount: missingMetadataGroups.length,
      completionRatio:
        negRiskGroups.length > 0
          ? Number((completeGroups.length / negRiskGroups.length).toFixed(3))
          : 0,
      selectedMarketsTotal: negRiskGroups.reduce((sum, g) => sum + g.markets.length, 0),
      groupSizeStats,
      eligibleMarketsTotal: eligibleMarkets.length,
      requireCompleteGroup: config.negativeRisk.requireCompleteGroup,
      maxMarkets: config.marketUniverse.maxMarkets,
      minLiquidity: config.marketUniverse.minMarketLiquidity
    };
    this.logger.info(universeHealth, "Negative Risk universe health snapshot.");

    if (incompleteGroups.length > 0 || missingMetadataGroups.length > 0) {
      this.logger.warn(
        {
          incompleteGroups,
          missingMetadataGroups,
          requireCompleteGroup: config.negativeRisk.requireCompleteGroup
        },
        "Negative Risk universe contains incomplete or unverified event groups; evaluator will reject them while requireCompleteGroup is enabled."
      );
    }

    // Periodic universe health alert to Telegram (rate-limited 1 per refresh).
    // Fix: use category "diagnostic" so the dispatcher uses the generic renderer.
    // Earlier this used "operator_status", which triggered the full operator-status
    // template (현재 자산 / 초기 자본 / 총 수익 / ...), but our `details` payload
    // doesn't have those fields, so every value rendered as "-".
    if (this.alertDispatcher) {
      const summaryStr =
        `complete=${completeGroups.length}/${negRiskGroups.length}` +
        ` (${(universeHealth.completionRatio * 100).toFixed(1)}%)` +
        ` · incomplete=${incompleteGroups.length}` +
        ` · missingMeta=${missingMetadataGroups.length}` +
        ` · groupSize avg=${groupSizeStats.avg} max=${groupSizeStats.max}`;
      void this.alertDispatcher
        .dispatch({
          schemaVersion: 1,
          category: "diagnostic",
          severity: "info",
          title: "🟦 Neg-risk universe health",
          summary: summaryStr,
          occurredAtMs: Date.now(),
          runtime: "negative-risk",
          tags: ["negative-risk", "universe-health"],
          details: {
            ...universeHealth,
            sampleIncomplete: incompleteGroups.slice(0, 5),
            sampleComplete: completeGroups.slice(0, 5)
          }
        })
        .catch((err) => {
          this.logger.debug({ err }, "Failed to dispatch universe health alert.");
        });
    }

    const selectedEntries = selection.rankedGroups.filter((entry) =>
      negRiskGroups.some((group) => group.eventId === entry.group.eventId)
    );
    this.latestSelectedEntries = selectedEntries;
    const capitalSignal = buildNegativeRiskCapitalSignal(selectedEntries);
    this.latestSelectionCapitalSignalScore = capitalSignal.score;
    const selectionScopedCapitalSignals = buildNegativeRiskScopedCapitalSignals(selectedEntries);
    const nextEventIds = new Set(negRiskGroups.map((group) => group.eventId));
    const retainedCount = [...nextEventIds].filter((eventId) => previousEventIds.has(eventId)).length;
    const newEventIds = [...nextEventIds].filter((eventId) => !previousEventIds.has(eventId));
    const droppedEventIds = [...previousEventIds].filter((eventId) => !nextEventIds.has(eventId));

    this.trackedTokenToEventId.clear();
    this.groupsByEventId.clear();

    for (const group of negRiskGroups) {
      this.groupsByEventId.set(group.eventId, group);

      for (const market of group.markets) {
        const yesTokenId = getYesTokenId(market);
        const noTokenId = getNoTokenId(market);

        if (yesTokenId) {
          this.trackedTokenToEventId.set(yesTokenId, group.eventId);
          this.seedFeeRate(yesTokenId, market);
        }

        if (noTokenId) {
          this.trackedTokenToEventId.set(noTokenId, group.eventId);
          this.seedFeeRate(noTokenId, market);
        }
      }
    }

    this.positionManager.setMarketUniverse(
      negRiskGroups.flatMap((group) => group.markets),
      "negative-risk"
    );
    this.refreshDynamicCapitalSignalFromPerformance();
    this.refreshScopedCapitalSignalsFromPerformance();

    const executionAssetIds = [...this.trackedTokenToEventId.keys()];
    const selectionSignalAssetIds = buildSelectionSignalSubscriptionAssetIds(
      eligibleMarkets,
      negRiskGroups.flatMap((group) => group.markets)
    );
    this.marketWs.replaceSubscriptions(selectionSignalAssetIds);

    if (config.mode === "live" && this.userTracker) {
      this.userTracker.connect(
        [...new Set(negRiskGroups.flatMap((group) => group.markets.map((market) => market.conditionId)))],
        "market_universe_refresh"
      );
    }

    this.logger.info(
      {
        candidateMarkets: markets.length,
        eligibleMarkets: eligibleMarkets.length,
        candidateGroups: candidateGroups.length,
        eligibleGroups: eligibleGroups.length,
        groups: negRiskGroups.length,
        retainedGroups: retainedCount,
        newGroups: newEventIds.length,
        droppedGroups: droppedEventIds.length,
        forcedHeldGroups: cooldown.forcedHoldIds.length,
        blockedReentries: cooldown.blockedReentryIds.length,
        capitalSignal,
        scopedCapitalSignalCounts: {
          conditions: selectionScopedCapitalSignals.byConditionId.size,
          events: selectionScopedCapitalSignals.byEventId.size
        },
        markets: negRiskGroups.reduce((total, group) => total + group.markets.length, 0),
        marketsWithSelectionSignals: signalsByConditionId.size,
        assets: selectionSignalAssetIds.length,
        executionAssets: executionAssetIds.length,
        selectionSignalMarkets: eligibleMarkets.length,
        maxGroupMarkets: config.negativeRisk.maxGroupMarkets,
        universeFetch: diagnostics,
        groupSelection: selection.diagnostics
      },
      "Negative Risk universe refreshed."
    );
  }

  private async handleTokenUpdate(tokenId: string): Promise<void> {
    const eventId = this.trackedTokenToEventId.get(tokenId);

    if (!eventId) {
      return;
    }

    const group = this.groupsByEventId.get(eventId);

    if (!group) {
      return;
    }

    const now = Date.now();
    const cooldownUntil = this.cooldownUntil.get(eventId) ?? 0;

    if (cooldownUntil > now) {
      return;
    }

    if (this.executionLocks.has(eventId) || this.evaluationLocks.has(eventId)) {
      return;
    }

    const booksByTokenId = new Map<string, NormalizedOrderBook>();

    for (const market of group.markets) {
      const yesTokenId = getYesTokenId(market);

      if (!yesTokenId) {
        return;
      }

      const yesBook = this.orderBookStore.get(yesTokenId);

      if (!yesBook) {
        return;
      }

      booksByTokenId.set(yesTokenId, yesBook);

      const noTokenId = getNoTokenId(market);

      if (noTokenId) {
        const noBook = this.orderBookStore.get(noTokenId);

        if (noBook) {
          booksByTokenId.set(noTokenId, noBook);
        }
      }
    }

    this.evaluationLocks.add(eventId);

    try {
      const feeRatesByTokenId = new Map<string, number>();

      for (const market of group.markets) {
        const yesTokenId = getYesTokenId(market);
        const noTokenId = getNoTokenId(market);

        if (yesTokenId) {
          const feeRate = await this.resolveFeeRate(yesTokenId, market.feesEnabled);
          feeRatesByTokenId.set(yesTokenId, feeRate);
        }

        if (noTokenId) {
          const feeRate = await this.resolveFeeRate(noTokenId, market.feesEnabled);
          feeRatesByTokenId.set(noTokenId, feeRate);
        }
      }

      const evaluation = evaluateNegativeRiskOpportunity(group, booksByTokenId, feeRatesByTokenId);

      if (evaluation.status !== "opportunity") {
        return;
      }

      const signalCooldownMs = this.getEffectiveSignalCooldownMs();
      const executionCooldownMs = this.getEffectiveExecutionCooldownMs();
      const lastSignalAt = this.lastSignalAt.get(eventId) ?? 0;

      if (now - lastSignalAt < signalCooldownMs) {
        return;
      }

      this.lastSignalAt.set(eventId, now);

      const rankedOpportunities = [
        evaluation.opportunity,
        ...evaluation.alternativeOpportunities
      ];

      if (config.mode === "dry-run") {
        this.logOpportunity(evaluation.opportunity);
        this.recordPaperOpportunity(evaluation.opportunity);
        return;
      }

      if (!this.executor) {
        return;
      }

      const executableOpportunity =
        rankedOpportunities.find(
          (opportunity) =>
            opportunity.kind === "yes-basket" ||
            (config.negativeRisk.enableLiveConversionBridge &&
              opportunity.kind === "no-to-yes-conversion")
        ) ??
        rankedOpportunities[0];

      if (evaluation.opportunity.kind === "no-to-yes-conversion") {
        this.logOpportunity(evaluation.opportunity);

        if (!config.negativeRisk.enableLiveConversionBridge) {
          if (executableOpportunity?.kind !== "yes-basket") {
            this.logger.warn(
              {
                eventId: group.eventId,
                eventSlug: group.eventSlug,
                marketId: group.marketId
              },
              "Negative Risk best opportunity requires NO-to-YES conversion. Live execution for that path is not enabled yet."
            );
            return;
          }

          this.logger.warn(
            {
              eventId: group.eventId,
              eventSlug: group.eventSlug,
              skippedKind: evaluation.opportunity.kind,
              fallbackKind: executableOpportunity.kind,
              bestNetEdge: evaluation.opportunity.netEdge.toFixed(4),
              fallbackNetEdge: executableOpportunity.netEdge.toFixed(4)
            },
            "Negative Risk live mode fell back to an executable YES basket because the richer conversion path is not enabled yet."
          );
        }
      }

      if (!executableOpportunity) {
        return;
      }

      this.executionLocks.add(eventId);
      this.cooldownUntil.set(eventId, now + executionCooldownMs);

      try {
        await this.tryExecuteOpportunity(executableOpportunity);
      } catch (error) {
        this.riskManager.noteOrderFailure?.(
          "negative-risk.execute",
          `${group.eventSlug}:${error instanceof Error ? error.message : String(error)}`
        );
        this.logger.error(
          { err: error, eventId: group.eventId, eventSlug: group.eventSlug },
          "Negative Risk execution failed."
        );
      } finally {
        this.executionLocks.delete(eventId);
      }
    } finally {
      this.evaluationLocks.delete(eventId);
    }
  }

  private recordPaperOpportunity(opportunity: NegativeRiskOpportunity): void {
    if (!this.paperTradingSessionService) {
      return;
    }

    const booksByTokenId = new Map(
      (opportunity.kind === "yes-basket"
        ? opportunity.legs.map((leg) => leg.tokenId)
        : [opportunity.entry.tokenId, ...opportunity.exitLegs.map((leg) => leg.tokenId)]
      ).flatMap((tokenId) => {
        const book = this.orderBookStore.get(tokenId);
        return book ? ([[tokenId, book]] as const) : [];
      })
    );
    const fillAssessment = assessNegativeRiskPaperFillConfidence(opportunity, booksByTokenId);
    const observedVenueLatency = summarizeObservedVenueLatency({
      detectedAtMs: opportunity.detectedAtMs,
      books:
        opportunity.kind === "yes-basket"
          ? opportunity.legs.map((leg) => booksByTokenId.get(leg.tokenId))
          : [
              booksByTokenId.get(opportunity.entry.tokenId),
              ...opportunity.exitLegs.map((leg) => booksByTokenId.get(leg.tokenId))
            ]
    });

    const intents = buildNegativeRiskIntents(opportunity);
    const coordination = this.coordinator.coordinate(intents);
    const fullyApproved = coordination.approvedIntents.length === intents.length;
    const pnlBreakdown = deriveExecutionNetPnlBreakdown({
      grossRealizedPnlUsdc: opportunity.grossEdge,
      expectedGrossEdgeUsdc: opportunity.grossEdge,
      feeCostUsdc: opportunity.feeCost,
      completion: "fully-filled"
    });
    const rejectionReason = fullyApproved
      ? "dry_run_coordinator_approved"
      : [
          ...new Set(
            coordination.rejected.map((rejected) => rejected.reason)
          )
        ].join(",");

    this.paperTradingSessionService.recordTrade({
      id: `negative-risk:paper:${opportunity.group.eventId}:${opportunity.detectedAtMs}`,
      strategy: "negative-risk",
      marketScope: opportunity.group.eventSlug,
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
      tags: ["dry-run-runtime", "negative-risk", opportunity.kind]
    });
  }

  private logOpportunity(opportunity: NegativeRiskOpportunity): void {
    if (opportunity.kind === "yes-basket") {
      this.logger.info(
        {
          kind: opportunity.kind,
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug,
          eventTitle: opportunity.group.eventTitle,
          marketId: opportunity.group.marketId,
          shares: opportunity.shares,
          groupMarkets: opportunity.legs.length,
          grossCost: formatUsd(opportunity.grossCost),
          grossCostPerShare: opportunity.grossCostPerShare.toFixed(4),
          feeCost: formatUsd(opportunity.feeCost),
          netEdge: formatUsd(opportunity.netEdge),
          netEdgeBpsOnPar: opportunity.netEdgeBpsOnPar.toFixed(2),
          legs: opportunity.legs.map((leg) => ({
            market: leg.market.slug,
            outcomeTitle: leg.outcomeTitle,
            averagePrice: leg.fill.averagePrice.toFixed(4),
            worstPrice: leg.limitPrice.toFixed(4)
          }))
        },
        config.mode === "dry-run"
          ? "Negative Risk YES basket opportunity detected."
          : "Negative Risk YES basket opportunity accepted."
      );
      this.dispatchOpportunityAlert(opportunity);
      return;
    }

    this.logger.info(
      {
        kind: opportunity.kind,
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        eventTitle: opportunity.group.eventTitle,
        marketId: opportunity.conversionMarketId,
        shares: opportunity.shares,
        convertedSharesPerLeg: opportunity.convertedSharesPerLeg.toFixed(5),
        sourceQuestionIndex: opportunity.sourceQuestionIndex,
        conversionIndexSet: opportunity.conversionIndexSet,
        grossCost: formatUsd(opportunity.grossCost),
        grossProceeds: formatUsd(opportunity.grossProceeds),
        feeCost: formatUsd(opportunity.feeCost),
        netEdge: formatUsd(opportunity.netEdge),
        netEdgeBpsOnPar: opportunity.netEdgeBpsOnPar.toFixed(2),
        entry: {
          market: opportunity.entry.market.slug,
          outcomeTitle: opportunity.entry.outcomeTitle,
          averagePrice: opportunity.entry.fill.averagePrice.toFixed(4),
          worstPrice: opportunity.entry.limitPrice.toFixed(4)
        },
        exitLegs: opportunity.exitLegs.map((leg) => ({
          market: leg.market.slug,
          outcomeTitle: leg.outcomeTitle,
          averagePrice: leg.fill.averagePrice.toFixed(4),
          worstPrice: leg.limitPrice.toFixed(4)
        }))
      },
      config.mode === "dry-run"
        ? "Negative Risk NO-to-YES conversion opportunity detected."
        : "Negative Risk NO-to-YES conversion opportunity accepted."
    );
    this.dispatchOpportunityAlert(opportunity);
  }

  private dispatchOpportunityAlert(opportunity: NegativeRiskOpportunity): void {
    if (!this.alertDispatcher) return;
    const nowMs = Date.now();
    if (nowMs - this.lastOpportunityAlertAtMs <= 60_000) return;
    this.lastOpportunityAlertAtMs = nowMs;

    const isDryRun = config.mode === "dry-run";
    const titlePrefix = isDryRun ? "🟡 [DRY-RUN]" : "🎯";
    const eventTitle =
      opportunity.group.eventTitle ?? opportunity.group.eventSlug ?? opportunity.group.eventId;

    const isLegSingleLevel = (avg: number, worst: number) =>
      Math.abs(avg - worst) < 1e-6;

    const baseDetails: Record<string, unknown> = {
      kind: opportunity.kind,
      eventId: opportunity.group.eventId,
      eventSlug: opportunity.group.eventSlug,
      eventTitle: opportunity.group.eventTitle,
      shares: opportunity.shares,
      grossCostUsdc: opportunity.grossCost,
      grossCostPerShare: opportunity.grossCostPerShare,
      feeCostUsdc: opportunity.feeCost,
      netEdgeUsdc: opportunity.netEdge,
      netEdgeBpsOnPar: opportunity.netEdgeBpsOnPar
    };

    let summary: string;
    if (opportunity.kind === "yes-basket") {
      const totalLegs = opportunity.legs.length;
      const singleLevelLegs = opportunity.legs.filter((leg) =>
        isLegSingleLevel(leg.fill.averagePrice, leg.fill.worstPrice)
      ).length;
      const depthLabel =
        singleLevelLegs === totalLegs
          ? `DEEP ✓ (${totalLegs}/${totalLegs} 단일레벨)`
          : `THIN ⚠ (${singleLevelLegs}/${totalLegs} 단일레벨, ${totalLegs - singleLevelLegs} 다단계)`;
      summary =
        `${eventTitle.slice(0, 50)}\n` +
        `· ${totalLegs} outcomes × ${opportunity.shares}주\n` +
        `· 투입 $${opportunity.grossCost.toFixed(2)} → 회수 $${opportunity.shares.toFixed(2)} → 차익 $${opportunity.netEdge.toFixed(4)} (${opportunity.netEdgeBpsOnPar.toFixed(0)} bps)\n` +
        `· 물량: ${depthLabel}`;
      baseDetails.groupMarkets = totalLegs;
      baseDetails.depth = {
        totalLegs,
        singleLevelLegs,
        multiLevelLegs: totalLegs - singleLevelLegs
      };
      baseDetails.legs = opportunity.legs.map((leg) => ({
        marketSlug: leg.market.slug,
        marketQuestion: leg.market.question,
        outcomeTitle: leg.outcomeTitle,
        averagePrice: leg.fill.averagePrice,
        worstPrice: leg.fill.worstPrice,
        limitPrice: leg.limitPrice,
        singleLevel: isLegSingleLevel(leg.fill.averagePrice, leg.fill.worstPrice)
      }));
    } else {
      const allLegs = [opportunity.entry, ...opportunity.exitLegs];
      const singleLevelLegs = allLegs.filter((leg) =>
        isLegSingleLevel(leg.fill.averagePrice, leg.fill.worstPrice)
      ).length;
      const depthLabel =
        singleLevelLegs === allLegs.length
          ? `DEEP ✓ (${singleLevelLegs}/${allLegs.length} 단일레벨)`
          : `THIN ⚠ (${singleLevelLegs}/${allLegs.length} 단일레벨)`;
      summary =
        `${eventTitle.slice(0, 50)} · NO→YES conv\n` +
        `· ${opportunity.shares}주\n` +
        `· 투입 $${opportunity.grossCost.toFixed(2)} → 회수 $${opportunity.grossProceeds.toFixed(2)} → 차익 $${opportunity.netEdge.toFixed(4)} (${opportunity.netEdgeBpsOnPar.toFixed(0)} bps)\n` +
        `· 물량: ${depthLabel}`;
      baseDetails.grossProceedsUsdc = opportunity.grossProceeds;
      baseDetails.conversionMarketId = opportunity.conversionMarketId;
      baseDetails.depth = {
        totalLegs: allLegs.length,
        singleLevelLegs,
        multiLevelLegs: allLegs.length - singleLevelLegs
      };
      baseDetails.entry = {
        marketSlug: opportunity.entry.market.slug,
        outcomeTitle: opportunity.entry.outcomeTitle,
        averagePrice: opportunity.entry.fill.averagePrice,
        worstPrice: opportunity.entry.fill.worstPrice,
        limitPrice: opportunity.entry.limitPrice,
        singleLevel: isLegSingleLevel(
          opportunity.entry.fill.averagePrice,
          opportunity.entry.fill.worstPrice
        )
      };
      baseDetails.exitLegs = opportunity.exitLegs.map((leg) => ({
        marketSlug: leg.market.slug,
        outcomeTitle: leg.outcomeTitle,
        averagePrice: leg.fill.averagePrice,
        worstPrice: leg.fill.worstPrice,
        limitPrice: leg.limitPrice,
        singleLevel: isLegSingleLevel(leg.fill.averagePrice, leg.fill.worstPrice)
      }));
    }

    void this.alertDispatcher
      .dispatch({
        schemaVersion: 1,
        category: "arb_opportunity",
        severity: "info",
        title: `${titlePrefix} Negative-risk arb 기회`,
        summary,
        occurredAtMs: nowMs,
        runtime: "negative-risk",
        tags: ["negative-risk", "opportunity", opportunity.kind, isDryRun ? "dry-run" : "live"],
        details: baseDetails
      })
      .catch((err) => {
        this.logger.debug({ err }, "Failed to dispatch negative-risk opportunity alert.");
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

  private async tryExecuteOpportunity(
    opportunity: NegativeRiskOpportunity
  ): Promise<void> {
    if (!this.executor) {
      return;
    }

    const intents = buildNegativeRiskIntents(opportunity);
    const incomingPriority = intents[0]?.priority ?? 0;
    const conditionIds = getNegativeRiskConditionIds(opportunity);
    const lowerPriorityOrders = conditionIds.flatMap((conditionId) =>
      this.executionEngine
        .getActiveOrdersForCondition(conditionId)
        .filter((order) => order.strategy !== "negative-risk" && order.priority < incomingPriority)
    );

    if (lowerPriorityOrders.length > 0) {
      if (!this.preemptConditionOrders) {
        this.logger.warn(
          {
            eventId: opportunity.group.eventId,
            eventSlug: opportunity.group.eventSlug,
            conditionIds,
            blockingStrategies: [...new Set(lowerPriorityOrders.map((order) => order.strategy))]
          },
          "Skipped Negative Risk execution because lower-priority orders existed but no preemption hook was available."
        );
        return;
      }

      await this.preemptConditionOrders(
        conditionIds,
        "negative-risk",
        incomingPriority
      );
    }

    const coordination = this.coordinator.coordinate(intents);

    if (coordination.approvedIntents.length !== intents.length) {
      this.logger.warn(
        {
          eventId: opportunity.group.eventId,
          eventSlug: opportunity.group.eventSlug,
          approvedIntents: coordination.approvedIntents.length,
          totalIntents: intents.length,
          rejected: coordination.rejected.map((rejected) => ({
            conditionId: rejected.intent.conditionId,
            tokenId: rejected.intent.tokenId,
            side: rejected.intent.side,
            reason: rejected.reason,
            detail: rejected.detail
          }))
        },
        "Skipped Negative Risk execution because one or more entry intents were not approved by the coordinator."
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
        // Fix B: fully_filled_pending_resolution is yes-basket holding inventory until
        // event resolution; PnL is 0 now and will be recognized later. We record it as
        // residual-exposure so capital accounting reflects the still-open position.
        completion:
          summary.status === "fully_filled"
            ? "fully-filled"
            : summary.status === "emergency_unwind"
              ? "emergency-unwind"
              : "residual-exposure"
      });
      this.pnlEngine.recordTrade({
        id: `negative-risk:${opportunity.group.eventId}:${opportunity.detectedAtMs}:${summary.status}`,
        strategy: "negative-risk",
        marketScope: opportunity.group.eventSlug,
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
        detail: summary.detail,
        tags: ["negative-risk", summary.status],
        metadata: {
          eventId: opportunity.group.eventId,
          category:
            opportunity.kind === "yes-basket"
              ? opportunity.group.markets[0]?.category
              : opportunity.entry.market.category,
          legCount: opportunity.kind === "yes-basket" ? opportunity.legs.length : opportunity.exitLegs.length + 1,
          opportunityKind: opportunity.kind,
          grossCostPerShare: Number(opportunity.grossCostPerShare.toFixed(6)),
          netEdgeBpsOnPar: Number(opportunity.netEdgeBpsOnPar.toFixed(4)),
          expectedGrossEdgeUsdc: Number(opportunity.grossEdge.toFixed(6))
        }
      });
      this.refreshDynamicCapitalSignalFromPerformance();
      this.refreshScopedCapitalSignalsFromPerformance();
      this.riskManager.noteTradeClosed?.(
        pnlBreakdown.realizedPnlUsdc,
        "negative-risk.execution",
        `${opportunity.group.eventSlug}:${summary.status}`
      );
    }

    if (summary.stateMismatchDetail) {
      this.riskManager.noteStateMismatch?.(
        "negative-risk.balance-reconciliation",
        `${opportunity.group.eventSlug}:${summary.stateMismatchDetail}`
      );
    }

    if (summary.status === "residual_exposure") {
      this.riskManager.noteStateMismatch?.(
        "negative-risk.execution",
        `${opportunity.group.eventSlug}:${summary.detail ?? "Residual exposure remained after unwind flow."}`
      );
    }
  }

  private trackOpenedPositions(
    summary: Awaited<ReturnType<NegativeRiskExecutor["execute"]>>,
    opportunity: NegativeRiskOpportunity
  ): void {
    let inventoryChanged = false;

    for (const [index, position] of (summary.openedPositions ?? []).entries()) {
      this.inventoryTracker.addLot({
        lotId: `negative-risk:${opportunity.group.eventId}:${opportunity.detectedAtMs}:${position.tokenId}:${index}`,
        strategy: "negative-risk",
        tokenId: position.tokenId,
        marketScope: position.marketScope,
        conditionId: position.conditionId,
        outcome: position.outcome,
        shares: position.shares,
        totalCostUsdc: position.totalCostUsdc,
        openedAtMs: position.openedAtMs,
        metadata: {
          executionSource: "negative-risk",
          eventSlug: opportunity.group.eventSlug
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
      this.pnlEngine.getStrategySnapshot("negative-risk")
    ]);
    const blendedSignalScore = blendCapitalSignalScores(
      this.latestSelectionCapitalSignalScore,
      performanceSignal.score
    );

    this.positionManager.setStrategyCapitalSignal("negative-risk", blendedSignalScore);
  }

  private refreshScopedCapitalSignalsFromPerformance(): void {
    const selectionSignals = buildNegativeRiskScopedCapitalSignals(this.latestSelectedEntries);
    const conditionToEventId = new Map<string, string>();
    const conditionToCategory = new Map<string, string>();

    for (const entry of this.latestSelectedEntries) {
      for (const market of entry.group.markets) {
        conditionToEventId.set(market.conditionId, entry.group.eventId);

        const normalizedCategory = market.category?.trim().toLowerCase();

        if (normalizedCategory) {
          conditionToCategory.set(market.conditionId, normalizedCategory);
        }
      }
    }

    const performanceSignals = buildScopedPerformanceCapitalSignals({
      trades: this.pnlEngine.exportTrades(),
      relevantStrategies: ["negative-risk"],
      conditionToEventId,
      conditionToCategory
    });
    const blendedSignals = blendScopedCapitalSignals(selectionSignals, performanceSignals);

    this.positionManager.setConditionCapitalSignals(
      blendedSignals.byConditionId,
      "negative-risk"
    );
    this.positionManager.setEventCapitalSignals(blendedSignals.byEventId, "negative-risk");
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
