import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { UserWsTracker } from "../src/polymarket/user-ws.js";

describe("UserWsTracker", () => {
  it("absorbs websocket errors emitted while terminating a locally replaced user socket", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    } as unknown as Logger;
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      logger
    );
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

    (tracker as unknown as { socket: unknown }).socket = socket;

    expect(() => tracker.close()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Ignored user websocket error after local close."
    );
  });

  it("reuses cached websocket outcomes when the fill arrives before a waiter is attached", async () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );

    (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
      JSON.stringify({
        event_type: "trade",
        taker_order_id: "order-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "5",
        price: "0.4",
        status: "MATCHED"
      }),
      1
    );

    await expect(tracker.waitForOrderOutcome("order-1", 50)).resolves.toMatchObject({
      state: "filled",
      size: 5,
      price: 0.4,
      notional: 2
    });
  });

  it("publishes incremental fill progress from order events using the matched-size delta", () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );
    const listener = vi.fn();
    tracker.subscribeOrderFillProgress(listener);

    (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
      JSON.stringify({
        event_type: "order",
        id: "order-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        original_size: "8",
        size_matched: "3",
        price: "0.46",
        status: "LIVE"
      }),
      1
    );

    (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
      JSON.stringify({
        event_type: "order",
        id: "order-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        original_size: "8",
        size_matched: "5",
        price: "0.46",
        status: "LIVE"
      }),
      1
    );

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderId: "order-1",
        matchedSize: 3,
        deltaMatchedSize: 3,
        isTerminal: false
      })
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderId: "order-1",
        matchedSize: 5,
        deltaMatchedSize: 2,
        isTerminal: false
      })
    );
  });

  it("publishes maker-fill progress from trade payload maker_orders entries", () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );
    const listener = vi.fn();
    tracker.subscribeOrderFillProgress(listener);

    (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "5",
        price: "0.46",
        status: "MATCHED",
        maker_orders: [
          {
            order_id: "maker-order-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "5",
            price: "0.46"
          }
        ]
      }),
      1
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeId: "trade-1",
        orderId: "maker-order-1",
        matchedSize: 5,
        deltaMatchedSize: 5,
        price: 0.46,
        isTerminal: false
      })
    );
  });

  it("deduplicates repeated maker trade lifecycle updates for the same trade id", () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );
    const listener = vi.fn();
    tracker.subscribeOrderFillProgress(listener);
    const handleMessage = (raw: string) =>
      (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
        raw,
        1
      );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-dup-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "10",
        price: "0.46",
        status: "MINED",
        maker_orders: [
          {
            order_id: "maker-order-dup-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "10",
            price: "0.46"
          }
        ]
      })
    );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-dup-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "10",
        price: "0.46",
        status: "CONFIRMED",
        maker_orders: [
          {
            order_id: "maker-order-dup-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "10",
            price: "0.46"
          }
        ]
      })
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "maker-order-dup-1",
        matchedSize: 10,
        deltaMatchedSize: 10
      })
    );
  });

  it("still publishes remaining order-event delta after deduplicating repeated maker trade updates", () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );
    const listener = vi.fn();
    tracker.subscribeOrderFillProgress(listener);
    const handleMessage = (raw: string) =>
      (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
        raw,
        1
      );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-dup-2",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "5",
        price: "0.46",
        status: "MATCHED",
        maker_orders: [
          {
            order_id: "maker-order-dup-2",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "5",
            price: "0.46"
          }
        ]
      })
    );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-dup-2",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "5",
        price: "0.46",
        status: "CONFIRMED",
        maker_orders: [
          {
            order_id: "maker-order-dup-2",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "5",
            price: "0.46"
          }
        ]
      })
    );

    handleMessage(
      JSON.stringify({
        event_type: "order",
        id: "maker-order-dup-2",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        original_size: "10",
        size_matched: "10",
        price: "0.46",
        status: "FILLED"
      })
    );

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderId: "maker-order-dup-2",
        matchedSize: 5,
        deltaMatchedSize: 5,
        isTerminal: false
      })
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderId: "maker-order-dup-2",
        matchedSize: 10,
        deltaMatchedSize: 5,
        isTerminal: true
      })
    );
  });

  it("does not double-count cumulative maker matched_amount snapshots across different trade ids", () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );
    const listener = vi.fn();
    tracker.subscribeOrderFillProgress(listener);
    const handleMessage = (raw: string) =>
      (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
        raw,
        1
      );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-cumulative-1",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "3.78",
        price: "0.69",
        status: "MATCHED",
        maker_orders: [
          {
            order_id: "maker-order-cumulative-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "3.78",
            price: "0.69"
          }
        ]
      })
    );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-cumulative-2",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "3.78",
        price: "0.69",
        status: "CONFIRMED",
        maker_orders: [
          {
            order_id: "maker-order-cumulative-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "3.78",
            price: "0.69"
          }
        ]
      })
    );

    handleMessage(
      JSON.stringify({
        event_type: "trade",
        id: "trade-cumulative-3",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        size: "7.56",
        price: "0.69",
        status: "CONFIRMED",
        maker_orders: [
          {
            order_id: "maker-order-cumulative-1",
            asset_id: "yes-token",
            side: "BUY",
            matched_amount: "7.56",
            price: "0.69"
          }
        ]
      })
    );

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderId: "maker-order-cumulative-1",
        matchedSize: 3.78,
        deltaMatchedSize: 3.78,
        price: 0.69
      })
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderId: "maker-order-cumulative-1",
        matchedSize: 7.56,
        deltaMatchedSize: 3.78,
        price: 0.69
      })
    );
  });

  it("treats a cancellation with matched size as a partially filled terminal outcome", async () => {
    const tracker = new UserWsTracker(
      {
        apiKey: "key",
        secret: "secret",
        passphrase: "passphrase"
      },
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      } as unknown as Logger
    );

    (tracker as unknown as { handleMessage: (raw: string, generation: number) => void }).handleMessage(
      JSON.stringify({
        event_type: "order",
        id: "order-2",
        market: "condition-1",
        asset_id: "yes-token",
        side: "BUY",
        original_size: "8",
        size_matched: "3",
        price: "0.41",
        status: "CANCELED"
      }),
      1
    );

    await expect(tracker.waitForOrderOutcome("order-2", 50)).resolves.toMatchObject({
      state: "partially_filled",
      size: 3,
      price: 0.41,
      notional: 1.23
    });
  });

  it("accumulates my fill shares per asset and returns window-scoped totals", () => {
    const tracker = new UserWsTracker(
      { apiKey: "key", secret: "secret", passphrase: "passphrase" },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
    );

    const handleMessage = (raw: string) =>
      (tracker as unknown as { handleMessage: (raw: string, gen: number) => void }).handleMessage(raw, 1);

    const baseMs = Date.now();

    // Inject two fill events for yes-token (delta 3 and delta 5)
    handleMessage(JSON.stringify({
      event_type: "order",
      id: "order-fill-1",
      market: "condition-x",
      asset_id: "yes-token",
      side: "BUY",
      original_size: "10",
      size_matched: "3",
      price: "0.45",
      status: "LIVE"
    }));
    handleMessage(JSON.stringify({
      event_type: "order",
      id: "order-fill-1",
      market: "condition-x",
      asset_id: "yes-token",
      side: "BUY",
      original_size: "10",
      size_matched: "8",
      price: "0.45",
      status: "LIVE"
    }));

    // Total = 3 + 5 = 8 shares accumulated
    expect(tracker.getMyFillShares("yes-token", 60_000, baseMs + 100)).toBeCloseTo(8, 5);
    // Different asset — no fills
    expect(tracker.getMyFillShares("no-token", 60_000, baseMs + 100)).toBe(0);
    // Window has expired: query 2 minutes later with a 10-second window → fills (recorded at ~baseMs)
    // are now older than the window cutoff (baseMs + 120_000 - 10_000 = baseMs + 110_000 > baseMs)
    expect(tracker.getMyFillShares("yes-token", 10_000, baseMs + 120_000)).toBe(0);
  });
});
