import { afterEach, describe, expect, it, vi } from "vitest";
import { OrderType, Side } from "@polymarket/clob-client-v2";

import { config } from "../src/config.js";
import { MarketMakerBot } from "../src/market-maker-bot.js";
import type { UserOrderFillProgressEvent } from "../src/polymarket/user-ws.js";
import type { BinaryMarket } from "../src/types.js";

const market: BinaryMarket = {
  id: "market-1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "Will BTC be above 120k?",
  slug: "btc-above-120k",
  category: "Crypto",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: true,
  negRisk: false
};

const fillProgressEvent: UserOrderFillProgressEvent = {
  orderId: "order-1",
  market: market.slug,
  assetId: market.tokenIds[0],
  side: "SELL",
  price: 0.52,
  originalSize: 20,
  matchedSize: 5,
  deltaMatchedSize: 5,
  status: "MATCHED",
  isTerminal: false
};

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const portfolioSnapshot = () => ({
  dayKey: "2026-04-24",
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
  lifetimeNetPnlUsdc: 0,
  byStrategy: {}
});

const strategySnapshot = (strategy: string) => ({
  strategy,
  dayKey: "2026-04-24",
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
  dailyWinningTrades: 0,
  dailyLosingTrades: 0,
  dailyFlatTrades: 0
});

