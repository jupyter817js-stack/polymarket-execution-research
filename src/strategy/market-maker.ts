import { OrderType, Side } from "@polymarket/clob-client-v2";

import { config } from "../config.js";
import type { RiskExecutionThrottleSnapshot } from "../core/degraded-execution-policy.js";
import type { TrackedInventoryPosition } from "../core/inventory-lot-tracker.js";
import { estimateRebateEfficiencyScore } from "./rebates.js";
import type { BinaryMarket, NormalizedOrderBook } from "../types.js";
import { clampPrice, roundDownToTick, roundUpToTick } from "../utils.js";

const EPSILON = 1e-9;

const normalizeLinear = (value: number, minValue: number, maxValue: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (maxValue <= minValue) {
    return value >= maxValue ? 1 : 0;
  }

  return Math.max(0, Math.min(1, (value - minValue) / (maxValue - minValue)));
};

export type MarketMakerRejectReason =
  | "stale_book"
  | "missing_top_of_book"
  | "spread_too_tight"
  | "market_spread_too_narrow"
  | "top_book_liquidity_too_thin"
  | "invalid_quote_shape";

export interface QuoteInstruction {
  tokenId: string;
  outcome: string;
  side: Side;
  quoteSlot?: string;
  price: number;
  size: number;
  tickSize: number;
  negRisk?: boolean;
  postOnly: boolean;
  orderType: OrderType.GTC | OrderType.GTD | OrderType.FOK;
  executionStyle?: "one-side-aggressive-exit";
  expiration?: number;
  maxRestingAgeMs?: number;
}

export interface TokenQuotePlan {
  tokenId: string;
  outcome: string;
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  observedSpread: number;
  observedSpreadTicks: number;
  topBookLiquidityUsdc: number;
  rewardEligible: boolean;
  rebateEfficiencyScore: number;
  rebatePrioritySide?: Side.BUY | Side.SELL;
  rebateInwardTicks: number;
  inventoryShares: number;
  opposingInventoryShares: number;
  inventorySkewRatio: number;
  inventoryBuyAdjustmentTicks: number;
  inventorySellAdjustmentTicks: number;
  fillRateFeedbackInwardTicks: number;
  tapePressureBiasSide?: Side.BUY | Side.SELL;
  tapePressureBiasTicks: number;
  tapePressureScore?: number;
  tapePressureTradesPerMinute?: number;
  quotes: readonly [QuoteInstruction, QuoteInstruction];
}

export interface MarketMakerFillRateFeedback {
  postedQuoteCount: number;
  filledQuoteCount: number;
  fillRate: number;
  inwardTicks: number;
}

export interface MarketMakerPlan {
  market: BinaryMarket;
  generatedAtMs: number;
  rewardActive: boolean;
  executionThrottle?: Pick<
    RiskExecutionThrottleSnapshot,
    "state" | "dominantReason" | "quoteSizeMultiplier" | "quoteHalfSpreadTicksMultiplier"
  >;
  fillRateFeedback?: MarketMakerFillRateFeedback;
  quotes: QuoteInstruction[];
  tokenPlans: readonly [TokenQuotePlan, TokenQuotePlan];
}

export type MarketMakerEvaluation =
  | {
      status: "ready";
      plan: MarketMakerPlan;
    }
  | {
      status: "rejected";
      reason: MarketMakerRejectReason;
      detail: string;
    };

type TokenPlanEvaluation =
  | TokenQuotePlan
  | {
      status: "rejected";
      reason: MarketMakerRejectReason;
      detail: string;
    };

const isRejectedTokenPlan = (
  value: TokenPlanEvaluation
): value is Extract<TokenPlanEvaluation, { status: "rejected" }> => "status" in value;

const getTopBookLiquidityUsdc = (book: NormalizedOrderBook): number => {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];

  if (!bestBid || !bestAsk) {
    return 0;
  }

  return bestBid.price * bestBid.size + bestAsk.price * bestAsk.size;
};

