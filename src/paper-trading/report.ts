import type { RiskState, StrategyName } from "../core/types.js";
import type { SimulationPaperTradeRecord, SimulationReport } from "../simulation/harness.js";
import type { PaperFillConfidence } from "./fill-confidence.js";

export type PaperTradingTradeRecord = {
  id: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  status: "filled" | "partial_filled" | "not_filled";
  expectedRealizedPnlUsdc: number;
  expectedGrossEdgeUsdc: number;
  realizedPnlUsdc?: number;
  grossRealizedPnlUsdc?: number;
  feeCostUsdc: number;
  simulatedFillLatencyMs?: number;
  simulatedFillRatio?: number;
  filledShares?: number;
  missedExpectedRealizedPnlUsdc?: number;
  observedVenueLatencyMs?: number;
  observedBookSkewMs?: number;
  depthCoverageRatio?: number;
  fillConfidence?: PaperFillConfidence;
  shares?: number;
  reason?: string;
  tags: string[];
};

export type PaperTradingCheckpointValidation = {
  runtime: string;
  checkpointReason: "startup" | "checkpoint" | "stop" | "manual";
  lastCheckpointGeneratedAtMs: number;
  checkpointAgeMs: number;
  withinFreshnessWindow: boolean;
  checkpointRiskState: RiskState;
  sessionRiskState: RiskState;
  riskStateMatchesSession: boolean;
  recoveryReady: boolean;
  activeOrderCount: number;
  activeConditionCount: number;
  openLotCount: number;
  openShares: number;
  openCostUsdc: number;
};

export type PaperTradingStrategyReport = {
  strategy: StrategyName;
  expectedTradeCount: number;
  filledTradeCount: number;
  partialFilledTradeCount?: number;
  missedTradeCount: number;
  fillRate: number;
  totalExpectedRealizedPnlUsdc: number;
  totalRealizedPnlUsdc: number;
  expectedVsRealizedDeltaUsdc: number;
  averageRealizedFillLatencyMs?: number;
  averageObservedVenueLatencyMs?: number;
  averageObservedBookSkewMs?: number;
  highConfidenceTradeCount: number;
  mediumConfidenceTradeCount: number;
  lowConfidenceTradeCount: number;
};

export type PaperTradingSessionReport = {
  sessionName: string;
  source: "simulation" | "dry-run-runtime";
  startedAtMs?: number;
  endedAtMs?: number;
  expectedTradeCount: number;
  filledTradeCount: number;
  partialFilledTradeCount?: number;
  missedTradeCount: number;
  fillRate: number;
  totalExpectedRealizedPnlUsdc: number;
  totalRealizedPnlUsdc: number;
  expectedVsRealizedDeltaUsdc: number;
  averageRealizedFillLatencyMs?: number;
  averageObservedVenueLatencyMs?: number;
  averageObservedBookSkewMs?: number;
  highConfidenceTradeCount: number;
  mediumConfidenceTradeCount: number;
  lowConfidenceTradeCount: number;
  finalRiskState: RiskState;
  checkpointValidation?: PaperTradingCheckpointValidation;
  byStrategy: PaperTradingStrategyReport[];
  trades: PaperTradingTradeRecord[];
};

