import { config } from "../config.js";
import type { BinaryMarket } from "../types.js";
import type { InventoryLotSnapshot } from "./inventory-lot-tracker.js";
import type {
  ActiveOrderState,
  OrderIntent,
  PositionGateDecision,
  RiskState,
  RiskStatusSnapshot,
  StrategyName
} from "./types.js";

type StrategyBudgetBucket = "market-making" | "same-market-arb" | "negative-risk";
export type ScopedCapitalSignalEntries =
  | ReadonlyMap<string, number>
  | Iterable<readonly [string, number]>;

const EPSILON = 1e-9;
const STRATEGY_BUDGET_BUCKETS: readonly StrategyBudgetBucket[] = [
  "market-making",
  "same-market-arb",
  "negative-risk"
] as const;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const normalizeScopeKey = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeScopedSignalEntries = (
  signals: ScopedCapitalSignalEntries
): Map<string, number> => {
  const normalizedSignals = new Map<string, number>();

  for (const [scopeId, rawScore] of signals) {
    const normalizedScopeId = normalizeScopeKey(scopeId);

    if (!normalizedScopeId || !Number.isFinite(rawScore)) {
      continue;
    }

    normalizedSignals.set(normalizedScopeId, clamp01(rawScore));
  }

  return normalizedSignals;
};

export const setScopedSignalsBySource = (
  registry: Map<string, Map<string, number>>,
  signals: ScopedCapitalSignalEntries,
  source = "default"
): void => {
  const normalizedSource = normalizeScopeKey(source) ?? "default";
  const normalizedSignals = normalizeScopedSignalEntries(signals);

  if (normalizedSignals.size === 0) {
    registry.delete(normalizedSource);
    return;
  }

  registry.set(normalizedSource, normalizedSignals);
};

export const mergeScopedSignalsBySource = (
  registry: ReadonlyMap<string, ReadonlyMap<string, number>>
): Map<string, number> => {
  const merged = new Map<string, number>();

  for (const scopedSignals of registry.values()) {
    for (const [scopeId, score] of scopedSignals.entries()) {
      merged.set(scopeId, Math.max(merged.get(scopeId) ?? 0, clamp01(score)));
    }
  }

  return merged;
};

export const computeDynamicScopedCapUsdc = (options: {
  staticCapUsdc: number;
  scopeId: string;
  signalByScope: ReadonlyMap<string, number>;
  enableDynamicReallocation: boolean;
  reallocationIntensity: number;
  signalFloor: number;
}): number => {
  if (
    options.staticCapUsdc <= EPSILON ||
    !options.enableDynamicReallocation ||
    options.signalByScope.size === 0
  ) {
    return options.staticCapUsdc;
  }

  const normalizedScopeId = normalizeScopeKey(options.scopeId);

  if (!normalizedScopeId) {
    return options.staticCapUsdc;
  }

  const scopeSignal = options.signalByScope.get(normalizedScopeId);

  if (typeof scopeSignal !== "number") {
    return options.staticCapUsdc;
  }

  const reallocationIntensity = clamp01(options.reallocationIntensity);

  if (reallocationIntensity <= EPSILON) {
    return options.staticCapUsdc;
  }

  const baselineShare = 1 / options.signalByScope.size;
  const floorShare = baselineShare * (1 - reallocationIntensity);
  const signalFloor = clamp01(options.signalFloor);
  const effectiveSignalEntries = [...options.signalByScope.entries()].map(
    ([scopeKey, score]): [string, number] => [scopeKey, Math.max(signalFloor, clamp01(score))]
  );
  const effectiveSignalTotal = effectiveSignalEntries.reduce(
    (total, [, score]) => total + score,
    0
  );

  if (effectiveSignalTotal <= EPSILON) {
    return options.staticCapUsdc;
  }

  const effectiveSignal = effectiveSignalEntries.find(
    ([scopeKey]) => scopeKey === normalizedScopeId
  )?.[1];

  if (typeof effectiveSignal !== "number") {
    return options.staticCapUsdc;
  }

  const effectiveShare =
    floorShare + reallocationIntensity * (effectiveSignal / effectiveSignalTotal);

  return options.staticCapUsdc * (effectiveShare / baselineShare);
};

