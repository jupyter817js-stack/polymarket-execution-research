import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RiskReductionExecutor } from "../src/trading/risk-reduction-executor.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

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
  feesEnabled: false,
  negRisk: false
};

const makeBook = (overrides?: Partial<NormalizedOrderBook>): NormalizedOrderBook => ({
  assetId: "yes-token",
  market: market.conditionId,
  bids: [{ price: 0.701, size: 10 }],
  asks: [{ price: 0.75, size: 10 }],
  tickSize: 0.001,
  minOrderSize: 1,
  negRisk: false,
  lastTradePrice: undefined,
  hash: undefined,
  updatedAtMs: Date.now(),
  ...overrides
});

const toRawConditionalUnits = (shares: number): string => String(shares * 1_000_000);

describe("RiskReductionExecutor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits a marketable sell and reports proceeds when inventory reduction fills immediately", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(5),
        allowances: {
          ctf: toRawConditionalUnits(5)
        }
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "risk-reduction-1",
            status: "matched",
            takingAmount: "3.5",
            makingAmount: "5"
          }
        ]
      })
    };
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;
    const executor = new RiskReductionExecutor(
      client as never,
      { get: vi.fn().mockReturnValue(makeBook()) } as never,
      logger
    );

    const summary = await executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "risk halt"
    );

    expect(client.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: "yes-token",
        price: 0.69,
        size: 5,
        side: "SELL"
      }),
      {
        tickSize: "0.01"
      }
    );
    expect(client.postOrders).toHaveBeenCalledWith([{ order: {}, orderType: "GTC" }]);
    expect(summary.reducedCount).toBe(1);
    expect(summary.reducedShares).toBeCloseTo(5, 8);
    expect(summary.totalProceedsUsdc).toBeCloseTo(3.5, 8);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        marketSlug: market.slug,
        tokenId: "yes-token",
        outcome: "Yes",
        requestedShares: 5,
        status: "reduced",
        reducedShares: 5,
        proceedsUsdc: 3.5
      })
    );
  });

  it("skips candidates that have no sellable inventory", async () => {
    vi.useFakeTimers();
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(0),
        allowances: {
          ctf: toRawConditionalUnits(0)
        }
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const executor = new RiskReductionExecutor(
      client as never,
      { get: vi.fn().mockReturnValue(makeBook()) } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summaryPromise = executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "risk halt"
    );
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary.reducedCount).toBe(0);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "skipped_no_inventory",
        requestedShares: 0,
        observedBalance: 0,
        observedAllowance: 0,
        observedSellableShares: 0
      })
    );
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
  });

  it("reports venue balance and allowance when sellable inventory is below the venue minimum", async () => {
    const minSizeMarket: BinaryMarket = {
      ...market,
      orderMinSize: 5
    };
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(1.485),
        allowances: {
          ctf: toRawConditionalUnits(1.485)
        }
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const executor = new RiskReductionExecutor(
      client as never,
      {
        get: vi.fn().mockReturnValue(
          makeBook({
            minOrderSize: 5
          })
        )
      } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summary = await executor.reduceCandidates(
      [{ market: minSizeMarket, tokenId: "yes-token", outcome: "Yes" }],
      "stuck inventory sweep"
    );

    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "skipped_below_min_size",
        requestedShares: 1.485,
        observedBalance: 1.485,
        observedAllowance: 1.485,
        observedSellableShares: 1.485
      })
    );
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
  });

  it("skips partial reductions that would leave an unsellable dust remainder", async () => {
    const minSizeMarket: BinaryMarket = {
      ...market,
      orderMinSize: 5
    };
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(10),
        allowances: {
          ctf: toRawConditionalUnits(10)
        }
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const executor = new RiskReductionExecutor(
      client as never,
      {
        get: vi.fn().mockReturnValue(
          makeBook({
            bids: [{ price: 0.53, size: 10 }],
            minOrderSize: 5
          })
        )
      } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summary = await executor.reduceCandidates(
      [
        {
          market: minSizeMarket,
          tokenId: "yes-token",
          outcome: "Yes",
          maxReductionShares: 8
        }
      ],
      "aged inventory exit ladder"
    );

    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "skipped_below_min_size",
        requestedShares: 8,
        observedSellableShares: 10,
        detail: expect.stringContaining("would leave residual dust 2.0000")
      })
    );
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
  });

  it("retries briefly when venue free balance is still settling after quote cancellation", async () => {
    vi.useFakeTimers();
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({
          balance: toRawConditionalUnits(0),
          allowances: {
            ctf: toRawConditionalUnits(0)
          }
        })
        .mockResolvedValueOnce({
          balance: toRawConditionalUnits(5),
          allowances: {
            ctf: toRawConditionalUnits(5)
          }
        }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "risk-reduction-1",
            status: "matched",
            takingAmount: "3.5",
            makingAmount: "5"
          }
        ]
      })
    };
    const executor = new RiskReductionExecutor(
      client as never,
      { get: vi.fn().mockReturnValue(makeBook()) } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summaryPromise = executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "max-hold hard exit"
    );
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(client.getBalanceAllowance).toHaveBeenCalledTimes(2);
    expect(summary.reducedCount).toBe(1);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "reduced",
        requestedShares: 5,
        reducedShares: 5
      })
    );
  });

  it("reports missing bid liquidity when the book has no usable bids", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(5),
        allowances: {
          ctf: toRawConditionalUnits(5)
        }
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const executor = new RiskReductionExecutor(
      client as never,
      {
        get: vi.fn().mockReturnValue(
          makeBook({
            bids: []
          })
        )
      } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summary = await executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "risk halt"
    );

    expect(summary.reducedCount).toBe(0);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "skipped_no_bid_liquidity",
        requestedShares: 0
      })
    );
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it("falls back to a REST orderbook when the token is outside the websocket book universe", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(5),
        allowances: {
          ctf: toRawConditionalUnits(5)
        }
      }),
      getOrderBook: vi.fn().mockResolvedValue({
        asset_id: "yes-token",
        market: market.conditionId,
        bids: [{ price: "0.701", size: "10" }],
        asks: [{ price: "0.75", size: "10" }],
        timestamp: String(Date.now()),
        tick_size: "0.001",
        min_order_size: "1",
        neg_risk: false,
        hash: "book-hash",
        last_trade_price: "0.72"
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "risk-reduction-rest-book",
            status: "matched",
            takingAmount: "3.5",
            makingAmount: "5"
          }
        ]
      })
    };
    const store = {
      get: vi.fn().mockReturnValue(undefined),
      upsertSnapshot: vi.fn().mockReturnValue(makeBook())
    };
    const executor = new RiskReductionExecutor(
      client as never,
      store as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summary = await executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "max-hold hard exit"
    );

    expect(client.getOrderBook).toHaveBeenCalledWith("yes-token");
    expect(store.upsertSnapshot).toHaveBeenCalledTimes(1);
    expect(summary.reducedCount).toBe(1);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "reduced",
        requestedShares: 5,
        reducedShares: 5
      })
    );
  });

  it("treats partial delayed fills as successful risk reduction and reports reduced proceeds", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(5),
        allowances: {
          ctf: toRawConditionalUnits(5)
        }
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "risk-reduction-partial",
            status: "live"
          }
        ]
      }),
      getOrder: vi.fn()
        .mockResolvedValueOnce({
          status: "live",
          size_matched: "0",
          original_size: "5",
          price: "0.69"
        })
        .mockResolvedValueOnce({
          status: "cancelled",
          size_matched: "2",
          original_size: "5",
          price: "0.69"
        }),
      cancelOrder: vi.fn().mockResolvedValue(undefined)
    };
    const executor = new RiskReductionExecutor(
      client as never,
      { get: vi.fn().mockReturnValue(makeBook()) } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summary = await executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "risk halt"
    );

    expect(summary.reducedCount).toBe(1);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "reduced",
        requestedShares: 5,
        reducedShares: 2
      })
    );
    expect(summary.results[0]?.proceedsUsdc).toBeCloseTo(1.38, 8);
    expect(summary.results[0]?.price).toBeCloseTo(0.69, 8);
    expect(summary.results[0]?.proceedsSource).toBe("limit_price");
    expect(summary.results[0]?.detail).toContain("partially filled");
  });

  it("separates allowance lookup failures from true no-inventory skips", async () => {
    vi.useFakeTimers();
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({
        balance: toRawConditionalUnits(5)
      }),
      createOrder: vi.fn(),
      postOrders: vi.fn()
    };
    const executor = new RiskReductionExecutor(
      client as never,
      { get: vi.fn().mockReturnValue(makeBook()) } as never,
      { warn: vi.fn(), error: vi.fn() } as never
    );

    const summaryPromise = executor.reduceCandidates(
      [{ market, tokenId: "yes-token", outcome: "Yes" }],
      "stuck inventory sweep"
    );
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;

    expect(summary.reducedCount).toBe(0);
    expect(summary.results[0]).toEqual(
      expect.objectContaining({
        status: "skipped_allowance_unavailable",
        requestedShares: 0,
        observedBalance: 5
      })
    );
    expect(client.createOrder).not.toHaveBeenCalled();
    expect(client.postOrders).not.toHaveBeenCalled();
  });
});
