import type { InventoryLotSnapshot } from "../core/inventory-lot-tracker.js";
import { buildOperatingKpiSummary, type OperatingKpiSummary } from "../core/operating-kpis.js";
import type { RiskBudgetAdjustmentSnapshot } from "../core/capital-allocator.js";
import type { RiskState, StrategyName } from "../core/types.js";
import type { PaperTradingSessionReport } from "../paper-trading/report.js";
import type { RestartDrillReport } from "./restart-drill-report.js";
import { comparePaperAndRealizedSessions } from "./paper-live-comparison.js";
import type { RealizedTradingSessionReport } from "./realized-report.js";

type MonitoringCheckpointSnapshot = {
  summaryType: "monitoring_snapshot";
  runtime: string;
  risk: {
    state: RiskState;
  };
  riskBudgetAdjustment?: RiskBudgetAdjustmentSnapshot;
  kpis?: OperatingKpiSummary;
  portfolio: {
    dayKey?: string;
    dailyRealizedPnlUsdc: number;
    dailyGrossRealizedPnlUsdc?: number;
    dailyNetPnlUsdc?: number;
    lifetimeNetPnlUsdc?: number;
    dailyRewardUsdc?: number;
    dailyRebateUsdc?: number;
    openInventoryCostUsdc?: number;
    openInventoryMarkValueUsdc?: number;
    openInventoryUnrealizedPnlUsdc?: number;
    dailyTradeCount?: number;
  };
  activeOrders: {
    total: number;
    activeConditions: number;
  };
};

export type RuntimeCheckpointReport = {
  checkpointType: "runtime_checkpoint";
  schemaVersion: 1;
  runtime: string;
  reason: "startup" | "checkpoint" | "stop" | "manual";
  generatedAtMs: number;
  monitoringSnapshot: MonitoringCheckpointSnapshot;
  inventory: {
    openLotCount: number;
    openShares: number;
    openCostUsdc: number;
    openLots?: InventoryLotSnapshot[];
  };
};

export type SmallLiveReportStatus = "ok" | "review" | "halted";

export type SmallLiveReportFlagCode =
  | "risk_not_running"
  | "session_loss"
  | "paper_report_missing"
  | "paper_checkpoint_not_ready"
  | "runtime_checkpoint_missing"
  | "restart_drill_warning"
  | "restart_drill_failed"
  | "unmatched_paper_trades"
  | "unmatched_live_trades"
  | "open_inventory_remaining"
  | "active_orders_remaining"
  | "realized_below_paper"
  | "checkpoint_risk_differs";

export type SmallLiveReportFlag = {
  code: SmallLiveReportFlagCode;
  severity: "warning" | "critical";
  detail: string;
};

export type SmallLiveStrategySummary = {
  strategy: StrategyName;
  liveTradeCount: number;
  liveWinningTrades: number;
  liveLosingTrades: number;
  liveFlatTrades: number;
  liveExpectedEdgeUsdc: number;
  liveRealizedPnlUsdc: number;
  liveVsExpectedDeltaUsdc: number;
  paperExpectedTradeCount?: number;
  paperFilledTradeCount?: number;
  paperMissedTradeCount?: number;
  paperFillRate?: number;
  paperExpectedRealizedPnlUsdc?: number;
  paperRealizedPnlUsdc?: number;
  matchedLiveTradeCount?: number;
  paperVsLiveDeltaUsdc?: number;
};

