import type { Logger } from "pino";

import type {
  InventoryValuationSnapshot,
  PnLEngineLike,
  PnlTradeRecord,
  PnlTradeRecordInput,
  PortfolioPnlSnapshot,
  RecordedTradePnl,
  StrategyName,
  StrategyPnlSnapshot
} from "./types.js";

type Aggregate = {
  realizedPnlUsdc: number;
  grossRealizedPnlUsdc: number;
  feeCostUsdc: number;
  rebateUsdc: number;
  rewardUsdc: number;
  slippageCostUsdc: number;
  unfilledCostUsdc: number;
  gasCostUsdc: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  lastTradeAtMs?: number;
};

type PnLEngineOptions = {
  now?: () => number;
  maxRecords?: number;
  inventoryValuationProvider?: () => InventoryValuationSnapshot | undefined;
};

const EMPTY_INVENTORY_VALUATION: InventoryValuationSnapshot = {
  openInventoryCostUsdc: 0,
  openInventoryMarkValueUsdc: 0,
  openInventoryUnrealizedPnlUsdc: 0,
  pricedOpenTokenCount: 0,
  unpricedOpenTokenCount: 0
};

const createEmptyAggregate = (): Aggregate => ({
  realizedPnlUsdc: 0,
  grossRealizedPnlUsdc: 0,
  feeCostUsdc: 0,
  rebateUsdc: 0,
  rewardUsdc: 0,
  slippageCostUsdc: 0,
  unfilledCostUsdc: 0,
  gasCostUsdc: 0,
  tradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0
});

const formatDayKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const cloneAggregate = (aggregate: Aggregate): Aggregate => ({
  ...aggregate
});

const updateAggregate = (aggregate: Aggregate, trade: PnlTradeRecord): void => {
  aggregate.realizedPnlUsdc += trade.realizedPnlUsdc;
  aggregate.grossRealizedPnlUsdc += trade.grossRealizedPnlUsdc;
  aggregate.feeCostUsdc += trade.feeCostUsdc;
  aggregate.rebateUsdc += trade.rebateUsdc;
  aggregate.rewardUsdc += trade.rewardUsdc;
  aggregate.slippageCostUsdc += trade.slippageCostUsdc;
  aggregate.unfilledCostUsdc += trade.unfilledCostUsdc;
  aggregate.gasCostUsdc += trade.gasCostUsdc;
  aggregate.tradeCount += 1;
  aggregate.lastTradeAtMs = trade.closedAtMs;

  // Floating point break-even tolerance — costBasis 와 proceeds 가 정확히 같은
  // maker SELL close 도 JS 부동소수점 연산 후 -4.4e-16 같은 노이즈를 남김.
  // ±$0.001 (= 1μ USDC) 이내면 flat 으로 분류.
  const FLAT_PNL_EPSILON_USDC = 1e-3;
  if (trade.realizedPnlUsdc > FLAT_PNL_EPSILON_USDC) {
    aggregate.winningTrades += 1;
    return;
  }

  if (trade.realizedPnlUsdc < -FLAT_PNL_EPSILON_USDC) {
    aggregate.losingTrades += 1;
    return;
  }

  aggregate.flatTrades += 1;
};

export class PnLEngine implements PnLEngineLike {
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly inventoryValuationProvider: (() => InventoryValuationSnapshot | undefined) | undefined;
  private dayKey: string;
  private readonly trades: PnlTradeRecord[] = [];
  private readonly lifetimeByStrategy = new Map<StrategyName, Aggregate>();
  private readonly dailyByStrategy = new Map<StrategyName, Aggregate>();
  private lifetimePortfolio = createEmptyAggregate();
  private dailyPortfolio = createEmptyAggregate();

  constructor(
    private readonly logger?: Logger,
    options?: PnLEngineOptions
  ) {
    this.now = options?.now ?? (() => Date.now());
    this.maxRecords = Math.max(1, options?.maxRecords ?? 1_000);
    this.inventoryValuationProvider = options?.inventoryValuationProvider;
    this.dayKey = formatDayKey(this.now());
  }

