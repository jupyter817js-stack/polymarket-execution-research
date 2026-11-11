import { describe, expect, it } from "vitest";

import { MarketCompetitionMonitor } from "../src/core/market-competition-monitor.js";

describe("MarketCompetitionMonitor — fill-share ratio", () => {
  it("returns fillShareRatio when both my fills and total market fills are available", () => {
    const monitor = new MarketCompetitionMonitor(
      () => undefined,
      () => ({ myShares: 30, totalShares: 100 })
    );
    // Seed reward data so getSnapshot doesn't return undefined
    monitor.updateRewardData("condition-1", "test-market", 10, 0.8, Date.now());

    const snapshot = monitor.getSnapshot("condition-1");
    expect(snapshot).not.toBeUndefined();
    expect(snapshot?.fillShareRatio).toBeCloseTo(0.3, 5);
    expect(snapshot?.myFillShares).toBe(30);
    expect(snapshot?.totalMarketFills).toBe(100);
  });

  it("returns fillShareRatio undefined when total market fills are zero", () => {
    const monitor = new MarketCompetitionMonitor(
      () => undefined,
      () => ({ myShares: 0, totalShares: 0 })
    );
    monitor.updateRewardData("condition-1", "test-market", 5, 0.5, Date.now());

    const snapshot = monitor.getSnapshot("condition-1");
    expect(snapshot?.fillShareRatio).toBeUndefined();
  });

  it("returns a snapshot based solely on fill-share when no reward data exists", () => {
    const monitor = new MarketCompetitionMonitor(
      () => undefined,
      () => ({ myShares: 10, totalShares: 200 })
    );

    // No updateRewardData called — snapshot should still be returned because fill data exists
    const snapshot = monitor.getSnapshot("condition-1");
    expect(snapshot).not.toBeUndefined();
    expect(snapshot?.fillShareRatio).toBeCloseTo(0.05, 5);
  });

  it("getSummaryForLog includes fillShareRatioPct", () => {
    const monitor = new MarketCompetitionMonitor(
      () => 0.2,
      () => ({ myShares: 50, totalShares: 200 })
    );
    monitor.updateRewardData("condition-1", "slug-1", 15, 0.9, Date.now());

    const summary = monitor.getSummaryForLog(["condition-1"]);
    expect(summary[0]?.fillShareRatioPct).toBeCloseTo(25, 1); // 50/200 = 0.25 = 25%
  });

  it("returns undefined snapshot when no signals are available at all", () => {
    const monitor = new MarketCompetitionMonitor(
      () => undefined,
      () => ({ myShares: 0, totalShares: 0 })
    );

    expect(monitor.getSnapshot("condition-unknown")).toBeUndefined();
  });
});
