import { describe, expect, it } from "vitest";

import {
  filterMarketsForSelectionEligibility,
  rankMarketsForSelection,
  rankNegativeRiskGroupsForSelection
} from "../src/core/market-selection.js";
import { config } from "../src/config.js";
import type { NegativeRiskGroup } from "../src/strategy/negative-risk.js";
import type { BinaryMarket } from "../src/types.js";

const futureEndDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const makeBinaryMarket = (
  id: string,
  overrides: Partial<BinaryMarket> = {}
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
  tokenIds: [`yes-${id}`, `no-${id}`],
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
  negRisk: false,
  rewardRatePerDay: 0.5,
  rewardsMinSize: 1,
  rewardsMaxSpread: 0.05,
  ...overrides
});

const makeNegativeRiskGroup = (
  id: string,
  marketCount: number,
  marketOverrides: Partial<BinaryMarket> = {}
): NegativeRiskGroup => ({
  eventId: `event-${id}`,
  eventSlug: `event-${id}`,
  eventTitle: `Event ${id}`,
  marketId: `market-id-${id}`,
  markets: Array.from({ length: marketCount }, (_, index) =>
    makeBinaryMarket(`${id}-${index + 1}`, {
      eventId: `event-${id}`,
      eventSlug: `event-${id}`,
      eventTitle: `Event ${id}`,
      groupItemTitle: `Outcome ${index + 1}`,
      negRisk: true,
      enableNegRisk: true,
      ...marketOverrides
    })
  )
});

