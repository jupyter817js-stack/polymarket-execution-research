import { config } from "../config.js";
import type {
  BinaryMarket,
  NormalizedOrderBook,
  SameMarketEvaluationDiagnostics,
  SameMarketEvaluation,
  SameMarketRejectReason,
  SameMarketOpportunity
} from "../types.js";
import { clampPrice, getExecutableTickSize, roundUpToTick } from "../utils.js";
import { estimateBuyFee } from "./fees.js";
import { calculateBuyFill } from "./vwap.js";

const getAvailableDepth = (book: NormalizedOrderBook): number =>
  book.asks.reduce((total, level) => total + level.size, 0);

const getExecutableDepthAtLimit = (
  book: NormalizedOrderBook,
  limitPrice: number
): number =>
  book.asks.reduce(
    (total, level) =>
      level.price <= limitPrice + DECIMAL_TOLERANCE ? total + level.size : total,
    0
  );

const MARKETABLE_BUY_MIN_NOTIONAL = 1;
const MAX_MARKETABLE_BUY_MAKER_DECIMALS = 2;
const MAX_ORDER_SIZE_DECIMALS = 5;
const DECIMAL_TOLERANCE = 1e-8;
const ORDER_SIZE_SCALE = 10 ** MAX_ORDER_SIZE_DECIMALS;
const MAX_DECIMAL_PARSE_PLACES = 8;

const getPositiveMinOrderSize = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const roundToDecimals = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const roundUpToOrderSizePrecision = (value: number): number =>
  roundToDecimals(
    Math.ceil((Math.max(value, 0) - DECIMAL_TOLERANCE) * ORDER_SIZE_SCALE) / ORDER_SIZE_SCALE,
    MAX_ORDER_SIZE_DECIMALS
  );

const hasMaxDecimals = (value: number, decimals: number): boolean =>
  Math.abs(value - roundToDecimals(value, decimals)) <= DECIMAL_TOLERANCE;

const gcdBigInt = (a: bigint, b: bigint): bigint => {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;

  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }

  return left;
};

const toDecimalRatio = (value: number): { units: bigint; scale: bigint } => {
  const normalized =
    value
      .toFixed(MAX_DECIMAL_PARSE_PLACES)
      .replace(/\.?0+$/, "")
      .trim() || "0";
  const [whole = "0", fraction = ""] = normalized.split(".");
  const scale = BigInt(10 ** fraction.length);
  const unitsText = fraction ? `${whole}${fraction}` : whole;
  return {
    units: BigInt(unitsText),
    scale
  };
};

const getPrecisionCompatibleShareQuantum = (price: number): number => {
  const { units: priceUnits, scale: priceScale } = toDecimalRatio(price);
  const sizeScale = BigInt(ORDER_SIZE_SCALE);
  const notionalScale = BigInt(10 ** MAX_MARKETABLE_BUY_MAKER_DECIMALS);
  const denominator = priceScale * sizeScale;
  const divisor = gcdBigInt(priceUnits * notionalScale, denominator);
  const shareQuantumUnits = denominator / divisor;
  return Number(shareQuantumUnits) / ORDER_SIZE_SCALE;
};

const roundUpToShareQuantum = (value: number, shareQuantum: number): number => {
  const minimum = roundUpToOrderSizePrecision(value);

  if (shareQuantum <= 0) {
    return minimum;
  }

  return roundUpToOrderSizePrecision(
    Math.ceil((minimum - DECIMAL_TOLERANCE) / shareQuantum) * shareQuantum
  );
};

const getAutoAdjustedSharesForLimitPrice = (limitPrice: number, minimumShares: number): number => {
  const minimumTargetNotional = Math.max(
    config.strategy.targetOrderNotionalUsdc,
    MARKETABLE_BUY_MIN_NOTIONAL
  );
  const minimumNotionalShares = minimumTargetNotional / limitPrice;
  return roundUpToShareQuantum(
    Math.max(minimumShares, minimumNotionalShares),
    getPrecisionCompatibleShareQuantum(limitPrice)
  );
};