type Aggregate = {
  expectedTradeCount: number;
  filledTradeCount: number;
  partialFilledTradeCount: number;
  missedTradeCount: number;
  totalExpectedRealizedPnlUsdc: number;
  totalRealizedPnlUsdc: number;
  latencyTotalMs: number;
  latencyCount: number;
  observedVenueLatencyTotalMs: number;
  observedVenueLatencyCount: number;
  observedBookSkewTotalMs: number;
  observedBookSkewCount: number;
  highConfidenceTradeCount: number;
  mediumConfidenceTradeCount: number;
  lowConfidenceTradeCount: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const createEmptyAggregate = (): Aggregate => ({
  expectedTradeCount: 0,
  filledTradeCount: 0,
  partialFilledTradeCount: 0,
  missedTradeCount: 0,
  totalExpectedRealizedPnlUsdc: 0,
  totalRealizedPnlUsdc: 0,
  latencyTotalMs: 0,
  latencyCount: 0,
  observedVenueLatencyTotalMs: 0,
  observedVenueLatencyCount: 0,
  observedBookSkewTotalMs: 0,
  observedBookSkewCount: 0,
  highConfidenceTradeCount: 0,
  mediumConfidenceTradeCount: 0,
  lowConfidenceTradeCount: 0
});

const toStrategyReport = (
  strategy: StrategyName,
  aggregate: Aggregate
): PaperTradingStrategyReport => ({
  strategy,
  expectedTradeCount: aggregate.expectedTradeCount,
  filledTradeCount: aggregate.filledTradeCount,
  partialFilledTradeCount: aggregate.partialFilledTradeCount,
  missedTradeCount: aggregate.missedTradeCount,
  fillRate:
    aggregate.expectedTradeCount > 0 ? aggregate.filledTradeCount / aggregate.expectedTradeCount : 0,
  totalExpectedRealizedPnlUsdc: round(aggregate.totalExpectedRealizedPnlUsdc),
  totalRealizedPnlUsdc: round(aggregate.totalRealizedPnlUsdc),
  expectedVsRealizedDeltaUsdc: round(
    aggregate.totalRealizedPnlUsdc - aggregate.totalExpectedRealizedPnlUsdc
  ),
  averageRealizedFillLatencyMs:
    aggregate.latencyCount > 0 ? round(aggregate.latencyTotalMs / aggregate.latencyCount) : undefined,
  averageObservedVenueLatencyMs:
    aggregate.observedVenueLatencyCount > 0
      ? round(aggregate.observedVenueLatencyTotalMs / aggregate.observedVenueLatencyCount)
      : undefined,
  averageObservedBookSkewMs:
    aggregate.observedBookSkewCount > 0
      ? round(aggregate.observedBookSkewTotalMs / aggregate.observedBookSkewCount)
      : undefined,
  highConfidenceTradeCount: aggregate.highConfidenceTradeCount,
  mediumConfidenceTradeCount: aggregate.mediumConfidenceTradeCount,
  lowConfidenceTradeCount: aggregate.lowConfidenceTradeCount
});

export const buildPaperTradingSessionReport = (input: {
  sessionName: string;
  source: PaperTradingSessionReport["source"];
  startedAtMs?: number;
  endedAtMs?: number;
  finalRiskState: RiskState;
  checkpointValidation?: PaperTradingCheckpointValidation;
  trades: readonly PaperTradingTradeRecord[];
}): PaperTradingSessionReport => {
  const trades = [...input.trades];
  const aggregate = createEmptyAggregate();
  const byStrategy = new Map<StrategyName, Aggregate>();

  for (const trade of trades) {
    aggregate.expectedTradeCount += 1;
    aggregate.totalExpectedRealizedPnlUsdc += trade.expectedRealizedPnlUsdc;

    const strategyAggregate = byStrategy.get(trade.strategy) ?? createEmptyAggregate();
    strategyAggregate.expectedTradeCount += 1;
    strategyAggregate.totalExpectedRealizedPnlUsdc += trade.expectedRealizedPnlUsdc;

    if (trade.fillConfidence === "high") {
      aggregate.highConfidenceTradeCount += 1;
      strategyAggregate.highConfidenceTradeCount += 1;
    } else if (trade.fillConfidence === "medium") {
      aggregate.mediumConfidenceTradeCount += 1;
      strategyAggregate.mediumConfidenceTradeCount += 1;
    } else if (trade.fillConfidence === "low") {
      aggregate.lowConfidenceTradeCount += 1;
      strategyAggregate.lowConfidenceTradeCount += 1;
    }

    if (trade.status === "filled" || trade.status === "partial_filled") {
      aggregate.filledTradeCount += 1;
      aggregate.totalRealizedPnlUsdc += trade.realizedPnlUsdc ?? 0;
      strategyAggregate.filledTradeCount += 1;
      strategyAggregate.totalRealizedPnlUsdc += trade.realizedPnlUsdc ?? 0;

      if (trade.status === "partial_filled") {
        aggregate.partialFilledTradeCount += 1;
        strategyAggregate.partialFilledTradeCount += 1;
      }

      if (typeof trade.simulatedFillLatencyMs === "number") {
        aggregate.latencyTotalMs += trade.simulatedFillLatencyMs;
        aggregate.latencyCount += 1;
        strategyAggregate.latencyTotalMs += trade.simulatedFillLatencyMs;
        strategyAggregate.latencyCount += 1;
      }
    } else {
      aggregate.missedTradeCount += 1;
      strategyAggregate.missedTradeCount += 1;
    }

    if (typeof trade.observedVenueLatencyMs === "number") {
      aggregate.observedVenueLatencyTotalMs += trade.observedVenueLatencyMs;
      aggregate.observedVenueLatencyCount += 1;
      strategyAggregate.observedVenueLatencyTotalMs += trade.observedVenueLatencyMs;
      strategyAggregate.observedVenueLatencyCount += 1;
    }

    if (typeof trade.observedBookSkewMs === "number") {
      aggregate.observedBookSkewTotalMs += trade.observedBookSkewMs;
      aggregate.observedBookSkewCount += 1;
      strategyAggregate.observedBookSkewTotalMs += trade.observedBookSkewMs;
      strategyAggregate.observedBookSkewCount += 1;
    }

    byStrategy.set(trade.strategy, strategyAggregate);
  }

  return {
    sessionName: input.sessionName,
    source: input.source,
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    expectedTradeCount: aggregate.expectedTradeCount,
    filledTradeCount: aggregate.filledTradeCount,
    partialFilledTradeCount: aggregate.partialFilledTradeCount,
    missedTradeCount: aggregate.missedTradeCount,
    fillRate:
      aggregate.expectedTradeCount > 0 ? aggregate.filledTradeCount / aggregate.expectedTradeCount : 0,
    totalExpectedRealizedPnlUsdc: round(aggregate.totalExpectedRealizedPnlUsdc),
    totalRealizedPnlUsdc: round(aggregate.totalRealizedPnlUsdc),
    expectedVsRealizedDeltaUsdc: round(
      aggregate.totalRealizedPnlUsdc - aggregate.totalExpectedRealizedPnlUsdc
    ),
    averageRealizedFillLatencyMs:
      aggregate.latencyCount > 0 ? round(aggregate.latencyTotalMs / aggregate.latencyCount) : undefined,
    averageObservedVenueLatencyMs:
      aggregate.observedVenueLatencyCount > 0
        ? round(aggregate.observedVenueLatencyTotalMs / aggregate.observedVenueLatencyCount)
        : undefined,
    averageObservedBookSkewMs:
      aggregate.observedBookSkewCount > 0
        ? round(aggregate.observedBookSkewTotalMs / aggregate.observedBookSkewCount)
        : undefined,
    highConfidenceTradeCount: aggregate.highConfidenceTradeCount,
    mediumConfidenceTradeCount: aggregate.mediumConfidenceTradeCount,
    lowConfidenceTradeCount: aggregate.lowConfidenceTradeCount,
    finalRiskState: input.finalRiskState,
    checkpointValidation: input.checkpointValidation,
    byStrategy: [...byStrategy.entries()]
      .map(([strategy, strategyAggregate]) => toStrategyReport(strategy, strategyAggregate))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    trades: trades.map((trade) => ({
      ...trade,
      tags: [...trade.tags]
      }))
  };
};

// ---- CSV export -------------------------------------------------------------

const csvCell = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const str = String(value);
  return str.includes(",") || str.includes('"') || str.includes("\n")
    ? `"${str.replace(/"/g, '""')}"`
    : str;
};

