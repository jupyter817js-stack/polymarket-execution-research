import WebSocket from "ws";

import type { Logger } from "pino";

import { config } from "../config.js";
import type {
  BookSnapshotEvent,
  LastTradePriceEvent,
  PriceChangeEvent,
  TickSizeChangeEvent
} from "../types.js";
import { chunk } from "../utils.js";
import { OrderBookStore } from "./orderbook-store.js";

type TokenUpdateHandler = (tokenId: string) => void;

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type MarketEvent =
  | BookSnapshotEvent
  | PriceChangeEvent
  | TickSizeChangeEvent
  | LastTradePriceEvent;

export class MarketWsManager {
  private readonly sockets: WebSocket[] = [];
  private readonly heartbeatTimers = new Map<WebSocket, NodeJS.Timeout>();
  private readonly lastMessageAtMs = new Map<WebSocket, number>();
  private generation = 0;
  private currentAssetCount = 0;

  constructor(
    private readonly store: OrderBookStore,
    private readonly logger: Logger,
    private readonly onTokenUpdate: TokenUpdateHandler
  ) {}

  replaceSubscriptions(assetIds: readonly string[]): void {
    if (this.sockets.length > 0) {
      this.logger.info(
        {
          previousGeneration: this.generation,
          nextGeneration: this.generation + 1,
          previousShardCount: this.sockets.length,
          nextShardCount: chunk(assetIds, config.ws.batchSize).length,
          assetCount: assetIds.length,
          reason: "market_universe_refresh"
        },
        "Replacing market websocket subscriptions."
      );
    }

    this.closeAll();
    const generation = this.generation;
    this.currentAssetCount = assetIds.length;

    const shards = chunk(assetIds, config.ws.batchSize);

    for (const batch of shards) {
      this.openShard(batch, generation);
    }
  }

  closeAll(): void {
    this.generation += 1;

    while (this.sockets.length > 0) {
      const socket = this.sockets.pop();
      if (socket) {
        const heartbeat = this.heartbeatTimers.get(socket);
        if (heartbeat) {
          clearInterval(heartbeat);
          this.heartbeatTimers.delete(socket);
        }
        this.lastMessageAtMs.delete(socket);
      }
      if (socket) {
        this.terminateSocketAfterLocalClose(socket);
      }
    }
  }

  private terminateSocketAfterLocalClose(socket: WebSocket): void {
    socket.removeAllListeners("open");
    socket.removeAllListeners("message");
    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.on("error", (error) => {
      this.logger.debug({ err: error }, "Ignored market websocket error after local close.");
    });

    try {
      socket.terminate();
    } catch (error) {
      this.logger.debug({ err: error }, "Ignored market websocket terminate error after local close.");
    }
  }

  private openShard(assetIds: readonly string[], generation: number): void {
    if (assetIds.length === 0) {
      return;
    }

    const socket = new WebSocket(MARKET_WS_URL);
    this.sockets.push(socket);

    socket.on("open", () => {
      this.startHeartbeat(socket);
      this.lastMessageAtMs.delete(socket);
      this.logger.info(
        { assetCount: assetIds.length, heartbeatMs: config.ws.heartbeatMs },
        "Market websocket shard connected."
      );
      socket.send(JSON.stringify({ type: "market", assets_ids: assetIds }));
    });

    socket.on("message", (raw) => {
      this.lastMessageAtMs.set(socket, Date.now());
      this.handleMessage(raw.toString());
    });

    socket.on("close", (code, reasonBuffer) => {
      this.stopHeartbeat(socket);
      const index = this.sockets.indexOf(socket);
      if (index >= 0) {
        this.sockets.splice(index, 1);
      }

      const reason = reasonBuffer.toString("utf8");
      const lastMessageAtMs = this.lastMessageAtMs.get(socket);
      this.lastMessageAtMs.delete(socket);

      this.logger.warn(
        {
          assetCount: assetIds.length,
          generation,
          code,
          reason: reason || undefined,
          reconnectInMs: config.ws.reconnectMs,
          lastMessageAgeMs:
            typeof lastMessageAtMs === "number" ? Date.now() - lastMessageAtMs : undefined
        },
        "Market websocket shard closed."
      );
      setTimeout(() => {
        if (generation !== this.generation) {
          return;
        }

        this.openShard(assetIds, generation);
      }, config.ws.reconnectMs);
    });

    socket.on("error", (error) => {
      this.logger.error({ err: error }, "Market websocket shard error.");
    });
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat(socket);
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send("PING");
    }, config.ws.heartbeatMs);
    this.heartbeatTimers.set(socket, heartbeat);
  }

  private stopHeartbeat(socket: WebSocket): void {
    const heartbeat = this.heartbeatTimers.get(socket);

    if (!heartbeat) {
      return;
    }

    clearInterval(heartbeat);
    this.heartbeatTimers.delete(socket);
  }

  private handleMessage(raw: string): void {
    if (raw.trim() === "PONG") {
      return;
    }

    let payload: MarketEvent[] | MarketEvent;

    try {
      payload = JSON.parse(raw) as MarketEvent[] | MarketEvent;
    } catch (error) {
      this.logger.warn({ err: error, raw }, "Failed to parse market websocket payload.");
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];

    for (const event of events) {
      if ("bids" in event && "asks" in event) {
        const book = this.store.upsertSnapshot(event);
        this.onTokenUpdate(book.assetId);
        continue;
      }

      if (event.event_type === "price_change") {
        const assetIds = this.store.applyPriceChange(event);

        for (const assetId of assetIds) {
          this.onTokenUpdate(assetId);
        }

        continue;
      }

      if (event.event_type === "tick_size_change") {
        const book = this.store.applyTickSizeChange(event);

        if (book) {
          this.onTokenUpdate(book.assetId);
        }

        continue;
      }

      if (event.event_type === "last_trade_price") {
        const book = this.store.applyLastTradePrice(event);

        if (book) {
          this.onTokenUpdate(book.assetId);
        }
      }
    }
  }
}