const getBookAgeMs = (updatedAtMs: number, evaluatedAtMs: number): number => {
  if (!Number.isFinite(updatedAtMs)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, evaluatedAtMs - updatedAtMs);
};

const getBookTimingRejectReason = (
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook,
  evaluatedAtMs: number
): SameMarketRejectReason | undefined => {
  const bookAgeA = getBookAgeMs(bookA.updatedAtMs, evaluatedAtMs);
  const bookAgeB = getBookAgeMs(bookB.updatedAtMs, evaluatedAtMs);
  const bookTimestampSkewMs = Math.abs(bookA.updatedAtMs - bookB.updatedAtMs);

  if (bookAgeA > config.strategy.maxBookStalenessMs) {
    return "stale_book_leg_a";
  }

  if (bookAgeB > config.strategy.maxBookStalenessMs) {
    return "stale_book_leg_b";
  }

  if (bookTimestampSkewMs > config.strategy.maxBookSkewMs) {
    return "book_timestamp_skew_too_wide";
  }

  return undefined;
};

const buildExecutionPlan = (
  shares: number,
  worstPrice: number,
  tickSize: number,
  leg: "a" | "b"
): {
  limitPrice: number;
  orderNotional: number;
  rejectReason?: SameMarketRejectReason;
} => {
  const limitPrice = clampPrice(
    roundUpToTick(worstPrice + config.strategy.buyPriceBuffer, tickSize),
    tickSize
  );
  const orderNotional = shares * limitPrice;

  if (orderNotional + DECIMAL_TOLERANCE < MARKETABLE_BUY_MIN_NOTIONAL) {
    return {
      limitPrice,
      orderNotional,
      rejectReason:
        leg === "a"
          ? "marketable_buy_min_notional_leg_a"
          : "marketable_buy_min_notional_leg_b"
    };
  }

  if (
    !hasMaxDecimals(shares, MAX_ORDER_SIZE_DECIMALS) ||
    !hasMaxDecimals(orderNotional, MAX_MARKETABLE_BUY_MAKER_DECIMALS)
  ) {
    return {
      limitPrice,
      orderNotional,
      rejectReason:
        leg === "a"
          ? "marketable_buy_precision_invalid_leg_a"
          : "marketable_buy_precision_invalid_leg_b"
    };
  }

  return {
    limitPrice,
    orderNotional
  };
};

const getEntryDepthRejectReason = (
  executableDepthAtLimit: number,
  requiredDepthAtLimit: number,
  leg: "a" | "b"
): SameMarketRejectReason | undefined => {
  if (executableDepthAtLimit + DECIMAL_TOLERANCE >= requiredDepthAtLimit) {
    return undefined;
  }

  return leg === "a"
    ? "entry_depth_ratio_too_shallow_leg_a"
    : "entry_depth_ratio_too_shallow_leg_b";
};

export const getEffectiveOrderMinSize = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook
): number =>
  Math.max(
    getPositiveMinOrderSize(market.orderMinSize),
    getPositiveMinOrderSize(bookA.minOrderSize),
    getPositiveMinOrderSize(bookB.minOrderSize)
  );

const resolveEntryShares = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook
): {
  configuredTargetShares: number;
  effectiveOrderMinSize: number;
  shares: number;
} => {
  const configuredTargetShares = config.strategy.targetShares;
  const effectiveOrderMinSize = getEffectiveOrderMinSize(market, bookA, bookB);
  const minimumShares = Math.max(configuredTargetShares, effectiveOrderMinSize);
  const legATickSize = getExecutableTickSize(bookA.tickSize, market.orderPriceMinTickSize);
  const legBTickSize = getExecutableTickSize(bookB.tickSize, market.orderPriceMinTickSize);
  let shares = roundUpToOrderSizePrecision(minimumShares);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const fillA = calculateBuyFill(bookA.asks, shares);
    const fillB = calculateBuyFill(bookB.asks, shares);

    if (!fillA || !fillB) {
      break;
    }

    const legAPlan = buildExecutionPlan(shares, fillA.worstPrice, legATickSize, "a");
    const legBPlan = buildExecutionPlan(shares, fillB.worstPrice, legBTickSize, "b");
    const nextShares = Math.max(
      minimumShares,
      getAutoAdjustedSharesForLimitPrice(legAPlan.limitPrice, minimumShares),
      getAutoAdjustedSharesForLimitPrice(legBPlan.limitPrice, minimumShares)
    );

    if (nextShares <= shares + DECIMAL_TOLERANCE) {
      break;
    }

    shares = nextShares;
  }

  return {
    configuredTargetShares,
    effectiveOrderMinSize,
    shares
  };
};

