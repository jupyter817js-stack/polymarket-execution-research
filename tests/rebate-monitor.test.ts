import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RebateMonitor } from "../src/trading/rebate-monitor.js";

describe("RebateMonitor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes only the delta between actual rebate snapshots", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ rebated_fees_usdc: 0.2, condition_id: "condition-1" }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ rebated_fees_usdc: 0.7, condition_id: "condition-1" }]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ rebated_fees_usdc: 0.7, condition_id: "condition-1" }]
      });
    vi.stubGlobal("fetch", fetchMock);

    const onActualRebateDelta = vi.fn();
    const monitor = new RebateMonitor(
      {} as never,
      "0xmaker",
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as unknown as Logger,
      () => undefined,
      onActualRebateDelta
    );

    await (monitor as any).logDailySummary();
    await (monitor as any).logDailySummary();
    await (monitor as any).logDailySummary();

    expect(onActualRebateDelta).toHaveBeenCalledTimes(2);
    const firstDelta = onActualRebateDelta.mock.calls[0]?.[0];
    const secondDelta = onActualRebateDelta.mock.calls[1]?.[0];

    expect(firstDelta?.deltaRebateUsdc).toBeCloseTo(0.2, 8);
    expect(firstDelta?.totalActualRebatedUsdc).toBeCloseTo(0.2, 8);
    expect(firstDelta?.fillCount).toBe(0);
    expect(firstDelta?.marketDeltas).toEqual([
      expect.objectContaining({
        conditionId: "condition-1",
        totalActualRebatedUsdc: 0.2
      })
    ]);
    expect(firstDelta?.marketDeltas[0]?.deltaRebateUsdc).toBeCloseTo(0.2, 8);
    expect(secondDelta?.deltaRebateUsdc).toBeCloseTo(0.5, 8);
    expect(secondDelta?.totalActualRebatedUsdc).toBeCloseTo(0.7, 8);
    expect(secondDelta?.fillCount).toBe(0);
    expect(secondDelta?.marketDeltas).toEqual([
      expect.objectContaining({
        conditionId: "condition-1",
        totalActualRebatedUsdc: 0.7
      })
    ]);
    expect(secondDelta?.marketDeltas[0]?.deltaRebateUsdc).toBeCloseTo(0.5, 8);
  });

  it("queries current-day trades with the current user param shape", async () => {
    const getTradesPaginated = vi.fn().mockResolvedValue({
      trades: [],
      next_cursor: undefined
    });
    const monitor = new RebateMonitor(
      { getTradesPaginated } as never,
      "0xmaker",
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger,
      () => undefined
    );

    await (monitor as any).fetchCurrentDayTrades();

    expect(getTradesPaginated).toHaveBeenCalledTimes(1);
    expect(getTradesPaginated).toHaveBeenCalledWith(
      expect.objectContaining({
        user: "0xmaker"
      }),
      undefined
    );
  });

  it("falls back to maker_address when the trades endpoint rejects the current user param shape", async () => {
    const getTradesPaginated = vi
      .fn()
      .mockRejectedValueOnce({
        status: 400,
        message: "Invalid trade params payload",
        data: {
          error: "Invalid trade params payload"
        }
      })
      .mockResolvedValueOnce({
        trades: [],
        next_cursor: undefined
      });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    } as unknown as Logger;
    const monitor = new RebateMonitor(
      { getTradesPaginated } as never,
      "0xmaker",
      logger,
      () => undefined
    );

    await (monitor as any).fetchCurrentDayTrades();

    expect(getTradesPaginated).toHaveBeenCalledTimes(2);
    expect(getTradesPaginated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        user: "0xmaker"
      }),
      undefined
    );
    expect(getTradesPaginated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        maker_address: "0xmaker"
      }),
      undefined
    );
    expect((logger as any).debug).toHaveBeenCalledTimes(1);
  });

  it("stops paginating when the trades endpoint returns the terminal LTE cursor", async () => {
    const getTradesPaginated = vi.fn().mockResolvedValue({
      trades: [
        {
          id: "trade-1",
          match_time: new Date().toISOString(),
          maker_orders: [],
          size: "1",
          price: "0.5"
        }
      ],
      next_cursor: "LTE="
    });
    const monitor = new RebateMonitor(
      { getTradesPaginated } as never,
      "0xmaker",
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger,
      () => undefined
    );

    await (monitor as any).fetchCurrentDayTrades();

    expect(getTradesPaginated).toHaveBeenCalledTimes(1);
  });

  it("publishes maker fill records with the maker order id in chronological order", async () => {
    const today = new Date();
    today.setUTCHours(10, 0, 0, 0);
    const older = today.toISOString();
    const newer = new Date(today.getTime() + 60_000).toISOString();
    const getTradesPaginated = vi.fn().mockResolvedValue({
      trades: [
        {
          id: "trade-newer",
          market: "condition-1",
          asset_id: "yes-token",
          side: "BUY",
          size: "5",
          price: "0.46",
          status: "MATCHED",
          match_time: newer,
          maker_orders: [
            {
              order_id: "maker-order-newer",
              maker_address: "0xmaker",
              asset_id: "yes-token",
              outcome: "Yes",
              side: "BUY",
              matched_amount: "5",
              price: "0.46"
            }
          ]
        },
        {
          id: "trade-older",
          market: "condition-1",
          asset_id: "yes-token",
          side: "BUY",
          size: "10",
          price: "0.45",
          status: "MATCHED",
          match_time: older,
          maker_orders: [
            {
              order_id: "maker-order-older",
              maker_address: "0xmaker",
              asset_id: "yes-token",
              outcome: "Yes",
              side: "BUY",
              matched_amount: "10",
              price: "0.45"
            }
          ]
        }
      ],
      next_cursor: undefined
    });
    const onMakerFillRecorded = vi.fn();
    const monitor = new RebateMonitor(
      { getTradesPaginated } as never,
      "0xmaker",
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger,
      () => undefined,
      undefined,
      onMakerFillRecorded
    );

    await (monitor as any).refreshTrades();

    expect(onMakerFillRecorded).toHaveBeenCalledTimes(2);
    expect(onMakerFillRecorded).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tradeId: "trade-older",
        orderId: "maker-order-older",
        shares: 10,
        price: 0.45
      })
    );
    expect(onMakerFillRecorded).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tradeId: "trade-newer",
        orderId: "maker-order-newer",
        shares: 5,
        price: 0.46
      })
    );
  });

  it("disables trade refresh after repeated invalid trade params payload errors", async () => {
    const getTradesPaginated = vi
      .fn()
      .mockRejectedValue({
        status: 400,
        message: "Invalid trade params payload",
        data: {
          error: "Invalid trade params payload"
        }
      });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    } as unknown as Logger;
    const monitor = new RebateMonitor(
      { getTradesPaginated } as never,
      "0xmaker",
      logger,
      () => undefined
    );

    await (monitor as any).refreshTrades();
    await (monitor as any).refreshTrades();

    expect(getTradesPaginated).toHaveBeenCalledTimes(2);
    expect((logger as any).info).toHaveBeenCalledTimes(1);
    expect((logger as any).warn).not.toHaveBeenCalled();
  });
});
