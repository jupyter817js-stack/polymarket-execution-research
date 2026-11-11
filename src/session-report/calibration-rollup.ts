import type { StrategyName } from "../core/types.js";
import type { SmallLiveReport, SmallLiveReportStatus } from "./small-live-report.js";

export type CalibrationRollupBucketSummary = {
  label: string;
  paperTradeCount: number;
  matchedLiveTradeCount: number;
  captureRatePct?: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
  pnlRealizationPct?: number;
};

export type CalibrationRollupObservedLatencySummary = CalibrationRollupBucketSummary & {
  averageObservedVenueLatencyMs?: number;
  averageObservedBookSkewMs?: number;
};

export type CalibrationRollupStrategySummary = {
  strategy: StrategyName;
  sessionCount: number;
  paperTradeCount: number;
  matchedLiveTradeCount: number;
  captureRatePct?: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
  pnlRealizationPct?: number;
};

export type CalibrationRollupSessionSummary = {
  sessionName: string;
  generatedAtMs: number;
  overallStatus: SmallLiveReportStatus;
  finalRiskState: SmallLiveReport["finalRiskState"];
  paperTradeCount: number;
  matchedLiveTradeCount: number;
  captureRatePct?: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
  pnlRealizationPct?: number;
  averageObservedVenueLatencyMs?: number;
  averageObservedBookSkewMs?: number;
  riskStressScore?: number;
  paperCheckpointRecoveryReady?: boolean;
};

export type CalibrationRollupReport = {
  reportType: "paper_live_calibration_rollup";
  schemaVersion: 1;
  groupName: string;
  generatedAtMs: number;
  sessionCount: number;
  sessionsWithPaperCount: number;
  sessionsWithoutPaperCount: number;
  sessionsWithCheckpointReadyPaperCount: number;
  statusCounts: Record<SmallLiveReportStatus, number>;
  totalPaperTradeCount: number;
  totalMatchedLiveTradeCount: number;
  totalUnmatchedPaperTradeCount: number;
  totalUnmatchedLiveTradeCount: number;
  overallCaptureRatePct?: number;
  totalPaperExpectedRealizedPnlUsdc: number;
  totalMatchedLiveRealizedPnlUsdc: number;
  totalLiveVsPaperDeltaUsdc: number;
  overallPnlRealizationPct?: number;
  byConfidence: CalibrationRollupBucketSummary[];
  byObservedLatency: CalibrationRollupObservedLatencySummary[];
  byStrategy: CalibrationRollupStrategySummary[];
  bestSessionByPaperDelta?: CalibrationRollupSessionSummary;
  worstSessionByPaperDelta?: CalibrationRollupSessionSummary;
  sessions: CalibrationRollupSessionSummary[];
};

type Aggregate = {
  paperTradeCount: number;
  matchedLiveTradeCount: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
};

type ObservedLatencyAggregate = Aggregate & {
  observedVenueLatencyTotalMs: number;
  observedVenueLatencyCount: number;
  observedBookSkewTotalMs: number;
  observedBookSkewCount: number;
};

