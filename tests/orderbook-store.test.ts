import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { OrderBookStore } from "../src/polymarket/orderbook-store.js";

describe("OrderBookStore", () => {
  const originalEnableTapePressureBias = config.marketMaker.enableTapePressureBias;
  const originalTapePressureWindowMs = config.marketMaker.tapePressureWindowMs;
  const originalTapePressureMinTrades = config.marketMaker.tapePressureMinTrades;
  const originalTapePressureMinTradesPerMinute = config.marketMaker.tapePressureMinTradesPerMinute;
  const originalTapePressureImbalanceThreshold = config.marketMaker.tapePressureImbalanceThreshold;
  const originalTapePressureMaxInwardTicks = config.marketMaker.tapePressureMaxInwardTicks;

  afterEach(() => {
    (config.marketMaker as { enableTapePressureBias: boolean }).enableTapePressureBias =
      originalEnableTapePressureBias;
    (config.marketMaker as { tapePressureWindowMs: number }).tapePressureWindowMs =
      originalTapePressureWindowMs;
    (config.marketMaker as { tapePressureMinTrades: number }).tapePressureMinTrades =
      originalTapePressureMinTrades;
    (
      config.marketMaker as { tapePressureMinTradesPerMinute: number }
    ).tapePressureMinTradesPerMinute = originalTapePressureMinTradesPerMinute;
    (
      config.marketMaker as { tapePressureImbalanceThreshold: number }
    ).tapePressureImbalanceThreshold = originalTapePressureImbalanceThreshold;
    (config.marketMaker as { tapePressureMaxInwardTicks: number }).tapePressureMaxInwardTicks =
      originalTapePressureMaxInwardTicks;
  });

  it("records market trade-tape updates without mutating book freshness timestamps", () => {
    const now = Date.now();
    const store = new OrderBookStore();
    store.upsertSnapshot({
      event_type: "book",
      asset_id: "yes-token",
      market: "condition-1",
      bids: [{ price: "0.48", size: "100" }],
      asks: [{ price: "0.50", size: "100" }],
      timestamp: String(now),
      tick_size: "0.01",
      min_order_size: "1",
      last_trade_price: "0.49"
    });

    const beforeTrade = store.get("yes-token");
    expect(beforeTrade?.lastTradePrice).toBe(0.49);
    expect(beforeTrade?.updatedAtMs).toBe(now);
    expect(store.getSelectionTelemetry("yes-token")?.recentActivityEvents).toBe(1);

    const updatedBook = store.applyLastTradePrice({
      event_type: "last_trade_price",
      asset_id: "yes-token",
      market: "condition-1",
      price: "0.47",
      size: "12",
      side: "SELL",
      timestamp: String(now + 1000)
    });

    expect(updatedBook?.lastTradePrice).toBe(0.47);
    expect(updatedBook?.updatedAtMs).toBe(now);
    expect(store.getSelectionTelemetry("yes-token")?.recentActivityEvents).toBe(2);
  });

  it("computes directional tape pressure from recent trade-tape flow", () => {
    (config.marketMaker as { enableTapePressureBias: boolean }).enableTapePressureBias = true;
    (config.marketMaker as { tapePressureWindowMs: number }).tapePressureWindowMs = 60_000;
    (config.marketMaker as { tapePressureMinTrades: number }).tapePressureMinTrades = 4;
    (
      config.marketMaker as { tapePressureMinTradesPerMinute: number }
    ).tapePressureMinTradesPerMinute = 4;
    (
      config.marketMaker as { tapePressureImbalanceThreshold: number }
    ).tapePressureImbalanceThreshold = 0.2;
    (config.marketMaker as { tapePressureMaxInwardTicks: number }).tapePressureMaxInwardTicks = 1;

    const now = Date.now();
    const store = new OrderBookStore();
    store.upsertSnapshot({
      event_type: "book",
      asset_id: "yes-token",
      market: "condition-1",
      bids: [{ price: "0.48", size: "100" }],
      asks: [{ price: "0.50", size: "100" }],
      timestamp: String(now - 5_000),
      tick_size: "0.01",
      min_order_size: "1",
      last_trade_price: "0.49"
    });

    for (let index = 0; index < 4; index += 1) {
      store.applyLastTradePrice({
        event_type: "last_trade_price",
        asset_id: "yes-token",
        market: "condition-1",
        price: "0.50",
        size: "10",
        side: "BUY",
        timestamp: String(now - 4_000 + index * 500)
      });
    }

    const updatedBook = store.get("yes-token");

    expect(updatedBook?.tapePressure).toMatchObject({
      recentTradeCount: 4,
      buyTradeCount: 4,
      sellTradeCount: 0,
      dominantSide: "BUY",
      biasTicks: 1
    });
    expect(updatedBook?.tapePressure?.pressureScore).toBeGreaterThan(0);
  });

  it("getTotalFillVolume sums tape samples within the requested window", () => {
    const originalFillShareWindowMs = config.marketMaker.fillShareWindowMs;
    (config.marketMaker as { fillShareWindowMs: number }).fillShareWindowMs = 60_000;

    try {
      const store = new OrderBookStore();
      const now = Date.now();

      store.upsertSnapshot({
        event_type: "book",
        asset_id: "yes-token",
        market: "condition-1",
        bids: [{ price: "0.48", size: "100" }],
        asks: [{ price: "0.50", size: "100" }],
        timestamp: String(now),
        tick_size: "0.01",
        min_order_size: "1",
        last_trade_price: "0.49"
      });

      // Three trades: two inside a 10-second window, one older
      store.applyLastTradePrice({ event_type: "last_trade_price", asset_id: "yes-token", market: "condition-1", price: "0.48", size: "5", side: "BUY", timestamp: String(now - 20_000) });
      store.applyLastTradePrice({ event_type: "last_trade_price", asset_id: "yes-token", market: "condition-1", price: "0.49", size: "10", side: "SELL", timestamp: String(now - 3_000) });
      store.applyLastTradePrice({ event_type: "last_trade_price", asset_id: "yes-token", market: "condition-1", price: "0.50", size: "7", side: "BUY", timestamp: String(now - 1_000) });

      // Full 60-second window: all three trades = 22
      expect(store.getTotalFillVolume("yes-token", 60_000, now)).toBeCloseTo(22, 5);
      // 5-second window: only the two recent trades = 17
      expect(store.getTotalFillVolume("yes-token", 5_000, now)).toBeCloseTo(17, 5);
      // Unknown asset: 0
      expect(store.getTotalFillVolume("no-token", 60_000, now)).toBe(0);
    } finally {
      (config.marketMaker as { fillShareWindowMs: number }).fillShareWindowMs = originalFillShareWindowMs;
    }
  });
});
