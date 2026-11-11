import { describe, expect, it } from "vitest";

import {
  buildMarketSelectionSignal,
  buildSelectionSignalSubscriptionAssetIds,
  estimateBestBidSupportShares,
  estimateExpectedExitSeconds,
  estimateMarketableExitNotionalUsdc,
  estimatePassiveExitQueueAheadShares,
  resolveSelectionTargetShares
} from "../src/core/market-selection-signals.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

const futureEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const makeBinaryMarket = (
  id: string,
  tokenIds: [string, string]
): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: `question-${id}`,
  question: `Will outcome ${id} happen?`,
  slug: `market-${id}`,
  eventId: `event-${id}`,
  eventSlug: `event-${id}`,
  eventTitle: `Event ${id}`,
  groupItemTitle: `Outcome ${id}`,
  category: "Politics",
  liquidity: 300_000,
  volume24hr: 15_000,
  volume: 120_000,
  competitive: 60,
  marketScore: 65,
  outcomes: ["Yes", "No"],
  tokenIds,
  bestBid: 0.48,
  bestAsk: 0.5,
  spread: 0.02,
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  endDate: futureEndDate,
  feesEnabled: false,
  negRisk: false
});

describe("buildSelectionSignalSubscriptionAssetIds", () => {
  it("tracks all eligible market tokens for selection signals", () => {
    const eligibleMarkets = [
      makeBinaryMarket("one", ["yes-1", "no-1"]),
      makeBinaryMarket("two", ["yes-2", "no-2"])
    ];
    const selectedMarkets = [eligibleMarkets[0]!];

    expect(buildSelectionSignalSubscriptionAssetIds(eligibleMarkets, selectedMarkets)).toEqual([
      "yes-1",
      "no-1",
      "yes-2",
      "no-2"
    ]);
  });

  it("keeps selected-market tokens subscribed even if they are not in the eligible list", () => {
    const eligibleMarkets = [makeBinaryMarket("one", ["yes-1", "no-1"])];
    const selectedMarkets = [makeBinaryMarket("legacy", ["yes-legacy", "no-legacy"])];

    expect(buildSelectionSignalSubscriptionAssetIds(eligibleMarkets, selectedMarkets)).toEqual([
      "yes-1",
      "no-1",
      "yes-legacy",
      "no-legacy"
    ]);
  });
});

describe("market selection exitability signals", () => {
  it("estimates current marketable exit notional and expected exit seconds from bid depth and tape", () => {
    const book: NormalizedOrderBook = {
      assetId: "yes-1",
      market: "market-one",
      bids: [
        { price: 0.48, size: 20 },
        { price: 0.47, size: 20 }
      ],
      asks: [{ price: 0.5, size: 20 }],
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      lastTradePrice: 0.49,
      hash: undefined,
      updatedAtMs: Date.now(),
      tapePressure: {
        windowMs: 60_000,
        recentTradeCount: 8,
        buyTradeCount: 5,
        sellTradeCount: 3,
        buyVolume: 30,
        sellVolume: 12,
        tradesPerMinute: 8,
        signedTradeImbalance: 0.25,
        signedVolumeImbalance: 0.4286,
        pressureScore: 0.2,
        biasTicks: 1,
        dominantSide: "BUY",
        lastTradeSide: "BUY"
      }
    };

    expect(estimateMarketableExitNotionalUsdc(book, 25)).toBe(11.95);
    expect(estimateExpectedExitSeconds(book, 25)).toBe(50);
    expect(estimateBestBidSupportShares(book)).toBe(20);
    expect(estimatePassiveExitQueueAheadShares(book, 0.5)).toBe(20);
  });

  it("includes exitability metrics in the aggregated market signal", () => {
    const market = makeBinaryMarket("signal", ["yes-signal", "no-signal"]);
    const books = new Map<string, NormalizedOrderBook>([
      [
        market.tokenIds[0],
        {
          assetId: market.tokenIds[0],
          market: market.slug,
          bids: [
            { price: 0.47, size: 30 },
            { price: 0.46, size: 20 }
          ],
          asks: [{ price: 0.49, size: 30 }],
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          lastTradePrice: 0.48,
          hash: undefined,
          updatedAtMs: Date.now(),
          tapePressure: {
            windowMs: 60_000,
            recentTradeCount: 10,
            buyTradeCount: 6,
            sellTradeCount: 4,
            buyVolume: 24,
            sellVolume: 12,
            tradesPerMinute: 10,
            signedTradeImbalance: 0.2,
            signedVolumeImbalance: 0.3333,
            pressureScore: 0.18,
            biasTicks: 1,
            dominantSide: "BUY",
            lastTradeSide: "BUY"
          }
        }
      ],
      [
        market.tokenIds[1],
        {
          assetId: market.tokenIds[1],
          market: market.slug,
          bids: [
            { price: 0.53, size: 30 },
            { price: 0.52, size: 20 }
          ],
          asks: [{ price: 0.55, size: 30 }],
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          lastTradePrice: 0.54,
          hash: undefined,
          updatedAtMs: Date.now(),
          tapePressure: {
            windowMs: 60_000,
            recentTradeCount: 12,
            buyTradeCount: 7,
            sellTradeCount: 5,
            buyVolume: 18,
            sellVolume: 10,
            tradesPerMinute: 12,
            signedTradeImbalance: 0.1667,
            signedVolumeImbalance: 0.2857,
            pressureScore: 0.15,
            biasTicks: 1,
            dominantSide: "BUY",
            lastTradeSide: "BUY"
          }
        }
      ]
    ]);

    const signal = buildMarketSelectionSignal(
      market,
      (tokenId) => books.get(tokenId),
      () => ({
        recentActivityEvents: 6,
        recentTradeEvents: 4,
        midpointRange: 0.01
      })
    );
    const targetShares = resolveSelectionTargetShares(market);
    const expectedMarketableExitNotionalUsdc = Math.min(
      estimateMarketableExitNotionalUsdc(books.get(market.tokenIds[0]), targetShares) ?? Number.POSITIVE_INFINITY,
      estimateMarketableExitNotionalUsdc(books.get(market.tokenIds[1]), targetShares) ?? Number.POSITIVE_INFINITY
    );
    const expectedExitSeconds = Math.max(
      estimateExpectedExitSeconds(books.get(market.tokenIds[0]), targetShares) ?? 0,
      estimateExpectedExitSeconds(books.get(market.tokenIds[1]), targetShares) ?? 0
    );

    expect(signal).toEqual(
      expect.objectContaining({
        topBookLiquidityFloorUsdc: 28.8,
        bestBidSizeFloorShares: 30,
        bestAskQueueCeilingShares: 30,
        marketableExitNotionalUsdc: expectedMarketableExitNotionalUsdc,
        expectedExitSeconds,
        recentTradeEventsInWindow: 8,
        recentTradeEventsFloorInWindow: 4
      })
    );
  });
});
