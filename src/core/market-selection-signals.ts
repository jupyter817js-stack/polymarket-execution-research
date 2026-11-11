import { config } from "../config.js";
import type { MarketSelectionSignal } from "./market-selection.js";
import type { BinaryMarket, NormalizedOrderBook } from "../types.js";

export interface MarketSelectionBookTelemetry {
  recentActivityEvents: number;
  recentTradeEvents?: number;
  midpointRange?: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const roundScore = (value: number): number => Number(value.toFixed(4));

const roundValue = (value: number): number => Number(value.toFixed(4));

const average = (values: readonly number[]): number =>
  values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 0;

const normalizeLinear = (value: number, minValue: number, maxValue: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (maxValue <= minValue) {
    return value >= maxValue ? 1 : 0;
  }

  return clamp01((value - minValue) / (maxValue - minValue));
};

const getBestSpread = (book: NormalizedOrderBook): number | undefined => {
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

  return bestAsk - bestBid;
};

const scoreTightSpread = (averageSpread: number | undefined): number => {
  if (typeof averageSpread !== "number" || !Number.isFinite(averageSpread)) {
    return 0.45;
  }

  return roundScore(1 - clamp01((averageSpread - 0.01) / 0.07));
};

export const resolveSelectionTargetShares = (market: BinaryMarket): number =>
  Math.max(
    config.strategy.targetShares,
    config.marketMaker.quoteSize,
    market.orderMinSize,
    1
  );

export const estimateMarketableExitNotionalUsdc = (
  book: NormalizedOrderBook | undefined,
  targetShares: number
): number | undefined => {
  if (!book || !(targetShares > 0) || book.bids.length === 0) {
    return undefined;
  }

  let remainingShares = targetShares;
  let marketableNotionalUsdc = 0;

  for (const level of book.bids) {
    if (!(level.size > 0) || !(level.price > 0)) {
      continue;
    }

    const executedShares = Math.min(remainingShares, level.size);
    marketableNotionalUsdc += executedShares * level.price;
    remainingShares -= executedShares;

    if (remainingShares <= 1e-9) {
      break;
    }
  }

  return marketableNotionalUsdc > 0 ? roundValue(marketableNotionalUsdc) : undefined;
};

export const estimateBestBidSupportShares = (
  book: NormalizedOrderBook | undefined
): number | undefined => {
  const bestBidSize = book?.bids[0]?.size;
  return typeof bestBidSize === "number" && Number.isFinite(bestBidSize) && bestBidSize >= 0
    ? roundValue(bestBidSize)
    : undefined;
};

export const estimatePassiveExitQueueAheadShares = (
  book: NormalizedOrderBook | undefined,
  targetExitPrice: number | undefined
): number | undefined => {
  if (
    !book ||
    !(typeof targetExitPrice === "number") ||
    !Number.isFinite(targetExitPrice) ||
    !(targetExitPrice > 0)
  ) {
    return undefined;
  }

  let queueAheadShares = 0;
  for (const level of book.asks) {
    if (!(level.size > 0) || !(level.price > 0)) {
      continue;
    }

    if (level.price - Number.EPSILON > targetExitPrice) {
      break;
    }

    queueAheadShares += level.size;
  }

  return roundValue(queueAheadShares);
};

export const estimateExpectedExitSeconds = (
  book: NormalizedOrderBook | undefined,
  targetShares: number
): number | undefined => {
  if (!book || !(targetShares > 0)) {
    return undefined;
  }

  const tapePressure = book.tapePressure;
  if (
    !tapePressure ||
    !(tapePressure.windowMs > 0) ||
    !(tapePressure.buyVolume > 0) ||
    !(tapePressure.buyTradeCount > 0)
  ) {
    return undefined;
  }

  const buySharesPerSecond = tapePressure.buyVolume / (tapePressure.windowMs / 1_000);
  if (!(buySharesPerSecond > 0)) {
    return undefined;
  }

  return roundValue(targetShares / buySharesPerSecond);
};

export const buildMarketSelectionSignal = (
  market: BinaryMarket,
  getBook: (tokenId: string) => NormalizedOrderBook | undefined,
  getTelemetry?: (tokenId: string) => MarketSelectionBookTelemetry | undefined,
  getDisplacementRate?: (conditionId: string) => number
): MarketSelectionSignal | undefined => {
  const books = market.tokenIds
    .map((tokenId) => getBook(tokenId))
    .filter((book): book is NormalizedOrderBook => Boolean(book));

  if (books.length === 0) {
    return undefined;
  }

  const now = Date.now();
  const maxBookStalenessMs = Math.max(config.strategy.maxBookStalenessMs, 1);
  const bookAges = books.map((book) => Math.max(0, now - book.updatedAtMs));
  const freshBookCount = bookAges.filter((ageMs) => ageMs <= maxBookStalenessMs).length;
  const freshnessScore = average(bookAges.map((ageMs) => clamp01(1 - ageMs / maxBookStalenessMs)));
  const twoSidedBooks = books.filter((book) => book.bids.length > 0 && book.asks.length > 0);
  const lastTradeBookCount = books.filter(
    (book) => typeof book.lastTradePrice === "number" && Number.isFinite(book.lastTradePrice)
  ).length;
  const targetShares = resolveSelectionTargetShares(market);
  const topLevelCoverages = twoSidedBooks.map((book) => {
    const bestBidSize = book.bids[0]?.size ?? 0;
    const bestAskSize = book.asks[0]?.size ?? 0;
    return (bestBidSize + bestAskSize) / (2 * targetShares);
  });
  const averageTopLevelCoverage = average(topLevelCoverages);
  const depthScore = roundScore(normalizeLinear(averageTopLevelCoverage, 0.5, 4));
  const averageSpread = average(
    twoSidedBooks
      .map((book) => getBestSpread(book))
      .filter((spread): spread is number => typeof spread === "number")
  );
  const bestBidNotionalFloorUsdc = Math.min(
    ...twoSidedBooks.map((book) => {
      const bestBid = book.bids[0];
      return bestBid ? bestBid.price * bestBid.size : Number.POSITIVE_INFINITY;
    })
  );
  const bestBidSizeFloorShares = Math.min(
    ...twoSidedBooks.map((book) => book.bids[0]?.size ?? Number.POSITIVE_INFINITY)
  );
  const topBookLiquidityFloorUsdc = Math.min(
    ...twoSidedBooks.map((book) => {
      const bestBid = book.bids[0];
      const bestAsk = book.asks[0];
      return bestBid && bestAsk
        ? bestBid.price * bestBid.size + bestAsk.price * bestAsk.size
        : Number.POSITIVE_INFINITY;
    })
  );
  const bestAskNotionalFloorUsdc = Math.min(
    ...twoSidedBooks.map((book) => {
      const bestAsk = book.asks[0];
      return bestAsk ? bestAsk.price * bestAsk.size : Number.POSITIVE_INFINITY;
    })
  );
  const bestAskQueueCeilingShares = Math.max(
    ...twoSidedBooks.map((book) =>
      estimatePassiveExitQueueAheadShares(book, book.asks[0]?.price) ?? 0
    )
  );
  const marketableExitNotionalCandidates = books
    .map((book) => estimateMarketableExitNotionalUsdc(book, targetShares))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const marketableExitNotionalUsdc =
    marketableExitNotionalCandidates.length > 0
      ? Math.min(...marketableExitNotionalCandidates)
      : undefined;
  const expectedExitSecondsCandidates = books
    .map((book) => estimateExpectedExitSeconds(book, targetShares))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const expectedExitSeconds =
    expectedExitSecondsCandidates.length === books.length && books.length > 0
      ? Math.max(...expectedExitSecondsCandidates)
      : undefined;
  const telemetryByTokenId = market.tokenIds
    .map((tokenId) => ({ tokenId, telemetry: getTelemetry?.(tokenId) }))
    .filter(
      (
        entry
      ): entry is {
        tokenId: string;
        telemetry: MarketSelectionBookTelemetry;
      } => Boolean(entry.telemetry)
    );
  const recentActivityEventsInWindow = telemetryByTokenId.reduce(
    (total, entry) => total + Math.max(0, entry.telemetry.recentActivityEvents),
    0
  );
  const recentTradeEventsInWindow = telemetryByTokenId.reduce(
    (total, entry) => total + Math.max(0, entry.telemetry.recentTradeEvents ?? 0),
    0
  );
  const recentTradeEventsByToken = market.tokenIds.map((tokenId) =>
    Math.max(0, getTelemetry?.(tokenId)?.recentTradeEvents ?? 0)
  );
  const recentTradeEventsFloorInWindow =
    recentTradeEventsByToken.length > 0 ? Math.min(...recentTradeEventsByToken) : undefined;
  const midpointRangeInWindowCandidates = telemetryByTokenId
    .map((entry) => entry.telemetry.midpointRange)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const midpointRangeInWindow =
    midpointRangeInWindowCandidates.length > 0
      ? Math.max(...midpointRangeInWindowCandidates)
      : undefined;
  const activityScore = roundScore(
    freshnessScore * 0.3 +
      (twoSidedBooks.length / books.length) * 0.2 +
      (lastTradeBookCount / books.length) * 0.15 +
      depthScore * 0.35
  );

  return {
    spreadScore: scoreTightSpread(averageSpread),
    activityScore,
    depthScore,
    averageSpread: Number.isFinite(averageSpread) && averageSpread > 0 ? roundScore(averageSpread) : undefined,
    topBookLiquidityFloorUsdc:
      Number.isFinite(topBookLiquidityFloorUsdc) && topBookLiquidityFloorUsdc > 0
        ? roundScore(topBookLiquidityFloorUsdc)
        : undefined,
    bestBidNotionalFloorUsdc:
      Number.isFinite(bestBidNotionalFloorUsdc) && bestBidNotionalFloorUsdc > 0
        ? roundScore(bestBidNotionalFloorUsdc)
        : undefined,
    bestBidSizeFloorShares:
      Number.isFinite(bestBidSizeFloorShares) && bestBidSizeFloorShares >= 0
        ? roundValue(bestBidSizeFloorShares)
        : undefined,
    bestAskNotionalFloorUsdc:
      Number.isFinite(bestAskNotionalFloorUsdc) && bestAskNotionalFloorUsdc > 0
        ? roundScore(bestAskNotionalFloorUsdc)
        : undefined,
    bestAskQueueCeilingShares:
      Number.isFinite(bestAskQueueCeilingShares) && bestAskQueueCeilingShares >= 0
        ? roundValue(bestAskQueueCeilingShares)
        : undefined,
    marketableExitNotionalUsdc:
      typeof marketableExitNotionalUsdc === "number" && marketableExitNotionalUsdc > 0
        ? roundValue(marketableExitNotionalUsdc)
        : undefined,
    expectedExitSeconds:
      typeof expectedExitSeconds === "number" && expectedExitSeconds > 0
        ? roundValue(expectedExitSeconds)
        : undefined,
    recentActivityEventsInWindow,
    recentTradeEventsInWindow,
    recentTradeEventsFloorInWindow,
    midpointRangeInWindow:
      typeof midpointRangeInWindow === "number"
        ? roundScore(midpointRangeInWindow)
        : undefined,
    averageBookAgeMs: Math.round(average(bookAges)),
    averageTopLevelCoverage: Number.isFinite(averageTopLevelCoverage)
      ? roundScore(averageTopLevelCoverage)
      : undefined,
    freshBookCount,
    twoSidedBookCount: twoSidedBooks.length,
    lastTradeBookCount,
    makerCompetitionScore: (() => {
      const rate = getDisplacementRate?.(market.conditionId);
      return typeof rate === "number" && rate > 0
        ? roundScore(1 - clamp01(rate))
        : undefined;
    })()
  };
};

export const buildMarketSelectionSignals = (
  markets: readonly BinaryMarket[],
  getBook: (tokenId: string) => NormalizedOrderBook | undefined,
  getTelemetry?: (tokenId: string) => MarketSelectionBookTelemetry | undefined,
  getDisplacementRate?: (conditionId: string) => number
): Map<string, MarketSelectionSignal> => {
  const signalsByConditionId = new Map<string, MarketSelectionSignal>();

  for (const market of markets) {
    const signal = buildMarketSelectionSignal(market, getBook, getTelemetry, getDisplacementRate);

    if (!signal) {
      continue;
    }

    signalsByConditionId.set(market.conditionId, signal);
  }

  return signalsByConditionId;
};

export const buildSelectionSignalSubscriptionAssetIds = (
  eligibleMarkets: readonly BinaryMarket[],
  selectedMarkets: readonly BinaryMarket[] = []
): string[] => {
  const assetIds = new Set<string>();

  for (const market of eligibleMarkets) {
    for (const tokenId of market.tokenIds) {
      assetIds.add(tokenId);
    }
  }

  for (const market of selectedMarkets) {
    for (const tokenId of market.tokenIds) {
      assetIds.add(tokenId);
    }
  }

  return [...assetIds];
};
