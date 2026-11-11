import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { InventoryLotTracker } from "../src/core/inventory-lot-tracker.js";
import type {
  PnlTradeRecordInput,
  PnLEngineLike,
  RiskManagerLike,
  StrategyPnlSnapshot,
  PortfolioPnlSnapshot
} from "../src/core/types.js";
import type { BinaryMarket } from "../src/types.js";
import { ResolvedMarketClaimService } from "../src/trading/resolved-market-claim-service.js";

const closedBinaryMarket: BinaryMarket = {
  id: "market-1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "Milwaukee Brewers vs Boston Red Sox",
  slug: "mlb-mil-bos-2026-04-08",
  category: "Sports",
  outcomes: ["Milwaukee Brewers", "Boston Red Sox"],
  tokenIds: ["brewers-token", "red-sox-token"],
  active: false,
  closed: true,
  acceptingOrders: false,
  enableOrderBook: false,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: false
};

const emptyStrategySnapshot: StrategyPnlSnapshot = {
  strategy: "market-making",
  dayKey: "2026-04-09",
  dailyRealizedPnlUsdc: 0,
  lifetimeRealizedPnlUsdc: 0,
  dailyGrossRealizedPnlUsdc: 0,
  lifetimeGrossRealizedPnlUsdc: 0,
  dailyFeeCostUsdc: 0,
  lifetimeFeeCostUsdc: 0,
  dailyRebateUsdc: 0,
  lifetimeRebateUsdc: 0,
  dailyRewardUsdc: 0,
  lifetimeRewardUsdc: 0,
  dailySlippageCostUsdc: 0,
  lifetimeSlippageCostUsdc: 0,
  dailyUnfilledCostUsdc: 0,
  lifetimeUnfilledCostUsdc: 0,
  dailyGasCostUsdc: 0,
  lifetimeGasCostUsdc: 0,
  dailyTradeCount: 0,
  lifetimeTradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0
};

const emptyPortfolioSnapshot: PortfolioPnlSnapshot = {
  dayKey: "2026-04-09",
  dailyRealizedPnlUsdc: 0,
  lifetimeRealizedPnlUsdc: 0,
  dailyGrossRealizedPnlUsdc: 0,
  lifetimeGrossRealizedPnlUsdc: 0,
  dailyFeeCostUsdc: 0,
  lifetimeFeeCostUsdc: 0,
  dailyRebateUsdc: 0,
  lifetimeRebateUsdc: 0,
  dailyRewardUsdc: 0,
  lifetimeRewardUsdc: 0,
  dailySlippageCostUsdc: 0,
  lifetimeSlippageCostUsdc: 0,
  dailyUnfilledCostUsdc: 0,
  lifetimeUnfilledCostUsdc: 0,
  dailyGasCostUsdc: 0,
  lifetimeGasCostUsdc: 0,
  dailyTradeCount: 0,
  lifetimeTradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0,
  byStrategy: {}
};

