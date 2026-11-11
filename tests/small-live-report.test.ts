import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildSmallLiveReport } from "../src/session-report/small-live-report.js";

describe("Small live report", () => {
  it("builds an operator-facing summary from realized, paper, and checkpoint inputs", () => {
    const report = buildSmallLiveReport({
      sessionName: "small-live-2026-03-31",
      generatedAtMs: 1_700_000_010_000,
      paper: {
        sessionName: "paper-session",
        source: "dry-run-runtime",
        startedAtMs: 1,
        endedAtMs: 2,
        expectedTradeCount: 2,
        filledTradeCount: 2,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.5,
        totalRealizedPnlUsdc: 0.5,
        expectedVsRealizedDeltaUsdc: 0,
        averageRealizedFillLatencyMs: 250,
        averageObservedVenueLatencyMs: 510,
        averageObservedBookSkewMs: 45,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 1,
        lowConfidenceTradeCount: 0,
        finalRiskState: "RUNNING",
        checkpointValidation: {
          runtime: "integrated",
          checkpointReason: "checkpoint",
          lastCheckpointGeneratedAtMs: 1,
          checkpointAgeMs: 180_000,
          withinFreshnessWindow: false,
          checkpointRiskState: "RUNNING",
          sessionRiskState: "RUNNING",
          riskStateMatchesSession: true,
          recoveryReady: false,
          activeOrderCount: 1,
          activeConditionCount: 1,
          openLotCount: 2,
          openShares: 3.5,
          openCostUsdc: 1.15
        },
        byStrategy: [
          {
            strategy: "negative-risk",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.2,
            totalRealizedPnlUsdc: 0.2,
            expectedVsRealizedDeltaUsdc: 0,
            averageRealizedFillLatencyMs: 200,
            averageObservedVenueLatencyMs: 900,
            averageObservedBookSkewMs: 70,
            highConfidenceTradeCount: 0,
            mediumConfidenceTradeCount: 1,
            lowConfidenceTradeCount: 0
          },
          {
            strategy: "same-market-arb",
            expectedTradeCount: 1,
            filledTradeCount: 1,
            missedTradeCount: 0,
            fillRate: 1,
            totalExpectedRealizedPnlUsdc: 0.3,
            totalRealizedPnlUsdc: 0.3,
            expectedVsRealizedDeltaUsdc: 0,
            averageRealizedFillLatencyMs: 300,
            averageObservedVenueLatencyMs: 120,
            averageObservedBookSkewMs: 20,
            highConfidenceTradeCount: 1,
            mediumConfidenceTradeCount: 0,
            lowConfidenceTradeCount: 0
          }
        ],
        trades: [
          {
            id: "paper-1",
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
            depthCoverageRatio: 2,
            fillConfidence: "high",
            tags: ["paper"]
          },
          {
            id: "paper-2",
            strategy: "negative-risk",
            marketScope: "election-basket",
            status: "filled",
            expectedRealizedPnlUsdc: 0.2,
            expectedGrossEdgeUsdc: 0.25,
            realizedPnlUsdc: 0.2,
            grossRealizedPnlUsdc: 0.25,
            feeCostUsdc: 0.05,
            observedVenueLatencyMs: 900,
            observedBookSkewMs: 70,
            depthCoverageRatio: 1.2,
            fillConfidence: "medium",
            tags: ["paper"]
          }
        ]
      },
      realized: {
        sessionName: "live-session",
        source: "live-runtime",
        startedAtMs: 1,
        endedAtMs: 2,
        finalRiskState: "DEGRADED",
        tradeCount: 2,
        winningTrades: 1,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.45,
        totalRealizedPnlUsdc: 0.1,
        realizedVsExpectedDeltaUsdc: -0.35,
        byStrategy: [
          {
            strategy: "negative-risk",
            tradeCount: 1,
            winningTrades: 0,
            losingTrades: 1,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.15,
            totalRealizedPnlUsdc: -0.1,
            realizedVsExpectedDeltaUsdc: -0.25
          },
          {
            strategy: "same-market-arb",
            tradeCount: 1,
            winningTrades: 1,
            losingTrades: 0,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.3,
            totalRealizedPnlUsdc: 0.2,
            realizedVsExpectedDeltaUsdc: -0.1
          }
        ],
        trades: [
          {
            id: "live-1",
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
            closedAtMs: 3,
            tags: ["live"]
          },
          {
            id: "live-2",
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
            expectedEdgeUsdc: 0.15,
            closedAtMs: 4,
            tags: ["live"]
          }
        ]
      },
      checkpoint: {
        checkpointType: "runtime_checkpoint",
        schemaVersion: 1,
        runtime: "integrated",
        reason: "stop",
        generatedAtMs: 5,
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
          openLotCount: 2,
          openShares: 3.5,
          openCostUsdc: 1.15,
          openLots: [
            {
              lotId: "lot-1",
              strategy: "same-market-arb",
              tokenId: "yes-1",
              marketScope: "btc-above-120k",
              conditionId: "condition-1",
              outcome: "Yes",
              shares: 2,
              totalCostUsdc: 0.6,
              openedAtMs: 1
            },
            {
              lotId: "lot-2",
              strategy: "negative-risk",
              tokenId: "yes-2",
              marketScope: "election-basket",
              shares: 1.5,
              totalCostUsdc: 0.55,
              openedAtMs: 2
            }
          ]
        }
      },
      restartDrill: {
        reportType: "restart_drill_report",
        schemaVersion: 1,
        sessionName: "restart-drill-session",
        generatedAtMs: 6,
        runtime: "integrated",
        outcome: "warning",
        checkpoint: {
          generatedAtMs: 5,
          riskState: "DEGRADED",
          openLotCount: 2,
          openShares: 3.5,
          openCostUsdc: 1.15
        },
        recovery: {
          recoveredLotCount: 2,
          recoveredShares: 3.4,
          recoveredCostUsdc: 1.1
        },
        totals: {
          matchedLotCount: 2,
          missingLotCount: 0,
          unexpectedLotCount: 0,
          sharesDelta: -0.1,
          costDeltaUsdc: -0.05
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

    expect(report.reportType).toBe("small_live_summary");
    expect(report.overallStatus).toBe("review");
    expect(report.comparison?.matchedKeyCount).toBe(2);
    expect(report.comparison?.totalPaperVsLiveDeltaUsdc).toBeCloseTo(-0.4, 8);
    expect(report.paperSession?.averageObservedVenueLatencyMs).toBeCloseTo(510, 8);
    expect(report.paperSession?.checkpointRecoveryReady).toBe(false);
    expect(report.kpis).toEqual(
      expect.objectContaining({
        tradeCount: 2,
        averageTradeExpectedEdgeUsdc: 0.225,
        averageTradeNetPnlUsdc: 0.05,
        dailyRoiPct: Number(
          ((0.1 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)
        ),
        residualInventoryCostUsdc: 1.15,
        yesNoImbalancePct: 100
      })
    );
    expect(
      report.comparison?.byObservedLatency.find((bucket) => bucket.label === "fast")?.paperTradeCount
    ).toBe(1);
    expect(report.checkpoint?.openLotCount).toBe(2);
    expect(report.checkpoint?.riskBudgetAdjustment).toEqual(
      expect.objectContaining({
        stressScore: 0.6,
        sharedBuyBudgetMultiplier: 0.42
      })
    );
    expect(report.checkpoint?.kpis).toEqual(
      expect.objectContaining({
        tradeCount: 2,
        residualInventoryCostUsdc: 1.15,
        yesNoImbalancePct: 100
      })
    );
    expect(report.restartDrill).toEqual(
      expect.objectContaining({
        outcome: "warning",
        matchedLotCount: 2,
        sharesDelta: -0.1,
        costDeltaUsdc: -0.05
      })
    );
    expect(report.flags.map((flag) => flag.code)).toEqual(
      expect.arrayContaining([
        "risk_not_running",
        "paper_checkpoint_not_ready",
        "restart_drill_warning",
        "realized_below_paper",
        "open_inventory_remaining",
        "active_orders_remaining"
      ])
    );

    const arbSummary = report.byStrategy.find((summary) => summary.strategy === "same-market-arb");
    expect(arbSummary?.paperExpectedTradeCount).toBe(1);
    expect(arbSummary?.liveTradeCount).toBe(1);
    expect(arbSummary?.paperVsLiveDeltaUsdc).toBeCloseTo(-0.1, 8);
  });

  it("marks halted sessions and missing supplemental files for review", () => {
    const report = buildSmallLiveReport({
      realized: {
        sessionName: "halted-session",
        source: "live-runtime",
        finalRiskState: "HALTED",
        tradeCount: 1,
        winningTrades: 0,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.2,
        totalRealizedPnlUsdc: -0.4,
        realizedVsExpectedDeltaUsdc: -0.6,
        byStrategy: [
          {
            strategy: "same-market-arb",
            tradeCount: 1,
            winningTrades: 0,
            losingTrades: 1,
            flatTrades: 0,
            totalExpectedEdgeUsdc: 0.2,
            totalRealizedPnlUsdc: -0.4,
            realizedVsExpectedDeltaUsdc: -0.6
          }
        ],
        trades: [
          {
            id: "live-1",
            dayKey: "2026-03-31",
            strategy: "same-market-arb",
            marketScope: "btc-above-120k",
            realizedPnlUsdc: -0.4,
            grossRealizedPnlUsdc: -0.35,
            feeCostUsdc: 0.05,
            rebateUsdc: 0,
            rewardUsdc: 0,
            slippageCostUsdc: 0,
            unfilledCostUsdc: 0,
            gasCostUsdc: 0,
            expectedEdgeUsdc: 0.2,
            closedAtMs: 10,
            tags: ["live"]
          }
        ]
      }
    });

    expect(report.overallStatus).toBe("halted");
    expect(report.paperSession).toBeUndefined();
    expect(report.checkpoint).toBeUndefined();
    expect(report.flags.map((flag) => flag.code)).toEqual(
      expect.arrayContaining([
        "risk_not_running",
        "session_loss",
        "paper_report_missing",
        "runtime_checkpoint_missing"
      ])
    );
  });
});