const CSV_TRADE_HEADERS = [
  "id",
  "strategy",
  "marketScope",
  "conditionId",
  "status",
  "shares",
  "expectedRealizedPnlUsdc",
  "realizedPnlUsdc",
  "missedExpectedRealizedPnlUsdc",
  "simulatedFillRatio",
  "simulatedFillLatencyMs",
  "feeCostUsdc",
  "fillConfidence",
  "depthCoverageRatio",
  "reason",
  "tags"
] as const;

/**
 * Converts a paper trading session report to a two-section CSV string:
 * 1. A header row with session-level KPIs.
 * 2. One row per trade.
 *
 * Suitable for pasting into a spreadsheet or `npm run paper-csv` output.
 */
export const toPaperTradingCsv = (report: PaperTradingSessionReport): string => {
  const lines: string[] = [];

  // Section 1: session summary
  lines.push("# Session Summary");
  lines.push(["metric", "value"].map(csvCell).join(","));
  const summary: [string, unknown][] = [
    ["sessionName", report.sessionName],
    ["source", report.source],
    ["expectedTradeCount", report.expectedTradeCount],
    ["filledTradeCount", report.filledTradeCount],
    ["partialFilledTradeCount", report.partialFilledTradeCount ?? 0],
    ["missedTradeCount", report.missedTradeCount],
    ["fillRate", report.fillRate],
    ["totalExpectedRealizedPnlUsdc", report.totalExpectedRealizedPnlUsdc],
    ["totalRealizedPnlUsdc", report.totalRealizedPnlUsdc],
    ["expectedVsRealizedDeltaUsdc", report.expectedVsRealizedDeltaUsdc],
    ["averageRealizedFillLatencyMs", report.averageRealizedFillLatencyMs ?? ""],
    ["highConfidenceTradeCount", report.highConfidenceTradeCount],
    ["mediumConfidenceTradeCount", report.mediumConfidenceTradeCount],
    ["lowConfidenceTradeCount", report.lowConfidenceTradeCount],
    ["finalRiskState", report.finalRiskState]
  ];
  for (const [metric, value] of summary) {
    lines.push([metric, value].map(csvCell).join(","));
  }

  lines.push("");

  // Section 2: per-trade rows
  lines.push("# Trades");
  lines.push(CSV_TRADE_HEADERS.map(csvCell).join(","));
  for (const trade of report.trades) {
    lines.push(
      [
        trade.id,
        trade.strategy,
        trade.marketScope,
        trade.conditionId ?? "",
        trade.status,
        trade.shares ?? "",
        trade.expectedRealizedPnlUsdc,
        trade.realizedPnlUsdc ?? "",
        trade.missedExpectedRealizedPnlUsdc ?? "",
        trade.simulatedFillRatio ?? "",
        trade.simulatedFillLatencyMs ?? "",
        trade.feeCostUsdc,
        trade.fillConfidence ?? "",
        trade.depthCoverageRatio ?? "",
        trade.reason ?? "",
        trade.tags.join("|")
      ]
        .map(csvCell)
        .join(",")
    );
  }

  return lines.join("\n");
};

export const buildPaperTradingReportFromSimulation = (
  simulationReport: SimulationReport
): PaperTradingSessionReport =>
  buildPaperTradingSessionReport({
    sessionName: `${simulationReport.scenarioName}:paper`,
    source: "simulation",
    startedAtMs: simulationReport.steps[0]?.atMs,
    endedAtMs: simulationReport.steps.at(-1)?.atMs,
    finalRiskState: simulationReport.finalRiskState,
    trades: simulationReport.steps.flatMap((step) => step.paperTrades as SimulationPaperTradeRecord[])
  });
