import type { RiskState, StrategyName } from "../core/types.js";
import type {
  SmallLiveReport,
  SmallLiveReportStatus,
  SmallLiveStrategySummary
} from "./small-live-report.js";

export type OperationsKpiRollupSessionSummary = {
  sessionName: string;
  sessionAtMs: number;
  sessionDayKey: string;
  overallStatus: SmallLiveReportStatus;
  finalRiskState: RiskState;
  tradeCount: number;
  liveRealizedPnlUsdc: number;
  liveVsExpectedDeltaUsdc: number;
  paperVsLiveDeltaUsdc?: number;
  dailyRoiPct: number;
  rewardIncomeUsdc: number;
  rebateIncomeUsdc: number;
  residualInventoryUtilizationPct: number;
  yesNoImbalancePct?: number;
  riskStressScore?: number;
  sharedBuyBudgetMultiplier?: number;
};

export type OperationsKpiRollupStrategySummary = {
  strategy: StrategyName;
  sessionCount: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  totalExpectedEdgeUsdc: number;
  totalRealizedPnlUsdc: number;
  totalLiveVsExpectedDeltaUsdc: number;
  totalPaperVsLiveDeltaUsdc: number;
  averageTradeExpectedEdgeUsdc: number;
  averageTradeNetPnlUsdc: number;
};

export type OperationsKpiRollupWindowSummary = {
  scope: "overall" | "weekly" | "monthly";
  key: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
  statusCounts: Record<SmallLiveReportStatus, number>;
  finalRiskStateCounts: Record<RiskState, number>;
  sessionsWithPaperCount: number;
  sessionsWithCheckpointCount: number;
  sessionsWithPaperCheckpointReadyCount: number;
  sessionsWithPaperCheckpointNotReadyCount: number;
  sessionsWithRestartDrillCount: number;
  totalTradeCount: number;
  totalExpectedEdgeUsdc: number;
  totalLiveRealizedPnlUsdc: number;
  totalLiveVsExpectedDeltaUsdc: number;
  totalPaperVsLiveDeltaUsdc: number;
  averageTradeExpectedEdgeUsdc: number;
  averageTradeNetPnlUsdc: number;
  averageDailyRoiPct: number;
  maxDailyRoiPct: number;
  minDailyRoiPct: number;
  totalRewardIncomeUsdc: number;
  totalRebateIncomeUsdc: number;
  averageRewardShareOfPositiveCreditsPct: number;
  averageRebateShareOfPositiveCreditsPct: number;
  averageResidualInventoryUtilizationPct: number;
  maxResidualInventoryUtilizationPct: number;
  averageYesNoImbalancePct?: number;
  maxYesNoImbalancePct?: number;
  averageStressScore?: number;
  maxStressScore?: number;
  averageSharedBuyBudgetMultiplier?: number;
  minSharedBuyBudgetMultiplier?: number;
  /** Aggregated trade reason breakdown across all sessions in this window. */
  reasonBreakdown?: Record<string, { count: number; totalPnlUsdc: number; winRate: number }>;
  bestSessionByLivePnl?: OperationsKpiRollupSessionSummary;
  worstSessionByLivePnl?: OperationsKpiRollupSessionSummary;
  worstSessionByPaperDelta?: OperationsKpiRollupSessionSummary;
  byStrategy: OperationsKpiRollupStrategySummary[];
};

export type OperationsKpiRollupReport = {
  reportType: "operations_kpi_rollup";
  schemaVersion: 1;
  groupName: string;
  generatedAtMs: number;
  sourceSessionCount: number;
  overall: OperationsKpiRollupWindowSummary;
  weekly: OperationsKpiRollupWindowSummary[];
  monthly: OperationsKpiRollupWindowSummary[];
};

type StrategyAggregate = {
  sessionCount: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  totalExpectedEdgeUsdc: number;
  totalRealizedPnlUsdc: number;
  totalLiveVsExpectedDeltaUsdc: number;
  totalPaperVsLiveDeltaUsdc: number;
};

