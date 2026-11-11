import WebSocket from "ws";

import type { Logger } from "pino";

import { config } from "../config.js";
import type { OrderResolution, UserOrderEvent, UserTradeEvent } from "../types.js";

const USER_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const ORDER_OUTCOME_CACHE_TTL_MS = Math.max(30_000, config.ws.userOrderTimeoutMs * 2);
const MAKER_TRADE_EVENT_DEDUPE_TTL_MS = Math.max(
  30 * 60_000,
  config.ws.userOrderTimeoutMs * 20,
  ORDER_OUTCOME_CACHE_TTL_MS * 4
);
const MATCH_EPSILON = 1e-9;

const isFilledTrade = (event: UserTradeEvent): boolean =>
  ["MATCHED", "MINED", "CONFIRMED"].includes(event.status.toUpperCase());

export interface UserOrderFillProgressEvent {
  tradeId?: string;
  orderId: string;
  market: string;
  assetId: string;
  side: "BUY" | "SELL";
  price: number;
  originalSize: number;
  matchedSize: number;
  deltaMatchedSize: number;
  status?: string;
  isTerminal: boolean;
}

export class UserWsTracker {
  private socket: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private connectionGeneration = 0;
  private reconnectAttempt = 0;
  private lastMessageAtMs: number | undefined;
  /** Timestamp when the most recent socket closed — used by backfill callback to
   * know the lookback window for missed fills. */
  private lastDisconnectAtMs: number | undefined;
  private reconnectBackfillHandler?: (disconnectAtMs: number, reconnectAtMs: number) => Promise<void> | void;
  private readonly waiters = new Map<
    string,
    Array<(resolution: OrderResolution) => void>
  >();
  private readonly resolvedOrders = new Map<
    string,
    {
      resolution: OrderResolution;
      resolvedAtMs: number;
    }
  >();
  private readonly matchedSizeByOrderId = new Map<string, number>();
  private readonly processedMakerTradeKeys = new Map<string, number>();
  private readonly orderFillProgressListeners = new Set<
    (event: UserOrderFillProgressEvent) => void
  >();
  private readonly myFillSamples = new Map<string, Array<{ atMs: number; shares: number }>>();

  constructor(
    private readonly auth: { apiKey: string; secret: string; passphrase: string },
    private readonly logger: Logger
  ) {}

  /** Register a callback invoked after each successful reconnect. The callback
   * receives (disconnectAtMs, reconnectAtMs) so it can backfill fills from REST
   * that were missed during the WebSocket downtime. */
  setReconnectBackfillHandler(
    handler: (disconnectAtMs: number, reconnectAtMs: number) => Promise<void> | void
  ): void {
    this.reconnectBackfillHandler = handler;
  }

