import type {
  BookSnapshotEvent,
  LastTradePriceEvent,
  NormalizedOrderBook,
  OrderBookLevel,
  PriceChangeEvent,
  TradeTapePressureSnapshot,
  TickSizeChangeEvent
} from "../types.js";
import { config } from "../config.js";
import { asNumber } from "../utils.js";

const sortAsksBestFirst = (levels: OrderBookLevel[]): OrderBookLevel[] =>
  levels
    .filter((level) => level.size > 0)
    .sort((left, right) => left.price - right.price);

const sortBidsBestFirst = (levels: OrderBookLevel[]): OrderBookLevel[] =>
  levels
    .filter((level) => level.size > 0)
    .sort((left, right) => right.price - left.price);

const toLevels = (levels: Array<{ price: string; size: string }>): OrderBookLevel[] =>
  levels.map((level) => ({
    price: asNumber(level.price),
    size: asNumber(level.size)
  }));

type MidpointSample = {
  atMs: number;
  midpoint: number;
};

type TradeTapeSample = {
  atMs: number;
  side: "BUY" | "SELL";
  size: number;
  price: number;
};

type SelectionTelemetryState = {
  activityEventsAtMs: number[];
  /** Trade-only events: incremented exclusively when an actual trade is observed. */
  tradeEventsAtMs: number[];
  midpointSamples: MidpointSample[];
  tapeSamples: TradeTapeSample[];
};

export interface OrderBookSelectionTelemetry {
  recentActivityEvents: number;
  /** Recent actual trade events (subset of recentActivityEvents). */
  recentTradeEvents: number;
  midpointRange?: number;
}

