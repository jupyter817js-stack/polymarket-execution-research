import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildRiskExecutionThrottleSnapshot } from "../src/core/degraded-execution-policy.js";
import type { RiskStatusSnapshot } from "../src/core/types.js";

const makeSnapshot = (
  overrides: Partial<RiskStatusSnapshot> = {}
): RiskStatusSnapshot => ({
  state: "RUNNING",
  dayKey: "2026-04-06",
  dailyRealizedPnlUsdc: 0,
  dailyLossUsdc: 0,
  consecutiveLosses: 0,
  apiErrors: 0,
  orderFailures: 0,
  stateMismatches: 0,
  lastEventAtMs: Date.now(),
  ...overrides
});

describe("buildRiskExecutionThrottleSnapshot", () => {
  it("returns neutral multipliers while risk is running", () => {
    const snapshot = buildRiskExecutionThrottleSnapshot(makeSnapshot());

    expect(snapshot).toEqual(
      expect.objectContaining({
        state: "RUNNING",
        dominantReason: "none",
        quoteSizeMultiplier: 1,
        quoteHalfSpreadTicksMultiplier: 1,
        signalCooldownMultiplier: 1,
        executionCooldownMultiplier: 1
      })
    );
  });

  it("shrinks MM quotes and widens spreads when loss stress dominates", () => {
    const dailyLossUsdc = Math.max(
      config.risk.maxDailyLossUsdc * config.risk.degradeDailyLossRatio + 1,
      1
    );
    const snapshot = buildRiskExecutionThrottleSnapshot(
      makeSnapshot({
        state: "DEGRADED",
        dailyRealizedPnlUsdc: -dailyLossUsdc,
        dailyLossUsdc,
        consecutiveLosses: Math.max(config.risk.degradeConsecutiveLosses, 1)
      })
    );

    expect(["daily_loss", "consecutive_losses"]).toContain(snapshot.dominantReason);
    expect(snapshot.quoteSizeMultiplier).toBeLessThan(1);
    expect(snapshot.quoteHalfSpreadTicksMultiplier).toBeGreaterThan(1);
    expect(snapshot.signalCooldownMultiplier).toBeGreaterThan(1);
    expect(snapshot.executionCooldownMultiplier).toBeGreaterThan(1);
  });

  it("extends cooldowns more aggressively when operational risk dominates", () => {
    const apiErrors = Math.max(config.risk.degradeApiErrors + 1, config.risk.maxApiErrors - 1);
    const orderFailures = Math.max(0, config.risk.degradeOrderFailures - 1);
    const stateMismatches = Math.max(0, config.risk.degradeStateMismatches - 1);
    const snapshot = buildRiskExecutionThrottleSnapshot(
      makeSnapshot({
        state: "DEGRADED",
        apiErrors,
        orderFailures,
        stateMismatches
      })
    );

    expect(snapshot.dominantReason).toBe("api_errors");
    expect(snapshot.signalCooldownMultiplier).toBeGreaterThan(1);
    expect(snapshot.executionCooldownMultiplier).toBeGreaterThanOrEqual(
      snapshot.signalCooldownMultiplier
    );
    expect(snapshot.quoteSizeMultiplier).toBeLessThan(1);
  });
});
