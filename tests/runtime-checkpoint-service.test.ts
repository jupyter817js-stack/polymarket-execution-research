import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionEngine } from "../src/core/execution-engine.js";
import { InventoryLotTracker } from "../src/core/inventory-lot-tracker.js";
import { PnLEngine } from "../src/core/pnl-engine.js";
import { RiskManager } from "../src/core/risk-manager.js";
import { RuntimeCheckpointService } from "../src/core/runtime-checkpoint-service.js";

describe("RuntimeCheckpointService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a recovery checkpoint with monitoring state and open lots", () => {
    vi.useFakeTimers();

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-runtime-checkpoint-"));
    const outputFile = path.join(tempDir, "runtime-checkpoint.json");
    const now = new Date(2026, 2, 31, 9, 0, 0).getTime();
    const executionEngine = new ExecutionEngine();
    const pnlEngine = new PnLEngine(undefined, {
      now: () => now
    });
    const riskManager = new RiskManager(undefined, {
      now: () => now,
      thresholds: {
        maxDailyLossUsdc: 10,
        degradeDailyLossRatio: 0.5,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 1,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 10,
        degradeOrderFailures: 1,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        blockNewBuyIntentsOnDegraded: true,
        cancelMmBuyQuotesOnDegraded: true,
        enableMmInventoryReductionOnHalt: true,
        resetSessionOnNewDay: false
      }
    });
    const inventoryTracker = new InventoryLotTracker();
    inventoryTracker.addLot({
      lotId: "carry-over-1",
      strategy: "same-market-arb",
      tokenId: "yes-token",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      outcome: "Yes",
      shares: 4,
      totalCostUsdc: 1.8,
      openedAtMs: now - 5_000
    });
    executionEngine.upsertActiveOrder({
      orderId: "order-1",
      strategy: "market-making",
      priority: 200,
      conditionId: "condition-1",
      tokenId: "yes-token",
      side: "BUY",
      price: 0.48,
      size: 25,
      tif: "GTC",
      postOnly: true,
      openedAtMs: now,
      intentId: "intent-1"
    });
    pnlEngine.recordTrade({
      id: "trade-1",
      strategy: "negative-risk",
      marketScope: "sample-event",
      realizedPnlUsdc: 0.75,
      closedAtMs: now,
      tags: ["negative-risk", "fully-filled"]
    });
    riskManager.noteOrderFailure("negative-risk", "temporary issue");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const service = new RuntimeCheckpointService({
      executionEngine,
      pnlEngine,
      riskManager,
      inventoryTracker,
      logger: logger as never,
      runtime: "integrated",
      outputFile,
      intervalMs: 1_000
    });

    service.start();
    const payload = JSON.parse(readFileSync(outputFile, "utf8")) as Record<string, unknown>;

    expect(payload).toEqual(
      expect.objectContaining({
        checkpointType: "runtime_checkpoint",
        schemaVersion: 1,
        runtime: "integrated",
        reason: "startup"
      })
    );
    expect(payload.monitoringSnapshot).toEqual(
      expect.objectContaining({
        summaryType: "monitoring_snapshot",
        runtime: "integrated",
        risk: expect.objectContaining({
          state: "DEGRADED",
          orderFailures: 1
        }),
        riskBudgetAdjustment: expect.objectContaining({
          state: "DEGRADED",
          sharedBuyBudgetMultiplier: 0.6
        }),
        executionThrottle: expect.objectContaining({
          state: "DEGRADED",
          signalCooldownMultiplier: expect.any(Number),
          executionCooldownMultiplier: expect.any(Number)
        }),
        portfolio: expect.objectContaining({
          dailyRealizedPnlUsdc: 0.75
        })
      })
    );
    expect(payload.inventory).toEqual(
      expect.objectContaining({
        openLotCount: 1,
        openShares: 4,
        openCostUsdc: 1.8,
        openLots: [
          expect.objectContaining({
            lotId: "carry-over-1",
            tokenId: "yes-token",
            shares: 4,
            totalCostUsdc: 1.8
          })
        ]
      })
    );

    service.stop();
    expect(logger.info).toHaveBeenCalled();

    rmSync(tempDir, { recursive: true, force: true });
  });
});