  connect(markets: readonly string[], reason: "market_universe_refresh" | "reconnect_after_close" = "market_universe_refresh"): void {
    if (!config.ws.enableUserWs || markets.length === 0) {
      return;
    }

    const hadExistingSocket = Boolean(this.socket);
    const previousGeneration = this.connectionGeneration;
    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;

    if (hadExistingSocket) {
      this.logger.info(
        {
          previousGeneration,
          nextGeneration: generation,
          marketCount: markets.length,
          reason
        },
        "Replacing user websocket subscription."
      );
    }

    this.close();

    const socket = new WebSocket(USER_WS_URL);
    this.socket = socket;

    socket.on("open", () => {
      const reconnectAtMs = Date.now();
      const wasReconnect = reason === "reconnect_after_close";
      const previousDisconnectAtMs = this.lastDisconnectAtMs;
      this.reconnectAttempt = 0;
      this.lastMessageAtMs = undefined;
      this.startHeartbeat(socket);
      this.logger.info(
        { marketCount: markets.length, generation, heartbeatMs: config.ws.heartbeatMs },
        "User websocket connected."
      );
      socket.send(
        JSON.stringify({
          type: "user",
          markets,
          auth: {
            apiKey: this.auth.apiKey,
            secret: this.auth.secret,
            passphrase: this.auth.passphrase
          }
        })
      );

      // Backfill missed fills after reconnect — the window between lastDisconnectAtMs
      // and now may contain trade events the WebSocket missed.
      if (wasReconnect && this.reconnectBackfillHandler && typeof previousDisconnectAtMs === "number") {
        const downtimeMs = reconnectAtMs - previousDisconnectAtMs;
        this.logger.info(
          { downtimeMs, disconnectAtMs: previousDisconnectAtMs, reconnectAtMs },
          "Triggering user-ws backfill for missed fills during downtime."
        );
        Promise.resolve(
          this.reconnectBackfillHandler(previousDisconnectAtMs, reconnectAtMs)
        ).catch((err) => {
          this.logger.warn({ err }, "user-ws reconnect backfill failed.");
        });
      }
    });

    socket.on("message", (raw) => {
      this.lastMessageAtMs = Date.now();
      this.handleMessage(raw.toString(), generation);
    });

    socket.on("close", (code, reasonBuffer) => {
      const reason = reasonBuffer.toString("utf8");
      const wasActiveSocket = this.socket === socket;
      this.stopHeartbeat(socket);

      if (wasActiveSocket) {
        this.socket = undefined;
        // Mark disconnect time so the next reconnect can trigger backfill
        // covering the downtime window.
        this.lastDisconnectAtMs = Date.now();
      }

      const closePayload = {
        generation,
        code,
        reason: reason || undefined,
        reconnectInMs: config.ws.reconnectMs,
        lastMessageAgeMs:
          typeof this.lastMessageAtMs === "number" ? Date.now() - this.lastMessageAtMs : undefined,
        wasActiveSocket
      };

      if (!wasActiveSocket) {
        this.logger.info(closePayload, "User websocket closed after replacement.");
        return;
      }

      this.reconnectAttempt += 1;
      this.logger.warn(
        { ...closePayload, reconnectAttempt: this.reconnectAttempt },
        "User websocket closed."
      );

      setTimeout(() => {
        if (generation !== this.connectionGeneration) {
          return;
        }

        this.connect(markets, "reconnect_after_close");
      }, config.ws.reconnectMs);
    });

    socket.on("error", (error) => {
      this.logger.error({ err: error }, "User websocket error.");
    });
  }

  close(): void {
    this.stopHeartbeat();
    if (this.socket) {
      this.terminateSocketAfterLocalClose(this.socket);
    }
    this.socket = undefined;
  }

  private terminateSocketAfterLocalClose(socket: WebSocket): void {
    socket.removeAllListeners("open");
    socket.removeAllListeners("message");
    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.on("error", (error) => {
      this.logger.debug({ err: error }, "Ignored user websocket error after local close.");
    });

    try {
      socket.terminate();
    } catch (error) {
      this.logger.debug({ err: error }, "Ignored user websocket terminate error after local close.");
    }
  }

  subscribeOrderFillProgress(
    listener: (event: UserOrderFillProgressEvent) => void
  ): () => void {
    this.orderFillProgressListeners.add(listener);

    return () => {
      this.orderFillProgressListeners.delete(listener);
    };
  }

  peekOrderOutcome(orderId: string): OrderResolution | undefined {
    const cached = this.resolvedOrders.get(orderId);

    if (!cached) {
      return undefined;
    }

    if (Date.now() - cached.resolvedAtMs > ORDER_OUTCOME_CACHE_TTL_MS) {
      this.resolvedOrders.delete(orderId);
      return undefined;
    }

    return { ...cached.resolution };
  }

  async waitForOrderOutcome(orderId: string, timeoutMs: number): Promise<OrderResolution> {
    const cached = this.peekOrderOutcome(orderId);

    if (cached) {
      return cached;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resolveWaiters(orderId, { state: "timed_out", size: 0 });
      }, timeoutMs);

      const resolver = (resolution: OrderResolution) => {
        clearTimeout(timeout);
        resolve(resolution);
      };