describe("MarketMakerBot", () => {
  const originalQuotePostedIncludePassiveSells =
    config.alerting.quotePostedIncludePassiveSells;

  afterEach(() => {
    (config.alerting as { quotePostedIncludePassiveSells: boolean }).quotePostedIncludePassiveSells =
      originalQuotePostedIncludePassiveSells;
  });

  it("cancels active market-making quotes during shutdown", async () => {
    const cancelQuotesByOrderIds = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    const closeAll = vi.fn();
    const closeUserTracker = vi.fn();
    const stopMonitor = vi.fn();
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.stopping = false;
    bot.refreshTimer = undefined;
    bot.deadMarketCheckTimer = undefined;
    bot.sellCoverageWatchdogTimer = undefined;
    bot.quoteExecutor = {
      getActiveQuotes: vi.fn(() => [
        { orderId: "quote-1", side: "BUY" },
        { orderId: "quote-2", side: "SELL" }
      ]),
      cancelQuotesByOrderIds
    };
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();
    bot.logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    bot.orderHeartbeat = { stop: stopMonitor };
    bot.rewardMonitor = { stop: stopMonitor };
    bot.rebateMonitor = { stop: stopMonitor };
    bot.resolvedMarketClaimService = { stop: stopMonitor };
    bot.inventorySnapshotService = { stop: stopMonitor };
    bot.runtimeCheckpointService = { stop: stopMonitor };
    bot.realizedTradingSessionService = { stop: stopMonitor };
    bot.marketWs = { closeAll };
    bot.userTracker = { close: closeUserTracker };
    bot.alertDispatcher = {
      hasSinks: vi.fn(() => true),
      dispatch
    };

    await bot.stop();

    expect(cancelQuotesByOrderIds).toHaveBeenCalledWith(
      ["quote-1", "quote-2"],
      "shutdown"
    );
    expect(bot.syncExecutionEngineWithActiveQuotes).toHaveBeenCalled();
    expect(closeAll).toHaveBeenCalled();
    expect(closeUserTracker).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "bot_lifecycle",
        runtime: "market-maker",
        tags: ["lifecycle", "stopped"]
      })
    );
  });

  it("syncs execution state after the global passive BUY age watchdog cancels quotes", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const cancelExpiredPassiveBuyQuotes = vi.fn(async () => [
      {
        orderId: "buy-order-1",
        conditionId: "condition-1",
        tokenId: "yes-token",
        side: Side.BUY
      }
    ]);

    bot.stopping = false;
    bot.quoteExecutor = { cancelExpiredPassiveBuyQuotes };
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();
    bot.requestImmediateConditionReevaluation = vi.fn();

    await bot.checkPassiveBuyAgeWatchdog();

    expect(cancelExpiredPassiveBuyQuotes).toHaveBeenCalled();
    expect(bot.syncExecutionEngineWithActiveQuotes).toHaveBeenCalled();
    expect(bot.requestImmediateConditionReevaluation).toHaveBeenCalledWith("condition-1");
  });

  it("keeps startup fallback markets watch-only until live selection confirms execution", async () => {
    const cancelConditionBuyQuotes = vi.fn(async () => undefined);
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.stopping = false;
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.evaluationLocks = new Set();
    bot.selectedConditionIds = new Set([market.conditionId]);
    bot.watchOnlyConditionIds = new Set([market.conditionId]);
    bot.quoteExecutor = { cancelConditionBuyQuotes };
    bot.operatorControl = {
      isPaused: vi.fn(() => false),
      isMarketAllowed: vi.fn(() => true)
    };
    bot.isInventoryOnlyManagedCondition = vi.fn(() => false);
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();

    await bot.handleTokenUpdate(market.tokenIds[0]);

    expect(cancelConditionBuyQuotes).toHaveBeenCalledWith(
      market.conditionId,
      "startup fallback watch-only"
    );
    expect(bot.syncExecutionEngineWithActiveQuotes).toHaveBeenCalled();
    expect(bot.evaluationLocks.size).toBe(0);
  });

  it("only drains quotes for non-selected markets that have no inventory", async () => {
    const cancelMarketQuotes = vi.fn(async () => undefined);
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.stopping = false;
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.selectedConditionIds = new Set();
    bot.evaluationLocks = new Set();
    bot.watchOnlyConditionIds = new Set();
    bot.quoteExecutor = { cancelMarketQuotes };
    bot.operatorControl = {
      isPaused: vi.fn(() => false),
      isMarketAllowed: vi.fn(() => true)
    };
    bot.isInventoryOnlyManagedCondition = vi.fn(() => false);
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();

    await bot.handleTokenUpdate(market.tokenIds[0]);

    expect(cancelMarketQuotes).toHaveBeenCalledWith(market.conditionId);
    expect(bot.syncExecutionEngineWithActiveQuotes).toHaveBeenCalled();
    expect(bot.evaluationLocks.size).toBe(0);
  });

  it("dispatches standalone operator status alerts from runtime checkpoints", async () => {
    const dispatch = vi.fn(async () => undefined);
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.alertDispatcher = {
      hasSinks: vi.fn(() => true),
      dispatch
    };
    bot.pnlEngine = {
      getPortfolioSnapshot: vi.fn(() => portfolioSnapshot()),
      getStrategySnapshot: vi.fn((strategy: string) => strategySnapshot(strategy))
    };
    bot.inventoryTracker = {
      exportOpenLots: vi.fn(() => [])
    };
    bot.quoteExecutor = {
      getKnownVenueShares: vi.fn(() => undefined)
    };
    bot.tradingClient = {
      getBalanceAllowance: vi.fn(async () => ({
        balance: "200000000",
        allowance: "200000000"
      }))
    };
    bot.logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    };
    bot.orderBookStore = { get: vi.fn(() => undefined) };
    bot.tokenToMarket = new Map();
    bot.conditionToMarket = new Map();
    bot.knownConditionToMarket = new Map();
    bot.knownSlugToMarket = new Map();
    bot.sessionMmBuyFillCount = 2;
    bot.sessionMmSellFillCount = 1;
    bot.sessionMmTotalHoldMs = 30_000;
    bot.sessionMmHoldSampleCount = 1;
    bot.lastOperatorStatusAlertAtMs = 0;
    bot.startupAtMs = 1_000;
    bot.startupCapitalUsdc = 200;

    await bot.maybeDispatchOperatorStatusAlert({
      runtime: "market-maker",
      reason: "checkpoint",
      generatedAtMs: 2_000,
      riskState: "RUNNING",
      activeOrderCount: 2,
      activeConditionCount: 1,
      openLotCount: 0,
      openShares: 0,
      openCostUsdc: 0
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "operator_status",
        runtime: "market-maker",
        details: expect.objectContaining({
          cashBalanceUsdc: 200,
          activeOrderCount: 2,
          marketMakingSessionBuyFills: 2,
          marketMakingSessionSellFills: 1
        })
      })
    );
  });

  it("ignores user-ws fill progress after shutdown begins", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.stopping = true;
    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => undefined)
    };
    bot.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.conditionToMarket = new Map([[market.conditionId, market]]);
    bot.knownConditionToMarket = new Map<string, BinaryMarket>();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.knownQuoteOrderObservationsByOrderId = new Map([
      [
        fillProgressEvent.orderId,
        {
          orderId: fillProgressEvent.orderId,
          conditionId: market.conditionId,
          marketSlug: market.slug,
          tokenId: fillProgressEvent.assetId,
          side: fillProgressEvent.side,
          size: fillProgressEvent.originalSize,
          seenAtMs: Date.now()
        }
      ]
    ]);
    bot.terminallyHandledQuoteOrdersByOrderId = new Map();
    bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fillProgressEvent);
    await flushAsyncWork();

    expect(bot.quoteExecutor.getActiveQuoteByOrderId).not.toHaveBeenCalled();
    expect(bot.reconcileVenueInventoryForMarket).not.toHaveBeenCalled();
    expect(bot.requestImmediateConditionReevaluation).not.toHaveBeenCalled();
  });

  it("does not trigger reevaluation after shutdown begins mid recovery", async () => {
    let resolveReconcile: (() => void) | undefined;
    const reconcileVenueInventoryForMarket = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReconcile = resolve;
        })
    );
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.stopping = false;
    bot.logger = {
      warn: vi.fn()
    };
    bot.reconcileVenueInventoryForMarket = reconcileVenueInventoryForMarket;
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.recoverFromUntrackedFillProgress(fillProgressEvent, market);

    expect(reconcileVenueInventoryForMarket).toHaveBeenCalledWith(
      market,
      expect.any(Number),
      true
    );

    bot.stopping = true;
    resolveReconcile?.();
    await flushAsyncWork();

    expect(bot.requestImmediateConditionReevaluation).not.toHaveBeenCalled();
  });

  it("forces venue reconciliation and reevaluation for untracked fill progress on an active market", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => undefined)
    };
    bot.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.conditionToMarket = new Map([[market.conditionId, market]]);
    bot.knownConditionToMarket = new Map<string, BinaryMarket>();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.knownQuoteOrderObservationsByOrderId = new Map([
      [
        fillProgressEvent.orderId,
        {
          orderId: fillProgressEvent.orderId,
          conditionId: market.conditionId,
          marketSlug: market.slug,
          tokenId: fillProgressEvent.assetId,
          side: fillProgressEvent.side,
          size: fillProgressEvent.originalSize,
          seenAtMs: Date.now()
        }
      ]
    ]);
    bot.terminallyHandledQuoteOrdersByOrderId = new Map();
    bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fillProgressEvent);
    await flushAsyncWork();

    expect(bot.reconcileVenueInventoryForMarket).toHaveBeenCalledWith(
      market,
      expect.any(Number),
      true
    );
    expect(bot.requestImmediateConditionReevaluation).toHaveBeenCalledWith(
      market.conditionId
    );
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: fillProgressEvent.orderId,
        recoveryScheduled: true,
        recoveredConditionId: market.conditionId
      }),
      "Received user-ws fill progress for an order that is no longer tracked locally."
    );
  });

  it("falls back to known market metadata when the token is no longer in the active market set", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => undefined)
    };
    bot.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map<string, BinaryMarket>();
    bot.conditionToMarket = new Map<string, BinaryMarket>();
    bot.knownConditionToMarket = new Map<string, BinaryMarket>();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.knownQuoteOrderObservationsByOrderId = new Map([
      [
        fillProgressEvent.orderId,
        {
          orderId: fillProgressEvent.orderId,
          conditionId: market.conditionId,
          marketSlug: market.slug,
          tokenId: fillProgressEvent.assetId,
          side: fillProgressEvent.side,
          size: fillProgressEvent.originalSize,
          seenAtMs: Date.now()
        }
      ]
    ]);
    bot.terminallyHandledQuoteOrdersByOrderId = new Map();
    bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fillProgressEvent);
    await flushAsyncWork();

    expect(bot.reconcileVenueInventoryForMarket).toHaveBeenCalledWith(
      market,
      expect.any(Number),
      true
    );
    expect(bot.requestImmediateConditionReevaluation).toHaveBeenCalledWith(
      market.conditionId
    );
  });

  it("seeds known off-universe markets for immediate reevaluation", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.tokenToMarket = new Map<string, BinaryMarket>();
    bot.conditionToMarket = new Map<string, BinaryMarket>();
    bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
    bot.evaluationLocks = new Set<string>();
    bot.pendingImmediateReevaluationConditionIds = new Set<string>();
    bot.handleTokenUpdate = vi.fn();

    bot.requestImmediateConditionReevaluation(market.conditionId);

    expect(bot.conditionToMarket.get(market.conditionId)).toBe(market);
    expect(bot.tokenToMarket.get(market.tokenIds[0])).toBe(market);
    expect(bot.tokenToMarket.get(market.tokenIds[1])).toBe(market);
    expect(bot.handleTokenUpdate).toHaveBeenCalledWith(market.tokenIds[0]);
  });

  it("skips immediate reevaluation scheduling during shutdown", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;

    bot.stopping = true;
    bot.tokenToMarket = new Map<string, BinaryMarket>();
    bot.conditionToMarket = new Map<string, BinaryMarket>();
    bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
    bot.evaluationLocks = new Set<string>();
    bot.pendingImmediateReevaluationConditionIds = new Set<string>();
    bot.rememberManagedMarket = vi.fn();
    bot.handleTokenUpdate = vi.fn();

    bot.requestImmediateConditionReevaluation(market.conditionId);

    expect(bot.rememberManagedMarket).not.toHaveBeenCalled();
    expect(bot.pendingImmediateReevaluationConditionIds.size).toBe(0);
    expect(bot.handleTokenUpdate).not.toHaveBeenCalled();
  });

  it("keeps off-universe inventory markets in the managed universe", () => {
    const offUniverseMarket: BinaryMarket = {
      ...market,
      id: "market-2",
      conditionId: "condition-2",
      questionId: "question-2",
      question: "Will BTC be below 100k?",
      slug: "btc-below-100k",
      tokenIds: ["yes-token-2", "no-token-2"]
    };
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.tokenToMarket = new Map<string, BinaryMarket>();
    bot.knownConditionToMarket = new Map<string, BinaryMarket>([
      [market.conditionId, market],
      [offUniverseMarket.conditionId, offUniverseMarket]
    ]);
    bot.knownSlugToMarket = new Map<string, BinaryMarket>([
      [market.slug, market],
      [offUniverseMarket.slug, offUniverseMarket]
    ]);
    bot.inventoryTracker = {
      exportOpenLots: vi.fn(() => [
        {
          lotId: "lot-1",
          strategy: "market-making",
          tokenId: offUniverseMarket.tokenIds[0],
          marketScope: offUniverseMarket.slug,
          shares: 10,
          conditionId: offUniverseMarket.conditionId,
          totalCostUsdc: 4,
          openedAtMs: Date.now()
        }
      ]),
      getOpenShares: vi.fn((tokenId: string) =>
        tokenId === offUniverseMarket.tokenIds[0] ? 10 : 0
      )
    };

    const inventoryOnlyMarkets = bot.collectInventoryOnlyManagedMarkets([market]);

    expect(inventoryOnlyMarkets).toEqual([offUniverseMarket]);
  });

  it("suppresses a fresh passive BUY when recent trade flow is absent", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [{ price: 0.48, size: 13 }],
        asks: [{ price: 0.52, size: 10 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.5,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 1,
        recentTradeEvents: 0
      }))
    };
    bot.quoteExecutor = undefined;
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.48,
          bestAsk: 0.52,
          observedSpread: 0.04,
          observedSpreadTicks: 4,
          topBookLiquidityUsdc: 10,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.SELL,
              price: 0.52,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: market.tokenIds[1],
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.48,
          bestAsk: 0.52,
          observedSpread: 0.04,
          observedSpreadTicks: 4,
          topBookLiquidityUsdc: 10,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[1],
              outcome: "No",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[1],
              outcome: "No",
              side: Side.SELL,
              price: 0.52,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.SELL,
          price: 0.52,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);
    const adjustedBuy = adjusted.quotes.find((quote: any) => quote.side === Side.BUY);

    expect(adjustedBuy).toBeUndefined();
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        tokenId: market.tokenIds[0],
        maxRestingAgeMs: config.marketMaker.passiveBuyNoTradeMaxAgeMs,
        weakenedReasons: expect.arrayContaining(["no_recent_trades"]),
        severeReasons: expect.arrayContaining(["no_recent_trades"])
      }),
      "Skipped passive BUY because the market's freshness/exitability lease was already violated at posting time."
    );
  });

  it("suppresses a fresh passive BUY when absent trade flow also has weak exitability", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [
          { price: 0.48, size: 5 },
          { price: 0.47, size: 10 }
        ],
        asks: [{ price: 0.49, size: 25_000 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.5,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 1,
        recentTradeEvents: 0
      }))
    };
    bot.quoteExecutor = undefined;
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.48,
          bestAsk: 0.52,
          observedSpread: 0.04,
          observedSpreadTicks: 4,
          topBookLiquidityUsdc: 13.68,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.SELL,
              price: 0.52,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.SELL,
          price: 0.52,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);
    const adjustedBuy = adjusted.quotes.find((quote: any) => quote.side === Side.BUY);

    expect(adjustedBuy).toBeUndefined();
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        tokenId: market.tokenIds[0],
        maxRestingAgeMs: config.marketMaker.passiveBuyNoTradeMaxAgeMs,
        weakenedReasons: expect.arrayContaining([
          "no_recent_trades",
          "crowded_target_exit_queue"
        ]),
        severeReasons: expect.arrayContaining(["no_recent_trades_with_weak_exitability"])
      }),
      "Skipped passive BUY because the market's freshness/exitability lease was already violated at posting time."
    );
  });

  it("withdraws an aged passive BUY after its freshness lease expires under weak market conditions", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [{ price: 0.48, size: 10 }],
        asks: [{ price: 0.52, size: 10 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.5,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 1,
        recentTradeEvents: 0
      }))
    };
    bot.quoteExecutor = {
      getActiveQuote: vi.fn(() => ({
        tokenId: market.tokenIds[0],
        outcome: "Yes",
        side: Side.BUY,
        price: 0.48,
        size: 10,
        tickSize: 0.01,
        postOnly: true,
        orderType: OrderType.GTC,
        conditionId: market.conditionId,
        marketSlug: market.slug,
        orderId: "buy-order-1",
        intentCreatedAtMs: nowMs - 61_000,
        openedAtMs: nowMs - 61_000,
        partialFillCount: 0,
        requoteCount: 0
      }))
    };
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.48,
          bestAsk: 0.52,
          observedSpread: 0.04,
          observedSpreadTicks: 4,
          topBookLiquidityUsdc: 10,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.SELL,
              price: 0.52,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: market.tokenIds[1],
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.48,
          bestAsk: 0.52,
          observedSpread: 0.04,
          observedSpreadTicks: 4,
          topBookLiquidityUsdc: 10,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[1],
              outcome: "No",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[1],
              outcome: "No",
              side: Side.SELL,
              price: 0.52,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.SELL,
          price: 0.52,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);

    expect(adjusted.quotes.some((quote: any) => quote.side === Side.BUY)).toBe(false);
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        tokenId: market.tokenIds[0],
        activeQuoteAgeMs: 61_000,
        maxRestingAgeMs: config.marketMaker.passiveBuyNoTradeMaxAgeMs
      }),
      "Cancelled stale passive BUY because its freshness lease expired under weaker market conditions."
    );
  });

  it("suppresses a fresh passive BUY when severe exitability warnings are already present", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [{ price: 0.48, size: 4 }],
        asks: [
          { price: 0.49, size: 25_001 },
          { price: 0.5, size: 10 }
        ],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.485,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 6,
        recentTradeEvents: 4,
        midpointRange: 0.005
      }))
    };
    bot.quoteExecutor = undefined;
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.485,
          bestBid: 0.48,
          bestAsk: 0.49,
          observedSpread: 0.01,
          observedSpreadTicks: 1,
          topBookLiquidityUsdc: 12_252.49,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.SELL,
              price: 0.49,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);
    const adjustedBuy = adjusted.quotes.find((quote: any) => quote.side === Side.BUY);

    expect(adjustedBuy).toBeUndefined();
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        tokenId: market.tokenIds[0],
        activeQuoteAgeMs: undefined,
        maxRestingAgeMs: config.marketMaker.passiveBuyWeakSignalMaxAgeMs,
        severeReasons: expect.arrayContaining(["very_weak_best_bid_support"])
      }),
      "Skipped passive BUY because the market's freshness/exitability lease was already violated at posting time."
    );
  });

  it("suppresses a fresh passive BUY when midpoint range chops by two ticks inside the volatility window", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [{ price: 0.48, size: 20 }],
        asks: [{ price: 0.49, size: 20 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.485,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 6,
        recentTradeEvents: 4,
        midpointRange: 0.02
      }))
    };
    bot.quoteExecutor = undefined;
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.485,
          bestBid: 0.48,
          bestAsk: 0.49,
          observedSpread: 0.01,
          observedSpreadTicks: 1,
          topBookLiquidityUsdc: 19.4,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);
    const adjustedBuy = adjusted.quotes.find((quote: any) => quote.side === Side.BUY);

    expect(adjustedBuy).toBeUndefined();
    expect(bot.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        tokenId: market.tokenIds[0],
        maxRestingAgeMs: config.marketMaker.passiveBuyNoTradeMaxAgeMs,
        severeReasons: expect.arrayContaining(["adverse_midpoint_range"])
      }),
      "Skipped passive BUY because the market's freshness/exitability lease was already violated at posting time."
    );
  });

  it("allows a fresh passive BUY on mild midpoint chop but shortens its resting age", () => {
    const nowMs = Date.parse("2026-04-23T00:00:00.000Z");
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.orderBookStore = {
      get: vi.fn(() => ({
        assetId: market.tokenIds[0],
        market: market.slug,
        bids: [{ price: 0.48, size: 20 }],
        asks: [{ price: 0.49, size: 20 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: 0.485,
        hash: undefined,
        updatedAtMs: nowMs
      })),
      getSelectionTelemetry: vi.fn(() => ({
        recentActivityEvents: 6,
        recentTradeEvents: 4,
        midpointRange: 0.015
      }))
    };
    bot.quoteExecutor = undefined;
    bot.logger = { info: vi.fn() };

    const plan = {
      market,
      generatedAtMs: nowMs,
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          midpoint: 0.485,
          bestBid: 0.48,
          bestAsk: 0.49,
          observedSpread: 0.01,
          observedSpreadTicks: 1,
          topBookLiquidityUsdc: 19.4,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          inventoryShares: 0,
          opposingInventoryShares: 0,
          inventorySkewRatio: 0,
          inventoryBuyAdjustmentTicks: 0,
          inventorySellAdjustmentTicks: 0,
          fillRateFeedbackInwardTicks: 0,
          quotes: [
            {
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              side: Side.BUY,
              price: 0.48,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ] as const,
      quotes: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          side: Side.BUY,
          price: 0.48,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    const adjusted = bot.applyPassiveBuyFreshnessLeaseToPlan(market, plan, nowMs);
    const adjustedBuy = adjusted.quotes.find((quote: any) => quote.side === Side.BUY);

    expect(adjustedBuy).toEqual(
      expect.objectContaining({
        tokenId: market.tokenIds[0],
        side: Side.BUY,
        maxRestingAgeMs: config.marketMaker.passiveBuyNoTradeMaxAgeMs
      })
    );
    expect(bot.logger.info).not.toHaveBeenCalled();
  });

  it("ignores untracked fill progress for unknown orders", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => undefined)
    };
    bot.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.conditionToMarket = new Map([[market.conditionId, market]]);
    bot.knownConditionToMarket = new Map<string, BinaryMarket>();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.knownQuoteOrderObservationsByOrderId = new Map();
    bot.terminallyHandledQuoteOrdersByOrderId = new Map();
    bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fillProgressEvent);
    await flushAsyncWork();

    expect(bot.reconcileVenueInventoryForMarket).not.toHaveBeenCalled();
    expect(bot.requestImmediateConditionReevaluation).not.toHaveBeenCalled();
    expect(bot.logger.info).not.toHaveBeenCalled();
    expect(bot.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: fillProgressEvent.orderId,
        recoveryScheduled: false,
        ignoredReason: "unknown_order_id"
      }),
      "Ignored user-ws fill progress for an unknown order."
    );
  });

  it("ignores duplicate late fill progress for recently completed orders", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => undefined)
    };
    bot.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.conditionToMarket = new Map([[market.conditionId, market]]);
    bot.knownConditionToMarket = new Map<string, BinaryMarket>();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.knownQuoteOrderObservationsByOrderId = new Map();
    bot.terminallyHandledQuoteOrdersByOrderId = new Map([
      [
        fillProgressEvent.orderId,
        {
          orderId: fillProgressEvent.orderId,
          conditionId: market.conditionId,
          marketSlug: market.slug,
          tokenId: fillProgressEvent.assetId,
          side: fillProgressEvent.side,
          size: fillProgressEvent.originalSize,
          seenAtMs: Date.now(),
          resolvedAtMs: Date.now(),
          matchedSize: fillProgressEvent.matchedSize
        }
      ]
    ]);
    bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fillProgressEvent);
    await flushAsyncWork();

    expect(bot.reconcileVenueInventoryForMarket).not.toHaveBeenCalled();
    expect(bot.requestImmediateConditionReevaluation).not.toHaveBeenCalled();
    expect(bot.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: fillProgressEvent.orderId
      }),
      "Ignored duplicate user-ws fill progress for a recently completed order."
    );
  });

  it("clamps tracked fill progress that exceeds the known order size", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const trackedQuote = {
      orderId: fillProgressEvent.orderId,
      conditionId: market.conditionId,
      marketSlug: market.slug,
      tokenId: fillProgressEvent.assetId,
      outcome: "No",
      side: "SELL",
      category: undefined,
      price: 0.31,
      size: 10,
      intentCreatedAtMs: Date.now() - 1_000,
      openedAtMs: Date.now() - 500,
      partialFillCount: 0,
      requoteCount: 0,
      firstFillAtMs: undefined
    };
    const overfilledEvent: UserOrderFillProgressEvent = {
      ...fillProgressEvent,
      side: "SELL",
      price: 0.31,
      originalSize: 10,
      matchedSize: 14,
      deltaMatchedSize: 7,
      isTerminal: false
    };

    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => trackedQuote),
      notifyOrderFillProgress: vi.fn(),
      removeTrackedQuoteByOrderId: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[trackedQuote.tokenId, market]]);
    bot.noteQuoteFilled = vi.fn();
    bot.handleMakerFill = vi.fn();
    bot.noteTerminallyHandledQuoteOrder = vi.fn();
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(overfilledEvent);

    expect(bot.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: overfilledEvent.orderId,
        rawMatchedSize: 14,
        rawDeltaMatchedSize: 7,
        boundedMatchedSize: 10,
        boundedDeltaMatchedSize: 3
      }),
      "Clamped user-ws fill progress that exceeded the tracked order size."
    );
    expect(bot.quoteExecutor.notifyOrderFillProgress).toHaveBeenCalledWith(
      overfilledEvent.orderId,
      true,
      expect.any(Number)
    );
    expect(bot.handleMakerFill).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeId: `user-ws:${overfilledEvent.orderId}:10.00000000`,
        shares: 3,
        notionalUsdc: 0.93
      })
    );
    expect(bot.noteTerminallyHandledQuoteOrder).toHaveBeenCalledWith(
      trackedQuote,
      expect.objectContaining({
        matchedSize: 10,
        deltaMatchedSize: 3,
        isTerminal: true
      }),
      expect.any(Number)
    );
    expect(bot.quoteExecutor.removeTrackedQuoteByOrderId).toHaveBeenCalledWith(
      overfilledEvent.orderId
    );
  });

  it("treats a full-size user-ws trade fill as terminal even without terminal status", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const trackedQuote = {
      orderId: fillProgressEvent.orderId,
      conditionId: market.conditionId,
      marketSlug: market.slug,
      tokenId: fillProgressEvent.assetId,
      outcome: "No",
      side: "BUY",
      category: undefined,
      price: 0.54,
      size: 10,
      intentCreatedAtMs: Date.now() - 90_000,
      openedAtMs: Date.now() - 85_000,
      maxRestingAgeMs: 90_000,
      partialFillCount: 0,
      requoteCount: 0,
      firstFillAtMs: undefined
    };
    const fullTradeFillEvent: UserOrderFillProgressEvent = {
      ...fillProgressEvent,
      side: "BUY",
      price: 0.54,
      originalSize: 10,
      matchedSize: 10,
      deltaMatchedSize: 10,
      isTerminal: false
    };

    bot.quoteExecutor = {
      getActiveQuoteByOrderId: vi.fn(() => trackedQuote),
      notifyOrderFillProgress: vi.fn(),
      removeTrackedQuoteByOrderId: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.tokenToMarket = new Map([[trackedQuote.tokenId, market]]);
    bot.noteQuoteFilled = vi.fn();
    bot.handleMakerFill = vi.fn();
    bot.noteTerminallyHandledQuoteOrder = vi.fn();
    bot.requestImmediateConditionReevaluation = vi.fn();

    bot.handleUserOrderFillProgress(fullTradeFillEvent);

    expect(bot.quoteExecutor.notifyOrderFillProgress).toHaveBeenCalledWith(
      fullTradeFillEvent.orderId,
      true,
      expect.any(Number)
    );
    expect(bot.noteTerminallyHandledQuoteOrder).toHaveBeenCalledWith(
      trackedQuote,
      expect.objectContaining({
        matchedSize: 10,
        deltaMatchedSize: 10,
        isTerminal: true
      }),
      expect.any(Number)
    );
    expect(bot.quoteExecutor.removeTrackedQuoteByOrderId).toHaveBeenCalledWith(
      fullTradeFillEvent.orderId
    );
    expect(bot.handleMakerFill).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "BUY",
        shares: 10,
        notionalUsdc: 5.4
      })
    );
  });

  it("dispatches a throttled quote-posted alert for BUY quotes", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.alertDispatcher = {
      dispatch: vi.fn(async () => undefined)
    };
    bot.lastQuotePostedAlertAtBySlotKey = new Map();

    bot.maybeDispatchQuotePostedAlert({
      tokenId: market.tokenIds[0],
      side: "BUY",
      quoteSlot: "primary",
      postOnly: true,
      marketSlug: market.slug,
      orderId: "buy-order-1",
      openedAtMs: Date.now(),
      outcome: "Yes",
      size: 20,
      price: 0.41,
      orderType: "GTC",
      executionStyle: "passive-maker"
    });

    expect(bot.alertDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(bot.alertDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "quote_posted",
        details: expect.objectContaining({
          side: "BUY",
          postOnly: true
        })
      })
    );
  });

  it("suppresses duplicate BUY quote-posted alerts and passive SELL quote-posted alerts", async () => {
    (config.alerting as { quotePostedIncludePassiveSells: boolean }).quotePostedIncludePassiveSells =
      false;
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.alertDispatcher = {
      dispatch: vi.fn(async () => undefined)
    };
    bot.lastQuotePostedAlertAtBySlotKey = new Map();

    const openedAtMs = Date.now();
    const buyQuote = {
      tokenId: market.tokenIds[0],
      side: "BUY",
      quoteSlot: "primary",
      postOnly: true,
      marketSlug: market.slug,
      orderId: "buy-order-1",
      openedAtMs,
      outcome: "Yes",
      size: 20,
      price: 0.41,
      orderType: "GTC",
      executionStyle: "passive-maker"
    };

    bot.maybeDispatchQuotePostedAlert(buyQuote);
    bot.maybeDispatchQuotePostedAlert({
      ...buyQuote,
      orderId: "buy-order-2",
      openedAtMs: openedAtMs + 5_000
    });
    bot.maybeDispatchQuotePostedAlert({
      tokenId: market.tokenIds[1],
      side: "SELL",
      quoteSlot: "primary",
      postOnly: true,
      marketSlug: market.slug,
      orderId: "sell-order-1",
      openedAtMs,
      outcome: "No",
      size: 20,
      price: 0.62,
      orderType: "GTC",
      executionStyle: "passive-maker"
    });

    expect(bot.alertDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("blocks new BUY re-entry after a BUY fill when SELL feasibility is weak", () => {
    const originalMinRecentTradeEvents = config.marketUniverse.minRecentTradeEvents;
    const originalMinBestBidNotionalUsdc = config.marketUniverse.minBestBidNotionalUsdc;
    const originalMinExitDepthMultiplier = config.marketUniverse.minExitDepthMultiplier;
    const originalActivityWindowMs = config.marketUniverse.activityWindowMs;
    const originalConditionBuySuppressionMs = config.marketMaker.conditionBuySuppressionMs;
    const originalBuyReentryAfterFillCooldownMs = config.marketMaker.buyReentryAfterFillCooldownMs;
    const originalBalanceRefreshMs = config.marketMaker.balanceRefreshMs;
    const originalMaxBookStalenessMs = config.strategy.maxBookStalenessMs;

    (config.marketUniverse as { minRecentTradeEvents: number }).minRecentTradeEvents = 3;
    (config.marketUniverse as { minBestBidNotionalUsdc: number }).minBestBidNotionalUsdc = 60;
    (config.marketUniverse as { minExitDepthMultiplier: number }).minExitDepthMultiplier = 0;
    (config.marketUniverse as { activityWindowMs: number }).activityWindowMs = 60_000;
    (config.marketMaker as { conditionBuySuppressionMs: number }).conditionBuySuppressionMs = 20_000;
    (config.marketMaker as { buyReentryAfterFillCooldownMs: number }).buyReentryAfterFillCooldownMs =
      15_000;
    (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs = 10_000;
    (config.strategy as { maxBookStalenessMs: number }).maxBookStalenessMs = 5_000;

    try {
      const positions = new Map<string, any>();
      const nowMs = Date.now();
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastBuyFillAtByConditionId = new Map();
      bot.lastFillAtByConditionId = new Map();
      bot.oneSideAggressiveExitRejectCountByTokenId = new Map();
      bot.oneSideFillRecoveryByConditionId = new Map();
      bot.postBuySellFeasibilityBlocksByConditionId = new Map();
      bot.conditionToMarket = new Map([[market.conditionId, market]]);
      bot.knownConditionToMarket = new Map();
      bot.knownSlugToMarket = new Map([[market.slug, market]]);
      bot.tokenToMarket = new Map([
        [market.tokenIds[0], market],
        [market.tokenIds[1], market]
      ]);
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.quoteExecutor = {
        cancelConditionBuyQuotes: vi.fn(async () => undefined),
        invalidateConditionalBalance: vi.fn()
      };
      bot.inventoryTracker = {
        consumeVenueSyncShares: vi.fn(),
        addLot: vi.fn((lot: any) => {
          positions.set(lot.tokenId, {
            tokenId: lot.tokenId,
            conditionId: lot.conditionId,
            marketScope: lot.marketScope,
            outcome: lot.outcome,
            shares: lot.shares,
            totalCostUsdc: lot.totalCostUsdc,
            openedAtMs: lot.openedAtMs
          });
        }),
        getOpenPosition: vi.fn((tokenId: string) => positions.get(tokenId))
      };
      bot.clearRecentConfirmedInventoryCloseGuard = vi.fn();
      bot.syncTrackedInventoryLots = vi.fn();
      bot.requestImmediateConditionReevaluation = vi.fn();
      bot.buildMakerFillAlertContext = vi.fn(() => ({
        positionBeforeShares: 0,
        positionAfterShares: 10,
        orderType: "maker"
      }));
      bot.alertDispatcher = {
        dispatch: vi.fn(async () => undefined)
      };
      bot.orderBookStore = {
        get: vi.fn((tokenId: string) => ({
          assetId: tokenId,
          market: market.slug,
          bids: tokenId === market.tokenIds[0] ? [{ price: 0.4, size: 50 }] : [{ price: 0.58, size: 30 }],
          asks: tokenId === market.tokenIds[0] ? [{ price: 0.42, size: 50 }] : [{ price: 0.6, size: 30 }],
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          lastTradePrice: 0.41,
          hash: undefined,
          updatedAtMs: nowMs,
          tapePressure: {
            windowMs: 60_000,
            recentTradeCount: 3,
            buyTradeCount: 0,
            sellTradeCount: 3,
            buyVolume: 0,
            sellVolume: 15,
            tradesPerMinute: 3,
            signedTradeImbalance: -1,
            signedVolumeImbalance: -1,
            pressureScore: -0.4,
            biasTicks: -1,
            dominantSide: "SELL",
            lastTradeSide: "SELL"
          }
        })),
        getSelectionTelemetry: vi.fn(() => ({
          recentActivityEvents: 3,
          recentTradeEvents: 0,
          midpointRange: 0.01
        }))
      };
      bot.displacementTracker = {
        getDisplacementRate: vi.fn(() => 0)
      };

      bot["handleMakerFill"]({
        tradeId: "trade-1",
        date: new Date(nowMs).toISOString(),
        matchedAt: new Date(nowMs).toISOString(),
        conditionId: market.conditionId,
        marketSlug: market.slug,
        feesEnabled: true,
        assetId: market.tokenIds[0],
        outcome: "Yes",
        side: "BUY",
        shares: 10,
        price: 0.4,
        notionalUsdc: 4,
        feeEquivalentUsdc: 0,
        maxPotentialRebateUsdc: 0,
        makerRebatePct: 0
      });

      const block = bot.postBuySellFeasibilityBlocksByConditionId.get(market.conditionId);
      expect(block).toEqual(
        expect.objectContaining({
          conditionId: market.conditionId,
          requiredConditionRecentTradeEvents: 3,
          reasons: expect.arrayContaining([
            "condition_recent_trade_flow_below_threshold",
            "token_recent_trade_flow_below_threshold",
            "best_bid_depth_below_threshold"
          ])
        })
      );
      expect(block?.blockedTokens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tokenId: market.tokenIds[0]
          })
        ])
      );
      expect(bot.requestImmediateConditionReevaluation).toHaveBeenCalledWith(market.conditionId);
      expect(bot.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          conditionId: market.conditionId,
          filledTokenId: market.tokenIds[0]
        }),
        "Blocked new BUY re-entry after maker BUY fill: SELL feasibility is not yet verified."
      );
    } finally {
      (config.marketUniverse as { minRecentTradeEvents: number }).minRecentTradeEvents =
        originalMinRecentTradeEvents;
      (config.marketUniverse as { minBestBidNotionalUsdc: number }).minBestBidNotionalUsdc =
        originalMinBestBidNotionalUsdc;
      (config.marketUniverse as { minExitDepthMultiplier: number }).minExitDepthMultiplier =
        originalMinExitDepthMultiplier;
      (config.marketUniverse as { activityWindowMs: number }).activityWindowMs =
        originalActivityWindowMs;
      (config.marketMaker as { conditionBuySuppressionMs: number }).conditionBuySuppressionMs =
        originalConditionBuySuppressionMs;
      (config.marketMaker as { buyReentryAfterFillCooldownMs: number }).buyReentryAfterFillCooldownMs =
        originalBuyReentryAfterFillCooldownMs;
      (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs =
        originalBalanceRefreshMs;
      (config.strategy as { maxBookStalenessMs: number }).maxBookStalenessMs =
        originalMaxBookStalenessMs;
    }
  });

  it("releases the post-buy BUY block once SELL feasibility recovers", () => {
    const originalMinRecentTradeEvents = config.marketUniverse.minRecentTradeEvents;
    const originalMinBestBidNotionalUsdc = config.marketUniverse.minBestBidNotionalUsdc;
    const originalMinExitDepthMultiplier = config.marketUniverse.minExitDepthMultiplier;
    const originalActivityWindowMs = config.marketUniverse.activityWindowMs;
    const originalConditionBuySuppressionMs = config.marketMaker.conditionBuySuppressionMs;
    const originalBuyReentryAfterFillCooldownMs = config.marketMaker.buyReentryAfterFillCooldownMs;
    const originalBalanceRefreshMs = config.marketMaker.balanceRefreshMs;
    const originalMaxBookStalenessMs = config.strategy.maxBookStalenessMs;

    (config.marketUniverse as { minRecentTradeEvents: number }).minRecentTradeEvents = 3;
    (config.marketUniverse as { minBestBidNotionalUsdc: number }).minBestBidNotionalUsdc = 60;
    (config.marketUniverse as { minExitDepthMultiplier: number }).minExitDepthMultiplier = 0;
    (config.marketUniverse as { activityWindowMs: number }).activityWindowMs = 60_000;
    (config.marketMaker as { conditionBuySuppressionMs: number }).conditionBuySuppressionMs = 20_000;
    (config.marketMaker as { buyReentryAfterFillCooldownMs: number }).buyReentryAfterFillCooldownMs =
      15_000;
    (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs = 10_000;
    (config.strategy as { maxBookStalenessMs: number }).maxBookStalenessMs = 5_000;

    try {
      const nowMs = Date.now();
      const telemetryByTokenId = new Map<
        string,
        { recentActivityEvents: number; recentTradeEvents: number; midpointRange: number }
      >([
        [market.tokenIds[0], { recentActivityEvents: 3, recentTradeEvents: 0, midpointRange: 0.01 }],
        [market.tokenIds[1], { recentActivityEvents: 1, recentTradeEvents: 0, midpointRange: 0.01 }]
      ]);
      const booksByTokenId = new Map<string, any>([
        [
          market.tokenIds[0],
          {
            assetId: market.tokenIds[0],
            market: market.slug,
            bids: [{ price: 0.4, size: 50 }],
            asks: [{ price: 0.42, size: 50 }],
            tickSize: 0.01,
            minOrderSize: 1,
            negRisk: false,
            lastTradePrice: 0.41,
            hash: undefined,
            updatedAtMs: nowMs,
            tapePressure: {
              windowMs: 60_000,
              recentTradeCount: 3,
              buyTradeCount: 0,
              sellTradeCount: 3,
              buyVolume: 0,
              sellVolume: 15,
              tradesPerMinute: 3,
              signedTradeImbalance: -1,
              signedVolumeImbalance: -1,
              pressureScore: -0.4,
              biasTicks: -1,
              dominantSide: "SELL",
              lastTradeSide: "SELL"
            }
          }
        ],
        [
          market.tokenIds[1],
          {
            assetId: market.tokenIds[1],
            market: market.slug,
            bids: [{ price: 0.58, size: 30 }],
            asks: [{ price: 0.6, size: 30 }],
            tickSize: 0.01,
            minOrderSize: 1,
            negRisk: false,
            lastTradePrice: 0.59,
            hash: undefined,
            updatedAtMs: nowMs,
            tapePressure: {
              windowMs: 60_000,
              recentTradeCount: 3,
              buyTradeCount: 0,
              sellTradeCount: 3,
              buyVolume: 0,
              sellVolume: 15,
              tradesPerMinute: 3,
              signedTradeImbalance: -1,
              signedVolumeImbalance: -1,
              pressureScore: -0.4,
              biasTicks: -1,
              dominantSide: "SELL",
              lastTradeSide: "SELL"
            }
          }
        ]
      ]);
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.lastBuyFillAtByConditionId = new Map([[market.conditionId, nowMs]]);
      bot.postBuySellFeasibilityBlocksByConditionId = new Map();
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                conditionId: market.conditionId,
                marketScope: market.slug,
                outcome: "Yes",
                shares: 10,
                totalCostUsdc: 4,
                openedAtMs: nowMs
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn((tokenId: string) => booksByTokenId.get(tokenId)),
        getSelectionTelemetry: vi.fn((tokenId: string) => telemetryByTokenId.get(tokenId))
      };
      bot.displacementTracker = {
        getDisplacementRate: vi.fn(() => 0)
      };

      const initialBlock = bot["refreshPostBuySellFeasibilityBlock"](market, nowMs);
      expect(initialBlock).toBeDefined();
      expect(bot.postBuySellFeasibilityBlocksByConditionId.has(market.conditionId)).toBe(true);

      telemetryByTokenId.set(market.tokenIds[0], {
        recentActivityEvents: 4,
        recentTradeEvents: 2,
        midpointRange: 0.01
      });
      telemetryByTokenId.set(market.tokenIds[1], {
        recentActivityEvents: 3,
        recentTradeEvents: 2,
        midpointRange: 0.01
      });
      booksByTokenId.set(market.tokenIds[0], {
        ...booksByTokenId.get(market.tokenIds[0]),
        bids: [{ price: 0.4, size: 200 }],
        updatedAtMs: nowMs + 1_000,
        tapePressure: {
          windowMs: 60_000,
          recentTradeCount: 8,
          buyTradeCount: 5,
          sellTradeCount: 3,
          buyVolume: 40,
          sellVolume: 12,
          tradesPerMinute: 8,
          signedTradeImbalance: 0.25,
          signedVolumeImbalance: 0.5385,
          pressureScore: 0.3,
          biasTicks: 1,
          dominantSide: "BUY",
          lastTradeSide: "BUY"
        }
      });
      booksByTokenId.set(market.tokenIds[1], {
        ...booksByTokenId.get(market.tokenIds[1]),
        bids: [{ price: 0.58, size: 120 }],
        updatedAtMs: nowMs + 1_000,
        tapePressure: {
          windowMs: 60_000,
          recentTradeCount: 8,
          buyTradeCount: 5,
          sellTradeCount: 3,
          buyVolume: 35,
          sellVolume: 12,
          tradesPerMinute: 8,
          signedTradeImbalance: 0.25,
          signedVolumeImbalance: 0.4894,
          pressureScore: 0.28,
          biasTicks: 1,
          dominantSide: "BUY",
          lastTradeSide: "BUY"
        }
      });

      const releasedBlock = bot["refreshPostBuySellFeasibilityBlock"](market, nowMs + 1_000);
      expect(releasedBlock).toBeUndefined();
      expect(bot.postBuySellFeasibilityBlocksByConditionId.has(market.conditionId)).toBe(false);
    } finally {
      (config.marketUniverse as { minRecentTradeEvents: number }).minRecentTradeEvents =
        originalMinRecentTradeEvents;
      (config.marketUniverse as { minBestBidNotionalUsdc: number }).minBestBidNotionalUsdc =
        originalMinBestBidNotionalUsdc;
      (config.marketUniverse as { minExitDepthMultiplier: number }).minExitDepthMultiplier =
        originalMinExitDepthMultiplier;
      (config.marketUniverse as { activityWindowMs: number }).activityWindowMs =
        originalActivityWindowMs;
      (config.marketMaker as { conditionBuySuppressionMs: number }).conditionBuySuppressionMs =
        originalConditionBuySuppressionMs;
      (config.marketMaker as { buyReentryAfterFillCooldownMs: number }).buyReentryAfterFillCooldownMs =
        originalBuyReentryAfterFillCooldownMs;
      (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs =
        originalBalanceRefreshMs;
      (config.strategy as { maxBookStalenessMs: number }).maxBookStalenessMs =
        originalMaxBookStalenessMs;
    }
  });

  it("does not trigger stuck inventory sweep when active sell coverage already exists", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuotes: vi.fn(() => []),
      cancelMarketQuotes: vi.fn(async () => undefined)
    };
    bot.riskReductionExecutor = {};
    bot.inventoryTracker = {
      getOpenPosition: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.consecutiveStuckInventoryCyclesByConditionId = new Map([[market.conditionId, 2]]);
    bot.lastStuckInventorySweepAtByConditionId = new Map();
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();
    bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

    const swept = await bot.maybeSweepStuckInventory({
      market,
      trackedInventoryPositions: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          shares: 20,
          totalCostUsdc: 8
        }
      ],
      sellCoverageByTokenId: new Map([[market.tokenIds[0], 20]]),
      temporarilySuppressedSellTokenIds: new Set(),
      diagnostics: [],
      minimumSellQuoteSize: 5
    });

    expect(swept).toBe(false);
    expect(bot.consecutiveStuckInventoryCyclesByConditionId.has(market.conditionId)).toBe(false);
    expect(bot.reduceInventoryRiskCandidates).not.toHaveBeenCalled();
  });

  it("does not trigger stuck inventory sweep while SELL reposting is intentionally suppressed", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuotes: vi.fn(() => []),
      cancelMarketQuotes: vi.fn(async () => undefined)
    };
    bot.riskReductionExecutor = {};
    bot.inventoryTracker = {
      getOpenPosition: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.consecutiveStuckInventoryCyclesByConditionId = new Map([[market.conditionId, 2]]);
    bot.lastStuckInventorySweepAtByConditionId = new Map();
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();
    bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

    const swept = await bot.maybeSweepStuckInventory({
      market,
      trackedInventoryPositions: [
        {
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          shares: 20,
          totalCostUsdc: 8
        }
      ],
      sellCoverageByTokenId: new Map(),
      temporarilySuppressedSellTokenIds: new Set([market.tokenIds[0]]),
      diagnostics: [],
      minimumSellQuoteSize: 5
    });

    expect(swept).toBe(false);
    expect(bot.consecutiveStuckInventoryCyclesByConditionId.has(market.conditionId)).toBe(false);
    expect(bot.reduceInventoryRiskCandidates).not.toHaveBeenCalled();
  });

  it("promotes stale break-even-eligible inventory into the stuck sweep path", async () => {
    const originalExitMinProfitTicks = config.marketMaker.exitMinProfitTicks;
    const originalBreakEvenExitAfterMs = config.marketMaker.breakEvenExitAfterMs;
    const originalBreakEvenExitMaxLossTicks = config.marketMaker.breakEvenExitMaxLossTicks;

    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 60_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: vi.fn(() => []),
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.38, size: 50 }],
          asks: [{ price: 0.42, size: 50 }],
          tickSize: 0.01
        }))
      };
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                marketScope: market.slug,
                conditionId: market.conditionId,
                outcome: "Yes",
                shares: 20,
                totalCostUsdc: 8,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.consecutiveStuckInventoryCyclesByConditionId = new Map([[market.conditionId, 2]]);
      bot.consecutiveFailedStuckSweepsByConditionId = new Map();
      bot.lastStuckInventorySweepAtByConditionId = new Map();
      bot.stuckSweepDeactivateUntilMsByConditionId = new Map();
      bot.reconcileVenueInventoryForMarket = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      const swept = await bot.maybeSweepStuckInventory({
        market,
        trackedInventoryPositions: [
          {
            tokenId: market.tokenIds[0],
            outcome: "Yes",
            shares: 20,
            totalCostUsdc: 8
          }
        ],
        sellCoverageByTokenId: new Map(),
        temporarilySuppressedSellTokenIds: new Set(),
        diagnostics: [],
        minimumSellQuoteSize: 5
      });

      expect(swept).toBe(true);
      expect(bot.quoteExecutor.cancelMarketQuotes).toHaveBeenCalledWith(market.conditionId);
      expect(bot.reduceInventoryRiskCandidates).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            market,
            tokenId: market.tokenIds[0],
            outcome: "Yes",
            minSellPrice: 0.39
          })
        ],
        "stuck inventory sweep"
      );
    } finally {
      (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks =
        originalExitMinProfitTicks;
      (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs =
        originalBreakEvenExitAfterMs;
      (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks =
        originalBreakEvenExitMaxLossTicks;
    }
  });

  it("escalates repeated SELL-coverage gaps into a forced partial risk reduction", async () => {
    const originalGapCount = config.marketMaker.sellCoverageForceExitAfterGapCount;
    const originalMaxReductionShares =
      config.marketMaker.sellCoverageForceExitMaxReductionShares;
    const originalCooldownMs = config.marketMaker.sellCoverageForceExitCooldownMs;
    const originalMaxLossUsdc = config.marketMaker.sellCoverageForceExitMaxLossUsdc;
    const originalMaxLossTicks = config.marketMaker.sellCoverageForceExitMaxLossTicks;

    (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
      2;
    (config.marketMaker as { sellCoverageForceExitMaxReductionShares: number }).sellCoverageForceExitMaxReductionShares =
      5;
    (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
      120_000;
    (config.marketMaker as { sellCoverageForceExitMaxLossUsdc: number }).sellCoverageForceExitMaxLossUsdc =
      0;
    (config.marketMaker as { sellCoverageForceExitMaxLossTicks: number }).sellCoverageForceExitMaxLossTicks =
      0;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: vi.fn(() => []),
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.inventoryTracker = {
        exportOpenLots: vi.fn(() => [
          {
            tokenId: market.tokenIds[0],
            shares: 20,
            conditionId: market.conditionId
          }
        ]),
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                marketScope: market.slug,
                conditionId: market.conditionId,
                outcome: "Yes",
                shares: 20,
                totalCostUsdc: 8,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.41, size: 100 }],
          asks: [{ price: 0.43, size: 100 }],
          tickSize: 0.01
        }))
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.lastSellFillAtByTokenId = new Map();
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastSellQuoteReleaseAtByTokenId = new Map();
      bot.consecutiveSellCoverageWatchdogGapsByConditionId = new Map();
      bot.sellCoverageEscalationCooldownUntilMsByConditionId = new Map();
      bot.conditionToMarket = new Map([[market.conditionId, market]]);
      bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
      bot.pendingImmediateReevaluationConditionIds = new Set();
      bot.evaluationLocks = new Set();
      bot.rememberManagedMarket = vi.fn();
      bot.handleTokenUpdate = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      await bot.checkSellCoverage();
      expect(bot.reduceInventoryRiskCandidates).not.toHaveBeenCalled();

      await bot.checkSellCoverage();

      expect(bot.quoteExecutor.cancelMarketQuotes).toHaveBeenCalledWith(market.conditionId);
      expect(bot.reduceInventoryRiskCandidates).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            market,
            tokenId: market.tokenIds[0],
            outcome: "Yes",
            maxReductionShares: 5,
            minSellPrice: 0.39
          })
        ],
        "sell coverage forced escalation"
      );
    } finally {
      (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
        originalGapCount;
      (config.marketMaker as { sellCoverageForceExitMaxReductionShares: number }).sellCoverageForceExitMaxReductionShares =
        originalMaxReductionShares;
      (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
        originalCooldownMs;
      (config.marketMaker as { sellCoverageForceExitMaxLossUsdc: number }).sellCoverageForceExitMaxLossUsdc =
        originalMaxLossUsdc;
      (config.marketMaker as { sellCoverageForceExitMaxLossTicks: number }).sellCoverageForceExitMaxLossTicks =
        originalMaxLossTicks;
    }
  });

  it("does not escalate below-minimum dust inventory as a SELL coverage failure", async () => {
    const originalGapCount = config.marketMaker.sellCoverageForceExitAfterGapCount;
    const originalMaxReductionShares =
      config.marketMaker.sellCoverageForceExitMaxReductionShares;

    (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
      1;
    (config.marketMaker as { sellCoverageForceExitMaxReductionShares: number }).sellCoverageForceExitMaxReductionShares =
      5;

    try {
      const dustMarket = {
        ...market,
        orderMinSize: 5
      };
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: vi.fn(() => []),
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.inventoryTracker = {
        exportOpenLots: vi.fn(() => [
          {
            tokenId: dustMarket.tokenIds[0],
            shares: 0.9,
            conditionId: dustMarket.conditionId
          }
        ]),
        getOpenPosition: vi.fn(() => ({
          tokenId: dustMarket.tokenIds[0],
          marketScope: dustMarket.slug,
          conditionId: dustMarket.conditionId,
          outcome: "Yes",
          shares: 0.9,
          totalCostUsdc: 0.36,
          openedAtMs: 0
        }))
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.4, size: 100 }],
          asks: [{ price: 0.42, size: 100 }],
          tickSize: 0.01,
          minOrderSize: 5
        }))
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.lastSellFillAtByTokenId = new Map();
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastSellQuoteReleaseAtByTokenId = new Map();
      bot.consecutiveSellCoverageWatchdogGapsByConditionId = new Map();
      bot.sellCoverageEscalationCooldownUntilMsByConditionId = new Map();
      bot.lastSellCoverageDustLogAtByTokenId = new Map();
      bot.conditionToMarket = new Map([[dustMarket.conditionId, dustMarket]]);
      bot.knownConditionToMarket = new Map([[dustMarket.conditionId, dustMarket]]);
      bot.pendingImmediateReevaluationConditionIds = new Set();
      bot.evaluationLocks = new Set();
      bot.rememberManagedMarket = vi.fn();
      bot.handleTokenUpdate = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      await bot.checkSellCoverage();

      expect(bot.reduceInventoryRiskCandidates).not.toHaveBeenCalled();
      expect(bot.quoteExecutor.cancelMarketQuotes).not.toHaveBeenCalled();
      expect(
        bot.consecutiveSellCoverageWatchdogGapsByConditionId.has(dustMarket.conditionId)
      ).toBe(false);
      expect(bot.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenId: dustMarket.tokenIds[0],
          shares: 0.9,
          minimumSellShares: 5
        }),
        "SELL coverage watchdog ignored below-minimum dust inventory."
      );
    } finally {
      (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
        originalGapCount;
      (config.marketMaker as { sellCoverageForceExitMaxReductionShares: number }).sellCoverageForceExitMaxReductionShares =
        originalMaxReductionShares;
    }
  });

  it("resets SELL-coverage forced-exit escalation after coverage returns", async () => {
    const originalGapCount = config.marketMaker.sellCoverageForceExitAfterGapCount;

    (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
      2;

    try {
      const activeQuotes = vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ tokenId: market.tokenIds[0], side: Side.SELL }])
        .mockReturnValueOnce([]);
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: activeQuotes,
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.inventoryTracker = {
        exportOpenLots: vi.fn(() => [
          {
            tokenId: market.tokenIds[0],
            shares: 20,
            conditionId: market.conditionId
          }
        ]),
        getOpenPosition: vi.fn(() => ({
          tokenId: market.tokenIds[0],
          marketScope: market.slug,
          conditionId: market.conditionId,
          outcome: "Yes",
          shares: 20,
          totalCostUsdc: 8,
          openedAtMs: 0
        }))
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.41, size: 100 }],
          asks: [{ price: 0.43, size: 100 }],
          tickSize: 0.01
        }))
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.lastSellFillAtByTokenId = new Map();
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastSellQuoteReleaseAtByTokenId = new Map();
      bot.consecutiveSellCoverageWatchdogGapsByConditionId = new Map();
      bot.sellCoverageEscalationCooldownUntilMsByConditionId = new Map();
      bot.conditionToMarket = new Map([[market.conditionId, market]]);
      bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
      bot.pendingImmediateReevaluationConditionIds = new Set();
      bot.evaluationLocks = new Set();
      bot.rememberManagedMarket = vi.fn();
      bot.handleTokenUpdate = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      await bot.checkSellCoverage();
      await bot.checkSellCoverage();
      await bot.checkSellCoverage();

      expect(bot.reduceInventoryRiskCandidates).not.toHaveBeenCalled();
      expect(bot.consecutiveSellCoverageWatchdogGapsByConditionId.get(market.conditionId)).toBe(1);
    } finally {
      (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
        originalGapCount;
    }
  });

  it("does not retrigger forced SELL coverage exits while cooldown is active", async () => {
    const originalGapCount = config.marketMaker.sellCoverageForceExitAfterGapCount;
    const originalCooldownMs = config.marketMaker.sellCoverageForceExitCooldownMs;

    (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
      1;
    (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
      120_000;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: vi.fn(() => []),
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.inventoryTracker = {
        exportOpenLots: vi.fn(() => [
          {
            tokenId: market.tokenIds[0],
            shares: 20,
            conditionId: market.conditionId
          }
        ]),
        getOpenPosition: vi.fn(() => ({
          tokenId: market.tokenIds[0],
          marketScope: market.slug,
          conditionId: market.conditionId,
          outcome: "Yes",
          shares: 20,
          totalCostUsdc: 8,
          openedAtMs: 0
        }))
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.41, size: 100 }],
          asks: [{ price: 0.43, size: 100 }],
          tickSize: 0.01
        }))
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.lastSellFillAtByTokenId = new Map();
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastSellQuoteReleaseAtByTokenId = new Map();
      bot.consecutiveSellCoverageWatchdogGapsByConditionId = new Map();
      bot.sellCoverageEscalationCooldownUntilMsByConditionId = new Map();
      bot.conditionToMarket = new Map([[market.conditionId, market]]);
      bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
      bot.pendingImmediateReevaluationConditionIds = new Set();
      bot.evaluationLocks = new Set();
      bot.rememberManagedMarket = vi.fn();
      bot.handleTokenUpdate = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      await bot.checkSellCoverage();
      await bot.checkSellCoverage();

      expect(bot.reduceInventoryRiskCandidates).toHaveBeenCalledTimes(1);
    } finally {
      (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
        originalGapCount;
      (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
        originalCooldownMs;
    }
  });

  it("allows only one forced SELL coverage cleanup per condition while halted", async () => {
    const originalGapCount = config.marketMaker.sellCoverageForceExitAfterGapCount;
    const originalCooldownMs = config.marketMaker.sellCoverageForceExitCooldownMs;

    (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
      1;
    (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
      0;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.quoteExecutor = {
        getActiveQuotes: vi.fn(() => []),
        cancelMarketQuotes: vi.fn(async () => undefined)
      };
      bot.riskReductionExecutor = {};
      bot.riskManager = {
        getState: vi.fn(() => "HALTED")
      };
      bot.inventoryTracker = {
        exportOpenLots: vi.fn(() => [
          {
            tokenId: market.tokenIds[0],
            shares: 20,
            conditionId: market.conditionId
          }
        ]),
        getOpenPosition: vi.fn(() => ({
          tokenId: market.tokenIds[0],
          marketScope: market.slug,
          conditionId: market.conditionId,
          outcome: "Yes",
          shares: 20,
          totalCostUsdc: 8,
          openedAtMs: 0
        }))
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.41, size: 100 }],
          asks: [{ price: 0.43, size: 100 }],
          tickSize: 0.01
        }))
      };
      bot.logger = {
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn()
      };
      bot.lastSellFillAtByTokenId = new Map();
      bot.lastBuyFillAtByTokenId = new Map();
      bot.lastSellQuoteReleaseAtByTokenId = new Map();
      bot.consecutiveSellCoverageWatchdogGapsByConditionId = new Map();
      bot.sellCoverageEscalationCooldownUntilMsByConditionId = new Map();
      bot.haltedSellCoverageCleanupAttemptedConditionIds = new Set();
      bot.conditionToMarket = new Map([[market.conditionId, market]]);
      bot.knownConditionToMarket = new Map([[market.conditionId, market]]);
      bot.pendingImmediateReevaluationConditionIds = new Set();
      bot.evaluationLocks = new Set();
      bot.rememberManagedMarket = vi.fn();
      bot.handleTokenUpdate = vi.fn(async () => undefined);
      bot.syncExecutionEngineWithActiveQuotes = vi.fn();
      bot.reduceInventoryRiskCandidates = vi.fn(async () => undefined);

      await bot.checkSellCoverage();
      await bot.checkSellCoverage();

      expect(bot.reduceInventoryRiskCandidates).toHaveBeenCalledTimes(1);
      expect(bot.quoteExecutor.cancelMarketQuotes).toHaveBeenCalledTimes(1);
    } finally {
      (config.marketMaker as { sellCoverageForceExitAfterGapCount: number }).sellCoverageForceExitAfterGapCount =
        originalGapCount;
      (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
        originalCooldownMs;
    }
  });

  it("starts a post-risk-reduction reentry cooldown after a stuck-inventory sweep reduction", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.inventoryTracker = {
      getOpenPosition: vi.fn(() => undefined),
      getOpenShares: vi.fn(() => 0),
      closeLots: vi.fn(() => ({
        closedKnownShares: 20,
        closedUnknownShares: 0,
        recognizedCostBasisUsdc: 8,
        recognizedProceedsUsdc: 8,
        unrecognizedProceedsUsdc: 0,
        pieces: []
      }))
    };
    bot.pnlEngine = {
      recordTrade: vi.fn()
    };
    bot.riskManager = {
      noteTradeClosed: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.alertDispatcher = {
      dispatch: vi.fn(async () => undefined)
    };
    const beforeMs = Date.now();
    bot.tokenToMarket = new Map([[market.tokenIds[0], market]]);
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.orderBookStore = {
      get: vi.fn((tokenId: string) => ({
        assetId: tokenId,
        market: market.slug,
        bids: [{ price: 0.4, size: 50 }],
        asks: [{ price: 0.42, size: 50 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: undefined,
        hash: undefined,
        updatedAtMs: beforeMs
      }))
    };
    bot.riskReductionReentryCooldownUntilMsByConditionId = new Map();
    bot.lastSellFillAtByTokenId = new Map();
    bot.lastBuyFillAtByTokenId = new Map([[market.tokenIds[0], beforeMs - 30_000]]);
    bot.lastFillAtByConditionId = new Map();
    bot.recentConfirmedInventoryCloseGuardsByTokenId = new Map();
    bot.agedInventoryExitLadderStateByTokenId = new Map();
    bot.sessionMmSellFillCount = 0;
    bot.sessionMmTotalHoldMs = 0;
    bot.sessionMmHoldSampleCount = 0;
    bot.syncTrackedInventoryLots = vi.fn();
    bot.refreshDynamicCapitalSignalFromPerformance = vi.fn();
    bot.refreshScopedCapitalSignalsFromPerformance = vi.fn();

    bot.recordRiskReductionSummary(
      {
        reason: "stuck inventory sweep",
        candidateCount: 1,
        reducedCount: 1,
        reducedShares: 20,
        totalProceedsUsdc: 8,
        results: [
          {
            marketSlug: market.slug,
            tokenId: market.tokenIds[0],
            outcome: "Yes",
            requestedShares: 20,
            status: "reduced",
            reducedShares: 20,
            proceedsUsdc: 8,
            detail: "reduced"
          }
        ]
      },
      "stuck inventory sweep"
    );

    expect(bot.isInsideRiskReductionReentryCooldown(market.conditionId, beforeMs)).toBe(true);
    expect(
      bot.riskReductionReentryCooldownUntilMsByConditionId.get(market.conditionId)
    ).toBeGreaterThanOrEqual(
      beforeMs + config.marketMaker.postRiskReductionReentryCooldownMs
    );
    expect(bot.sessionMmSellFillCount).toBe(1);
    expect(bot.sessionMmHoldSampleCount).toBe(1);
    expect(bot.sessionMmTotalHoldMs).toBeGreaterThanOrEqual(30_000);
    expect(bot.lastFillAtByConditionId.get(market.conditionId)).toBeGreaterThanOrEqual(beforeMs);
    expect(bot.alertDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "order_fill",
        tags: expect.arrayContaining([
          "market-making",
          "sell",
          "risk-reduction",
          "inventory-close"
        ]),
        details: expect.objectContaining({
          side: "SELL",
          shares: 20,
          price: 0.4,
          notionalUsdc: 8,
          realizedPnlUsdc: 0,
          reason: "inventory_close"
        })
      })
    );
  });

  it("stages an aged inventory exit ladder before the max-hold hard exit", () => {
    const originalEnableMaxHoldHardExit = config.marketMaker.enableMaxHoldHardExit;
    const originalMaxHoldHardExitAfterMs = config.marketMaker.maxHoldHardExitAfterMs;
    const originalBreakEvenExitAfterMs = config.marketMaker.breakEvenExitAfterMs;
    const originalBreakEvenExitMaxLossTicks = config.marketMaker.breakEvenExitMaxLossTicks;
    const originalAgeBasedUnwindAfterMs = config.marketMaker.ageBasedUnwindAfterMs;
    const originalStaleBreakEvenUnwindAfterMs =
      config.marketMaker.staleBreakEvenUnwindAfterMs;
    const originalSellCoverageForceExitCooldownMs =
      config.marketMaker.sellCoverageForceExitCooldownMs;

    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit = true;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs = 120_000;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 60_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
      60_000;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                marketScope: market.slug,
                conditionId: market.conditionId,
                outcome: "Yes",
                shares: 20,
                totalCostUsdc: 10,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          tickSize: 0.01
        }))
      };
      bot.agedInventoryExitLadderStateByTokenId = new Map();

      const stageTwoCandidates = bot.buildAgedInventoryExitLadderCandidates(market, 95_000);

      expect(stageTwoCandidates).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          outcome: "Yes",
          stage: 2,
          maxReductionShares: 16,
          minSellPrice: 0.49
        })
      ]);

      bot.agedInventoryExitLadderStateByTokenId.set(market.tokenIds[0], {
        openedAtMs: 0,
        attemptedStage: 2
      });
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 100_000)).toEqual([]);

      const stageThreeCandidates = bot.buildAgedInventoryExitLadderCandidates(market, 115_000);
      expect(stageThreeCandidates).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 3,
          maxReductionShares: 20,
          minSellPrice: 0.49
        })
      ]);
    } finally {
      (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit =
        originalEnableMaxHoldHardExit;
      (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs =
        originalMaxHoldHardExitAfterMs;
      (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs =
        originalBreakEvenExitAfterMs;
      (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks =
        originalBreakEvenExitMaxLossTicks;
      (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs =
        originalAgeBasedUnwindAfterMs;
      (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
        originalStaleBreakEvenUnwindAfterMs;
    }
  });

  it("relaxes aged inventory exit ladder loss limits by stage", () => {
    const originalEnableMaxHoldHardExit = config.marketMaker.enableMaxHoldHardExit;
    const originalMaxHoldHardExitAfterMs = config.marketMaker.maxHoldHardExitAfterMs;
    const originalBreakEvenExitAfterMs = config.marketMaker.breakEvenExitAfterMs;
    const originalBreakEvenExitMaxLossTicks = config.marketMaker.breakEvenExitMaxLossTicks;
    const originalAgeBasedUnwindAfterMs = config.marketMaker.ageBasedUnwindAfterMs;
    const originalStaleBreakEvenUnwindAfterMs =
      config.marketMaker.staleBreakEvenUnwindAfterMs;
    const originalSellCoverageForceExitCooldownMs =
      config.marketMaker.sellCoverageForceExitCooldownMs;

    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit = true;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs = 900_000;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 300_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 4;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
      300_000;
    (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
      60_000;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                marketScope: market.slug,
                conditionId: market.conditionId,
                outcome: "Yes",
                shares: 10,
                totalCostUsdc: 4.1,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          tickSize: 0.01
        }))
      };
      bot.agedInventoryExitLadderStateByTokenId = new Map();

      expect(bot.buildAgedInventoryExitLadderCandidates(market, 90_000)).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 1,
          maxReductionShares: 4,
          minSellPrice: 0.42
        })
      ]);

      bot.agedInventoryExitLadderStateByTokenId.set(market.tokenIds[0], {
        openedAtMs: 0,
        attemptedStage: 1,
        lastAttemptedAtMs: 90_000
      });
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 110_000)).toEqual([]);
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 151_000)).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 1
        })
      ]);

      bot.agedInventoryExitLadderStateByTokenId.clear();
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 230_000)).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 1,
          minSellPrice: 0.42
        })
      ]);

      bot.agedInventoryExitLadderStateByTokenId.clear();
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 500_000)).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 2,
          minSellPrice: 0.39
        })
      ]);

      bot.agedInventoryExitLadderStateByTokenId.clear();
      expect(bot.buildAgedInventoryExitLadderCandidates(market, 750_000)).toEqual([
        expect.objectContaining({
          tokenId: market.tokenIds[0],
          stage: 3,
          minSellPrice: 0.37
        })
      ]);
    } finally {
      (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit =
        originalEnableMaxHoldHardExit;
      (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs =
        originalMaxHoldHardExitAfterMs;
      (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs =
        originalBreakEvenExitAfterMs;
      (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks =
        originalBreakEvenExitMaxLossTicks;
      (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs =
        originalAgeBasedUnwindAfterMs;
      (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
        originalStaleBreakEvenUnwindAfterMs;
      (config.marketMaker as { sellCoverageForceExitCooldownMs: number }).sellCoverageForceExitCooldownMs =
        originalSellCoverageForceExitCooldownMs;
    }
  });

  it("expands aged-inventory reductions to avoid leaving below-minimum dust", () => {
    const originalEnableMaxHoldHardExit = config.marketMaker.enableMaxHoldHardExit;
    const originalMaxHoldHardExitAfterMs = config.marketMaker.maxHoldHardExitAfterMs;
    const originalBreakEvenExitAfterMs = config.marketMaker.breakEvenExitAfterMs;
    const originalBreakEvenExitMaxLossTicks = config.marketMaker.breakEvenExitMaxLossTicks;
    const originalAgeBasedUnwindAfterMs = config.marketMaker.ageBasedUnwindAfterMs;
    const originalStaleBreakEvenUnwindAfterMs =
      config.marketMaker.staleBreakEvenUnwindAfterMs;

    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit = true;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs = 900_000;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 300_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 4;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
      300_000;

    try {
      const minSizeMarket = {
        ...market,
        orderMinSize: 5
      };
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === minSizeMarket.tokenIds[0]
            ? {
                tokenId,
                marketScope: minSizeMarket.slug,
                conditionId: minSizeMarket.conditionId,
                outcome: "Yes",
                shares: 10,
                totalCostUsdc: 5.4,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({ tickSize: 0.01 }))
      };
      bot.agedInventoryExitLadderStateByTokenId = new Map();

      expect(bot.buildAgedInventoryExitLadderCandidates(minSizeMarket, 500_000)).toEqual([
        expect.objectContaining({
          tokenId: minSizeMarket.tokenIds[0],
          stage: 2,
          maxReductionShares: 10
        })
      ]);
    } finally {
      (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit =
        originalEnableMaxHoldHardExit;
      (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs =
        originalMaxHoldHardExitAfterMs;
      (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs =
        originalBreakEvenExitAfterMs;
      (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks =
        originalBreakEvenExitMaxLossTicks;
      (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs =
        originalAgeBasedUnwindAfterMs;
      (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
        originalStaleBreakEvenUnwindAfterMs;
    }
  });

  it("cools down repeated thin top-book execution rejects", () => {
    const originalThreshold = config.marketMaker.thinTopBookRejectionThreshold;
    const originalCooldownMs = config.marketMaker.thinTopBookRejectionCooldownMs;

    (config.marketMaker as { thinTopBookRejectionThreshold: number }).thinTopBookRejectionThreshold = 3;
    (config.marketMaker as { thinTopBookRejectionCooldownMs: number }).thinTopBookRejectionCooldownMs =
      60_000;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.thinTopBookRejectCountByConditionId = new Map();
      bot.thinTopBookRejectCooldownUntilMsByConditionId = new Map();
      bot.thinTopBookRejectCooldownLevelByConditionId = new Map();

      expect(bot.noteThinTopBookReject(market.conditionId, 1_000)).toEqual({
        count: 1,
        activated: false
      });
      expect(bot.noteThinTopBookReject(market.conditionId, 2_000)).toEqual({
        count: 2,
        activated: false
      });
      expect(bot.noteThinTopBookReject(market.conditionId, 3_000)).toEqual({
        count: 3,
        activated: true,
        cooldownUntilMs: 63_000
      });
      expect(bot.isInsideThinTopBookRejectCooldown(market.conditionId, 3_001)).toBe(true);

      bot.pruneThinTopBookRejectCooldowns(63_001);
      expect(bot.isInsideThinTopBookRejectCooldown(market.conditionId, 63_001)).toBe(false);

      expect(bot.noteThinTopBookReject(market.conditionId, 64_000)).toEqual({
        count: 1,
        activated: false
      });
      expect(bot.noteThinTopBookReject(market.conditionId, 65_000)).toEqual({
        count: 2,
        activated: false
      });
      expect(bot.noteThinTopBookReject(market.conditionId, 66_000)).toEqual({
        count: 3,
        activated: true,
        cooldownUntilMs: 186_000
      });
    } finally {
      (config.marketMaker as { thinTopBookRejectionThreshold: number }).thinTopBookRejectionThreshold =
        originalThreshold;
      (config.marketMaker as { thinTopBookRejectionCooldownMs: number }).thinTopBookRejectionCooldownMs =
        originalCooldownMs;
    }
  });

  it("preserves active SELL coverage when an inventory market is rejected for thin top-book liquidity", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getActiveQuotes: vi.fn(() => [
        {
          conditionId: market.conditionId,
          tokenId: market.tokenIds[0],
          side: Side.BUY,
          orderId: "buy-order"
        },
        {
          conditionId: market.conditionId,
          tokenId: market.tokenIds[0],
          side: Side.SELL,
          orderId: "sell-order"
        }
      ]),
      cancelConditionBuyQuotes: vi.fn(async () => undefined),
      cancelMarketQuotes: vi.fn(async () => undefined)
    };
    bot.inventoryTracker = {
      getOpenPosition: vi.fn((tokenId: string) =>
        tokenId === market.tokenIds[0]
          ? {
              tokenId,
              marketScope: market.slug,
              conditionId: market.conditionId,
              outcome: "Yes",
              shares: 10,
              totalCostUsdc: 4,
              openedAtMs: 0
            }
          : undefined
      )
    };
    bot.thinTopBookRejectCountByConditionId = new Map();
    bot.thinTopBookRejectCooldownUntilMsByConditionId = new Map();
    bot.thinTopBookRejectCooldownLevelByConditionId = new Map();
    bot.lastRejectedPlanLogAtByConditionId = new Map();
    bot.lastRejectedPlanLogSignatureByConditionId = new Map();
    bot.syncExecutionEngineWithActiveQuotes = vi.fn();
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };

    await bot.handleRejectedEvaluation(market, {
      status: "rejected",
      reason: "top_book_liquidity_too_thin",
      detail: "Yes topBookLiquidityUsdc(6.82) < minTopBookLiquidityUsdc(30.00)"
    });

    expect(bot.quoteExecutor.cancelConditionBuyQuotes).toHaveBeenCalledWith(
      market.conditionId,
      "market evaluation rejected: top_book_liquidity_too_thin"
    );
    expect(bot.quoteExecutor.cancelMarketQuotes).not.toHaveBeenCalled();
  });

  it("uses the configured bounded loss floor for SELL-coverage forced exits", () => {
    const originalMaxLossUsdc = config.marketMaker.sellCoverageForceExitMaxLossUsdc;
    const originalMaxLossTicks = config.marketMaker.sellCoverageForceExitMaxLossTicks;

    (config.marketMaker as { sellCoverageForceExitMaxLossUsdc: number }).sellCoverageForceExitMaxLossUsdc =
      0.35;
    (config.marketMaker as { sellCoverageForceExitMaxLossTicks: number }).sellCoverageForceExitMaxLossTicks =
      8;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.inventoryTracker = {
        getOpenPosition: vi.fn((tokenId: string) =>
          tokenId === market.tokenIds[0]
            ? {
                tokenId,
                marketScope: market.slug,
                conditionId: market.conditionId,
                outcome: "Yes",
                shares: 10,
                totalCostUsdc: 5.6,
                openedAtMs: 0
              }
            : undefined
        )
      };
      bot.orderBookStore = {
        get: vi.fn(() => ({
          bids: [{ price: 0.49, size: 100 }],
          asks: [{ price: 0.51, size: 100 }],
          tickSize: 0.01
        }))
      };

      expect(
        bot.resolveSellCoverageForcedReductionMinSellPrice(
          market,
          market.tokenIds[0],
          5
        )
      ).toBe(0.49);
    } finally {
      (config.marketMaker as { sellCoverageForceExitMaxLossUsdc: number }).sellCoverageForceExitMaxLossUsdc =
        originalMaxLossUsdc;
      (config.marketMaker as { sellCoverageForceExitMaxLossTicks: number }).sellCoverageForceExitMaxLossTicks =
        originalMaxLossTicks;
    }
  });

  it("throttles inventory-only management logs", () => {
    const originalVerboseLogIntervalMs = config.observability.verboseMarketLogIntervalMs;
    (config.observability as { verboseMarketLogIntervalMs: number }).verboseMarketLogIntervalMs = 5_000;

    try {
      const bot = Object.create(MarketMakerBot.prototype) as any;
      bot.lastInventoryOnlyManagementLogAtByConditionId = new Map();

      expect(bot.shouldLogInventoryOnlyManagement(market.conditionId, 1_000)).toBe(true);
      expect(bot.shouldLogInventoryOnlyManagement(market.conditionId, 30_000)).toBe(false);
      expect(bot.shouldLogInventoryOnlyManagement(market.conditionId, 61_001)).toBe(true);
    } finally {
      (config.observability as { verboseMarketLogIntervalMs: number }).verboseMarketLogIntervalMs =
        originalVerboseLogIntervalMs;
    }
  });

  it("refreshes the market universe immediately after auto-reactivating dead markets", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const nowMs = Date.now();

    bot.operatorControl = {
      isMarketDisabled: vi.fn(() => true),
      enableMarket: vi.fn()
    };
    bot.lastFillAtByConditionId = new Map();
    bot.autoDisabledAtByConditionId = new Map([
      [
        market.conditionId,
        nowMs - config.marketMaker.deadMarketReactivationMs - 1
      ]
    ]);
    bot.stopping = false;
    bot.refreshUniverse = vi.fn(async () => undefined);
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn()
    };

    bot.checkDeadMarkets();
    await flushAsyncWork();

    expect(bot.operatorControl.enableMarket).toHaveBeenCalledWith(market.conditionId);
    expect(bot.refreshUniverse).toHaveBeenCalledTimes(1);
  });

  it("suppresses immediate venue-sync resurrection after a confirmed sell close", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    bot.quoteExecutor = {
      getConditionalBalanceSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          balance: 19.622,
          allowance: 19.622,
          refreshedAtMs: Date.now()
        })
        .mockResolvedValueOnce({
          balance: 0,
          allowance: 0,
          refreshedAtMs: Date.now()
        })
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.positionManager = {
      updateTokenInventory: vi.fn(),
      syncTrackedInventoryLots: vi.fn()
    };
    bot.inventoryTracker = {
      getOpenShares: vi.fn((tokenId: string) => (tokenId === market.tokenIds[0] ? 0.002 : 0)),
      reconcileVenuePosition: vi.fn().mockReturnValue(false)
    };
    bot.lastVenueInventoryReconciliationAtByConditionId = new Map();
    bot.oneSideFillRecoveryByConditionId = new Map();
    bot.recentConfirmedInventoryCloseGuardsByTokenId = new Map([
      [
        market.tokenIds[0],
        {
          tokenId: market.tokenIds[0],
          conditionId: market.conditionId,
          marketSlug: market.slug,
          closedAtMs: Date.now(),
          closedShares: 19.62,
          remainingSharesAfterClose: 0
        }
      ]
    ]);
    bot.getCurrentBestBid = vi.fn(() => 0.4);
    bot.syncTrackedInventoryLots = vi.fn();
    bot.alertDispatcher = {
      dispatch: vi.fn()
    };

    await bot.reconcileVenueInventoryForMarket(market, Date.now(), true);

    expect(bot.inventoryTracker.reconcileVenuePosition).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: market.tokenIds[0],
        venueBalance: 0.002
      })
    );
    expect(bot.positionManager.updateTokenInventory).toHaveBeenCalledWith(
      market.tokenIds[0],
      expect.objectContaining({
        balance: 0.002
      })
    );
  });

  it("suppresses partial inventory resurrection after a maker sell close", async () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const nowMs = Date.now();
    bot.quoteExecutor = {
      getConditionalBalanceSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          balance: 19.78,
          allowance: 19.78,
          refreshedAtMs: nowMs
        })
        .mockResolvedValueOnce({
          balance: 0,
          allowance: 0,
          refreshedAtMs: nowMs
        })
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.positionManager = {
      updateTokenInventory: vi.fn(),
      syncTrackedInventoryLots: vi.fn()
    };
    bot.inventoryTracker = {
      getOpenShares: vi.fn((tokenId: string) => (tokenId === market.tokenIds[0] ? 14.78 : 0)),
      reconcileVenuePosition: vi.fn().mockReturnValue(false)
    };
    bot.lastVenueInventoryReconciliationAtByConditionId = new Map();
    bot.oneSideFillRecoveryByConditionId = new Map();
    bot.recentConfirmedInventoryCloseGuardsByTokenId = new Map([
      [
        market.tokenIds[0],
        {
          tokenId: market.tokenIds[0],
          conditionId: market.conditionId,
          marketSlug: market.slug,
          closedAtMs: nowMs,
          closedShares: 5,
          remainingSharesAfterClose: 14.78
        }
      ]
    ]);
    bot.getCurrentBestBid = vi.fn(() => 0.63);
    bot.syncTrackedInventoryLots = vi.fn();
    bot.alertDispatcher = {
      dispatch: vi.fn()
    };

    await bot.reconcileVenueInventoryForMarket(market, nowMs, true);

    expect(bot.inventoryTracker.reconcileVenuePosition).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: market.tokenIds[0],
        venueBalance: 14.78
      })
    );
    expect(bot.positionManager.updateTokenInventory).toHaveBeenCalledWith(
      market.tokenIds[0],
      expect.objectContaining({
        balance: 14.78
      })
    );
  });

  it("clamps SELL-planning shares to the post-close remainder during the recent close guard", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const nowMs = Date.now();

    bot.inventoryTracker = {
      getOpenShares: vi.fn(() => 20)
    };
    bot.recentConfirmedInventoryCloseGuardsByTokenId = new Map([
      [
        market.tokenIds[0],
        {
          tokenId: market.tokenIds[0],
          conditionId: market.conditionId,
          marketSlug: market.slug,
          closedAtMs: nowMs,
          closedShares: 20,
          remainingSharesAfterClose: 0
        }
      ]
    ]);
    bot.logger = {
      debug: vi.fn()
    };

    const trustedShares = bot["getTrustedTrackedOpenSharesForSellPlanning"](
      market,
      market.tokenIds[0],
      nowMs + 1_000
    );

    expect(trustedShares).toBe(0);
  });

  it("requests an immediate reevaluation after a maker SELL fill", () => {
    const bot = Object.create(MarketMakerBot.prototype) as any;
    const nowMs = Date.now();
    let openPosition: any = {
      tokenId: market.tokenIds[0],
      conditionId: market.conditionId,
      marketScope: market.slug,
      outcome: "Yes",
      shares: 10,
      totalCostUsdc: 4,
      openedAtMs: nowMs - 30_000
    };

    bot.quoteExecutor = {
      invalidateConditionalBalance: vi.fn()
    };
    bot.inventoryTracker = {
      getOpenPosition: vi.fn(() => openPosition),
      closeLots: vi.fn(() => {
        openPosition = undefined;
        return {
          closedKnownShares: 10,
          closedUnknownShares: 0,
          recognizedCostBasisUsdc: 4,
          recognizedProceedsUsdc: 4.2,
          unrecognizedProceedsUsdc: 0,
          pieces: [
            {
              lotId: "lot-1",
              strategy: "market-making",
              marketScope: market.slug,
              conditionId: market.conditionId,
              tokenId: market.tokenIds[0],
              outcome: "Yes",
              shares: 10,
              costBasisUsdc: 4,
              proceedsUsdc: 4.2,
              realizedPnlUsdc: 0.2,
              openedAtMs: nowMs - 30_000,
              closedAtMs: nowMs
            }
          ]
        };
      })
    };
    bot.pnlEngine = {
      recordTrade: vi.fn()
    };
    bot.riskManager = {
      noteTradeClosed: vi.fn()
    };
    bot.logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn()
    };
    bot.positionManager = {
      deductTokenInventoryShares: vi.fn()
    };
    bot.lastSellFillAtByTokenId = new Map();
    bot.lastFillAtByConditionId = new Map();
    bot.lastBuyFillAtByTokenId = new Map([[market.tokenIds[0], nowMs - 30_000]]);
    bot.oneSideAggressiveExitRejectCountByTokenId = new Map();
    bot.recentConfirmedInventoryCloseGuardsByTokenId = new Map();
    bot.agedInventoryExitLadderStateByTokenId = new Map();
    bot.oneSideFillRecoveryByConditionId = new Map();
    bot.sessionMmSellFillCount = 0;
    bot.sessionMmTotalHoldMs = 0;
    bot.sessionMmHoldSampleCount = 0;
    bot.syncTrackedInventoryLots = vi.fn();
    bot.refreshDynamicCapitalSignalFromPerformance = vi.fn();
    bot.refreshScopedCapitalSignalsFromPerformance = vi.fn();
    bot.buildMakerFillAlertContext = vi.fn(() => ({
      positionBeforeShares: 10,
      positionAfterShares: 0
    }));
    bot.alertDispatcher = {
      dispatch: vi.fn(async () => undefined)
    };
    bot.conditionToMarket = new Map([[market.conditionId, market]]);
    bot.knownConditionToMarket = new Map();
    bot.knownSlugToMarket = new Map([[market.slug, market]]);
    bot.requestImmediateConditionReevaluation = vi.fn();
    bot.refreshPostBuySellFeasibilityBlock = vi.fn();

    bot["handleMakerFill"]({
      tradeId: "trade-sell-1",
      date: new Date(nowMs).toISOString(),
      matchedAt: new Date(nowMs).toISOString(),
      conditionId: market.conditionId,
      marketSlug: market.slug,
      feesEnabled: true,
      assetId: market.tokenIds[0],
      outcome: "Yes",
      side: "SELL",
      shares: 10,
      price: 0.42,
      notionalUsdc: 4.2,
      feeEquivalentUsdc: 0,
      maxPotentialRebateUsdc: 0,
      makerRebatePct: 0
    });

    expect(bot.requestImmediateConditionReevaluation).toHaveBeenCalledWith(market.conditionId);
  });
});