type WindowAggregate = {
  startAtMs: number;
  endAtMs: number;
  statusCounts: Record<SmallLiveReportStatus, number>;
  finalRiskStateCounts: Record<RiskState, number>;
  sessionsWithPaperCount: number;
  sessionsWithCheckpointCount: number;
  sessionsWithPaperCheckpointReadyCount: number;
  sessionsWithPaperCheckpointNotReadyCount: number;
  sessionsWithRestartDrillCount: number;
  totalTradeCount: number;
  totalExpectedEdgeUsdc: number;
  totalLiveRealizedPnlUsdc: number;
  totalLiveVsExpectedDeltaUsdc: number;
  totalPaperVsLiveDeltaUsdc: number;
  totalDailyRoiPct: number;
  maxDailyRoiPct: number;
  minDailyRoiPct: number;
  totalRewardIncomeUsdc: number;
  totalRebateIncomeUsdc: number;
  totalRewardShareOfPositiveCreditsPct: number;
  totalRebateShareOfPositiveCreditsPct: number;
  totalResidualInventoryUtilizationPct: number;
  maxResidualInventoryUtilizationPct: number;
  totalYesNoImbalancePct: number;
  yesNoImbalanceCount: number;
  maxYesNoImbalancePct: number;
  totalStressScore: number;
  stressCount: number;
  maxStressScore: number;
  totalSharedBuyBudgetMultiplier: number;
  sharedBuyBudgetMultiplierCount: number;
  minSharedBuyBudgetMultiplier: number;
  byStrategy: Map<StrategyName, StrategyAggregate>;
  sessions: OperationsKpiRollupSessionSummary[];
};

type WindowDescriptor = {
  key: string;
  startDate: string;
  endDate: string;
  startAtMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (value: number): number => Number(value.toFixed(8));
const pad2 = (value: number): string => value.toString().padStart(2, "0");

const createStrategyAggregate = (): StrategyAggregate => ({
  sessionCount: 0,
  tradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0,
  totalExpectedEdgeUsdc: 0,
  totalRealizedPnlUsdc: 0,
  totalLiveVsExpectedDeltaUsdc: 0,
  totalPaperVsLiveDeltaUsdc: 0
});

const createWindowAggregate = (): WindowAggregate => ({
  startAtMs: Number.POSITIVE_INFINITY,
  endAtMs: 0,
  statusCounts: {
    ok: 0,
    review: 0,
    halted: 0
  },
  finalRiskStateCounts: {
    RUNNING: 0,
    WARNING: 0,
    DEGRADED: 0,
    RECOVERY: 0,
    HALTED: 0
  },
  sessionsWithPaperCount: 0,
  sessionsWithCheckpointCount: 0,
  sessionsWithPaperCheckpointReadyCount: 0,
  sessionsWithPaperCheckpointNotReadyCount: 0,
  sessionsWithRestartDrillCount: 0,
  totalTradeCount: 0,
  totalExpectedEdgeUsdc: 0,
  totalLiveRealizedPnlUsdc: 0,
  totalLiveVsExpectedDeltaUsdc: 0,
  totalPaperVsLiveDeltaUsdc: 0,
  totalDailyRoiPct: 0,
  maxDailyRoiPct: Number.NEGATIVE_INFINITY,
  minDailyRoiPct: Number.POSITIVE_INFINITY,
  totalRewardIncomeUsdc: 0,
  totalRebateIncomeUsdc: 0,
  totalRewardShareOfPositiveCreditsPct: 0,
  totalRebateShareOfPositiveCreditsPct: 0,
  totalResidualInventoryUtilizationPct: 0,
  maxResidualInventoryUtilizationPct: 0,
  totalYesNoImbalancePct: 0,
  yesNoImbalanceCount: 0,
  maxYesNoImbalancePct: 0,
  totalStressScore: 0,
  stressCount: 0,
  maxStressScore: 0,
  totalSharedBuyBudgetMultiplier: 0,
  sharedBuyBudgetMultiplierCount: 0,
  minSharedBuyBudgetMultiplier: Number.POSITIVE_INFINITY,
  byStrategy: new Map<StrategyName, StrategyAggregate>(),
  sessions: []
});

const formatDayKeyUtc = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

const getSessionTimestamp = (report: SmallLiveReport): number =>
  report.realizedSession.endedAtMs ?? report.checkpoint?.generatedAtMs ?? report.generatedAtMs;

const summarizeSession = (report: SmallLiveReport): OperationsKpiRollupSessionSummary => {
  const sessionAtMs = getSessionTimestamp(report);
  return {
    sessionName: report.sessionName,
    sessionAtMs,
    sessionDayKey: formatDayKeyUtc(sessionAtMs),
    overallStatus: report.overallStatus,
    finalRiskState: report.finalRiskState,
    tradeCount: report.realizedSession.tradeCount,
    liveRealizedPnlUsdc: round(report.realizedSession.totalRealizedPnlUsdc),
    liveVsExpectedDeltaUsdc: round(report.realizedSession.realizedVsExpectedDeltaUsdc),
    paperVsLiveDeltaUsdc: report.comparison
      ? round(report.comparison.totalPaperVsLiveDeltaUsdc)
      : undefined,
    dailyRoiPct: round(report.kpis.dailyRoiPct),
    rewardIncomeUsdc: round(report.kpis.rewardIncomeUsdc),
    rebateIncomeUsdc: round(report.kpis.rebateIncomeUsdc),
    residualInventoryUtilizationPct: round(report.kpis.residualInventoryUtilizationPct),
    yesNoImbalancePct:
      typeof report.kpis.yesNoImbalancePct === "number"
        ? round(report.kpis.yesNoImbalancePct)
        : undefined,
    riskStressScore: report.checkpoint?.riskBudgetAdjustment?.stressScore,
    sharedBuyBudgetMultiplier: report.checkpoint?.riskBudgetAdjustment?.sharedBuyBudgetMultiplier
  };
};

const getIsoWeekDescriptor = (timestamp: number): WindowDescriptor => {
  const date = new Date(timestamp);
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);

  const weekYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / DAY_MS) + 1) / 7);

  const weekStart = new Date(utcDate.getTime());
  weekStart.setUTCDate(utcDate.getUTCDate() - 3);
  const weekEnd = new Date(weekStart.getTime());
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  return {
    key: `${weekYear}-W${pad2(weekNumber)}`,
    startDate: formatDayKeyUtc(weekStart.getTime()),
    endDate: formatDayKeyUtc(weekEnd.getTime()),
    startAtMs: weekStart.getTime()
  };
};

