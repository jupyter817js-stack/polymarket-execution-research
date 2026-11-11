import type { Logger } from "pino";

import { config } from "../config.js";
import type {
  OrderIntent,
  RiskGateDecision,
  RiskManagerLike,
  RiskState,
  RiskStatusSnapshot
} from "./types.js";

export type RiskThresholdConfig = {
  maxDailyLossUsdc: number;
  degradeDailyLossRatio: number;
  maxConsecutiveLosses: number;
  degradeConsecutiveLosses: number;
  minLossUsdcForConsecutiveLoss: number;
  maxApiErrors: number;
  degradeApiErrors: number;
  maxOrderFailures: number;
  degradeOrderFailures: number;
  maxStateMismatches: number;
  degradeStateMismatches: number;
  blockNewBuyIntentsOnDegraded: boolean;
  cancelMmBuyQuotesOnDegraded: boolean;
  enableMmInventoryReductionOnHalt: boolean;
  resetSessionOnNewDay: boolean;
  /** 0 = disabled. Fraction of maxDailyLossUsdc that triggers WARNING (must be < degradeDailyLossRatio). */
  warnDailyLossRatio: number;
  /** 0 = disabled. Consecutive losses before WARNING. */
  warnConsecutiveLosses: number;
  /** 0 = disabled. API errors before WARNING. */
  warnApiErrors: number;
  /** 0 = disabled. Order failures before WARNING. */
  warnOrderFailures: number;
  /** 0 = disabled. State mismatches before WARNING. */
  warnStateMismatches: number;
  /** 0 = disabled. Cooldown (ms) spent in RECOVERY before returning to RUNNING after exiting DEGRADED. */
  recoveryCooldownMs: number;
  /** Quote size multiplier applied while in WARNING state (0–1). */
  warningMmQuoteSizeMultiplier: number;
  /** Quote size multiplier applied while in RECOVERY state (0–1). */
  recoveryMmQuoteSizeMultiplier: number;
};

type RiskEvent =
  | "api_error"
  | "order_failure"
  | "state_mismatch"
  | "trade_closed"
  | "day_rollover"
  | "recovery_check";

type StateComputation = {
  state: RiskState;
  reason?: string;
  detail?: string;
};

type RiskManagerOptions = {
  now?: () => number;
  thresholds?: Partial<RiskThresholdConfig>;
};

const defaultThresholds = (): RiskThresholdConfig => ({
  ...config.risk
});

const formatDayKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

