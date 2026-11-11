import { describe, expect, it } from "vitest";

import { buildPaperTradingReportFromSimulation } from "../src/paper-trading/report.js";
import {
  parseSimulationScenario,
  runSimulationScenario
} from "../src/simulation/harness.js";

describe("Paper trading report", () => {
  it("builds a filled session summary from the simulation harness report", () => {
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

    const simulationReport = runSimulationScenario(scenario);
    const paperReport = buildPaperTradingReportFromSimulation(simulationReport);
    const expectedPnl = paperReport.trades[0]?.expectedRealizedPnlUsdc ?? 0;

    expect(paperReport.sessionName).toBe("mm-vs-arb:paper");
    expect(paperReport.source).toBe("simulation");
    expect(paperReport.expectedTradeCount).toBe(1);
    expect(paperReport.filledTradeCount).toBe(1);
    expect(paperReport.partialFilledTradeCount).toBe(0);
    expect(paperReport.missedTradeCount).toBe(0);
    expect(paperReport.fillRate).toBe(1);
    expect(paperReport.totalExpectedRealizedPnlUsdc).toBeCloseTo(expectedPnl, 6);
    expect(paperReport.totalRealizedPnlUsdc).toBeCloseTo(expectedPnl, 6);
    expect(paperReport.expectedVsRealizedDeltaUsdc).toBeCloseTo(0, 8);
    expect(paperReport.averageRealizedFillLatencyMs).toBe(0);
    expect(paperReport.highConfidenceTradeCount).toBe(1);
    expect(paperReport.mediumConfidenceTradeCount).toBe(0);
    expect(paperReport.lowConfidenceTradeCount).toBe(0);
    expect(paperReport.finalRiskState).toBe("RUNNING");
    expect(paperReport.trades).toHaveLength(1);
    expect(paperReport.trades[0]?.status).toBe("filled");
    expect(paperReport.trades[0]?.expectedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(paperReport.trades[0]?.realizedPnlUsdc).toBeCloseTo(expectedPnl, 6);
    expect(paperReport.trades[0]?.fillConfidence).toBe("high");
    expect(paperReport.trades[0]?.depthCoverageRatio).toBeGreaterThan(1);

    const arbSummary = paperReport.byStrategy.find(
      (summary) => summary.strategy === "same-market-arb"
    );

    expect(arbSummary?.expectedTradeCount).toBe(1);
    expect(arbSummary?.filledTradeCount).toBe(1);
    expect(arbSummary?.partialFilledTradeCount).toBe(0);
    expect(arbSummary?.fillRate).toBe(1);
    expect(arbSummary?.totalRealizedPnlUsdc).toBeCloseTo(expectedPnl, 6);
    expect(arbSummary?.highConfidenceTradeCount).toBe(1);
  });

  it("marks blocked opportunities as missed trades in the paper report", () => {
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

    const simulationReport = runSimulationScenario(scenario);
    const paperReport = buildPaperTradingReportFromSimulation(simulationReport);
    const expectedPnl = paperReport.trades[0]?.expectedRealizedPnlUsdc ?? 0;

    expect(paperReport.expectedTradeCount).toBe(1);
    expect(paperReport.filledTradeCount).toBe(0);
    expect(paperReport.partialFilledTradeCount).toBe(0);
    expect(paperReport.missedTradeCount).toBe(1);
    expect(paperReport.fillRate).toBe(0);
    expect(paperReport.totalExpectedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(paperReport.totalRealizedPnlUsdc).toBeCloseTo(0, 8);
    expect(paperReport.expectedVsRealizedDeltaUsdc).toBeCloseTo(-expectedPnl, 6);
    expect(paperReport.highConfidenceTradeCount).toBe(1);
    expect(paperReport.finalRiskState).toBe("DEGRADED");
    expect(paperReport.trades).toHaveLength(1);
    expect(paperReport.trades[0]?.status).toBe("not_filled");
    expect(paperReport.trades[0]?.reason).toBe("risk_blocked");
    expect(paperReport.trades[0]?.fillConfidence).toBe("high");
    expect(paperReport.trades[0]?.depthCoverageRatio).toBeGreaterThan(1);

    const arbSummary = paperReport.byStrategy.find(
      (summary) => summary.strategy === "same-market-arb"
    );

    expect(arbSummary?.missedTradeCount).toBe(1);
    expect(arbSummary?.totalExpectedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(arbSummary?.totalRealizedPnlUsdc).toBeCloseTo(0, 8);
    expect(arbSummary?.highConfidenceTradeCount).toBe(1);
  });

  it("surfaces partial fills and simulated latency in the paper session summary", () => {
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

    const simulationReport = runSimulationScenario(scenario);
    const paperReport = buildPaperTradingReportFromSimulation(simulationReport);
    const arbSummary = paperReport.byStrategy.find(
      (summary) => summary.strategy === "same-market-arb"
    );
    const expectedPnl = paperReport.trades[0]?.expectedRealizedPnlUsdc ?? 0;
    const FILL_RATIO = 0.4;
    const MISS_RATIO = 1 - FILL_RATIO;

    expect(paperReport.expectedTradeCount).toBe(1);
    expect(paperReport.filledTradeCount).toBe(1);
    expect(paperReport.partialFilledTradeCount).toBe(1);
    expect(paperReport.missedTradeCount).toBe(0);
    expect(paperReport.fillRate).toBe(1);
    expect(paperReport.totalExpectedRealizedPnlUsdc).toBeGreaterThan(0);
    expect(paperReport.totalRealizedPnlUsdc).toBeCloseTo(expectedPnl * FILL_RATIO, 6);
    expect(paperReport.expectedVsRealizedDeltaUsdc).toBeCloseTo(-expectedPnl * MISS_RATIO, 6);
    expect(paperReport.averageRealizedFillLatencyMs).toBe(1200);
    expect(paperReport.trades[0]?.status).toBe("partial_filled");
    expect(paperReport.trades[0]?.simulatedFillRatio).toBeCloseTo(0.4, 8);
    expect(paperReport.trades[0]?.missedExpectedRealizedPnlUsdc).toBeCloseTo(expectedPnl * MISS_RATIO, 6);
    expect(arbSummary?.filledTradeCount).toBe(1);
    expect(arbSummary?.partialFilledTradeCount).toBe(1);
    expect(arbSummary?.averageRealizedFillLatencyMs).toBe(1200);
  });
});