type StrategyAggregate = Aggregate & {
  sessionCount: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const toPct = (numerator: number, denominator: number): number | undefined =>
  denominator > 0 ? round((numerator / denominator) * 100) : undefined;

const createAggregate = (): Aggregate => ({
  paperTradeCount: 0,
  matchedLiveTradeCount: 0,
  paperExpectedRealizedPnlUsdc: 0,
  matchedLiveRealizedPnlUsdc: 0,
  liveVsPaperDeltaUsdc: 0
});

const createObservedLatencyAggregate = (): ObservedLatencyAggregate => ({
  ...createAggregate(),
  observedVenueLatencyTotalMs: 0,
  observedVenueLatencyCount: 0,
  observedBookSkewTotalMs: 0,
  observedBookSkewCount: 0
});

const summarizeSession = (report: SmallLiveReport): CalibrationRollupSessionSummary => {
  const matchedLiveTradeCount = report.byStrategy.reduce(
    (total, strategy) => total + (strategy.matchedLiveTradeCount ?? 0),
    0
  );
  const matchedLiveRealizedPnlUsdc = report.byStrategy.reduce(
    (total, strategy) =>
      total +
      ((strategy.paperExpectedRealizedPnlUsdc ?? 0) + (strategy.paperVsLiveDeltaUsdc ?? 0)),
    0
  );
  const paperTradeCount = report.paperSession?.expectedTradeCount ?? 0;
  const paperExpectedRealizedPnlUsdc = report.paperSession?.totalExpectedRealizedPnlUsdc ?? 0;

  return {
    sessionName: report.sessionName,
    generatedAtMs: report.generatedAtMs,
    overallStatus: report.overallStatus,
    finalRiskState: report.finalRiskState,
    paperTradeCount,
    matchedLiveTradeCount,
    captureRatePct: toPct(matchedLiveTradeCount, paperTradeCount),
    paperExpectedRealizedPnlUsdc: round(paperExpectedRealizedPnlUsdc),
    matchedLiveRealizedPnlUsdc: round(matchedLiveRealizedPnlUsdc),
    liveVsPaperDeltaUsdc: round(report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0),
    pnlRealizationPct: toPct(matchedLiveRealizedPnlUsdc, paperExpectedRealizedPnlUsdc),
    averageObservedVenueLatencyMs: report.paperSession?.averageObservedVenueLatencyMs,
    averageObservedBookSkewMs: report.paperSession?.averageObservedBookSkewMs,
    riskStressScore: report.checkpoint?.riskBudgetAdjustment?.stressScore,
    paperCheckpointRecoveryReady: report.paperSession?.checkpointRecoveryReady
  };
};

export const buildCalibrationRollupReport = (input: {
  groupName?: string;
  generatedAtMs?: number;
  reports: readonly SmallLiveReport[];
}): CalibrationRollupReport => {
  if (input.reports.length === 0) {
    throw new Error("At least one small-live report is required to build a calibration rollup.");
  }

  const sessions = input.reports
    .map((report) => summarizeSession(report))
    .sort((left, right) => left.generatedAtMs - right.generatedAtMs);
  const byConfidence = new Map<string, Aggregate>();
  const byObservedLatency = new Map<string, ObservedLatencyAggregate>();
  const byStrategy = new Map<StrategyName, StrategyAggregate>();
  const statusCounts: Record<SmallLiveReportStatus, number> = {
    ok: 0,
    review: 0,
    halted: 0
  };

  let sessionsWithPaperCount = 0;
  let sessionsWithoutPaperCount = 0;
  let sessionsWithCheckpointReadyPaperCount = 0;
  let totalPaperTradeCount = 0;
  let totalMatchedLiveTradeCount = 0;
  let totalUnmatchedPaperTradeCount = 0;
  let totalUnmatchedLiveTradeCount = 0;
  let totalPaperExpectedRealizedPnlUsdc = 0;
  let totalMatchedLiveRealizedPnlUsdc = 0;
  let totalLiveVsPaperDeltaUsdc = 0;

  for (const report of input.reports) {
    statusCounts[report.overallStatus] += 1;

    if (report.paperSession) {
      sessionsWithPaperCount += 1;
      if (report.paperSession.checkpointRecoveryReady) {
        sessionsWithCheckpointReadyPaperCount += 1;
      }
    } else {
      sessionsWithoutPaperCount += 1;
    }

    totalPaperTradeCount += report.paperSession?.expectedTradeCount ?? 0;
    totalMatchedLiveTradeCount += report.byStrategy.reduce(
      (total, strategy) => total + (strategy.matchedLiveTradeCount ?? 0),
      0
    );
    totalUnmatchedPaperTradeCount += report.comparison?.unmatchedPaperTradeCount ?? 0;
    totalUnmatchedLiveTradeCount += report.comparison?.unmatchedLiveTradeCount ?? 0;
    totalPaperExpectedRealizedPnlUsdc += report.paperSession?.totalExpectedRealizedPnlUsdc ?? 0;
    totalMatchedLiveRealizedPnlUsdc += report.byStrategy.reduce(
      (total, strategy) =>
        total +
        ((strategy.paperExpectedRealizedPnlUsdc ?? 0) + (strategy.paperVsLiveDeltaUsdc ?? 0)),
      0
    );
    totalLiveVsPaperDeltaUsdc += report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0;

    for (const bucket of report.comparison?.byConfidence ?? []) {
      const aggregate = byConfidence.get(bucket.label) ?? createAggregate();
      aggregate.paperTradeCount += bucket.paperTradeCount;
      aggregate.matchedLiveTradeCount += bucket.matchedLiveTradeCount;
      aggregate.paperExpectedRealizedPnlUsdc += bucket.paperExpectedRealizedPnlUsdc;
      aggregate.matchedLiveRealizedPnlUsdc += bucket.matchedLiveRealizedPnlUsdc;
      aggregate.liveVsPaperDeltaUsdc += bucket.liveVsPaperDeltaUsdc;
      byConfidence.set(bucket.label, aggregate);
    }

    for (const bucket of report.comparison?.byObservedLatency ?? []) {
      const aggregate = byObservedLatency.get(bucket.label) ?? createObservedLatencyAggregate();
      aggregate.paperTradeCount += bucket.paperTradeCount;
      aggregate.matchedLiveTradeCount += bucket.matchedLiveTradeCount;
      aggregate.paperExpectedRealizedPnlUsdc += bucket.paperExpectedRealizedPnlUsdc;
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

    for (const strategy of report.byStrategy) {
      if (
        strategy.paperExpectedTradeCount === undefined &&
        strategy.matchedLiveTradeCount === undefined &&
        strategy.paperExpectedRealizedPnlUsdc === undefined
      ) {
        continue;
      }

      const aggregate = byStrategy.get(strategy.strategy) ?? {
        sessionCount: 0,
        ...createAggregate()
      };
      aggregate.sessionCount += 1;
      aggregate.paperTradeCount += strategy.paperExpectedTradeCount ?? 0;
      aggregate.matchedLiveTradeCount += strategy.matchedLiveTradeCount ?? 0;
      aggregate.paperExpectedRealizedPnlUsdc += strategy.paperExpectedRealizedPnlUsdc ?? 0;
      aggregate.liveVsPaperDeltaUsdc += strategy.paperVsLiveDeltaUsdc ?? 0;
      aggregate.matchedLiveRealizedPnlUsdc +=
        (strategy.paperExpectedRealizedPnlUsdc ?? 0) + (strategy.paperVsLiveDeltaUsdc ?? 0);
      byStrategy.set(strategy.strategy, aggregate);
    }
  }

  const bestSessionByPaperDelta = [...sessions]
    .filter((session) => typeof session.liveVsPaperDeltaUsdc === "number")
    .sort((left, right) => right.liveVsPaperDeltaUsdc - left.liveVsPaperDeltaUsdc)[0];
  const worstSessionByPaperDelta = [...sessions]
    .filter((session) => typeof session.liveVsPaperDeltaUsdc === "number")
    .sort((left, right) => left.liveVsPaperDeltaUsdc - right.liveVsPaperDeltaUsdc)[0];

  return {
    reportType: "paper_live_calibration_rollup",
    schemaVersion: 1,
    groupName: input.groupName ?? "paper-live-calibration",
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    sessionCount: input.reports.length,
    sessionsWithPaperCount,
    sessionsWithoutPaperCount,
    sessionsWithCheckpointReadyPaperCount,
    statusCounts,
    totalPaperTradeCount,
    totalMatchedLiveTradeCount,
    totalUnmatchedPaperTradeCount,
    totalUnmatchedLiveTradeCount,
    overallCaptureRatePct: toPct(totalMatchedLiveTradeCount, totalPaperTradeCount),
    totalPaperExpectedRealizedPnlUsdc: round(totalPaperExpectedRealizedPnlUsdc),
    totalMatchedLiveRealizedPnlUsdc: round(totalMatchedLiveRealizedPnlUsdc),
    totalLiveVsPaperDeltaUsdc: round(totalLiveVsPaperDeltaUsdc),
    overallPnlRealizationPct: toPct(
      totalMatchedLiveRealizedPnlUsdc,
      totalPaperExpectedRealizedPnlUsdc
    ),
    byConfidence: [...byConfidence.entries()]
      .map(([label, aggregate]) => ({
        label,
        paperTradeCount: aggregate.paperTradeCount,
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        captureRatePct: toPct(aggregate.matchedLiveTradeCount, aggregate.paperTradeCount),
        paperExpectedRealizedPnlUsdc: round(aggregate.paperExpectedRealizedPnlUsdc),
        matchedLiveRealizedPnlUsdc: round(aggregate.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(aggregate.liveVsPaperDeltaUsdc),
        pnlRealizationPct: toPct(
          aggregate.matchedLiveRealizedPnlUsdc,
          aggregate.paperExpectedRealizedPnlUsdc
        )
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byObservedLatency: [...byObservedLatency.entries()]
      .map(([label, aggregate]) => ({
        label,
        paperTradeCount: aggregate.paperTradeCount,
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        captureRatePct: toPct(aggregate.matchedLiveTradeCount, aggregate.paperTradeCount),
        paperExpectedRealizedPnlUsdc: round(aggregate.paperExpectedRealizedPnlUsdc),
        matchedLiveRealizedPnlUsdc: round(aggregate.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(aggregate.liveVsPaperDeltaUsdc),
        pnlRealizationPct: toPct(
          aggregate.matchedLiveRealizedPnlUsdc,
          aggregate.paperExpectedRealizedPnlUsdc
        ),
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
    byStrategy: [...byStrategy.entries()]
      .map(([strategy, aggregate]) => ({
        strategy,
        sessionCount: aggregate.sessionCount,
        paperTradeCount: aggregate.paperTradeCount,
        matchedLiveTradeCount: aggregate.matchedLiveTradeCount,
        captureRatePct: toPct(aggregate.matchedLiveTradeCount, aggregate.paperTradeCount),
        paperExpectedRealizedPnlUsdc: round(aggregate.paperExpectedRealizedPnlUsdc),
        matchedLiveRealizedPnlUsdc: round(aggregate.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(aggregate.liveVsPaperDeltaUsdc),
        pnlRealizationPct: toPct(
          aggregate.matchedLiveRealizedPnlUsdc,
          aggregate.paperExpectedRealizedPnlUsdc
        )
      }))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    bestSessionByPaperDelta,
    worstSessionByPaperDelta,
    sessions
  };
};