export const buildSameMarketOpportunitySnapshot = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook,
  feeRateA: number,
  feeRateB: number
): SameMarketOpportunity | undefined => {
  const evaluatedAtMs = Date.now();
  const { effectiveOrderMinSize, shares } = resolveEntryShares(market, bookA, bookB);
  const timingRejectReason = getBookTimingRejectReason(bookA, bookB, evaluatedAtMs);

  if (timingRejectReason) {
    return undefined;
  }

  if (shares < effectiveOrderMinSize) {
    return undefined;
  }

  const fillA = calculateBuyFill(bookA.asks, shares);
  const fillB = calculateBuyFill(bookB.asks, shares);

  if (!fillA || !fillB) {
    return undefined;
  }

  const grossCost = fillA.totalCost + fillB.totalCost;
  const grossEdge = shares - grossCost;
  const feeCost =
    estimateBuyFee(fillA, feeRateA, config.strategy.feePriceExponent) +
    estimateBuyFee(fillB, feeRateB, config.strategy.feePriceExponent);
  const netEdge = grossEdge - feeCost;
  const netEdgeBpsOnPar = (netEdge / shares) * 10_000;
  const grossCostPerShare = grossCost / shares;
  const legATickSize = getExecutableTickSize(bookA.tickSize, market.orderPriceMinTickSize);
  const legBTickSize = getExecutableTickSize(bookB.tickSize, market.orderPriceMinTickSize);
  const legAPlan = buildExecutionPlan(shares, fillA.worstPrice, legATickSize, "a");
  const legBPlan = buildExecutionPlan(shares, fillB.worstPrice, legBTickSize, "b");
  const requiredDepthAtLimit = shares * config.strategy.entryMinDepthRatio;
  const legAExecutableDepthAtLimit = getExecutableDepthAtLimit(bookA, legAPlan.limitPrice);
  const legBExecutableDepthAtLimit = getExecutableDepthAtLimit(bookB, legBPlan.limitPrice);
  const legADepthRejectReason = getEntryDepthRejectReason(
    legAExecutableDepthAtLimit,
    requiredDepthAtLimit,
    "a"
  );
  const legBDepthRejectReason = getEntryDepthRejectReason(
    legBExecutableDepthAtLimit,
    requiredDepthAtLimit,
    "b"
  );

  if (grossCostPerShare > config.strategy.maxEntryGrossCostPerShare) {
    return undefined;
  }

  if (legAPlan.rejectReason || legBPlan.rejectReason || legADepthRejectReason || legBDepthRejectReason) {
    return undefined;
  }

  return {
    market,
    shares,
    grossCost,
    grossCostPerShare,
    grossEdge,
    feeCost,
    netEdge,
    netEdgeBpsOnPar,
    legs: [
      {
        tokenId: market.tokenIds[0],
        outcome: market.outcomes[0],
        fill: fillA,
        tickSize: legATickSize,
        limitPrice: legAPlan.limitPrice,
        feeRateBps: feeRateA
      },
      {
        tokenId: market.tokenIds[1],
        outcome: market.outcomes[1],
        fill: fillB,
        tickSize: legBTickSize,
        limitPrice: legBPlan.limitPrice,
        feeRateBps: feeRateB
      }
    ],
    detectedAtMs: evaluatedAtMs
  };
};

