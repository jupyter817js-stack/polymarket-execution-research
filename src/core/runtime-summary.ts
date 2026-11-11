import { buildRiskBudgetAdjustmentSnapshot } from "./capital-allocator.js";
import { buildRiskExecutionThrottleSnapshot } from "./degraded-execution-policy.js";
import { ExecutionEngine } from "./execution-engine.js";
import type { InventoryLotSnapshot } from "./inventory-lot-tracker.js";
import { buildOperatingKpiSummary } from "./operating-kpis.js";
import type { PnLEngineLike, RiskManagerLike, StrategyName } from "./types.js";

type BuildMonitoringSnapshotOptions = {
  executionEngine: ExecutionEngine;
  pnlEngine: PnLEngineLike;
  riskManager: RiskManagerLike;
  runtime: string;
  monitoringIntervalMs: number;
  inventoryLots?: readonly InventoryLotSnapshot[];
};

const sortStrategies = (strategies: readonly StrategyName[]): StrategyName[] =>
  [...strategies].sort((left, right) => left.localeCompare(right));

export const buildMonitoringSnapshotPayload = (
  options: BuildMonitoringSnapshotOptions
) => {
  const portfolio = options.pnlEngine.getPortfolioSnapshot();
  const recentTrade = options.pnlEngine.getRecentTrades(1)[0];
  const risk =
    options.riskManager.getSnapshot?.() ?? {
      state: options.riskManager.getState?.() ?? "RUNNING"
    };
  const riskBudgetAdjustment = buildRiskBudgetAdjustmentSnapshot(
    "dayKey" in risk ? risk : undefined
  );
  const executionThrottle = buildRiskExecutionThrottleSnapshot(
    "dayKey" in risk ? risk : undefined
  );
  const activeOrders = options.executionEngine.getActiveOrders();
  const exportedTrades = options.pnlEngine.exportTrades();
  const dailyTrades = exportedTrades.filter((trade) => trade.dayKey === portfolio.dayKey);
  const kpis = buildOperatingKpiSummary({
    dayKey: portfolio.dayKey,
    dailyTradeCount: portfolio.dailyTradeCount,
    dailyRealizedPnlUsdc: portfolio.dailyRealizedPnlUsdc,
    dailyGrossRealizedPnlUsdc: portfolio.dailyGrossRealizedPnlUsdc,
    dailyRewardUsdc: portfolio.dailyRewardUsdc,
    dailyRebateUsdc: portfolio.dailyRebateUsdc,
    trades: dailyTrades,
    openLots: options.inventoryLots
  });
  const activeOrdersByStrategy = activeOrders.reduce(
    (accumulator, order) => {
      accumulator[order.strategy] = (accumulator[order.strategy] ?? 0) + 1;
      return accumulator;
    },
    {} as Partial<Record<StrategyName, number>>
  );
  const activeConditions = new Set(activeOrders.map((order) => order.conditionId)).size;
  const strategies = sortStrategies(Object.keys(portfolio.byStrategy) as StrategyName[]).map(
    (strategy) => {
      const snapshot = portfolio.byStrategy[strategy]!;
      return {
        strategy,
        dailyRealizedPnlUsdc: snapshot.dailyRealizedPnlUsdc,
        dailyGrossRealizedPnlUsdc: snapshot.dailyGrossRealizedPnlUsdc,
        dailyFeeCostUsdc: snapshot.dailyFeeCostUsdc,
        dailyRebateUsdc: snapshot.dailyRebateUsdc,
        dailyRewardUsdc: snapshot.dailyRewardUsdc,
        dailyTradeCount: snapshot.dailyTradeCount,
        lifetimeRealizedPnlUsdc: snapshot.lifetimeRealizedPnlUsdc,
        lifetimeTradeCount: snapshot.lifetimeTradeCount
      };
    }
  );

  return {
    summaryType: "monitoring_snapshot" as const,
    schemaVersion: 1 as const,
    runtime: options.runtime,
    monitoringIntervalMs: options.monitoringIntervalMs,
    risk,
    riskBudgetAdjustment,
    executionThrottle,
    kpis,
    portfolio: {
      dayKey: portfolio.dayKey,
      dailyRealizedPnlUsdc: portfolio.dailyRealizedPnlUsdc,
      dailyGrossRealizedPnlUsdc: portfolio.dailyGrossRealizedPnlUsdc,
      dailyNetPnlUsdc: portfolio.dailyNetPnlUsdc,
      dailyFeeCostUsdc: portfolio.dailyFeeCostUsdc,
      dailyRebateUsdc: portfolio.dailyRebateUsdc,
      dailyRewardUsdc: portfolio.dailyRewardUsdc,
      dailySlippageCostUsdc: portfolio.dailySlippageCostUsdc,
      dailyUnfilledCostUsdc: portfolio.dailyUnfilledCostUsdc,
      lifetimeRealizedPnlUsdc: portfolio.lifetimeRealizedPnlUsdc,
      lifetimeNetPnlUsdc: portfolio.lifetimeNetPnlUsdc,
      openInventoryCostUsdc: portfolio.openInventoryCostUsdc,
      openInventoryMarkValueUsdc: portfolio.openInventoryMarkValueUsdc,
      openInventoryUnrealizedPnlUsdc: portfolio.openInventoryUnrealizedPnlUsdc,
      pricedOpenTokenCount: portfolio.pricedOpenTokenCount,
      unpricedOpenTokenCount: portfolio.unpricedOpenTokenCount,
      dailyTradeCount: portfolio.dailyTradeCount,
      lifetimeTradeCount: portfolio.lifetimeTradeCount
    },
    strategies,
    activeOrders: {
      total: activeOrders.length,
      activeConditions,
      byStrategy: activeOrdersByStrategy
    },
    recentTrade:
      recentTrade
        ? {
            id: recentTrade.id,
            strategy: recentTrade.strategy,
            marketScope: recentTrade.marketScope,
            realizedPnlUsdc: recentTrade.realizedPnlUsdc,
            closedAtMs: recentTrade.closedAtMs,
            tags: recentTrade.tags
          }
        : undefined
  };
};
