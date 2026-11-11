import type {
  RankedMarketSelection,
  RankedNegativeRiskGroupSelection
} from "./market-selection.js";
import { config } from "../config.js";
import type { PnlTradeRecord, StrategyName, StrategyPnlSnapshot } from "./types.js";

export interface StrategyCapitalSignal {
  score: number;
  selectedCount: number;
  components: {
    reward: number;
    rebate: number;
    liquidity: number;
    activity: number;
    spread: number;
    structure: number;
  };
}

export interface ScopedCapitalSignals {
  byConditionId: Map<string, number>;
  byEventId: Map<string, number>;
  byCategory: Map<string, number>;
}

export interface StrategyPerformanceCapitalSignal {
  score: number;
  tradeCount: number;
  components: {
    pnl: number;
    winRate: number;
    activity: number;
  };
}

type ScopedTradePerformanceAccumulator = {
  realizedPnlUsdc: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
};

type ScopedSignalAccumulator = {
  total: number[];
  reward: number[];
  rebate: number[];
};

const roundScore = (value: number): number =>
  Number(Math.max(0, Math.min(1, value)).toFixed(4));

const average = (values: readonly number[]): number =>
  values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;

const normalizeLinear = (value: number, minValue: number, maxValue: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (maxValue <= minValue) {
    return value >= maxValue ? 1 : 0;
  }

  return roundScore(Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue))));
};

const normalizeSymmetric = (value: number, scale: number): number => {
  if (!Number.isFinite(value) || scale <= 0) {
    return 0.5;
  }

  return roundScore(Math.max(0, Math.min(1, 0.5 + value / (2 * scale))));
};

const normalizeCategory = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const pushGroupedScore = (
  groupedScores: Map<string, ScopedSignalAccumulator>,
  scopeId: string | undefined,
  score: number,
  rewardScore = 0,
  rebateScore = 0
): void => {
  if (!scopeId || !Number.isFinite(score)) {
    return;
  }

  const bucket = groupedScores.get(scopeId);

  if (bucket) {
    bucket.total.push(score);
    bucket.reward.push(rewardScore);
    bucket.rebate.push(rebateScore);
    return;
  }

  groupedScores.set(scopeId, {
    total: [score],
    reward: [rewardScore],
    rebate: [rebateScore]
  });
};

const finalizeGroupedScores = (
  groupedScores: ReadonlyMap<string, ScopedSignalAccumulator>,
  options?: {
    rewardWeight?: number;
    rebateWeight?: number;
  }
): Map<string, number> => {
  const rewardWeight = options?.rewardWeight ?? 0;
  const rebateWeight = options?.rebateWeight ?? 0;

  return new Map(
    [...groupedScores.entries()].map(([scopeId, scores]) => {
      const baseScore = average(scores.total);
      const weightedScore =
        baseScore * (1 - rewardWeight - rebateWeight) +
        average(scores.reward) * rewardWeight +
        average(scores.rebate) * rebateWeight;

      return [scopeId, roundScore(weightedScore)];
    })
  );
};

const recordTradePerformance = (
  groupedPerformance: Map<string, ScopedTradePerformanceAccumulator>,
  scopeId: string | undefined,
  trade: PnlTradeRecord
): void => {
  if (!scopeId) {
    return;
  }

  const existing = groupedPerformance.get(scopeId) ?? {
    realizedPnlUsdc: 0,
    tradeCount: 0,
    winningTrades: 0,
    losingTrades: 0
  };

  existing.realizedPnlUsdc += trade.realizedPnlUsdc;
  existing.tradeCount += 1;

  if (trade.realizedPnlUsdc > 0) {
    existing.winningTrades += 1;
  } else if (trade.realizedPnlUsdc < 0) {
    existing.losingTrades += 1;
  }

  groupedPerformance.set(scopeId, existing);
};