export type SmallLiveReport = {
  reportType: "small_live_summary";
  schemaVersion: 1;
  sessionName: string;
  generatedAtMs: number;
  overallStatus: SmallLiveReportStatus;
  finalRiskState: RiskState;
  kpis: OperatingKpiSummary;
  realizedSession: {
    sessionName: string;
    startedAtMs?: number;
    endedAtMs?: number;
    tradeCount: number;
    winningTrades: number;
    losingTrades: number;
    flatTrades: number;
    totalExpectedEdgeUsdc: number;
    totalRealizedPnlUsdc: number;
    realizedVsExpectedDeltaUsdc: number;
    /** Individual trade records — included when the report is built with trade details. */
    trades?: Array<{ strategy: string; realizedPnlUsdc: number; detail?: string; tags: string[] }>;
  };
  paperSession?: {
    sessionName: string;
    source: PaperTradingSessionReport["source"];
    expectedTradeCount: number;
    filledTradeCount: number;
    missedTradeCount: number;
    fillRate: number;
    totalExpectedRealizedPnlUsdc: number;
    totalRealizedPnlUsdc: number;
    expectedVsRealizedDeltaUsdc: number;
    averageObservedVenueLatencyMs?: number;
    averageObservedBookSkewMs?: number;
    highConfidenceTradeCount: number;
    mediumConfidenceTradeCount: number;
    lowConfidenceTradeCount: number;
    checkpointRecoveryReady?: boolean;
    checkpointAgeMs?: number;
  };
  comparison?: {
    matchedKeyCount: number;
    unmatchedPaperTradeCount: number;
    unmatchedLiveTradeCount: number;
    totalPaperVsLiveDeltaUsdc: number;
    byConfidence: ReturnType<typeof comparePaperAndRealizedSessions>["byConfidence"];
    byObservedLatency: ReturnType<typeof comparePaperAndRealizedSessions>["byObservedLatency"];
  };
  checkpoint?: {
    runtime: string;
    generatedAtMs: number;
    reason: RuntimeCheckpointReport["reason"];
    riskState: RiskState;
    riskBudgetAdjustment?: RiskBudgetAdjustmentSnapshot;
    kpis?: OperatingKpiSummary;
    dailyRealizedPnlUsdc: number;
    dailyNetPnlUsdc?: number;
    lifetimeNetPnlUsdc?: number;
    activeOrderCount: number;
    activeConditionCount: number;
    openLotCount: number;
    openShares: number;
    openCostUsdc: number;
    openInventoryMarkValueUsdc?: number;
    openInventoryUnrealizedPnlUsdc?: number;
  };
  restartDrill?: {
    outcome: RestartDrillReport["outcome"];
    generatedAtMs: number;
    matchedLotCount: number;
    missingLotCount: number;
    unexpectedLotCount: number;
    sharesDelta: number;
    costDeltaUsdc: number;
  };
  byStrategy: SmallLiveStrategySummary[];
  flags: SmallLiveReportFlag[];
};

const round = (value: number): number => Number(value.toFixed(8));

const buildFlag = (
  code: SmallLiveReportFlagCode,
  severity: SmallLiveReportFlag["severity"],
  detail: string
): SmallLiveReportFlag => ({
  code,
  severity,
  detail
});

