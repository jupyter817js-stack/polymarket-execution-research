import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { MarketWsManager } from "../src/polymarket/market-ws.js";
import { OrderBookStore } from "../src/polymarket/orderbook-store.js";

describe("MarketWsManager", () => {
  it("absorbs websocket errors emitted while terminating a locally replaced shard", () => {
    const store = new OrderBookStore();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    } as unknown as Logger;
    const manager = new MarketWsManager(store, logger, vi.fn());
    let errorListener: ((error: Error) => void) | undefined;
    const socket = {
      removeAllListeners: vi.fn(),
      on: vi.fn((event: string, listener: (error: Error) => void) => {
        if (event === "error") {
          errorListener = listener;
        }

        return socket;
      }),
      terminate: vi.fn(() => {
        errorListener?.(new Error("WebSocket was closed before the connection was established"));
      })
    };

    (manager as unknown as { sockets: unknown[] }).sockets.push(socket);

    expect(() => manager.closeAll()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Ignored market websocket error after local close."
    );
  });

  it("routes market trade-tape events into the store and triggers an immediate token update", () => {
    const store = new OrderBookStore();
    store.upsertSnapshot({
      event_type: "book",
      asset_id: "yes-token",
      market: "condition-1",
      bids: [{ price: "0.48", size: "100" }],
      asks: [{ price: "0.50", size: "100" }],
      timestamp: "1000",
      tick_size: "0.01",
      min_order_size: "1"
    });

    const onTokenUpdate = vi.fn();
    const manager = new MarketWsManager(
      store,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger,
      onTokenUpdate
    );

    (manager as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify({
        event_type: "last_trade_price",
        asset_id: "yes-token",
        market: "condition-1",
        price: "0.47",
        size: "12",
        side: "SELL",
        timestamp: "2000"
      })
    );

    expect(store.get("yes-token")?.lastTradePrice).toBe(0.47);
    expect(onTokenUpdate).toHaveBeenCalledTimes(1);
    expect(onTokenUpdate).toHaveBeenCalledWith("yes-token");
  });
});
