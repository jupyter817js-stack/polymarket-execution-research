import { describe, expect, it } from "vitest";

import { buildCalibrationRollupReport } from "../src/session-report/calibration-rollup.js";
import type { SmallLiveReport } from "../src/session-report/small-live-report.js";

const reportReview: SmallLiveReport = {
  reportType: "small_live_summary",
  schemaVersion: 1,
  sessionName: "session-review",
  generatedAtMs: 100,
  overallStatus: "review",
  finalRiskState: "DEGRADED",
  kpis: {
    tradeCount: 2,
    averageTradeExpectedEdgeUsdc: 0.25,
    averageTradeNetPnlUsdc: 0.05,
    rewardIncomeUsdc: 0,
    rebateIncomeUsdc: 0,
    rewardShareOfPositiveCreditsPct: 0,
    rebateShareOfPositiveCreditsPct: 0,
    dailyRoiPct: 0.01,
    residualInventoryCostUsdc: 0.8,
    residualInventoryUtilizationPct: 0.08,
    yesNoImbalancePct: 100
  },
  realizedSession: {
    sessionName: "live-review",
    tradeCount: 2,
    winningTrades: 1,
    losingTrades: 1,
    flatTrades: 0,
    totalExpectedEdgeUsdc: 0.6,
    totalRealizedPnlUsdc: 0.35,
    realizedVsExpectedDeltaUsdc: -0.25
  },
  paperSession: {
    sessionName: "paper-review",
    source: "dry-run-runtime",
    expectedTradeCount: 3,
    filledTradeCount: 2,
    partialFilledTradeCount: 0,
    missedTradeCount: 1,
    fillRate: 2 / 3,
    totalExpectedRealizedPnlUsdc: 0.6,
    totalRealizedPnlUsdc: 0.35,
    expectedVsRealizedDeltaUsdc: -0.25,
    averageObservedVenueLatencyMs: 400,
    averageObservedBookSkewMs: 40,
    highConfidenceTradeCount: 2,
    mediumConfidenceTradeCount: 1,
    lowConfidenceTradeCount: 0,
    finalRiskState: "RUNNING",
    checkpointRecoveryReady: false,
    checkpointAgeMs: 180000,
    byStrategy: [],
    trades: []
  },
  comparison: {
    matchedKeyCount: 2,
    unmatchedPaperTradeCount: 1,
    unmatchedLiveTradeCount: 0,
    totalPaperVsLiveDeltaUsdc: -0.25,
    byConfidence: [
      {
        label: "high",
        paperTradeCount: 2,
        paperExpectedRealizedPnlUsdc: 0.4,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.25,
        liveVsPaperDeltaUsdc: -0.15
      },
      {
        label: "medium",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.2,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.1,
        liveVsPaperDeltaUsdc: -0.1
      }
    ],
    byObservedLatency: [
      {
        label: "fast",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.2,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.1,
        liveVsPaperDeltaUsdc: -0.1,
        averageObservedVenueLatencyMs: 150,
        averageObservedBookSkewMs: 20
      },
      {
        label: "moderate",
        paperTradeCount: 2,
        paperExpectedRealizedPnlUsdc: 0.4,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.25,
        liveVsPaperDeltaUsdc: -0.15,
        averageObservedVenueLatencyMs: 525,
        averageObservedBookSkewMs: 50
      }
    ],
    byStrategy: [
      {
        strategy: "same-market-arb",
        paperTradeCount: 2,
        paperExpectedRealizedPnlUsdc: 0.4,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.25,
        liveVsPaperDeltaUsdc: -0.15
      },
      {
        strategy: "negative-risk",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.2,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.1,
        liveVsPaperDeltaUsdc: -0.1
      }
    ]
  },
  checkpoint: {
    runtime: "integrated",
    generatedAtMs: 120,
    reason: "stop",
    riskState: "DEGRADED",
    riskBudgetAdjustment: {
      state: "DEGRADED",
      stressScore: 0.6,
      dynamicCurveMultiplier: 0.7,
      sharedBuyBudgetMultiplier: 0.42,
      strategyBuyBudgetMultipliers: {
        "market-making": 0.21,
        "same-market-arb": 0.336,
        "negative-risk": 0.294
      }
    },
    kpis: {
      tradeCount: 2,
      averageTradeExpectedEdgeUsdc: 0.25,
      averageTradeNetPnlUsdc: 0.05,
      rewardIncomeUsdc: 0,
      rebateIncomeUsdc: 0,
      rewardShareOfPositiveCreditsPct: 0,
      rebateShareOfPositiveCreditsPct: 0,
      dailyRoiPct: 0.01,
      residualInventoryCostUsdc: 0.8,
      residualInventoryUtilizationPct: 0.08,
      yesNoImbalancePct: 100
    },
    dailyRealizedPnlUsdc: 0.35,
    activeOrderCount: 1,
    activeConditionCount: 1,
    openLotCount: 1,
    openShares: 2,
    openCostUsdc: 0.8
  },
  byStrategy: [
    {
      strategy: "same-market-arb",
      liveTradeCount: 1,
      liveWinningTrades: 1,
      liveLosingTrades: 0,
      liveFlatTrades: 0,
      liveExpectedEdgeUsdc: 0.4,
      liveRealizedPnlUsdc: 0.25,
      liveVsExpectedDeltaUsdc: -0.15,
      paperExpectedTradeCount: 2,
      paperFilledTradeCount: 1,
      paperMissedTradeCount: 1,
      paperFillRate: 0.5,
      paperExpectedRealizedPnlUsdc: 0.4,
      paperRealizedPnlUsdc: 0.25,
      matchedLiveTradeCount: 1,
      paperVsLiveDeltaUsdc: -0.15
    },
    {
      strategy: "negative-risk",
      liveTradeCount: 1,
      liveWinningTrades: 0,
      liveLosingTrades: 1,
      liveFlatTrades: 0,
      liveExpectedEdgeUsdc: 0.2,
      liveRealizedPnlUsdc: 0.1,
      liveVsExpectedDeltaUsdc: -0.1,
      paperExpectedTradeCount: 1,
      paperFilledTradeCount: 1,
      paperMissedTradeCount: 0,
      paperFillRate: 1,
      paperExpectedRealizedPnlUsdc: 0.2,
      paperRealizedPnlUsdc: 0.1,
      matchedLiveTradeCount: 1,
      paperVsLiveDeltaUsdc: -0.1
    }
  ],
  flags: []
};

