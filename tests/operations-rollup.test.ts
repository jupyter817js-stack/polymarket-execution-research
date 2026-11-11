import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildOperationsKpiRollupReport } from "../src/session-report/operations-rollup.js";
import { buildSmallLiveReport } from "../src/session-report/small-live-report.js";

const createTimestamp = (year: number, month: number, day: number, hour = 0): number =>
  Date.UTC(year, month - 1, day, hour, 0, 0, 0);

describe("Operations KPI rollup report", () => {
  it("builds weekly and monthly KPI windows from small-live reports", () => {
    const sessionWeek14A = buildSmallLiveReport({
      sessionName: "week14-a",
      generatedAtMs: createTimestamp(2026, 3, 31, 3),
      realized: {
        sessionName: "realized-week14-a",
        source: "live-runtime",
        endedAtMs: createTimestamp(2026, 3, 30, 23),
        finalRiskState: "RUNNING",
        tradeCount: 1,
        winningTrades: 1,
        losingTrades: 0,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.1,
        totalRealizedPnlUsdc: 0.12,
        realizedVsExpectedDeltaUsdc: 0.02,
        byStrategy: [
          {
            strategy: "same-market-arb",
            tradeCount: 1,
            winningTrades: 1,
            losingTrades: 0,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.1,
            totalRealizedPnlUsdc: 0.12,
            realizedVsExpectedDeltaUsdc: 0.02
          }
        ],
        trades: [
          {
            id: "trade-week14-a",
            dayKey: "2026-03-30",
            strategy: "same-market-arb",
            marketScope: "btc-above-120k",
            conditionId: "condition-a",
            realizedPnlUsdc: 0.12,
            grossRealizedPnlUsdc: 0.14,
            feeCostUsdc: 0.02,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.1,
            closedAtMs: createTimestamp(2026, 3, 30, 23),
            tags: ["live"]
          }
        ]
      },
      paper: {
        sessionName: "paper-week14-a",
        source: "dry-run-runtime",
        expectedTradeCount: 1,
        filledTradeCount: 1,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.1,
        totalRealizedPnlUsdc: 0.1,
        expectedVsRealizedDeltaUsdc: 0,
        averageObservedVenueLatencyMs: 120,
        averageObservedBookSkewMs: 20,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 0,
        lowConfidenceTradeCount: 0,
        finalRiskState: "RUNNING",
        checkpointValidation: {
          runtime: "integrated",
          checkpointReason: "stop",
          lastCheckpointGeneratedAtMs: createTimestamp(2026, 3, 30, 23),
          checkpointAgeMs: 2_000,
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
            totalExpectedRealizedPnlUsdc: 0.1,
            totalRealizedPnlUsdc: 0.1,
            expectedVsRealizedDeltaUsdc: 0,
            averageObservedVenueLatencyMs: 120,
            averageObservedBookSkewMs: 20,
            highConfidenceTradeCount: 1,
            mediumConfidenceTradeCount: 0,
            lowConfidenceTradeCount: 0
          }
        ],
        trades: [
          {
            id: "paper-trade-week14-a",
            strategy: "same-market-arb",
            marketScope: "btc-above-120k",
            conditionId: "condition-a",
            status: "filled",
            expectedRealizedPnlUsdc: 0.1,
            expectedGrossEdgeUsdc: 0.1,
            realizedPnlUsdc: 0.1,
            grossRealizedPnlUsdc: 0.1,
            feeCostUsdc: 0,
            observedVenueLatencyMs: 120,
            observedBookSkewMs: 20,
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
        generatedAtMs: createTimestamp(2026, 3, 30, 23),
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
            dayKey: "2026-03-30",
            dailyRealizedPnlUsdc: 0.12,
            dailyGrossRealizedPnlUsdc: 0.14,
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
      }
    });

    const sessionWeek14B = buildSmallLiveReport({
      sessionName: "week14-b",
      generatedAtMs: createTimestamp(2026, 4, 2, 4),
      realized: {
        sessionName: "realized-week14-b",
        source: "live-runtime",
        endedAtMs: createTimestamp(2026, 4, 2, 1),
        finalRiskState: "DEGRADED",
        tradeCount: 1,
        winningTrades: 1,
        losingTrades: 0,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.03,
        totalRealizedPnlUsdc: 0.06,
        realizedVsExpectedDeltaUsdc: 0.03,
        byStrategy: [
          {
            strategy: "market-making",
            tradeCount: 1,
            winningTrades: 1,
            losingTrades: 0,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.03,
            totalRealizedPnlUsdc: 0.06,
            realizedVsExpectedDeltaUsdc: 0.03
          }
        ],
        trades: [
          {
            id: "trade-week14-b",
            dayKey: "2026-04-02",
            strategy: "market-making",
            marketScope: "nba-finals",
            conditionId: "condition-b",
            realizedPnlUsdc: 0.06,
            grossRealizedPnlUsdc: 0.1,
            feeCostUsdc: 0.01,
            rebateUsdc: 0.01,
            rewardUsdc: 0.02,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.03,
            closedAtMs: createTimestamp(2026, 4, 2, 1),
            tags: ["live"]
          }
        ]
      },
      paper: {
        sessionName: "paper-week14-b",
        source: "dry-run-runtime",
        expectedTradeCount: 1,
        filledTradeCount: 1,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.08,
        totalRealizedPnlUsdc: 0.08,
        expectedVsRealizedDeltaUsdc: 0,
        averageObservedVenueLatencyMs: 300,
        averageObservedBookSkewMs: 35,
        highConfidenceTradeCount: 0,
        mediumConfidenceTradeCount: 1,
        lowConfidenceTradeCount: 0,
        finalRiskState: "DEGRADED",
        checkpointValidation: {
          runtime: "integrated",
          checkpointReason: "stop",
          lastCheckpointGeneratedAtMs: createTimestamp(2026, 4, 2, 1),
          checkpointAgeMs: 12_000,
          withinFreshnessWindow: true,
          checkpointRiskState: "DEGRADED",
          sessionRiskState: "DEGRADED",
          riskStateMatchesSession: true,
          recoveryReady: false,
          activeOrderCount: 1,
          activeConditionCount: 1,
          openLotCount: 1,
          openShares: 3,
          openCostUsdc: 1.5
        },
        byStrategy: [
          {
            strategy: "market-making",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.08,
            totalRealizedPnlUsdc: 0.08,
            expectedVsRealizedDeltaUsdc: 0,
            averageObservedVenueLatencyMs: 300,
            averageObservedBookSkewMs: 35,
            highConfidenceTradeCount: 0,
            mediumConfidenceTradeCount: 1,
            lowConfidenceTradeCount: 0
          }
        ],
        trades: [
          {
            id: "paper-trade-week14-b",
            strategy: "market-making",
            marketScope: "nba-finals",
            conditionId: "condition-b",
            status: "filled",
            expectedRealizedPnlUsdc: 0.08,
            expectedGrossEdgeUsdc: 0.08,
            realizedPnlUsdc: 0.08,
            grossRealizedPnlUsdc: 0.08,
            feeCostUsdc: 0,
            observedVenueLatencyMs: 300,
            observedBookSkewMs: 35,
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
        generatedAtMs: createTimestamp(2026, 4, 2, 1),
        monitoringSnapshot: {
          summaryType: "monitoring_snapshot",
          runtime: "integrated",
          risk: {
            state: "DEGRADED"
          },
          riskBudgetAdjustment: {
            state: "DEGRADED",
            stressScore: 0.5,
            dynamicCurveMultiplier: 0.8,
            sharedBuyBudgetMultiplier: 0.48,
            strategyBuyBudgetMultipliers: {
              "market-making": 0.24,
              "same-market-arb": 0.48,
              "negative-risk": 0.42
            }
          },
          portfolio: {
            dayKey: "2026-04-02",
            dailyRealizedPnlUsdc: 0.06,
            dailyGrossRealizedPnlUsdc: 0.1,
            dailyRewardUsdc: 0.03,
            dailyRebateUsdc: 0.02,
            dailyTradeCount: 1
          },
          activeOrders: {
            total: 1,
            activeConditions: 1
          }
        },
        inventory: {
          openLotCount: 2,
          openShares: 4,
          openCostUsdc: 2,
          openLots: [
            {
              lotId: "lot-week14-b-1",
              strategy: "market-making",
              tokenId: "yes-week14-b",
              marketScope: "nba-finals",
              conditionId: "condition-b",
              outcome: "Yes",
              shares: 3,
              totalCostUsdc: 1.5,
              openedAtMs: createTimestamp(2026, 4, 2, 0)
            },
            {
              lotId: "lot-week14-b-2",
              strategy: "market-making",
              tokenId: "no-week14-b",
              marketScope: "nba-finals",
              conditionId: "condition-b",
              outcome: "No",
              shares: 1,
              totalCostUsdc: 0.5,
              openedAtMs: createTimestamp(2026, 4, 2, 0)
            }
          ]
        }
      }
    });

    const sessionWeek16 = buildSmallLiveReport({
      sessionName: "week16-a",
      generatedAtMs: createTimestamp(2026, 4, 15, 3),
      realized: {
        sessionName: "realized-week16-a",
        source: "live-runtime",
        endedAtMs: createTimestamp(2026, 4, 15, 2),
        finalRiskState: "HALTED",
        tradeCount: 1,
        winningTrades: 0,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.05,
        totalRealizedPnlUsdc: -0.04,
        realizedVsExpectedDeltaUsdc: -0.09,
        byStrategy: [
          {
            strategy: "negative-risk",
            tradeCount: 1,
            winningTrades: 0,
            losingTrades: 1,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.05,
            totalRealizedPnlUsdc: -0.04,
            realizedVsExpectedDeltaUsdc: -0.09
          }
        ],
        trades: [
          {
            id: "trade-week16-a",
            dayKey: "2026-04-15",
            strategy: "negative-risk",
            marketScope: "election-basket",
            conditionId: "condition-c",
            realizedPnlUsdc: -0.04,
            grossRealizedPnlUsdc: -0.01,
            feeCostUsdc: 0.03,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.05,
            closedAtMs: createTimestamp(2026, 4, 15, 2),
            tags: ["live"]
          }
        ]
      },
      checkpoint: {
        checkpointType: "runtime_checkpoint",
        schemaVersion: 1,
        runtime: "integrated",
        reason: "stop",
        generatedAtMs: createTimestamp(2026, 4, 15, 2),
        monitoringSnapshot: {
          summaryType: "monitoring_snapshot",
          runtime: "integrated",
          risk: {
            state: "HALTED"
          },
          riskBudgetAdjustment: {
            state: "HALTED",
            stressScore: 1,
            dynamicCurveMultiplier: 0.3,
            sharedBuyBudgetMultiplier: 0.18,
            strategyBuyBudgetMultipliers: {
              "market-making": 0.09,
              "same-market-arb": 0.18,
              "negative-risk": 0.18
            }
          },
          portfolio: {
            dayKey: "2026-04-15",
            dailyRealizedPnlUsdc: -0.04,
            dailyGrossRealizedPnlUsdc: -0.01,
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
      }
    });

    const report = buildOperationsKpiRollupReport({
      groupName: "ops-q2",
      generatedAtMs: createTimestamp(2026, 4, 16, 0),
      reports: [sessionWeek14A, sessionWeek14B, sessionWeek16]
    });

    expect(report.reportType).toBe("operations_kpi_rollup");
    expect(report.groupName).toBe("ops-q2");
    expect(report.sourceSessionCount).toBe(3);
    expect(report.weekly).toHaveLength(2);
    expect(report.monthly).toHaveLength(2);

    const weeklyW14 = report.weekly.find((window) => window.key === "2026-W14");
    const monthlyApril = report.monthly.find((window) => window.key === "2026-04");

    expect(weeklyW14).toEqual(
      expect.objectContaining({
        sessionCount: 2,
        totalTradeCount: 2,
        totalLiveRealizedPnlUsdc: 0.18,
        totalRewardIncomeUsdc: 0.03,
        totalRebateIncomeUsdc: 0.02,
        sessionsWithPaperCount: 2,
        sessionsWithPaperCheckpointReadyCount: 1,
        sessionsWithPaperCheckpointNotReadyCount: 1,
        averageTradeExpectedEdgeUsdc: 0.065,
        averageTradeNetPnlUsdc: 0.09,
        averageStressScore: 0.25,
        minSharedBuyBudgetMultiplier: 0.48
      })
    );
    expect(weeklyW14?.bestSessionByLivePnl?.sessionName).toBe("week14-a");
    expect(weeklyW14?.worstSessionByPaperDelta?.sessionName).toBe("week14-b");

    expect(monthlyApril).toEqual(
      expect.objectContaining({
        sessionCount: 2,
        totalTradeCount: 2,
        totalLiveRealizedPnlUsdc: 0.02,
        totalRewardIncomeUsdc: 0.03,
        totalRebateIncomeUsdc: 0.02,
        maxResidualInventoryUtilizationPct: Number(
          ((2 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)
        ),
        maxYesNoImbalancePct: 50,
        averageSharedBuyBudgetMultiplier: 0.33
      })
    );

    expect(report.overall).toEqual(
      expect.objectContaining({
        sessionCount: 3,
        totalTradeCount: 3,
        totalExpectedEdgeUsdc: 0.18,
        totalLiveRealizedPnlUsdc: 0.14,
        totalLiveVsExpectedDeltaUsdc: -0.04,
        totalPaperVsLiveDeltaUsdc: 0,
        averageTradeExpectedEdgeUsdc: 0.06,
        averageTradeNetPnlUsdc: Number((0.14 / 3).toFixed(8)),
        totalRewardIncomeUsdc: 0.03,
        totalRebateIncomeUsdc: 0.02,
        averageRewardShareOfPositiveCreditsPct: Number(((0 + 20 + 0) / 3).toFixed(8)),
        averageRebateShareOfPositiveCreditsPct: Number((13.33333333 / 3).toFixed(8)),
        averageStressScore: 0.5,
        maxStressScore: 1,
        averageSharedBuyBudgetMultiplier: Number(((1 + 0.48 + 0.18) / 3).toFixed(8)),
        minSharedBuyBudgetMultiplier: 0.18
      })
    );

    const marketMakingSummary = report.overall.byStrategy.find(
      (strategy) => strategy.strategy === "market-making"
    );
    const negRiskSummary = report.overall.byStrategy.find(
      (strategy) => strategy.strategy === "negative-risk"
    );
    expect(marketMakingSummary).toEqual(
      expect.objectContaining({
        sessionCount: 1,
        tradeCount: 1,
        totalRealizedPnlUsdc: 0.06,
        averageTradeNetPnlUsdc: 0.06
      })
    );
    expect(negRiskSummary).toEqual(
      expect.objectContaining({
        sessionCount: 1,
        tradeCount: 1,
        totalRealizedPnlUsdc: -0.04
      })
    );
  });

  it("rejects empty input", () => {
    expect(() => buildOperationsKpiRollupReport({ reports: [] })).toThrow(
      "At least one small-live report is required"
    );
  });
});