  recordTrade(
    record: PnlTradeRecordInput
  ): RecordedTradePnl {
    const closedAtMs = record.closedAtMs ?? this.now();
    const nextDayKey = record.dayKey ?? formatDayKey(closedAtMs);
    const feeCostUsdc = record.feeCostUsdc ?? 0;
    const rebateUsdc = record.rebateUsdc ?? 0;
    const rewardUsdc = record.rewardUsdc ?? 0;
    const slippageCostUsdc = record.slippageCostUsdc ?? 0;
    const unfilledCostUsdc = record.unfilledCostUsdc ?? 0;
    const gasCostUsdc = record.gasCostUsdc ?? 0;
    const providedNetRealizedPnlUsdc = record.realizedPnlUsdc;
    const providedGrossRealizedPnlUsdc = record.grossRealizedPnlUsdc;

    if (
      typeof providedNetRealizedPnlUsdc !== "number" &&
      typeof providedGrossRealizedPnlUsdc !== "number"
    ) {
      throw new Error("PnLEngine.recordTrade requires realizedPnlUsdc or grossRealizedPnlUsdc.");
    }

    const grossRealizedPnlUsdc =
      providedGrossRealizedPnlUsdc ??
      ((providedNetRealizedPnlUsdc ?? 0) +
        feeCostUsdc +
        slippageCostUsdc +
        unfilledCostUsdc +
        gasCostUsdc -
        rebateUsdc -
        rewardUsdc);
    const realizedPnlUsdc =
      providedNetRealizedPnlUsdc ??
      (grossRealizedPnlUsdc -
        feeCostUsdc -
        slippageCostUsdc -
        unfilledCostUsdc -
        gasCostUsdc +
        rebateUsdc +
        rewardUsdc);

    this.rollDayIfNeeded(nextDayKey);

    const normalizedRecord: PnlTradeRecord = {
      ...record,
      dayKey: nextDayKey,
      realizedPnlUsdc,
      grossRealizedPnlUsdc,
      feeCostUsdc,
      rebateUsdc,
      rewardUsdc,
      slippageCostUsdc,
      unfilledCostUsdc,
      gasCostUsdc,
      closedAtMs,
      tags: [...record.tags]
    };

    this.trades.push(normalizedRecord);

    if (this.trades.length > this.maxRecords) {
      this.trades.splice(0, this.trades.length - this.maxRecords);
    }

    const lifetimeStrategy = this.getOrCreateAggregate(this.lifetimeByStrategy, record.strategy);
    const dailyStrategy = this.getOrCreateAggregate(this.dailyByStrategy, record.strategy);

    updateAggregate(lifetimeStrategy, normalizedRecord);
    updateAggregate(dailyStrategy, normalizedRecord);
    updateAggregate(this.lifetimePortfolio, normalizedRecord);
    updateAggregate(this.dailyPortfolio, normalizedRecord);

    const strategySnapshot = this.getStrategySnapshot(record.strategy);
    const portfolioSnapshot = this.getPortfolioSnapshot();

    this.logger?.info(
      {
        trade: normalizedRecord,
        strategySnapshot,
        portfolioSnapshot
      },
      "Recorded realized trade PnL."
    );

    return {
      trade: normalizedRecord,
      strategySnapshot,
      portfolioSnapshot
    };
  }

  getStrategySnapshot(strategy: StrategyName): StrategyPnlSnapshot {
    this.rollDayIfNeeded(formatDayKey(this.now()));
    const lifetime = cloneAggregate(this.lifetimeByStrategy.get(strategy) ?? createEmptyAggregate());
    const daily = cloneAggregate(this.dailyByStrategy.get(strategy) ?? createEmptyAggregate());

    return {
      strategy,
      dayKey: this.dayKey,
      dailyRealizedPnlUsdc: daily.realizedPnlUsdc,
      lifetimeRealizedPnlUsdc: lifetime.realizedPnlUsdc,
      dailyGrossRealizedPnlUsdc: daily.grossRealizedPnlUsdc,
      lifetimeGrossRealizedPnlUsdc: lifetime.grossRealizedPnlUsdc,
      dailyFeeCostUsdc: daily.feeCostUsdc,
      lifetimeFeeCostUsdc: lifetime.feeCostUsdc,
      dailyRebateUsdc: daily.rebateUsdc,
      lifetimeRebateUsdc: lifetime.rebateUsdc,
      dailyRewardUsdc: daily.rewardUsdc,
      lifetimeRewardUsdc: lifetime.rewardUsdc,
      dailySlippageCostUsdc: daily.slippageCostUsdc,
      lifetimeSlippageCostUsdc: lifetime.slippageCostUsdc,
      dailyUnfilledCostUsdc: daily.unfilledCostUsdc,
      lifetimeUnfilledCostUsdc: lifetime.unfilledCostUsdc,
      dailyGasCostUsdc: daily.gasCostUsdc,
      lifetimeGasCostUsdc: lifetime.gasCostUsdc,
      dailyTradeCount: daily.tradeCount,
      lifetimeTradeCount: lifetime.tradeCount,
      winningTrades: lifetime.winningTrades,
      losingTrades: lifetime.losingTrades,
      flatTrades: lifetime.flatTrades,
      dailyWinningTrades: daily.winningTrades,
      dailyLosingTrades: daily.losingTrades,
      dailyFlatTrades: daily.flatTrades,
      lastTradeAtMs: lifetime.lastTradeAtMs
    };
  }