describe("Market selection ranking", () => {
  it("prefers reward and rebate friendly markets for market making", () => {
    const rewardHeavy = makeBinaryMarket("reward-heavy", {
      slug: "reward-heavy",
      feesEnabled: true,
      rewardRatePerDay: 3,
      rewardsMinSize: 1,
      rewardsMaxSpread: 0.02,
      category: "Sports",
      liquidity: 320_000
    });
    const plain = makeBinaryMarket("plain", {
      slug: "plain",
      feesEnabled: false,
      rewardRatePerDay: 0.5,
      rewardsMinSize: 1,
      rewardsMaxSpread: 0.05,
      liquidity: 320_000
    });

    const result = rankMarketsForSelection([plain, rewardHeavy], {
      profile: "market-making",
      maxMarkets: 1
    });

    expect(result.selectedMarkets).toHaveLength(1);
    expect(result.selectedMarkets[0]?.slug).toBe("reward-heavy");
    expect(result.rankedMarkets[0]?.breakdown.reward).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.reward ?? 0
    );
  });

  it("prefers fee-free markets for same-market arbitrage", () => {
    const feeFree = makeBinaryMarket("fee-free", {
      slug: "fee-free",
      feesEnabled: false,
      liquidity: 280_000
    });
    const feeEnabled = makeBinaryMarket("fee-enabled", {
      slug: "fee-enabled",
      feesEnabled: true,
      liquidity: 280_000
    });

    const result = rankMarketsForSelection([feeEnabled, feeFree], {
      profile: "same-market-arb",
      maxMarkets: 1
    });

    expect(result.selectedMarkets).toHaveLength(1);
    expect(result.selectedMarkets[0]?.slug).toBe("fee-free");
    expect(result.rankedMarkets[0]?.breakdown.rebate).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.rebate ?? 0
    );
  });

  it("uses spread and activity signals when ranking similar markets", () => {
    const signalStrong = makeBinaryMarket("signal-strong", {
      slug: "signal-strong",
      feesEnabled: false,
      liquidity: 260_000
    });
    const signalWeak = makeBinaryMarket("signal-weak", {
      slug: "signal-weak",
      feesEnabled: false,
      liquidity: 260_000
    });

    const result = rankMarketsForSelection([signalWeak, signalStrong], {
      profile: "same-market-arb",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          signalStrong.conditionId,
          {
            spreadScore: 0.95,
            activityScore: 0.9,
            depthScore: 0.92,
            averageSpread: 0.012,
            averageBookAgeMs: 250,
            averageTopLevelCoverage: 4.2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 2
          }
        ],
        [
          signalWeak.conditionId,
          {
            spreadScore: 0.2,
            activityScore: 0.25,
            depthScore: 0.18,
            averageSpread: 0.065,
            averageBookAgeMs: 6_000,
            averageTopLevelCoverage: 0.35,
            freshBookCount: 0,
            twoSidedBookCount: 1,
            lastTradeBookCount: 0
          }
        ]
      ])
    });

    expect(result.selectedMarkets[0]?.slug).toBe("signal-strong");
    expect(result.rankedMarkets[0]?.breakdown.spread).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.spread ?? 0
    );
    expect(result.rankedMarkets[0]?.breakdown.activity).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.activity ?? 0
    );
  });

  it("filters out depth-only MM candidates when a lower-liquidity market has verified recent trade flow", () => {
    const highLiquidityQuiet = makeBinaryMarket("high-liquidity-quiet", {
      slug: "high-liquidity-quiet",
      liquidity: 420_000,
      volume24hr: 40_000,
      volume: 400_000
    });
    const lowerLiquidityActive = makeBinaryMarket("lower-liquidity-active", {
      slug: "lower-liquidity-active",
      liquidity: 180_000,
      volume24hr: 18_000,
      volume: 160_000
    });

    const result = rankMarketsForSelection([highLiquidityQuiet, lowerLiquidityActive], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          highLiquidityQuiet.conditionId,
          {
            spreadScore: 0.82,
            activityScore: 0.52,
            depthScore: 0.96,
            averageSpread: 0.02,
            bestBidNotionalFloorUsdc: 220,
            bestAskNotionalFloorUsdc: 220,
            recentActivityEventsInWindow: 24,
            recentTradeEventsInWindow: 0,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 400,
            averageTopLevelCoverage: 5.4,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 2
          }
        ],
        [
          lowerLiquidityActive.conditionId,
          {
            spreadScore: 0.84,
            activityScore: 0.79,
            depthScore: 0.62,
            averageSpread: 0.02,
            bestBidNotionalFloorUsdc: 120,
            bestAskNotionalFloorUsdc: 120,
            recentActivityEventsInWindow: 12,
            recentTradeEventsInWindow: 6,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 300,
            averageTopLevelCoverage: 1.8,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 2
          }
        ]
      ])
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["lower-liquidity-active"]);
    expect(result.rankedMarkets.map((entry) => entry.market.slug)).toEqual([
      "lower-liquidity-active"
    ]);
  });

  it("prefers faster exitability when MM candidates look similarly active", () => {
    const fastExit = makeBinaryMarket("fast-exit", {
      slug: "fast-exit",
      liquidity: 220_000
    });
    const slowExit = makeBinaryMarket("slow-exit", {
      slug: "slow-exit",
      liquidity: 220_000
    });

    const result = rankMarketsForSelection([slowExit, fastExit], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          fastExit.conditionId,
          {
            spreadScore: 0.82,
            activityScore: 0.78,
            depthScore: 0.66,
            averageSpread: 0.02,
            bestBidNotionalFloorUsdc: 90,
            bestAskNotionalFloorUsdc: 90,
            marketableExitNotionalUsdc: 120,
            expectedExitSeconds: 42,
            recentActivityEventsInWindow: 12,
            recentTradeEventsInWindow: 6,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 250,
            averageTopLevelCoverage: 2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 2
          }
        ],
        [
          slowExit.conditionId,
          {
            spreadScore: 0.82,
            activityScore: 0.78,
            depthScore: 0.66,
            averageSpread: 0.02,
            bestBidNotionalFloorUsdc: 90,
            bestAskNotionalFloorUsdc: 90,
            marketableExitNotionalUsdc: 75,
            expectedExitSeconds: 72,
            recentActivityEventsInWindow: 12,
            recentTradeEventsInWindow: 6,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 250,
            averageTopLevelCoverage: 2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 2
          }
        ]
      ])
    });

    expect(result.selectedMarkets[0]?.slug).toBe("fast-exit");
    expect(result.rankedMarkets.map((entry) => entry.market.slug)).toEqual(["fast-exit"]);
    expect(result.diagnostics.mandatoryCandidateCount).toBe(2);
    expect(result.diagnostics.preferredCandidateCount).toBe(1);
  });

  it("keeps non-reward markets eligible while still ranking rewarded markets first", () => {
    const rewarded = makeBinaryMarket("rewarded", {
      slug: "rewarded",
      rewardRatePerDay: 0.8
    });
    const noReward = makeBinaryMarket("no-reward", {
      slug: "no-reward",
      rewardRatePerDay: 0,
      rewardsMinSize: undefined,
      rewardsMaxSpread: undefined
    });

    const result = rankMarketsForSelection([noReward, rewarded], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["rewarded", "no-reward"]);
    expect(result.rankedMarkets.some((entry) => entry.market.slug === "no-reward")).toBe(true);
  });

  it("keeps non-executable reward markets eligible while removing their reward bonus", () => {
    const executableReward = makeBinaryMarket("executable-reward", {
      slug: "executable-reward",
      rewardRatePerDay: 0.8,
      rewardsMinSize: 1,
      rewardsMaxSpread: 0.05
    });
    const nonExecutableReward = makeBinaryMarket("non-executable-reward", {
      slug: "non-executable-reward",
      rewardRatePerDay: 3,
      rewardsMinSize: 200,
      rewardsMaxSpread: 0.01
    });

    const result = rankMarketsForSelection([nonExecutableReward, executableReward], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual([
      "executable-reward",
      "non-executable-reward"
    ]);
    expect(
      result.rankedMarkets.some((entry) => entry.market.slug === "non-executable-reward")
    ).toBe(true);
    expect(
      result.rankedMarkets.find((entry) => entry.market.slug === "non-executable-reward")?.breakdown
        .reward
    ).toBe(0);
    expect(
      result.rankedMarkets.find((entry) => entry.market.slug === "non-executable-reward")?.breakdown
        .structure
    ).toBeLessThan(
      result.rankedMarkets.find((entry) => entry.market.slug === "executable-reward")?.breakdown
        .structure ?? 0
    );
  });

  it("does not let a non-executable reward tag win market-making tie-breaks by raw reward rate alone", () => {
    const noReward = makeBinaryMarket("a-no-reward", {
      slug: "a-no-reward",
      rewardRatePerDay: 0,
      rewardsMinSize: undefined,
      rewardsMaxSpread: undefined
    });
    const nonExecutableReward = makeBinaryMarket("z-non-executable", {
      slug: "z-non-executable",
      rewardRatePerDay: 3,
      rewardsMinSize: 200,
      rewardsMaxSpread: 0.01
    });

    const result = rankMarketsForSelection([nonExecutableReward, noReward], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual([
      "a-no-reward",
      "z-non-executable"
    ]);
  });

  it("pushes non-executable reward markets behind otherwise comparable no-reward markets", () => {
    const noReward = makeBinaryMarket("steady-no-reward", {
      slug: "steady-no-reward",
      rewardRatePerDay: 0,
      rewardsMinSize: undefined,
      rewardsMaxSpread: undefined,
      liquidity: 280_000,
      volume24hr: 12_000
    });
    const nonExecutableReward = makeBinaryMarket("louder-non-executable", {
      slug: "louder-non-executable",
      rewardRatePerDay: 3,
      rewardsMinSize: 200,
      rewardsMaxSpread: 0.01,
      liquidity: 300_000,
      volume24hr: 14_000
    });

    const result = rankMarketsForSelection([nonExecutableReward, noReward], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.rankedMarkets[0]?.market.slug).toBe("steady-no-reward");
    expect(result.rankedMarkets[1]?.market.slug).toBe("louder-non-executable");
  });

  it("excludes markets whose spread is below the documented 1% minimum", () => {
    const tooTight = makeBinaryMarket("too-tight", {
      slug: "too-tight",
      spread: 0.005,
      bestBid: 0.495,
      bestAsk: 0.5
    });
    const acceptable = makeBinaryMarket("acceptable", {
      slug: "acceptable",
      spread: 0.015,
      bestBid: 0.49,
      bestAsk: 0.505
    });

    const result = rankMarketsForSelection([tooTight, acceptable], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["acceptable"]);
    expect(result.rankedMarkets.some((entry) => entry.market.slug === "too-tight")).toBe(false);
  });

  it("drops metadata-only inactive markets from MM selection once trade-flow weighting is enforced", () => {
    const active = makeBinaryMarket("active", {
      slug: "active",
      liquidity: 260_000,
      volume24hr: 90_000,
      volume: 900_000,
      competitive: 85,
      marketScore: 82,
      spread: 0.02
    });
    const inactive = makeBinaryMarket("inactive", {
      slug: "inactive",
      liquidity: 260_000,
      volume24hr: 100,
      volume: 1_000,
      competitive: 0,
      marketScore: 0,
      spread: 0.02
    });

    const result = rankMarketsForSelection([inactive, active], {
      profile: "market-making",
      maxMarkets: 2
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["active"]);
    expect(result.rankedMarkets.some((entry) => entry.market.slug === "inactive")).toBe(false);
  });

  it("keeps only the mandatory stage in the base eligibility filter", () => {
    const strong = makeBinaryMarket("strong-signal", {
      slug: "strong-signal",
      rewardRatePerDay: 1.2
    });
    const thinBid = makeBinaryMarket("thin-bid", {
      slug: "thin-bid",
      rewardRatePerDay: 1.2
    });
    const quiet = makeBinaryMarket("quiet", {
      slug: "quiet",
      rewardRatePerDay: 1.2
    });
    const volatile = makeBinaryMarket("volatile", {
      slug: "volatile",
      rewardRatePerDay: 1.2
    });
    const signalsByConditionId = new Map([
      [
        strong.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 180,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 6,
          midpointRangeInWindow: 0.01,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ],
      [
        thinBid.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 25,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 6,
          midpointRangeInWindow: 0.01,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ],
      [
        quiet.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 180,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 0,
          midpointRangeInWindow: 0.01,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ],
      [
        volatile.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 180,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 6,
          midpointRangeInWindow: 0.08,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ]
    ]);

    const eligible = filterMarketsForSelectionEligibility(
      [thinBid, quiet, volatile, strong],
      { signalsByConditionId }
    );

    expect(eligible.map((market) => market.slug)).toEqual([
      "thin-bid",
      "volatile",
      "strong-signal"
    ]);
  });

  it("applies the same hard eligibility gate before any strategy-specific selection", () => {
    const rewarded = makeBinaryMarket("rewarded-gate", {
      slug: "rewarded-gate",
      rewardRatePerDay: 0.9,
      spread: 0.02
    });
    const noReward = makeBinaryMarket("no-reward-gate", {
      slug: "no-reward-gate",
      rewardRatePerDay: 0,
      rewardsMinSize: undefined,
      rewardsMaxSpread: undefined
    });
    const tooTight = makeBinaryMarket("too-tight-gate", {
      slug: "too-tight-gate",
      spread: 0.005,
      bestBid: 0.495,
      bestAsk: 0.5
    });

    const eligible = filterMarketsForSelectionEligibility([rewarded, noReward, tooTight]);

    expect(eligible.map((market) => market.slug)).toEqual(["rewarded-gate", "no-reward-gate"]);
  });

  it("rejects market-making candidates whose live top-book liquidity would fail execution", () => {
    const thinTopBook = makeBinaryMarket("thin-top-book", {
      slug: "thin-top-book",
      spread: 0.02
    });
    const executable = makeBinaryMarket("executable-top-book", {
      slug: "executable-top-book",
      spread: 0.02
    });

    const eligible = filterMarketsForSelectionEligibility(
      [thinTopBook, executable],
      {
        profile: "market-making",
        signalsByConditionId: new Map([
          [
            thinTopBook.conditionId,
            {
              spreadScore: 0.9,
              activityScore: 0.8,
              depthScore: 0.8,
              averageSpread: 0.02,
              topBookLiquidityFloorUsdc: 20,
              bestBidNotionalFloorUsdc: 90,
              bestAskNotionalFloorUsdc: 90,
              recentActivityEventsInWindow: 6,
              recentTradeEventsInWindow: 2,
              midpointRangeInWindow: 0.01,
              freshBookCount: 2,
              twoSidedBookCount: 2,
              lastTradeBookCount: 2
            }
          ],
          [
            executable.conditionId,
            {
              spreadScore: 0.9,
              activityScore: 0.8,
              depthScore: 0.8,
              averageSpread: 0.02,
              topBookLiquidityFloorUsdc: 180,
              bestBidNotionalFloorUsdc: 90,
              bestAskNotionalFloorUsdc: 90,
              recentActivityEventsInWindow: 6,
              recentTradeEventsInWindow: 2,
              midpointRangeInWindow: 0.01,
              freshBookCount: 2,
              twoSidedBookCount: 2,
              lastTradeBookCount: 2
            }
          ]
        ])
      }
    );

    expect(eligible.map((market) => market.slug)).toEqual(["executable-top-book"]);
  });

  it("keeps mildly weak-support and crowded-exit candidates eligible so runtime freshness controls can make the final BUY decision", () => {
    const weakSupport = makeBinaryMarket("weak-support", {
      slug: "weak-support",
      spread: 0.02
    });
    const crowdedExit = makeBinaryMarket("crowded-exit", {
      slug: "crowded-exit",
      spread: 0.02
    });
    const healthy = makeBinaryMarket("healthy-support", {
      slug: "healthy-support",
      spread: 0.02
    });
    const requiredSupportShares =
      config.marketMaker.quoteSize *
      config.marketMaker.passiveBuyMinBestBidSupportMultiplier;
    const maximumExitQueueAheadShares =
      config.marketMaker.quoteSize *
      config.marketMaker.passiveBuyMaxTargetExitQueueMultiplier;

    const eligible = filterMarketsForSelectionEligibility(
      [weakSupport, crowdedExit, healthy],
      {
        profile: "market-making",
        signalsByConditionId: new Map([
          [
            weakSupport.conditionId,
            {
              spreadScore: 0.9,
              activityScore: 0.8,
              depthScore: 0.8,
              averageSpread: 0.02,
              topBookLiquidityFloorUsdc: 220,
              bestBidNotionalFloorUsdc: 90,
              bestAskNotionalFloorUsdc: 90,
              bestBidSizeFloorShares: requiredSupportShares * 0.75,
              bestAskQueueCeilingShares: 500,
              recentActivityEventsInWindow: 6,
              recentTradeEventsInWindow: 2,
              midpointRangeInWindow: 0.01,
              freshBookCount: 2,
              twoSidedBookCount: 2,
              lastTradeBookCount: 2
            }
          ],
          [
            crowdedExit.conditionId,
            {
              spreadScore: 0.9,
              activityScore: 0.8,
              depthScore: 0.8,
              averageSpread: 0.02,
              topBookLiquidityFloorUsdc: 220,
              bestBidNotionalFloorUsdc: 90,
              bestAskNotionalFloorUsdc: 90,
              bestBidSizeFloorShares: requiredSupportShares * 1.2,
              bestAskQueueCeilingShares: maximumExitQueueAheadShares * 1.25,
              recentActivityEventsInWindow: 6,
              recentTradeEventsInWindow: 2,
              midpointRangeInWindow: 0.01,
              freshBookCount: 2,
              twoSidedBookCount: 2,
              lastTradeBookCount: 2
            }
          ],
          [
            healthy.conditionId,
            {
              spreadScore: 0.9,
              activityScore: 0.8,
              depthScore: 0.8,
              averageSpread: 0.02,
              topBookLiquidityFloorUsdc: 220,
              bestBidNotionalFloorUsdc: 90,
              bestAskNotionalFloorUsdc: 90,
              bestBidSizeFloorShares: requiredSupportShares * 1.2,
              bestAskQueueCeilingShares: 2_000,
              recentActivityEventsInWindow: 6,
              recentTradeEventsInWindow: 2,
              midpointRangeInWindow: 0.01,
              freshBookCount: 2,
              twoSidedBookCount: 2,
              lastTradeBookCount: 2
            }
          ]
        ])
      }
    );

    expect(eligible.map((market) => market.slug)).toEqual([
      "weak-support",
      "crowded-exit",
      "healthy-support"
    ]);
  });

  it("rejects market-making candidates that already violate severe execution gates", () => {
    const veryWeakSupport = makeBinaryMarket("very-weak-support", {
      slug: "very-weak-support",
      spread: 0.02
    });
    const veryCrowdedExit = makeBinaryMarket("very-crowded-exit", {
      slug: "very-crowded-exit",
      spread: 0.02
    });
    const verySlowExit = makeBinaryMarket("very-slow-exit", {
      slug: "very-slow-exit",
      spread: 0.02
    });
    const healthy = makeBinaryMarket("healthy-execution", {
      slug: "healthy-execution",
      spread: 0.02
    });
    const requiredSupportShares =
      config.marketMaker.quoteSize *
      config.marketMaker.passiveBuyMinBestBidSupportMultiplier;
    const maximumExitQueueAheadShares =
      config.marketMaker.quoteSize *
      config.marketMaker.passiveBuyMaxTargetExitQueueMultiplier;
    const healthySignal = {
      spreadScore: 0.9,
      activityScore: 0.8,
      depthScore: 0.8,
      averageSpread: 0.02,
      topBookLiquidityFloorUsdc: 220,
      bestBidNotionalFloorUsdc: 90,
      bestAskNotionalFloorUsdc: 90,
      bestBidSizeFloorShares: requiredSupportShares * 1.2,
      bestAskQueueCeilingShares: maximumExitQueueAheadShares * 0.5,
      marketableExitNotionalUsdc: config.marketMaker.quoteSize,
      expectedExitSeconds: config.marketMaker.passiveBuyMaxExpectedExitSeconds,
      recentActivityEventsInWindow: 6,
      recentTradeEventsInWindow: Math.max(config.marketUniverse.minRecentTradeEvents, 2),
      recentTradeEventsFloorInWindow: 1,
      midpointRangeInWindow: 0.01,
      freshBookCount: 2,
      twoSidedBookCount: 2,
      lastTradeBookCount: 2
    };

    const eligible = filterMarketsForSelectionEligibility(
      [veryWeakSupport, veryCrowdedExit, verySlowExit, healthy],
      {
        profile: "market-making",
        signalsByConditionId: new Map([
          [
            veryWeakSupport.conditionId,
            {
              ...healthySignal,
              bestBidSizeFloorShares: requiredSupportShares * 0.4
            }
          ],
          [
            veryCrowdedExit.conditionId,
            {
              ...healthySignal,
              bestAskQueueCeilingShares: maximumExitQueueAheadShares * 2.5
            }
          ],
          [
            verySlowExit.conditionId,
            {
              ...healthySignal,
              expectedExitSeconds:
                config.marketMaker.passiveBuyMaxExpectedExitSeconds * 2 + 1
            }
          ],
          [healthy.conditionId, healthySignal]
        ])
      }
    );

    expect(eligible.map((market) => market.slug)).toEqual(["healthy-execution"]);
  });

  it("does not promote mandatory MM candidates when live signals show they are not executable", () => {
    const thinBid = makeBinaryMarket("fallback-thin-bid", {
      slug: "fallback-thin-bid",
      rewardRatePerDay: 0
    });
    const volatile = makeBinaryMarket("fallback-volatile", {
      slug: "fallback-volatile",
      rewardRatePerDay: 0
    });
    const signalsByConditionId = new Map([
      [
        thinBid.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 25,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 6,
          midpointRangeInWindow: 0.01,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ],
      [
        volatile.conditionId,
        {
          spreadScore: 0.9,
          activityScore: 0.9,
          depthScore: 0.9,
          averageSpread: 0.02,
          bestBidNotionalFloorUsdc: 180,
          bestAskNotionalFloorUsdc: 190,
          recentActivityEventsInWindow: 6,
          midpointRangeInWindow: 0.08,
          freshBookCount: 2,
          twoSidedBookCount: 2,
          lastTradeBookCount: 2
        }
      ]
    ]);

    const result = rankMarketsForSelection([thinBid, volatile], {
      profile: "market-making",
      maxMarkets: 2,
      signalsByConditionId,
      requireLiveExecutionSignals: true
    });

    expect(result.selectedMarkets).toEqual([]);
    expect(result.diagnostics.mandatoryCandidateCount).toBe(2);
    expect(result.diagnostics.preferredCandidateCount).toBe(0);
    expect(result.diagnostics.usedMandatoryFallback).toBe(false);
  });

  it("keeps mandatory MM candidates as a startup watchlist before live signals arrive", () => {
    const startupCandidate = makeBinaryMarket("startup-watchlist", {
      slug: "startup-watchlist",
      rewardRatePerDay: 0
    });

    const result = rankMarketsForSelection([startupCandidate], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map(),
      requireLiveExecutionSignals: true
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["startup-watchlist"]);
    expect(result.diagnostics.mandatoryCandidateCount).toBe(1);
    expect(result.diagnostics.preferredCandidateCount).toBe(0);
    expect(result.diagnostics.usedMandatoryFallback).toBe(true);
  });

  it("allows one-sided recent trade flow into MM selection so token-level freshness gates can choose the active side", () => {
    const oneSidedFlow = makeBinaryMarket("one-sided-flow", {
      slug: "one-sided-flow",
      rewardRatePerDay: 0
    });

    const result = rankMarketsForSelection([oneSidedFlow], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          oneSidedFlow.conditionId,
          {
            spreadScore: 0.9,
            activityScore: 0.8,
            depthScore: 0.8,
            averageSpread: 0.02,
            topBookLiquidityFloorUsdc: 180,
            bestBidNotionalFloorUsdc: 90,
            bestAskNotionalFloorUsdc: 90,
            bestBidSizeFloorShares:
              config.marketMaker.quoteSize *
              config.marketMaker.passiveBuyMinBestBidSupportMultiplier,
            bestAskQueueCeilingShares: 50,
            marketableExitNotionalUsdc: config.marketMaker.quoteSize,
            recentActivityEventsInWindow: 4,
            recentTradeEventsInWindow: Math.max(config.marketUniverse.minRecentTradeEvents, 1),
            recentTradeEventsFloorInWindow: 0,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 500,
            averageTopLevelCoverage: 2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 1
          }
        ]
      ]),
      requireLiveExecutionSignals: true
    });

    expect(result.selectedMarkets.map((market) => market.slug)).toEqual(["one-sided-flow"]);
    expect(result.diagnostics.preferredCandidateCount).toBe(1);
    expect(result.diagnostics.preferredRejectReasons).not.toHaveProperty(
      "one_sided_recent_trade_flow"
    );
  });

  it("keeps zero-trade MM markets out of live execution fallback", () => {
    const noTradeFlow = makeBinaryMarket("zero-trade-flow", {
      slug: "zero-trade-flow",
      rewardRatePerDay: 0
    });

    const result = rankMarketsForSelection([noTradeFlow], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          noTradeFlow.conditionId,
          {
            spreadScore: 0.9,
            activityScore: 0.8,
            depthScore: 0.8,
            averageSpread: 0.02,
            topBookLiquidityFloorUsdc: 180,
            bestBidNotionalFloorUsdc: 90,
            bestAskNotionalFloorUsdc: 90,
            bestBidSizeFloorShares:
              config.marketMaker.quoteSize *
              config.marketMaker.passiveBuyMinBestBidSupportMultiplier,
            bestAskQueueCeilingShares: 50,
            marketableExitNotionalUsdc: config.marketMaker.quoteSize,
            recentActivityEventsInWindow: 4,
            recentTradeEventsInWindow: 0,
            recentTradeEventsFloorInWindow: 0,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 500,
            averageTopLevelCoverage: 2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 0
          }
        ]
      ]),
      requireLiveExecutionSignals: true
    });

    expect(result.selectedMarkets).toEqual([]);
    expect(result.diagnostics.mandatoryCandidateCount).toBe(0);
    expect(result.diagnostics.preferredCandidateCount).toBe(0);
    expect(result.diagnostics.usedMandatoryFallback).toBe(false);
    expect(result.diagnostics.preferredRejectReasons).toEqual({});
  });

  it("does not use metadata fallback for execution once live telemetry exists elsewhere", () => {
    const metadataOnly = makeBinaryMarket("metadata-only-fallback", {
      slug: "metadata-only-fallback",
      rewardRatePerDay: 0,
      liquidity: 300_000,
      volume24hr: 90_000,
      volume: 950_000,
      spread: 0.02
    });

    const result = rankMarketsForSelection([metadataOnly], {
      profile: "market-making",
      maxMarkets: 1,
      signalsByConditionId: new Map([
        [
          "other-live-condition",
          {
            spreadScore: 0.9,
            activityScore: 0.8,
            depthScore: 0.8,
            averageSpread: 0.02,
            topBookLiquidityFloorUsdc: 180,
            bestBidNotionalFloorUsdc: 90,
            bestAskNotionalFloorUsdc: 90,
            bestBidSizeFloorShares:
              config.marketMaker.quoteSize *
              config.marketMaker.passiveBuyMinBestBidSupportMultiplier,
            bestAskQueueCeilingShares: 50,
            marketableExitNotionalUsdc: config.marketMaker.quoteSize,
            recentActivityEventsInWindow: 4,
            recentTradeEventsInWindow: Math.max(config.marketUniverse.minRecentTradeEvents, 1),
            recentTradeEventsFloorInWindow: 0,
            midpointRangeInWindow: 0.01,
            averageBookAgeMs: 500,
            averageTopLevelCoverage: 2,
            freshBookCount: 2,
            twoSidedBookCount: 2,
            lastTradeBookCount: 1
          }
        ]
      ]),
      requireLiveExecutionSignals: true
    });

    expect(result.selectedMarkets).toEqual([]);
    expect(result.diagnostics.mandatoryCandidateCount).toBe(1);
    expect(result.diagnostics.preferredCandidateCount).toBe(0);
    expect(result.diagnostics.usedMandatoryFallback).toBe(false);
    expect(result.diagnostics.preferredRejectReasons).toMatchObject({
      missing_live_execution_signal: 1
    });
  });

  it("uses market volume metadata when live book signals are absent", () => {
    const activeMarket = makeBinaryMarket("active-market", {
      slug: "active-market",
      liquidity: 260_000,
      volume24hr: 85_000,
      volume: 900_000,
      competitive: 90,
      marketScore: 88,
      spread: 0.018
    });
    const sleepyMarket = makeBinaryMarket("sleepy-market", {
      slug: "sleepy-market",
      liquidity: 260_000,
      volume24hr: 400,
      volume: 4_000,
      competitive: 10,
      marketScore: 12,
      spread: 0.06
    });

    const result = rankMarketsForSelection([sleepyMarket, activeMarket], {
      profile: "same-market-arb",
      maxMarkets: 1
    });

    expect(result.selectedMarkets[0]?.slug).toBe("active-market");
    expect(result.rankedMarkets[0]?.breakdown.activity).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.activity ?? 0
    );
    expect(result.rankedMarkets[0]?.breakdown.spread).toBeGreaterThan(
      result.rankedMarkets[1]?.breakdown.spread ?? 0
    );
  });

  it("applies stickiness to reduce churn when scores are close", () => {
    const incumbent = makeBinaryMarket("incumbent", {
      slug: "incumbent",
      liquidity: 260_000
    });
    const challenger = makeBinaryMarket("challenger", {
      slug: "challenger",
      liquidity: 275_000
    });

    const withoutStickiness = rankMarketsForSelection([incumbent, challenger], {
      profile: "same-market-arb",
      maxMarkets: 1
    });
    const withStickiness = rankMarketsForSelection([incumbent, challenger], {
      profile: "same-market-arb",
      maxMarkets: 1,
      preferredConditionIds: new Set([incumbent.conditionId]),
      stickinessBoost: 0.08
    });

    expect(withoutStickiness.selectedMarkets[0]?.slug).toBe("challenger");
    expect(withStickiness.selectedMarkets[0]?.slug).toBe("incumbent");
    expect(withStickiness.rankedMarkets[0]?.breakdown.retentionBonus).toBeGreaterThan(0);
  });

  it("keeps Negative Risk groups intact while respecting the total market cap", () => {
    const highLiquidityGroup = makeNegativeRiskGroup("alpha", 3, {
      liquidity: 350_000,
      rewardRatePerDay: 1.5,
      feesEnabled: true,
      category: "Sports"
    });
    const mediumGroup = makeNegativeRiskGroup("beta", 2, {
      liquidity: 220_000,
      rewardRatePerDay: 0.5,
      feesEnabled: true,
      category: "Sports"
    });
    const overflowGroup = makeNegativeRiskGroup("gamma", 4, {
      liquidity: 150_000,
      rewardRatePerDay: 0,
      feesEnabled: false
    });

    const result = rankNegativeRiskGroupsForSelection(
      [overflowGroup, mediumGroup, highLiquidityGroup],
      {
        maxMarkets: 5
      }
    );

    expect(result.selectedGroups.map((group) => group.eventId)).toEqual([
      "event-alpha",
      "event-beta"
    ]);
    expect(result.diagnostics.selectedGroupCount).toBe(2);
    expect(result.diagnostics.selectedMarketCount).toBe(5);
    expect(result.selectedGroups.some((group) => group.eventId === "event-gamma")).toBe(false);
  });
});
