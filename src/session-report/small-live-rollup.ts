import type { RiskState, StrategyName } from "../core/types.js";
import type { RiskBudgetAdjustmentSnapshot } from "../core/capital-allocator.js";
import type {
  PaperLiveComparisonBucket,
  PaperLiveComparisonObservedLatencyBucket
} from "./paper-live-comparison.js";
import type {
  SmallLiveReport,
  SmallLiveReportFlagCode,
  SmallLiveReportStatus
} from "./small-live-report.js";

export type SmallLiveRollupFlagSummary = {
  code: SmallLiveReportFlagCode;
  count: number;
  criticalCount: number;
  warningCount: number;
};

export type SmallLiveRollupStrategySummary = {
  strategy: StrategyName;
  sessionCount: number;
  reviewSessionCount: number;
  haltedSessionCount: number;
  liveTradeCount: number;
  liveWinningTrades: number;
  liveLosingTrades: number;
  liveFlatTrades: number;
  liveExpectedEdgeUsdc: number;
  liveRealizedPnlUsdc: number;
  liveVsExpectedDeltaUsdc: number;
  paperExpectedTradeCount: number;
  paperFilledTradeCount: number;
  paperMissedTradeCount: number;
  matchedLiveTradeCount: number;
  paperVsLiveDeltaUsdc: number;
};

export type SmallLiveRollupSessionSummary = {
  sessionName: string;
  generatedAtMs: number;
  overallStatus: SmallLiveReportStatus;
  finalRiskState: RiskState;
  liveTradeCount: number;
  liveRealizedPnlUsdc: number;
  liveVsExpectedDeltaUsdc: number;
  paperVsLiveDeltaUsdc?: number;
  paperAverageObservedVenueLatencyMs?: number;
  paperAverageObservedBookSkewMs?: number;
  paperCheckpointRecoveryReady?: boolean;
  openLotCount?: number;
  activeOrderCount?: number;
  riskStressScore?: number;
  sharedBuyBudgetMultiplier?: number;
  dailyRoiPct?: number;
  rewardIncomeUsdc?: number;
  rebateIncomeUsdc?: number;
  residualInventoryUtilizationPct?: number;
  yesNoImbalancePct?: number;
  flagCodes: SmallLiveReportFlagCode[];
};

export type SmallLiveRollupPaperConfidenceSummary = PaperLiveComparisonBucket;

export type SmallLiveRollupObservedLatencySummary = PaperLiveComparisonObservedLatencyBucket;

export type SmallLiveRollupReport = {
  reportType: "small_live_rollup";
  schemaVersion: 1;
  groupName: string;
  generatedAtMs: number;
  sessionCount: number;
  statusCounts: Record<SmallLiveReportStatus, number>;
  finalRiskStateCounts: Record<RiskState, number>;
  sessionWithoutPaperCount: number;
  sessionWithoutCheckpointCount: number;
  sessionWithPaperCheckpointValidationCount: number;
  sessionWithPaperCheckpointReadyCount: number;
  sessionWithPaperCheckpointNotReadyCount: number;
  sessionWithRestartDrillCount: number;
  restartDrillPassedCount: number;
  restartDrillWarningCount: number;
  restartDrillFailedCount: number;
  sessionsWithResidualInventoryCount: number;
  sessionsWithResidualActiveOrdersCount: number;
  sessionsWithRiskBudgetAdjustmentCount: number;
  totalLiveTradeCount: number;
  totalLiveExpectedEdgeUsdc: number;
  totalLiveRealizedPnlUsdc: number;
  totalLiveVsExpectedDeltaUsdc: number;
  totalPaperVsLiveDeltaUsdc: number;
  kpis?: {
    averageDailyRoiPct: number;
    totalRewardIncomeUsdc: number;
    totalRebateIncomeUsdc: number;
    maxResidualInventoryUtilizationPct: number;
    maxYesNoImbalancePct?: number;
  };
  riskBudgetAdjustment?: {
    averageStressScore: number;
    maxStressScore: number;
    averageSharedBuyBudgetMultiplier: number;
    minSharedBuyBudgetMultiplier: number;
    strategyMinBuyBudgetMultipliers: RiskBudgetAdjustmentSnapshot["strategyBuyBudgetMultipliers"];
  };
  bestSessionByLivePnl?: SmallLiveRollupSessionSummary;
  worstSessionByLivePnl?: SmallLiveRollupSessionSummary;
  worstSessionByPaperDelta?: SmallLiveRollupSessionSummary;
  /** Aggregated trade reason breakdown across all sessions (e.g. spread_capture, inventory_reduce). */
  reasonBreakdown?: Record<string, { count: number; totalPnlUsdc: number; winRate: number }>;
  byPaperConfidence: SmallLiveRollupPaperConfidenceSummary[];
  byObservedLatency: SmallLiveRollupObservedLatencySummary[];
  byFlag: SmallLiveRollupFlagSummary[];
  byStrategy: SmallLiveRollupStrategySummary[];
  sessions: SmallLiveRollupSessionSummary[];
};

