import { describe, expect, it } from "vitest";

import {
  parseSimulationScenario,
  runSimulationScenario
} from "../src/simulation/harness.js";

describe("Simulation harness", () => {
  it("replays market-making and then lets same-market arb replace the passive BUY slots", () => {
    const scenario = parseSimulationScenario({
      name: "mm-vs-arb",
      markets: [
        {
          id: "market-1",
          conditionId: "condition-1",
          question: "Will BTC be above 120k?",
          slug: "btc-above-120k",
          category: "Crypto",
          outcomes: ["Yes", "No"],
          tokenIds: ["yes-token", "no-token"],
          feesEnabled: false
        }
      ],
      initialBooks: [
        {
          tokenId: "yes-token",
          bids: [{ price: 0.49, size: 2500 }],
          asks: [{ price: 0.51, size: 2500 }]
        },
        {
          tokenId: "no-token",
          bids: [{ price: 0.49, size: 2500 }],
          asks: [{ price: 0.51, size: 2500 }]
        }
      ],
      steps: [
        {
          id: "step-1",
          atMs: 1_767_225_600_000,
          evaluate: ["market-making"]
        },
        {
          id: "step-2",
          atMs: 1_767_225_601_000,
          bookSnapshots: [
            {
              tokenId: "yes-token",
              bids: [{ price: 0.41, size: 500 }],
              asks: [{ price: 0.42, size: 500 }]
            },
            {
              tokenId: "no-token",
              bids: [{ price: 0.54, size: 500 }],
              asks: [{ price: 0.55, size: 500 }]
            }
          ],
          evaluate: ["same-market-arb"]
        }
      ]
    });

    const report = runSimulationScenario(scenario);

    expect(report.stepCount).toBe(2);
    expect(report.finalRiskState).toBe("RUNNING");
    expect(report.finalActiveOrderCount).toBe(2);
    expect(report.totalGeneratedIntentCount).toBe(6);
    expect(report.totalApprovedIntentCount).toBe(6);
    expect(report.totalRejectedIntentCount).toBe(0);
    expect(report.totalSimulatedTradeCount).toBe(1);
    expect(report.totalSimulatedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(report.finalPortfolio.dailyTradeCount).toBe(1);
    expect(report.finalPortfolio.dailyRealizedPnlUsdc).toBeGreaterThan(0);
    expect(report.steps[0]?.acceptedActions.create).toBe(4);
    expect(report.steps[0]?.activeOrderCount).toBe(4);
    expect(report.steps[0]?.simulatedTradeCount).toBe(0);
    expect(report.steps[1]?.acceptedActions.replace).toBe(2);
    expect(report.steps[1]?.simulatedTradeCount).toBe(1);
    expect(report.steps[1]?.simulatedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(report.steps[1]?.portfolio.dailyTradeCount).toBe(1);
    expect(report.steps[1]?.portfolio.dailyRealizedPnlUsdc).toBeGreaterThan(0);
    expect(report.steps[1]?.activeOrderCount).toBe(2);
    // Verify that simulated PnL equals the arb trade's realized PnL (full fill, no partial)
    const arbSimTrade = report.steps[1]?.simulatedTrades[0];
    expect(arbSimTrade?.status).toBe("filled");
    expect(arbSimTrade?.realizedPnlUsdc).toBeCloseTo(
      arbSimTrade?.expectedRealizedPnlUsdc ?? 0, 6
    );

    const mmTotals = report.strategyTotals.find((summary) => summary.strategy === "market-making");
    const arbTotals = report.strategyTotals.find(
      (summary) => summary.strategy === "same-market-arb"
    );

    expect(mmTotals?.opportunityCount).toBe(1);
    expect(mmTotals?.generatedIntentCount).toBe(4);
    expect(arbTotals?.opportunityCount).toBe(1);
    expect(arbTotals?.generatedIntentCount).toBe(2);
  });

  it("applies simulated risk events and blocks new BUY intents while degraded", () => {
    const scenario = parseSimulationScenario({
      name: "risk-degraded-buy-block",
      markets: [
        {
          id: "market-1",
          conditionId: "condition-1",
          question: "Will ETH be above 8k?",
          slug: "eth-above-8k",
          outcomes: ["Yes", "No"],
          tokenIds: ["eth-yes", "eth-no"],
          feesEnabled: false
        }
      ],
      initialBooks: [
        {
          tokenId: "eth-yes",
          bids: [{ price: 0.41, size: 500 }],
          asks: [{ price: 0.42, size: 500 }]
        },
        {
          tokenId: "eth-no",
          bids: [{ price: 0.54, size: 500 }],
          asks: [{ price: 0.55, size: 500 }]
        }
      ],
      riskThresholds: {
        maxDailyLossUsdc: 10,
        degradeDailyLossRatio: 0.5,
        blockNewBuyIntentsOnDegraded: true
      },
      steps: [
        {
          id: "step-1",
          atMs: 1_767_225_700_000,
          riskEvents: [
            {
              type: "trade_closed",
              realizedPnlUsdc: -6,
              source: "simulation-loss"
            }
          ],
          evaluate: ["same-market-arb"]
        }
      ]
    });

    const report = runSimulationScenario(scenario);

    expect(report.finalRiskState).toBe("DEGRADED");
    expect(report.finalActiveOrderCount).toBe(0);
    expect(report.totalGeneratedIntentCount).toBe(2);
    expect(report.totalApprovedIntentCount).toBe(0);
    expect(report.totalRejectedIntentCount).toBe(2);
    expect(report.totalSimulatedTradeCount).toBe(0);
    expect(report.finalPortfolio.dailyTradeCount).toBe(0);
    expect(report.steps[0]?.riskEventsApplied[0]?.state).toBe("DEGRADED");
    expect(report.steps[0]?.coordinatorRejections.risk_blocked).toBe(2);
    expect(report.steps[0]?.simulatedTradeCount).toBe(0);
    expect(report.steps[0]?.activeOrderCount).toBe(0);
  });

  it("supports step-level partial fills with simulated latency on approved opportunities", () => {
    const scenario = parseSimulationScenario({
      name: "partial-fill-latency",
      markets: [
        {
          id: "market-1",
          conditionId: "condition-1",
          question: "Will SOL be above 1k?",
          slug: "sol-above-1k",
          outcomes: ["Yes", "No"],
          tokenIds: ["sol-yes", "sol-no"],
          feesEnabled: false
        }
      ],
      initialBooks: [
        {
          tokenId: "sol-yes",
          bids: [{ price: 0.41, size: 500 }],
          asks: [{ price: 0.42, size: 500 }]
        },
        {
          tokenId: "sol-no",
          bids: [{ price: 0.54, size: 500 }],
          asks: [{ price: 0.55, size: 500 }]
        }
      ],
      steps: [
        {
          id: "step-1",
          atMs: 1_767_225_800_000,
          evaluate: ["same-market-arb"],
          execution: {
            defaultLatencyMs: 1200,
            tradeOverrides: [
              {
                strategy: "same-market-arb",
                conditionId: "condition-1",
                fillRatio: 0.4,
                reason: "partial_fill_simulation"
              }
            ]
          }
        }
      ]
    });

    const report = runSimulationScenario(scenario);
    const simulatedTrade = report.steps[0]?.simulatedTrades[0];
    const paperTrade = report.steps[0]?.paperTrades[0];

    // Use the computed expectedRealizedPnlUsdc as the baseline — it depends on
    // config-driven values (targetShares, etc.) and we want to verify ratios, not absolutes.
    const expectedFullFillPnl = simulatedTrade?.expectedRealizedPnlUsdc ?? 0;
    const FILL_RATIO = 0.4;
    const MISS_RATIO = 1 - FILL_RATIO;

    expect(report.totalSimulatedTradeCount).toBe(1);
    expect(report.totalSimulatedRealizedPnlUsdc).toBeCloseTo(expectedFullFillPnl * FILL_RATIO, 6);
    expect(simulatedTrade?.status).toBe("partial_filled");
    expect(simulatedTrade?.realizedPnlUsdc).toBeCloseTo(expectedFullFillPnl * FILL_RATIO, 6);
    expect(simulatedTrade?.simulatedFillLatencyMs).toBe(1200);
    expect(simulatedTrade?.simulatedFillRatio).toBeCloseTo(FILL_RATIO, 8);
    expect(simulatedTrade?.missedExpectedRealizedPnlUsdc).toBeCloseTo(
      expectedFullFillPnl * MISS_RATIO, 6
    );
    expect(paperTrade?.status).toBe("partial_filled");
    expect(paperTrade?.reason).toBe("partial_fill_simulation");
    expect(paperTrade?.simulatedFillLatencyMs).toBe(1200);
    expect(paperTrade?.simulatedFillRatio).toBeCloseTo(FILL_RATIO, 8);
    expect(paperTrade?.realizedPnlUsdc).toBeCloseTo(expectedFullFillPnl * FILL_RATIO, 6);
    expect(paperTrade?.missedExpectedRealizedPnlUsdc).toBeCloseTo(
      expectedFullFillPnl * MISS_RATIO, 6
    );
  });
});
