import { describe, expect, it } from "vitest";

import { InventoryLotTracker } from "../src/core/inventory-lot-tracker.js";

describe("InventoryLotTracker", () => {
  it("realizes pnl from tracked lots using fifo consumption", () => {
    const tracker = new InventoryLotTracker();

    tracker.addLot({
      lotId: "lot-1",
      strategy: "market-making",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 4,
      totalCostUsdc: 1.6,
      openedAtMs: 1
    });
    tracker.addLot({
      lotId: "lot-2",
      strategy: "market-making",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 2,
      totalCostUsdc: 1.2,
      openedAtMs: 2
    });

    const result = tracker.closeLots({
      tokenId: "yes-token",
      shares: 5,
      proceedsUsdc: 3.5,
      closedAtMs: 10
    });

    expect(result.closedKnownShares).toBeCloseTo(5, 8);
    expect(result.closedUnknownShares).toBe(0);
    expect(result.recognizedCostBasisUsdc).toBeCloseTo(2.2, 8);
    expect(result.recognizedProceedsUsdc).toBeCloseTo(3.5, 8);
    expect(result.pieces[0]).toEqual(
      expect.objectContaining({
        lotId: "lot-1",
        shares: 4,
        costBasisUsdc: 1.6
      })
    );
    expect(result.pieces[0]?.proceedsUsdc).toBeCloseTo(2.8, 8);
    expect(result.pieces[0]?.realizedPnlUsdc).toBeCloseTo(1.2, 8);
    expect(result.pieces[1]).toEqual(
      expect.objectContaining({
        lotId: "lot-2",
        shares: 1,
        costBasisUsdc: 0.6
      })
    );
    expect(result.pieces[1]?.proceedsUsdc).toBeCloseTo(0.7, 8);
    expect(result.pieces[1]?.realizedPnlUsdc).toBeCloseTo(0.1, 8);
    expect(tracker.getOpenShares("yes-token")).toBeCloseTo(1, 8);
  });

  it("tracks unknown shares when more inventory is sold than the tracker knows about", () => {
    const tracker = new InventoryLotTracker();

    tracker.addLot({
      lotId: "lot-1",
      strategy: "same-market-arb",
      tokenId: "no-token",
      marketScope: "event-a",
      conditionId: "condition-2",
      outcome: "No",
      shares: 2,
      totalCostUsdc: 0.8,
      openedAtMs: 1
    });

    const result = tracker.closeLots({
      tokenId: "no-token",
      shares: 3,
      proceedsUsdc: 1.5,
      closedAtMs: 20
    });

    expect(result.closedKnownShares).toBeCloseTo(2, 8);
    expect(result.closedUnknownShares).toBeCloseTo(1, 8);
    expect(result.recognizedCostBasisUsdc).toBeCloseTo(0.8, 8);
    expect(result.recognizedProceedsUsdc).toBeCloseTo(1, 8);
    expect(result.unrecognizedProceedsUsdc).toBeCloseTo(0.5, 8);
    expect(tracker.getOpenLotCount("no-token")).toBe(0);
  });

  it("exports the remaining open lots in seed-compatible order", () => {
    const tracker = new InventoryLotTracker();

    tracker.addLot({
      lotId: "lot-b",
      strategy: "negative-risk",
      tokenId: "token-b",
      marketScope: "event-b",
      shares: 1,
      totalCostUsdc: 0.42,
      openedAtMs: 20
    });
    tracker.addLot({
      lotId: "lot-a",
      strategy: "market-making",
      tokenId: "token-a",
      marketScope: "event-a",
      shares: 2,
      totalCostUsdc: 0.8,
      openedAtMs: 10
    });

    tracker.closeLots({
      tokenId: "token-a",
      shares: 0.5,
      proceedsUsdc: 0.3,
      closedAtMs: 30
    });

    const snapshot = tracker.exportOpenLots();

    expect(snapshot[0]).toEqual(
      expect.objectContaining({
        lotId: "lot-a",
        tokenId: "token-a",
        shares: 1.5,
        openedAtMs: 10
      })
    );
    expect(snapshot[0]?.totalCostUsdc).toBeCloseTo(0.6, 8);
    expect(snapshot[1]).toEqual(
      expect.objectContaining({
        lotId: "lot-b",
        tokenId: "token-b",
        shares: 1,
        totalCostUsdc: 0.42,
        openedAtMs: 20
      })
    );
  });

  it("adds a venue-sync lot when venue balance exceeds tracked real inventory", () => {
    const tracker = new InventoryLotTracker();

    tracker.addLot({
      lotId: "real-lot",
      strategy: "market-making",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 4,
      totalCostUsdc: 1.2,
      openedAtMs: 1
    });

    const changed = tracker.reconcileVenuePosition({
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      venueBalance: 10,
      estimatedAverageCostUsdcPerShare: 0.4,
      reconciledAtMs: 50
    });

    expect(changed).toBe(true);
    expect(tracker.getOpenShares("yes-token")).toBeCloseTo(10, 8);
    const snapshot = tracker.exportOpenLots();

    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toEqual(
      expect.objectContaining({
        lotId: "real-lot",
        shares: 4
      })
    );
    expect(snapshot[0]?.totalCostUsdc).toBeCloseTo(1.2, 8);
    expect(snapshot[1]).toEqual(
      expect.objectContaining({
        lotId: "venue-sync:yes-token",
        shares: 6
      })
    );
    expect(snapshot[1]?.totalCostUsdc).toBeCloseTo(2.4, 8);
  });

  it("consumes venue-sync shares when a delayed real fill arrives", () => {
    const tracker = new InventoryLotTracker();

    tracker.reconcileVenuePosition({
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      venueBalance: 12,
      estimatedAverageCostUsdcPerShare: 0.39,
      reconciledAtMs: 50
    });

    expect(tracker.consumeVenueSyncShares("yes-token", 5)).toBeCloseTo(5, 8);
    tracker.addLot({
      lotId: "real-fill",
      strategy: "market-making",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 5,
      totalCostUsdc: 0.9,
      openedAtMs: 60
    });

    const snapshot = tracker.exportOpenLots();

    expect(tracker.getOpenShares("yes-token")).toBeCloseTo(12, 8);
    expect(snapshot).toEqual([
      expect.objectContaining({
        lotId: "venue-sync:yes-token",
        shares: 7
      }),
      expect.objectContaining({
        lotId: "real-fill",
        shares: 5,
        totalCostUsdc: 0.9
      })
    ]);
  });
});
