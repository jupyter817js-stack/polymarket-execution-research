import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { RewardMonitor } from "../src/trading/reward-monitor.js";

describe("RewardMonitor", () => {
  it("publishes live scoring results back to the quote executor before deciding on auto-cancel", async () => {
    const updateRewardScoring = vi.fn();
    const cancelQuotesByOrderIds = vi.fn();
    const client = {
      areOrdersScoring: vi.fn().mockResolvedValue({
        "buy-order-1": false
      })
    };

    const monitor = new RewardMonitor(
      client as never,
      {
        getActiveQuotes: () => [
          {
            orderId: "buy-order-1",
            conditionId: "condition-1",
            marketSlug: "market-1"
          }
        ],
        updateRewardScoring,
        cancelQuotesByOrderIds
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );

    await (monitor as any).checkOrderScoring();

    expect(updateRewardScoring).toHaveBeenCalledWith({
      "buy-order-1": false
    });
    expect(cancelQuotesByOrderIds).not.toHaveBeenCalled();
  });

  it("publishes only the delta between daily reward snapshots", async () => {
    const client = {
      getUserEarningsAndMarketsConfig: vi
        .fn()
        .mockResolvedValueOnce([
          {
            condition_id: "condition-1",
            market_slug: "market-1",
            earning_percentage: 0.5,
            market_competitiveness: 1,
            earnings: [{ earnings: 0.4 }]
          }
        ])
        .mockResolvedValueOnce([
          {
            condition_id: "condition-1",
            market_slug: "market-1",
            earning_percentage: 0.5,
            market_competitiveness: 1,
            earnings: [{ earnings: 0.9 }]
          }
        ])
        .mockResolvedValueOnce([
          {
            condition_id: "condition-1",
            market_slug: "market-1",
            earning_percentage: 0.5,
            market_competitiveness: 1,
            earnings: [{ earnings: 0.9 }]
          }
        ])
    };

    const onRewardEarningsDelta = vi.fn();
    const monitor = new RewardMonitor(
      client as never,
      {
        getActiveQuotes: () => [],
        updateRewardScoring: vi.fn()
      } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger,
      onRewardEarningsDelta
    );

    await (monitor as any).logDailyEarnings();
    await (monitor as any).logDailyEarnings();
    await (monitor as any).logDailyEarnings();

    expect(onRewardEarningsDelta).toHaveBeenCalledTimes(2);
    expect(onRewardEarningsDelta).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        deltaRewardUsdc: 0.4,
        totalEstimatedEarningsUsdc: 0.4,
        marketCount: 1,
        marketDeltas: [
          expect.objectContaining({
            conditionId: "condition-1",
            marketSlug: "market-1",
            deltaRewardUsdc: 0.4,
            totalEstimatedEarningsUsdc: 0.4
          })
        ]
      })
    );
    expect(onRewardEarningsDelta).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        deltaRewardUsdc: 0.5,
        totalEstimatedEarningsUsdc: 0.9,
        marketCount: 1,
        marketDeltas: [
          expect.objectContaining({
            conditionId: "condition-1",
            marketSlug: "market-1",
            deltaRewardUsdc: 0.5,
            totalEstimatedEarningsUsdc: 0.9
          })
        ]
      })
    );
  });
});
