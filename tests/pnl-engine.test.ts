import { describe, expect, it } from "vitest";

import { PnLEngine } from "../src/core/pnl-engine.js";

describe("PnLEngine", () => {
  it("aggregates realized pnl by strategy and portfolio", () => {
    const engine = new PnLEngine(undefined, {
      now: () => new Date(2026, 2, 29, 12, 0, 0).getTime()
    });

    engine.recordTrade({
      id: "trade-1",
      strategy: "same-market-arb",
      marketScope: "market-a",
      conditionId: "condition-a",
      realizedPnlUsdc: 1.25,
      expectedEdgeUsdc: 1.1,
      shares: 5,
      openedAtMs: new Date(2026, 2, 29, 11, 59, 0).getTime(),
      closedAtMs: new Date(2026, 2, 29, 12, 0, 0).getTime(),
      detail: "fully filled",
      tags: ["same-market-arb", "fully_filled"]
    });
    engine.recordTrade({
      id: "trade-2",
      strategy: "negative-risk",
      marketScope: "event-a",
      realizedPnlUsdc: -0.4,
      expectedEdgeUsdc: 0.2,
      shares: 4,
      closedAtMs: new Date(2026, 2, 29, 12, 1, 0).getTime(),
      detail: "emergency unwind",
      tags: ["negative-risk", "emergency_unwind"]
    });

    const sameMarketSnapshot = engine.getStrategySnapshot("same-market-arb");
    const negativeRiskSnapshot = engine.getStrategySnapshot("negative-risk");
    const portfolioSnapshot = engine.getPortfolioSnapshot();

    expect(sameMarketSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(1.25, 8);
    expect(sameMarketSnapshot.lifetimeTradeCount).toBe(1);
    expect(negativeRiskSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(-0.4, 8);
    expect(negativeRiskSnapshot.losingTrades).toBe(1);
    expect(portfolioSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(0.85, 8);
    expect(portfolioSnapshot.lifetimeTradeCount).toBe(2);
    expect(portfolioSnapshot.byStrategy["same-market-arb"]?.dailyTradeCount).toBe(1);
    expect(portfolioSnapshot.byStrategy["negative-risk"]?.dailyTradeCount).toBe(1);
  });

  it("tracks gross, fee, reward, rebate, slippage, and unfilled components in net pnl", () => {
    const engine = new PnLEngine(undefined, {
      now: () => new Date(2026, 2, 29, 12, 0, 0).getTime()
    });

    engine.recordTrade({
      id: "trade-components",
      strategy: "same-market-arb",
      marketScope: "market-a",
      conditionId: "condition-a",
      grossRealizedPnlUsdc: 1.4,
      feeCostUsdc: 0.2,
      rebateUsdc: 0.05,
      rewardUsdc: 0.1,
      slippageCostUsdc: 0.15,
      unfilledCostUsdc: 0.05,
      gasCostUsdc: 0.02,
      shares: 5,
      closedAtMs: new Date(2026, 2, 29, 12, 0, 0).getTime(),
      tags: ["same-market-arb", "component-test"]
    });

    const strategySnapshot = engine.getStrategySnapshot("same-market-arb");
    const portfolioSnapshot = engine.getPortfolioSnapshot();
    const recentTrade = engine.getRecentTrades(1)[0]!;

    expect(recentTrade.realizedPnlUsdc).toBeCloseTo(1.13, 8);
    expect(recentTrade.grossRealizedPnlUsdc).toBeCloseTo(1.4, 8);
    expect(strategySnapshot.dailyFeeCostUsdc).toBeCloseTo(0.2, 8);
    expect(strategySnapshot.dailyRebateUsdc).toBeCloseTo(0.05, 8);
    expect(strategySnapshot.dailyRewardUsdc).toBeCloseTo(0.1, 8);
    expect(strategySnapshot.dailySlippageCostUsdc).toBeCloseTo(0.15, 8);
    expect(strategySnapshot.dailyUnfilledCostUsdc).toBeCloseTo(0.05, 8);
    expect(strategySnapshot.dailyGasCostUsdc).toBeCloseTo(0.02, 8);
    expect(portfolioSnapshot.dailyGrossRealizedPnlUsdc).toBeCloseTo(1.4, 8);
    expect(portfolioSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(1.13, 8);
  });

  it("resets daily snapshots on a new day while preserving lifetime totals", () => {
    let now = new Date(2026, 2, 29, 23, 59, 0).getTime();
    const engine = new PnLEngine(undefined, {
      now: () => now
    });

    engine.recordTrade({
      id: "trade-1",
      strategy: "same-market-arb",
      marketScope: "market-a",
      conditionId: "condition-a",
      realizedPnlUsdc: 1,
      shares: 5,
      closedAtMs: now,
      tags: ["same-market-arb"]
    });

    now = new Date(2026, 2, 30, 0, 1, 0).getTime();

    const beforeNewTrade = engine.getPortfolioSnapshot();
    expect(beforeNewTrade.dayKey).toBe("2026-03-30");
    expect(beforeNewTrade.dailyRealizedPnlUsdc).toBe(0);
    expect(beforeNewTrade.lifetimeRealizedPnlUsdc).toBe(1);

    engine.recordTrade({
      id: "trade-2",
      strategy: "negative-risk",
      marketScope: "event-a",
      realizedPnlUsdc: 0.5,
      shares: 3,
      closedAtMs: now,
      tags: ["negative-risk"]
    });

    const portfolioSnapshot = engine.getPortfolioSnapshot();
    expect(portfolioSnapshot.dayKey).toBe("2026-03-30");
    expect(portfolioSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(0.5, 8);
    expect(portfolioSnapshot.lifetimeRealizedPnlUsdc).toBeCloseTo(1.5, 8);
    expect(engine.getRecentTrades(1)[0]?.id).toBe("trade-2");
  });

  it("adds open inventory MTM to official portfolio net pnl snapshots", () => {
    const engine = new PnLEngine(undefined, {
      now: () => new Date(2026, 2, 29, 12, 0, 0).getTime(),
      inventoryValuationProvider: () => ({
        openInventoryCostUsdc: 3.2,
        openInventoryMarkValueUsdc: 3.6,
        openInventoryUnrealizedPnlUsdc: 0.4,
        pricedOpenTokenCount: 1,
        unpricedOpenTokenCount: 0
      })
    });

    engine.recordTrade({
      id: "trade-net",
      strategy: "market-making",
      marketScope: "market-a",
      realizedPnlUsdc: 1.1,
      closedAtMs: new Date(2026, 2, 29, 12, 0, 0).getTime(),
      tags: ["market-making"]
    });

    const portfolioSnapshot = engine.getPortfolioSnapshot();

    expect(portfolioSnapshot.dailyRealizedPnlUsdc).toBeCloseTo(1.1, 8);
    expect(portfolioSnapshot.dailyNetPnlUsdc).toBeCloseTo(1.5, 8);
    expect(portfolioSnapshot.lifetimeNetPnlUsdc).toBeCloseTo(1.5, 8);
    expect(portfolioSnapshot.openInventoryCostUsdc).toBeCloseTo(3.2, 8);
    expect(portfolioSnapshot.openInventoryMarkValueUsdc).toBeCloseTo(3.6, 8);
    expect(portfolioSnapshot.openInventoryUnrealizedPnlUsdc).toBeCloseTo(0.4, 8);
  });
});