  getPortfolioSnapshot(): PortfolioPnlSnapshot {
    this.rollDayIfNeeded(formatDayKey(this.now()));
    const byStrategy: Partial<Record<StrategyName, StrategyPnlSnapshot>> = {};
    const inventoryValuation = this.inventoryValuationProvider?.() ?? EMPTY_INVENTORY_VALUATION;

    for (const strategy of new Set([
      ...this.lifetimeByStrategy.keys(),
      ...this.dailyByStrategy.keys()
    ])) {
      byStrategy[strategy] = this.getStrategySnapshot(strategy);
    }

    return {
      dayKey: this.dayKey,
      dailyRealizedPnlUsdc: this.dailyPortfolio.realizedPnlUsdc,
      lifetimeRealizedPnlUsdc: this.lifetimePortfolio.realizedPnlUsdc,
      dailyGrossRealizedPnlUsdc: this.dailyPortfolio.grossRealizedPnlUsdc,
      lifetimeGrossRealizedPnlUsdc: this.lifetimePortfolio.grossRealizedPnlUsdc,
      dailyFeeCostUsdc: this.dailyPortfolio.feeCostUsdc,
      lifetimeFeeCostUsdc: this.lifetimePortfolio.feeCostUsdc,
      dailyRebateUsdc: this.dailyPortfolio.rebateUsdc,
      lifetimeRebateUsdc: this.lifetimePortfolio.rebateUsdc,
      dailyRewardUsdc: this.dailyPortfolio.rewardUsdc,
      lifetimeRewardUsdc: this.lifetimePortfolio.rewardUsdc,
      dailySlippageCostUsdc: this.dailyPortfolio.slippageCostUsdc,
      lifetimeSlippageCostUsdc: this.lifetimePortfolio.slippageCostUsdc,
      dailyUnfilledCostUsdc: this.dailyPortfolio.unfilledCostUsdc,
      lifetimeUnfilledCostUsdc: this.lifetimePortfolio.unfilledCostUsdc,
      dailyGasCostUsdc: this.dailyPortfolio.gasCostUsdc,
      lifetimeGasCostUsdc: this.lifetimePortfolio.gasCostUsdc,
      dailyTradeCount: this.dailyPortfolio.tradeCount,
      lifetimeTradeCount: this.lifetimePortfolio.tradeCount,
      winningTrades: this.lifetimePortfolio.winningTrades,
      losingTrades: this.lifetimePortfolio.losingTrades,
      flatTrades: this.lifetimePortfolio.flatTrades,
      lastTradeAtMs: this.lifetimePortfolio.lastTradeAtMs,
      dailyNetPnlUsdc:
        this.dailyPortfolio.realizedPnlUsdc + inventoryValuation.openInventoryUnrealizedPnlUsdc,
      lifetimeNetPnlUsdc:
        this.lifetimePortfolio.realizedPnlUsdc + inventoryValuation.openInventoryUnrealizedPnlUsdc,
      ...inventoryValuation,
      byStrategy
    };
  }

  getRecentTrades(limit = 20): PnlTradeRecord[] {
    const boundedLimit = Math.max(0, limit);
    return this.trades.slice(-boundedLimit).reverse().map((trade) => ({
      ...trade,
      tags: [...trade.tags],
      metadata: trade.metadata ? { ...trade.metadata } : undefined
    }));
  }

  exportTrades(limit = this.maxRecords): PnlTradeRecord[] {
    const boundedLimit = Math.max(0, limit);
    return this.trades.slice(-boundedLimit).map((trade) => ({
      ...trade,
      tags: [...trade.tags],
      metadata: trade.metadata ? { ...trade.metadata } : undefined
    }));
  }

  private getOrCreateAggregate(
    store: Map<StrategyName, Aggregate>,
    strategy: StrategyName
  ): Aggregate {
    const existing = store.get(strategy);

    if (existing) {
      return existing;
    }

    const created = createEmptyAggregate();
    store.set(strategy, created);
    return created;
  }

  private rollDayIfNeeded(nextDayKey: string): void {
    if (nextDayKey === this.dayKey) {
      return;
    }

    this.dayKey = nextDayKey;
    this.dailyPortfolio = createEmptyAggregate();
    this.dailyByStrategy.clear();
  }
}
