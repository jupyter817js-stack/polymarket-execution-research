import { describe, expect, it, vi } from "vitest";

import { RiskManager } from "../src/core/risk-manager.js";
import type { OrderIntent } from "../src/core/types.js";

const makeIntent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  id: "intent-1",
  strategy: "market-making",
  priority: 200,
  conditionId: "condition-1",
  tokenId: "token-1",
  side: "BUY",
  price: 0.49,
  size: 25,
  tif: "GTC",
  postOnly: true,
  createdAtMs: 1,
  reason: "test",
  tags: [],
  ...overrides
});

describe("RiskManager", () => {
  it("enters degraded mode before halting on repeated order failures", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 3,
        degradeOrderFailures: 2,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false
      }
    });

    manager.noteOrderFailure("market-making.quote-post", "first");
    expect(manager.getState()).toBe("RUNNING");

    manager.noteOrderFailure("market-making.quote-post", "second");
    expect(manager.getState()).toBe("DEGRADED");

    manager.noteOrderFailure("market-making.quote-post", "third");
    const snapshot = manager.getSnapshot();
    expect(snapshot.state).toBe("HALTED");
    expect(snapshot.haltReason).toBe("order_failure_limit_exceeded");
  });

  it("halts when cumulative daily realized loss exceeds the configured cap", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 10,
        degradeDailyLossRatio: 0.5,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 10,
        degradeOrderFailures: 5,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false
      }
    });

    manager.noteTradeClosed(-6, "same-market-arb", "first loss");
    expect(manager.getState()).toBe("DEGRADED");

    manager.noteTradeClosed(-5, "negative-risk", "second loss");
    const snapshot = manager.getSnapshot();
    expect(snapshot.state).toBe("HALTED");
    expect(snapshot.dailyLossUsdc).toBe(11);
    expect(snapshot.haltReason).toBe("daily_loss_limit_exceeded");
  });

  it("does not count tiny dust losses toward consecutive-loss halts", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 10,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 2,
        degradeConsecutiveLosses: 2,
        minLossUsdcForConsecutiveLoss: 0.001,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 10,
        degradeOrderFailures: 5,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false
      }
    });

    manager.noteTradeClosed(-0.008, "market-making", "first inventory close loss");
    expect(manager.getSnapshot().consecutiveLosses).toBe(1);
    expect(manager.getState()).toBe("RUNNING");

    manager.noteTradeClosed(-0.00004, "market-making", "dust inventory close loss");
    const snapshot = manager.getSnapshot();

    expect(snapshot.consecutiveLosses).toBe(1);
    expect(snapshot.dailyLossUsdc).toBeCloseTo(0.00804);
    expect(snapshot.state).toBe("RUNNING");
    expect(snapshot.haltReason).toBeUndefined();
  });

  it("blocks new BUY intents but still allows SELL intents while degraded", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
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

    manager.noteOrderFailure("market-making.quote-post", "first degraded signal");

    const buyDecision = manager.evaluateIntent(makeIntent());
    const sellDecision = manager.evaluateIntent(
      makeIntent({
        id: "intent-2",
        side: "SELL"
      })
    );

    expect(manager.getState()).toBe("DEGRADED");
    expect(buyDecision.allowed).toBe(false);
    expect(buyDecision.reason).toBe("risk_degraded_buy_blocked");
    expect(sellDecision.allowed).toBe(true);
    expect(sellDecision.state).toBe("DEGRADED");
  });

  it("enters WARNING before DEGRADED when warn thresholds are configured", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 5,
        degradeOrderFailures: 3,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false,
        warnOrderFailures: 1,
        warnApiErrors: 0,
        warnConsecutiveLosses: 0,
        warnDailyLossRatio: 0,
        warnStateMismatches: 0,
        recoveryCooldownMs: 0,
        warningMmQuoteSizeMultiplier: 0.9,
        recoveryMmQuoteSizeMultiplier: 0.75
      }
    });

    manager.noteOrderFailure("market-making.quote-post", "first failure");
    expect(manager.getState()).toBe("WARNING");

    // WARNING allows BUY intents
    const buyDecision = manager.evaluateIntent(makeIntent());
    expect(buyDecision.allowed).toBe(true);
    expect(buyDecision.state).toBe("WARNING");

    // Still allows SELL
    const sellDecision = manager.evaluateIntent(makeIntent({ side: "SELL" }));
    expect(sellDecision.allowed).toBe(true);
  });

  it("escalates from WARNING to DEGRADED when degrade threshold is crossed", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 5,
        degradeOrderFailures: 3,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false,
        warnOrderFailures: 1,
        warnApiErrors: 0,
        warnConsecutiveLosses: 0,
        warnDailyLossRatio: 0,
        warnStateMismatches: 0,
        recoveryCooldownMs: 0,
        warningMmQuoteSizeMultiplier: 0.9,
        recoveryMmQuoteSizeMultiplier: 0.75
      }
    });

    manager.noteOrderFailure("market-making", "warn trigger");
    expect(manager.getState()).toBe("WARNING");

    manager.noteOrderFailure("market-making", "degrade #2");
    manager.noteOrderFailure("market-making", "degrade #3");
    expect(manager.getState()).toBe("DEGRADED");
  });

  it("enters RECOVERY after DEGRADED clears when recoveryCooldownMs > 0", () => {
    let now = 1_000_000;
    const manager = new RiskManager(undefined, {
      now: () => now,
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 3,
        degradeOrderFailures: 1,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: true,
        warnOrderFailures: 0,
        warnApiErrors: 0,
        warnConsecutiveLosses: 0,
        warnDailyLossRatio: 0,
        warnStateMismatches: 0,
        recoveryCooldownMs: 5_000,
        warningMmQuoteSizeMultiplier: 0.9,
        recoveryMmQuoteSizeMultiplier: 0.75
      }
    });

    // Trigger DEGRADED
    manager.noteOrderFailure("market-making", "trigger degrade");
    expect(manager.getState()).toBe("DEGRADED");

    // Advance to new day — counters reset, DEGRADED clears → should enter RECOVERY
    now += 24 * 60 * 60 * 1000;
    manager.getSnapshot(); // triggers rollDayIfNeeded
    expect(manager.getState()).toBe("RECOVERY");

    const snapshot = manager.getSnapshot();
    expect(snapshot.recoveryUntilMs).toBeDefined();

    // RECOVERY blocks new BUY intents
    const buyDecision = manager.evaluateIntent(makeIntent());
    expect(buyDecision.allowed).toBe(false);
    expect(buyDecision.reason).toBe("risk_recovery_buy_blocked");

    // RECOVERY allows risk-reduction BUY
    const riskReductionBuy = manager.evaluateIntent(
      makeIntent({ strategy: "risk-reduction", side: "BUY" })
    );
    expect(riskReductionBuy.allowed).toBe(true);

    // RECOVERY allows SELL
    const sellDecision = manager.evaluateIntent(makeIntent({ side: "SELL" }));
    expect(sellDecision.allowed).toBe(true);

    // After cooldown, state returns to RUNNING
    now += 6_000; // past the 5s cooldown
    manager.noteStateMismatch("test", "trigger recompute");
    expect(manager.getState()).toBe("RUNNING");
  });

  it("returns to DEGRADED from RECOVERY if counters climb back up", () => {
    let now = 1_000_000;
    const manager = new RiskManager(undefined, {
      now: () => now,
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 3,
        degradeOrderFailures: 2,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: true,
        warnOrderFailures: 0,
        warnApiErrors: 0,
        warnConsecutiveLosses: 0,
        warnDailyLossRatio: 0,
        warnStateMismatches: 0,
        recoveryCooldownMs: 30_000,
        warningMmQuoteSizeMultiplier: 0.9,
        recoveryMmQuoteSizeMultiplier: 0.75
      }
    });

    manager.noteOrderFailure("mm", "1");
    manager.noteOrderFailure("mm", "2");
    expect(manager.getState()).toBe("DEGRADED");

    // New day resets counters → RECOVERY
    now += 24 * 60 * 60 * 1000;
    manager.getSnapshot();
    expect(manager.getState()).toBe("RECOVERY");

    // New failure re-enters DEGRADED and clears recovery state
    manager.noteOrderFailure("mm", "back to degrade");
    manager.noteOrderFailure("mm", "back to degrade 2");
    expect(manager.getState()).toBe("DEGRADED");
    expect(manager.getSnapshot().recoveryUntilMs).toBeUndefined();
  });

  it("HALTED state does not enter RECOVERY", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0.8,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 2,
        degradeOrderFailures: 1,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false,
        warnOrderFailures: 0,
        warnApiErrors: 0,
        warnConsecutiveLosses: 0,
        warnDailyLossRatio: 0,
        warnStateMismatches: 0,
        recoveryCooldownMs: 30_000,
        warningMmQuoteSizeMultiplier: 0.9,
        recoveryMmQuoteSizeMultiplier: 0.75
      }
    });

    manager.noteOrderFailure("mm", "1");
    expect(manager.getState()).toBe("DEGRADED");
    manager.noteOrderFailure("mm", "2");
    expect(manager.getState()).toBe("HALTED");

    // Further events must not leave HALTED
    manager.noteTradeClosed(5, "mm", "winning trade");
    expect(manager.getState()).toBe("HALTED");
    expect(manager.getSnapshot().recoveryUntilMs).toBeUndefined();
  });

  it("resets daily pnl pressure on a new day while preserving session counters and entering recovery", () => {
    let now = new Date(2026, 2, 29, 12, 0, 0).getTime();
    const manager = new RiskManager(undefined, {
      now: () => now,
      thresholds: {
        maxDailyLossUsdc: 10,
        degradeDailyLossRatio: 0.5,
        maxConsecutiveLosses: 10,
        degradeConsecutiveLosses: 5,
        maxApiErrors: 10,
        degradeApiErrors: 5,
        maxOrderFailures: 10,
        degradeOrderFailures: 5,
        maxStateMismatches: 10,
        degradeStateMismatches: 5,
        resetSessionOnNewDay: false
      }
    });

    manager.noteTradeClosed(-6, "same-market-arb", "loss on day one");
    expect(manager.getSnapshot().state).toBe("DEGRADED");

    now = new Date(2026, 2, 30, 0, 1, 0).getTime();

    const snapshot = manager.getSnapshot();
    expect(snapshot.dayKey).toBe("2026-03-30");
    expect(snapshot.state).toBe("RECOVERY");
    expect(snapshot.dailyLossUsdc).toBe(0);
    expect(snapshot.consecutiveLosses).toBe(1);
    expect(snapshot.recoveryUntilMs).toBeGreaterThan(now);
  });

  it("restoreRecoveryState enters RECOVERY and notifies subscribers", () => {
    const listener = vi.fn();
    const manager = new RiskManager(undefined);
    manager.subscribe(listener);

    const recoveryUntilMs = Date.now() + 30_000;
    manager.restoreRecoveryState(recoveryUntilMs);

    expect(manager.getState()).toBe("RECOVERY");
    expect(manager.getSnapshot().recoveryUntilMs).toBe(recoveryUntilMs);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ state: "RECOVERY" });
  });

  it("restoreRecoveryState is a no-op when the timestamp is already expired", () => {
    const listener = vi.fn();
    const manager = new RiskManager(undefined);
    manager.subscribe(listener);

    manager.restoreRecoveryState(Date.now() - 1_000);

    expect(manager.getState()).toBe("RUNNING");
    expect(listener).not.toHaveBeenCalled();
  });

  it("restoreRecoveryState is overridden by a HALTED threshold", () => {
    const manager = new RiskManager(undefined, {
      thresholds: {
        maxDailyLossUsdc: 100,
        degradeDailyLossRatio: 0,
        maxConsecutiveLosses: 0,
        degradeConsecutiveLosses: 0,
        maxApiErrors: 0,
        degradeApiErrors: 0,
        maxOrderFailures: 1,
        degradeOrderFailures: 0,
        maxStateMismatches: 0,
        degradeStateMismatches: 0,
        resetSessionOnNewDay: false
      }
    });

    manager.restoreRecoveryState(Date.now() + 60_000);
    expect(manager.getState()).toBe("RECOVERY");

    manager.noteOrderFailure("test-trigger", "force halt");
    expect(manager.getState()).toBe("HALTED");
  });
});