const STRATEGY_BUCKET_BY_NAME: Partial<Record<StrategyName, StrategyBudgetBucket>> = {
  "market-making": "market-making",
  "liquidity-rewards": "market-making",
  "maker-rebates": "market-making",
  "same-market-arb": "same-market-arb",
  "negative-risk": "negative-risk"
};

const getStrategyBudgetBucket = (
  strategy: StrategyName
): StrategyBudgetBucket | undefined => STRATEGY_BUCKET_BY_NAME[strategy];

const getStaticStrategyBudgetCapUsdc = (bucket: StrategyBudgetBucket): number => {
  switch (bucket) {
    case "market-making":
      return config.capital.marketMakingBudgetUsdc;
    case "same-market-arb":
      return config.capital.sameMarketArbBudgetUsdc;
    case "negative-risk":
      return config.capital.negativeRiskBudgetUsdc;
  }
};

const getDegradedStrategyBudgetMultiplier = (bucket: StrategyBudgetBucket): number => {
  switch (bucket) {
    case "market-making":
      return config.capital.degradedMarketMakingBudgetMultiplier;
    case "same-market-arb":
      return config.capital.degradedSameMarketArbBudgetMultiplier;
    case "negative-risk":
      return config.capital.degradedNegativeRiskBudgetMultiplier;
  }
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

const computeRiskStressScore = (snapshot?: RiskStatusSnapshot): number => {
  if (!snapshot || snapshot.state !== "DEGRADED") {
    return 0;
  }

  return Math.max(
    computeThresholdStress(
      snapshot.dailyLossUsdc,
      config.risk.maxDailyLossUsdc * config.risk.degradeDailyLossRatio,
      config.risk.maxDailyLossUsdc
    ),
    computeThresholdStress(
      snapshot.consecutiveLosses,
      config.risk.degradeConsecutiveLosses,
      config.risk.maxConsecutiveLosses
    ),
    computeThresholdStress(
      snapshot.apiErrors,
      config.risk.degradeApiErrors,
      config.risk.maxApiErrors
    ),
    computeThresholdStress(
      snapshot.orderFailures,
      config.risk.degradeOrderFailures,
      config.risk.maxOrderFailures
    ),
    computeThresholdStress(
      snapshot.stateMismatches,
      config.risk.degradeStateMismatches,
      config.risk.maxStateMismatches
    )
  );
};

export type RiskBudgetAdjustmentSnapshot = {
  state: RiskState;
  stressScore: number;
  dynamicCurveMultiplier: number;
  sharedBuyBudgetMultiplier: number;
  strategyBuyBudgetMultipliers: Record<StrategyBudgetBucket, number>;
};

export const buildRiskBudgetAdjustmentSnapshot = (
  snapshot?: RiskStatusSnapshot
): RiskBudgetAdjustmentSnapshot => {
  const state = snapshot?.state ?? "RUNNING";

  if (state === "HALTED") {
    return {
      state,
      stressScore: 1,
      dynamicCurveMultiplier: 0,
      sharedBuyBudgetMultiplier: 0,
      strategyBuyBudgetMultipliers: {
        "market-making": 0,
        "same-market-arb": 0,
        "negative-risk": 0
      }
    };
  }

  if (state !== "DEGRADED") {
    return {
      state,
      stressScore: 0,
      dynamicCurveMultiplier: 1,
      sharedBuyBudgetMultiplier: 1,
      strategyBuyBudgetMultipliers: {
        "market-making": 1,
        "same-market-arb": 1,
        "negative-risk": 1
      }
    };
  }

  const stressScore = computeRiskStressScore(snapshot);
  const dynamicCurveMultiplier = !config.capital.enableDynamicDegradedCurve
    ? 1
    : clamp01(config.capital.degradedCurveFloorMultiplier) +
      (1 - clamp01(config.capital.degradedCurveFloorMultiplier)) *
        (1 - Math.pow(stressScore, Math.max(config.capital.degradedCurveExponent, EPSILON)));
  const sharedBuyBudgetMultiplier =
    dynamicCurveMultiplier * config.capital.degradedBuyBudgetMultiplier;

  return {
    state,
    stressScore: Number(stressScore.toFixed(8)),
    dynamicCurveMultiplier: Number(dynamicCurveMultiplier.toFixed(8)),
    sharedBuyBudgetMultiplier: Number(sharedBuyBudgetMultiplier.toFixed(8)),
    strategyBuyBudgetMultipliers: {
      "market-making": Number(
        (sharedBuyBudgetMultiplier * getDegradedStrategyBudgetMultiplier("market-making")).toFixed(8)
      ),
      "same-market-arb": Number(
        (sharedBuyBudgetMultiplier * getDegradedStrategyBudgetMultiplier("same-market-arb")).toFixed(8)
      ),
      "negative-risk": Number(
        (sharedBuyBudgetMultiplier * getDegradedStrategyBudgetMultiplier("negative-risk")).toFixed(8)
      )
    }
  };
};

const getIntentEventId = (
  item: { tokenId: string; metadata?: OrderIntent["metadata"] },
  marketByTokenId: ReadonlyMap<string, BinaryMarket>
): string | undefined => {
  const metadataEventId = item.metadata?.eventId;

  if (typeof metadataEventId === "string" && metadataEventId.length > 0) {
    return metadataEventId;
  }

  return marketByTokenId.get(item.tokenId)?.eventId;
};

const getInventoryLotConditionId = (
  lot: InventoryLotSnapshot,
  marketByTokenId: ReadonlyMap<string, BinaryMarket>
): string | undefined => lot.conditionId ?? marketByTokenId.get(lot.tokenId)?.conditionId;

const getInventoryLotEventId = (
  lot: InventoryLotSnapshot,
  marketByTokenId: ReadonlyMap<string, BinaryMarket>
): string | undefined => {
  const metadataEventId = lot.metadata?.eventId;

  if (typeof metadataEventId === "string" && metadataEventId.length > 0) {
    return metadataEventId;
  }

  return marketByTokenId.get(lot.tokenId)?.eventId;
};

const getInventoryLotNotionalUsdc = (
  lot: InventoryLotSnapshot,
  referencePriceByTokenId: ReadonlyMap<string, number>
): number => {
  const referencePrice = referencePriceByTokenId.get(lot.tokenId);
  const markedNotionalUsdc =
    typeof referencePrice === "number" && referencePrice > 0 ? lot.shares * referencePrice : 0;

  return Math.max(lot.totalCostUsdc, markedNotionalUsdc);
};

export class CapitalAllocator {
  private readonly reservedBuyNotionalByStrategy = new Map<StrategyBudgetBucket, number>();
  private readonly reservedBuyNotionalByCondition = new Map<string, number>();
  private readonly reservedBuyNotionalByEvent = new Map<string, number>();
  private readonly dynamicSignalByStrategy = new Map<StrategyBudgetBucket, number>();
  private readonly dynamicConditionSignalsBySource = new Map<string, Map<string, number>>();
  private readonly dynamicEventSignalsBySource = new Map<string, Map<string, number>>();
  private riskState: RiskState = "RUNNING";
  private riskSnapshot: RiskStatusSnapshot | undefined;

  /** Rolling 1-hour buy notional tracking for hourly budget enforcement. */
  private readonly hourlyBuyEntries: Array<{ atMs: number; notionalUsdc: number }> = [];
  private static readonly HOURLY_WINDOW_MS = 60 * 60 * 1000;

  /** Record a committed buy for hourly budget tracking. */
  recordHourlyBuy(notionalUsdc: number, atMs: number = Date.now()): void {
    if (config.capital.hourlyBuyBudgetUsdc <= 0) return;
    this.hourlyBuyEntries.push({ atMs, notionalUsdc });
    // Prune entries older than the window.
    const cutoff = atMs - CapitalAllocator.HOURLY_WINDOW_MS;
    while (this.hourlyBuyEntries.length > 0 && (this.hourlyBuyEntries[0]?.atMs ?? 0) < cutoff) {
      this.hourlyBuyEntries.shift();
    }
  }

  /** Get total buy notional in the current rolling hour window. */
  getHourlyBuyNotionalUsdc(nowMs: number = Date.now()): number {
    const cutoff = nowMs - CapitalAllocator.HOURLY_WINDOW_MS;
    return this.hourlyBuyEntries
      .filter((entry) => entry.atMs >= cutoff)
      .reduce((sum, entry) => sum + entry.notionalUsdc, 0);
  }

  beginBatch(): void {
    this.reservedBuyNotionalByStrategy.clear();
    this.reservedBuyNotionalByCondition.clear();
    this.reservedBuyNotionalByEvent.clear();
  }

  commitApprovedIntent(
    intent: OrderIntent,
    marketByTokenId: ReadonlyMap<string, BinaryMarket>,
    existingActiveOrder?: ActiveOrderState
  ): void {
    if (intent.side !== "BUY") {
      return;
    }

    const strategyBucket = getStrategyBudgetBucket(intent.strategy);

    if (!strategyBucket) {
      return;
    }

    const existingBuyNotionalUsdc =
      existingActiveOrder?.strategy === intent.strategy &&
      existingActiveOrder.side === "BUY"
        ? existingActiveOrder.price * existingActiveOrder.size
        : 0;
    const incrementalBuyNotionalUsdc = Math.max(
      0,
      intent.price * intent.size - existingBuyNotionalUsdc
    );

    if (incrementalBuyNotionalUsdc <= 0) {
      return;
    }

    this.reservedBuyNotionalByStrategy.set(
      strategyBucket,
      (this.reservedBuyNotionalByStrategy.get(strategyBucket) ?? 0) + incrementalBuyNotionalUsdc
    );
    this.reservedBuyNotionalByCondition.set(
      intent.conditionId,
      (this.reservedBuyNotionalByCondition.get(intent.conditionId) ?? 0) +
        incrementalBuyNotionalUsdc
    );

    const eventId = getIntentEventId(intent, marketByTokenId);

    if (eventId) {
      this.reservedBuyNotionalByEvent.set(
        eventId,
        (this.reservedBuyNotionalByEvent.get(eventId) ?? 0) + incrementalBuyNotionalUsdc
      );
    }
  }

  endBatch(): void {
    this.beginBatch();
  }

  setStrategySignal(strategy: StrategyName, score: number): void {
    const bucket = getStrategyBudgetBucket(strategy);

    if (!bucket || !Number.isFinite(score)) {
      return;
    }

    this.dynamicSignalByStrategy.set(bucket, clamp01(score));
  }

  setConditionSignals(signals: ScopedCapitalSignalEntries, source = "default"): void {
    setScopedSignalsBySource(this.dynamicConditionSignalsBySource, signals, source);
  }

  setEventSignals(signals: ScopedCapitalSignalEntries, source = "default"): void {
    setScopedSignalsBySource(this.dynamicEventSignalsBySource, signals, source);
  }

  setRiskState(state: RiskState): void {
    this.riskState = state;
  }

  setRiskSnapshot(snapshot: RiskStatusSnapshot): void {
    this.riskSnapshot = { ...snapshot };
    this.riskState = snapshot.state;
  }

  getPassiveCategoryRiskBudgetMultiplier(): number {
    return this.getRiskBudgetMultiplier("market-making");
  }

  evaluateIntent(
    intent: OrderIntent,
    context: {
      activeOrders: readonly ActiveOrderState[];
      openInventoryLots: readonly InventoryLotSnapshot[];
      marketByTokenId: ReadonlyMap<string, BinaryMarket>;
      referencePriceByTokenId: ReadonlyMap<string, number>;
      existingActiveOrder?: ActiveOrderState;
    }
  ): PositionGateDecision {
    if (intent.side !== "BUY") {
      return {
        allowed: true
      };
    }

    const strategyBucket = getStrategyBudgetBucket(intent.strategy);

    if (!strategyBucket) {
      return {
        allowed: true
      };
    }

    const existingBuyNotionalUsdc =
      context.existingActiveOrder?.strategy === intent.strategy &&
      context.existingActiveOrder.side === "BUY"
        ? context.existingActiveOrder.price * context.existingActiveOrder.size
        : 0;
    const incrementalBuyNotionalUsdc = Math.max(
      0,
      intent.price * intent.size - existingBuyNotionalUsdc
    );

    if (incrementalBuyNotionalUsdc <= 0) {
      return {
        allowed: true
      };
    }

    const totalProjectedBuyBudgetUsdc =
      this.getActiveBuyNotional(context.activeOrders) +
      this.getTrackedInventoryNotional(
        context.openInventoryLots,
        context.referencePriceByTokenId
      ) +
      this.getReservedBuyNotional() +
      incrementalBuyNotionalUsdc;

    if (
      config.capital.totalActiveBuyBudgetUsdc > 0 &&
      totalProjectedBuyBudgetUsdc >
        config.capital.totalActiveBuyBudgetUsdc + EPSILON
    ) {
      return {
        allowed: false,
        reason: "total_active_buy_budget_exceeded",
        detail: `projectedActiveBuyBudgetUsdc(${totalProjectedBuyBudgetUsdc.toFixed(4)}) > totalActiveBuyBudgetUsdc(${config.capital.totalActiveBuyBudgetUsdc.toFixed(4)})`,
        projectedExposureUsdc: totalProjectedBuyBudgetUsdc
      };
    }

    // Hourly rolling buy budget gate: prevent excessive buying within a single hour.
    if (config.capital.hourlyBuyBudgetUsdc > 0) {
      const hourlyUsed = this.getHourlyBuyNotionalUsdc();
      if (hourlyUsed + incrementalBuyNotionalUsdc > config.capital.hourlyBuyBudgetUsdc + EPSILON) {
        return {
          allowed: false,
          reason: "hourly_buy_budget_exceeded",
          detail: `hourlyBuyUsed(${hourlyUsed.toFixed(4)}) + incremental(${incrementalBuyNotionalUsdc.toFixed(4)}) > hourlyBuyBudgetUsdc(${config.capital.hourlyBuyBudgetUsdc.toFixed(4)})`,
          projectedExposureUsdc: totalProjectedBuyBudgetUsdc
        };
      }
    }

    const strategyProjectedBuyBudgetUsdc =
      this.getActiveBuyNotional(context.activeOrders, (order) =>
        getStrategyBudgetBucket(order.strategy) === strategyBucket
      ) +
      this.getTrackedInventoryNotional(
        context.openInventoryLots,
        context.referencePriceByTokenId,
        (lot) => getStrategyBudgetBucket(lot.strategy) === strategyBucket
      ) +
      (this.reservedBuyNotionalByStrategy.get(strategyBucket) ?? 0) +
      incrementalBuyNotionalUsdc;
    const strategyBudgetCapUsdc = this.getStrategyBudgetCapUsdc(strategyBucket);

    if (
      strategyBudgetCapUsdc > 0 &&
      strategyProjectedBuyBudgetUsdc > strategyBudgetCapUsdc + EPSILON
    ) {
      return {
        allowed: false,
        reason: "strategy_buy_budget_exceeded",
        detail: `projectedStrategyBuyBudgetUsdc(${strategyProjectedBuyBudgetUsdc.toFixed(4)}) > strategyBudgetCapUsdc(${strategyBudgetCapUsdc.toFixed(4)}) for ${strategyBucket}`,
        projectedExposureUsdc: strategyProjectedBuyBudgetUsdc
      };
    }

    const conditionProjectedBuyBudgetUsdc =
      this.getActiveBuyNotional(
        context.activeOrders,
        (order) => order.conditionId === intent.conditionId
      ) +
      this.getTrackedInventoryNotional(
        context.openInventoryLots,
        context.referencePriceByTokenId,
        (lot) =>
          getInventoryLotConditionId(lot, context.marketByTokenId) === intent.conditionId
      ) +
      (this.reservedBuyNotionalByCondition.get(intent.conditionId) ?? 0) +
      incrementalBuyNotionalUsdc;

    const conditionBudgetCapUsdc = this.getConditionBudgetCapUsdc(
      intent.conditionId,
      strategyBucket
    );

    if (
      conditionBudgetCapUsdc > 0 &&
      conditionProjectedBuyBudgetUsdc > conditionBudgetCapUsdc + EPSILON
    ) {
      return {
        allowed: false,
        reason: "condition_buy_budget_exceeded",
        detail: `projectedConditionBuyBudgetUsdc(${conditionProjectedBuyBudgetUsdc.toFixed(4)}) > conditionBudgetCapUsdc(${conditionBudgetCapUsdc.toFixed(4)})`,
        projectedExposureUsdc: conditionProjectedBuyBudgetUsdc
      };
    }

    const eventId = getIntentEventId(intent, context.marketByTokenId);

    if (eventId) {
      const eventProjectedBuyBudgetUsdc =
        this.getActiveBuyNotional(context.activeOrders, (order) => {
          const orderEventId = getIntentEventId(order, context.marketByTokenId);
          return orderEventId === eventId;
        }) +
        this.getTrackedInventoryNotional(
          context.openInventoryLots,
          context.referencePriceByTokenId,
          (lot) => getInventoryLotEventId(lot, context.marketByTokenId) === eventId
        ) +
        (this.reservedBuyNotionalByEvent.get(eventId) ?? 0) +
        incrementalBuyNotionalUsdc;

      const eventBudgetCapUsdc = this.getEventBudgetCapUsdc(eventId, strategyBucket);

      if (
        eventBudgetCapUsdc > 0 &&
        eventProjectedBuyBudgetUsdc > eventBudgetCapUsdc + EPSILON
      ) {
        return {
          allowed: false,
          reason: "event_buy_budget_exceeded",
          detail: `projectedEventBuyBudgetUsdc(${eventProjectedBuyBudgetUsdc.toFixed(4)}) > eventBudgetCapUsdc(${eventBudgetCapUsdc.toFixed(4)})`,
          projectedExposureUsdc: eventProjectedBuyBudgetUsdc
        };
      }
    }

    return {
      allowed: true,
      projectedExposureUsdc: strategyProjectedBuyBudgetUsdc
    };
  }

  private getReservedBuyNotional(): number {
    return [...this.reservedBuyNotionalByStrategy.values()].reduce(
      (total, value) => total + value,
      0
    );
  }

  private getStrategyBudgetCapUsdc(bucket: StrategyBudgetBucket): number {
    const staticCapUsdc = getStaticStrategyBudgetCapUsdc(bucket);
    const riskAdjustedStaticCapUsdc =
      staticCapUsdc * this.getRiskBudgetMultiplier(bucket);

    if (
      !config.capital.enableDynamicStrategyReallocation ||
      config.capital.totalActiveBuyBudgetUsdc <= EPSILON
    ) {
      return riskAdjustedStaticCapUsdc;
    }

    const baseCapByBucket = new Map(
      STRATEGY_BUDGET_BUCKETS.map((strategyBucket) => [
        strategyBucket,
        Math.max(0, getStaticStrategyBudgetCapUsdc(strategyBucket))
      ])
    );
    const baseCapTotalUsdc = [...baseCapByBucket.values()].reduce(
      (total, capUsdc) => total + capUsdc,
      0
    );

    if (baseCapTotalUsdc <= EPSILON) {
      return riskAdjustedStaticCapUsdc;
    }

    const reallocationIntensity = clamp01(config.capital.strategyReallocationIntensity);

    if (reallocationIntensity <= EPSILON) {
      return riskAdjustedStaticCapUsdc;
    }

    const signalFloor = clamp01(config.capital.strategySignalFloor);
    const baseShareByBucket = new Map(
      STRATEGY_BUDGET_BUCKETS.map((strategyBucket) => [
        strategyBucket,
        (baseCapByBucket.get(strategyBucket) ?? 0) / baseCapTotalUsdc
      ])
    );
    const floorShareByBucket = new Map(
      STRATEGY_BUDGET_BUCKETS.map((strategyBucket) => [
        strategyBucket,
        (baseShareByBucket.get(strategyBucket) ?? 0) * (1 - reallocationIntensity)
      ])
    );
    const reallocationPoolShare =
      1 -
      [...floorShareByBucket.values()].reduce((total, share) => total + share, 0);
    const signalByBucket = new Map(
      STRATEGY_BUDGET_BUCKETS.map((strategyBucket) => {
        const rawSignal = this.dynamicSignalByStrategy.get(strategyBucket);
        const fallbackSignal = baseShareByBucket.get(strategyBucket) ?? 0;

        return [strategyBucket, Math.max(signalFloor, rawSignal ?? fallbackSignal)];
      })
    );
    const signalTotal = [...signalByBucket.values()].reduce(
      (total, signal) => total + signal,
      0
    );

    if (signalTotal <= EPSILON) {
      return riskAdjustedStaticCapUsdc;
    }

    const effectiveShare =
      (floorShareByBucket.get(bucket) ?? 0) +
      reallocationPoolShare * ((signalByBucket.get(bucket) ?? 0) / signalTotal);

    return (
      config.capital.totalActiveBuyBudgetUsdc *
      this.getRiskBudgetMultiplier(bucket) *
      effectiveShare
    );
  }

  private getConditionBudgetCapUsdc(conditionId: string, strategyBucket?: StrategyBudgetBucket): number {
    return computeDynamicScopedCapUsdc({
      staticCapUsdc:
        config.capital.conditionBuyBudgetUsdc * this.getRiskBudgetMultiplier(strategyBucket),
      scopeId: conditionId,
      signalByScope: mergeScopedSignalsBySource(this.dynamicConditionSignalsBySource),
      enableDynamicReallocation: config.capital.enableDynamicScopeReallocation,
      reallocationIntensity: config.capital.scopeReallocationIntensity,
      signalFloor: config.capital.scopeSignalFloor
    });
  }

  private getEventBudgetCapUsdc(eventId: string, strategyBucket?: StrategyBudgetBucket): number {
    return computeDynamicScopedCapUsdc({
      staticCapUsdc:
        config.capital.eventBuyBudgetUsdc * this.getRiskBudgetMultiplier(strategyBucket),
      scopeId: eventId,
      signalByScope: mergeScopedSignalsBySource(this.dynamicEventSignalsBySource),
      enableDynamicReallocation: config.capital.enableDynamicScopeReallocation,
      reallocationIntensity: config.capital.scopeReallocationIntensity,
      signalFloor: config.capital.scopeSignalFloor
    });
  }

  private getRiskBudgetMultiplier(bucket?: StrategyBudgetBucket): number {
    switch (this.riskState) {
      case "DEGRADED":
        return (
          this.getDynamicDegradedCurveMultiplier() *
          config.capital.degradedBuyBudgetMultiplier *
          (bucket ? getDegradedStrategyBudgetMultiplier(bucket) : 1)
        );
      case "HALTED":
        return 0;
      default:
        return 1;
    }
  }

  private getDynamicDegradedCurveMultiplier(): number {
    if (
      this.riskState !== "DEGRADED" ||
      !config.capital.enableDynamicDegradedCurve
    ) {
      return 1;
    }
    return buildRiskBudgetAdjustmentSnapshot(this.riskSnapshot).dynamicCurveMultiplier;
  }

  private getActiveBuyNotional(
    activeOrders: readonly ActiveOrderState[],
    predicate?: (order: ActiveOrderState) => boolean
  ): number {
    return activeOrders
      .filter((order) => order.side === "BUY" && (predicate ? predicate(order) : true))
      .reduce((total, order) => total + order.price * order.size, 0);
  }

  private getTrackedInventoryNotional(
    openInventoryLots: readonly InventoryLotSnapshot[],
    referencePriceByTokenId: ReadonlyMap<string, number>,
    predicate?: (lot: InventoryLotSnapshot) => boolean
  ): number {
    return openInventoryLots
      .filter((lot) => (predicate ? predicate(lot) : true))
      .reduce(
        (total, lot) => total + getInventoryLotNotionalUsdc(lot, referencePriceByTokenId),
        0
      );
  }
}
