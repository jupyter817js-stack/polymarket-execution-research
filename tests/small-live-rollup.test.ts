import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildSmallLiveReport } from "../src/session-report/small-live-report.js";
import { buildSmallLiveRollupReport } from "../src/session-report/small-live-rollup.js";

describe("Small live rollup report", () => {
  it("aggregates multiple small-live session reports into a cumulative rollup", () => {
    const reviewSession = buildSmallLiveReport({
      sessionName: "session-review",
      generatedAtMs: 100,
      realized: {
        sessionName: "live-review",
        source: "live-runtime",
        finalRiskState: "DEGRADED",
        tradeCount: 2,
        winningTrades: 1,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.5,
        totalRealizedPnlUsdc: 0.1,
        realizedVsExpectedDeltaUsdc: -0.4,
        byStrategy: [
          {
            strategy: "same-market-arb",
            tradeCount: 1,
            winningTrades: 1,
            losingTrades: 0,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.3,
            totalRealizedPnlUsdc: 0.2,
            realizedVsExpectedDeltaUsdc: -0.1
          },
          {
            strategy: "negative-risk",
            tradeCount: 1,
            winningTrades: 0,
            losingTrades: 1,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.2,
            totalRealizedPnlUsdc: -0.1,
            realizedVsExpectedDeltaUsdc: -0.3
          }
        ],
        trades: [
          {
            id: "review-live-1",
            dayKey: "2026-03-31",
            strategy: "same-market-arb",
            marketScope: "btc-above-120k",
            conditionId: "condition-1",
            realizedPnlUsdc: 0.2,
            grossRealizedPnlUsdc: 0.25,
            feeCostUsdc: 0.05,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.3,
            closedAtMs: 10,
            tags: ["live"]
          },
          {
            id: "review-live-2",
            dayKey: "2026-03-31",
            strategy: "negative-risk",
            marketScope: "election-basket",
            realizedPnlUsdc: -0.1,
            grossRealizedPnlUsdc: -0.05,
            feeCostUsdc: 0.05,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.2,
            closedAtMs: 11,
            tags: ["live"]
          }
        ]
      },
      paper: {
        sessionName: "paper-review",
        source: "dry-run-runtime",
        expectedTradeCount: 2,
        filledTradeCount: 2,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.5,
        totalRealizedPnlUsdc: 0.5,
        expectedVsRealizedDeltaUsdc: 0,
        averageObservedVenueLatencyMs: 510,
        averageObservedBookSkewMs: 45,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 1,
        lowConfidenceTradeCount: 0,
        finalRiskState: "RUNNING",
        checkpointValidation: {
          runtime: "integrated",
          checkpointReason: "checkpoint",
          lastCheckpointGeneratedAtMs: 100,
          checkpointAgeMs: 180_000,
          withinFreshnessWindow: false,
          checkpointRiskState: "RUNNING",
          sessionRiskState: "RUNNING",
          riskStateMatchesSession: true,
          recoveryReady: false,
          activeOrderCount: 1,
          activeConditionCount: 1,
          openLotCount: 1,
          openShares: 2,
          openCostUsdc: 0.8
        },
        byStrategy: [
          {
            strategy: "same-market-arb",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.3,
            totalRealizedPnlUsdc: 0.3,
            expectedVsRealizedDeltaUsdc: 0,
            averageObservedVenueLatencyMs: 120,
            averageObservedBookSkewMs: 20,
            highConfidenceTradeCount: 1,
            mediumConfidenceTradeCount: 0,
            lowConfidenceTradeCount: 0
          },
          {
            strategy: "negative-risk",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.2,
            totalRealizedPnlUsdc: 0.2,
            expectedVsRealizedDeltaUsdc: 0,
            averageObservedVenueLatencyMs: 900,
            averageObservedBookSkewMs: 70,
            highConfidenceTradeCount: 0,
            mediumConfidenceTradeCount: 1,
            lowConfidenceTradeCount: 0
          }
        ],
        trades: [
          {
            id: "review-paper-1",
            strategy: "same-market-arb",
            marketScope: "btc-above-120k",
            conditionId: "condition-1",
            status: "filled",
            expectedRealizedPnlUsdc: 0.3,
            expectedGrossEdgeUsdc: 0.3,
            realizedPnlUsdc: 0.3,
            grossRealizedPnlUsdc: 0.3,
            feeCostUsdc: 0,
            observedVenueLatencyMs: 120,
            observedBookSkewMs: 20,
            fillConfidence: "high",
            tags: ["paper"]
          },
          {
            id: "review-paper-2",
            strategy: "negative-risk",
            marketScope: "election-basket",
            status: "filled",
            expectedRealizedPnlUsdc: 0.2,
            expectedGrossEdgeUsdc: 0.2,
            realizedPnlUsdc: 0.2,
            grossRealizedPnlUsdc: 0.2,
            feeCostUsdc: 0,
            observedVenueLatencyMs: 900,
            observedBookSkewMs: 70,
            fillConfidence: "medium",
            tags: ["paper"]
          }
        ]
      },
      checkpoint: {
        checkpointType: "runtime_checkpoint",
        schemaVersion: 1,
        runtime: "integrated",
        reason: "stop",
        generatedAtMs: 12,
        monitoringSnapshot: {
          summaryType: "monitoring_snapshot",
          runtime: "integrated",
          risk: {
            state: "DEGRADED"
          },
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
          portfolio: {
            dayKey: "2026-03-31",
            dailyRealizedPnlUsdc: 0.1,
            dailyGrossRealizedPnlUsdc: 0.2,
            dailyRewardUsdc: 0,
            dailyRebateUsdc: 0,
            dailyTradeCount: 2
          },
          activeOrders: {
            total: 1,
            activeConditions: 1
          }
        },
        inventory: {
          openLotCount: 1,
          openShares: 2,
          openCostUsdc: 0.8,
          openLots: [
            {
              lotId: "review-lot-1",
              strategy: "same-market-arb",
              tokenId: "yes-1",
              marketScope: "btc-above-120k",
              conditionId: "condition-1",
              outcome: "Yes",
              shares: 2,
              totalCostUsdc: 0.8,
              openedAtMs: 1
            }
          ]
        }
      },
      restartDrill: {
        reportType: "restart_drill_report",
        schemaVersion: 1,
        sessionName: "review-restart-drill",
        generatedAtMs: 13,
        runtime: "integrated",
        outcome: "warning",
        checkpoint: {
          generatedAtMs: 12,
          riskState: "DEGRADED",
          openLotCount: 1,
          openShares: 2,
          openCostUsdc: 0.8
        },
        recovery: {
          recoveredLotCount: 1,
          recoveredShares: 1.9,
          recoveredCostUsdc: 0.76
        },
        totals: {
          matchedLotCount: 1,
          missingLotCount: 0,
          unexpectedLotCount: 0,
          sharesDelta: -0.1,
          costDeltaUsdc: -0.04
        },
        lotDiffs: [],
        flags: [
          {
            code: "share_mismatch",
            severity: "warning",
            detail: "Recovered lot shares drifted slightly."
          }
        ]
      }
    });

    const okSession = buildSmallLiveReport({
      sessionName: "session-ok",
      generatedAtMs: 200,
      realized: {
        sessionName: "live-ok",
        source: "live-runtime",
        finalRiskState: "RUNNING",
        tradeCount: 1,
        winningTrades: 1,
        losingTrades: 0,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.15,
        totalRealizedPnlUsdc: 0.2,
        realizedVsExpectedDeltaUsdc: 0.05,
        byStrategy: [
          {
            strategy: "same-market-arb",
            tradeCount: 1,
            winningTrades: 1,
            losingTrades: 0,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.15,
            totalRealizedPnlUsdc: 0.2,
            realizedVsExpectedDeltaUsdc: 0.05
          }
        ],
        trades: [
          {
            id: "ok-live-1",
            dayKey: "2026-04-01",
            strategy: "same-market-arb",
            marketScope: "eth-above-5k",
            conditionId: "condition-2",
            realizedPnlUsdc: 0.2,
            grossRealizedPnlUsdc: 0.22,
            feeCostUsdc: 0.02,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.15,
            closedAtMs: 20,
            tags: ["live"]
          }
        ]
      },
      paper: {
        sessionName: "paper-ok",
        source: "dry-run-runtime",
        expectedTradeCount: 1,
        filledTradeCount: 1,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.15,
        totalRealizedPnlUsdc: 0.15,
        expectedVsRealizedDeltaUsdc: 0,
        averageObservedVenueLatencyMs: 180,
        averageObservedBookSkewMs: 25,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 0,
        lowConfidenceTradeCount: 0,
        finalRiskState: "RUNNING",
        checkpointValidation: {
          runtime: "integrated",
          checkpointReason: "stop",
          lastCheckpointGeneratedAtMs: 200,
          checkpointAgeMs: 10_000,
          withinFreshnessWindow: true,
          checkpointRiskState: "RUNNING",
          sessionRiskState: "RUNNING",
          riskStateMatchesSession: true,
          recoveryReady: true,
          activeOrderCount: 0,
          activeConditionCount: 0,
          openLotCount: 0,
          openShares: 0,
          openCostUsdc: 0
        },
        byStrategy: [
          {
            strategy: "same-market-arb",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.15,
            totalRealizedPnlUsdc: 0.15,
            expectedVsRealizedDeltaUsdc: 0,
            averageObservedVenueLatencyMs: 180,
            averageObservedBookSkewMs: 25,
            highConfidenceTradeCount: 1,
            mediumConfidenceTradeCount: 0,
            lowConfidenceTradeCount: 0
          }
        ],
        trades: [
          {
            id: "ok-paper-1",
            strategy: "same-market-arb",
            marketScope: "eth-above-5k",
            conditionId: "condition-2",
            status: "filled",
            expectedRealizedPnlUsdc: 0.15,
            expectedGrossEdgeUsdc: 0.15,
            realizedPnlUsdc: 0.15,
            grossRealizedPnlUsdc: 0.15,
            feeCostUsdc: 0,
            observedVenueLatencyMs: 180,
            observedBookSkewMs: 25,
            fillConfidence: "high",
            tags: ["paper"]
          }
        ]
      },
      checkpoint: {
        checkpointType: "runtime_checkpoint",
        schemaVersion: 1,
        runtime: "integrated",
        reason: "stop",
        generatedAtMs: 21,
        monitoringSnapshot: {
          summaryType: "monitoring_snapshot",
          runtime: "integrated",
          risk: {
            state: "RUNNING"
          },
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
          portfolio: {
            dayKey: "2026-04-01",
            dailyRealizedPnlUsdc: 0.2,
            dailyGrossRealizedPnlUsdc: 0.22,
            dailyRewardUsdc: 0,
            dailyRebateUsdc: 0,
            dailyTradeCount: 1
          },
          activeOrders: {
            total: 0,
            activeConditions: 0
          }
        },
        inventory: {
          openLotCount: 0,
          openShares: 0,
          openCostUsdc: 0,
          openLots: []
        }
      },
      restartDrill: {
        reportType: "restart_drill_report",
        schemaVersion: 1,
        sessionName: "ok-restart-drill",
        generatedAtMs: 22,
        runtime: "integrated",
        outcome: "passed",
        checkpoint: {
          generatedAtMs: 21,
          riskState: "RUNNING",
          openLotCount: 0,
          openShares: 0,
          openCostUsdc: 0
        },
        recovery: {
          recoveredLotCount: 0,
          recoveredShares: 0,
          recoveredCostUsdc: 0
        },
        totals: {
          matchedLotCount: 0,
          missingLotCount: 0,
          unexpectedLotCount: 0,
          sharesDelta: 0,
          costDeltaUsdc: 0
        },
        lotDiffs: [],
        flags: []
      }
    });

    const rollup = buildSmallLiveRollupReport({
      groupName: "week-14-small-live",
      generatedAtMs: 300,
      reports: [reviewSession, okSession]
    });

    expect(rollup.reportType).toBe("small_live_rollup");
    expect(rollup.groupName).toBe("week-14-small-live");
    expect(rollup.sessionCount).toBe(2);
    expect(rollup.statusCounts).toEqual({
      ok: 1,
      review: 1,
      halted: 0
    });
    expect(rollup.sessionWithPaperCheckpointValidationCount).toBe(2);
    expect(rollup.sessionWithPaperCheckpointReadyCount).toBe(1);
    expect(rollup.sessionWithPaperCheckpointNotReadyCount).toBe(1);
    expect(rollup.finalRiskStateCounts).toEqual({
      RUNNING: 1,
      WARNING: 0,
      DEGRADED: 1,
      RECOVERY: 0,
      HALTED: 0
    });
    expect(rollup.sessionWithRestartDrillCount).toBe(2);
    expect(rollup.restartDrillPassedCount).toBe(1);
    expect(rollup.restartDrillWarningCount).toBe(1);
    expect(rollup.restartDrillFailedCount).toBe(0);
    expect(rollup.sessionsWithResidualInventoryCount).toBe(1);
    expect(rollup.sessionsWithResidualActiveOrdersCount).toBe(1);
    expect(rollup.sessionsWithRiskBudgetAdjustmentCount).toBe(2);
    expect(rollup.totalLiveTradeCount).toBe(3);
    expect(rollup.totalLiveRealizedPnlUsdc).toBeCloseTo(0.3, 8);
    expect(rollup.totalLiveVsExpectedDeltaUsdc).toBeCloseTo(-0.35, 8);
    expect(rollup.totalPaperVsLiveDeltaUsdc).toBeCloseTo(-0.35, 8);
    expect(rollup.kpis).toEqual(
      expect.objectContaining({
        averageDailyRoiPct: Number(
          (((0.1 / config.capital.totalActiveBuyBudgetUsdc) * 100 +
            (0.2 / config.capital.totalActiveBuyBudgetUsdc) * 100) /
            2).toFixed(8)
        ),
        totalRewardIncomeUsdc: 0,
        totalRebateIncomeUsdc: 0,
        maxResidualInventoryUtilizationPct: Number(
          ((0.8 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)
        ),
        maxYesNoImbalancePct: 100
      })
    );
    expect(rollup.riskBudgetAdjustment).toEqual(
      expect.objectContaining({
        averageStressScore: 0.3,
        maxStressScore: 0.6,
        averageSharedBuyBudgetMultiplier: 0.71,
        minSharedBuyBudgetMultiplier: 0.42,
        strategyMinBuyBudgetMultipliers: {
          "market-making": 0.21,
          "same-market-arb": 0.336,
          "negative-risk": 0.294
        }
      })
    );
    expect(
      rollup.byObservedLatency.find((bucket) => bucket.label === "fast")?.paperTradeCount
    ).toBe(2);
    expect(
      rollup.byObservedLatency.find((bucket) => bucket.label === "fast")
        ?.averageObservedVenueLatencyMs
    ).toBeCloseTo(150, 8);
    expect(
      rollup.byObservedLatency.find((bucket) => bucket.label === "moderate")?.paperTradeCount
    ).toBe(1);
    expect(rollup.bestSessionByLivePnl?.sessionName).toBe("session-ok");
    expect(rollup.worstSessionByPaperDelta?.sessionName).toBe("session-review");

    const arbSummary = rollup.byStrategy.find((strategy) => strategy.strategy === "same-market-arb");
    const negRiskSummary = rollup.byStrategy.find((strategy) => strategy.strategy === "negative-risk");
    const realizedBelowPaperFlag = rollup.byFlag.find((flag) => flag.code === "realized_below_paper");

    expect(arbSummary?.sessionCount).toBe(2);
    expect(arbSummary?.liveTradeCount).toBe(2);
    expect(arbSummary?.liveRealizedPnlUsdc).toBeCloseTo(0.4, 8);
    expect(arbSummary?.paperVsLiveDeltaUsdc).toBeCloseTo(-0.05, 8);
    expect(negRiskSummary?.sessionCount).toBe(1);
    expect(negRiskSummary?.liveRealizedPnlUsdc).toBeCloseTo(-0.1, 8);
    expect(realizedBelowPaperFlag?.count).toBe(1);
    expect(realizedBelowPaperFlag?.warningCount).toBe(1);
    expect(rollup.sessions.find((session) => session.sessionName === "session-review")?.paperCheckpointRecoveryReady).toBe(false);
    expect(rollup.sessions.find((session) => session.sessionName === "session-review")?.riskStressScore).toBe(0.6);
    expect(
      rollup.sessions.find((session) => session.sessionName === "session-review")
        ?.sharedBuyBudgetMultiplier
    ).toBe(0.42);
    expect(
      rollup.sessions.find((session) => session.sessionName === "session-review")?.dailyRoiPct
    ).toBe(Number(((0.1 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)));
    expect(
      rollup.sessions.find((session) => session.sessionName === "session-review")
        ?.residualInventoryUtilizationPct
    ).toBe(Number(((0.8 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)));
  });

  it("rejects empty input", () => {
    expect(() => buildSmallLiveRollupReport({ reports: [] })).toThrow(
      "At least one small-live report is required"
    );
  });
});
