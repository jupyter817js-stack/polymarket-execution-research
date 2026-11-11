import { config } from "../config.js";
import { buildRiskBudgetAdjustmentSnapshot } from "./capital-allocator.js";
import type { RiskState, RiskStatusSnapshot } from "./types.js";

const EPSILON = 1e-9;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export type DegradedExecutionDominantReason =
  | "none"
  | "daily_loss"
  | "consecutive_losses"
  | "api_errors"
  | "order_failures"
  | "state_mismatches";

export type RiskExecutionThrottleSnapshot = {
  state: RiskState;
  stressScore: number;
  dominantReason: DegradedExecutionDominantReason;
  reasonScores: {
    dailyLoss: number;
    consecutiveLosses: number;
    apiErrors: number;
    orderFailures: number;
    stateMismatches: number;
  };
  quoteSizeMultiplier: number;
  quoteHalfSpreadTicksMultiplier: number;
  signalCooldownMultiplier: number;
  executionCooldownMultiplier: number;
};

const computeThresholdStress = (
  value: number,
  degradedThreshold: number,
  haltedThreshold: number
): number => {
  if (!Number.isFinite(value) || haltedThreshold <= 0) {
    return 0;
  }

  if (value <= degradedThreshold) {
    return 0;
  }

  if (haltedThreshold <= degradedThreshold) {
    return 1;
  }

  return clamp01((value - degradedThreshold) / (haltedThreshold - degradedThreshold));
};

const getReasonScores = (snapshot: RiskStatusSnapshot) => ({
  dailyLoss: computeThresholdStress(
    snapshot.dailyLossUsdc,
    config.risk.maxDailyLossUsdc * config.risk.degradeDailyLossRatio,
    config.risk.maxDailyLossUsdc
  ),
  consecutiveLosses: computeThresholdStress(
    snapshot.consecutiveLosses,
    config.risk.degradeConsecutiveLosses,
    config.risk.maxConsecutiveLosses
  ),
  apiErrors: computeThresholdStress(
    snapshot.apiErrors,
    config.risk.degradeApiErrors,
    config.risk.maxApiErrors
  ),
  orderFailures: computeThresholdStress(
    snapshot.orderFailures,
    config.risk.degradeOrderFailures,
    config.risk.maxOrderFailures
  ),
  stateMismatches: computeThresholdStress(
    snapshot.stateMismatches,
    config.risk.degradeStateMismatches,
    config.risk.maxStateMismatches
  )
});

const getDominantReason = (
  state: RiskState,
  scores: RiskExecutionThrottleSnapshot["reasonScores"]
): DegradedExecutionDominantReason => {
  if (state !== "DEGRADED" && state !== "WARNING") {
    return state === "HALTED" ? "state_mismatches" : "none";
  }

  const ranked = [
    ["daily_loss", scores.dailyLoss],
    ["consecutive_losses", scores.consecutiveLosses],
    ["api_errors", scores.apiErrors],
    ["order_failures", scores.orderFailures],
    ["state_mismatches", scores.stateMismatches]
  ] as const;

  const dominant = ranked.reduce(
    (best, candidate) => (candidate[1] > best[1] + EPSILON ? candidate : best),
    ranked[0]
  );

  return dominant[1] > EPSILON ? dominant[0] : "none";
};

const ZERO_REASON_SCORES: RiskExecutionThrottleSnapshot["reasonScores"] = {
  dailyLoss: 0,
  consecutiveLosses: 0,
  apiErrors: 0,
  orderFailures: 0,
  stateMismatches: 0
};