type StrategyAggregate = {
  sessionCount: number;
  reviewSessionCount: number;
  haltedSessionCount: number;
  liveTradeCount: number;
  liveWinningTrades: number;
  liveLosingTrades: number;
  liveFlatTrades: number;
  liveExpectedEdgeUsdc: number;
  liveRealizedPnlUsdc: number;
  liveVsExpectedDeltaUsdc: number;
  paperExpectedTradeCount: number;
  paperFilledTradeCount: number;
  paperMissedTradeCount: number;
  matchedLiveTradeCount: number;
  paperVsLiveDeltaUsdc: number;
};

type FlagAggregate = {
  count: number;
  criticalCount: number;
  warningCount: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const createStrategyAggregate = (): StrategyAggregate => ({
  sessionCount: 0,
  reviewSessionCount: 0,
  haltedSessionCount: 0,
  liveTradeCount: 0,
  liveWinningTrades: 0,
  liveLosingTrades: 0,
  liveFlatTrades: 0,
  liveExpectedEdgeUsdc: 0,
  liveRealizedPnlUsdc: 0,
  liveVsExpectedDeltaUsdc: 0,
  paperExpectedTradeCount: 0,
  paperFilledTradeCount: 0,
  paperMissedTradeCount: 0,
  matchedLiveTradeCount: 0,
  paperVsLiveDeltaUsdc: 0
});

const summarizeSession = (report: SmallLiveReport): SmallLiveRollupSessionSummary => ({
  sessionName: report.sessionName,
  generatedAtMs: report.generatedAtMs,
  overallStatus: report.overallStatus,
  finalRiskState: report.finalRiskState,
  liveTradeCount: report.realizedSession.tradeCount,
  liveRealizedPnlUsdc: round(report.realizedSession.totalRealizedPnlUsdc),
  liveVsExpectedDeltaUsdc: round(report.realizedSession.realizedVsExpectedDeltaUsdc),
  paperVsLiveDeltaUsdc: report.comparison
    ? round(report.comparison.totalPaperVsLiveDeltaUsdc)
    : undefined,
  paperAverageObservedVenueLatencyMs: report.paperSession?.averageObservedVenueLatencyMs,
  paperAverageObservedBookSkewMs: report.paperSession?.averageObservedBookSkewMs,
  paperCheckpointRecoveryReady: report.paperSession?.checkpointRecoveryReady,
  openLotCount: report.checkpoint?.openLotCount,
  activeOrderCount: report.checkpoint?.activeOrderCount,
  riskStressScore: report.checkpoint?.riskBudgetAdjustment?.stressScore,
  sharedBuyBudgetMultiplier: report.checkpoint?.riskBudgetAdjustment?.sharedBuyBudgetMultiplier,
  dailyRoiPct: report.kpis.dailyRoiPct,
  rewardIncomeUsdc: report.kpis.rewardIncomeUsdc,
  rebateIncomeUsdc: report.kpis.rebateIncomeUsdc,
  residualInventoryUtilizationPct: report.kpis.residualInventoryUtilizationPct,
  yesNoImbalancePct: report.kpis.yesNoImbalancePct,
  flagCodes: report.flags.map((flag) => flag.code)
});

export const buildSmallLiveRollupReport = (input: {
  groupName?: string;
  generatedAtMs?: number;
  reports: readonly SmallLiveReport[];
}): SmallLiveRollupReport => {
  if (input.reports.length === 0) {
    throw new Error("At least one small-live report is required to build a rollup report.");
  }

  const sessions = input.reports
    .map((report) => summarizeSession(report))
    .sort((left, right) => left.generatedAtMs - right.generatedAtMs);
  const byFlag = new Map<SmallLiveReportFlagCode, FlagAggregate>();
  const byStrategy = new Map<StrategyName, StrategyAggregate>();
  const statusCounts: Record<SmallLiveReportStatus, number> = {
    ok: 0,
    review: 0,
    halted: 0
  };
  const byPaperConfidence = new Map<
    SmallLiveRollupPaperConfidenceSummary["label"],
    Omit<SmallLiveRollupPaperConfidenceSummary, "label">
  >();
  const byObservedLatency = new Map<
    SmallLiveRollupObservedLatencySummary["label"],
    Omit<
      SmallLiveRollupObservedLatencySummary,
      "label" | "averageObservedVenueLatencyMs" | "averageObservedBookSkewMs"
    > & {
      observedVenueLatencyTotalMs: number;
      observedVenueLatencyCount: number;
      observedBookSkewTotalMs: number;
      observedBookSkewCount: number;
    }
  >();
  const finalRiskStateCounts: Record<RiskState, number> = {
    RUNNING: 0,
    WARNING: 0,
    DEGRADED: 0,
    RECOVERY: 0,
    HALTED: 0
  };

  let sessionWithoutPaperCount = 0;
  let sessionWithoutCheckpointCount = 0;
  let sessionWithPaperCheckpointValidationCount = 0;
  let sessionWithPaperCheckpointReadyCount = 0;
  let sessionWithPaperCheckpointNotReadyCount = 0;
  let sessionWithRestartDrillCount = 0;
  let restartDrillPassedCount = 0;
  let restartDrillWarningCount = 0;
  let restartDrillFailedCount = 0;
  let sessionsWithResidualInventoryCount = 0;
  let sessionsWithResidualActiveOrdersCount = 0;
  let sessionsWithRiskBudgetAdjustmentCount = 0;
  let totalLiveTradeCount = 0;
  let totalLiveExpectedEdgeUsdc = 0;
  let totalLiveRealizedPnlUsdc = 0;
  let totalLiveVsExpectedDeltaUsdc = 0;
  let totalPaperVsLiveDeltaUsdc = 0;
  let sessionsWithKpisCount = 0;
  let totalDailyRoiPct = 0;
  let totalRewardIncomeUsdc = 0;
  let totalRebateIncomeUsdc = 0;
  let maxResidualInventoryUtilizationPct = 0;
  let maxYesNoImbalancePct = 0;
  let hasYesNoImbalance = false;
  const reasonAgg = new Map<string, { count: number; totalPnlUsdc: number; wins: number }>();
  let totalStressScore = 0;
  let maxStressScore = 0;
  let totalSharedBuyBudgetMultiplier = 0;
  let minSharedBuyBudgetMultiplier = Number.POSITIVE_INFINITY;
  const strategyMinBuyBudgetMultipliers: RiskBudgetAdjustmentSnapshot["strategyBuyBudgetMultipliers"] =
    {
      "market-making": Number.POSITIVE_INFINITY,
      "same-market-arb": Number.POSITIVE_INFINITY,
      "negative-risk": Number.POSITIVE_INFINITY
    };

  for (const report of input.reports) {
    statusCounts[report.overallStatus] += 1;
    finalRiskStateCounts[report.finalRiskState] += 1;

    if (!report.paperSession) {
      sessionWithoutPaperCount += 1;
    }
    if (!report.checkpoint) {
      sessionWithoutCheckpointCount += 1;
    }
    if (typeof report.paperSession?.checkpointRecoveryReady === "boolean") {
      sessionWithPaperCheckpointValidationCount += 1;
      if (report.paperSession.checkpointRecoveryReady) {
        sessionWithPaperCheckpointReadyCount += 1;
      } else {
        sessionWithPaperCheckpointNotReadyCount += 1;
      }
    }
    if (report.restartDrill) {
      sessionWithRestartDrillCount += 1;
      if (report.restartDrill.outcome === "passed") {
        restartDrillPassedCount += 1;
      } else if (report.restartDrill.outcome === "warning") {
        restartDrillWarningCount += 1;
      } else {
        restartDrillFailedCount += 1;
      }
    }
    if ((report.checkpoint?.openLotCount ?? 0) > 0) {
      sessionsWithResidualInventoryCount += 1;
    }
    if ((report.checkpoint?.activeOrderCount ?? 0) > 0) {
      sessionsWithResidualActiveOrdersCount += 1;
    }
    if (report.checkpoint?.riskBudgetAdjustment) {
      sessionsWithRiskBudgetAdjustmentCount += 1;
      totalStressScore += report.checkpoint.riskBudgetAdjustment.stressScore;
      maxStressScore = Math.max(maxStressScore, report.checkpoint.riskBudgetAdjustment.stressScore);
      totalSharedBuyBudgetMultiplier +=
        report.checkpoint.riskBudgetAdjustment.sharedBuyBudgetMultiplier;
      minSharedBuyBudgetMultiplier = Math.min(
        minSharedBuyBudgetMultiplier,
        report.checkpoint.riskBudgetAdjustment.sharedBuyBudgetMultiplier
      );
      for (const strategy of Object.keys(
        report.checkpoint.riskBudgetAdjustment.strategyBuyBudgetMultipliers
      ) as Array<keyof RiskBudgetAdjustmentSnapshot["strategyBuyBudgetMultipliers"]>) {
        strategyMinBuyBudgetMultipliers[strategy] = Math.min(
          strategyMinBuyBudgetMultipliers[strategy],
          report.checkpoint.riskBudgetAdjustment.strategyBuyBudgetMultipliers[strategy]
        );
      }
    }

    totalLiveTradeCount += report.realizedSession.tradeCount;
    totalLiveExpectedEdgeUsdc += report.realizedSession.totalExpectedEdgeUsdc;
    totalLiveRealizedPnlUsdc += report.realizedSession.totalRealizedPnlUsdc;
    totalLiveVsExpectedDeltaUsdc += report.realizedSession.realizedVsExpectedDeltaUsdc;
    totalPaperVsLiveDeltaUsdc += report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0;

    // Aggregate trade reasons from individual trade records.
    for (const trade of report.realizedSession.trades ?? []) {
      const reason = trade.detail ?? (trade.tags.length > 1 ? trade.tags[1] : undefined) ?? "unknown";
      const entry = reasonAgg.get(reason) ?? { count: 0, totalPnlUsdc: 0, wins: 0 };
      entry.count += 1;
      entry.totalPnlUsdc += trade.realizedPnlUsdc;
      if (trade.realizedPnlUsdc > 0) entry.wins += 1;
      reasonAgg.set(reason, entry);
    }

    sessionsWithKpisCount += 1;
    totalDailyRoiPct += report.kpis.dailyRoiPct;
    totalRewardIncomeUsdc += report.kpis.rewardIncomeUsdc;
    totalRebateIncomeUsdc += report.kpis.rebateIncomeUsdc;
    maxResidualInventoryUtilizationPct = Math.max(
      maxResidualInventoryUtilizationPct,
      report.kpis.residualInventoryUtilizationPct
    );
    if (typeof report.kpis.yesNoImbalancePct === "number") {
      hasYesNoImbalance = true;
      maxYesNoImbalancePct = Math.max(maxYesNoImbalancePct, report.kpis.yesNoImbalancePct);
    }

    for (const bucket of report.comparison?.byConfidence ?? []) {
      const aggregate = byPaperConfidence.get(bucket.label) ?? {
        paperTradeCount: 0,
        paperExpectedRealizedPnlUsdc: 0,
        matchedLiveTradeCount: 0,
        matchedLiveRealizedPnlUsdc: 0,
        liveVsPaperDeltaUsdc: 0
      };
      aggregate.paperTradeCount += bucket.paperTradeCount;
      aggregate.paperExpectedRealizedPnlUsdc += bucket.paperExpectedRealizedPnlUsdc;
      aggregate.matchedLiveTradeCount += bucket.matchedLiveTradeCount;
      aggregate.matchedLiveRealizedPnlUsdc += bucket.matchedLiveRealizedPnlUsdc;
      aggregate.liveVsPaperDeltaUsdc += bucket.liveVsPaperDeltaUsdc;
      byPaperConfidence.set(bucket.label, aggregate);
    }

    for (const bucket of report.comparison?.byObservedLatency ?? []) {
      const aggregate = byObservedLatency.get(bucket.label) ?? {
        paperTradeCount: 0,
        paperExpectedRealizedPnlUsdc: 0,
        matchedLiveTradeCount: 0,
        matchedLiveRealizedPnlUsdc: 0,
        liveVsPaperDeltaUsdc: 0,
        observedVenueLatencyTotalMs: 0,
        observedVenueLatencyCount: 0,
        observedBookSkewTotalMs: 0,
        observedBookSkewCount: 0
      };
      aggregate.paperTradeCount += bucket.paperTradeCount;
      aggregate.paperExpectedRealizedPnlUsdc += bucket.paperExpectedRealizedPnlUsdc;
      aggregate.matchedLiveTradeCount += bucket.matchedLiveTradeCount;
      aggregate.matchedLiveRealizedPnlUsdc += bucket.matchedLiveRealizedPnlUsdc;
      aggregate.liveVsPaperDeltaUsdc += bucket.liveVsPaperDeltaUsdc;
      if (typeof bucket.averageObservedVenueLatencyMs === "number") {
        aggregate.observedVenueLatencyTotalMs +=
          bucket.averageObservedVenueLatencyMs * bucket.paperTradeCount;
        aggregate.observedVenueLatencyCount += bucket.paperTradeCount;
      }
      if (typeof bucket.averageObservedBookSkewMs === "number") {
        aggregate.observedBookSkewTotalMs += bucket.averageObservedBookSkewMs * bucket.paperTradeCount;
        aggregate.observedBookSkewCount += bucket.paperTradeCount;
      }
      byObservedLatency.set(bucket.label, aggregate);
    }

    for (const flag of report.flags) {
      const aggregate = byFlag.get(flag.code) ?? {
        count: 0,
        criticalCount: 0,
        warningCount: 0
      };
      aggregate.count += 1;
      if (flag.severity === "critical") {
        aggregate.criticalCount += 1;
      } else {
        aggregate.warningCount += 1;
      }
      byFlag.set(flag.code, aggregate);
    }

    for (const strategy of report.byStrategy) {
      const aggregate = byStrategy.get(strategy.strategy) ?? createStrategyAggregate();
      aggregate.sessionCount += 1;
      if (report.overallStatus === "review") {
        aggregate.reviewSessionCount += 1;
      }
      if (report.overallStatus === "halted") {
        aggregate.haltedSessionCount += 1;
      }
      aggregate.liveTradeCount += strategy.liveTradeCount;
      aggregate.liveWinningTrades += strategy.liveWinningTrades;
      aggregate.liveLosingTrades += strategy.liveLosingTrades;
      aggregate.liveFlatTrades += strategy.liveFlatTrades;
      aggregate.liveExpectedEdgeUsdc += strategy.liveExpectedEdgeUsdc;
      aggregate.liveRealizedPnlUsdc += strategy.liveRealizedPnlUsdc;
      aggregate.liveVsExpectedDeltaUsdc += strategy.liveVsExpectedDeltaUsdc;
      aggregate.paperExpectedTradeCount += strategy.paperExpectedTradeCount ?? 0;
      aggregate.paperFilledTradeCount += strategy.paperFilledTradeCount ?? 0;
      aggregate.paperMissedTradeCount += strategy.paperMissedTradeCount ?? 0;
      aggregate.matchedLiveTradeCount += strategy.matchedLiveTradeCount ?? 0;
      aggregate.paperVsLiveDeltaUsdc += strategy.paperVsLiveDeltaUsdc ?? 0;
      byStrategy.set(strategy.strategy, aggregate);
    }
  }

  const bestSessionByLivePnl = [...sessions].sort(
    (left, right) => right.liveRealizedPnlUsdc - left.liveRealizedPnlUsdc
  )[0];
  const worstSessionByLivePnl = [...sessions].sort(
    (left, right) => left.liveRealizedPnlUsdc - right.liveRealizedPnlUsdc
  )[0];
  const worstSessionByPaperDelta = [...sessions]
    .filter((session) => typeof session.paperVsLiveDeltaUsdc === "number")
    .sort(
      (left, right) =>
        (left.paperVsLiveDeltaUsdc ?? Number.POSITIVE_INFINITY) -
        (right.paperVsLiveDeltaUsdc ?? Number.POSITIVE_INFINITY)
    )[0];

  return {
    reportType: "small_live_rollup",
    schemaVersion: 1,
    groupName: input.groupName ?? "small-live-rollup",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    sessionCount: input.reports.length,
    statusCounts,
    finalRiskStateCounts,
    sessionWithoutPaperCount,
    sessionWithoutCheckpointCount,
    sessionWithPaperCheckpointValidationCount,
    sessionWithPaperCheckpointReadyCount,
    sessionWithPaperCheckpointNotReadyCount,
    sessionWithRestartDrillCount,
    restartDrillPassedCount,
    restartDrillWarningCount,
    restartDrillFailedCount,
    sessionsWithResidualInventoryCount,
    sessionsWithResidualActiveOrdersCount,
    sessionsWithRiskBudgetAdjustmentCount,
    totalLiveTradeCount,
    totalLiveExpectedEdgeUsdc: round(totalLiveExpectedEdgeUsdc),
    totalLiveRealizedPnlUsdc: round(totalLiveRealizedPnlUsdc),
    totalLiveVsExpectedDeltaUsdc: round(totalLiveVsExpectedDeltaUsdc),
    totalPaperVsLiveDeltaUsdc: round(totalPaperVsLiveDeltaUsdc),
    kpis:
      sessionsWithKpisCount > 0
        ? {
            averageDailyRoiPct: round(totalDailyRoiPct / sessionsWithKpisCount),
            totalRewardIncomeUsdc: round(totalRewardIncomeUsdc),
            totalRebateIncomeUsdc: round(totalRebateIncomeUsdc),
            maxResidualInventoryUtilizationPct: round(maxResidualInventoryUtilizationPct),
            maxYesNoImbalancePct: hasYesNoImbalance ? round(maxYesNoImbalancePct) : undefined
          }
        : undefined,
    riskBudgetAdjustment:
      sessionsWithRiskBudgetAdjustmentCount > 0
        ? {
            averageStressScore: round(
              totalStressScore / sessionsWithRiskBudgetAdjustmentCount
            ),
            maxStressScore: round(maxStressScore),
            averageSharedBuyBudgetMultiplier: round(
              totalSharedBuyBudgetMultiplier / sessionsWithRiskBudgetAdjustmentCount
            ),
            minSharedBuyBudgetMultiplier: round(minSharedBuyBudgetMultiplier),
            strategyMinBuyBudgetMultipliers: {
              "market-making": round(strategyMinBuyBudgetMultipliers["market-making"]),
              "same-market-arb": round(
                strategyMinBuyBudgetMultipliers["same-market-arb"]
              ),
              "negative-risk": round(
                strategyMinBuyBudgetMultipliers["negative-risk"]
              )
            }
          }
        : undefined,
    bestSessionByLivePnl,
    worstSessionByLivePnl,
    worstSessionByPaperDelta,
    reasonBreakdown: reasonAgg.size > 0
      ? Object.fromEntries(
          [...reasonAgg.entries()]
            .sort(([, a], [, b]) => b.count - a.count)
            .map(([reason, agg]) => [
              reason,
              {
                count: agg.count,
                totalPnlUsdc: round(agg.totalPnlUsdc),
                winRate: agg.count > 0 ? round(agg.wins / agg.count) : 0
              }
            ])
        )
      : undefined,
    byPaperConfidence: [...byPaperConfidence.entries()]
      .map(([label, aggregate]) => ({
        label,
        paperTradeCount: aggregate.paperTradeCount,
        paperExpectedRealizedPnlUsdc: round(aggregate.paperExpectedRealizedPnlUsdc),
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        matchedLiveRealizedPnlUsdc: round(aggregate.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(aggregate.liveVsPaperDeltaUsdc)
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byObservedLatency: [...byObservedLatency.entries()]
      .map(([label, aggregate]) => ({
        label,
        paperTradeCount: aggregate.paperTradeCount,
        paperExpectedRealizedPnlUsdc: round(aggregate.paperExpectedRealizedPnlUsdc),
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        matchedLiveRealizedPnlUsdc: round(aggregate.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(aggregate.liveVsPaperDeltaUsdc),
        averageObservedVenueLatencyMs:
          aggregate.observedVenueLatencyCount > 0
            ? round(aggregate.observedVenueLatencyTotalMs / aggregate.observedVenueLatencyCount)
            : undefined,
        averageObservedBookSkewMs:
          aggregate.observedBookSkewCount > 0
            ? round(aggregate.observedBookSkewTotalMs / aggregate.observedBookSkewCount)
            : undefined
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byFlag: [...byFlag.entries()]
      .map(([code, aggregate]) => ({
        code,
        count: aggregate.count,
        criticalCount: aggregate.criticalCount,
        warningCount: aggregate.warningCount
      }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    byStrategy: [...byStrategy.entries()]
      .map(([strategy, aggregate]) => ({
        strategy,
        sessionCount: aggregate.sessionCount,
        reviewSessionCount: aggregate.reviewSessionCount,
        haltedSessionCount: aggregate.haltedSessionCount,
        liveTradeCount: aggregate.liveTradeCount,
        liveWinningTrades: aggregate.liveWinningTrades,
        liveLosingTrades: aggregate.liveLosingTrades,
        liveFlatTrades: aggregate.liveFlatTrades,
        liveExpectedEdgeUsdc: round(aggregate.liveExpectedEdgeUsdc),
        liveRealizedPnlUsdc: round(aggregate.liveRealizedPnlUsdc),
        liveVsExpectedDeltaUsdc: round(aggregate.liveVsExpectedDeltaUsdc),
        paperExpectedTradeCount: aggregate.paperExpectedTradeCount,
        paperFilledTradeCount: aggregate.paperFilledTradeCount,
        paperMissedTradeCount: aggregate.paperMissedTradeCount,
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        paperVsLiveDeltaUsdc: round(aggregate.paperVsLiveDeltaUsdc)
      }))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    sessions
  };
};
