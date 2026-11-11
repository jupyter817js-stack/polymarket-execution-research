import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InventoryLotTracker } from "../src/core/inventory-lot-tracker.js";
import { InventorySnapshotService } from "../src/core/inventory-snapshot-service.js";

describe("InventorySnapshotService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes open lots to a snapshot file on start and on stop", () => {
    vi.useFakeTimers();

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-inventory-snapshot-"));
    const outputFile = path.join(tempDir, "inventory-lots.json");
    const tracker = new InventoryLotTracker();
    tracker.addLot({
      lotId: "lot-1",
      strategy: "market-making",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 5,
      totalCostUsdc: 2.4,
      openedAtMs: 123
    });

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const service = new InventorySnapshotService({
      tracker,
      logger: logger as never,
      runtime: "integrated",
      outputFile,
      intervalMs: 1_000
    });

    service.start();
    let snapshot = JSON.parse(readFileSync(outputFile, "utf8")) as Array<Record<string, unknown>>;
    expect(snapshot).toEqual([
      expect.objectContaining({
        lotId: "lot-1",
        tokenId: "yes-token",
        shares: 5,
        totalCostUsdc: 2.4
      })
    ]);

    tracker.closeLots({
      tokenId: "yes-token",
      shares: 2,
      proceedsUsdc: 1.1,
      closedAtMs: 200
    });

    vi.advanceTimersByTime(1_200);
    snapshot = JSON.parse(readFileSync(outputFile, "utf8")) as Array<Record<string, unknown>>;
    expect(snapshot[0]).toEqual(
      expect.objectContaining({
        lotId: "lot-1",
        shares: 3,
        totalCostUsdc: 1.44
      })
    );

    tracker.closeLots({
      tokenId: "yes-token",
      shares: 3,
      proceedsUsdc: 1.6,
      closedAtMs: 300
    });
    service.stop();

    snapshot = JSON.parse(readFileSync(outputFile, "utf8")) as Array<Record<string, unknown>>;
    expect(snapshot).toEqual([]);
    expect(logger.info).toHaveBeenCalled();

    rmSync(tempDir, { recursive: true, force: true });
  });
});