const getMonthDescriptor = (timestamp: number): WindowDescriptor => {
  const date = new Date(timestamp);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);

  return {
    key: `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`,
    startDate: formatDayKeyUtc(monthStart),
    endDate: formatDayKeyUtc(monthEnd),
    startAtMs: monthStart
  };
};

const accumulateStrategy = (
  aggregate: Map<StrategyName, StrategyAggregate>,
  summary: SmallLiveStrategySummary
): void => {
  const strategyAggregate = aggregate.get(summary.strategy) ?? createStrategyAggregate();
  strategyAggregate.sessionCount += 1;
  strategyAggregate.tradeCount += summary.liveTradeCount;
  strategyAggregate.winningTrades += summary.liveWinningTrades;
  strategyAggregate.losingTrades += summary.liveLosingTrades;
  strategyAggregate.flatTrades += summary.liveFlatTrades;
  strategyAggregate.totalExpectedEdgeUsdc += summary.liveExpectedEdgeUsdc;
  strategyAggregate.totalRealizedPnlUsdc += summary.liveRealizedPnlUsdc;
  strategyAggregate.totalLiveVsExpectedDeltaUsdc += summary.liveVsExpectedDeltaUsdc;
  strategyAggregate.totalPaperVsLiveDeltaUsdc += summary.paperVsLiveDeltaUsdc ?? 0;
  aggregate.set(summary.strategy, strategyAggregate);
};

