import { describe, expect, it, vi, afterEach } from "vitest";

import { config } from "../src/config.js";
import { ExecutionEngine } from "../src/core/execution-engine.js";
import { MonitoringService } from "../src/core/monitoring-service.js";
import { PnLEngine } from "../src/core/pnl-engine.js";
import { RiskManager } from "../src/core/risk-manager.js";

describe("MonitoringService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits portfolio, risk, and active-order snapshots to the logger", () => {
    const now = new Date(2026, 2, 29, 12, 0, 0).getTime();
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
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 10,
        degradeOrderFailures: 1,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false
      }
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    executionEngine.upsertActiveOrder({
      orderId: "order-1",
      strategy: "market-making",
      priority: 200,
      conditionId: "condition-a",
      tokenId: "token-a",
      side: "BUY",
      price: 0.49,
      size: 25,
      tif: "GTC",
      postOnly: true,
      openedAtMs: now,
      intentId: "intent-1"
    });
    pnlEngine.recordTrade({
      id: "trade-1",
      strategy: "same-market-arb",
      marketScope: "market-a",
      conditionId: "condition-a",
      realizedPnlUsdc: 1.25,
      shares: 5,
      closedAtMs: now,
      tags: ["same-market-arb", "fully-filled"]
    });
    riskManager.noteOrderFailure("same-market-arb", "temporary failure");

    const service = new MonitoringService({
      executionEngine,
      pnlEngine,
      riskManager,
      logger: logger as never,
      runtime: "integrated",
      intervalMs: 60_000
    });

    service.emitSnapshot();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryType: "monitoring_snapshot",
        schemaVersion: 1,
        runtime: "integrated",
        monitoringIntervalMs: 60_000,
        risk: expect.objectContaining({
          state: "DEGRADED",
          orderFailures: 1
        }),
        riskBudgetAdjustment: expect.objectContaining({
          state: "DEGRADED",
          stressScore: 0,
          sharedBuyBudgetMultiplier: 0.6,
          strategyBuyBudgetMultipliers: expect.objectContaining({
            "market-making": 0.3,
            "same-market-arb": 0.48,
            "negative-risk": 0.42
          })
        }),
        executionThrottle: expect.objectContaining({
          state: "DEGRADED",
          dominantReason: "none",
          quoteSizeMultiplier: expect.any(Number),
          quoteHalfSpreadTicksMultiplier: expect.any(Number),
          signalCooldownMultiplier: expect.any(Number),
          executionCooldownMultiplier: expect.any(Number)
        }),
        kpis: expect.objectContaining({
          tradeCount: 1,
          averageTradeExpectedEdgeUsdc: 0,
          averageTradeNetPnlUsdc: 1.25,
          dailyRoiPct: Number(
            ((1.25 / config.capital.totalActiveBuyBudgetUsdc) * 100).toFixed(8)
          )
        }),
        portfolio: expect.objectContaining({
          dayKey: "2026-03-29",
          dailyRealizedPnlUsdc: 1.25,
          lifetimeTradeCount: 1
        }),
        activeOrders: {
          total: 1,
          activeConditions: 1,
          byStrategy: {
            "market-making": 1
          }
        },
        recentTrade: expect.objectContaining({
          id: "trade-1",
          strategy: "same-market-arb",
          realizedPnlUsdc: 1.25
        }),
        strategies: [
          expect.objectContaining({
            strategy: "same-market-arb",
            dailyRealizedPnlUsdc: 1.25,
            lifetimeTradeCount: 1
          })
        ]
      }),
      "Monitoring snapshot updated."
    );
  });

  it("emits immediately on start and stops periodic snapshots after stop", () => {
    vi.useFakeTimers();

    const now = new Date(2026, 2, 29, 12, 0, 0).getTime();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const service = new MonitoringService({
      executionEngine: new ExecutionEngine(),
      pnlEngine: new PnLEngine(undefined, {
        now: () => now
      }),
      riskManager: new RiskManager(undefined, {
        now: () => now
      }),
      logger: logger as never,
      runtime: "integrated",
      intervalMs: 1_000
    });

    service.start();
    expect(logger.info).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_500);
    expect(logger.info).toHaveBeenCalledTimes(3);

    service.stop();
    vi.advanceTimersByTime(2_000);
    expect(logger.info).toHaveBeenCalledTimes(3);
  });
});