export const inspectSameMarketEvaluation = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook,
  feeRateA: number,
  feeRateB: number
): SameMarketEvaluation => {
  const evaluatedAtMs = Date.now();
  const bookAgeA = getBookAgeMs(bookA.updatedAtMs, evaluatedAtMs);
  const bookAgeB = getBookAgeMs(bookB.updatedAtMs, evaluatedAtMs);
  const bookTimestampSkewMs = Math.abs(bookA.updatedAtMs - bookB.updatedAtMs);
  const { configuredTargetShares, effectiveOrderMinSize, shares } = resolveEntryShares(
    market,
    bookA,
    bookB
  );
  const diagnostics: SameMarketEvaluationDiagnostics = {
    market,
    evaluatedAtMs,
    configuredTargetShares,
    shares,
    sharesAutoAdjusted: shares > configuredTargetShares + DECIMAL_TOLERANCE,
    marketOrderMinSize: market.orderMinSize,
    bookOrderMinSizeA: bookA.minOrderSize,
    bookOrderMinSizeB: bookB.minOrderSize,
    effectiveOrderMinSize,
    targetOrderNotionalUsdc: config.strategy.targetOrderNotionalUsdc,
    maxBookStalenessMs: config.strategy.maxBookStalenessMs,
    maxBookSkewMs: config.strategy.maxBookSkewMs,
    maxEntryGrossCostPerShare: config.strategy.maxEntryGrossCostPerShare,
    entryMinDepthRatio: config.strategy.entryMinDepthRatio,
    bookTimestampSkewMs,
    topOfBookSum:
      bookA.asks[0] && bookB.asks[0] ? bookA.asks[0].price + bookB.asks[0].price : undefined,
    legA: {
      tokenId: market.tokenIds[0],
      outcome: market.outcomes[0],
      updatedAtMs: bookA.updatedAtMs,
      bookAgeMs: bookAgeA,
      bestAsk: bookA.asks[0]?.price,
      availableDepth: getAvailableDepth(bookA),
      feeRateBps: feeRateA
    },
    legB: {
      tokenId: market.tokenIds[1],
      outcome: market.outcomes[1],
      updatedAtMs: bookB.updatedAtMs,
      bookAgeMs: bookAgeB,
      bestAsk: bookB.asks[0]?.price,
      availableDepth: getAvailableDepth(bookB),
      feeRateBps: feeRateB
    }
  };

  const timingRejectReason = getBookTimingRejectReason(bookA, bookB, evaluatedAtMs);

  if (timingRejectReason) {
    return {
      status: "rejected",
      reason: timingRejectReason,
      diagnostics
    };
  }

  if (shares < effectiveOrderMinSize) {
    return {
      status: "rejected",
      reason: "target_shares_below_order_min_size",
      diagnostics
    };
  }

  const fillA = calculateBuyFill(bookA.asks, shares);
  const fillB = calculateBuyFill(bookB.asks, shares);

  diagnostics.legA.averagePrice = fillA?.averagePrice;
  diagnostics.legA.worstPrice = fillA?.worstPrice;
  diagnostics.legB.averagePrice = fillB?.averagePrice;
  diagnostics.legB.worstPrice = fillB?.worstPrice;

  if (!fillA) {
    return {
      status: "rejected",
      reason: "insufficient_depth_leg_a",
      diagnostics
    };
  }

  if (!fillB) {
    return {
      status: "rejected",
      reason: "insufficient_depth_leg_b",
      diagnostics
    };
  }

  const legATickSize = getExecutableTickSize(bookA.tickSize, market.orderPriceMinTickSize);
  const legBTickSize = getExecutableTickSize(bookB.tickSize, market.orderPriceMinTickSize);
  const legAPlan = buildExecutionPlan(shares, fillA.worstPrice, legATickSize, "a");
  const legBPlan = buildExecutionPlan(shares, fillB.worstPrice, legBTickSize, "b");
  const requiredDepthAtLimit = shares * diagnostics.entryMinDepthRatio;
  const legAExecutableDepthAtLimit = getExecutableDepthAtLimit(bookA, legAPlan.limitPrice);
  const legBExecutableDepthAtLimit = getExecutableDepthAtLimit(bookB, legBPlan.limitPrice);

  diagnostics.legA.limitPrice = legAPlan.limitPrice;
  diagnostics.legA.orderNotional = legAPlan.orderNotional;
  diagnostics.legA.executableDepthAtLimit = legAExecutableDepthAtLimit;
  diagnostics.legA.requiredDepthAtLimit = requiredDepthAtLimit;
  diagnostics.legB.limitPrice = legBPlan.limitPrice;
  diagnostics.legB.orderNotional = legBPlan.orderNotional;
  diagnostics.legB.executableDepthAtLimit = legBExecutableDepthAtLimit;
  diagnostics.legB.requiredDepthAtLimit = requiredDepthAtLimit;

  if (legAPlan.rejectReason) {
    return {
      status: "rejected",
      reason: legAPlan.rejectReason,
      diagnostics
    };
  }

  if (legBPlan.rejectReason) {
    return {
      status: "rejected",
      reason: legBPlan.rejectReason,
      diagnostics
    };
  }

  const legADepthRejectReason = getEntryDepthRejectReason(
    legAExecutableDepthAtLimit,
    requiredDepthAtLimit,
    "a"
  );

  if (legADepthRejectReason) {
    return {
      status: "rejected",
      reason: legADepthRejectReason,
      diagnostics
    };
  }

  const legBDepthRejectReason = getEntryDepthRejectReason(
    legBExecutableDepthAtLimit,
    requiredDepthAtLimit,
    "b"
  );

  if (legBDepthRejectReason) {
    return {
      status: "rejected",
      reason: legBDepthRejectReason,
      diagnostics
    };
  }

  const grossCost = fillA.totalCost + fillB.totalCost;
  const grossEdge = shares - grossCost;
  diagnostics.grossCost = grossCost;
  diagnostics.grossCostPerShare = grossCost / shares;
  diagnostics.grossEdge = grossEdge;

  if (diagnostics.grossCostPerShare > diagnostics.maxEntryGrossCostPerShare) {
    return {
      status: "rejected",
      reason: "gross_cost_above_entry_cap",
      diagnostics
    };
  }

  if (grossEdge <= 0) {
    return {
      status: "rejected",
      reason: "gross_edge_non_positive",
      diagnostics
    };
  }

  const feeCost =
    estimateBuyFee(fillA, feeRateA, config.strategy.feePriceExponent) +
    estimateBuyFee(fillB, feeRateB, config.strategy.feePriceExponent);
  const netEdge = grossEdge - feeCost;
  const netEdgeBpsOnPar = (netEdge / shares) * 10_000;
  diagnostics.feeCost = feeCost;
  diagnostics.netEdge = netEdge;
  diagnostics.netEdgeBpsOnPar = netEdgeBpsOnPar;

  if (netEdge < config.strategy.minNetEdgeUsdc) {
    return {
      status: "rejected",
      reason: "net_edge_below_min_usdc",
      diagnostics
    };
  }

  if (netEdgeBpsOnPar < config.strategy.minNetEdgeBps) {
    return {
      status: "rejected",
      reason: "net_edge_below_min_bps",
      diagnostics
    };
  }

  return {
    status: "opportunity",
    diagnostics,
    opportunity: {
      market,
      shares,
      grossCost,
      grossCostPerShare: grossCost / shares,
      grossEdge,
      feeCost,
      netEdge,
      netEdgeBpsOnPar,
      legs: [
        {
          tokenId: market.tokenIds[0],
          outcome: market.outcomes[0],
          fill: fillA,
          tickSize: legATickSize,
          limitPrice: legAPlan.limitPrice,
          feeRateBps: feeRateA
        },
        {
          tokenId: market.tokenIds[1],
          outcome: market.outcomes[1],
          fill: fillB,
          tickSize: legBTickSize,
          limitPrice: legBPlan.limitPrice,
          feeRateBps: feeRateB
        }
      ],
      detectedAtMs: Date.now()
    }
  };
};

export const evaluateSameMarketOpportunity = (
  market: BinaryMarket,
  bookA: NormalizedOrderBook,
  bookB: NormalizedOrderBook,
  feeRateA: number,
  feeRateB: number
): SameMarketOpportunity | undefined => {
  const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, feeRateA, feeRateB);

  if (evaluation.status !== "opportunity") {
    return undefined;
  }

  return evaluation.opportunity;
};
