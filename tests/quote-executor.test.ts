import { OrderType, Side } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { PositionManager } from "../src/core/position-manager.js";
import type { MarketMakerPlan } from "../src/strategy/market-maker.js";
import { QuoteExecutor } from "../src/trading/quote-executor.js";
import type { BinaryMarket } from "../src/types.js";

const cryptoMarket: BinaryMarket = {
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

const secondCryptoMarket: BinaryMarket = {
  ...cryptoMarket,
  id: "market-2",
  conditionId: "condition-2",
  questionId: "question-2",
  question: "Will ETH be above 8k?",
  slug: "eth-above-8k",
  tokenIds: ["eth-yes", "eth-no"]
};

const toRawConditionalUnits = (shares: number): string => String(shares * 1_000_000);

describe("QuoteExecutor", () => {
  const originalMaxTokenExposureShares = config.marketMaker.maxTokenExposureShares;
  const originalMaxTokenExposurePortfolioRatio = config.marketMaker.maxTokenExposurePortfolioRatio;
  const originalMaxCategoryExposureUsdc = config.marketMaker.maxCategoryExposureUsdc;
  const originalMarketMakingBudgetUsdc = config.capital.marketMakingBudgetUsdc;
  const originalRequoteCooldownMs = config.marketMaker.requoteCooldownMs;
  const originalStaleRequoteAfterMs = config.marketMaker.staleRequoteAfterMs;
  const originalPassiveRefreshMinRestMs = config.marketMaker.passiveRefreshMinRestMs;
  const originalPassiveRefreshMaxSaferDriftTicks =
    config.marketMaker.passiveRefreshMaxSaferDriftTicks;
  const originalEnablePassiveSellTracking = config.marketMaker.enablePassiveSellTracking;
  const originalPassiveSellTrackingTriggerBps =
    config.marketMaker.passiveSellTrackingTriggerBps;
  const originalPassiveSellTrackingTriggerAbsolute =
    config.marketMaker.passiveSellTrackingTriggerAbsolute;
  const originalPassiveSellMaxAgeMs = config.marketMaker.passiveSellMaxAgeMs;
  const originalPassiveBuyMaxAgeMs = config.marketMaker.passiveBuyMaxAgeMs;
  const originalPassiveBuyWeakSignalMaxAgeMs =
    config.marketMaker.passiveBuyWeakSignalMaxAgeMs;
  const originalPassiveBuyNoTradeMaxAgeMs =
    config.marketMaker.passiveBuyNoTradeMaxAgeMs;
  const originalPassiveBuyMaxExpectedExitSeconds =
    config.marketMaker.passiveBuyMaxExpectedExitSeconds;
  const originalPassiveToAggressiveAfterMs = config.marketMaker.passiveToAggressiveAfterMs;
  const originalBalanceRefreshMs = config.marketMaker.balanceRefreshMs;
  const originalQuoteSize = config.marketMaker.quoteSize;
  const baselineTestMarketMakingBudgetUsdc = Math.max(originalMarketMakingBudgetUsdc, 1_000);

  beforeEach(() => {
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc =
      baselineTestMarketMakingBudgetUsdc;
  });

  afterEach(() => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares =
      originalMaxTokenExposureShares;
    (
      config.marketMaker as { maxTokenExposurePortfolioRatio: number }
    ).maxTokenExposurePortfolioRatio = originalMaxTokenExposurePortfolioRatio;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc =
      originalMaxCategoryExposureUsdc;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc =
      originalMarketMakingBudgetUsdc;
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs =
      originalRequoteCooldownMs;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs =
      originalStaleRequoteAfterMs;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs =
      originalPassiveRefreshMinRestMs;
    (
      config.marketMaker as { passiveRefreshMaxSaferDriftTicks: number }
    ).passiveRefreshMaxSaferDriftTicks = originalPassiveRefreshMaxSaferDriftTicks;
    (config.marketMaker as { enablePassiveSellTracking: boolean }).enablePassiveSellTracking =
      originalEnablePassiveSellTracking;
    (config.marketMaker as { passiveSellTrackingTriggerBps: number }).passiveSellTrackingTriggerBps =
      originalPassiveSellTrackingTriggerBps;
    (
      config.marketMaker as { passiveSellTrackingTriggerAbsolute: number }
    ).passiveSellTrackingTriggerAbsolute = originalPassiveSellTrackingTriggerAbsolute;
    (config.marketMaker as { passiveSellMaxAgeMs: number }).passiveSellMaxAgeMs =
      originalPassiveSellMaxAgeMs;
    (config.marketMaker as { passiveBuyMaxAgeMs: number }).passiveBuyMaxAgeMs =
      originalPassiveBuyMaxAgeMs;
    (
      config.marketMaker as { passiveBuyWeakSignalMaxAgeMs: number }
    ).passiveBuyWeakSignalMaxAgeMs = originalPassiveBuyWeakSignalMaxAgeMs;
    (
      config.marketMaker as { passiveBuyNoTradeMaxAgeMs: number }
    ).passiveBuyNoTradeMaxAgeMs = originalPassiveBuyNoTradeMaxAgeMs;
    (
      config.marketMaker as { passiveBuyMaxExpectedExitSeconds: number }
    ).passiveBuyMaxExpectedExitSeconds = originalPassiveBuyMaxExpectedExitSeconds;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      originalPassiveToAggressiveAfterMs;
    (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs =
      originalBalanceRefreshMs;
    (config.marketMaker as { quoteSize: number }).quoteSize = originalQuoteSize;
  });

  it("suppresses new buy quotes when the category exposure cap would be exceeded", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 20;

    const client = {
      getBalanceAllowance: vi.fn().mockImplementation(({ token_id }: { token_id?: string }) => {
        if (token_id === "eth-yes") {
          return Promise.resolve({
            balance: toRawConditionalUnits(50),
            allowance: toRawConditionalUnits(50)
          });
        }

        return Promise.resolve({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        });
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "sell-order-1" },
          { success: true, orderID: "sell-order-2" }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket, secondCryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: true,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: true,
          rebateEfficiencyScore: 1,
          rebatePrioritySide: Side.BUY,
          rebateInwardTicks: 1,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.5,
              size: 25,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 25,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: true,
          rebateEfficiencyScore: 1,
          rebatePrioritySide: Side.SELL,
          rebateInwardTicks: 1,
          quotes: [
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.BUY,
              price: 0.49,
              size: 25,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.SELL,
              price: 0.5,
              size: 25,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.5,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.SELL,
          price: 0.5,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect(client.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tokenID: "yes-token",
        side: "SELL"
      }),
      expect.anything()
    );
    expect(client.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tokenID: "no-token",
        side: "SELL"
      }),
      expect.anything()
    );
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "Crypto",
        maxCategoryExposureUsdc: 20
      }),
      "Suppressed buy quote because category exposure would exceed the configured cap."
    );
  });

  it("logs an info breadcrumb when a recovery opposing-side buy is suppressed by exposure caps", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 10;

    const client = {
      getBalanceAllowance: vi.fn().mockImplementation(({ token_id }: { token_id?: string }) => {
        if (token_id === "yes-token") {
          return Promise.resolve({
            balance: toRawConditionalUnits(20),
            allowance: toRawConditionalUnits(20)
          });
        }

        return Promise.resolve({
          balance: "0",
          allowance: "0"
        });
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [{ success: true, orderID: "recovery-sell-order" }]
        })
        .mockResolvedValueOnce({
          orders: []
        })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: false,
          orderType: OrderType.GTC,
          quoteSlot: "one-side-aggressive-exit:1",
          executionStyle: "one-side-aggressive-exit"
        }
      ]
    });

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: false,
          orderType: OrderType.GTC,
          quoteSlot: "one-side-aggressive-exit:1",
          executionStyle: "one-side-aggressive-exit"
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.67,
          size: 20,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect((logger as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "no-token",
        outcome: "No",
        reasonCode: "category_exposure_cap",
        activeRecoverySellQuotes: [
          expect.objectContaining({
            tokenId: "yes-token",
            quoteSlot: "one-side-aggressive-exit:1"
          })
        ]
      }),
      "Suppressed recovery opposing-side BUY before posting."
    );
  });

  it("suppresses sell quotes when the account starts flat", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({ balance: "0", allowance: "0" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "buy-order-2" }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect(client.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tokenID: "yes-token",
        side: "BUY"
      }),
      expect.anything()
    );
    expect(client.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tokenID: "no-token",
        side: "BUY"
      }),
      expect.anything()
    );
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        balance: 0,
        allowance: 0,
        projectedReservedSellSize: 5
      }),
      "Suppressed sell quote because inventory or allowance was insufficient."
    );
  });

  it("suppresses buy quotes when token exposure would exceed the configured portfolio ratio cap", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    (
      config.marketMaker as { maxTokenExposurePortfolioRatio: number }
    ).maxTokenExposurePortfolioRatio = 0.2;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 20;

    const client = {
      getBalanceAllowance: vi.fn().mockImplementation(({ token_id }: { token_id?: string }) => {
        if (token_id === "yes-token") {
          return Promise.resolve({
            balance: toRawConditionalUnits(10),
            allowance: toRawConditionalUnits(10)
          });
        }

        return Promise.resolve({ balance: "0", allowance: "0" });
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [{ success: true, orderID: "sell-order-1" }]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: "yes-token",
        side: Side.SELL
      }),
      expect.anything()
    );
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        maxTokenExposurePortfolioRatio: 0.2
      }),
      "Suppressed buy quote because token exposure would exceed the configured portfolio ratio cap."
    );
  });

  it("invalidates cached conditional balances after a fill so sell quotes can retry with fresh venue state", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValue({
          balance: toRawConditionalUnits(5),
          allowance: toRawConditionalUnits(5)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-1" },
            { success: true, orderID: "sell-order-1" }
          ]
        })
        .mockResolvedValueOnce({
          orders: [{ success: true, orderID: "sell-order-2" }]
        })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const sellOnlyPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    await executor.reconcile(sellOnlyPlan);
    expect(client.createOrder).toHaveBeenCalledTimes(2);

    executor.invalidateConditionalBalance("yes-token");

    await executor.reconcile(sellOnlyPlan);
    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(client.postOrders).toHaveBeenCalledTimes(2);
  });

  it("reposts a passive SELL in the same refresh cycle when sell tracking forces a refresh", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { quoteSize: number }).quoteSize = 5;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-1" },
            { success: true, orderID: "sell-order-1" },
            { success: true, orderID: "buy-order-2" },
            { success: true, orderID: "sell-order-2" }
          ]
        })
        .mockResolvedValueOnce({
          orders: []
        }),
      cancelOrder: vi.fn().mockResolvedValue({})
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const initialPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.BUY,
              price: 0.49,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.SELL,
              price: 0.51,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    await executor.reconcile(initialPlan);

    const refreshedPlan = {
      ...initialPlan,
      generatedAtMs: Date.now() + 1,
      tokenPlans: [
        {
          ...initialPlan.tokenPlans[0]!,
          quotes: [
            initialPlan.tokenPlans[0]!.quotes[0]!,
            {
              ...initialPlan.tokenPlans[0]!.quotes[1]!,
              price: 0.52
            }
          ]
        },
        initialPlan.tokenPlans[1]!
      ],
      quotes: [
        initialPlan.quotes[0]!,
        {
          ...initialPlan.quotes[1]!,
          price: 0.52
        }
      ]
    };

    await executor.reconcile(refreshedPlan);

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(client.createOrder).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tokenID: "yes-token",
        side: "SELL",
        price: 0.52
      }),
      expect.anything()
    );
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenIds: ["yes-token"]
      }),
      "Refreshing passive SELL ladder at the current market tracking anchor."
    );
  });

  it("forces a fresh balance check before reposting a SELL quote", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { balanceRefreshMs: number }).balanceRefreshMs = 60_000;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({
          balance: toRawConditionalUnits(12),
          allowance: toRawConditionalUnits(12)
        })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValueOnce({
        orders: [{ success: true, orderID: "sell-order-1" }]
      }),
      cancelOrder: vi.fn().mockResolvedValue({})
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const firstPlan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 12,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };
    const refreshedPlan: MarketMakerPlan = {
      ...firstPlan,
      generatedAtMs: Date.now() + 1_000,
      tokenPlans: [
        {
          ...firstPlan.tokenPlans[0],
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.52,
              size: 12,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        firstPlan.tokenPlans[1]
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.52,
          size: 12,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    await executor.reconcile(firstPlan);
    await executor.reconcile(refreshedPlan);

    expect(client.getBalanceAllowance).toHaveBeenCalledTimes(2);
    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.postOrders).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        balance: 0,
        allowance: 0,
        projectedReservedSellSize: 12
      }),
      "Suppressed sell quote because inventory or allowance was insufficient."
    );
  });

  it("keeps unchanged passive BUY quotes resting even after the stale requote interval", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 60_000;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 5_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 0;
    (config.marketMaker as { passiveSellMaxAgeMs: number }).passiveSellMaxAgeMs = 120_000;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-1" },
            { success: true, orderID: "sell-order-1" }
          ]
        })
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-2" },
            { success: true, orderID: "sell-order-2" }
          ]
        }),
      cancelOrders: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
      const firstNow = Date.now();
      const stablePlan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: false,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              }
            ]
          },
          {
            tokenId: "no-token",
            outcome: "No",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: []
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          }
        ]
      };

      await executor.reconcile(stablePlan);
      vi.advanceTimersByTime(6_000);
      expect(Date.now() - firstNow).toBe(6_000);
      expect(config.marketMaker.staleRequoteAfterMs).toBe(5_000);
      await executor.reconcile({
        ...stablePlan,
        generatedAtMs: Date.now()
      });

      expect(client.cancelOrders).not.toHaveBeenCalled();
      expect(client.createOrder).toHaveBeenCalledTimes(1);
      expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).not.toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          staleRequoteAfterMs: 5_000
        }),
        "Refreshing stale passive quotes at the current top-of-book target."
      );
      expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).not.toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          requoteCooldownMs: 60_000
        }),
        "Bypassed requote cooldown to refresh stale passive quotes."
      );
      expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).not.toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          requoteCooldownMs: 60_000
        }),
        "Skipped quote refresh because the market is still inside the requote cooldown."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes unchanged passive BUY quotes after the configured freshness lease expires", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 60_000;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 5_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 0;
    (config.marketMaker as { passiveSellMaxAgeMs: number }).passiveSellMaxAgeMs = 120_000;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [{ success: true, orderID: "buy-order-1" }]
        })
        .mockResolvedValueOnce({
          orders: [{ success: true, orderID: "buy-order-2" }]
        }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));

      const stablePlan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: false,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC,
                maxRestingAgeMs: 5_000
              }
            ]
          },
          {
            tokenId: "no-token",
            outcome: "No",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: []
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC,
            maxRestingAgeMs: 5_000
          }
        ]
      };

      await executor.reconcile(stablePlan);
      vi.advanceTimersByTime(6_000);

      await executor.reconcile({
        ...stablePlan,
        generatedAtMs: Date.now()
      });

      expect(client.cancelOrder).toHaveBeenCalledTimes(1);
      expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "buy-order-1" });
      expect(client.createOrder).toHaveBeenCalledTimes(2);
      expect(
        (logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          staleQuoteKeys: ["yes-token:BUY:primary"]
        }),
        "Refreshing stale passive quotes at the current top-of-book target."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels expired passive BUY quotes globally without waiting for market reconcile", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: "0",
        allowance: "0"
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [{ success: true, orderID: "buy-order-1" }]
      }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrders: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const onQuoteCancelled = vi.fn();
    const executor = new QuoteExecutor(
      client as never,
      logger,
      undefined,
      undefined,
      { onQuoteCancelled }
    );

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));

      const plan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: false,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC,
                maxRestingAgeMs: 5_000
              }
            ]
          },
          {
            tokenId: "no-token",
            outcome: "No",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: []
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC,
            maxRestingAgeMs: 5_000
          }
        ]
      } satisfies MarketMakerPlan;

      await executor.reconcile(plan);
      expect(executor.getActiveQuotes().map((quote) => quote.orderId)).toEqual([
        "buy-order-1"
      ]);

      vi.advanceTimersByTime(5_001);
      const cancelledQuotes = await executor.cancelExpiredPassiveBuyQuotes(
        Date.now(),
        "unit-test passive buy watchdog"
      );

      expect(cancelledQuotes.map((quote) => quote.orderId)).toEqual(["buy-order-1"]);
      expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "buy-order-1" });
      expect(executor.getActiveQuotes()).toEqual([]);
      expect(onQuoteCancelled).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "buy-order-1" }),
        "unit-test passive buy watchdog"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send duplicate venue cancels while an order cancel is already in flight", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    let resolveCancel: ((value?: unknown) => void) | undefined;
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: "0",
        allowance: "0"
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [{ success: true, orderID: "buy-order-1" }]
      }),
      cancelOrder: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveCancel = resolve;
          })
      ),
      cancelOrders: vi.fn()
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const plan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    } satisfies MarketMakerPlan;

    await executor.reconcile(plan);

    const firstCancel = executor.cancelQuotesBySide(Side.BUY, "first cancel");
    await Promise.resolve();
    const secondCancel = executor.cancelQuotesBySide(Side.BUY, "duplicate cancel");

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    resolveCancel?.();
    await Promise.all([firstCancel, secondCancel]);

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(executor.getActiveQuotes()).toEqual([]);
  });

  it("refreshes unchanged passive SELL quotes only after the passive sell max-age threshold", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 60_000;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 5_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 0;
    (config.marketMaker as { passiveSellMaxAgeMs: number }).passiveSellMaxAgeMs = 5_000;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-1" },
            { success: true, orderID: "sell-order-1" }
          ]
        })
        .mockResolvedValueOnce({
          orders: [{ success: true, orderID: "sell-order-2" }]
        }),
      cancelOrder: vi.fn().mockResolvedValue(undefined),
      cancelOrders: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
      const stablePlan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: false,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              },
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.SELL,
                price: 0.51,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              }
            ]
          },
          {
            tokenId: "no-token",
            outcome: "No",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: []
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          },
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.SELL,
            price: 0.51,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          }
        ]
      };

      await executor.reconcile(stablePlan);
      vi.advanceTimersByTime(6_000);
      await executor.reconcile({
        ...stablePlan,
        generatedAtMs: Date.now()
      });

      expect(client.cancelOrders).not.toHaveBeenCalled();
      expect(client.cancelOrder).toHaveBeenCalledTimes(1);
      expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "sell-order-1" });
      expect(client.createOrder).toHaveBeenCalledTimes(3);
      expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          staleRequoteAfterMs: 5_000,
          passiveSellMaxAgeMs: 5_000,
          staleQuoteKeys: ["yes-token:SELL:primary"]
        }),
        "Refreshing stale passive quotes at the current top-of-book target."
      );
      expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          requoteCooldownMs: 60_000
        }),
        "Bypassed requote cooldown to refresh stale passive quotes."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a passive BUY quote resting when the new target is only one safer tick more aggressive", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 60_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 15_000;
    (
      config.marketMaker as { passiveRefreshMaxSaferDriftTicks: number }
    ).passiveRefreshMaxSaferDriftTicks = 2;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "sell-order-1" }
        ]
      }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const initialPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 5,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    await executor.reconcile(initialPlan);

    await executor.reconcile({
      ...initialPlan,
      generatedAtMs: Date.now() + 1,
      tokenPlans: [
        {
          ...initialPlan.tokenPlans[0]!,
          quotes: [
            {
              ...initialPlan.tokenPlans[0]!.quotes[0]!,
              price: 0.5
            },
            initialPlan.tokenPlans[0]!.quotes[1]!
          ]
        }
      ],
      quotes: [
        {
          ...initialPlan.quotes[0]!,
          price: 0.5
        },
        initialPlan.quotes[1]!
      ]
    });

    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect(client.cancelOrders).not.toHaveBeenCalled();
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("refreshes the full passive SELL ladder when the tracked market anchor moves by one tick", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 60_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 15_000;
    (
      config.marketMaker as { passiveRefreshMaxSaferDriftTicks: number }
    ).passiveRefreshMaxSaferDriftTicks = 2;
    (config.marketMaker as { enablePassiveSellTracking: boolean }).enablePassiveSellTracking =
      true;
    (config.marketMaker as { passiveSellTrackingTriggerBps: number }).passiveSellTrackingTriggerBps =
      100;
    (
      config.marketMaker as { passiveSellTrackingTriggerAbsolute: number }
    ).passiveSellTrackingTriggerAbsolute = 0.01;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "buy-order-1" },
            { success: true, orderID: "sell-order-0" },
            { success: true, orderID: "sell-order-1" },
            { success: true, orderID: "sell-order-2" }
          ]
        })
        .mockResolvedValueOnce({
          orders: [
            { success: true, orderID: "sell-order-0b" },
            { success: true, orderID: "sell-order-1b" },
            { success: true, orderID: "sell-order-2b" }
          ]
        }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    const initialPlan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 20,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            },
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.SELL,
              price: 0.51,
              size: 20,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 20,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC,
          quoteSlot: "sell-layer-0"
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.52,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC,
          quoteSlot: "sell-layer-1"
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.53,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC,
          quoteSlot: "sell-layer-2"
        }
      ]
    };

    await executor.reconcile(initialPlan);

    await executor.reconcile({
      ...initialPlan,
      generatedAtMs: Date.now() + 1,
      quotes: [
        initialPlan.quotes[0]!,
        {
          ...initialPlan.quotes[1]!,
          price: 0.5
        },
        {
          ...initialPlan.quotes[2]!,
          price: 0.51
        },
        {
          ...initialPlan.quotes[3]!,
          price: 0.52
        }
      ]
    });

    expect(client.cancelOrders).toHaveBeenCalledTimes(1);
    expect(client.cancelOrders).toHaveBeenCalledWith([
      "sell-order-0",
      "sell-order-1",
      "sell-order-2"
    ]);
    expect(client.createOrder).toHaveBeenCalledTimes(7);
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenIds: ["yes-token"],
        triggerBps: 100,
        triggerAbsolute: 0.01
      }),
      "Refreshing passive SELL ladder at the current market tracking anchor."
    );
  });

  it("lets passive BUY quotes keep resting through a two-tick safer repricing while still inside the minimum rest window", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 60_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 15_000;
    (
      config.marketMaker as { passiveRefreshMaxSaferDriftTicks: number }
    ).passiveRefreshMaxSaferDriftTicks = 2;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "sell-order-1" }
        ]
      }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));

      const initialPlan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: false,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5000,
            rewardEligible: false,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              },
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.SELL,
                price: 0.51,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              }
            ]
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          },
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.SELL,
            price: 0.51,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          }
        ]
      };

      await executor.reconcile(initialPlan);
      vi.advanceTimersByTime(10_000);

      await executor.reconcile({
        ...initialPlan,
        generatedAtMs: Date.now(),
        tokenPlans: [
          {
            ...initialPlan.tokenPlans[0]!,
            quotes: [
              {
                ...initialPlan.tokenPlans[0]!.quotes[0]!,
                price: 0.51
              },
              initialPlan.tokenPlans[0]!.quotes[1]!
            ]
          }
        ],
        quotes: [
          {
            ...initialPlan.quotes[0]!,
            price: 0.51
          },
          initialPlan.quotes[1]!
        ]
      });

      expect(client.createOrder).toHaveBeenCalledTimes(2);
      expect(client.cancelOrders).not.toHaveBeenCalled();
      expect(client.cancelOrder).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers stale refresh for non-scoring passive BUY quotes until the passive-to-aggressive window elapses", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;
    (config.marketMaker as { staleRequoteAfterMs: number }).staleRequoteAfterMs = 15_000;
    (config.marketMaker as { passiveRefreshMinRestMs: number }).passiveRefreshMinRestMs = 15_000;
    (config.marketMaker as { passiveSellMaxAgeMs: number }).passiveSellMaxAgeMs = 15_000;
    (
      config.marketMaker as { passiveRefreshMaxSaferDriftTicks: number }
    ).passiveRefreshMaxSaferDriftTicks = 2;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      45_000;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    vi.useFakeTimers();

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "sell-order-1" }
        ]
      }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    try {
      executor.setMarketUniverse([cryptoMarket]);
      vi.setSystemTime(new Date("2026-04-11T00:00:00.000Z"));

      const plan: MarketMakerPlan = {
        market: cryptoMarket,
        generatedAtMs: Date.now(),
        rewardActive: true,
        tokenPlans: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            midpoint: 0.5,
            bestBid: 0.49,
            bestAsk: 0.51,
            observedSpread: 0.02,
            observedSpreadTicks: 2,
            topBookLiquidityUsdc: 5_000,
            rewardEligible: true,
            rebateEfficiencyScore: 0,
            rebateInwardTicks: 0,
            quotes: [
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.BUY,
                price: 0.49,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              },
              {
                tokenId: "yes-token",
                outcome: "Yes",
                side: Side.SELL,
                price: 0.51,
                size: 5,
                tickSize: 0.01,
                postOnly: true,
                orderType: OrderType.GTC
              }
            ]
          }
        ],
        quotes: [
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.BUY,
            price: 0.49,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          },
          {
            tokenId: "yes-token",
            outcome: "Yes",
            side: Side.SELL,
            price: 0.51,
            size: 5,
            tickSize: 0.01,
            postOnly: true,
            orderType: OrderType.GTC
          }
        ]
      };

      await executor.reconcile(plan);
      executor.updateRewardScoring({
        "buy-order-1": false,
        "sell-order-1": true
      });

      vi.advanceTimersByTime(20_000);
      await executor.reconcile({
        ...plan,
        generatedAtMs: Date.now()
      });

      expect(client.cancelOrders).not.toHaveBeenCalled();
      expect(client.cancelOrder).toHaveBeenCalledTimes(1);
      expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "sell-order-1" });
      expect(client.createOrder).toHaveBeenCalledTimes(3);
      expect(
        executor.getActiveQuote("yes-token", Side.BUY)?.orderId
      ).toBe("buy-order-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels only BUY quotes when degraded mode requests active buy withdrawal", async () => {
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 1_000;
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "sell-order-1" },
          { success: true, orderID: "buy-order-2" },
          { success: true, orderID: "sell-order-2" }
        ]
      }),
      cancelOrders: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: true,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: true,
          rebateEfficiencyScore: 1,
          rebatePrioritySide: Side.BUY,
          rebateInwardTicks: 1,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: true,
          rebateEfficiencyScore: 1,
          rebatePrioritySide: Side.SELL,
          rebateInwardTicks: 1,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.SELL,
          price: 0.5,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    await executor.cancelQuotesBySide(Side.BUY, "risk degraded");

    expect(client.cancelOrders).toHaveBeenCalledWith(["buy-order-1", "buy-order-2"]);
    expect(executor.getActiveQuotes().map((quote) => quote.orderId)).toEqual([
      "sell-order-1",
      "sell-order-2"
    ]);
  });

  it("keeps recently cancelled quotes addressable for late fill attribution", async () => {
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(100),
          allowance: toRawConditionalUnits(100)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "sell-order-1" }
        ]
      }),
      cancelOrders: vi.fn().mockResolvedValue(undefined),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 20,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.5,
          size: 20,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    const trackedQuoteBeforeCancel = executor.getActiveQuotes()[0];
    expect(trackedQuoteBeforeCancel).toBeTruthy();

    await executor.cancelQuotesBySide(trackedQuoteBeforeCancel!.side, "quote refresh");

    expect(executor.getActiveQuoteByOrderId(trackedQuoteBeforeCancel!.orderId)).toBeUndefined();
    expect(executor.getTrackedQuoteByOrderId(trackedQuoteBeforeCancel!.orderId)).toMatchObject({
      orderId: trackedQuoteBeforeCancel!.orderId,
      tokenId: trackedQuoteBeforeCancel!.tokenId,
      outcome: trackedQuoteBeforeCancel!.outcome,
      side: trackedQuoteBeforeCancel!.side
    });

    expect(executor.removeTrackedQuoteByOrderId(trackedQuoteBeforeCancel!.orderId)).toMatchObject({
      orderId: trackedQuoteBeforeCancel!.orderId
    });
    expect(executor.getTrackedQuoteByOrderId(trackedQuoteBeforeCancel!.orderId)).toBeUndefined();
  });

  it("treats batch already-matched cancel responses as terminal while preserving fill recovery", async () => {
    const cancelOrders = vi.fn();
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: "0",
          allowance: "0"
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          { success: true, orderID: "buy-order-1" },
          { success: true, orderID: "buy-order-2" }
        ]
      }),
      cancelOrders
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "yes-token",
              outcome: "Yes",
              side: Side.BUY,
              price: 0.49,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: [
            {
              tokenId: "no-token",
              outcome: "No",
              side: Side.BUY,
              price: 0.49,
              size: 10,
              tickSize: 0.01,
              postOnly: true,
              orderType: OrderType.GTC
            }
          ]
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 10,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    const [confirmedCancelQuote, rejectedCancelQuote] = executor.getActiveQuotes();
    expect(confirmedCancelQuote).toBeTruthy();
    expect(rejectedCancelQuote).toBeTruthy();
    cancelOrders.mockResolvedValueOnce({
      canceled: [confirmedCancelQuote!.orderId],
      not_canceled: {
        [rejectedCancelQuote!.orderId]: "order already matched"
      }
    });

    await executor.cancelQuotesBySide(Side.BUY, "market quote refresh or withdrawal");

    expect(executor.getActiveQuoteByOrderId(confirmedCancelQuote!.orderId)).toBeUndefined();
    expect(executor.getTrackedQuoteByOrderId(confirmedCancelQuote!.orderId)).toMatchObject({
      orderId: confirmedCancelQuote!.orderId
    });
    expect(executor.getActiveQuoteByOrderId(rejectedCancelQuote!.orderId)).toBeUndefined();
    expect(executor.getTrackedQuoteByOrderId(rejectedCancelQuote!.orderId)).toMatchObject({
      orderId: rejectedCancelQuote!.orderId
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        rejectedOrderIds: [rejectedCancelQuote!.orderId]
      }),
      "Batch quote cancel returned not-cancelled orders; keeping them tracked for fill recovery."
    );
  });

  it("does not count aggressive FOK liquidity misses as risk order failures", async () => {
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValue({
          balance: toRawConditionalUnits(8),
          allowance: toRawConditionalUnits(8)
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: false,
            orderID: "",
            status: "",
            takingAmount: "",
            makingAmount: "",
            errorMsg: "order couldn't be fully filled. FOK orders are fully filled or killed."
          }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const riskManager = {
      noteOrderFailure: vi.fn()
    };
    const executor = new QuoteExecutor(client as never, logger, undefined, riskManager);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.49,
          size: 2,
          tickSize: 0.01,
          postOnly: false,
          orderType: OrderType.FOK,
          executionStyle: "one-side-aggressive-exit"
        }
      ]
    });

    expect(riskManager.noteOrderFailure).not.toHaveBeenCalled();
  });

  it("uses the position manager's post-fill inventory as a hard SELL cap", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowance: toRawConditionalUnits(10)
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const positionManager = new PositionManager();
    const executor = new QuoteExecutor(client as never, logger, positionManager);

    executor.setMarketUniverse([cryptoMarket]);
    positionManager.setMarketUniverse([cryptoMarket]);
    positionManager.updateTokenInventory("yes-token", {
      balance: 0,
      allowance: 0,
      refreshedAtMs: Date.now()
    });

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: false,
          orderType: OrderType.GTC,
          executionStyle: "one-side-aggressive-exit"
        }
      ]
    });

    expect(client.getBalanceAllowance).toHaveBeenCalled();
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        managedBalance: 0,
        managedAllowance: 0,
        sellableSize: 0
      }),
      "Suppressed sell quote because inventory or allowance was insufficient."
    );
  });

  it("does not count SELL inventory over-commit rejects as risk order failures", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowance: toRawConditionalUnits(10)
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: false,
            orderID: "",
            status: "",
            takingAmount: "",
            makingAmount: "",
            errorMsg:
              "not enough balance / allowance: the balance is not enough -> balance: 10001537, sum of matched orders: 10000000, order amount: 5000000"
          }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const riskManager = {
      noteOrderFailure: vi.fn()
    };
    const executor = new QuoteExecutor(client as never, logger, undefined, riskManager);

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile({
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: false,
          orderType: OrderType.GTC,
          executionStyle: "one-side-aggressive-exit"
        }
      ]
    });

    expect(riskManager.noteOrderFailure).not.toHaveBeenCalled();
    expect((logger as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        side: Side.SELL,
        executionStyle: "one-side-aggressive-exit"
      }),
      "SELL post rejected because venue inventory was already committed. Skipping risk failure increment."
    );
  });

  it("suppresses SELL quotes below the venue minimum before posting them", async () => {
    const minSizeMarket: BinaryMarket = {
      ...cryptoMarket,
      orderMinSize: 5
    };
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowance: toRawConditionalUnits(10)
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([minSizeMarket]);

    await executor.reconcile({
      market: minSizeMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 1.48,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: minSizeMarket.slug,
        tokenId: "yes-token",
        size: 1.48,
        minimumSellQuoteSize: 5
      }),
      "Suppressed sell quote because the requested size was below the venue minimum."
    );
  });

  it("suppresses BUY quotes below the venue minimum before posting them", async () => {
    const minSizeMarket: BinaryMarket = {
      ...cryptoMarket,
      orderMinSize: 5
    };
    const client = {
      getBalanceAllowance: vi.fn(),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);

    executor.setMarketUniverse([minSizeMarket]);

    await executor.reconcile({
      market: minSizeMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 3.75,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    });

    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: minSizeMarket.slug,
        tokenId: "yes-token",
        size: 3.75,
        minimumBuyQuoteSize: 5
      }),
      "Suppressed buy quote because the requested size was below the venue minimum."
    );
  });

  it("suppresses repeated residual min-size rejects before they can loop into more failures", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;

    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowance: toRawConditionalUnits(10)
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: false,
            orderID: "",
            status: "",
            takingAmount: "",
            makingAmount: "",
            errorMsg: "Size (5.00) lower than the minimum: 10"
          }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const riskManager = {
      noteOrderFailure: vi.fn()
    };
    const executor = new QuoteExecutor(client as never, logger, undefined, riskManager);
    const residualSellPlan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile(residualSellPlan);
    await executor.reconcile(residualSellPlan);

    expect(client.postOrders).toHaveBeenCalledTimes(1);
    expect(riskManager.noteOrderFailure).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { debug: ReturnType<typeof vi.fn> }).debug).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        size: 5
      }),
      "Suppressed SELL repost because the venue recently rejected the same residual size."
    );
  });

  it("deduplicates repeated post-only cross-book rejects before counting another order failure", async () => {
    (config.marketMaker as { requoteCooldownMs: number }).requoteCooldownMs = 0;

    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowance: toRawConditionalUnits(10)
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: false,
            orderID: "",
            status: "",
            takingAmount: "",
            makingAmount: "",
            errorMsg: "invalid post-only order: order crosses book"
          }
        ]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const riskManager = {
      noteOrderFailure: vi.fn()
    };
    const executor = new QuoteExecutor(client as never, logger, undefined, riskManager);
    const postOnlySellPlan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 5,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    executor.setMarketUniverse([cryptoMarket]);

    await executor.reconcile(postOnlySellPlan);
    await executor.reconcile(postOnlySellPlan);

    expect(client.postOrders).toHaveBeenCalledTimes(2);
    expect(riskManager.noteOrderFailure).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        tokenId: "yes-token",
        rejectCategory: "post_only_cross"
      }),
      "Skipped duplicate structural quote rejection to avoid over-counting order failures."
    );
  });

  it("lets the CLOB client resolve negRisk when market metadata differs from the order book", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(0),
        allowance: toRawConditionalUnits(100)
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [{ success: true, orderID: "order-1" }]
      })
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const executor = new QuoteExecutor(client as never, logger);
    const plan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          negRisk: true,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    executor.setMarketUniverse([cryptoMarket]);
    await executor.reconcile(plan);

    expect(client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenID: "yes-token" }),
      expect.not.objectContaining({ negRisk: expect.anything() })
    );
    expect((logger as unknown as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: cryptoMarket.slug,
        marketNegRisk: false
      }),
      "Market metadata and order-book negRisk differ; letting CLOB client resolve the order version."
    );
  });

  it("backs off order-version venue rejects without tripping global API risk", async () => {
    vi.useFakeTimers();

    const orderVersionError = Object.assign(new Error("order_version_mismatch"), {
      status: 400
    });
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(0),
        allowance: toRawConditionalUnits(100)
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockRejectedValue(orderVersionError)
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Logger;
    const riskManager = {
      noteApiError: vi.fn()
    };
    const executor = new QuoteExecutor(client as never, logger, undefined, riskManager);
    const plan: MarketMakerPlan = {
      market: cryptoMarket,
      generatedAtMs: Date.now(),
      rewardActive: false,
      tokenPlans: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        },
        {
          tokenId: "no-token",
          outcome: "No",
          midpoint: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          observedSpread: 0.02,
          observedSpreadTicks: 2,
          topBookLiquidityUsdc: 5000,
          rewardEligible: false,
          rebateEfficiencyScore: 0,
          rebateInwardTicks: 0,
          quotes: []
        }
      ],
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 5,
          tickSize: 0.01,
          negRisk: true,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    };

    try {
      vi.setSystemTime(new Date("2026-04-29T00:00:00.000Z"));
      executor.setMarketUniverse([cryptoMarket]);

      await executor.reconcile(plan);
      await executor.reconcile(plan);

      expect(client.createOrder).toHaveBeenCalledTimes(1);
      expect(client.postOrders).toHaveBeenCalledTimes(1);
      expect(riskManager.noteApiError).not.toHaveBeenCalled();
      expect((logger as unknown as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
        expect.objectContaining({
          market: cryptoMarket.slug,
          category: "venue_reject",
          errorStatus: 400,
          errorMessage: "order_version_mismatch"
        }),
        "postOrders venue rejected this market/order version — applying per-market backoff without global API risk."
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