describe("ResolvedMarketClaimService", () => {
  const originalEnableResolvedClaim = config.marketMaker.enableResolvedClaim;

  afterEach(() => {
    (config.marketMaker as { enableResolvedClaim: boolean }).enableResolvedClaim =
      originalEnableResolvedClaim;
    vi.restoreAllMocks();
  });

  it("claims resolved complementary inventory and settles both winner and loser lots into realized pnl", async () => {
    (config.marketMaker as { enableResolvedClaim: boolean }).enableResolvedClaim = true;
    const tracker = new InventoryLotTracker();
    tracker.addLot({
      lotId: "lot-brewers",
      strategy: "market-making",
      tokenId: "brewers-token",
      marketScope: closedBinaryMarket.slug,
      conditionId: closedBinaryMarket.conditionId,
      outcome: "Milwaukee Brewers",
      shares: 12,
      totalCostUsdc: 5.28,
      openedAtMs: 1
    });
    tracker.addLot({
      lotId: "lot-red-sox",
      strategy: "market-making",
      tokenId: "red-sox-token",
      marketScope: closedBinaryMarket.slug,
      conditionId: closedBinaryMarket.conditionId,
      outcome: "Boston Red Sox",
      shares: 12,
      totalCostUsdc: 6.72,
      openedAtMs: 2
    });

    const recordedTrades: PnlTradeRecordInput[] = [];
    const pnlEngine: PnLEngineLike = {
      recordTrade: vi.fn((trade: PnlTradeRecordInput) => {
        recordedTrades.push(trade);
        return {
          trade: trade as never,
          strategySnapshot: emptyStrategySnapshot,
          portfolioSnapshot: emptyPortfolioSnapshot
        };
      }),
      getStrategySnapshot: vi.fn(() => emptyStrategySnapshot),
      getPortfolioSnapshot: vi.fn(() => emptyPortfolioSnapshot),
      getRecentTrades: vi.fn(() => []),
      exportTrades: vi.fn(() => [])
    };
    const riskManager: RiskManagerLike = {
      evaluateIntent: vi.fn(() => ({ allowed: true, state: "RUNNING" })),
      noteTradeClosed: vi.fn(() => ({ allowed: true, state: "RUNNING" }))
    };
    const onInventoryChanged = vi.fn();
    const fetchResolution = vi.fn().mockResolvedValue({
      market: closedBinaryMarket,
      payoutFractions: [0, 1] as const,
      closedTime: "2026-04-09T00:00:00.000Z"
    });
    const executeClaim = vi.fn().mockResolvedValue({ txHash: "0xclaimtx" });

    const service = new ResolvedMarketClaimService({
      client: {} as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never,
      inventoryTracker: tracker,
      pnlEngine,
      riskManager,
      onInventoryChanged,
      fetchResolution,
      executeClaim
    });

    await service.runOnce();

    expect(fetchResolution).toHaveBeenCalledWith(closedBinaryMarket.slug);
    expect(executeClaim).toHaveBeenCalledTimes(1);
    expect(tracker.exportOpenLots()).toEqual([]);
    expect(recordedTrades).toHaveLength(2);
    expect(recordedTrades.map((trade) => trade.marketScope)).toEqual([
      closedBinaryMarket.slug,
      closedBinaryMarket.slug
    ]);
    expect(recordedTrades.map((trade) => trade.realizedPnlUsdc)).toEqual([-5.28, 5.28]);
    expect(recordedTrades.every((trade) => trade.tags.includes("resolved-claim"))).toBe(true);
    expect(riskManager.noteTradeClosed).toHaveBeenCalledTimes(2);
    expect(onInventoryChanged).toHaveBeenCalledTimes(1);
  });

  it("skips claim execution when the resolved condition does not match the tracked lots", async () => {
    (config.marketMaker as { enableResolvedClaim: boolean }).enableResolvedClaim = true;
    const tracker = new InventoryLotTracker();
    tracker.addLot({
      lotId: "lot-red-sox",
      strategy: "market-making",
      tokenId: "red-sox-token",
      marketScope: closedBinaryMarket.slug,
      conditionId: "different-condition",
      outcome: "Boston Red Sox",
      shares: 12,
      totalCostUsdc: 6.72,
      openedAtMs: 2
    });

    const executeClaim = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const service = new ResolvedMarketClaimService({
      client: {} as never,
      logger: logger as never,
      inventoryTracker: tracker,
      pnlEngine: {
        recordTrade: vi.fn(() => ({
          trade: {} as never,
          strategySnapshot: emptyStrategySnapshot,
          portfolioSnapshot: emptyPortfolioSnapshot
        })),
        getStrategySnapshot: vi.fn(() => emptyStrategySnapshot),
        getPortfolioSnapshot: vi.fn(() => emptyPortfolioSnapshot),
        getRecentTrades: vi.fn(() => []),
        exportTrades: vi.fn(() => [])
      },
      fetchResolution: vi.fn().mockResolvedValue({
        market: closedBinaryMarket,
        payoutFractions: [0, 1] as const
      }),
      executeClaim
    });

    await service.runOnce();

    expect(executeClaim).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(tracker.exportOpenLots()).toHaveLength(1);
  });
});