const finalizeTradePerformanceScores = (
  groupedPerformance: ReadonlyMap<string, ScopedTradePerformanceAccumulator>
): Map<string, number> =>
  new Map(
    [...groupedPerformance.entries()].map(([scopeId, snapshot]) => {
      const decisiveTrades = snapshot.winningTrades + snapshot.losingTrades;
      const pnlScore = normalizeSymmetric(
        snapshot.realizedPnlUsdc,
        config.capital.intraDayPnlScaleUsdc
      );
      const winRateScore =
        decisiveTrades > 0 ? roundScore(snapshot.winningTrades / decisiveTrades) : 0.5;
      const activityScore = normalizeLinear(snapshot.tradeCount, 0, 8);

      return [scopeId, roundScore(pnlScore * 0.5 + winRateScore * 0.3 + activityScore * 0.2)];
    })
  );

const blendScopedSignalMaps = (
  selectionSignals: ReadonlyMap<string, number>,
  performanceSignals: ReadonlyMap<string, number>
): Map<string, number> => {
  const blended = new Map<string, number>();
  const scopeIds = new Set([
    ...selectionSignals.keys(),
    ...performanceSignals.keys()
  ]);
  const performanceWeight = config.capital.enableIntraDayStrategyReallocation
    ? config.capital.intraDayPerformanceWeight
    : 0;

  for (const scopeId of scopeIds) {
    const selectionScore = selectionSignals.get(scopeId) ?? 0.5;
    const performanceScore = performanceSignals.get(scopeId) ?? selectionScore;

    blended.set(
      scopeId,
      roundScore(selectionScore * (1 - performanceWeight) + performanceScore * performanceWeight)
    );
  }

  return blended;
};

export const buildScopedPerformanceCapitalSignals = (options: {
  trades: readonly PnlTradeRecord[];
  relevantStrategies: readonly StrategyName[];
  conditionToEventId?: ReadonlyMap<string, string>;
  conditionToCategory?: ReadonlyMap<string, string>;
}): ScopedCapitalSignals => {
  const relevantStrategies = new Set(options.relevantStrategies);
  const conditionPerformance = new Map<string, ScopedTradePerformanceAccumulator>();
  const eventPerformance = new Map<string, ScopedTradePerformanceAccumulator>();
  const categoryPerformance = new Map<string, ScopedTradePerformanceAccumulator>();

  for (const trade of options.trades) {
    if (!relevantStrategies.has(trade.strategy)) {
      continue;
    }

    const conditionId = trade.conditionId;
    const metadataEventId =
      typeof trade.metadata?.eventId === "string" ? trade.metadata.eventId : undefined;
    const metadataCategory =
      typeof trade.metadata?.category === "string"
        ? normalizeCategory(trade.metadata.category)
        : undefined;
    const eventId =
      metadataEventId ??
      (conditionId ? options.conditionToEventId?.get(conditionId) : undefined);
    const category =
      metadataCategory ??
      (conditionId ? options.conditionToCategory?.get(conditionId) : undefined);

    recordTradePerformance(conditionPerformance, conditionId, trade);
    recordTradePerformance(eventPerformance, eventId, trade);
    recordTradePerformance(categoryPerformance, category, trade);
  }

  return {
    byConditionId: finalizeTradePerformanceScores(conditionPerformance),
    byEventId: finalizeTradePerformanceScores(eventPerformance),
    byCategory: finalizeTradePerformanceScores(categoryPerformance)
  };
};

export const blendScopedCapitalSignals = (
  selectionSignals: ScopedCapitalSignals,
  performanceSignals: ScopedCapitalSignals
): ScopedCapitalSignals => ({
  byConditionId: blendScopedSignalMaps(
    selectionSignals.byConditionId,
    performanceSignals.byConditionId
  ),
  byEventId: blendScopedSignalMaps(selectionSignals.byEventId, performanceSignals.byEventId),
  byCategory: blendScopedSignalMaps(selectionSignals.byCategory, performanceSignals.byCategory)
});