const accumulateReport = (
  aggregate: WindowAggregate,
  report: SmallLiveReport,
  sessionSummary: OperationsKpiRollupSessionSummary
): void => {
  const sessionAtMs = sessionSummary.sessionAtMs;
  aggregate.startAtMs = Math.min(aggregate.startAtMs, sessionAtMs);
  aggregate.endAtMs = Math.max(aggregate.endAtMs, sessionAtMs);
  aggregate.statusCounts[report.overallStatus] += 1;
  aggregate.finalRiskStateCounts[report.finalRiskState] += 1;

  if (report.paperSession) {
    aggregate.sessionsWithPaperCount += 1;
    if (report.paperSession.checkpointRecoveryReady === true) {
      aggregate.sessionsWithPaperCheckpointReadyCount += 1;
    } else if (report.paperSession.checkpointRecoveryReady === false) {
      aggregate.sessionsWithPaperCheckpointNotReadyCount += 1;
    }
  }

  if (report.checkpoint) {
    aggregate.sessionsWithCheckpointCount += 1;
  }

  if (report.restartDrill) {
    aggregate.sessionsWithRestartDrillCount += 1;
  }

  aggregate.totalTradeCount += report.realizedSession.tradeCount;
  aggregate.totalExpectedEdgeUsdc += report.realizedSession.totalExpectedEdgeUsdc;
  aggregate.totalLiveRealizedPnlUsdc += report.realizedSession.totalRealizedPnlUsdc;
  aggregate.totalLiveVsExpectedDeltaUsdc += report.realizedSession.realizedVsExpectedDeltaUsdc;
  aggregate.totalPaperVsLiveDeltaUsdc += report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0;

  aggregate.totalDailyRoiPct += report.kpis.dailyRoiPct;
  aggregate.maxDailyRoiPct = Math.max(aggregate.maxDailyRoiPct, report.kpis.dailyRoiPct);
  aggregate.minDailyRoiPct = Math.min(aggregate.minDailyRoiPct, report.kpis.dailyRoiPct);
  aggregate.totalRewardIncomeUsdc += report.kpis.rewardIncomeUsdc;
  aggregate.totalRebateIncomeUsdc += report.kpis.rebateIncomeUsdc;
  aggregate.totalRewardShareOfPositiveCreditsPct += report.kpis.rewardShareOfPositiveCreditsPct;
  aggregate.totalRebateShareOfPositiveCreditsPct += report.kpis.rebateShareOfPositiveCreditsPct;
  aggregate.totalResidualInventoryUtilizationPct += report.kpis.residualInventoryUtilizationPct;
  aggregate.maxResidualInventoryUtilizationPct = Math.max(
    aggregate.maxResidualInventoryUtilizationPct,
    report.kpis.residualInventoryUtilizationPct
  );

  if (typeof report.kpis.yesNoImbalancePct === "number") {
    aggregate.totalYesNoImbalancePct += report.kpis.yesNoImbalancePct;
    aggregate.yesNoImbalanceCount += 1;
    aggregate.maxYesNoImbalancePct = Math.max(
      aggregate.maxYesNoImbalancePct,
      report.kpis.yesNoImbalancePct
    );
  }

  if (report.checkpoint?.riskBudgetAdjustment) {
    aggregate.totalStressScore += report.checkpoint.riskBudgetAdjustment.stressScore;
    aggregate.stressCount += 1;
    aggregate.maxStressScore = Math.max(
      aggregate.maxStressScore,
      report.checkpoint.riskBudgetAdjustment.stressScore
    );
    aggregate.totalSharedBuyBudgetMultiplier +=
      report.checkpoint.riskBudgetAdjustment.sharedBuyBudgetMultiplier;
    aggregate.sharedBuyBudgetMultiplierCount += 1;
    aggregate.minSharedBuyBudgetMultiplier = Math.min(
      aggregate.minSharedBuyBudgetMultiplier,
      report.checkpoint.riskBudgetAdjustment.sharedBuyBudgetMultiplier
    );
  }

  for (const strategy of report.byStrategy) {
    accumulateStrategy(aggregate.byStrategy, strategy);
  }

  aggregate.sessions.push(sessionSummary);
};

const toStrategySummaries = (
  aggregate: Map<StrategyName, StrategyAggregate>
): OperationsKpiRollupStrategySummary[] =>
  [...aggregate.entries()]
    .map(([strategy, entry]) => ({
      strategy,
      sessionCount: entry.sessionCount,
      tradeCount: entry.tradeCount,
      winningTrades: entry.winningTrades,
      losingTrades: entry.losingTrades,
      flatTrades: entry.flatTrades,
      totalExpectedEdgeUsdc: round(entry.totalExpectedEdgeUsdc),
      totalRealizedPnlUsdc: round(entry.totalRealizedPnlUsdc),
      totalLiveVsExpectedDeltaUsdc: round(entry.totalLiveVsExpectedDeltaUsdc),
      totalPaperVsLiveDeltaUsdc: round(entry.totalPaperVsLiveDeltaUsdc),
      averageTradeExpectedEdgeUsdc:
        entry.tradeCount > 0 ? round(entry.totalExpectedEdgeUsdc / entry.tradeCount) : 0,
      averageTradeNetPnlUsdc:
        entry.tradeCount > 0 ? round(entry.totalRealizedPnlUsdc / entry.tradeCount) : 0
    }))
    .sort((left, right) => left.strategy.localeCompare(right.strategy));

