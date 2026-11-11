import { OrderType, Side } from "@polymarket/clob-client-v2";
import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  applyAgeBasedUnwindToMarketMakerPlan,
  applyInventoryExitGuardToMarketMakerPlan,
  applyMaxHoldHardExitToMarketMakerPlan,
  applyNetPairExitToMarketMakerPlan,
  applyOneSideInventoryHardGateToMarketMakerPlan,
  applyOneSideFillResponseToMarketMakerPlan,
  applyPassiveToAggressiveTransitionToMarketMakerPlan,
  buildMarketMakerPairInventoryState,
  applyTakeProfitToMarketMakerPlan,
  activeQuoteToActiveOrder,
  buildRetainedMarketMakingIntents,
  buildMarketMakingIntents,
  filterMarketMakerPlanByBuySuppression,
  filterMarketMakerPlanByPassiveBuyPriceBand,
  filterMarketMakerPlanByApprovedIntents,
  filterMarketMakerPlanBySellRepostCooldown,
  filterMarketMakerPlanByTrackedInventory,
  expandSellQuotesToLayers,
  resolveMarketMakerMaxHoldHardExitState,
  resolveMarketMakerOneSideFillResponseState,
  resolveMarketMakerNetPairExitMode,
  resolveBoundedLossExitPriceForPosition,
  resolveMinimumExitPriceForPosition
} from "../src/core/market-making-intents.js";
import type { RejectedIntent } from "../src/core/types.js";
import type { MarketMakerPlan } from "../src/strategy/market-maker.js";
import type { BinaryMarket } from "../src/types.js";