export const buildRiskExecutionThrottleSnapshot = (
  snapshot?: RiskStatusSnapshot
): RiskExecutionThrottleSnapshot => {
  const state = snapshot?.state ?? "RUNNING";

  if (state === "HALTED") {
    return {
      state,
      stressScore: 1,
      dominantReason: "state_mismatches",
      reasonScores: {
        dailyLoss: 1,
        consecutiveLosses: 1,
        apiErrors: 1,
        orderFailures: 1,
        stateMismatches: 1
      },
      quoteSizeMultiplier: 0,
      quoteHalfSpreadTicksMultiplier: Number(
        config.risk.degradedMmQuoteHalfSpreadMaxMultiplier.toFixed(8)
      ),
      signalCooldownMultiplier: Number(
        config.risk.degradedSignalCooldownMaxMultiplier.toFixed(8)
      ),
      executionCooldownMultiplier: Number(
        config.risk.degradedExecutionCooldownMaxMultiplier.toFixed(8)
      )
    };
  }

  if (state === "WARNING") {
    const reasonScores = snapshot ? getReasonScores(snapshot) : { ...ZERO_REASON_SCORES };
    // Dynamic stressScore based on actual risk indicators, clamped to WARNING range [0.10–0.25].
    const maxReason = Math.max(
      reasonScores.dailyLoss,
      reasonScores.consecutiveLosses,
      reasonScores.apiErrors,
      reasonScores.orderFailures,
      reasonScores.stateMismatches
    );
    const dynamicWarningStress = clamp01(0.10 + maxReason * 0.15);
    // Graduated multipliers: scale proportionally with actual stress instead of fixed values.
    const spreadMult = 1 + dynamicWarningStress * 0.67;   // 1.07–1.17
    const cooldownMult = 1 + dynamicWarningStress * 1.33;  // 1.13–1.33
    return {
      state,
      stressScore: Number(dynamicWarningStress.toFixed(8)),
      dominantReason: getDominantReason(state, reasonScores),
      reasonScores: {
        dailyLoss: Number(reasonScores.dailyLoss.toFixed(8)),
        consecutiveLosses: Number(reasonScores.consecutiveLosses.toFixed(8)),
        apiErrors: Number(reasonScores.apiErrors.toFixed(8)),
        orderFailures: Number(reasonScores.orderFailures.toFixed(8)),
        stateMismatches: Number(reasonScores.stateMismatches.toFixed(8))
      },
      quoteSizeMultiplier: Number(config.risk.warningMmQuoteSizeMultiplier.toFixed(8)),
      quoteHalfSpreadTicksMultiplier: Number(spreadMult.toFixed(8)),
      signalCooldownMultiplier: Number(cooldownMult.toFixed(8)),
      executionCooldownMultiplier: 1
    };
  }

  if (state === "RECOVERY") {
    // RECOVERY inherits the last DEGRADED stress scaled down by 60%.
    // Use reason scores to estimate the residual stress that led to DEGRADED.
    const reasonScores = snapshot ? getReasonScores(snapshot) : { ...ZERO_REASON_SCORES };
    const maxReason = Math.max(
      reasonScores.dailyLoss,
      reasonScores.consecutiveLosses,
      reasonScores.apiErrors,
      reasonScores.orderFailures,
      reasonScores.stateMismatches
    );
    const dynamicRecoveryStress = clamp01(0.20 + maxReason * 0.15);
    return {
      state,
      stressScore: Number(dynamicRecoveryStress.toFixed(8)),
      dominantReason: getDominantReason(state, reasonScores),
      reasonScores: {
        dailyLoss: Number(reasonScores.dailyLoss.toFixed(8)),
        consecutiveLosses: Number(reasonScores.consecutiveLosses.toFixed(8)),
        apiErrors: Number(reasonScores.apiErrors.toFixed(8)),
        orderFailures: Number(reasonScores.orderFailures.toFixed(8)),
        stateMismatches: Number(reasonScores.stateMismatches.toFixed(8))
      },
      quoteSizeMultiplier: Number(config.risk.recoveryMmQuoteSizeMultiplier.toFixed(8)),
      quoteHalfSpreadTicksMultiplier: Number((1 + dynamicRecoveryStress * 0.67).toFixed(8)),
      signalCooldownMultiplier: Number((1 + dynamicRecoveryStress * 1.67).toFixed(8)),
      executionCooldownMultiplier: Number((1 + dynamicRecoveryStress * 0.67).toFixed(8))
    };
  }

  if (!snapshot || state !== "DEGRADED") {
    return {
      state,
      stressScore: 0,
      dominantReason: "none",
      reasonScores: { ...ZERO_REASON_SCORES },
      quoteSizeMultiplier: 1,
      quoteHalfSpreadTicksMultiplier: 1,
      signalCooldownMultiplier: 1,
      executionCooldownMultiplier: 1
    };
  }

  const budgetAdjustment = buildRiskBudgetAdjustmentSnapshot(snapshot);
  const reasonScores = getReasonScores(snapshot);
  const dominantReason = getDominantReason(state, reasonScores);
  const baseStress = clamp01(1 - budgetAdjustment.sharedBuyBudgetMultiplier);
  const lossStress = Math.max(reasonScores.dailyLoss, reasonScores.consecutiveLosses);
  const operationalStress = Math.max(
    reasonScores.apiErrors,
    reasonScores.orderFailures,
    reasonScores.stateMismatches
  );
  const quoteStress = clamp01(Math.max(baseStress, lossStress, reasonScores.stateMismatches * 0.6));
  const cooldownStress = clamp01(
    Math.max(baseStress, operationalStress, reasonScores.stateMismatches * 0.9)
  );
  const quoteSizeFloor = clamp01(config.risk.degradedMmQuoteSizeFloorMultiplier);
  const quoteSizeMultiplier =
    quoteSizeFloor + (1 - quoteSizeFloor) * (1 - quoteStress);
  const quoteHalfSpreadTicksMultiplier =
    1 +
    quoteStress * Math.max(0, config.risk.degradedMmQuoteHalfSpreadMaxMultiplier - 1);
  const signalCooldownMultiplier =
    1 +
    cooldownStress * Math.max(0, config.risk.degradedSignalCooldownMaxMultiplier - 1);
  const executionCooldownMultiplier =
    1 +
    Math.max(cooldownStress, baseStress * 0.75) *
      Math.max(0, config.risk.degradedExecutionCooldownMaxMultiplier - 1);

  return {
    state,
    stressScore: Number(budgetAdjustment.stressScore.toFixed(8)),
    dominantReason,
    reasonScores: {
      dailyLoss: Number(reasonScores.dailyLoss.toFixed(8)),
      consecutiveLosses: Number(reasonScores.consecutiveLosses.toFixed(8)),
      apiErrors: Number(reasonScores.apiErrors.toFixed(8)),
      orderFailures: Number(reasonScores.orderFailures.toFixed(8)),
      stateMismatches: Number(reasonScores.stateMismatches.toFixed(8))
    },
    quoteSizeMultiplier: Number(quoteSizeMultiplier.toFixed(8)),
    quoteHalfSpreadTicksMultiplier: Number(quoteHalfSpreadTicksMultiplier.toFixed(8)),
    signalCooldownMultiplier: Number(signalCooldownMultiplier.toFixed(8)),
    executionCooldownMultiplier: Number(executionCooldownMultiplier.toFixed(8))
  };
};