const sortByLivePnlDesc = (
  left: OperationsKpiRollupSessionSummary,
  right: OperationsKpiRollupSessionSummary
): number => right.liveRealizedPnlUsdc - left.liveRealizedPnlUsdc;

const sortByPaperDeltaAsc = (
  left: OperationsKpiRollupSessionSummary,
  right: OperationsKpiRollupSessionSummary
): number =>
  (left.paperVsLiveDeltaUsdc ?? Number.POSITIVE_INFINITY) -
  (right.paperVsLiveDeltaUsdc ?? Number.POSITIVE_INFINITY);

const toWindowSummary = (input: {
  scope: OperationsKpiRollupWindowSummary["scope"];
  key: string;
  startDate: string;
  endDate: string;
  aggregate: WindowAggregate;
}): OperationsKpiRollupWindowSummary => {
  const { aggregate } = input;
  const sessionCount = aggregate.sessions.length;
  const worstSessionByPaperDelta = [...aggregate.sessions]
    .filter((session) => typeof session.paperVsLiveDeltaUsdc === "number")
    .sort(sortByPaperDeltaAsc)[0];

  return {
    scope: input.scope,
    key: input.key,
    startDate: input.startDate,
    endDate: input.endDate,
    sessionCount,
    statusCounts: aggregate.statusCounts,
    finalRiskStateCounts: aggregate.finalRiskStateCounts,
    sessionsWithPaperCount: aggregate.sessionsWithPaperCount,
    sessionsWithCheckpointCount: aggregate.sessionsWithCheckpointCount,
    sessionsWithPaperCheckpointReadyCount: aggregate.sessionsWithPaperCheckpointReadyCount,
    sessionsWithPaperCheckpointNotReadyCount: aggregate.sessionsWithPaperCheckpointNotReadyCount,
    sessionsWithRestartDrillCount: aggregate.sessionsWithRestartDrillCount,
    totalTradeCount: aggregate.totalTradeCount,
    totalExpectedEdgeUsdc: round(aggregate.totalExpectedEdgeUsdc),
    totalLiveRealizedPnlUsdc: round(aggregate.totalLiveRealizedPnlUsdc),
    totalLiveVsExpectedDeltaUsdc: round(aggregate.totalLiveVsExpectedDeltaUsdc),
    totalPaperVsLiveDeltaUsdc: round(aggregate.totalPaperVsLiveDeltaUsdc),
    averageTradeExpectedEdgeUsdc:
      aggregate.totalTradeCount > 0
        ? round(aggregate.totalExpectedEdgeUsdc / aggregate.totalTradeCount)
        : 0,
    averageTradeNetPnlUsdc:
      aggregate.totalTradeCount > 0
        ? round(aggregate.totalLiveRealizedPnlUsdc / aggregate.totalTradeCount)
        : 0,
    averageDailyRoiPct: sessionCount > 0 ? round(aggregate.totalDailyRoiPct / sessionCount) : 0,
    maxDailyRoiPct: sessionCount > 0 ? round(aggregate.maxDailyRoiPct) : 0,
    minDailyRoiPct: sessionCount > 0 ? round(aggregate.minDailyRoiPct) : 0,
    totalRewardIncomeUsdc: round(aggregate.totalRewardIncomeUsdc),
    totalRebateIncomeUsdc: round(aggregate.totalRebateIncomeUsdc),
    averageRewardShareOfPositiveCreditsPct:
      sessionCount > 0
        ? round(aggregate.totalRewardShareOfPositiveCreditsPct / sessionCount)
        : 0,
    averageRebateShareOfPositiveCreditsPct:
      sessionCount > 0
        ? round(aggregate.totalRebateShareOfPositiveCreditsPct / sessionCount)
        : 0,
    averageResidualInventoryUtilizationPct:
      sessionCount > 0
        ? round(aggregate.totalResidualInventoryUtilizationPct / sessionCount)
        : 0,
    maxResidualInventoryUtilizationPct: round(aggregate.maxResidualInventoryUtilizationPct),
    averageYesNoImbalancePct:
      aggregate.yesNoImbalanceCount > 0
        ? round(aggregate.totalYesNoImbalancePct / aggregate.yesNoImbalanceCount)
        : undefined,
    maxYesNoImbalancePct:
      aggregate.yesNoImbalanceCount > 0 ? round(aggregate.maxYesNoImbalancePct) : undefined,
    averageStressScore:
      aggregate.stressCount > 0 ? round(aggregate.totalStressScore / aggregate.stressCount) : undefined,
    maxStressScore: aggregate.stressCount > 0 ? round(aggregate.maxStressScore) : undefined,
    averageSharedBuyBudgetMultiplier:
      aggregate.sharedBuyBudgetMultiplierCount > 0
        ? round(
            aggregate.totalSharedBuyBudgetMultiplier / aggregate.sharedBuyBudgetMultiplierCount
          )
        : undefined,
    minSharedBuyBudgetMultiplier:
      aggregate.sharedBuyBudgetMultiplierCount > 0
        ? round(aggregate.minSharedBuyBudgetMultiplier)
        : undefined,
    bestSessionByLivePnl: [...aggregate.sessions].sort(sortByLivePnlDesc)[0],
    worstSessionByLivePnl: [...aggregate.sessions].sort(
      (left, right) => left.liveRealizedPnlUsdc - right.liveRealizedPnlUsdc
    )[0],
    worstSessionByPaperDelta,
    byStrategy: toStrategySummaries(aggregate.byStrategy)
  };
};