export class RiskManager implements RiskManagerLike {
  private readonly now: () => number;
  private readonly thresholds: RiskThresholdConfig;
  private readonly listeners = new Set<(snapshot: RiskStatusSnapshot) => void>();
  private state: RiskState = "RUNNING";
  private dayKey: string;
  private dailyRealizedPnlUsdc = 0;
  private consecutiveLosses = 0;
  private apiErrors = 0;
  private orderFailures = 0;
  private stateMismatches = 0;
  private lastEventAtMs: number;
  private haltReason: string | undefined;
  private haltDetail: string | undefined;
  private warnReason: string | undefined;
  private recoveryUntilMs: number | undefined;
  private recoveryCheckTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly logger?: Logger,
    options?: RiskManagerOptions
  ) {
    this.now = options?.now ?? (() => Date.now());
    this.thresholds = {
      ...defaultThresholds(),
      ...options?.thresholds
    };
    this.lastEventAtMs = this.now();
    this.dayKey = formatDayKey(this.lastEventAtMs);
  }

  evaluateIntent(intent: OrderIntent): RiskGateDecision {
    void intent;
    this.rollDayIfNeeded();

    if (this.state === "HALTED") {
      return {
        allowed: false,
        state: this.state,
        reason: this.haltReason ?? "risk_halted",
        detail: this.haltDetail ?? "Risk manager is halted."
      };
    }

    // RECOVERY: block new non-risk-reduction BUY intents while cooling down after DEGRADED
    if (
      this.state === "RECOVERY" &&
      intent.side === "BUY" &&
      intent.strategy !== "risk-reduction"
    ) {
      return {
        allowed: false,
        state: this.state,
        reason: "risk_recovery_buy_blocked",
        detail: "Risk manager is in recovery. New BUY intents are paused until the recovery cooldown expires."
      };
    }

    const isDegradedBuyBlocked =
      this.state === "DEGRADED" &&
      this.thresholds.blockNewBuyIntentsOnDegraded &&
      intent.side === "BUY" &&
      intent.strategy !== "risk-reduction";

    return {
      allowed: !isDegradedBuyBlocked,
      state: this.state,
      reason: isDegradedBuyBlocked
        ? "risk_degraded_buy_blocked"
        : this.state === "DEGRADED"
          ? "risk_degraded"
          : this.state === "RECOVERY"
            ? "risk_recovery"
            : this.state === "WARNING"
              ? "risk_warning"
              : undefined,
      detail: isDegradedBuyBlocked
        ? "Risk manager is degraded. New BUY intents are blocked until the session returns to RUNNING state."
        : this.state === "DEGRADED"
          ? "Risk manager is degraded. New intents remain allowed while thresholds are monitored closely."
          : this.state === "RECOVERY"
            ? "Risk manager is in recovery from a degraded episode."
            : this.state === "WARNING"
              ? `Risk manager is in warning state: ${this.warnReason ?? "threshold approaching"}.`
              : undefined
    };
  }

  getState(): RiskState {
    this.rollDayIfNeeded();
    return this.state;
  }

  getSnapshot(): RiskStatusSnapshot {
    this.rollDayIfNeeded();
    return this.buildSnapshot();
  }

  subscribe(listener: (snapshot: RiskStatusSnapshot) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  noteApiError(source: string, detail?: string): RiskGateDecision {
    this.rollDayIfNeeded();
    this.apiErrors += 1;
    return this.applyState("api_error", source, detail);
  }

  noteOrderFailure(source: string, detail?: string): RiskGateDecision {
    this.rollDayIfNeeded();
    this.orderFailures += 1;
    return this.applyState("order_failure", source, detail);
  }

  noteStateMismatch(source: string, detail?: string): RiskGateDecision {
    this.rollDayIfNeeded();
    this.stateMismatches += 1;
    return this.applyState("state_mismatch", source, detail);
  }

  noteTradeClosed(realizedPnlUsdc: number, source: string, detail?: string): RiskGateDecision {
    this.rollDayIfNeeded();
    this.dailyRealizedPnlUsdc += realizedPnlUsdc;
    this.consecutiveLosses = this.computeNextConsecutiveLosses(realizedPnlUsdc);

    return this.applyState(
      "trade_closed",
      source,
      detail ?? `realizedPnlUsdc(${realizedPnlUsdc.toFixed(4)})`
    );
  }

  private rollDayIfNeeded(): void {
    const now = this.now();
    const nextDayKey = formatDayKey(now);

    if (nextDayKey === this.dayKey) {
      return;
    }

    const previousDayKey = this.dayKey;
    this.dayKey = nextDayKey;
    this.dailyRealizedPnlUsdc = 0;

    if (this.thresholds.resetSessionOnNewDay) {
      this.consecutiveLosses = 0;
      this.apiErrors = 0;
      this.orderFailures = 0;
      this.stateMismatches = 0;
    }

    this.applyState(
      "day_rollover",
      "risk-manager",
      `Rolled risk day from ${previousDayKey} to ${nextDayKey}.`
    );
  }

  /**
   * Restores a persisted RECOVERY state on startup. No-op if recoveryUntilMs
   * is in the past. Should be called once during startup before market evaluation
   * begins (e.g. from restoreRiskRecoveryFromCheckpoint).
   */
  restoreRecoveryState(recoveryUntilMs: number, nowMs: number = this.now()): void {
    if (recoveryUntilMs <= nowMs) return;
    this.recoveryUntilMs = recoveryUntilMs;
    this.scheduleRecoveryCheck();
    // Force state re-evaluation and subscriber notification.
    this.applyState(
      "recovery_check",
      "checkpoint-restore",
      `Restored RECOVERY from checkpoint; expires at ${new Date(recoveryUntilMs).toISOString()}.`
    );
  }

  private applyState(event: RiskEvent, source: string, detail?: string): RiskGateDecision {
    const previousState = this.state;
    const previousReason = this.haltReason;
    let next = this.computeState();

    // DEGRADED → non-DEGRADED, non-HALTED: enter RECOVERY cooldown
    if (
      previousState === "DEGRADED" &&
      next.state !== "DEGRADED" &&
      next.state !== "HALTED" &&
      this.thresholds.recoveryCooldownMs > 0
    ) {
      this.recoveryUntilMs = this.now() + this.thresholds.recoveryCooldownMs;
      next = {
        state: "RECOVERY",
        reason: "recovering_from_degraded",
        detail: `Recovery cooldown expires at ${new Date(this.recoveryUntilMs).toISOString()}.`
      };
      this.scheduleRecoveryCheck();
    }

    // Re-entering DEGRADED: clear any stale recovery state
    if (next.state === "DEGRADED") {
      this.recoveryUntilMs = undefined;
      this.clearRecoveryTimer();
    }

    // Reaching RUNNING or WARNING: fully recovered, clear recovery state
    if (next.state === "RUNNING" || next.state === "WARNING") {
      this.recoveryUntilMs = undefined;
      this.clearRecoveryTimer();
    }

    this.state = next.state;
    this.haltReason = next.state === "HALTED" ? next.reason : undefined;
    this.haltDetail = next.state === "HALTED" ? next.detail : undefined;
    this.warnReason = next.state === "WARNING" ? next.reason : undefined;
    this.lastEventAtMs = this.now();

    const stateChanged =
      this.state !== previousState || this.haltReason !== previousReason;

    if (stateChanged) {
      const snapshot = this.buildSnapshot();

      if (this.state === "HALTED") {
        this.logger?.error(
          { event, source, detail, risk: snapshot },
          "Risk manager halted trading."
        );
      } else if (this.state === "DEGRADED") {
        this.logger?.warn(
          { event, source, detail, risk: snapshot },
          "Risk manager entered degraded mode."
        );
      } else if (this.state === "RECOVERY") {
        this.logger?.warn(
          { event, source, detail, risk: snapshot },
          "Risk manager entered recovery mode. BUY intents paused during cooldown."
        );
      } else if (this.state === "WARNING") {
        this.logger?.warn(
          { event, source, detail, risk: snapshot },
          "Risk manager entered warning state. Throttle applied."
        );
      } else {
        this.logger?.info(
          { event, source, detail, risk: snapshot },
          "Risk manager returned to running mode."
        );
      }

      for (const listener of this.listeners) {
        listener(snapshot);
      }
    }

    if (this.state === "HALTED") {
      return {
        allowed: false,
        state: this.state,
        reason: this.haltReason,
        detail: this.haltDetail
      };
    }

    if (this.state === "RECOVERY") {
      return {
        allowed: true,
        state: this.state,
        reason: next.reason,
        detail: next.detail
      };
    }

    return {
      allowed: true,
      state: this.state,
      reason: this.state === "DEGRADED" ? next.reason : this.state === "WARNING" ? next.reason : undefined,
      detail: this.state === "DEGRADED" ? next.detail : this.state === "WARNING" ? next.detail : undefined
    };
  }

  private scheduleRecoveryCheck(): void {
    this.clearRecoveryTimer();

    if (this.recoveryUntilMs === undefined) {
      return;
    }

    const delay = Math.max(0, this.recoveryUntilMs - this.now()) + 50;
    this.recoveryCheckTimer = setTimeout(() => {
      this.recoveryCheckTimer = undefined;
      this.applyState("recovery_check", "risk-manager", "Recovery cooldown expired.");
    }, delay);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryCheckTimer !== undefined) {
      clearTimeout(this.recoveryCheckTimer);
      this.recoveryCheckTimer = undefined;
    }
  }

  private computeState(): StateComputation {
    const dailyLossUsdc = this.getDailyLossUsdc();

    if (
      this.thresholds.maxDailyLossUsdc > 0 &&
      dailyLossUsdc >= this.thresholds.maxDailyLossUsdc
    ) {
      return {
        state: "HALTED",
        reason: "daily_loss_limit_exceeded",
        detail: `dailyLossUsdc(${dailyLossUsdc.toFixed(4)}) >= maxDailyLossUsdc(${this.thresholds.maxDailyLossUsdc.toFixed(4)})`
      };
    }

    if (
      this.thresholds.maxConsecutiveLosses > 0 &&
      this.consecutiveLosses >= this.thresholds.maxConsecutiveLosses
    ) {
      return {
        state: "HALTED",
        reason: "consecutive_loss_limit_exceeded",
        detail: `consecutiveLosses(${this.consecutiveLosses}) >= maxConsecutiveLosses(${this.thresholds.maxConsecutiveLosses})`
      };
    }

    if (
      this.thresholds.maxApiErrors > 0 &&
      this.apiErrors >= this.thresholds.maxApiErrors
    ) {
      return {
        state: "HALTED",
        reason: "api_error_limit_exceeded",
        detail: `apiErrors(${this.apiErrors}) >= maxApiErrors(${this.thresholds.maxApiErrors})`
      };
    }

    if (
      this.thresholds.maxOrderFailures > 0 &&
      this.orderFailures >= this.thresholds.maxOrderFailures
    ) {
      return {
        state: "HALTED",
        reason: "order_failure_limit_exceeded",
        detail: `orderFailures(${this.orderFailures}) >= maxOrderFailures(${this.thresholds.maxOrderFailures})`
      };
    }

    if (
      this.thresholds.maxStateMismatches > 0 &&
      this.stateMismatches >= this.thresholds.maxStateMismatches
    ) {
      return {
        state: "HALTED",
        reason: "state_mismatch_limit_exceeded",
        detail: `stateMismatches(${this.stateMismatches}) >= maxStateMismatches(${this.thresholds.maxStateMismatches})`
      };
    }

    const degradedDailyLossThreshold =
      this.thresholds.maxDailyLossUsdc * this.thresholds.degradeDailyLossRatio;

    if (
      this.thresholds.degradeDailyLossRatio > 0 &&
      dailyLossUsdc >= degradedDailyLossThreshold
    ) {
      return {
        state: "DEGRADED",
        reason: "daily_loss_elevated",
        detail: `dailyLossUsdc(${dailyLossUsdc.toFixed(4)}) >= degradedDailyLossUsdc(${degradedDailyLossThreshold.toFixed(4)})`
      };
    }

    if (
      this.thresholds.degradeConsecutiveLosses > 0 &&
      this.consecutiveLosses >= this.thresholds.degradeConsecutiveLosses
    ) {
      return {
        state: "DEGRADED",
        reason: "consecutive_losses_elevated",
        detail: `consecutiveLosses(${this.consecutiveLosses}) >= degradeConsecutiveLosses(${this.thresholds.degradeConsecutiveLosses})`
      };
    }

    if (
      this.thresholds.degradeApiErrors > 0 &&
      this.apiErrors >= this.thresholds.degradeApiErrors
    ) {
      return {
        state: "DEGRADED",
        reason: "api_errors_elevated",
        detail: `apiErrors(${this.apiErrors}) >= degradeApiErrors(${this.thresholds.degradeApiErrors})`
      };
    }

    if (
      this.thresholds.degradeOrderFailures > 0 &&
      this.orderFailures >= this.thresholds.degradeOrderFailures
    ) {
      return {
        state: "DEGRADED",
        reason: "order_failures_elevated",
        detail: `orderFailures(${this.orderFailures}) >= degradeOrderFailures(${this.thresholds.degradeOrderFailures})`
      };
    }

    if (
      this.thresholds.degradeStateMismatches > 0 &&
      this.stateMismatches >= this.thresholds.degradeStateMismatches
    ) {
      return {
        state: "DEGRADED",
        reason: "state_mismatches_elevated",
        detail: `stateMismatches(${this.stateMismatches}) >= degradeStateMismatches(${this.thresholds.degradeStateMismatches})`
      };
    }

    // RECOVERY: still in post-DEGRADED cooldown
    if (this.recoveryUntilMs !== undefined && this.now() < this.recoveryUntilMs) {
      return {
        state: "RECOVERY",
        reason: "recovering_from_degraded",
        detail: `Recovery cooldown expires at ${new Date(this.recoveryUntilMs).toISOString()}.`
      };
    }

    // WARNING: early-signal thresholds (below DEGRADE)
    const warnDailyLossThreshold =
      this.thresholds.maxDailyLossUsdc * this.thresholds.warnDailyLossRatio;

    if (
      this.thresholds.warnDailyLossRatio > 0 &&
      dailyLossUsdc >= warnDailyLossThreshold
    ) {
      return {
        state: "WARNING",
        reason: "daily_loss_warning",
        detail: `dailyLossUsdc(${dailyLossUsdc.toFixed(4)}) >= warnDailyLossThreshold(${warnDailyLossThreshold.toFixed(4)})`
      };
    }

    if (
      this.thresholds.warnConsecutiveLosses > 0 &&
      this.consecutiveLosses >= this.thresholds.warnConsecutiveLosses
    ) {
      return {
        state: "WARNING",
        reason: "consecutive_losses_warning",
        detail: `consecutiveLosses(${this.consecutiveLosses}) >= warnConsecutiveLosses(${this.thresholds.warnConsecutiveLosses})`
      };
    }

    if (
      this.thresholds.warnApiErrors > 0 &&
      this.apiErrors >= this.thresholds.warnApiErrors
    ) {
      return {
        state: "WARNING",
        reason: "api_errors_warning",
        detail: `apiErrors(${this.apiErrors}) >= warnApiErrors(${this.thresholds.warnApiErrors})`
      };
    }

    if (
      this.thresholds.warnOrderFailures > 0 &&
      this.orderFailures >= this.thresholds.warnOrderFailures
    ) {
      return {
        state: "WARNING",
        reason: "order_failures_warning",
        detail: `orderFailures(${this.orderFailures}) >= warnOrderFailures(${this.thresholds.warnOrderFailures})`
      };
    }

    if (
      this.thresholds.warnStateMismatches > 0 &&
      this.stateMismatches >= this.thresholds.warnStateMismatches
    ) {
      return {
        state: "WARNING",
        reason: "state_mismatches_warning",
        detail: `stateMismatches(${this.stateMismatches}) >= warnStateMismatches(${this.thresholds.warnStateMismatches})`
      };
    }

    return {
      state: "RUNNING"
    };
  }

  private getDailyLossUsdc(): number {
    return Math.max(0, -this.dailyRealizedPnlUsdc);
  }

  private computeNextConsecutiveLosses(realizedPnlUsdc: number): number {
    if (realizedPnlUsdc >= 0) {
      return 0;
    }

    if (Math.abs(realizedPnlUsdc) < this.thresholds.minLossUsdcForConsecutiveLoss) {
      return this.consecutiveLosses;
    }

    return this.consecutiveLosses + 1;
  }

  private buildSnapshot(): RiskStatusSnapshot {
    return {
      state: this.state,
      dayKey: this.dayKey,
      dailyRealizedPnlUsdc: this.dailyRealizedPnlUsdc,
      dailyLossUsdc: this.getDailyLossUsdc(),
      consecutiveLosses: this.consecutiveLosses,
      apiErrors: this.apiErrors,
      orderFailures: this.orderFailures,
      stateMismatches: this.stateMismatches,
      lastEventAtMs: this.lastEventAtMs,
      haltReason: this.haltReason,
      haltDetail: this.haltDetail,
      warnReason: this.warnReason,
      recoveryUntilMs: this.recoveryUntilMs
    };
  }
}