const resolveQuoteSize = (
  market: BinaryMarket,
  throttle?: RiskExecutionThrottleSnapshot
): number => {
  const rewardMinimum =
    config.marketMaker.useRewardMinSize &&
    throttle?.state !== "DEGRADED" &&
    typeof market.rewardsMinSize === "number" &&
    Number.isFinite(market.rewardsMinSize) &&
    market.rewardsMinSize > 0
      ? market.rewardsMinSize
      : 0;

  const rewardSchedulingMultiplier =
    config.marketMaker.enableRewardRebateScheduling && (market.rewardRatePerDay ?? 0) > EPSILON
      ? 1 +
        normalizeLinear(
          market.rewardRatePerDay ?? 0,
          0,
          config.marketMaker.rewardSchedulingRateCapPerDay
        ) *
          (config.marketMaker.rewardSchedulingMaxQuoteSizeMultiplier - 1)
      : 1;
  const effectiveBaseQuoteSize =
    config.marketMaker.quoteSize *
    (throttle?.quoteSizeMultiplier ?? 1) *
    rewardSchedulingMultiplier;

  return Math.max(effectiveBaseQuoteSize, rewardMinimum);
};

const resolveOrderExpiration = (): number | undefined => {
  if (config.marketMaker.orderType !== "GTD") {
    return undefined;
  }

  return Math.floor(Date.now() / 1000) + config.marketMaker.gtdBufferSeconds;
};

const chooseRebatePrioritySide = (
  midpoint: number,
  tokenIndex: number
): Side.BUY | Side.SELL => {
  if (midpoint > 0.5 + EPSILON) {
    return Side.BUY;
  }

  if (midpoint < 0.5 - EPSILON) {
    return Side.SELL;
  }

  return tokenIndex % 2 === 0 ? Side.BUY : Side.SELL;
};

const resolveInventorySkewAdjustments = (
  currentPosition: TrackedInventoryPosition | undefined,
  opposingPosition: TrackedInventoryPosition | undefined
): {
  inventoryShares: number;
  opposingInventoryShares: number;
  inventorySkewRatio: number;
  buyAdjustmentTicks: number;
  sellAdjustmentTicks: number;
} => {
  const inventoryShares = currentPosition?.shares ?? 0;
  const opposingInventoryShares = opposingPosition?.shares ?? 0;

  if (!config.marketMaker.enableInventorySkew || config.marketMaker.inventorySkewMaxTickOffset <= 0) {
    return {
      inventoryShares,
      opposingInventoryShares,
      inventorySkewRatio: 0,
      buyAdjustmentTicks: 0,
      sellAdjustmentTicks: 0
    };
  }

  const referenceShares = Math.max(config.marketMaker.maxTokenExposureShares, EPSILON);
  const inventorySkewRatio = Math.max(
    -1,
    Math.min(1, (inventoryShares - opposingInventoryShares) / referenceShares)
  );

  if (Math.abs(inventorySkewRatio) <= EPSILON) {
    return {
      inventoryShares,
      opposingInventoryShares,
      inventorySkewRatio: 0,
      buyAdjustmentTicks: 0,
      sellAdjustmentTicks: 0
    };
  }

  const rawTickOffset = Math.ceil(
    Math.abs(inventorySkewRatio) * config.marketMaker.inventorySkewMaxTickOffset
  );

  if (rawTickOffset <= 0) {
    return {
      inventoryShares,
      opposingInventoryShares,
      inventorySkewRatio,
      buyAdjustmentTicks: 0,
      sellAdjustmentTicks: 0
    };
  }

  return inventorySkewRatio > 0
    ? {
        inventoryShares,
        opposingInventoryShares,
        inventorySkewRatio,
        buyAdjustmentTicks: -rawTickOffset,
        sellAdjustmentTicks: rawTickOffset
      }
    : {
        inventoryShares,
        opposingInventoryShares,
        inventorySkewRatio,
        buyAdjustmentTicks: rawTickOffset,
        sellAdjustmentTicks: -rawTickOffset
      };
};