const market: BinaryMarket = {
  id: "market-1",
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

const plan: MarketMakerPlan = {
  market,
  generatedAtMs: 1,
  rewardActive: true,
  tokenPlans: [
    {
      tokenId: "yes-token",
      outcome: "Yes",
      midpoint: 0.5,
      bestBid: 0.49,
      bestAsk: 0.51,
      observedSpread: 0.02,
      observedSpreadTicks: 2,
      topBookLiquidityUsdc: 10_000,
      rewardEligible: true,
      rebateEfficiencyScore: 1,
      rebatePrioritySide: Side.BUY,
      rebateInwardTicks: 1,
      quotes: [
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.BUY,
          price: 0.49,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "yes-token",
          outcome: "Yes",
          side: Side.SELL,
          price: 0.51,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    },
    {
      tokenId: "no-token",
      outcome: "No",
      midpoint: 0.5,
      bestBid: 0.49,
      bestAsk: 0.51,
      observedSpread: 0.02,
      observedSpreadTicks: 2,
      topBookLiquidityUsdc: 10_000,
      rewardEligible: true,
      rebateEfficiencyScore: 1,
      rebatePrioritySide: Side.SELL,
      rebateInwardTicks: 1,
      quotes: [
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.BUY,
          price: 0.49,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        },
        {
          tokenId: "no-token",
          outcome: "No",
          side: Side.SELL,
          price: 0.51,
          size: 25,
          tickSize: 0.01,
          postOnly: true,
          orderType: OrderType.GTC
        }
      ]
    }
  ],
  quotes: [
    {
      tokenId: "yes-token",
      outcome: "Yes",
      side: Side.BUY,
      price: 0.49,
      size: 25,
      tickSize: 0.01,
      postOnly: true,
      orderType: OrderType.GTC
    },
    {
      tokenId: "yes-token",
      outcome: "Yes",
      side: Side.SELL,
      price: 0.51,
      size: 25,
      tickSize: 0.01,
      postOnly: true,
      orderType: OrderType.GTC
    },
    {
      tokenId: "no-token",
      outcome: "No",
      side: Side.BUY,
      price: 0.49,
      size: 25,
      tickSize: 0.01,
      postOnly: true,
      orderType: OrderType.GTC
    },
    {
      tokenId: "no-token",
      outcome: "No",
      side: Side.SELL,
      price: 0.51,
      size: 25,
      tickSize: 0.01,
      postOnly: true,
      orderType: OrderType.GTC
    }
  ]
};

describe("market-making intent adapters", () => {
  const originalEnableTakeProfitUnwind = config.marketMaker.enableTakeProfitUnwind;
  const originalEnableNetPairExit = config.marketMaker.enableNetPairExit;
  const originalEnableOneSideFillResponse = config.marketMaker.enableOneSideFillResponse;
  const originalOneSideFillMinImbalanceShares = config.marketMaker.oneSideFillMinImbalanceShares;
  const originalOneSideFillUnwindAfterMs = config.marketMaker.oneSideFillUnwindAfterMs;
  const originalOneSideFillRebalanceOpposingBuyInwardTicks =
    config.marketMaker.oneSideFillRebalanceOpposingBuyInwardTicks;
  const originalOneSideFillRebalanceFilledBuyOutwardTicks =
    config.marketMaker.oneSideFillRebalanceFilledBuyOutwardTicks;
  const originalOneSideFillRebalanceFilledSellInwardTicks =
    config.marketMaker.oneSideFillRebalanceFilledSellInwardTicks;
  const originalOneSideFillUnwindSellInwardTicks =
    config.marketMaker.oneSideFillUnwindSellInwardTicks;
  const originalOneSideFillAggressiveExitAfterMs =
    config.marketMaker.oneSideFillAggressiveExitAfterMs;
  const originalOneSideFillAggressiveExitMinChunkShares =
    config.marketMaker.oneSideFillAggressiveExitMinChunkShares;
  const originalOneSideFillAggressiveExitMaxChunkShares =
    config.marketMaker.oneSideFillAggressiveExitMaxChunkShares;
  const originalOneSideFillAggressiveExitChunkRatio =
    config.marketMaker.oneSideFillAggressiveExitChunkRatio;
  const originalOneSideFillAggressiveExitRepriceAfterRejects =
    config.marketMaker.oneSideFillAggressiveExitRepriceAfterRejects;
  const originalOneSideFillAggressiveExitRejectPriceConcessionTicks =
    config.marketMaker.oneSideFillAggressiveExitRejectPriceConcessionTicks;
  const originalOneSideFillAggressiveExitRejectSizeMultiplier =
    config.marketMaker.oneSideFillAggressiveExitRejectSizeMultiplier;
  const originalOneSideFillStopMaxLossBps =
    config.marketMaker.oneSideFillStopMaxLossBps;
  const originalOneSideFillUnwindSuppressFilledBuy =
    config.marketMaker.oneSideFillUnwindSuppressFilledBuy;
  const originalOneSideInventoryHardGateRatio =
    config.marketMaker.oneSideInventoryHardGateRatio;
  const originalNetPairTakeProfitMinPnlUsdc = config.marketMaker.netPairTakeProfitMinPnlUsdc;
  const originalNetPairStopMaxLossUsdc = config.marketMaker.netPairStopMaxLossUsdc;
  const originalNetPairTakeProfitMinEdgeBps = config.marketMaker.netPairTakeProfitMinEdgeBps;
  const originalNetPairStopMaxLossBps = config.marketMaker.netPairStopMaxLossBps;
  const originalNetPairSpreadCollapseMaxObservedSpreadTicks =
    config.marketMaker.netPairSpreadCollapseMaxObservedSpreadTicks;
  const originalTakeProfitMinPnlUsdc = config.marketMaker.takeProfitMinPnlUsdc;
  const originalTakeProfitMinEdgeBps = config.marketMaker.takeProfitMinEdgeBps;
  const originalEnableAgeBasedUnwind = config.marketMaker.enableAgeBasedUnwind;
  const originalAgeBasedUnwindAfterMs = config.marketMaker.ageBasedUnwindAfterMs;
  const originalAgeBasedUnwindStepMs = config.marketMaker.ageBasedUnwindStepMs;
  const originalAgeBasedUnwindMaxInwardTicks = config.marketMaker.ageBasedUnwindMaxInwardTicks;
  const originalEnableStaleBreakEvenUnwind = config.marketMaker.enableStaleBreakEvenUnwind;
  const originalStaleBreakEvenUnwindAfterMs =
    config.marketMaker.staleBreakEvenUnwindAfterMs;
  const originalStaleBreakEvenUnwindMinEdgeBps =
    config.marketMaker.staleBreakEvenUnwindMinEdgeBps;
  const originalEnableMaxHoldHardExit = config.marketMaker.enableMaxHoldHardExit;
  const originalMaxHoldHardExitAfterMs = config.marketMaker.maxHoldHardExitAfterMs;
  const originalMaxHoldHardExitSuppressBuys = config.marketMaker.maxHoldHardExitSuppressBuys;
  const originalExitMinSpreadTicks = config.marketMaker.exitMinSpreadTicks;
  const originalExitMinProfitTicks = config.marketMaker.exitMinProfitTicks;
  const originalBreakEvenExitAfterMs = config.marketMaker.breakEvenExitAfterMs;
  const originalBreakEvenExitMaxLossTicks = config.marketMaker.breakEvenExitMaxLossTicks;
  const originalConditionalExitMaxLossBps = config.marketMaker.conditionalExitMaxLossBps;
  const originalConditionalExitOverweightRatio = config.marketMaker.conditionalExitOverweightRatio;
  const originalMaxTokenExposureShares = config.marketMaker.maxTokenExposureShares;
  const originalEnablePassiveToAggressiveTransition =
    config.marketMaker.enablePassiveToAggressiveTransition;
  const originalPassiveToAggressiveAfterMs = config.marketMaker.passiveToAggressiveAfterMs;
  const originalPassiveToAggressivePriceBufferTicks =
    config.marketMaker.passiveToAggressivePriceBufferTicks;
  const originalMinPassiveBuyPrice = config.marketMaker.minPassiveBuyPrice;
  const originalMaxPassiveBuyPrice = config.marketMaker.maxPassiveBuyPrice;

  afterEach(() => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind =
      originalEnableTakeProfitUnwind;
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit =
      originalEnableNetPairExit;
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse =
      originalEnableOneSideFillResponse;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      originalOneSideFillMinImbalanceShares;
    (config.marketMaker as { oneSideFillUnwindAfterMs: number }).oneSideFillUnwindAfterMs =
      originalOneSideFillUnwindAfterMs;
    (config.marketMaker as { oneSideFillRebalanceOpposingBuyInwardTicks: number }).oneSideFillRebalanceOpposingBuyInwardTicks =
      originalOneSideFillRebalanceOpposingBuyInwardTicks;
    (config.marketMaker as { oneSideFillRebalanceFilledBuyOutwardTicks: number }).oneSideFillRebalanceFilledBuyOutwardTicks =
      originalOneSideFillRebalanceFilledBuyOutwardTicks;
    (config.marketMaker as { oneSideFillRebalanceFilledSellInwardTicks: number }).oneSideFillRebalanceFilledSellInwardTicks =
      originalOneSideFillRebalanceFilledSellInwardTicks;
    (config.marketMaker as { oneSideFillUnwindSellInwardTicks: number }).oneSideFillUnwindSellInwardTicks =
      originalOneSideFillUnwindSellInwardTicks;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      originalOneSideFillAggressiveExitAfterMs;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      originalOneSideFillAggressiveExitMinChunkShares;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      originalOneSideFillAggressiveExitMaxChunkShares;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      originalOneSideFillAggressiveExitChunkRatio;
    (config.marketMaker as { oneSideFillAggressiveExitRepriceAfterRejects: number }).oneSideFillAggressiveExitRepriceAfterRejects =
      originalOneSideFillAggressiveExitRepriceAfterRejects;
    (config.marketMaker as { oneSideFillAggressiveExitRejectPriceConcessionTicks: number }).oneSideFillAggressiveExitRejectPriceConcessionTicks =
      originalOneSideFillAggressiveExitRejectPriceConcessionTicks;
    (config.marketMaker as { oneSideFillAggressiveExitRejectSizeMultiplier: number }).oneSideFillAggressiveExitRejectSizeMultiplier =
      originalOneSideFillAggressiveExitRejectSizeMultiplier;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      originalOneSideFillStopMaxLossBps;
    (config.marketMaker as { oneSideFillUnwindSuppressFilledBuy: boolean }).oneSideFillUnwindSuppressFilledBuy =
      originalOneSideFillUnwindSuppressFilledBuy;
    (config.marketMaker as { oneSideInventoryHardGateRatio: number }).oneSideInventoryHardGateRatio =
      originalOneSideInventoryHardGateRatio;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      originalNetPairTakeProfitMinPnlUsdc;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc =
      originalNetPairStopMaxLossUsdc;
    (
      config.marketMaker as {
        netPairTakeProfitMinEdgeBps: number | undefined;
      }
    ).netPairTakeProfitMinEdgeBps = originalNetPairTakeProfitMinEdgeBps;
    (
      config.marketMaker as {
        netPairStopMaxLossBps: number | undefined;
      }
    ).netPairStopMaxLossBps = originalNetPairStopMaxLossBps;
    (config.marketMaker as { netPairSpreadCollapseMaxObservedSpreadTicks: number }).netPairSpreadCollapseMaxObservedSpreadTicks =
      originalNetPairSpreadCollapseMaxObservedSpreadTicks;
    (config.marketMaker as { takeProfitMinPnlUsdc: number }).takeProfitMinPnlUsdc =
      originalTakeProfitMinPnlUsdc;
    (config.marketMaker as { takeProfitMinEdgeBps: number }).takeProfitMinEdgeBps =
      originalTakeProfitMinEdgeBps;
    (config.marketMaker as { enableAgeBasedUnwind: boolean }).enableAgeBasedUnwind =
      originalEnableAgeBasedUnwind;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs =
      originalAgeBasedUnwindAfterMs;
    (config.marketMaker as { ageBasedUnwindStepMs: number }).ageBasedUnwindStepMs =
      originalAgeBasedUnwindStepMs;
    (config.marketMaker as { ageBasedUnwindMaxInwardTicks: number }).ageBasedUnwindMaxInwardTicks =
      originalAgeBasedUnwindMaxInwardTicks;
    (config.marketMaker as { enableStaleBreakEvenUnwind: boolean }).enableStaleBreakEvenUnwind =
      originalEnableStaleBreakEvenUnwind;
    (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
      originalStaleBreakEvenUnwindAfterMs;
    (config.marketMaker as { staleBreakEvenUnwindMinEdgeBps: number }).staleBreakEvenUnwindMinEdgeBps =
      originalStaleBreakEvenUnwindMinEdgeBps;
    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit =
      originalEnableMaxHoldHardExit;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs =
      originalMaxHoldHardExitAfterMs;
    (config.marketMaker as { maxHoldHardExitSuppressBuys: boolean }).maxHoldHardExitSuppressBuys =
      originalMaxHoldHardExitSuppressBuys;
    (config.marketMaker as { exitMinSpreadTicks: number }).exitMinSpreadTicks =
      originalExitMinSpreadTicks;
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks =
      originalExitMinProfitTicks;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs =
      originalBreakEvenExitAfterMs;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks =
      originalBreakEvenExitMaxLossTicks;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps =
      originalConditionalExitMaxLossBps;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      originalConditionalExitOverweightRatio;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares =
      originalMaxTokenExposureShares;
    (config.marketMaker as { enablePassiveToAggressiveTransition: boolean }).enablePassiveToAggressiveTransition =
      originalEnablePassiveToAggressiveTransition;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      originalPassiveToAggressiveAfterMs;
    (config.marketMaker as { passiveToAggressivePriceBufferTicks: number }).passiveToAggressivePriceBufferTicks =
      originalPassiveToAggressivePriceBufferTicks;
    (config.marketMaker as { minPassiveBuyPrice: number }).minPassiveBuyPrice =
      originalMinPassiveBuyPrice;
    (config.marketMaker as { maxPassiveBuyPrice: number }).maxPassiveBuyPrice =
      originalMaxPassiveBuyPrice;
  });

  it("builds one order intent per quote", () => {
    const intents = buildMarketMakingIntents(plan);

    expect(intents).toHaveLength(4);
    expect(intents[0]?.strategy).toBe("market-making");
    expect(intents[0]?.conditionId).toBe(plan.market.conditionId);
    expect(intents.every((intent) => intent.tags.includes("market-making"))).toBe(true);
  });

  it("suppresses only passive BUY quotes outside the configured entry price band", () => {
    (config.marketMaker as { minPassiveBuyPrice: number }).minPassiveBuyPrice = 0.18;
    (config.marketMaker as { maxPassiveBuyPrice: number }).maxPassiveBuyPrice = 0.82;

    const edgePlan: MarketMakerPlan = {
      ...plan,
      tokenPlans: [
        {
          ...plan.tokenPlans[0],
          bestBid: 0.85,
          bestAsk: 0.87,
          quotes: [
            { ...plan.tokenPlans[0].quotes[0], price: 0.86 },
            { ...plan.tokenPlans[0].quotes[1], price: 0.87 }
          ]
        },
        {
          ...plan.tokenPlans[1],
          bestBid: 0.13,
          bestAsk: 0.15,
          quotes: [
            { ...plan.tokenPlans[1].quotes[0], price: 0.14 },
            { ...plan.tokenPlans[1].quotes[1], price: 0.15 }
          ]
        }
      ],
      quotes: [
        { ...plan.tokenPlans[0].quotes[0], price: 0.86 },
        { ...plan.tokenPlans[0].quotes[1], price: 0.87 },
        { ...plan.tokenPlans[1].quotes[0], price: 0.14 },
        { ...plan.tokenPlans[1].quotes[1], price: 0.15 }
      ]
    };

    const filtered = filterMarketMakerPlanByPassiveBuyPriceBand(edgePlan);

    expect(filtered.quotes).toHaveLength(2);
    expect(filtered.quotes.every((quote) => quote.side === Side.SELL)).toBe(true);
  });

  it("filters a plan down to approved quote intents", () => {
    const intents = buildMarketMakingIntents(plan);
    const filteredPlan = filterMarketMakerPlanByApprovedIntents(plan, [
      intents[0]!,
      intents[3]!
    ]);

    expect(filteredPlan.quotes).toHaveLength(2);
    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:BUY",
      "no-token:SELL"
    ]);
  });

  it("retains quotes whose matching active orders already satisfy the intent", () => {
    const intents = buildMarketMakingIntents(plan);
    const retained = buildRetainedMarketMakingIntents(
      [],
      [
        {
          intent: intents[0]!,
          reason: "active_order_already_matches",
          detail: "Active order already matches."
        } satisfies RejectedIntent
      ]
    );

    const filteredPlan = filterMarketMakerPlanByApprovedIntents(plan, retained);

    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:BUY"
    ]);
  });

  it("preserves multiple approved SELL intents on the same token when they use distinct quote slots", () => {
    const ladderPlan: MarketMakerPlan = {
      ...plan,
      quotes: [
        ...plan.quotes,
        {
          ...plan.quotes[1]!,
          size: 2,
          postOnly: false,
          executionStyle: "one-side-aggressive-exit",
          quoteSlot: "one-side-aggressive-exit:1"
        },
        {
          ...plan.quotes[1]!,
          size: 2,
          postOnly: false,
          executionStyle: "one-side-aggressive-exit",
          quoteSlot: "one-side-aggressive-exit:2"
        },
        {
          ...plan.quotes[1]!,
          size: 4,
          postOnly: false,
          executionStyle: "one-side-aggressive-exit",
          quoteSlot: "one-side-aggressive-exit:3"
        }
      ]
    };

    const intents = buildMarketMakingIntents(ladderPlan);
    const filteredPlan = filterMarketMakerPlanByApprovedIntents(
      ladderPlan,
      intents.filter((intent) => intent.tokenId === "yes-token" && intent.side === Side.SELL)
    );

    expect(
      filteredPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => quote.quoteSlot)
    ).toEqual([
      undefined,
      "one-side-aggressive-exit:1",
      "one-side-aggressive-exit:2",
      "one-side-aggressive-exit:3"
    ]);
  });

  it("suppresses sell quotes when tracked inventory is unavailable", () => {
    const filteredPlan = filterMarketMakerPlanByTrackedInventory(plan, (tokenId) =>
      tokenId === "yes-token" ? 25 : 0
    );

    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:BUY",
      "yes-token:SELL",
      "no-token:BUY"
    ]);
  });

  it("expands a single passive SELL quote to cover the full tracked inventory", () => {
    const filteredPlan = filterMarketMakerPlanByTrackedInventory(plan, (tokenId) =>
      tokenId === "yes-token" ? 39.264 : 25
    );

    expect(
      filteredPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )
    ).toMatchObject({
      size: 39.264
    });
  });

  it("drops residual SELL layers that would fall below the venue minimum size", () => {
    const guardedMarket: BinaryMarket = {
      ...market,
      orderMinSize: 5
    };
    const layeredPlan: MarketMakerPlan = {
      ...plan,
      market: guardedMarket,
      quotes: [
        plan.quotes[0]!,
        {
          ...plan.quotes[1]!,
          size: 5,
          quoteSlot: "sell-layer-0"
        },
        {
          ...plan.quotes[1]!,
          size: 5,
          quoteSlot: "sell-layer-1"
        },
        plan.quotes[2]!,
        plan.quotes[3]!
      ]
    };

    const filteredPlan = filterMarketMakerPlanByTrackedInventory(layeredPlan, (tokenId) =>
      tokenId === "yes-token" ? 6 : 25
    );

    expect(
      filteredPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({
          quoteSlot: quote.quoteSlot,
          size: quote.size
        }))
    ).toEqual([
      {
        quoteSlot: "sell-layer-0",
        size: 5
      }
    ]);
  });

  it("suppresses sell quotes during the recent sell-fill repost cooldown", () => {
    const filteredPlan = filterMarketMakerPlanBySellRepostCooldown(
      plan,
      (tokenId) => tokenId === "no-token"
    );

    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:BUY",
      "yes-token:SELL",
      "no-token:BUY"
    ]);
  });

  it("suppresses sell quotes during the immediate post-buy settlement cooldown", () => {
    const filteredPlan = filterMarketMakerPlanBySellRepostCooldown(
      plan,
      (tokenId) => tokenId === "yes-token"
    );

    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:BUY",
      "no-token:BUY",
      "no-token:SELL"
    ]);
  });

  it("suppresses BUY quotes when a condition is inside the post-risk-reduction reentry cooldown", () => {
    const filteredPlan = filterMarketMakerPlanByBuySuppression(
      plan,
      (tokenId) => tokenId === "yes-token" || tokenId === "no-token"
    );

    expect(filteredPlan.quotes.map((quote) => `${quote.tokenId}:${quote.side}`)).toEqual([
      "yes-token:SELL",
      "no-token:SELL"
    ]);
  });

  it("tightens profitable SELL quotes to realize inventory sooner", () => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind = true;
    (config.marketMaker as { takeProfitMinPnlUsdc: number }).takeProfitMinPnlUsdc = 0.05;
    (config.marketMaker as { takeProfitMinEdgeBps: number }).takeProfitMinEdgeBps = 100;

    const adjustedPlan = applyTakeProfitToMarketMakerPlan(plan, (tokenId) =>
      tokenId === "yes-token"
        ? {
            tokenId,
            marketScope: plan.market.slug,
            conditionId: plan.market.conditionId,
            outcome: "Yes",
            shares: 25,
            totalCostUsdc: 11.25,
            openedAtMs: 1
          }
        : undefined
    );

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );
    const untouchedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "no-token" && quote.side === Side.SELL
    );

    expect(adjustedSellQuote?.price).toBe(0.5);
    expect(untouchedSellQuote?.price).toBe(0.51);
  });

  it("tightens profitable SELL quotes even when held shares are below the standard quote size", () => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind = true;
    (config.marketMaker as { takeProfitMinPnlUsdc: number }).takeProfitMinPnlUsdc = 0.05;
    (config.marketMaker as { takeProfitMinEdgeBps: number }).takeProfitMinEdgeBps = 100;

    const adjustedPlan = applyTakeProfitToMarketMakerPlan(plan, (tokenId) =>
      tokenId === "yes-token"
        ? {
            tokenId,
            marketScope: plan.market.slug,
            conditionId: plan.market.conditionId,
            outcome: "Yes",
            shares: 8,
            totalCostUsdc: 3.6,
            openedAtMs: 1
          }
        : undefined
    );

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );

    expect(adjustedSellQuote?.price).toBe(0.5);
  });

  it("builds a net pair inventory view across complementary YES/NO holdings", () => {
    const pairState = buildMarketMakerPairInventoryState(plan, (tokenId) => {
      if (tokenId === "yes-token") {
        return {
          tokenId,
          marketScope: plan.market.slug,
          conditionId: plan.market.conditionId,
          outcome: "Yes",
          shares: 8,
          totalCostUsdc: 3.6,
          openedAtMs: 1
        };
      }

      if (tokenId === "no-token") {
        return {
          tokenId,
          marketScope: plan.market.slug,
          conditionId: plan.market.conditionId,
          outcome: "No",
          shares: 8,
          totalCostUsdc: 4.32,
          openedAtMs: 1
        };
      }

      return undefined;
    });

    expect(pairState).toBeDefined();
    expect(pairState?.matchedShares).toBe(8);
    expect(pairState?.totalCostUsdc).toBeCloseTo(7.92);
    expect(pairState?.totalMarkValueUsdc).toBeCloseTo(7.84);
    expect(pairState?.totalNetPnlUsdc).toBeCloseTo(-0.08);
    expect(pairState?.matchedNetEdgeBps).toBeCloseTo((-0.08 / 7.92) * 10_000, 4);
  });

  it("tightens both passive SELL quotes when the matched pair net PnL reaches take-profit", () => {
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit = true;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      0.05;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc = 0.5;
    (
      config.marketMaker as {
        netPairTakeProfitMinEdgeBps: number | undefined;
      }
    ).netPairTakeProfitMinEdgeBps = undefined;
    (
      config.marketMaker as {
        netPairStopMaxLossBps: number | undefined;
      }
    ).netPairStopMaxLossBps = undefined;
    (config.marketMaker as { netPairSpreadCollapseMaxObservedSpreadTicks: number }).netPairSpreadCollapseMaxObservedSpreadTicks =
      1;

    const pairState = buildMarketMakerPairInventoryState(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 11.25,
      openedAtMs: 1
    }));

    expect(resolveMarketMakerNetPairExitMode(plan, pairState)).toBe("take-profit");

    const adjustedPlan = applyNetPairExitToMarketMakerPlan(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 11.25,
      openedAtMs: 1
    }));

    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.side === Side.SELL)
        .map((quote) => quote.price)
    ).toEqual([0.5, 0.5]);
  });

  it("triggers net pair take-profit from edge bps even before the USDC take-profit floor is reached", () => {
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit = true;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      0.5;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc = 1;
    (
      config.marketMaker as {
        netPairTakeProfitMinEdgeBps: number | undefined;
      }
    ).netPairTakeProfitMinEdgeBps = 30;
    (
      config.marketMaker as {
        netPairStopMaxLossBps: number | undefined;
      }
    ).netPairStopMaxLossBps = undefined;
    (config.marketMaker as { netPairSpreadCollapseMaxObservedSpreadTicks: number }).netPairSpreadCollapseMaxObservedSpreadTicks =
      1;

    const pairState = buildMarketMakerPairInventoryState(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 12.2,
      openedAtMs: 1
    }));

    expect(pairState?.matchedNetPnlUsdc).toBeCloseTo(0.1);
    expect(pairState?.matchedNetEdgeBps).toBeGreaterThan(30);
    expect(resolveMarketMakerNetPairExitMode(plan, pairState)).toBe("take-profit");
  });

  it("tightens both passive SELL quotes when the matched pair net PnL breaches stop-loss", () => {
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit = true;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      0.5;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc = 0.05;
    (
      config.marketMaker as {
        netPairTakeProfitMinEdgeBps: number | undefined;
      }
    ).netPairTakeProfitMinEdgeBps = undefined;
    (
      config.marketMaker as {
        netPairStopMaxLossBps: number | undefined;
      }
    ).netPairStopMaxLossBps = undefined;

    const adjustedPlan = applyNetPairExitToMarketMakerPlan(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 13.75,
      openedAtMs: 1
    }));

    // Net-pair exit still tightens the SELL quotes, but the absolute profit
    // floor (avgCost 0.55 + 1 tick = 0.56) clamps them back up — the operator
    // forbade sub-cost sells even under net-pair stop-loss conditions.
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.side === Side.SELL)
        .map((quote) => quote.price)
    ).toEqual([0.56, 0.56]);
  });

  it("triggers net pair stop-loss from edge bps even before the USDC stop floor is breached", () => {
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit = true;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      1;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc = 1;
    (
      config.marketMaker as {
        netPairTakeProfitMinEdgeBps: number | undefined;
      }
    ).netPairTakeProfitMinEdgeBps = undefined;
    (
      config.marketMaker as {
        netPairStopMaxLossBps: number | undefined;
      }
    ).netPairStopMaxLossBps = 150;
    (config.marketMaker as { netPairSpreadCollapseMaxObservedSpreadTicks: number }).netPairSpreadCollapseMaxObservedSpreadTicks =
      1;

    const pairState = buildMarketMakerPairInventoryState(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 12.5,
      openedAtMs: 1
    }));

    expect(pairState?.matchedNetPnlUsdc).toBeCloseTo(-0.5);
    expect(pairState?.matchedNetEdgeBps).toBeLessThan(-150);
    expect(resolveMarketMakerNetPairExitMode(plan, pairState)).toBe("stop");
  });

  it("tightens both passive SELL quotes when the pair spread collapses", () => {
    (config.marketMaker as { enableNetPairExit: boolean }).enableNetPairExit = true;
    (config.marketMaker as { netPairTakeProfitMinPnlUsdc: number }).netPairTakeProfitMinPnlUsdc =
      0.5;
    (config.marketMaker as { netPairStopMaxLossUsdc: number }).netPairStopMaxLossUsdc = 0.5;
    (config.marketMaker as { netPairSpreadCollapseMaxObservedSpreadTicks: number }).netPairSpreadCollapseMaxObservedSpreadTicks =
      2;

    const pairState = buildMarketMakerPairInventoryState(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 12.3,
      openedAtMs: 1
    }));

    expect(resolveMarketMakerNetPairExitMode(plan, pairState)).toBe("spread-collapse");

    const adjustedPlan = applyNetPairExitToMarketMakerPlan(plan, (tokenId) => ({
      tokenId,
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: tokenId === "yes-token" ? "Yes" : "No",
      shares: 25,
      totalCostUsdc: 12.3,
      openedAtMs: 1
    }));

    // avgCost 12.3/25 = 0.492; profit floor = roundUp(0.492 + 0.01) = 0.51 (tick 0.01).
    // The spread-collapse adjustment still fires but the floor anchors the SELL.
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.side === Side.SELL)
        .map((quote) => quote.price)
    ).toEqual([0.51, 0.51]);
  });

  it("does not trigger take-profit from one leg alone when the paired net position is still negative", () => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind = true;
    (config.marketMaker as { takeProfitMinPnlUsdc: number }).takeProfitMinPnlUsdc = 0.05;
    (config.marketMaker as { takeProfitMinEdgeBps: number }).takeProfitMinEdgeBps = 100;

    const adjustedPlan = applyTakeProfitToMarketMakerPlan(plan, (tokenId) => {
      if (tokenId === "yes-token") {
        return {
          tokenId,
          marketScope: plan.market.slug,
          conditionId: plan.market.conditionId,
          outcome: "Yes",
          shares: 25,
          totalCostUsdc: 11.25,
          openedAtMs: 1
        };
      }

      if (tokenId === "no-token") {
        return {
          tokenId,
          marketScope: plan.market.slug,
          conditionId: plan.market.conditionId,
          outcome: "No",
          shares: 25,
          totalCostUsdc: 13.5,
          openedAtMs: 1
        };
      }

      return undefined;
    });

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );

    expect(adjustedSellQuote?.price).toBe(0.51);
  });

  it("tightens old inventory SELL quotes step-by-step even without take-profit", () => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind = false;
    (config.marketMaker as { enableAgeBasedUnwind: boolean }).enableAgeBasedUnwind = true;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { ageBasedUnwindStepMs: number }).ageBasedUnwindStepMs = 60_000;
    (config.marketMaker as { ageBasedUnwindMaxInwardTicks: number }).ageBasedUnwindMaxInwardTicks = 2;

    const adjustedPlan = applyAgeBasedUnwindToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 25,
              totalCostUsdc: 12.75,
              openedAtMs: 0
            }
          : undefined,
      180_000
    );

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );
    const untouchedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "no-token" && quote.side === Side.SELL
    );

    // avgCost 12.75/25 = 0.51; profit floor = roundUp(0.51 + 0.01) = 0.52.
    // Age-based unwind tightens but the absolute floor anchors the SELL above cost.
    expect(adjustedSellQuote?.price).toBe(0.52);
    expect(untouchedSellQuote?.price).toBe(0.51);
  });

  it("tightens old small inventory SELL quotes even when held shares are below the standard quote size", () => {
    (config.marketMaker as { enableTakeProfitUnwind: boolean }).enableTakeProfitUnwind = false;
    (config.marketMaker as { enableAgeBasedUnwind: boolean }).enableAgeBasedUnwind = true;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { ageBasedUnwindStepMs: number }).ageBasedUnwindStepMs = 60_000;
    (config.marketMaker as { ageBasedUnwindMaxInwardTicks: number }).ageBasedUnwindMaxInwardTicks = 2;

    const adjustedPlan = applyAgeBasedUnwindToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 4.08,
              openedAtMs: 0
            }
          : undefined,
      180_000
    );

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );

    // avgCost 4.08/8 = 0.51; profit floor = 0.52.
    expect(adjustedSellQuote?.price).toBe(0.52);
  });

  it("does not apply age-based unwind when neither loss nor overweight trigger is present", () => {
    (config.marketMaker as { enableAgeBasedUnwind: boolean }).enableAgeBasedUnwind = true;
    (config.marketMaker as { enableStaleBreakEvenUnwind: boolean }).enableStaleBreakEvenUnwind =
      false;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 200;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const adjustedPlan = applyAgeBasedUnwindToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      180_000
    );

    expect(adjustedPlan).toBe(plan);
  });

  it("applies age-based unwind for stale inventory that is still at break-even or better", () => {
    (config.marketMaker as { enableAgeBasedUnwind: boolean }).enableAgeBasedUnwind = true;
    (config.marketMaker as { ageBasedUnwindAfterMs: number }).ageBasedUnwindAfterMs = 60_000;
    (config.marketMaker as { ageBasedUnwindStepMs: number }).ageBasedUnwindStepMs = 60_000;
    (config.marketMaker as { ageBasedUnwindMaxInwardTicks: number }).ageBasedUnwindMaxInwardTicks =
      3;
    (config.marketMaker as { enableStaleBreakEvenUnwind: boolean }).enableStaleBreakEvenUnwind =
      true;
    (config.marketMaker as { staleBreakEvenUnwindAfterMs: number }).staleBreakEvenUnwindAfterMs =
      120_000;
    (config.marketMaker as { staleBreakEvenUnwindMinEdgeBps: number }).staleBreakEvenUnwindMinEdgeBps =
      0;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 200;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const adjustedPlan = applyAgeBasedUnwindToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.84,
              openedAtMs: 0
            }
          : undefined,
      180_000
    );

    const adjustedSellQuote = adjustedPlan.quotes.find(
      (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
    );

    expect(adjustedPlan).not.toBe(plan);
    expect(adjustedSellQuote?.price).toBe(0.5);
  });

  it("immediately rebalances the opposite BUY and the filled-side SELL after a one-side fill", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillUnwindAfterMs: number }).oneSideFillUnwindAfterMs =
      120_000;
    (config.marketMaker as { oneSideFillRebalanceOpposingBuyInwardTicks: number }).oneSideFillRebalanceOpposingBuyInwardTicks =
      1;
    (config.marketMaker as { oneSideFillRebalanceFilledBuyOutwardTicks: number }).oneSideFillRebalanceFilledBuyOutwardTicks =
      1;
    (config.marketMaker as { oneSideFillRebalanceFilledSellInwardTicks: number }).oneSideFillRebalanceFilledSellInwardTicks =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      300_000;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      500;

    const recoveryState = resolveMarketMakerOneSideFillResponseState(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      30_000
    );

    expect(recoveryState?.mode).toBe("rebalance");

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      30_000
    );

    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY
      )?.price
    ).toBe(0.48);
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )?.price
    ).toBe(0.5);
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "no-token" && quote.side === Side.BUY
      )?.price
    ).toBe(0.5);
  });

  it("switches into unwind-priority mode and suppresses new BUYs on the filled side when imbalance persists", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillUnwindAfterMs: number }).oneSideFillUnwindAfterMs =
      60_000;
    (config.marketMaker as { oneSideFillRebalanceOpposingBuyInwardTicks: number }).oneSideFillRebalanceOpposingBuyInwardTicks =
      1;
    (config.marketMaker as { oneSideFillUnwindSellInwardTicks: number }).oneSideFillUnwindSellInwardTicks =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      300_000;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      500;
    (config.marketMaker as { oneSideFillUnwindSuppressFilledBuy: boolean }).oneSideFillUnwindSuppressFilledBuy =
      true;

    const recoveryState = resolveMarketMakerOneSideFillResponseState(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      180_000
    );

    expect(recoveryState?.mode).toBe("unwind-priority");

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      180_000
    );

    expect(
      adjustedPlan.quotes.some(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY
      )
    ).toBe(false);
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )?.price
    ).toBe(0.5);
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "no-token" && quote.side === Side.BUY
      )?.price
    ).toBe(0.5);
  });

  it("forces the filled-side SELL into a partially fillable GTC chunk exit after the one-side fill ages past 5 seconds", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    // Legacy aggressive-exit path under test; explicitly opt out of hedge mode.
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillUnwindAfterMs: number }).oneSideFillUnwindAfterMs =
      120_000;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      5_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      500;

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              // avgCost lowered to 0.48 so the absolute profit floor (0.49)
              // permits the aggressive 0.49 chunk exit asserted below.
              totalCostUsdc: 3.84,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      6_000
    );

    expect(
      adjustedPlan.quotes.some((quote) => quote.side === Side.BUY)
    ).toBe(false);
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({
          price: quote.price,
          size: quote.size,
          orderType: quote.orderType,
          postOnly: quote.postOnly,
          executionStyle: quote.executionStyle,
          quoteSlot: quote.quoteSlot
        }))
    ).toEqual([
      {
        price: 0.49,
        size: 2,
        orderType: OrderType.GTC,
        postOnly: false,
        executionStyle: "one-side-aggressive-exit",
        quoteSlot: "one-side-aggressive-exit:1"
      },
      {
        price: 0.49,
        size: 2,
        orderType: OrderType.GTC,
        postOnly: false,
        executionStyle: "one-side-aggressive-exit",
        quoteSlot: "one-side-aggressive-exit:2"
      },
      {
        price: 0.49,
        size: 4,
        orderType: OrderType.GTC,
        postOnly: false,
        executionStyle: "one-side-aggressive-exit",
        quoteSlot: "one-side-aggressive-exit:3"
      }
    ]);
  });

  it("immediately forces a filled-side SELL exit when the one-side fill breaches the 1% loss stop", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      30_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      100;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;

    const lossPlan: MarketMakerPlan = {
      ...plan,
      tokenPlans: [
        {
          ...plan.tokenPlans[0]!,
          bestBid: 0.48,
          bestAsk: 0.49,
          quotes: [
            {
              ...plan.tokenPlans[0]!.quotes[0]!,
              price: 0.48
            },
            {
              ...plan.tokenPlans[0]!.quotes[1]!,
              price: 0.49
            }
          ]
        },
        plan.tokenPlans[1]!
      ],
      quotes: [
        {
          ...plan.quotes[0]!,
          price: 0.48
        },
        {
          ...plan.quotes[1]!,
          price: 0.49
        },
        plan.quotes[2]!,
        plan.quotes[3]!
      ]
    };

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      lossPlan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: lossPlan.market.slug,
              conditionId: lossPlan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: lossPlan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      1_000
    );

    // Aggressive exit fires (mark edge -204 bps beats the 1% loss stop) and
    // uses the bounded-loss floor, allowing a one-tick exit instead of waiting
    // for a profit-floor sell that may never fill.
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => quote.size)
    ).toEqual([2, 2, 4]);
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .every(
          (quote) =>
            quote.price === 0.48 &&
            quote.orderType === OrderType.GTC &&
            quote.postOnly === false &&
            quote.executionStyle === "one-side-aggressive-exit"
        )
    ).toBe(true);
    expect(
      adjustedPlan.quotes.some((quote) => quote.side === Side.BUY)
    ).toBe(false);
  });

  it("shrinks the one-side aggressive exit chunk and concedes one tick after repeated liquidity misses", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      5_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;
    (config.marketMaker as { oneSideFillAggressiveExitRepriceAfterRejects: number }).oneSideFillAggressiveExitRepriceAfterRejects =
      3;
    (config.marketMaker as { oneSideFillAggressiveExitRejectPriceConcessionTicks: number }).oneSideFillAggressiveExitRejectPriceConcessionTicks =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitRejectSizeMultiplier: number }).oneSideFillAggressiveExitRejectSizeMultiplier =
      0.5;

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              // avgCost lowered to 0.46 so the profit floor (0.47) permits
              // the 1-tick concession down to 0.48 asserted below.
              totalCostUsdc: 3.68,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      6_000,
      () => 3
    );

    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({ size: quote.size, price: quote.price }))
    ).toEqual([
      { size: 1, price: 0.48 },
      { size: 1, price: 0.48 },
      { size: 6, price: 0.48 }
    ]);
  });

  it("relaxes the one-side aggressive exit floor after the break-even age", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      5_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;
    (config.marketMaker as { oneSideFillAggressiveExitRepriceAfterRejects: number }).oneSideFillAggressiveExitRepriceAfterRejects =
      3;
    (config.marketMaker as { oneSideFillAggressiveExitRejectPriceConcessionTicks: number }).oneSideFillAggressiveExitRejectPriceConcessionTicks =
      1;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 60_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.84,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      120_000,
      () => 3
    );

    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({ size: quote.size, price: quote.price }))
    ).toEqual([
      { size: 1, price: 0.47 },
      { size: 1, price: 0.47 },
      { size: 6, price: 0.47 }
    ]);
  });

  it("walks the one-side aggressive exit price down with age even without reject feedback", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      5_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;
    (config.marketMaker as { oneSideFillStopMaxLossBps: number }).oneSideFillStopMaxLossBps =
      1_000;
    (config.marketMaker as { ageBasedUnwindStepMs: number }).ageBasedUnwindStepMs = 30_000;
    (config.marketMaker as { ageBasedUnwindMaxInwardTicks: number }).ageBasedUnwindMaxInwardTicks =
      3;

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.2,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: plan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      96_000
    );

    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({ size: quote.size, price: quote.price }))
    ).toEqual([
      { size: 2, price: 0.46 },
      { size: 2, price: 0.46 },
      { size: 4, price: 0.46 }
    ]);
  });

  it("never emits an aggressive exit chunk below the venue minimum order size", () => {
    (config.marketMaker as { enableOneSideFillResponse: boolean }).enableOneSideFillResponse = true;
    (config.marketMaker as { oneSideFillResponseMode: string }).oneSideFillResponseMode = "exit";
    (config.marketMaker as { oneSideAggressiveExitTierTickSpacing: number }).oneSideAggressiveExitTierTickSpacing = 0;
    (config.marketMaker as { oneSideFillMinImbalanceShares: number }).oneSideFillMinImbalanceShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitAfterMs: number }).oneSideFillAggressiveExitAfterMs =
      5_000;
    (config.marketMaker as { oneSideFillAggressiveExitMinChunkShares: number }).oneSideFillAggressiveExitMinChunkShares =
      1;
    (config.marketMaker as { oneSideFillAggressiveExitMaxChunkShares: number }).oneSideFillAggressiveExitMaxChunkShares =
      2;
    (config.marketMaker as { oneSideFillAggressiveExitChunkRatio: number }).oneSideFillAggressiveExitChunkRatio =
      0.25;

    const highMinSizePlan: MarketMakerPlan = {
      ...plan,
      market: {
        ...plan.market,
        orderMinSize: 5
      }
    };

    const adjustedPlan = applyOneSideFillResponseToMarketMakerPlan(
      highMinSizePlan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: highMinSizePlan.market.slug,
              conditionId: highMinSizePlan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      {
        conditionId: highMinSizePlan.market.conditionId,
        filledTokenId: "yes-token",
        activatedAtMs: 0
      },
      6_000
    );

    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => quote.size)
    ).toEqual([8]);
  });

  it("applies the 80% one-side inventory hard gate by suppressing overweight BUYs and leaning the opposing BUY inward", () => {
    (config.marketMaker as { oneSideInventoryHardGateRatio: number }).oneSideInventoryHardGateRatio =
      0.8;
    (config.marketMaker as { oneSideFillRebalanceOpposingBuyInwardTicks: number }).oneSideFillRebalanceOpposingBuyInwardTicks =
      1;

    const adjustedPlan = applyOneSideInventoryHardGateToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : tokenId === "no-token"
            ? {
                tokenId,
                marketScope: plan.market.slug,
                conditionId: plan.market.conditionId,
                outcome: "No",
                shares: 2,
                totalCostUsdc: 1,
                openedAtMs: 0
              }
            : undefined
    );

    expect(
      adjustedPlan.quotes.some((quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY)
    ).toBe(false);
    expect(
      adjustedPlan.quotes.find((quote) => quote.tokenId === "no-token" && quote.side === Side.BUY)
        ?.price
    ).toBe(0.5);
    expect(
      adjustedPlan.quotes.find((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        ?.price
    ).toBe(0.5);
  });

  it("preserves aggressive exit SELL layers through the one-side hard gate", () => {
    (config.marketMaker as { oneSideInventoryHardGateRatio: number }).oneSideInventoryHardGateRatio =
      0.8;

    const aggressiveExitPlan: MarketMakerPlan = {
      ...plan,
      tokenPlans: [
        {
          ...plan.tokenPlans[0]!,
          quotes: [
            plan.tokenPlans[0]!.quotes[0]!,
            {
              ...plan.tokenPlans[0]!.quotes[1]!,
              price: 0.49,
              size: 5,
              postOnly: false,
              quoteSlot: "one-side-aggressive-exit:1",
              executionStyle: "one-side-aggressive-exit"
            }
          ]
        },
        plan.tokenPlans[1]!
      ],
      quotes: [
        plan.quotes[0]!,
        {
          ...plan.quotes[1]!,
          price: 0.49,
          size: 5,
          postOnly: false,
          quoteSlot: "one-side-aggressive-exit:1",
          executionStyle: "one-side-aggressive-exit"
        },
        {
          ...plan.quotes[1]!,
          price: 0.49,
          size: 5,
          postOnly: false,
          quoteSlot: "one-side-aggressive-exit:2",
          executionStyle: "one-side-aggressive-exit"
        },
        {
          ...plan.quotes[1]!,
          price: 0.49,
          size: 9.782,
          postOnly: false,
          quoteSlot: "one-side-aggressive-exit:3",
          executionStyle: "one-side-aggressive-exit"
        },
        plan.quotes[2]!,
        plan.quotes[3]!
      ]
    };

    const adjustedPlan = applyOneSideInventoryHardGateToMarketMakerPlan(
      aggressiveExitPlan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 19.782,
              totalCostUsdc: 9.89,
              openedAtMs: 0
            }
          : tokenId === "no-token"
            ? {
                tokenId,
                marketScope: plan.market.slug,
                conditionId: plan.market.conditionId,
                outcome: "No",
                shares: 2,
                totalCostUsdc: 1,
                openedAtMs: 0
              }
            : undefined
    );

    expect(
      adjustedPlan.quotes.some((quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY)
    ).toBe(false);
    expect(
      adjustedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => ({
          quoteSlot: quote.quoteSlot,
          price: quote.price,
          size: Number(quote.size.toFixed(6))
        }))
    ).toEqual([
      { quoteSlot: "one-side-aggressive-exit:1", price: 0.5, size: 5 },
      { quoteSlot: "one-side-aggressive-exit:2", price: 0.5, size: 5 },
      { quoteSlot: "one-side-aggressive-exit:3", price: 0.5, size: 9.782 }
    ]);
  });

  it("activates max-hold hard exit for stale inventory and suppresses fresh BUYs", () => {
    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit = true;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs = 60_000;
    (config.marketMaker as { maxHoldHardExitSuppressBuys: boolean }).maxHoldHardExitSuppressBuys =
      true;

    const hardExitState = resolveMarketMakerMaxHoldHardExitState(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 5.6,
              openedAtMs: 0
            }
          : undefined,
      120_000
    );

    expect(hardExitState?.agedTokenIds).toEqual(["yes-token"]);

    const adjustedPlan = applyMaxHoldHardExitToMarketMakerPlan(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 5.6,
              openedAtMs: 0
            }
          : undefined,
      120_000
    );

    expect(
      adjustedPlan.quotes.some(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY
      )
    ).toBe(false);
    expect(
      adjustedPlan.quotes.some((quote) => quote.tokenId === "yes-token")
    ).toBe(false);
    expect(
      adjustedPlan.quotes.some((quote) => quote.tokenId === "no-token")
    ).toBe(true);
  });

  it("does not activate max-hold hard exit when no conditional exit trigger is present", () => {
    (config.marketMaker as { enableMaxHoldHardExit: boolean }).enableMaxHoldHardExit = true;
    (config.marketMaker as { maxHoldHardExitAfterMs: number }).maxHoldHardExitAfterMs = 60_000;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 200;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const hardExitState = resolveMarketMakerMaxHoldHardExitState(
      plan,
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined,
      180_000
    );

    expect(hardExitState).toBeUndefined();
  });

  it("relaxes the minimum exit floor for sufficiently stale inventory", () => {
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 60_000;
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;

    const position = {
      tokenId: "yes-token",
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: "Yes",
      shares: 20,
      totalCostUsdc: 8,
      openedAtMs: 0
    };

    expect(resolveMinimumExitPriceForPosition(position, 0.01, 30_000)).toBe(0.41);
    expect(resolveMinimumExitPriceForPosition(position, 0.01, 120_000)).toBe(0.39);
  });

  it("resolves a bounded-loss floor one tick below average cost", () => {
    (config.marketMaker as { breakEvenExitMaxLossTicks: number }).breakEvenExitMaxLossTicks = 1;

    const position = {
      tokenId: "yes-token",
      marketScope: plan.market.slug,
      conditionId: plan.market.conditionId,
      outcome: "Yes",
      shares: 10,
      totalCostUsdc: 5.9,
      openedAtMs: 0
    };

    expect(resolveBoundedLossExitPriceForPosition(position, 0.01)).toBe(0.58);
  });

  it("raises passive SELL quotes to avoid inverted spread when no conditional exit trigger exists", () => {
    (config.marketMaker as { exitMinSpreadTicks: number }).exitMinSpreadTicks = 1;
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 200;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const guardedPlan = applyInventoryExitGuardToMarketMakerPlan(
      {
        ...plan,
        tokenPlans: [
          {
            ...plan.tokenPlans[0]!,
            quotes: [
              {
                ...plan.tokenPlans[0]!.quotes[0]!,
                price: 0.5
              },
              {
                ...plan.tokenPlans[0]!.quotes[1]!,
                price: 0.49
              }
            ]
          },
          plan.tokenPlans[1]!
        ],
        quotes: [
          {
            ...plan.quotes[0]!,
            price: 0.5
          },
          {
            ...plan.quotes[1]!,
            price: 0.49
          },
          plan.quotes[2]!,
          plan.quotes[3]!
        ]
      },
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 8,
              totalCostUsdc: 3.92,
              openedAtMs: 0
            }
          : undefined
    );

    expect(
      guardedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )?.price
    ).toBe(0.51);
  });

  it("holds layered inventory SELL quotes at the absolute profit floor even when the live book sits below it", () => {
    // 🔒 The profit floor (avgCost + exitMinProfitTicks) is now absolute. Previously
    // we anchored to the live book when bestAsk < floor, but the operator forbade
    // sub-cost / break-even sells. avgCost = 13.2/20 = 0.66, +1 tick = 0.67 floor,
    // so the layered SELLs stay at [0.67, 0.68, 0.69] even though bestAsk is 0.66.
    (config.marketMaker as { exitMinSpreadTicks: number }).exitMinSpreadTicks = 1;
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;
    // Disable time-based break-even relaxation (#4) so test's openedAtMs=0
    // position doesn't trigger stale unwind through a 4h+ age window.
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 0;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 200;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const guardedPlan = applyInventoryExitGuardToMarketMakerPlan(
      {
        ...plan,
        tokenPlans: [
          {
            ...plan.tokenPlans[0]!,
            bestBid: 0.65,
            bestAsk: 0.66,
            quotes: [
              {
                ...plan.tokenPlans[0]!.quotes[0]!,
                price: 0.65,
                size: 20
              },
              {
                ...plan.tokenPlans[0]!.quotes[1]!,
                price: 0.66,
                size: 20
              }
            ]
          },
          plan.tokenPlans[1]!
        ],
        quotes: [
          {
            ...plan.quotes[0]!,
            price: 0.65,
            size: 20
          },
          {
            ...plan.quotes[1]!,
            price: 0.66,
            size: 5,
            quoteSlot: "sell-layer-0"
          },
          {
            ...plan.quotes[1]!,
            price: 0.67,
            size: 5,
            quoteSlot: "sell-layer-1"
          },
          {
            ...plan.quotes[1]!,
            price: 0.68,
            size: 10,
            quoteSlot: "sell-layer-2"
          },
          plan.quotes[2]!,
          plan.quotes[3]!
        ]
      },
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 20,
              totalCostUsdc: 13.2,
              openedAtMs: 0
            }
          : undefined
    );

    expect(
      guardedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => quote.price)
    ).toEqual([0.67, 0.68, 0.69]);
  });

  it("preserves sell-layer spacing when the live book supports lifting the primary SELL floor", () => {
    (config.marketMaker as { exitMinSpreadTicks: number }).exitMinSpreadTicks = 1;
    (config.marketMaker as { exitMinProfitTicks: number }).exitMinProfitTicks = 1;
    (config.marketMaker as { breakEvenExitAfterMs: number }).breakEvenExitAfterMs = 0;
    (config.marketMaker as { enableStaleBreakEvenUnwind: boolean }).enableStaleBreakEvenUnwind =
      false;
    (config.marketMaker as { maxTokenExposureShares: number }).maxTokenExposureShares = 100;
    (config.marketMaker as { conditionalExitMaxLossBps: number }).conditionalExitMaxLossBps = 1_000;
    (config.marketMaker as { conditionalExitOverweightRatio: number }).conditionalExitOverweightRatio =
      0.8;

    const guardedPlan = applyInventoryExitGuardToMarketMakerPlan(
      {
        ...plan,
        tokenPlans: [
          {
            ...plan.tokenPlans[0]!,
            bestBid: 0.53,
            bestAsk: 0.57,
            quotes: [
              {
                ...plan.tokenPlans[0]!.quotes[0]!,
                price: 0.53,
                size: 20
              },
              {
                ...plan.tokenPlans[0]!.quotes[1]!,
                price: 0.54,
                size: 20
              }
            ]
          },
          plan.tokenPlans[1]!
        ],
        quotes: [
          {
            ...plan.quotes[0]!,
            price: 0.53,
            size: 20
          },
          {
            ...plan.quotes[1]!,
            price: 0.54,
            size: 5,
            quoteSlot: "sell-layer-0"
          },
          {
            ...plan.quotes[1]!,
            price: 0.55,
            size: 5,
            quoteSlot: "sell-layer-1"
          },
          {
            ...plan.quotes[1]!,
            price: 0.56,
            size: 10,
            quoteSlot: "sell-layer-2"
          },
          plan.quotes[2]!,
          plan.quotes[3]!
        ]
      },
      (tokenId) =>
        tokenId === "yes-token"
          ? {
              tokenId,
              marketScope: plan.market.slug,
              conditionId: plan.market.conditionId,
              outcome: "Yes",
              shares: 20,
              totalCostUsdc: 11,
              openedAtMs: 0
            }
          : undefined
    );

    expect(
      guardedPlan.quotes
        .filter((quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL)
        .map((quote) => quote.price)
    ).toEqual([0.56, 0.57, 0.58]);
  });

  it("converts stale passive quotes into aggressive marketable GTC quotes once the quote ages past the threshold", () => {
    (config.marketMaker as { enablePassiveToAggressiveTransition: boolean }).enablePassiveToAggressiveTransition =
      true;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      60_000;
    (config.marketMaker as { passiveToAggressivePriceBufferTicks: number }).passiveToAggressivePriceBufferTicks =
      0;

    const adjustedPlan = applyPassiveToAggressiveTransitionToMarketMakerPlan(
      plan,
      (tokenId, side) => ({
        ...(plan.quotes.find((quote) => quote.tokenId === tokenId && quote.side === side) ?? plan.quotes[0]!),
        orderId: `${tokenId}:${side}`,
        conditionId: plan.market.conditionId,
        marketSlug: plan.market.slug,
        category: plan.market.category,
        openedAtMs: 0
      }),
      120_000
    );

    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY
      )
    ).toMatchObject({
      price: 0.51,
      orderType: OrderType.GTC,
      postOnly: false
    });
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )
    ).toMatchObject({
      price: 0.49,
      orderType: OrderType.GTC,
      postOnly: false
    });
  });

  it("converts stale passive quotes even when desired passive prices were repriced", () => {
    (config.marketMaker as { enablePassiveToAggressiveTransition: boolean }).enablePassiveToAggressiveTransition =
      true;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      60_000;
    (config.marketMaker as { passiveToAggressivePriceBufferTicks: number }).passiveToAggressivePriceBufferTicks =
      0;

    const adjustedPlan = applyPassiveToAggressiveTransitionToMarketMakerPlan(
      plan,
      (tokenId, side) => {
        const desiredQuote =
          plan.quotes.find((quote) => quote.tokenId === tokenId && quote.side === side) ??
          plan.quotes[0]!;
        const repricedActivePrice =
          side === Side.BUY ? desiredQuote.price - 0.01 : desiredQuote.price + 0.01;

        return {
          ...desiredQuote,
          price: repricedActivePrice,
          orderId: `${tokenId}:${side}`,
          conditionId: plan.market.conditionId,
          marketSlug: plan.market.slug,
          category: plan.market.category,
          openedAtMs: 0
        };
      },
      120_000
    );

    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.BUY
      )
    ).toMatchObject({
      price: 0.51,
      orderType: OrderType.GTC,
      postOnly: false
    });
    expect(
      adjustedPlan.quotes.find(
        (quote) => quote.tokenId === "yes-token" && quote.side === Side.SELL
      )
    ).toMatchObject({
      price: 0.49,
      orderType: OrderType.GTC,
      postOnly: false
    });
  });

  it("keeps passive quotes unchanged before the passive-to-aggressive threshold elapses", () => {
    (config.marketMaker as { enablePassiveToAggressiveTransition: boolean }).enablePassiveToAggressiveTransition =
      true;
    (config.marketMaker as { passiveToAggressiveAfterMs: number }).passiveToAggressiveAfterMs =
      60_000;

    const adjustedPlan = applyPassiveToAggressiveTransitionToMarketMakerPlan(
      plan,
      (tokenId, side) => ({
        ...(plan.quotes.find((quote) => quote.tokenId === tokenId && quote.side === side) ?? plan.quotes[0]!),
        orderId: `${tokenId}:${side}`,
        conditionId: plan.market.conditionId,
        marketSlug: plan.market.slug,
        category: plan.market.category,
        openedAtMs: 90_000
      }),
      120_000
    );

    expect(adjustedPlan).toBe(plan);
  });

  it("converts active quotes into execution-engine active orders", () => {
    const activeOrder = activeQuoteToActiveOrder({
      ...plan.quotes[0]!,
      orderId: "order-1",
      conditionId: plan.market.conditionId,
      marketSlug: plan.market.slug,
      category: plan.market.category,
      openedAtMs: 1
    });

    expect(activeOrder.orderId).toBe("order-1");
    expect(activeOrder.strategy).toBe("market-making");
    expect(activeOrder.tif).toBe("GTC");
  });

  it("does not re-layer one-side aggressive exit SELL quotes into sub-minimum sizes", () => {
    const aggressiveExitPlan: MarketMakerPlan = {
      ...plan,
      quotes: [
        {
          ...plan.quotes[1]!,
          size: 5,
          quoteSlot: "one-side-aggressive-exit:1",
          postOnly: false,
          executionStyle: "one-side-aggressive-exit"
        },
        {
          ...plan.quotes[3]!,
          size: 15,
          quoteSlot: "one-side-aggressive-exit:2",
          postOnly: false,
          executionStyle: "one-side-aggressive-exit"
        }
      ]
    };

    const expanded = expandSellQuotesToLayers(aggressiveExitPlan, 3, 1, [0.25, 0.25, 0.5]);

    expect(expanded.quotes).toEqual(aggressiveExitPlan.quotes);
  });

  it("redistributes slightly sub-weighted sell ladders to keep a valid three-layer exit", () => {
    const thinSellPlan: MarketMakerPlan = {
      ...plan,
      quotes: [
        {
          ...plan.quotes[1]!,
          size: 19.784
        }
      ]
    };

    const expanded = expandSellQuotesToLayers(thinSellPlan, 3, 1, [0.25, 0.25, 0.5]);

    expect(
      expanded.quotes.map((quote) => ({
        quoteSlot: quote.quoteSlot,
        size: Number(quote.size.toFixed(6))
      }))
    ).toEqual([
      { quoteSlot: "sell-layer-0", size: 5 },
      { quoteSlot: "sell-layer-1", size: 5 },
      { quoteSlot: "sell-layer-2", size: 9.784 }
    ]);
  });

  it("falls back to fewer valid sell layers instead of collapsing to a single order", () => {
    const mediumSellPlan: MarketMakerPlan = {
      ...plan,
      quotes: [
        {
          ...plan.quotes[1]!,
          size: 12
        }
      ]
    };

    const expanded = expandSellQuotesToLayers(mediumSellPlan, 3, 1, [0.25, 0.25, 0.5]);

    expect(
      expanded.quotes.map((quote) => ({
        quoteSlot: quote.quoteSlot,
        size: Number(quote.size.toFixed(6))
      }))
    ).toEqual([
      { quoteSlot: "sell-layer-0", size: 5 },
      { quoteSlot: "sell-layer-1", size: 7 }
    ]);
  });
});
