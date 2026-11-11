// Fix N test — InventoryLotTracker.pruneDustLots removes lots below the dust threshold
// without touching healthy lots, and returns the removed lots so callers can attribute
// the foregone cost basis to a realized loss.
import { describe, expect, it } from "vitest";

import { InventoryLotTracker } from "../src/core/inventory-lot-tracker.js";

const seedTracker = (): InventoryLotTracker => {
  const tracker = new InventoryLotTracker();
  tracker.addLot({
    lotId: "lot-healthy",
    strategy: "same-market-arb",
    tokenId: "tok-healthy",
    marketScope: "market-h",
    conditionId: "cond-h",
    outcome: "Yes",
    shares: 5,
    totalCostUsdc: 4.0,
    openedAtMs: 1
  });
  tracker.addLot({
    lotId: "lot-dust",
    strategy: "same-market-arb",
    tokenId: "tok-dust",
    marketScope: "market-d",
    conditionId: "cond-d",
    outcome: "No",
    shares: 0.0066,
    totalCostUsdc: 0.005,
    openedAtMs: 2
  });
  tracker.addLot({
    lotId: "lot-borderline",
    strategy: "same-market-arb",
    tokenId: "tok-border",
    marketScope: "market-b",
    conditionId: "cond-b",
    outcome: "Yes",
    shares: 0.05,
    totalCostUsdc: 0.04,
    openedAtMs: 3
  });
  return tracker;
};

describe("Fix N: pruneDustLots", () => {
  it("removes only lots at or below the threshold and reports them", () => {
    const tracker = seedTracker();
    const removed = tracker.pruneDustLots(0.05);

    // dust (0.0066) and borderline (0.05) both pruned; healthy (5) survives.
    expect(removed.map((l) => l.lotId).sort()).toEqual(
      ["lot-borderline", "lot-dust"]
    );
    const remaining = tracker.exportOpenLots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.lotId).toBe("lot-healthy");
  });

  it("returns an empty list when no lots are below the threshold", () => {
    const tracker = seedTracker();
    const removed = tracker.pruneDustLots(0.001);
    expect(removed).toHaveLength(0);
    expect(tracker.exportOpenLots()).toHaveLength(3);
  });

  it("returns an empty list when threshold is zero or negative (no-op)", () => {
    const tracker = seedTracker();
    expect(tracker.pruneDustLots(0)).toHaveLength(0);
    expect(tracker.pruneDustLots(-1)).toHaveLength(0);
    expect(tracker.exportOpenLots()).toHaveLength(3);
  });

  it("removes the entire tokenId entry when all lots for it are dust", () => {
    const tracker = new InventoryLotTracker();
    tracker.addLot({
      lotId: "dust-1",
      strategy: "same-market-arb",
      tokenId: "tok-x",
      marketScope: "m",
      conditionId: "c",
      outcome: "Yes",
      shares: 0.001,
      totalCostUsdc: 0.001,
      openedAtMs: 1
    });
    tracker.addLot({
      lotId: "dust-2",
      strategy: "same-market-arb",
      tokenId: "tok-x",
      marketScope: "m",
      conditionId: "c",
      outcome: "Yes",
      shares: 0.002,
      totalCostUsdc: 0.002,
      openedAtMs: 2
    });

    const removed = tracker.pruneDustLots(0.05);
    expect(removed).toHaveLength(2);
    expect(tracker.exportOpenLots()).toHaveLength(0);
  });
});
