import { describe, expect, it } from "vitest";

import { comparePaperAndRealizedSessions } from "../src/session-report/paper-live-comparison.js";

describe("Paper vs live comparison", () => {
  it("compares paper confidence buckets against realized live trades", () => {
    const comparison = comparePaperAndRealizedSessions({
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
        averageRealizedFillLatencyMs: 0,
        averageObservedVenueLatencyMs: 510,
        averageObservedBookSkewMs: 45,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 1,
        lowConfidenceTradeCount: 0,
        finalRiskState: "RUNNING",
        byStrategy: [],
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
        finalRiskState: "RUNNING",
        tradeCount: 2,
        winningTrades: 1,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.45,
        totalRealizedPnlUsdc: 0.1,
        realizedVsExpectedDeltaUsdc: -0.35,
        byStrategy: [],
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
      }
    });

    expect(comparison.matchedKeyCount).toBe(2);
    expect(comparison.unmatchedPaperTradeCount).toBe(0);
    expect(comparison.unmatchedLiveTradeCount).toBe(0);

    const highBucket = comparison.byConfidence.find((bucket) => bucket.label === "high");
    const mediumBucket = comparison.byConfidence.find((bucket) => bucket.label === "medium");
    const fastLatencyBucket = comparison.byObservedLatency.find((bucket) => bucket.label === "fast");
    const moderateLatencyBucket = comparison.byObservedLatency.find(
      (bucket) => bucket.label === "moderate"
    );

    expect(highBucket?.paperTradeCount).toBe(1);
    expect(highBucket?.matchedLiveTradeCount).toBe(1);
    expect(highBucket?.matchedLiveRealizedPnlUsdc).toBeCloseTo(0.2, 8);
    expect(highBucket?.liveVsPaperDeltaUsdc).toBeCloseTo(-0.1, 8);
    expect(mediumBucket?.paperTradeCount).toBe(1);
    expect(mediumBucket?.matchedLiveTradeCount).toBe(1);
    expect(mediumBucket?.matchedLiveRealizedPnlUsdc).toBeCloseTo(-0.1, 8);
    expect(mediumBucket?.liveVsPaperDeltaUsdc).toBeCloseTo(-0.3, 8);
    expect(fastLatencyBucket?.paperTradeCount).toBe(1);
    expect(fastLatencyBucket?.averageObservedVenueLatencyMs).toBeCloseTo(120, 8);
    expect(fastLatencyBucket?.liveVsPaperDeltaUsdc).toBeCloseTo(-0.1, 8);
    expect(moderateLatencyBucket?.paperTradeCount).toBe(1);
    expect(moderateLatencyBucket?.averageObservedVenueLatencyMs).toBeCloseTo(900, 8);
    expect(moderateLatencyBucket?.averageObservedBookSkewMs).toBeCloseTo(70, 8);

    const arbStrategy = comparison.byStrategy.find(
      (strategy) => strategy.strategy === "same-market-arb"
    );
    const arbMatch = comparison.matches.find((match) => match.strategy === "same-market-arb");
    expect(arbStrategy?.matchedLiveRealizedPnlUsdc).toBeCloseTo(0.2, 8);
    expect(arbMatch?.paperObservedLatencyBucket).toBe("fast");
    expect(arbMatch?.paperAverageObservedVenueLatencyMs).toBeCloseTo(120, 8);
  });
});