const getMidpoint = (book: NormalizedOrderBook): number | undefined => {
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;

  if (
    typeof bestBid !== "number" ||
    typeof bestAsk !== "number" ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    bestAsk <= bestBid
  ) {
    return undefined;
  }

  return (bestBid + bestAsk) / 2;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class OrderBookStore {
  private readonly books = new Map<string, NormalizedOrderBook>();
  private readonly selectionTelemetry = new Map<string, SelectionTelemetryState>();

  upsertSnapshot(snapshot: BookSnapshotEvent): NormalizedOrderBook {
    const book: NormalizedOrderBook = {
      assetId: snapshot.asset_id,
      market: snapshot.market,
      bids: sortBidsBestFirst(toLevels(snapshot.bids)),
      asks: sortAsksBestFirst(toLevels(snapshot.asks)),
      tickSize: asNumber(snapshot.tick_size, 0.001),
      minOrderSize: asNumber(snapshot.min_order_size, 1),
      negRisk: Boolean(snapshot.neg_risk),
      lastTradePrice:
        typeof snapshot.last_trade_price === "string"
          ? asNumber(snapshot.last_trade_price)
          : undefined,
      hash: snapshot.hash,
      updatedAtMs: asNumber(snapshot.timestamp, Date.now())
    };

    this.books.set(book.assetId, book);
    this.noteSelectionTelemetry(book.assetId, book.updatedAtMs, book);
    return book;
  }

  applyPriceChange(event: PriceChangeEvent): string[] {
    const updatedAssetIds = new Set<string>();
    const updatedAtMs = asNumber(event.timestamp, Date.now());

    for (const change of event.price_changes) {
      const book = this.books.get(change.asset_id);

      if (!book) {
        continue;
      }

      const price = asNumber(change.price);
      const size = asNumber(change.size);
      const sideLevels = change.side === "BUY" ? book.bids : book.asks;
      const existingLevel = sideLevels.find((level) => Math.abs(level.price - price) < 1e-9);

      if (existingLevel) {
        existingLevel.size = size;
      } else if (size > 0) {
        sideLevels.push({ price, size });
      }

      if (change.side === "BUY") {
        book.bids = sortBidsBestFirst(book.bids);
      } else {
        book.asks = sortAsksBestFirst(book.asks);
      }

      book.hash = change.hash ?? book.hash;
      book.updatedAtMs = updatedAtMs;
      updatedAssetIds.add(change.asset_id);
    }

    for (const assetId of updatedAssetIds) {
      const book = this.books.get(assetId);

      if (!book) {
        continue;
      }

      this.noteSelectionTelemetry(assetId, updatedAtMs, book);
    }

    return [...updatedAssetIds];
  }

  applyTickSizeChange(event: TickSizeChangeEvent): NormalizedOrderBook | undefined {
    const book = this.books.get(event.asset_id);

    if (!book) {
      return undefined;
    }

    book.tickSize = asNumber(event.new_tick_size, book.tickSize);
    book.updatedAtMs = asNumber(event.timestamp, Date.now());
    return book;
  }

  applyLastTradePrice(event: LastTradePriceEvent): NormalizedOrderBook | undefined {
    const book = this.books.get(event.asset_id);

    if (!book) {
      return undefined;
    }

    const occurredAtMs = asNumber(event.timestamp, Date.now());
    const nextLastTradePrice = asNumber(event.price, Number.NaN);
    if (Number.isFinite(nextLastTradePrice)) {
      book.lastTradePrice = nextLastTradePrice;
    }
    const telemetry = this.noteSelectionActivity(book.assetId, occurredAtMs);
    // Trade events are tracked separately so the universe filter can require ACTUAL fills,
    // not just book-update churn. Without this distinction a market with only price-level
    // updates would pass the activity filter but never give us an exit.
    telemetry.tradeEventsAtMs.push(occurredAtMs);
    const tradeSize = asNumber(event.size, 0);
    telemetry.tapeSamples.push({
      atMs: occurredAtMs,
      side: event.side,
      size: Number.isFinite(tradeSize) && tradeSize > 0 ? tradeSize : 0,
      price: Number.isFinite(nextLastTradePrice) ? nextLastTradePrice : book.lastTradePrice ?? 0
    });
    this.pruneSelectionTelemetry(telemetry, occurredAtMs);
    book.tapePressure = this.buildTapePressureSnapshot(telemetry, occurredAtMs);
    this.selectionTelemetry.set(book.assetId, telemetry);
    return book;
  }

  get(assetId: string): NormalizedOrderBook | undefined {
    const book = this.books.get(assetId);

    if (!book) {
      return undefined;
    }

    const telemetry = this.selectionTelemetry.get(assetId);

    if (!telemetry) {
      book.tapePressure = undefined;
      return book;
    }

    const nowMs = Date.now();
    this.pruneSelectionTelemetry(telemetry, nowMs);
    book.tapePressure = this.buildTapePressureSnapshot(telemetry, nowMs);

    if (
      telemetry.activityEventsAtMs.length === 0 &&
      telemetry.midpointSamples.length === 0 &&
      telemetry.tapeSamples.length === 0
    ) {
      this.selectionTelemetry.delete(assetId);
    } else {
      this.selectionTelemetry.set(assetId, telemetry);
    }

    return book;
  }

  getSelectionTelemetry(assetId: string): OrderBookSelectionTelemetry | undefined {
    const state = this.selectionTelemetry.get(assetId);

    if (!state) {
      return undefined;
    }

    this.pruneSelectionTelemetry(state, Date.now());

    if (
      state.activityEventsAtMs.length === 0 &&
      state.midpointSamples.length === 0 &&
      state.tapeSamples.length === 0
    ) {
      this.selectionTelemetry.delete(assetId);
      return undefined;
    }

    let midpointRange: number | undefined;

    if (state.midpointSamples.length > 0) {
      const midpointValues = state.midpointSamples.map((sample) => sample.midpoint);
      midpointRange = Math.max(...midpointValues) - Math.min(...midpointValues);
    }

    return {
      recentActivityEvents: state.activityEventsAtMs.length,
      recentTradeEvents: state.tradeEventsAtMs.length,
      midpointRange:
        typeof midpointRange === "number" && Number.isFinite(midpointRange)
          ? midpointRange
          : undefined
    };
  }

  /**
   * Returns the total fill volume (shares) seen on the market tape for this asset
   * within the requested window. Uses the tape samples already accumulated by
   * `applyLastTradePrice`. Note: tape is retained up to
   * max(tapePressureWindowMs, fillShareWindowMs) so the window must not exceed that.
   */
  getTotalFillVolume(assetId: string, windowMs: number, nowMs: number = Date.now()): number {
    const state = this.selectionTelemetry.get(assetId);
    if (!state || state.tapeSamples.length === 0) return 0;
    const cutoffMs = nowMs - windowMs;
    return state.tapeSamples
      .filter((s) => s.atMs >= cutoffMs)
      .reduce((sum, s) => sum + s.size, 0);
  }

  private noteSelectionTelemetry(
    assetId: string,
    occurredAtMs: number,
    book: NormalizedOrderBook
  ): void {
    const atMs = Number.isFinite(occurredAtMs) && occurredAtMs > 0 ? occurredAtMs : Date.now();
    const state = this.noteSelectionActivity(assetId, atMs);
    const midpoint = getMidpoint(book);

    if (typeof midpoint === "number" && Number.isFinite(midpoint)) {
      state.midpointSamples.push({
        atMs,
        midpoint
      });
    }

    this.pruneSelectionTelemetry(state, atMs);
    this.selectionTelemetry.set(assetId, state);
  }

  private noteSelectionActivity(assetId: string, occurredAtMs: number): SelectionTelemetryState {
    const atMs = Number.isFinite(occurredAtMs) && occurredAtMs > 0 ? occurredAtMs : Date.now();
    const state = this.selectionTelemetry.get(assetId) ?? {
      activityEventsAtMs: [],
      tradeEventsAtMs: [],
      midpointSamples: [],
      tapeSamples: []
    };

    state.activityEventsAtMs.push(atMs);
    return state;
  }

  /** Increment the trade-only counter. Called only from applyLastTradePrice. */
  private noteSelectionTradeEvent(assetId: string, occurredAtMs: number): void {
    const atMs = Number.isFinite(occurredAtMs) && occurredAtMs > 0 ? occurredAtMs : Date.now();
    const state = this.selectionTelemetry.get(assetId);
    if (state) {
      state.tradeEventsAtMs.push(atMs);
    }
  }

  private pruneSelectionTelemetry(
    state: SelectionTelemetryState,
    nowMs: number
  ): void {
    const activityCutoffMs = nowMs - config.marketUniverse.activityWindowMs;
    const volatilityCutoffMs = nowMs - config.marketUniverse.volatilityWindowMs;
    const tapeCutoffMs = nowMs - Math.max(
      config.marketMaker.tapePressureWindowMs,
      config.marketMaker.fillShareWindowMs
    );

    while (
      state.activityEventsAtMs.length > 0 &&
      state.activityEventsAtMs[0]! < activityCutoffMs
    ) {
      state.activityEventsAtMs.shift();
    }

    while (
      state.tradeEventsAtMs.length > 0 &&
      state.tradeEventsAtMs[0]! < activityCutoffMs
    ) {
      state.tradeEventsAtMs.shift();
    }

    while (
      state.midpointSamples.length > 0 &&
      state.midpointSamples[0]!.atMs < volatilityCutoffMs
    ) {
      state.midpointSamples.shift();
    }

    while (
      state.tapeSamples.length > 0 &&
      state.tapeSamples[0]!.atMs < tapeCutoffMs
    ) {
      state.tapeSamples.shift();
    }
  }

  private buildTapePressureSnapshot(
    state: SelectionTelemetryState,
    nowMs: number
  ): TradeTapePressureSnapshot | undefined {
    if (!config.marketMaker.enableTapePressureBias || state.tapeSamples.length === 0) {
      return undefined;
    }

    const recentTradeCount = state.tapeSamples.length;
    const buySamples = state.tapeSamples.filter((sample) => sample.side === "BUY");
    const sellSamples = state.tapeSamples.filter((sample) => sample.side === "SELL");
    const buyTradeCount = buySamples.length;
    const sellTradeCount = sellSamples.length;
    const buyVolume = buySamples.reduce((total, sample) => total + sample.size, 0);
    const sellVolume = sellSamples.reduce((total, sample) => total + sample.size, 0);
    const totalVolume = buyVolume + sellVolume;
    const firstTradeAtMs = state.tapeSamples[0]!.atMs;
    const elapsedWindowMs = Math.max(
      1_000,
      Math.min(config.marketMaker.tapePressureWindowMs, Math.max(1, nowMs - firstTradeAtMs))
    );
    const tradesPerMinute = recentTradeCount * (60_000 / elapsedWindowMs);
    const signedTradeImbalance =
      recentTradeCount > 0 ? (buyTradeCount - sellTradeCount) / recentTradeCount : 0;
    const signedVolumeImbalance =
      totalVolume > 0 ? (buyVolume - sellVolume) / totalVolume : 0;
    const rawPressureScore = signedTradeImbalance * 0.45 + signedVolumeImbalance * 0.55;
    const velocityRatio =
      config.marketMaker.tapePressureMinTradesPerMinute > 0
        ? clamp01(tradesPerMinute / config.marketMaker.tapePressureMinTradesPerMinute)
        : 1;
    const pressureScore = rawPressureScore * velocityRatio;
    const pressureMagnitude = Math.abs(pressureScore);
    let biasTicks = 0;

    if (
      recentTradeCount >= config.marketMaker.tapePressureMinTrades &&
      pressureMagnitude > config.marketMaker.tapePressureImbalanceThreshold + 1e-9 &&
      config.marketMaker.tapePressureMaxInwardTicks > 0
    ) {
      const normalizedMagnitude = clamp01(
        (pressureMagnitude - config.marketMaker.tapePressureImbalanceThreshold) /
          Math.max(1e-9, 1 - config.marketMaker.tapePressureImbalanceThreshold)
      );
      const biasMagnitude = Math.min(
        config.marketMaker.tapePressureMaxInwardTicks,
        Math.ceil(
          normalizedMagnitude *
            velocityRatio *
            config.marketMaker.tapePressureMaxInwardTicks
        )
      );
      biasTicks =
        pressureScore > 0
          ? biasMagnitude
          : pressureScore < 0
            ? -biasMagnitude
            : 0;
    }

    return {
      windowMs: config.marketMaker.tapePressureWindowMs,
      recentTradeCount,
      buyTradeCount,
      sellTradeCount,
      buyVolume: Number(buyVolume.toFixed(8)),
      sellVolume: Number(sellVolume.toFixed(8)),
      tradesPerMinute: Number(tradesPerMinute.toFixed(4)),
      signedTradeImbalance: Number(signedTradeImbalance.toFixed(4)),
      signedVolumeImbalance: Number(signedVolumeImbalance.toFixed(4)),
      pressureScore: Number(pressureScore.toFixed(4)),
      biasTicks,
      dominantSide: biasTicks > 0 ? "BUY" : biasTicks < 0 ? "SELL" : undefined,
      lastTradeSide: state.tapeSamples[state.tapeSamples.length - 1]?.side
    };
  }
}