      const existing = this.waiters.get(orderId) ?? [];
      existing.push(resolver);
      this.waiters.set(orderId, existing);
    });
  }

  private publishOrderOutcome(orderId: string, resolution: OrderResolution): void {
    this.resolvedOrders.set(orderId, {
      resolution,
      resolvedAtMs: Date.now()
    });
    this.resolveWaiters(orderId, resolution);
  }

  private resolveWaiters(orderId: string, resolution: OrderResolution): void {
    const waiters = this.waiters.get(orderId);

    if (!waiters) {
      return;
    }

    this.waiters.delete(orderId);

    for (const waiter of waiters) {
      waiter(resolution);
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat(socket);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send("PING");
    }, config.ws.heartbeatMs);
  }

  private stopHeartbeat(socket?: WebSocket): void {
    if (socket && this.socket && socket !== this.socket) {
      return;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private handleMessage(raw: string, generation: number): void {
    const trimmed = raw.trim();

    if (trimmed === "PONG") {
      this.logger.debug({ generation }, "User websocket heartbeat acknowledged.");
      return;
    }

    let payload: Array<UserOrderEvent | UserTradeEvent> | UserOrderEvent | UserTradeEvent;

    try {
      payload = JSON.parse(raw) as
        | Array<UserOrderEvent | UserTradeEvent>
        | UserOrderEvent
        | UserTradeEvent;
    } catch (error) {
      this.logger.warn({ err: error, raw }, "Failed to parse user websocket payload.");
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];

    for (const event of events) {
      if (event.event_type === "trade") {
        const orderId = event.taker_order_id;

        if (orderId && isFilledTrade(event)) {
          const size = Number(event.size);
          const price = Number(event.price);
          this.publishOrderOutcome(orderId, {
            state: "filled",
            size,
            price,
            notional:
              Number.isFinite(size) && Number.isFinite(price) ? size * price : undefined
          });
        }

        if (orderId && event.status.toUpperCase() === "FAILED") {
          this.publishOrderOutcome(orderId, { state: "failed", size: 0 });
        }

        if (isFilledTrade(event) && Array.isArray(event.maker_orders)) {
          const handledAtMs = Date.now();

          for (const makerOrder of event.maker_orders) {
            const makerOrderId = makerOrder.order_id ?? makerOrder.id;
            const makerMatchedSnapshot = Number(makerOrder.matched_amount);
            const makerFillSize = Number(makerOrder.size ?? event.size);
            const makerPrice = Number(makerOrder.price ?? event.price);

            if (
              !makerOrderId ||
              (!Number.isFinite(makerMatchedSnapshot) || makerMatchedSnapshot <= MATCH_EPSILON) &&
                (!Number.isFinite(makerFillSize) || makerFillSize <= MATCH_EPSILON)
            ) {
              continue;
            }

            if (!this.shouldProcessMakerTradeFill(makerOrderId, event.id, handledAtMs)) {
              continue;
            }

            const previousMatchedSize = this.matchedSizeByOrderId.get(makerOrderId) ?? 0;
            // Treat `matched_amount` as the maker order's cumulative filled size.
            // Polymarket can replay the same fill snapshot across MATCHED/MINED/CONFIRMED
            // trade lifecycle events with different trade ids. Adding the raw value would
            // double-count inventory; using the cumulative high-water mark suppresses
            // duplicate snapshots while still allowing later larger snapshots through.
            const nextMatchedSize =
              Number.isFinite(makerMatchedSnapshot) && makerMatchedSnapshot > MATCH_EPSILON
                ? Math.max(previousMatchedSize, makerMatchedSnapshot)
                : previousMatchedSize + makerFillSize;
            const deltaMatchedSize = nextMatchedSize - previousMatchedSize;

            if (deltaMatchedSize <= MATCH_EPSILON) {
              continue;
            }

            this.matchedSizeByOrderId.set(makerOrderId, nextMatchedSize);
            this.publishOrderFillProgress({
              tradeId: event.id,
              orderId: makerOrderId,
              market: event.market,
              assetId: makerOrder.asset_id ?? event.asset_id,
              side: makerOrder.side ?? event.side,
              price: makerPrice,
              originalSize: Math.max(
                nextMatchedSize,
                Number.isFinite(makerMatchedSnapshot) && makerMatchedSnapshot > MATCH_EPSILON
                  ? makerMatchedSnapshot
                  : makerFillSize
              ),
              matchedSize: nextMatchedSize,
              deltaMatchedSize,
              status: event.status,
              // Trade payloads for maker fills are per-match, not terminal order lifecycle events.
              isTerminal: false
            });
          }
        }

        continue;
      }

      if (event.event_type === "order") {
        const type = event.type?.toUpperCase();
        const status = event.status?.toUpperCase();
        const originalSize = Number(event.original_size);
        const matchedSize = Number(event.size_matched);

        if (type === "CANCELLATION" || status === "CANCELED" || status === "CANCELLED") {
          const resolvedMatchedSize =
            Number.isFinite(matchedSize) && matchedSize > MATCH_EPSILON
              ? matchedSize
              : this.matchedSizeByOrderId.get(event.id) ?? 0;
          const price = Number(event.price);
          this.publishOrderOutcome(
            event.id,
            resolvedMatchedSize > MATCH_EPSILON
              ? {
                  state: "partially_filled",
                  size: resolvedMatchedSize,
                  price,
                  notional:
                    Number.isFinite(resolvedMatchedSize) && Number.isFinite(price)
                      ? resolvedMatchedSize * price
                      : undefined
                }
              : { state: "cancelled", size: 0 }
          );
          this.matchedSizeByOrderId.delete(event.id);
          continue;
        }

        if (
          Number.isFinite(originalSize) &&
          originalSize > 0 &&
          Number.isFinite(matchedSize) &&
          matchedSize > MATCH_EPSILON
        ) {
          const previousMatchedSize = this.matchedSizeByOrderId.get(event.id) ?? 0;
          const deltaMatchedSize = matchedSize - previousMatchedSize;

          if (deltaMatchedSize > MATCH_EPSILON) {
            this.matchedSizeByOrderId.set(event.id, matchedSize);
            this.publishOrderFillProgress({
              orderId: event.id,
              market: event.market,
              assetId: event.asset_id,
              side: event.side,
              price: Number(event.price),
              originalSize,
              matchedSize,
              deltaMatchedSize,
              status: event.status,
              isTerminal: matchedSize >= originalSize - MATCH_EPSILON
            });
          }
        }

        if (originalSize > 0 && matchedSize >= originalSize) {
          const price = Number(event.price);
          this.publishOrderOutcome(event.id, {
            state: "filled",
            size: matchedSize,
            price,
            notional:
              Number.isFinite(matchedSize) && Number.isFinite(price)
                ? matchedSize * price
                : undefined
          });
          this.matchedSizeByOrderId.delete(event.id);
        }
      }
    }
  }

  /**
   * Returns my total filled shares for a given asset within the requested window.
   * Used for fill-share ratio monitoring (my fills / total market fills).
   */
  getMyFillShares(assetId: string, windowMs: number, nowMs: number = Date.now()): number {
    const samples = this.myFillSamples.get(assetId);
    if (!samples || samples.length === 0) return 0;
    const cutoffMs = nowMs - windowMs;
    while (samples.length > 0 && samples[0]!.atMs < cutoffMs) {
      samples.shift();
    }
    return samples.reduce((sum, s) => sum + s.shares, 0);
  }

  private publishOrderFillProgress(event: UserOrderFillProgressEvent): void {
    if (event.deltaMatchedSize > 0) {
      const nowMs = Date.now();
      const samples = this.myFillSamples.get(event.assetId) ?? [];
      samples.push({ atMs: nowMs, shares: event.deltaMatchedSize });
      this.myFillSamples.set(event.assetId, samples);
    }
    for (const listener of this.orderFillProgressListeners) {
      listener(event);
    }
  }

  private shouldProcessMakerTradeFill(
    orderId: string,
    tradeId: string,
    nowMs: number = Date.now()
  ): boolean {
    this.pruneProcessedMakerTradeKeys(nowMs);
    const dedupeKey = `${orderId}:${tradeId}`;

    if (this.processedMakerTradeKeys.has(dedupeKey)) {
      return false;
    }

    this.processedMakerTradeKeys.set(dedupeKey, nowMs);
    return true;
  }

  private pruneProcessedMakerTradeKeys(nowMs: number = Date.now()): void {
    for (const [dedupeKey, processedAtMs] of this.processedMakerTradeKeys.entries()) {
      if (nowMs - processedAtMs > MAKER_TRADE_EVENT_DEDUPE_TTL_MS) {
        this.processedMakerTradeKeys.delete(dedupeKey);
      }
    }
  }
}