export const buildOperationsKpiRollupReport = (input: {
  groupName?: string;
  generatedAtMs?: number;
  reports: readonly SmallLiveReport[];
}): OperationsKpiRollupReport => {
  if (input.reports.length === 0) {
    throw new Error("At least one small-live report is required to build an operations KPI rollup.");
  }

  const overallAggregate = createWindowAggregate();
  const weekly = new Map<string, { descriptor: WindowDescriptor; aggregate: WindowAggregate }>();
  const monthly = new Map<string, { descriptor: WindowDescriptor; aggregate: WindowAggregate }>();

  for (const report of input.reports) {
    const sessionSummary = summarizeSession(report);
    accumulateReport(overallAggregate, report, sessionSummary);

    const weekDescriptor = getIsoWeekDescriptor(sessionSummary.sessionAtMs);
    const weekEntry =
      weekly.get(weekDescriptor.key) ?? {
        descriptor: weekDescriptor,
        aggregate: createWindowAggregate()
      };
    accumulateReport(weekEntry.aggregate, report, sessionSummary);
    weekly.set(weekDescriptor.key, weekEntry);

    const monthDescriptor = getMonthDescriptor(sessionSummary.sessionAtMs);
    const monthEntry =
      monthly.get(monthDescriptor.key) ?? {
        descriptor: monthDescriptor,
        aggregate: createWindowAggregate()
      };
    accumulateReport(monthEntry.aggregate, report, sessionSummary);
    monthly.set(monthDescriptor.key, monthEntry);
  }

  return {
    reportType: "operations_kpi_rollup",
    schemaVersion: 1,
    groupName: input.groupName ?? "operations-kpi-rollup",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    sourceSessionCount: input.reports.length,
    overall: toWindowSummary({
      scope: "overall",
      key: input.groupName ?? "operations-kpi-rollup",
      startDate: formatDayKeyUtc(overallAggregate.startAtMs),
      endDate: formatDayKeyUtc(overallAggregate.endAtMs),
      aggregate: overallAggregate
    }),
    weekly: [...weekly.values()]
      .sort((left, right) => left.descriptor.startAtMs - right.descriptor.startAtMs)
      .map(({ descriptor, aggregate }) =>
        toWindowSummary({
          scope: "weekly",
          key: descriptor.key,
          startDate: descriptor.startDate,
          endDate: descriptor.endDate,
          aggregate
        })
      ),
    monthly: [...monthly.values()]
      .sort((left, right) => left.descriptor.startAtMs - right.descriptor.startAtMs)
      .map(({ descriptor, aggregate }) =>
        toWindowSummary({
          scope: "monthly",
          key: descriptor.key,
          startDate: descriptor.startDate,
          endDate: descriptor.endDate,
          aggregate
        })
      )
  };
};