const applyTouchQuoteAnchoring = (
  bidPrice: number,
  askPrice: number,
  bestBidPrice: number,
  bestAskPrice: number,
  tickSize: number
): { bidPrice: number; askPrice: number } => {
  if (!config.marketMaker.enableTouchQuoteAnchoring) {
    return { bidPrice, askPrice };
  }

  const anchoredBidFloor = bestBidPrice;
  const anchoredBidCeiling = Math.min(
    bestAskPrice - tickSize,
    bestBidPrice + config.marketMaker.touchBidInwardTicks * tickSize
  );
  const anchoredAskFloor = Math.max(
    bestBidPrice + tickSize,
    bestAskPrice - config.marketMaker.touchAskInwardTicks * tickSize
  );
  const anchoredAskCeiling = bestAskPrice;

  let anchoredBidPrice = clampPrice(
    Math.min(Math.max(bidPrice, anchoredBidFloor), anchoredBidCeiling),
    tickSize
  );
  let anchoredAskPrice = clampPrice(
    Math.min(Math.max(askPrice, anchoredAskFloor), anchoredAskCeiling),
    tickSize
  );

  if (anchoredBidPrice + EPSILON >= anchoredAskPrice) {
    const minAskFromBid = clampPrice(anchoredBidPrice + tickSize, tickSize);
    if (minAskFromBid <= anchoredAskCeiling + EPSILON) {
      anchoredAskPrice = Math.min(anchoredAskCeiling, minAskFromBid);
    } else {
      const maxBidFromAsk = clampPrice(anchoredAskPrice - tickSize, tickSize);
      anchoredBidPrice = Math.max(anchoredBidFloor, maxBidFromAsk);
    }
  }

  return {
    bidPrice: anchoredBidPrice,
    askPrice: anchoredAskPrice
  };
};

const applyTapePressureBias = (
  bidPrice: number,
  askPrice: number,
  bestBidPrice: number,
  bestAskPrice: number,
  tickSize: number,
  tapePressure: NormalizedOrderBook["tapePressure"]
): {
  bidPrice: number;
  askPrice: number;
  biasSide?: Side.BUY | Side.SELL;
  biasTicks: number;
  pressureScore?: number;
  tradesPerMinute?: number;
} => {
  const rawBiasTicks = tapePressure?.biasTicks ?? 0;

  if (!config.marketMaker.enableTapePressureBias || rawBiasTicks === 0) {
    return {
      bidPrice,
      askPrice,
      biasSide: undefined,
      biasTicks: 0,
      pressureScore: tapePressure?.pressureScore,
      tradesPerMinute: tapePressure?.tradesPerMinute
    };
  }

  const biasMagnitude = Math.abs(rawBiasTicks);

  if (rawBiasTicks > 0) {
    const spreadTicks = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
    const maxBuyInwardTicks = Math.max(0, spreadTicks - 1);
    const appliedTicks = Math.min(maxBuyInwardTicks, biasMagnitude);

    return {
      bidPrice:
        appliedTicks > 0
          ? clampPrice(
              Math.min(bestAskPrice - tickSize, bidPrice + appliedTicks * tickSize),
              tickSize
            )
          : bidPrice,
      askPrice,
      biasSide: appliedTicks > 0 ? Side.BUY : undefined,
      biasTicks: appliedTicks,
      pressureScore: tapePressure?.pressureScore,
      tradesPerMinute: tapePressure?.tradesPerMinute
    };
  }

  const spreadTicks = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
  const maxSellInwardTicks = Math.max(0, spreadTicks - 1);
  const appliedTicks = Math.min(maxSellInwardTicks, biasMagnitude);

  return {
    bidPrice,
    askPrice:
      appliedTicks > 0
        ? clampPrice(
            Math.max(bestBidPrice + tickSize, askPrice - appliedTicks * tickSize),
            tickSize
          )
        : askPrice,
    biasSide: appliedTicks > 0 ? Side.SELL : undefined,
    biasTicks: appliedTicks,
    pressureScore: tapePressure?.pressureScore,
    tradesPerMinute: tapePressure?.tradesPerMinute
  };
};