const reportOk: SmallLiveReport = {
  reportType: "small_live_summary",
  schemaVersion: 1,
  sessionName: "session-ok",
  generatedAtMs: 200,
  overallStatus: "ok",
  finalRiskState: "RUNNING",
  kpis: {
    tradeCount: 1,
    averageTradeExpectedEdgeUsdc: 0.15,
    averageTradeNetPnlUsdc: 0.22,
    rewardIncomeUsdc: 0,
    rebateIncomeUsdc: 0,
    rewardShareOfPositiveCreditsPct: 0,
    rebateShareOfPositiveCreditsPct: 0,
    dailyRoiPct: 0.02,
    residualInventoryCostUsdc: 0,
    residualInventoryUtilizationPct: 0,
    yesNoImbalancePct: undefined
  },
  realizedSession: {
    sessionName: "live-ok",
    tradeCount: 1,
    winningTrades: 1,
    losingTrades: 0,
    flatTrades: 0,
    totalExpectedEdgeUsdc: 0.3,
    totalRealizedPnlUsdc: 0.22,
    realizedVsExpectedDeltaUsdc: -0.08
  },
  paperSession: {
    sessionName: "paper-ok",
    source: "dry-run-runtime",
    expectedTradeCount: 2,
    filledTradeCount: 1,
    partialFilledTradeCount: 0,
    missedTradeCount: 1,
    fillRate: 0.5,
    totalExpectedRealizedPnlUsdc: 0.3,
    totalRealizedPnlUsdc: 0.22,
    expectedVsRealizedDeltaUsdc: -0.08,
    averageObservedVenueLatencyMs: 650,
    averageObservedBookSkewMs: 55,
    highConfidenceTradeCount: 1,
    mediumConfidenceTradeCount: 0,
    lowConfidenceTradeCount: 1,
    finalRiskState: "RUNNING",
    checkpointRecoveryReady: true,
    checkpointAgeMs: 30000,
    byStrategy: [],
    trades: []
  },
  comparison: {
    matchedKeyCount: 1,
    unmatchedPaperTradeCount: 1,
    unmatchedLiveTradeCount: 0,
    totalPaperVsLiveDeltaUsdc: -0.08,
    byConfidence: [
      {
        label: "high",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.2,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.22,
        liveVsPaperDeltaUsdc: 0.02
      },
      {
        label: "low",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.1,
        matchedLiveTradeCount: 0,
        matchedLiveRealizedPnlUsdc: 0,
        liveVsPaperDeltaUsdc: -0.1
      }
    ],
    byObservedLatency: [
      {
        label: "fast",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.2,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.22,
        liveVsPaperDeltaUsdc: 0.02,
        averageObservedVenueLatencyMs: 200,
        averageObservedBookSkewMs: 25
      },
      {
        label: "slow",
        paperTradeCount: 1,
        paperExpectedRealizedPnlUsdc: 0.1,
        matchedLiveTradeCount: 0,
        matchedLiveRealizedPnlUsdc: 0,
        liveVsPaperDeltaUsdc: -0.1,
        averageObservedVenueLatencyMs: 1100,
        averageObservedBookSkewMs: 85
      }
    ],
    byStrategy: [
      {
        strategy: "same-market-arb",
        paperTradeCount: 2,
        paperExpectedRealizedPnlUsdc: 0.3,
        matchedLiveTradeCount: 1,
        matchedLiveRealizedPnlUsdc: 0.22,
        liveVsPaperDeltaUsdc: -0.08
      }
    ]
  },
  checkpoint: {
    runtime: "integrated",
    generatedAtMs: 220,
    reason: "stop",
    riskState: "RUNNING",
    riskBudgetAdjustment: {
      state: "RUNNING",
      stressScore: 0,
      dynamicCurveMultiplier: 1,
      sharedBuyBudgetMultiplier: 1,
      strategyBuyBudgetMultipliers: {
        "market-making": 1,
        "same-market-arb": 1,
        "negative-risk": 1
      }
    },
    kpis: {
      tradeCount: 1,
      averageTradeExpectedEdgeUsdc: 0.15,
      averageTradeNetPnlUsdc: 0.22,
      rewardIncomeUsdc: 0,
      rebateIncomeUsdc: 0,
      rewardShareOfPositiveCreditsPct: 0,
      rebateShareOfPositiveCreditsPct: 0,
      dailyRoiPct: 0.02,
      residualInventoryCostUsdc: 0,
      residualInventoryUtilizationPct: 0,
      yesNoImbalancePct: undefined
    },
    dailyRealizedPnlUsdc: 0.22,
    activeOrderCount: 0,
    activeConditionCount: 0,
    openLotCount: 0,
    openShares: 0,
    openCostUsdc: 0
  },
  byStrategy: [
    {
      strategy: "same-market-arb",
      liveTradeCount: 1,
      liveWinningTrades: 1,
      liveLosingTrades: 0,
      liveFlatTrades: 0,
      liveExpectedEdgeUsdc: 0.3,
      liveRealizedPnlUsdc: 0.22,
      liveVsExpectedDeltaUsdc: -0.08,
      paperExpectedTradeCount: 2,
      paperFilledTradeCount: 1,
      paperMissedTradeCount: 1,
      paperFillRate: 0.5,
      paperExpectedRealizedPnlUsdc: 0.3,
      paperRealizedPnlUsdc: 0.22,
      matchedLiveTradeCount: 1,
      paperVsLiveDeltaUsdc: -0.08
    }
  ],
  flags: []
};

