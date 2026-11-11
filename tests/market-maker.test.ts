import { Side } from "@polymarket/clob-client-v2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import type { TrackedInventoryPosition } from "../src/core/inventory-lot-tracker.js";
import type { RiskExecutionThrottleSnapshot } from "../src/core/degraded-execution-policy.js";
import {
  evaluateMarketMakerPlan,
  type MarketMakerFillRateFeedback
} from "../src/strategy/market-maker.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

const baseMarket: BinaryMarket = {
  id: "1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "Will BTC be above 120k?",
  slug: "btc-above-120k",
  category: "Crypto",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: true,
  negRisk: false
};

const makeBook = (
  assetId: string,
  bestBid = 0.49,
  bestAsk = 0.51,
  updatedAtMs = Date.now()
): NormalizedOrderBook => ({
  assetId,
  market: baseMarket.conditionId,
  bids: [{ price: bestBid, size: 2_500 }],
  asks: [{ price: bestAsk, size: 2_500 }],
  tickSize: 0.01,
  minOrderSize: 1,
  negRisk: false,
  lastTradePrice: 0.5,
  hash: undefined,
  updatedAtMs
});

describe("Market-maker planning", () => {
  const originalQuoteSize = config.marketMaker.quoteSize;
  const originalUseRewardMinSize = config.marketMaker.useRewardMinSize;
  const originalEnableTouchQuoteAnchoring = config.marketMaker.enableTouchQuoteAnchoring;
  const originalTouchBidInwardTicks = config.marketMaker.touchBidInwardTicks;
  const originalTouchAskInwardTicks = config.marketMaker.touchAskInwardTicks;
  const originalMinTopBookLiquidityUsdc = config.marketMaker.minTopBookLiquidityUsdc;
  const originalMaxTokenExposureShares = config.marketMaker.maxTokenExposureShares;
  const originalEnableRebateBias = config.marketMaker.enableRebateBias;
  const originalEnableInventorySkew = config.marketMaker.enableInventorySkew;
  const originalInventorySkewMaxTickOffset = config.marketMaker.inventorySkewMaxTickOffset;
  const originalEnableRewardRebateScheduling = config.marketMaker.enableRewardRebateScheduling;
  const originalRewardSchedulingMaxQuoteSizeMultiplier =
    config.marketMaker.rewardSchedulingMaxQuoteSizeMultiplier;
  const originalRewardSchedulingRateCapPerDay =
    config.marketMaker.rewardSchedulingRateCapPerDay;
  const originalRebateSchedulingExtraInwardTicks =
    config.marketMaker.rebateSchedulingExtraInwardTicks;
  const originalRebatePriorityThreshold = config.marketMaker.rebatePriorityThreshold;
  const originalRebateMaxInwardTicks = config.marketMaker.rebateMaxInwardTicks;
  const originalQuoteHalfSpreadTicks = config.marketMaker.quoteHalfSpreadTicks;
  const originalEnableFillRateFeedback = config.marketMaker.enableFillRateFeedback;
  const originalFillRateFeedbackMinPostedQuotes =
    config.marketMaker.fillRateFeedbackMinPostedQuotes;
  const originalFillRateFeedbackTarget = config.marketMaker.fillRateFeedbackTarget;
  const originalFillRateFeedbackMaxInwardTicks =
    config.marketMaker.fillRateFeedbackMaxInwardTicks;
  const originalEnableTapePressureBias = config.marketMaker.enableTapePressureBias;
  const originalTapePressureWindowMs = config.marketMaker.tapePressureWindowMs;
  const originalTapePressureMinTrades = config.marketMaker.tapePressureMinTrades;
  const originalTapePressureMinTradesPerMinute = config.marketMaker.tapePressureMinTradesPerMinute;
  const originalTapePressureImbalanceThreshold = config.marketMaker.tapePressureImbalanceThreshold;
  const originalTapePressureMaxInwardTicks = config.marketMaker.tapePressureMaxInwardTicks;

  beforeEach(() => {
    (config.marketMaker as { enableTouchQuoteAnchoring: boolean }).enableTouchQuoteAnchoring =
      false;
    (config.marketMaker as { touchBidInwardTicks: number }).touchBidInwardTicks = 1;
    (config.marketMaker as { touchAskInwardTicks: number }).touchAskInwardTicks = 1;
    // 📌 Legacy test setup: tests assert pre-#1/#2 behavior (BUY at bestBid,
    // SELL at bestAsk, any spread accepted). Disable the new bid-推격 / ask-추격
    // guards and spread filter for these tests so the expected prices still match.
    // New behavior is covered by dedicated tests elsewhere.
    (config.marketMaker as { buyMinInwardFromBidTicks: number }).buyMinInwardFromBidTicks = 0;
    (config.marketMaker as { sellMinOutwardFromAskTicks: number }).sellMinOutwardFromAskTicks = 0;
    (config.marketMaker as { minMarketSpreadTicks: number }).minMarketSpreadTicks = 1;
  });

  afterEach(() => {
    (config.marketMaker as { quoteSize: number }).quoteSize = originalQuoteSize;
    (config.marketMaker as { useRewardMinSize: boolean }).useRewardMinSize =
      originalUseRewardMinSize;
    (config.marketMaker as { enableTouchQuoteAnchoring: boolean }).enableTouchQuoteAnchoring =
      originalEnableTouchQuoteAnchoring;
    (config.marketMaker as { touchBidInwardTicks: number }).touchBidInwardTicks =
      originalTouchBidInwardTicks;
    (config.marketMaker as { touchAskInwardTicks: number }).touchAskInwardTicks =
      originalTouchAskInwardTicks;
    (config.marketMaker as { minTopBookLiquidityUsdc: number }).minTopBookLiquidityUsdc =
      originalMinTopBookLiquidityUsdc;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares =
      originalMaxTokenExposureShares;
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias =
      originalEnableRebateBias;
    (config.marketMaker as { enableInventorySkew: boolean }).enableInventorySkew =
      originalEnableInventorySkew;
    (config.marketMaker as { inventorySkewMaxTickOffset: number }).inventorySkewMaxTickOffset =
      originalInventorySkewMaxTickOffset;
    (config.marketMaker as { enableRewardRebateScheduling: boolean }).enableRewardRebateScheduling =
      originalEnableRewardRebateScheduling;
    (config.marketMaker as { rewardSchedulingMaxQuoteSizeMultiplier: number }).rewardSchedulingMaxQuoteSizeMultiplier =
      originalRewardSchedulingMaxQuoteSizeMultiplier;
    (config.marketMaker as { rewardSchedulingRateCapPerDay: number }).rewardSchedulingRateCapPerDay =
      originalRewardSchedulingRateCapPerDay;
    (config.marketMaker as { rebateSchedulingExtraInwardTicks: number }).rebateSchedulingExtraInwardTicks =
      originalRebateSchedulingExtraInwardTicks;
    (config.marketMaker as { rebatePriorityThreshold: number }).rebatePriorityThreshold =
      originalRebatePriorityThreshold;
    (config.marketMaker as { rebateMaxInwardTicks: number }).rebateMaxInwardTicks =
      originalRebateMaxInwardTicks;
    (config.marketMaker as { quoteHalfSpreadTicks: number }).quoteHalfSpreadTicks =
      originalQuoteHalfSpreadTicks;
    (config.marketMaker as { enableFillRateFeedback: boolean }).enableFillRateFeedback =
      originalEnableFillRateFeedback;
    (config.marketMaker as { fillRateFeedbackMinPostedQuotes: number }).fillRateFeedbackMinPostedQuotes =
      originalFillRateFeedbackMinPostedQuotes;
    (config.marketMaker as { fillRateFeedbackTarget: number }).fillRateFeedbackTarget =
      originalFillRateFeedbackTarget;
    (config.marketMaker as { fillRateFeedbackMaxInwardTicks: number }).fillRateFeedbackMaxInwardTicks =
      originalFillRateFeedbackMaxInwardTicks;
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

  it("builds a four-quote market-making plan for a valid binary market", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token"),
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.quotes).toHaveLength(4);
      expect(evaluation.plan.quotes.every((quote) => quote.postOnly)).toBe(true);
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeCloseTo(0.49);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeCloseTo(0.51);
    }
  });

  it("keeps an inventory exit plan alive when top-book liquidity is too thin for new entry", () => {
    (config.marketMaker as { minTopBookLiquidityUsdc: number }).minTopBookLiquidityUsdc = 100;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      {
        ...makeBook("yes-token", 0.49, 0.51),
        bids: [{ price: 0.49, size: 1 }],
        asks: [{ price: 0.51, size: 1 }]
      },
      {
        ...makeBook("no-token", 0.49, 0.51),
        bids: [{ price: 0.49, size: 1 }],
        asks: [{ price: 0.51, size: 1 }]
      },
      undefined,
      new Map<string, TrackedInventoryPosition | undefined>([
        [
          "yes-token",
          {
            tokenId: "yes-token",
            marketScope: baseMarket.slug,
            conditionId: baseMarket.conditionId,
            outcome: "Yes",
            shares: 10,
            totalCostUsdc: 4.9,
            openedAtMs: Date.now()
          }
        ],
        ["no-token", undefined]
      ])
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(
        evaluation.plan.quotes.some(
          (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
        )
      ).toBe(true);
    }
  });

  it("uses the reward minimum size when reward sizing is enabled", () => {
    (config.marketMaker as { quoteSize: number }).quoteSize = 10;
    (config.marketMaker as { useRewardMinSize: boolean }).useRewardMinSize = true;
    const rewardMarket: BinaryMarket = {
      ...baseMarket,
      rewardsMinSize: 25,
      rewardsMaxSpread: 0.02,
      rewardRatePerDay: 5
    };

    const evaluation = evaluateMarketMakerPlan(
      rewardMarket,
      makeBook("yes-token"),
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.quotes.every((quote) => quote.size === 25)).toBe(true);
      expect(evaluation.plan.tokenPlans.every((plan) => plan.rewardEligible)).toBe(true);
    }
  });

  it("scales quote size upward for reward-rich markets when reward scheduling is enabled", () => {
    (config.marketMaker as { quoteSize: number }).quoteSize = 10;
    (config.marketMaker as { useRewardMinSize: boolean }).useRewardMinSize = false;
    (config.marketMaker as { enableRewardRebateScheduling: boolean }).enableRewardRebateScheduling =
      true;
    (config.marketMaker as { rewardSchedulingMaxQuoteSizeMultiplier: number }).rewardSchedulingMaxQuoteSizeMultiplier =
      1.5;
    (config.marketMaker as { rewardSchedulingRateCapPerDay: number }).rewardSchedulingRateCapPerDay =
      3;

    const rewardMarket: BinaryMarket = {
      ...baseMarket,
      rewardsMinSize: 25,
      rewardsMaxSpread: 0.02,
      rewardRatePerDay: 3
    };

    const evaluation = evaluateMarketMakerPlan(
      rewardMarket,
      makeBook("yes-token"),
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.quotes.every((quote) => quote.size === 15)).toBe(true);
    }
  });

  it("tightens quote placement toward the rebate-efficient side in fee-enabled markets", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = true;
    (config.marketMaker as { rebatePriorityThreshold: number }).rebatePriorityThreshold = 0.9;
    (config.marketMaker as { rebateMaxInwardTicks: number }).rebateMaxInwardTicks = 1;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.49, 0.51),
      makeBook("no-token", 0.49, 0.51)
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.tokenPlans[0].rebatePrioritySide).toBe("BUY");
      expect(evaluation.plan.tokenPlans[0].rebateInwardTicks).toBe(1);
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeCloseTo(0.5);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeCloseTo(0.51);
      expect(evaluation.plan.tokenPlans[1].rebatePrioritySide).toBe("SELL");
      expect(evaluation.plan.tokenPlans[1].rebateInwardTicks).toBe(1);
      expect(evaluation.plan.tokenPlans[1].quotes[0].price).toBeCloseTo(0.49);
      expect(evaluation.plan.tokenPlans[1].quotes[1].price).toBeCloseTo(0.5);
    }
  });

  it("skews bid and ask asymmetrically when inventory is concentrated on one outcome", () => {
    (config.marketMaker as { enableInventorySkew: boolean }).enableInventorySkew = true;
    (config.marketMaker as { inventorySkewMaxTickOffset: number }).inventorySkewMaxTickOffset = 2;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 8;
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;

    const inventoryPositionsByTokenId = new Map<string, TrackedInventoryPosition>([
      [
        "yes-token",
        {
          tokenId: "yes-token",
          marketScope: baseMarket.slug,
          conditionId: baseMarket.conditionId,
          outcome: "Yes",
          shares: 8,
          totalCostUsdc: 3.92,
          openedAtMs: Date.now() - 60_000
        }
      ]
    ]);

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token"),
      makeBook("no-token"),
      undefined,
      inventoryPositionsByTokenId
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      const yesPlan = evaluation.plan.tokenPlans[0];
      const noPlan = evaluation.plan.tokenPlans[1];

      expect(yesPlan.inventorySkewRatio).toBeCloseTo(1);
      expect(yesPlan.inventoryBuyAdjustmentTicks).toBe(-2);
      expect(yesPlan.inventorySellAdjustmentTicks).toBe(2);
      expect(yesPlan.quotes[0].price).toBeCloseTo(0.47);
      expect(yesPlan.quotes[1].price).toBeCloseTo(0.5);

      expect(noPlan.inventorySkewRatio).toBeCloseTo(-1);
      expect(noPlan.inventoryBuyAdjustmentTicks).toBe(2);
      expect(noPlan.inventorySellAdjustmentTicks).toBe(-2);
      expect(noPlan.quotes[0].price).toBeCloseTo(0.5);
      expect(noPlan.quotes[1].price).toBeCloseTo(0.53);
    }
  });

  it("leans the BUY quote inward when recent tape shows sustained aggressive buying", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;
    (config.marketMaker as { enableInventorySkew: boolean }).enableInventorySkew = false;
    (config.marketMaker as { enableFillRateFeedback: boolean }).enableFillRateFeedback = false;
    (config.marketMaker as { enableTapePressureBias: boolean }).enableTapePressureBias = true;
    (config.marketMaker as { tapePressureMaxInwardTicks: number }).tapePressureMaxInwardTicks = 1;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      {
        ...makeBook("yes-token"),
        tapePressure: {
          windowMs: 60_000,
          recentTradeCount: 6,
          buyTradeCount: 6,
          sellTradeCount: 0,
          buyVolume: 60,
          sellVolume: 0,
          tradesPerMinute: 12,
          signedTradeImbalance: 1,
          signedVolumeImbalance: 1,
          pressureScore: 1,
          biasTicks: 1,
          dominantSide: "BUY",
          lastTradeSide: "BUY"
        }
      },
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      const yesPlan = evaluation.plan.tokenPlans[0];
      expect(yesPlan.tapePressureBiasSide).toBe(Side.BUY);
      expect(yesPlan.tapePressureBiasTicks).toBe(1);
      expect(yesPlan.quotes[0].price).toBeCloseTo(0.5);
      expect(yesPlan.quotes[1].price).toBeCloseTo(0.51);
    }
  });

  it("leans the SELL quote inward when recent tape shows sustained aggressive selling", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;
    (config.marketMaker as { enableInventorySkew: boolean }).enableInventorySkew = false;
    (config.marketMaker as { enableFillRateFeedback: boolean }).enableFillRateFeedback = false;
    (config.marketMaker as { enableTapePressureBias: boolean }).enableTapePressureBias = true;
    (config.marketMaker as { tapePressureMaxInwardTicks: number }).tapePressureMaxInwardTicks = 1;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      {
        ...makeBook("yes-token"),
        tapePressure: {
          windowMs: 60_000,
          recentTradeCount: 6,
          buyTradeCount: 0,
          sellTradeCount: 6,
          buyVolume: 0,
          sellVolume: 60,
          tradesPerMinute: 12,
          signedTradeImbalance: -1,
          signedVolumeImbalance: -1,
          pressureScore: -1,
          biasTicks: -1,
          dominantSide: "SELL",
          lastTradeSide: "SELL"
        }
      },
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      const yesPlan = evaluation.plan.tokenPlans[0];
      expect(yesPlan.tapePressureBiasSide).toBe(Side.SELL);
      expect(yesPlan.tapePressureBiasTicks).toBe(1);
      expect(yesPlan.quotes[0].price).toBeCloseTo(0.49);
      expect(yesPlan.quotes[1].price).toBeCloseTo(0.5);
    }
  });

  it("applies extra inward ticks on the rebate-priority side when reward/rebate scheduling is enabled", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = true;
    (config.marketMaker as { enableRewardRebateScheduling: boolean }).enableRewardRebateScheduling =
      true;
    (config.marketMaker as { rebatePriorityThreshold: number }).rebatePriorityThreshold = 0.9;
    (config.marketMaker as { rebateMaxInwardTicks: number }).rebateMaxInwardTicks = 1;
    (config.marketMaker as { rebateSchedulingExtraInwardTicks: number }).rebateSchedulingExtraInwardTicks =
      1;
    (config.marketMaker as { quoteHalfSpreadTicks: number }).quoteHalfSpreadTicks = 2;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.45, 0.55),
      makeBook("no-token", 0.45, 0.55)
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.tokenPlans[0].rebatePrioritySide).toBe("BUY");
      expect(evaluation.plan.tokenPlans[0].rebateInwardTicks).toBe(2);
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeCloseTo(0.5);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeCloseTo(0.52);
      expect(evaluation.plan.tokenPlans[1].rebatePrioritySide).toBe("SELL");
      expect(evaluation.plan.tokenPlans[1].rebateInwardTicks).toBe(2);
      expect(evaluation.plan.tokenPlans[1].quotes[0].price).toBeCloseTo(0.48);
      expect(evaluation.plan.tokenPlans[1].quotes[1].price).toBeCloseTo(0.5);
    }
  });

  it("tightens both passive quotes when recent fill rate is weak", () => {
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;
    (config.marketMaker as { enableFillRateFeedback: boolean }).enableFillRateFeedback = true;
    (config.marketMaker as { fillRateFeedbackMinPostedQuotes: number }).fillRateFeedbackMinPostedQuotes =
      4;
    (config.marketMaker as { fillRateFeedbackTarget: number }).fillRateFeedbackTarget = 0.5;
    (config.marketMaker as { fillRateFeedbackMaxInwardTicks: number }).fillRateFeedbackMaxInwardTicks =
      1;
    (config.marketMaker as { quoteHalfSpreadTicks: number }).quoteHalfSpreadTicks = 2;

    const fillRateFeedback: MarketMakerFillRateFeedback = {
      postedQuoteCount: 4,
      filledQuoteCount: 0,
      fillRate: 0,
      inwardTicks: 1
    };

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.45, 0.55),
      makeBook("no-token", 0.45, 0.55),
      undefined,
      undefined,
      fillRateFeedback
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.fillRateFeedback?.fillRate).toBe(0);
      expect(evaluation.plan.tokenPlans[0].fillRateFeedbackInwardTicks).toBe(1);
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeCloseTo(0.49);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeCloseTo(0.51);
    }
  });

  it("rejects markets whose spread is tighter than the configured minimum", () => {
    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.499, 0.501),
      makeBook("no-token")
    );

    expect(evaluation.status).toBe("rejected");

    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("spread_too_tight");
    }
  });

  it("rejects stale books", () => {
    const now = Date.now();
    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.49, 0.51, now - (config.strategy.maxBookStalenessMs + 1_000)),
      makeBook("no-token", 0.49, 0.51, now)
    );

    expect(evaluation.status).toBe("rejected");

    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("stale_book");
    }
  });

  it("applies degraded execution throttles to quote size and half-spread", () => {
    (config.marketMaker as { quoteSize: number }).quoteSize = 25;
    (config.marketMaker as { enableRewardRebateScheduling: boolean }).enableRewardRebateScheduling =
      false;
    const throttle: RiskExecutionThrottleSnapshot = {
      state: "DEGRADED",
      stressScore: 0.5,
      dominantReason: "daily_loss",
      reasonScores: {
        dailyLoss: 0.5,
        consecutiveLosses: 0.25,
        apiErrors: 0,
        orderFailures: 0,
        stateMismatches: 0
      },
      quoteSizeMultiplier: 0.6,
      quoteHalfSpreadTicksMultiplier: 2,
      signalCooldownMultiplier: 1.5,
      executionCooldownMultiplier: 2
    };

    const normalEvaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.45, 0.55),
      makeBook("no-token", 0.45, 0.55)
    );
    const throttledEvaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.45, 0.55),
      makeBook("no-token", 0.45, 0.55),
      throttle
    );

    expect(normalEvaluation.status).toBe("ready");
    expect(throttledEvaluation.status).toBe("ready");

    if (normalEvaluation.status === "ready" && throttledEvaluation.status === "ready") {
      expect(throttledEvaluation.plan.executionThrottle).toEqual(
        expect.objectContaining({
          state: "DEGRADED",
          dominantReason: "daily_loss",
          quoteSizeMultiplier: 0.6,
          quoteHalfSpreadTicksMultiplier: 2
        })
      );
      expect(throttledEvaluation.plan.quotes.every((quote) => quote.size === 15)).toBe(true);
      expect(throttledEvaluation.plan.tokenPlans[0].quotes[0].price).toBeLessThan(
        normalEvaluation.plan.tokenPlans[0].quotes[0].price
      );
      expect(throttledEvaluation.plan.tokenPlans[0].quotes[1].price).toBeGreaterThan(
        normalEvaluation.plan.tokenPlans[0].quotes[1].price
      );
    }
  });

  it("anchors maker quotes near top-of-book when touch anchoring is enabled", () => {
    (config.marketMaker as { enableTouchQuoteAnchoring: boolean }).enableTouchQuoteAnchoring =
      true;
    (config.marketMaker as { touchBidInwardTicks: number }).touchBidInwardTicks = 1;
    (config.marketMaker as { touchAskInwardTicks: number }).touchAskInwardTicks = 1;
    (config.marketMaker as { enableRebateBias: boolean }).enableRebateBias = false;
    (config.marketMaker as { quoteHalfSpreadTicks: number }).quoteHalfSpreadTicks = 3;

    const evaluation = evaluateMarketMakerPlan(
      baseMarket,
      makeBook("yes-token", 0.45, 0.55),
      makeBook("no-token", 0.45, 0.55)
    );

    expect(evaluation.status).toBe("ready");

    if (evaluation.status === "ready") {
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeGreaterThanOrEqual(0.45);
      expect(evaluation.plan.tokenPlans[0].quotes[0].price).toBeLessThanOrEqual(0.46);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeGreaterThanOrEqual(0.54);
      expect(evaluation.plan.tokenPlans[0].quotes[1].price).toBeLessThanOrEqual(0.55);
    }
  });
});