const buildEmptySignal = (): StrategyCapitalSignal => ({
  score: 0.5,
  selectedCount: 0,
  components: {
    reward: 0,
    rebate: 0,
    liquidity: 0,
    activity: 0,
    spread: 0,
    structure: 0
  }
});

export const buildMarketScopedCapitalSignals = (
  selectedEntries: readonly RankedMarketSelection[]
): ScopedCapitalSignals => {
  const conditionScores = new Map<string, ScopedSignalAccumulator>();
  const eventScores = new Map<string, ScopedSignalAccumulator>();
  const categoryScores = new Map<string, ScopedSignalAccumulator>();

  for (const entry of selectedEntries) {
    pushGroupedScore(
      conditionScores,
      entry.market.conditionId,
      entry.breakdown.total,
      entry.breakdown.reward,
      entry.breakdown.rebate
    );
    pushGroupedScore(
      eventScores,
      entry.market.eventId,
      entry.breakdown.total,
      entry.breakdown.reward,
      entry.breakdown.rebate
    );
    pushGroupedScore(
      categoryScores,
      normalizeCategory(entry.market.category),
      entry.breakdown.total,
      entry.breakdown.reward,
      entry.breakdown.rebate
    );
  }

  return {
    byConditionId: finalizeGroupedScores(conditionScores, {
      rewardWeight: 0.2,
      rebateWeight: 0.2
    }),
    byEventId: finalizeGroupedScores(eventScores, {
      rewardWeight: 0.2,
      rebateWeight: 0.2
    }),
    byCategory: finalizeGroupedScores(categoryScores, {
      rewardWeight: 0.25,
      rebateWeight: 0.35
    })
  };
};

export const buildNegativeRiskScopedCapitalSignals = (
  selectedEntries: readonly RankedNegativeRiskGroupSelection[]
): ScopedCapitalSignals => {
  const conditionScores = new Map<string, ScopedSignalAccumulator>();
  const eventScores = new Map<string, ScopedSignalAccumulator>();
  const categoryScores = new Map<string, ScopedSignalAccumulator>();

  for (const entry of selectedEntries) {
    pushGroupedScore(
      eventScores,
      entry.group.eventId,
      entry.breakdown.total,
      entry.breakdown.reward,
      entry.breakdown.rebate
    );

    for (const market of entry.group.markets) {
      pushGroupedScore(
        conditionScores,
        market.conditionId,
        entry.breakdown.total,
        entry.breakdown.reward,
        entry.breakdown.rebate
      );
      pushGroupedScore(
        categoryScores,
        normalizeCategory(market.category),
        entry.breakdown.total,
        entry.breakdown.reward,
        entry.breakdown.rebate
      );
    }
  }

  return {
    byConditionId: finalizeGroupedScores(conditionScores, {
      rewardWeight: 0.1,
      rebateWeight: 0.15
    }),
    byEventId: finalizeGroupedScores(eventScores, {
      rewardWeight: 0.15,
      rebateWeight: 0.15
    }),
    byCategory: finalizeGroupedScores(categoryScores, {
      rewardWeight: 0.15,
      rebateWeight: 0.2
    })
  };
};

export const buildStrategyPerformanceCapitalSignal = (
  snapshots: readonly StrategyPnlSnapshot[]
): StrategyPerformanceCapitalSignal => {
  if (snapshots.length === 0) {
    return {
      score: 0.5,
      tradeCount: 0,
      components: {
        pnl: 0.5,
        winRate: 0.5,
        activity: 0
      }
    };
  }

  const dailyRealizedPnlUsdc = snapshots.reduce(
    (total, snapshot) => total + snapshot.dailyRealizedPnlUsdc,
    0
  );
  const winningTrades = snapshots.reduce((total, snapshot) => total + snapshot.winningTrades, 0);
  const losingTrades = snapshots.reduce((total, snapshot) => total + snapshot.losingTrades, 0);
  const dailyTradeCount = snapshots.reduce(
    (total, snapshot) => total + snapshot.dailyTradeCount,
    0
  );
  const decisiveTrades = winningTrades + losingTrades;
  const components = {
    pnl: normalizeSymmetric(dailyRealizedPnlUsdc, config.capital.intraDayPnlScaleUsdc),
    winRate:
      decisiveTrades > 0 ? roundScore(winningTrades / decisiveTrades) : 0.5,
    activity: normalizeLinear(dailyTradeCount, 0, 12)
  };

  return {
    score: roundScore(
      components.pnl * 0.5 + components.winRate * 0.3 + components.activity * 0.2
    ),
    tradeCount: dailyTradeCount,
    components
  };
};