describe("Calibration rollup report", () => {
  it("aggregates long-horizon paper-vs-live calibration across small-live sessions", () => {
    const report = buildCalibrationRollupReport({
      groupName: "week-14-calibration",
      generatedAtMs: 500,
      reports: [reportReview, reportOk]
    });

    expect(report.reportType).toBe("paper_live_calibration_rollup");
    expect(report.groupName).toBe("week-14-calibration");
    expect(report.sessionCount).toBe(2);
    expect(report.sessionsWithPaperCount).toBe(2);
    expect(report.sessionsWithoutPaperCount).toBe(0);
    expect(report.sessionsWithCheckpointReadyPaperCount).toBe(1);
    expect(report.statusCounts).toEqual({
      ok: 1,
      review: 1,
      halted: 0
    });
    expect(report.totalPaperTradeCount).toBe(5);
    expect(report.totalMatchedLiveTradeCount).toBe(3);
    expect(report.totalUnmatchedPaperTradeCount).toBe(2);
    expect(report.totalUnmatchedLiveTradeCount).toBe(0);
    expect(report.overallCaptureRatePct).toBe(60);
    expect(report.totalPaperExpectedRealizedPnlUsdc).toBe(0.9);
    expect(report.totalMatchedLiveRealizedPnlUsdc).toBe(0.57);
    expect(report.totalLiveVsPaperDeltaUsdc).toBe(-0.33);
    expect(report.overallPnlRealizationPct).toBe(63.33333333);

    expect(report.byConfidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "high",
          paperTradeCount: 3,
          matchedLiveTradeCount: 2,
          captureRatePct: 66.66666667,
          paperExpectedRealizedPnlUsdc: 0.6,
          matchedLiveRealizedPnlUsdc: 0.47,
          liveVsPaperDeltaUsdc: -0.13,
          pnlRealizationPct: 78.33333333
        }),
        expect.objectContaining({
          label: "low",
          paperTradeCount: 1,
          matchedLiveTradeCount: 0,
          captureRatePct: 0,
          paperExpectedRealizedPnlUsdc: 0.1,
          matchedLiveRealizedPnlUsdc: 0,
          liveVsPaperDeltaUsdc: -0.1,
          pnlRealizationPct: 0
        })
      ])
    );

    expect(
      report.byObservedLatency.find((bucket) => bucket.label === "fast")
    ).toEqual(
      expect.objectContaining({
        paperTradeCount: 2,
        matchedLiveTradeCount: 2,
        captureRatePct: 100,
        averageObservedVenueLatencyMs: 175,
        averageObservedBookSkewMs: 22.5
      })
    );

    expect(report.byStrategy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: "same-market-arb",
          sessionCount: 2,
          paperTradeCount: 4,
          matchedLiveTradeCount: 2,
          captureRatePct: 50,
          paperExpectedRealizedPnlUsdc: 0.7,
          matchedLiveRealizedPnlUsdc: 0.47,
          liveVsPaperDeltaUsdc: -0.23,
          pnlRealizationPct: 67.14285714
        }),
        expect.objectContaining({
          strategy: "negative-risk",
          sessionCount: 1,
          paperTradeCount: 1,
          matchedLiveTradeCount: 1,
          captureRatePct: 100,
          paperExpectedRealizedPnlUsdc: 0.2,
          matchedLiveRealizedPnlUsdc: 0.1,
          liveVsPaperDeltaUsdc: -0.1,
          pnlRealizationPct: 50
        })
      ])
    );

    expect(report.bestSessionByPaperDelta?.sessionName).toBe("session-ok");
    expect(report.worstSessionByPaperDelta?.sessionName).toBe("session-review");
    expect(
      report.sessions.find((session) => session.sessionName === "session-review")
    ).toEqual(
      expect.objectContaining({
        paperTradeCount: 3,
        matchedLiveTradeCount: 2,
        captureRatePct: 66.66666667,
        liveVsPaperDeltaUsdc: -0.25,
        riskStressScore: 0.6,
        paperCheckpointRecoveryReady: false
      })
    );
  });

  it("rejects empty input", () => {
    expect(() => buildCalibrationRollupReport({ reports: [] })).toThrow(
      "At least one small-live report is required"
    );
  });
});
