import { describe, expect, it } from "vitest";

import { buildRealizedTradingSessionReport } from "../src/session-report/realized-report.js";

describe("Realized trading session report", () => {
  it("aggregates realized trades into a live session report", () => {
    const report = buildRealizedTradingSessionReport({
      sessionName: "integrated:realized",
      startedAtMs: 1_700_000_000_000,
      endedAtMs: 1_700_000_010_000,
      finalRiskState: "RUNNING",
      trades: [
        {
          id: "trade-1",
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
          closedAtMs: 1_700_000_001_000,
          tags: ["same-market-arb"]
        },
        {
          id: "trade-2",
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
          closedAtMs: 1_700_000_002_000,
          tags: ["negative-risk"]
        }
      ]
    });

    expect(report.source).toBe("live-runtime");
    expect(report.tradeCount).toBe(2);
    expect(report.winningTrades).toBe(1);
    expect(report.losingTrades).toBe(1);
    expect(report.flatTrades).toBe(0);
    expect(report.totalExpectedEdgeUsdc).toBeCloseTo(0.45, 8);
    expect(report.totalRealizedPnlUsdc).toBeCloseTo(0.1, 8);
    expect(report.realizedVsExpectedDeltaUsdc).toBeCloseTo(-0.35, 8);

    const arbSummary = report.byStrategy.find((summary) => summary.strategy === "same-market-arb");
    const negRiskSummary = report.byStrategy.find((summary) => summary.strategy === "negative-risk");

    expect(arbSummary?.tradeCount).toBe(1);
    expect(arbSummary?.totalExpectedEdgeUsdc).toBeCloseTo(0.3, 8);
    expect(arbSummary?.totalRealizedPnlUsdc).toBeCloseTo(0.2, 8);
    expect(negRiskSummary?.tradeCount).toBe(1);
    expect(negRiskSummary?.totalExpectedEdgeUsdc).toBeCloseTo(0.15, 8);
    expect(negRiskSummary?.totalRealizedPnlUsdc).toBeCloseTo(-0.1, 8);
  });
});