const buildTokenQuotePlan = (
  market: BinaryMarket,
  tokenId: string,
  outcome: string,
  book: NormalizedOrderBook,
  tokenIndex: number,
  currentPosition: TrackedInventoryPosition | undefined,
  opposingPosition: TrackedInventoryPosition | undefined,
  throttle?: RiskExecutionThrottleSnapshot,
  fillRateFeedback?: MarketMakerFillRateFeedback
): TokenPlanEvaluation => {
  const bookAgeMs = Date.now() - book.updatedAtMs;

  if (bookAgeMs > config.strategy.maxBookStalenessMs) {
    return {
      status: "rejected",
      reason: "stale_book",
      detail: `${outcome} bookAgeMs(${bookAgeMs}) > maxBookStalenessMs(${config.strategy.maxBookStalenessMs})`
    };
  }

  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];

  if (!bestBid || !bestAsk) {
    return {
      status: "rejected",
      reason: "missing_top_of_book",
      detail: `${outcome} book is missing best bid or best ask`
    };
  }

  const tickSize = Math.max(book.tickSize, market.orderPriceMinTickSize || book.tickSize);
  const observedSpread = bestAsk.price - bestBid.price;
  const observedSpreadTicks = Math.round(observedSpread / tickSize);

  if (observedSpread + EPSILON < config.marketMaker.minSpreadTicks * tickSize) {
    return {
      status: "rejected",
      reason: "spread_too_tight",
      detail: `${outcome} spread(${observedSpread.toFixed(4)}) < minSpread(${(
        config.marketMaker.minSpreadTicks * tickSize
      ).toFixed(4)})`
    };
  }

  // 🚫 진입 스프레드 요구. 시장 자체가 너무 좁으면 BUY/SELL 호가를 모두
  // bestBid/bestAsk 안쪽으로 배치할 수 없어 수익 구조가 성립하지 않음.
  // minMarketSpreadTicks 기본값 2틱은 "BUY at bid-1 + SELL at ask+1"을
  // 요구하는 #1/#2 정책의 최소 조건.
  if (observedSpreadTicks < config.marketMaker.minMarketSpreadTicks) {
    return {
      status: "rejected",
      reason: "market_spread_too_narrow",
      detail: `${outcome} observedSpreadTicks(${observedSpreadTicks}) < minMarketSpreadTicks(${config.marketMaker.minMarketSpreadTicks})`
    };
  }

  const topBookLiquidityUsdc = getTopBookLiquidityUsdc(book);
  const hasPairInventory =
    (currentPosition?.shares ?? 0) > EPSILON ||
    (opposingPosition?.shares ?? 0) > EPSILON;

  if (
    !hasPairInventory &&
    topBookLiquidityUsdc + EPSILON < config.marketMaker.minTopBookLiquidityUsdc
  ) {
    return {
      status: "rejected",
      reason: "top_book_liquidity_too_thin",
      detail: `${outcome} topBookLiquidityUsdc(${topBookLiquidityUsdc.toFixed(2)}) < minTopBookLiquidityUsdc(${config.marketMaker.minTopBookLiquidityUsdc.toFixed(2)})`
    };
  }

  const midpoint = (bestBid.price + bestAsk.price) / 2;
  const desiredHalfSpread =
    config.marketMaker.quoteHalfSpreadTicks *
    (throttle?.quoteHalfSpreadTicksMultiplier ?? 1) *
    tickSize;
  const rewardCapHalfSpread =
    config.marketMaker.enableRewardConstraints &&
    typeof market.rewardsMaxSpread === "number" &&
    Number.isFinite(market.rewardsMaxSpread) &&
    market.rewardsMaxSpread > 0
      ? market.rewardsMaxSpread / 2
      : Number.POSITIVE_INFINITY;
  const baseHalfSpread = Math.min(desiredHalfSpread, rewardCapHalfSpread);
  // 🚫 bestBid/bestAsk 추격 금지. buyMinInwardFromBidTicks > 0 이면 BUY 호가는
  // 반드시 bestBid보다 N틱 아래에 있어야 한다 (tight spread에서 추격 방지).
  // 0이면 레거시 동작(BUY를 bestBid까지 끌어올릴 수 있음).
  const buyInwardFromBidTicks = config.marketMaker.buyMinInwardFromBidTicks;
  const sellOutwardFromAskTicks = config.marketMaker.sellMinOutwardFromAskTicks;
  const bidTargetFromMidpoint = roundDownToTick(midpoint - baseHalfSpread, tickSize);
  const askTargetFromMidpoint = roundUpToTick(midpoint + baseHalfSpread, tickSize);

  let bidPrice: number;
  if (buyInwardFromBidTicks > 0) {
    // 새 정책: bestBid - N틱 이하로만 허용.
    const buyMaxBidAnchor = clampPrice(
      bestBid.price - buyInwardFromBidTicks * tickSize,
      tickSize
    );
    bidPrice = clampPrice(
      Math.min(bidTargetFromMidpoint, buyMaxBidAnchor, bestAsk.price - tickSize),
      tickSize
    );
  } else {
    // 레거시: target과 bestBid 중 높은 쪽 (BUY가 bestBid 아래로 내려가는 것만 방지).
    bidPrice = clampPrice(
      Math.min(Math.max(bidTargetFromMidpoint, bestBid.price), bestAsk.price - tickSize),
      tickSize
    );
  }

  let askPrice: number;
  if (sellOutwardFromAskTicks > 0) {
    // 새 정책: bestAsk + N틱 이상으로만 허용.
    const sellMinAskAnchor = clampPrice(
      bestAsk.price + sellOutwardFromAskTicks * tickSize,
      tickSize
    );
    askPrice = clampPrice(
      Math.max(askTargetFromMidpoint, sellMinAskAnchor, bestBid.price + tickSize),
      tickSize
    );
  } else {
    // 레거시: target과 bestAsk 중 낮은 쪽.
    askPrice = clampPrice(
      Math.max(Math.min(askTargetFromMidpoint, bestAsk.price), bestBid.price + tickSize),
      tickSize
    );
  }
  const rebateEfficiencyScore =
    market.feesEnabled && config.marketMaker.enableRebateBias
      ? estimateRebateEfficiencyScore(midpoint, market.category)
      : 0;
  const quoteSpreadTicks = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
  const maxOneSidedInwardTicks = Math.max(0, quoteSpreadTicks - 1);
  const rebatePrioritySide =
    rebateEfficiencyScore >= config.marketMaker.rebatePriorityThreshold && maxOneSidedInwardTicks > 0
      ? chooseRebatePrioritySide(midpoint, tokenIndex)
      : undefined;
  const maxScheduledRebateInwardTicks =
    config.marketMaker.rebateMaxInwardTicks +
    (config.marketMaker.enableRewardRebateScheduling
      ? config.marketMaker.rebateSchedulingExtraInwardTicks
      : 0);
  const rebateInwardTicks = rebatePrioritySide
    ? Math.min(maxScheduledRebateInwardTicks, maxOneSidedInwardTicks)
    : 0;

  if (rebatePrioritySide === Side.BUY) {
    bidPrice = clampPrice(
      Math.min(bestAsk.price - tickSize, bidPrice + rebateInwardTicks * tickSize),
      tickSize
    );
  } else if (rebatePrioritySide === Side.SELL) {
    askPrice = clampPrice(
      Math.max(bestBid.price + tickSize, askPrice - rebateInwardTicks * tickSize),
      tickSize
    );
  }

  const inventorySkew = resolveInventorySkewAdjustments(currentPosition, opposingPosition);
  const spreadTicksAfterRebate = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
  const maxBuyInwardTicks = Math.max(0, spreadTicksAfterRebate - 1);
  const buyInwardTicks = Math.max(0, inventorySkew.buyAdjustmentTicks);
  const buyOutwardTicks = Math.max(0, -inventorySkew.buyAdjustmentTicks);

  if (buyInwardTicks > 0) {
    bidPrice = clampPrice(
      Math.min(
        bestAsk.price - tickSize,
        bidPrice + Math.min(maxBuyInwardTicks, buyInwardTicks) * tickSize
      ),
      tickSize
    );
  } else if (buyOutwardTicks > 0) {
    bidPrice = clampPrice(Math.max(tickSize, bidPrice - buyOutwardTicks * tickSize), tickSize);
  }

  const spreadTicksAfterBuySkew = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
  const maxSellInwardTicks = Math.max(0, spreadTicksAfterBuySkew - 1);
  const sellInwardTicks = Math.max(0, inventorySkew.sellAdjustmentTicks);
  const sellOutwardTicks = Math.max(0, -inventorySkew.sellAdjustmentTicks);

  if (sellInwardTicks > 0) {
    askPrice = clampPrice(
      Math.max(
        bestBid.price + tickSize,
        askPrice - Math.min(maxSellInwardTicks, sellInwardTicks) * tickSize
      ),
      tickSize
    );
  } else if (sellOutwardTicks > 0) {
    askPrice = clampPrice(Math.min(1 - tickSize, askPrice + sellOutwardTicks * tickSize), tickSize);
  }

  const fillRateFeedbackInwardTicks = Math.max(0, fillRateFeedback?.inwardTicks ?? 0);

  if (fillRateFeedbackInwardTicks > 0) {
    const spreadTicksAfterInventorySkew = Math.max(
      0,
      Math.round((askPrice - bidPrice) / tickSize)
    );
    const maxFeedbackBuyInwardTicks = Math.max(0, spreadTicksAfterInventorySkew - 1);
    const buyFeedbackTicks = Math.min(maxFeedbackBuyInwardTicks, fillRateFeedbackInwardTicks);

    if (buyFeedbackTicks > 0) {
      bidPrice = clampPrice(
        Math.min(bestAsk.price - tickSize, bidPrice + buyFeedbackTicks * tickSize),
        tickSize
      );
    }

    const spreadTicksAfterBuyFeedback = Math.max(0, Math.round((askPrice - bidPrice) / tickSize));
    const maxFeedbackSellInwardTicks = Math.max(0, spreadTicksAfterBuyFeedback - 1);
    const sellFeedbackTicks = Math.min(
      maxFeedbackSellInwardTicks,
      fillRateFeedbackInwardTicks
    );

    if (sellFeedbackTicks > 0) {
      askPrice = clampPrice(
        Math.max(bestBid.price + tickSize, askPrice - sellFeedbackTicks * tickSize),
        tickSize
      );
    }
  }

  const tapePressureAdjustedQuotes = applyTapePressureBias(
    bidPrice,
    askPrice,
    bestBid.price,
    bestAsk.price,
    tickSize,
    book.tapePressure
  );
  bidPrice = tapePressureAdjustedQuotes.bidPrice;
  askPrice = tapePressureAdjustedQuotes.askPrice;

  const anchoredQuotes = applyTouchQuoteAnchoring(
    bidPrice,
    askPrice,
    bestBid.price,
    bestAsk.price,
    tickSize
  );
  bidPrice = anchoredQuotes.bidPrice;
  askPrice = anchoredQuotes.askPrice;

  if (bidPrice + EPSILON >= askPrice || bidPrice + EPSILON >= bestAsk.price || askPrice <= bestBid.price + EPSILON) {
    return {
      status: "rejected",
      reason: "invalid_quote_shape",
      detail: `${outcome} quote shape invalid at bid(${bidPrice.toFixed(4)}) ask(${askPrice.toFixed(4)})`
    };
  }

  const size = resolveQuoteSize(market, throttle);
  const expiration = resolveOrderExpiration();
  const rewardEligible =
    typeof market.rewardsMinSize === "number" &&
    market.rewardsMinSize > 0 &&
    typeof market.rewardsMaxSpread === "number" &&
    market.rewardsMaxSpread > 0 &&
    size + EPSILON >= market.rewardsMinSize &&
    askPrice - bidPrice <= market.rewardsMaxSpread + EPSILON;

  return {
    tokenId,
    outcome,
    midpoint,
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    observedSpread,
    observedSpreadTicks,
    topBookLiquidityUsdc,
    rewardEligible,
    rebateEfficiencyScore,
    rebatePrioritySide,
    rebateInwardTicks,
    inventoryShares: inventorySkew.inventoryShares,
    opposingInventoryShares: inventorySkew.opposingInventoryShares,
    inventorySkewRatio: inventorySkew.inventorySkewRatio,
    inventoryBuyAdjustmentTicks: inventorySkew.buyAdjustmentTicks,
    inventorySellAdjustmentTicks: inventorySkew.sellAdjustmentTicks,
    fillRateFeedbackInwardTicks,
    tapePressureBiasSide: tapePressureAdjustedQuotes.biasSide,
    tapePressureBiasTicks: tapePressureAdjustedQuotes.biasTicks,
    tapePressureScore: tapePressureAdjustedQuotes.pressureScore,
    tapePressureTradesPerMinute: tapePressureAdjustedQuotes.tradesPerMinute,
    quotes: [
      {
        tokenId,
        outcome,
        side: Side.BUY,
        price: bidPrice,
        size,
        tickSize,
        negRisk: book.negRisk,
        postOnly: true,
        orderType: config.marketMaker.orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
        expiration
      },
      {
        tokenId,
        outcome,
        side: Side.SELL,
        price: askPrice,
        size,
        tickSize,
        negRisk: book.negRisk,
        postOnly: true,
        orderType: config.marketMaker.orderType === "GTD" ? OrderType.GTD : OrderType.GTC,
        expiration
      }
    ]
  };
};

