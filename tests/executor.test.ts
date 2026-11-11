import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { ArbitrageExecutor } from "../src/trading/executor.js";
import type { BinaryMarket, SameMarketOpportunity } from "../src/types.js";

const market: BinaryMarket = {
  id: "1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "BitBoy convicted?",
  slug: "bitboy-convicted",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: false
};

const opportunity: SameMarketOpportunity = {
  market,
  shares: 5,
  grossCost: 4.9,
  grossCostPerShare: 0.98,
  grossEdge: 0.1,
  feeCost: 0,
  netEdge: 0.1,
  netEdgeBpsOnPar: 200,
  legs: [
    {
      tokenId: "yes-token",
      outcome: "Yes",
      fill: {
        shares: 5,
        totalCost: 1.5,
        averagePrice: 0.3,
        worstPrice: 0.3
      },
      tickSize: 0.01,
      limitPrice: 0.3,
      feeRateBps: 0
    },
    {
      tokenId: "no-token",
      outcome: "No",
      fill: {
        shares: 5,
        totalCost: 3.4,
        averagePrice: 0.68,
        worstPrice: 0.68
      },
      tickSize: 0.01,
      limitPrice: 0.68,
      feeRateBps: 0
    }
  ],
  detectedAtMs: Date.now()
};

describe("ArbitrageExecutor", () => {
  const originalEnableEmergencySell = config.execution.enableEmergencySell;
  const originalBuyPriceBuffer = config.strategy.buyPriceBuffer;
  const originalEmergencySellPriceBuffer = config.execution.emergencySellPriceBuffer;
  const originalAggressiveEntryOrderType = config.execution.aggressiveEntryOrderType;
  const originalAggressiveExitOrderType = config.execution.aggressiveExitOrderType;

  afterEach(() => {
    (config.execution as { enableEmergencySell: boolean }).enableEmergencySell =
      originalEnableEmergencySell;
    (config.strategy as { buyPriceBuffer: number }).buyPriceBuffer = originalBuyPriceBuffer;
    (config.execution as { emergencySellPriceBuffer: number }).emergencySellPriceBuffer =
      originalEmergencySellPriceBuffer;
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveEntryOrderType = originalAggressiveEntryOrderType;
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveExitOrderType = originalAggressiveExitOrderType;
  });

  it("uses the unified non-FOK order types for aggressive entry and emergency exits", async () => {
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
        enableEmergencySell: boolean;
      }
    ).aggressiveEntryOrderType = "IOC";
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
        enableEmergencySell: boolean;
      }
    ).aggressiveExitOrderType = "GTC";
    (config.execution as { enableEmergencySell: boolean }).enableEmergencySell = true;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" })
        .mockResolvedValueOnce({ balance: "5", allowance: "5" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            {
              success: false,
              orderID: "",
              status: "",
              takingAmount: "",
              makingAmount: "",
              errorMsg: "liquidity miss"
            },
            {
              success: true,
              orderID: "filled-order",
              status: "matched",
              takingAmount: "5",
              makingAmount: "3.5",
              errorMsg: ""
            }
          ]
        })
        .mockResolvedValueOnce([
          {
            success: true,
            orderID: "sell-order",
            status: "matched",
            takingAmount: "3.5",
            makingAmount: "5",
            errorMsg: ""
          }
        ])
    };

    const store = {
      get: vi.fn().mockReturnValue({
        assetId: "no-token",
        market: market.conditionId,
        bids: [{ price: 0.7, size: 100 }],
        asks: [{ price: 0.45, size: 100 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: undefined,
        hash: undefined,
        updatedAtMs: Date.now()
      })
    };

    const executor = new ArbitrageExecutor(
      client as never,
      store as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never
    );

    await executor.execute(opportunity);

    expect(client.postOrders).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        expect.objectContaining({ orderType: "FAK" }),
        expect.objectContaining({ orderType: "FAK" })
      ])
    );
    expect(client.postOrders).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([expect.objectContaining({ orderType: "GTC" })])
    );
  });

  it("skips recovery when actual filled cost would take the pair to par or worse", async () => {
    (config.execution as { enableEmergencySell: boolean }).enableEmergencySell = false;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValueOnce({
        orders: [
          {
            success: true,
            orderID: "filled-order",
            status: "matched",
            takingAmount: "5",
            makingAmount: "2.2",
            errorMsg: ""
          },
          {
            success: false,
            orderID: "",
            status: "",
            takingAmount: "",
            makingAmount: "",
            errorMsg: "invalid amounts"
          }
        ]
      })
    };

    const store = {
      get: vi.fn().mockReturnValue({
        assetId: "no-token",
        market: market.conditionId,
        bids: [{ price: 0.55, size: 100 }],
        asks: [{ price: 0.58, size: 100 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: undefined,
        hash: undefined,
        updatedAtMs: Date.now()
      })
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const executor = new ArbitrageExecutor(
      client as never,
      store as never,
      logger
    );

    await executor.execute(opportunity);

    expect(client.createOrder).toHaveBeenCalledTimes(2);
    expect(client.postOrders).toHaveBeenCalledTimes(1);
    const effectiveCap = Math.min(config.strategy.hedgeMaxGrossCostPerShare, 1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        combinedGrossCostPerShare: "1.0200",
        filledCost: "2.2000",
        missingCost: "2.9000",
        effectiveRecoveryGrossCostCapPerShare: effectiveCap.toFixed(4)
      }),
      "Recovery buy skipped because the combined cost cap was exceeded."
    );
  });

  it("uses the market minimum tick size and price buffer for emergency sells when the book is finer", async () => {
    (config.execution as { enableEmergencySell: boolean }).enableEmergencySell = true;
    (config.execution as { emergencySellPriceBuffer: number }).emergencySellPriceBuffer = 0.01;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" })
        .mockResolvedValueOnce({ balance: "5", allowance: "5" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            {
              success: false,
              orderID: "",
              status: "",
              takingAmount: "",
              makingAmount: "",
              errorMsg: "order couldn't be fully filled. FOK orders are fully filled or killed."
            },
            {
              success: true,
              orderID: "filled-order",
              status: "matched",
              takingAmount: "5",
              makingAmount: "3.5",
              errorMsg: ""
            }
          ]
        })
        .mockResolvedValueOnce([
          {
            success: true,
            orderID: "sell-order",
            status: "matched",
            takingAmount: "3.5",
            makingAmount: "5",
            errorMsg: ""
          }
        ])
    };

    const store = {
      get: vi.fn().mockReturnValue({
        assetId: "no-token",
        market: market.conditionId,
        bids: [{ price: 0.701, size: 100 }],
        asks: [{ price: 0.45, size: 100 }],
        tickSize: 0.001,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: undefined,
        hash: undefined,
        updatedAtMs: Date.now()
      })
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const executor = new ArbitrageExecutor(
      client as never,
      store as never,
      logger
    );

    await executor.execute(opportunity);

    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(client.postOrders).toHaveBeenCalledTimes(2);
    expect(client.createOrder).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tokenID: "no-token",
        price: 0.69,
        size: 5,
        side: "SELL"
      }),
      {
        tickSize: "0.01"
      }
    );
  });

  it("applies the configured buy price buffer to recovery buys", async () => {
    (config.execution as { enableEmergencySell: boolean }).enableEmergencySell = false;
    (config.strategy as { buyPriceBuffer: number }).buyPriceBuffer = 0.01;

    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            {
              success: true,
              orderID: "filled-order",
              status: "matched",
              takingAmount: "5",
              makingAmount: "1.5",
              errorMsg: ""
            },
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
        .mockResolvedValueOnce([
          {
            success: true,
            orderID: "recovery-order",
            status: "matched",
            takingAmount: "5",
            makingAmount: "2.95",
            errorMsg: ""
          }
        ])
    };

    const store = {
      get: vi.fn().mockReturnValue({
        assetId: "no-token",
        market: market.conditionId,
        bids: [{ price: 0.55, size: 100 }],
        asks: [{ price: 0.58, size: 100 }],
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        lastTradePrice: undefined,
        hash: undefined,
        updatedAtMs: Date.now()
      })
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const executor = new ArbitrageExecutor(
      client as never,
      store as never,
      logger
    );

    await executor.execute(opportunity);

    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(client.postOrders).toHaveBeenCalledTimes(2);
    expect(client.createOrder).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tokenID: "no-token",
        price: 0.59,
        size: 5,
        side: "BUY"
      }),
      {
        tickSize: "0.01"
      }
    );
  });

  it("returns a realized pnl summary when both entry legs fill", async () => {
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "filled-a",
            status: "matched",
            takingAmount: "5",
            makingAmount: "1.5",
            errorMsg: ""
          },
          {
            success: true,
            orderID: "filled-b",
            status: "matched",
            takingAmount: "5",
            makingAmount: "3.4",
            errorMsg: ""
          }
        ]
      })
    };

    const store = {
      get: vi.fn()
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const executor = new ArbitrageExecutor(
      client as never,
      store as never,
      logger
    );

    const summary = await executor.execute(opportunity);

    expect(summary.status).toBe("fully_filled");
    expect(summary.realizedPnlUsdc).toBeCloseTo(0.1, 8);
    expect(summary.openedPositions).toEqual([
      expect.objectContaining({
        tokenId: "yes-token",
        shares: 5,
        totalCostUsdc: 1.5
      }),
      expect.objectContaining({
        tokenId: "no-token",
        shares: 5,
        totalCostUsdc: 3.4
      })
    ]);
  });
});