export const blendCapitalSignalScores = (
  selectionScore: number,
  performanceScore: number
): number => {
  const weight = config.capital.enableIntraDayStrategyReallocation
    ? config.capital.intraDayPerformanceWeight
    : 0;

  return roundScore(
    selectionScore * (1 - weight) + performanceScore * weight
  );
};

export const buildMarketMakingCapitalSignal = (
  selectedEntries: readonly RankedMarketSelection[]
): StrategyCapitalSignal => {
  if (selectedEntries.length === 0) {
    return buildEmptySignal();
  }

  const components = {
    reward: roundScore(average(selectedEntries.map((entry) => entry.breakdown.reward))),
    rebate: roundScore(average(selectedEntries.map((entry) => entry.breakdown.rebate))),
    liquidity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.liquidity))),
    activity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.activity))),
    spread: roundScore(average(selectedEntries.map((entry) => entry.breakdown.spread))),
    structure: roundScore(average(selectedEntries.map((entry) => entry.breakdown.structure)))
  };

  return {
    score: roundScore(
      components.reward * 0.4 +
        components.rebate * 0.3 +
        components.liquidity * 0.15 +
        components.activity * 0.1 +
        components.spread * 0.05
    ),
    selectedCount: selectedEntries.length,
    components
  };
};

export const buildSameMarketArbCapitalSignal = (
  selectedEntries: readonly RankedMarketSelection[]
): StrategyCapitalSignal => {
  if (selectedEntries.length === 0) {
    return buildEmptySignal();
  }

  const components = {
    reward: roundScore(average(selectedEntries.map((entry) => entry.breakdown.reward))),
    rebate: roundScore(average(selectedEntries.map((entry) => entry.breakdown.rebate))),
    liquidity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.liquidity))),
    activity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.activity))),
    spread: roundScore(average(selectedEntries.map((entry) => entry.breakdown.spread))),
    structure: roundScore(average(selectedEntries.map((entry) => entry.breakdown.structure)))
  };

  return {
    score: roundScore(
      components.spread * 0.3 +
        components.activity * 0.25 +
        components.liquidity * 0.25 +
        components.rebate * 0.2
    ),
    selectedCount: selectedEntries.length,
    components
  };
};

export const buildNegativeRiskCapitalSignal = (
  selectedEntries: readonly RankedNegativeRiskGroupSelection[]
): StrategyCapitalSignal => {
  if (selectedEntries.length === 0) {
    return buildEmptySignal();
  }

  const components = {
    reward: roundScore(average(selectedEntries.map((entry) => entry.breakdown.reward))),
    rebate: roundScore(average(selectedEntries.map((entry) => entry.breakdown.rebate))),
    liquidity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.liquidity))),
    activity: roundScore(average(selectedEntries.map((entry) => entry.breakdown.activity))),
    spread: roundScore(average(selectedEntries.map((entry) => entry.breakdown.spread))),
    structure: roundScore(average(selectedEntries.map((entry) => entry.breakdown.structure)))
  };

  return {
    score: roundScore(
      components.structure * 0.3 +
        components.spread * 0.2 +
        components.activity * 0.2 +
        components.liquidity * 0.15 +
        components.reward * 0.1 +
        components.rebate * 0.05
    ),
    selectedCount: selectedEntries.length,
    components
  };
};