export const evaluateMarketMakerPlan = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook,
  throttle?: RiskExecutionThrottleSnapshot,
  inventoryPositionsByTokenId?: ReadonlyMap<string, TrackedInventoryPosition | undefined>,
  fillRateFeedback?: MarketMakerFillRateFeedback
): MarketMakerEvaluation => {
  const tokenPlanA = buildTokenQuotePlan(
    market,
    market.tokenIds[0],
    market.outcomes[0],
    bookA,
    0,
    inventoryPositionsByTokenId?.get(market.tokenIds[0]),
    inventoryPositionsByTokenId?.get(market.tokenIds[1]),
    throttle,
    fillRateFeedback
  );

  if (isRejectedTokenPlan(tokenPlanA)) {
    return tokenPlanA;
  }

  const tokenPlanB = buildTokenQuotePlan(
    market,
    market.tokenIds[1],
    market.outcomes[1],
    bookB,
    1,
    inventoryPositionsByTokenId?.get(market.tokenIds[1]),
    inventoryPositionsByTokenId?.get(market.tokenIds[0]),
    throttle,
    fillRateFeedback
  );

  if (isRejectedTokenPlan(tokenPlanB)) {
    return tokenPlanB;
  }

  return {
    status: "ready",
    plan: {
      market,
      generatedAtMs: Date.now(),
      rewardActive: Boolean(
        (market.rewardRatePerDay ?? 0) > 0 ||
          ((market.rewardsMinSize ?? 0) > 0 && (market.rewardsMaxSpread ?? 0) > 0)
      ),
      executionThrottle: throttle
        ? {
            state: throttle.state,
            dominantReason: throttle.dominantReason,
            quoteSizeMultiplier: throttle.quoteSizeMultiplier,
            quoteHalfSpreadTicksMultiplier: throttle.quoteHalfSpreadTicksMultiplier
          }
        : undefined,
      fillRateFeedback,
      quotes: [...tokenPlanA.quotes, ...tokenPlanB.quotes],
      tokenPlans: [tokenPlanA, tokenPlanB]
    }
  };
};