export const buildSmallLiveReport = (input: {
  sessionName?: string;
  generatedAtMs?: number;
  realized: RealizedTradingSessionReport;
  paper?: PaperTradingSessionReport;
  checkpoint?: RuntimeCheckpointReport;
  restartDrill?: RestartDrillReport;
}): SmallLiveReport => {
  const comparison =
    input.paper === undefined
      ? undefined
      : comparePaperAndRealizedSessions({
          paper: input.paper,
          realized: input.realized
        });

  const flags: SmallLiveReportFlag[] = [];

  if (input.realized.finalRiskState === "HALTED") {
    flags.push(
      buildFlag("risk_not_running", "critical", "The realized session finished in HALTED state.")
    );
  } else if (input.realized.finalRiskState === "DEGRADED") {
    flags.push(
      buildFlag(
        "risk_not_running",
        "warning",
        "The realized session finished in DEGRADED state and needs review."
      )
    );
  }

  if (input.realized.totalRealizedPnlUsdc < 0) {
    flags.push(
      buildFlag(
        "session_loss",
        "warning",
        `The realized session closed at ${round(input.realized.totalRealizedPnlUsdc)} USDC net PnL.`
      )
    );
  }

  if (!input.paper) {
    flags.push(
      buildFlag(
        "paper_report_missing",
        "warning",
        "No paper session report was provided, so expected-vs-live calibration is unavailable."
      )
    );
  }

  if (input.paper?.checkpointValidation && !input.paper.checkpointValidation.recoveryReady) {
    flags.push(
      buildFlag(
        "paper_checkpoint_not_ready",
        "warning",
        `Paper checkpoint validation was not recovery-ready. ageMs=${round(
          input.paper.checkpointValidation.checkpointAgeMs
        )}, riskMatch=${input.paper.checkpointValidation.riskStateMatchesSession}.`
      )
    );
  }

  if (!input.checkpoint) {
    flags.push(
      buildFlag(
        "runtime_checkpoint_missing",
        "warning",
        "No runtime checkpoint was provided, so residual active orders and carry-over inventory cannot be reviewed."
      )
    );
  }

  if (input.restartDrill?.outcome === "failed") {
    flags.push(
      buildFlag(
        "restart_drill_failed",
        "critical",
        `Restart drill failed with ${input.restartDrill.totals.missingLotCount} missing and ${input.restartDrill.totals.unexpectedLotCount} unexpected lots.`
      )
    );
  } else if (input.restartDrill?.outcome === "warning") {
    flags.push(
      buildFlag(
        "restart_drill_warning",
        "warning",
        `Restart drill reported lot deltas. sharesDelta=${round(input.restartDrill.totals.sharesDelta)}, costDeltaUsdc=${round(input.restartDrill.totals.costDeltaUsdc)}.`
      )
    );
  }

  if (comparison && comparison.unmatchedPaperTradeCount > 0) {
    flags.push(
      buildFlag(
        "unmatched_paper_trades",
        "warning",
        `${comparison.unmatchedPaperTradeCount} paper trades did not find a realized live match.`
      )
    );
  }

  if (comparison && comparison.unmatchedLiveTradeCount > 0) {
    flags.push(
      buildFlag(
        "unmatched_live_trades",
        "warning",
        `${comparison.unmatchedLiveTradeCount} live trades did not find a paper-session counterpart.`
      )
    );
  }

  const totalPaperVsLiveDeltaUsdc =
    comparison?.byStrategy.reduce((total, strategy) => total + strategy.liveVsPaperDeltaUsdc, 0) ??
    0;
  if (comparison && totalPaperVsLiveDeltaUsdc < 0) {
    flags.push(
      buildFlag(
        "realized_below_paper",
        "warning",
        `Live realized PnL landed ${round(totalPaperVsLiveDeltaUsdc)} USDC below paper expectations.`
      )
    );
  }

  if (input.checkpoint && input.checkpoint.inventory.openLotCount > 0) {
    flags.push(
      buildFlag(
        "open_inventory_remaining",
        "warning",
        `Checkpoint still shows ${input.checkpoint.inventory.openLotCount} open lots and ${round(input.checkpoint.inventory.openShares)} shares.`
      )
    );
  }

  if (input.checkpoint && input.checkpoint.monitoringSnapshot.activeOrders.total > 0) {
    flags.push(
      buildFlag(
        "active_orders_remaining",
        "warning",
        `Checkpoint still shows ${input.checkpoint.monitoringSnapshot.activeOrders.total} active orders.`
      )
    );
  }

  if (
    input.checkpoint &&
    input.checkpoint.monitoringSnapshot.risk.state !== input.realized.finalRiskState
  ) {
    flags.push(
      buildFlag(
        "checkpoint_risk_differs",
        "warning",
        `Checkpoint risk state ${input.checkpoint.monitoringSnapshot.risk.state} differs from realized-session final state ${input.realized.finalRiskState}.`
      )
    );
  }

  const strategyNames = new Set<StrategyName>([
    ...input.realized.byStrategy.map((summary) => summary.strategy),
    ...input.realized.trades.map((trade) => trade.strategy),
    ...(input.paper?.byStrategy.map((summary) => summary.strategy) ?? []),
    ...(input.paper?.trades.map((trade) => trade.strategy) ?? []),
    ...(comparison?.byStrategy.map((summary) => summary.strategy) ?? [])
  ]);
  const byStrategy = [...strategyNames]
    .sort((left, right) => left.localeCompare(right))
    .map((strategy) => {
      const realizedSummary = input.realized.byStrategy.find((summary) => summary.strategy === strategy);
      const paperSummary = input.paper?.byStrategy.find((summary) => summary.strategy === strategy);
      const comparisonSummary = comparison?.byStrategy.find((summary) => summary.strategy === strategy);

      return {
        strategy,
        liveTradeCount: realizedSummary?.tradeCount ?? 0,
        liveWinningTrades: realizedSummary?.winningTrades ?? 0,
        liveLosingTrades: realizedSummary?.losingTrades ?? 0,
        liveFlatTrades: realizedSummary?.flatTrades ?? 0,
        liveExpectedEdgeUsdc: round(realizedSummary?.totalExpectedEdgeUsdc ?? 0),
        liveRealizedPnlUsdc: round(realizedSummary?.totalRealizedPnlUsdc ?? 0),
        liveVsExpectedDeltaUsdc: round(realizedSummary?.realizedVsExpectedDeltaUsdc ?? 0),
        paperExpectedTradeCount: input.paper ? paperSummary?.expectedTradeCount ?? 0 : undefined,
        paperFilledTradeCount: input.paper ? paperSummary?.filledTradeCount ?? 0 : undefined,
        paperMissedTradeCount: input.paper ? paperSummary?.missedTradeCount ?? 0 : undefined,
        paperFillRate: input.paper ? round(paperSummary?.fillRate ?? 0) : undefined,
        paperExpectedRealizedPnlUsdc: input.paper
          ? round(paperSummary?.totalExpectedRealizedPnlUsdc ?? 0)
          : undefined,
        paperRealizedPnlUsdc: input.paper
          ? round(paperSummary?.totalRealizedPnlUsdc ?? 0)
          : undefined,
        matchedLiveTradeCount: comparison ? comparisonSummary?.matchedLiveTradeCount ?? 0 : undefined,
        paperVsLiveDeltaUsdc: comparison
          ? round(comparisonSummary?.liveVsPaperDeltaUsdc ?? 0)
          : undefined
      };
    });
  const checkpointPortfolio = input.checkpoint?.monitoringSnapshot.portfolio;
  const checkpointOpenLots = input.checkpoint?.inventory.openLots ?? [];
  const kpis = buildOperatingKpiSummary({
    dayKey: checkpointPortfolio?.dayKey ?? input.realized.trades[0]?.dayKey,
    dailyTradeCount: input.realized.tradeCount,
    dailyRealizedPnlUsdc: input.realized.totalRealizedPnlUsdc,
    dailyGrossRealizedPnlUsdc:
      checkpointPortfolio?.dailyGrossRealizedPnlUsdc ??
      input.realized.trades.reduce((total, trade) => total + trade.grossRealizedPnlUsdc, 0),
    dailyRewardUsdc:
      checkpointPortfolio?.dailyRewardUsdc ??
      input.realized.trades.reduce((total, trade) => total + trade.rewardUsdc, 0),
    dailyRebateUsdc:
      checkpointPortfolio?.dailyRebateUsdc ??
      input.realized.trades.reduce((total, trade) => total + trade.rebateUsdc, 0),
    trades: input.realized.trades,
    openLots: checkpointOpenLots
  });

  let overallStatus: SmallLiveReportStatus = "ok";
  if (
    input.realized.finalRiskState === "HALTED" ||
    flags.some((flag) => flag.severity === "critical")
  ) {
    overallStatus = "halted";
  } else if (flags.length > 0) {
    overallStatus = "review";
  }

  return {
    reportType: "small_live_summary",
    schemaVersion: 1,
    sessionName: input.sessionName ?? `${input.realized.sessionName}:small-live`,
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    overallStatus,
    finalRiskState: input.realized.finalRiskState,
    kpis,
    realizedSession: {
      sessionName: input.realized.sessionName,
      startedAtMs: input.realized.startedAtMs,
      endedAtMs: input.realized.endedAtMs,
      tradeCount: input.realized.tradeCount,
      winningTrades: input.realized.winningTrades,
      losingTrades: input.realized.losingTrades,
      flatTrades: input.realized.flatTrades,
      totalExpectedEdgeUsdc: round(input.realized.totalExpectedEdgeUsdc),
      totalRealizedPnlUsdc: round(input.realized.totalRealizedPnlUsdc),
      realizedVsExpectedDeltaUsdc: round(input.realized.realizedVsExpectedDeltaUsdc),
      trades: input.realized.trades.map((t) => ({
        strategy: t.strategy,
        realizedPnlUsdc: round(t.realizedPnlUsdc),
        detail: t.detail,
        tags: [...t.tags]
      }))
    },
    paperSession: input.paper
      ? {
          sessionName: input.paper.sessionName,
          source: input.paper.source,
          expectedTradeCount: input.paper.expectedTradeCount,
          filledTradeCount: input.paper.filledTradeCount,
          missedTradeCount: input.paper.missedTradeCount,
          fillRate: round(input.paper.fillRate),
          totalExpectedRealizedPnlUsdc: round(input.paper.totalExpectedRealizedPnlUsdc),
          totalRealizedPnlUsdc: round(input.paper.totalRealizedPnlUsdc),
          expectedVsRealizedDeltaUsdc: round(input.paper.expectedVsRealizedDeltaUsdc),
          averageObservedVenueLatencyMs:
            input.paper.averageObservedVenueLatencyMs === undefined
              ? undefined
              : round(input.paper.averageObservedVenueLatencyMs),
          averageObservedBookSkewMs:
            input.paper.averageObservedBookSkewMs === undefined
              ? undefined
              : round(input.paper.averageObservedBookSkewMs),
          highConfidenceTradeCount: input.paper.highConfidenceTradeCount,
          mediumConfidenceTradeCount: input.paper.mediumConfidenceTradeCount,
          lowConfidenceTradeCount: input.paper.lowConfidenceTradeCount,
          checkpointRecoveryReady: input.paper.checkpointValidation?.recoveryReady,
          checkpointAgeMs:
            input.paper.checkpointValidation?.checkpointAgeMs === undefined
              ? undefined
              : round(input.paper.checkpointValidation.checkpointAgeMs)
        }
      : undefined,
    comparison: comparison
      ? {
          matchedKeyCount: comparison.matchedKeyCount,
          unmatchedPaperTradeCount: comparison.unmatchedPaperTradeCount,
          unmatchedLiveTradeCount: comparison.unmatchedLiveTradeCount,
          totalPaperVsLiveDeltaUsdc: round(totalPaperVsLiveDeltaUsdc),
          byConfidence: comparison.byConfidence,
          byObservedLatency: comparison.byObservedLatency
        }
      : undefined,
    checkpoint: input.checkpoint
      ? {
          runtime: input.checkpoint.runtime,
          generatedAtMs: input.checkpoint.generatedAtMs,
          reason: input.checkpoint.reason,
          riskState: input.checkpoint.monitoringSnapshot.risk.state,
          riskBudgetAdjustment: input.checkpoint.monitoringSnapshot.riskBudgetAdjustment,
          kpis:
            input.checkpoint.monitoringSnapshot.kpis ??
            buildOperatingKpiSummary({
              dayKey: input.checkpoint.monitoringSnapshot.portfolio.dayKey,
              dailyTradeCount:
                input.checkpoint.monitoringSnapshot.portfolio.dailyTradeCount ??
                input.realized.tradeCount,
              dailyRealizedPnlUsdc: input.checkpoint.monitoringSnapshot.portfolio.dailyRealizedPnlUsdc,
              dailyGrossRealizedPnlUsdc:
                input.checkpoint.monitoringSnapshot.portfolio.dailyGrossRealizedPnlUsdc ??
                input.realized.trades.reduce((total, trade) => total + trade.grossRealizedPnlUsdc, 0),
              dailyRewardUsdc:
                input.checkpoint.monitoringSnapshot.portfolio.dailyRewardUsdc ??
                input.realized.trades.reduce((total, trade) => total + trade.rewardUsdc, 0),
              dailyRebateUsdc:
                input.checkpoint.monitoringSnapshot.portfolio.dailyRebateUsdc ??
                input.realized.trades.reduce((total, trade) => total + trade.rebateUsdc, 0),
              trades: input.realized.trades,
              openLots: checkpointOpenLots
            }),
          dailyRealizedPnlUsdc: round(
            input.checkpoint.monitoringSnapshot.portfolio.dailyRealizedPnlUsdc
          ),
          dailyNetPnlUsdc:
            typeof input.checkpoint.monitoringSnapshot.portfolio.dailyNetPnlUsdc === "number"
              ? round(input.checkpoint.monitoringSnapshot.portfolio.dailyNetPnlUsdc)
              : undefined,
          lifetimeNetPnlUsdc:
            typeof input.checkpoint.monitoringSnapshot.portfolio.lifetimeNetPnlUsdc === "number"
              ? round(input.checkpoint.monitoringSnapshot.portfolio.lifetimeNetPnlUsdc)
              : undefined,
          activeOrderCount: input.checkpoint.monitoringSnapshot.activeOrders.total,
          activeConditionCount: input.checkpoint.monitoringSnapshot.activeOrders.activeConditions,
          openLotCount: input.checkpoint.inventory.openLotCount,
          openShares: round(input.checkpoint.inventory.openShares),
          openCostUsdc: round(input.checkpoint.inventory.openCostUsdc),
          openInventoryMarkValueUsdc:
            typeof input.checkpoint.monitoringSnapshot.portfolio.openInventoryMarkValueUsdc === "number"
              ? round(input.checkpoint.monitoringSnapshot.portfolio.openInventoryMarkValueUsdc)
              : undefined,
          openInventoryUnrealizedPnlUsdc:
            typeof input.checkpoint.monitoringSnapshot.portfolio.openInventoryUnrealizedPnlUsdc === "number"
              ? round(input.checkpoint.monitoringSnapshot.portfolio.openInventoryUnrealizedPnlUsdc)
              : undefined
        }
      : undefined,
    restartDrill: input.restartDrill
      ? {
          outcome: input.restartDrill.outcome,
          generatedAtMs: input.restartDrill.generatedAtMs,
          matchedLotCount: input.restartDrill.totals.matchedLotCount,
          missingLotCount: input.restartDrill.totals.missingLotCount,
          unexpectedLotCount: input.restartDrill.totals.unexpectedLotCount,
          sharesDelta: round(input.restartDrill.totals.sharesDelta),
          costDeltaUsdc: round(input.restartDrill.totals.costDeltaUsdc)
        }
      : undefined,
    byStrategy,
    flags
  };
};
