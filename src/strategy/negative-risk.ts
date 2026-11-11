import type {
  BuyFill,
  BinaryMarket,
  NormalizedOrderBook,
  SellFill
} from "../types.js";
import { config } from "../config.js";
import { clampPrice, getExecutableTickSize, roundDownToTick, roundUpToTick } from "../utils.js";
import { estimateBuyFee, estimateSellFee } from "./fees.js";
import { calculateBuyFill, calculateSellFill } from "./vwap.js";

const DECIMAL_TOLERANCE = 1e-8;
const MARKETABLE_BUY_MIN_NOTIONAL = 1;
const MAX_MARKETABLE_BUY_MAKER_DECIMALS = 2;
const MAX_ORDER_SIZE_DECIMALS = 5;
const ORDER_SIZE_SCALE = 10 ** MAX_ORDER_SIZE_DECIMALS;
const MAX_DECIMAL_PARSE_PLACES = 8;
const QUESTION_ID_MASK = ~0xffn;
const BUY_PRICE_BUFFER = config.strategy.buyPriceBuffer;

export interface NegativeRiskGroup {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  marketId?: string;
  markets: BinaryMarket[];
  // Fix A (group completeness): populated by EventGroupRegistry after gamma fetch.
  // - expectedActiveMarketCount: total active+open+accepting markets in the negRisk event
  // - expectedQuestionIds: lowercased questionIDs of those active markets
  // - metadataFetchedAtMs: cache timestamp
  // When unset, evaluator rejects with `missing_event_metadata` (unless requireCompleteGroup is disabled).
  // When set, evaluator compares group.markets against this metadata; mismatch → `incomplete_group`.
  expectedActiveMarketCount?: number;
  expectedQuestionIds?: ReadonlySet<string>;
  metadataFetchedAtMs?: number;
}

export interface NegativeRiskLeg {
  market: BinaryMarket;
  tokenId: string;
  outcomeTitle: string;
  fill: BuyFill;
  tickSize: number;
  limitPrice: number;
  feeRateBps: number;
}

export interface NegativeRiskExitLeg {
  market: BinaryMarket;
  tokenId: string;
  outcomeTitle: string;
  fill: SellFill;
  tickSize: number;
  limitPrice: number;
  feeRateBps: number;
}

interface NegativeRiskOpportunityBase {
  kind: "yes-basket" | "no-to-yes-conversion";
  group: NegativeRiskGroup;
  shares: number;
  grossCost: number;
  grossCostPerShare: number;
  grossEdge: number;
  feeCost: number;
  netEdge: number;
  netEdgeBpsOnPar: number;
  detectedAtMs: number;
}

export interface NegativeRiskYesBasketOpportunity extends NegativeRiskOpportunityBase {
  kind: "yes-basket";
  legs: NegativeRiskLeg[];
}

export interface NegativeRiskNoConversionOpportunity extends NegativeRiskOpportunityBase {
  kind: "no-to-yes-conversion";
  entry: NegativeRiskLeg;
  exitLegs: NegativeRiskExitLeg[];
  grossProceeds: number;
  convertedSharesPerLeg: number;
  conversionFeeBps: number;
  conversionMarketId: string;
  conversionIndexSet: string;
  sourceQuestionIndex: number;
}

export type NegativeRiskOpportunity =
  | NegativeRiskYesBasketOpportunity
  | NegativeRiskNoConversionOpportunity;

export type NegativeRiskRejectReason =
  | "not_enough_markets"
  | "too_many_markets"
  | "missing_yes_token"
  | "missing_no_token"
  | "missing_conversion_metadata"
  | "missing_event_metadata"
  | "incomplete_group"
  | "yes_basket_disabled"
  | "stale_book"
  | "book_timestamp_skew_too_wide"
  | "insufficient_depth"
  | "target_shares_below_order_min_size"
  | "marketable_buy_min_notional"
  | "marketable_buy_precision_invalid"
  | "gross_cost_above_entry_cap"
  | "gross_edge_non_positive"
  | "net_edge_below_min_usdc"
  | "net_edge_below_min_bps";

export type NegativeRiskEvaluation =
  | {
      status: "opportunity";
      opportunity: NegativeRiskOpportunity;
      alternativeOpportunities: NegativeRiskOpportunity[];
    }
  | {
      status: "rejected";
      reason: NegativeRiskRejectReason;
      detail: string;
    };

type GroupLegContext = {
  market: BinaryMarket;
  yesTokenId: string;
  noTokenId?: string;
  outcomeTitle: string;
  yesBook: NormalizedOrderBook;
  noBook?: NormalizedOrderBook;
  yesFeeRateBps: number;
  noFeeRateBps: number;
  marketId?: string;
  questionIndex?: number;
};

type GroupValidation =
  | {
      status: "ok";
      contexts: GroupLegContext[];
      evaluatedAtMs: number;
    }
  | {
      status: "rejected";
      reason: NegativeRiskRejectReason;
      detail: string;
    };

type GroupContextRejection = {
  reason: NegativeRiskRejectReason;
  detail: string;
};

type GroupEvaluationResult =
  | {
      status: "opportunity";
      opportunity: NegativeRiskOpportunity;
    }
  | {
      status: "rejected";
      reason: NegativeRiskRejectReason;
      detail: string;
    };

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

const roundDownToOrderSizePrecision = (value: number): number =>
  roundToDecimals(
    Math.floor((Math.max(value, 0) + DECIMAL_TOLERANCE) * ORDER_SIZE_SCALE) / ORDER_SIZE_SCALE,
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

const getYesTokenId = (market: BinaryMarket): string | undefined => {
  const yesIndex = market.outcomes.findIndex((outcome) => outcome.trim().toLowerCase() === "yes");
  return yesIndex >= 0 ? market.tokenIds[yesIndex] : undefined;
};

const getNoTokenId = (market: BinaryMarket): string | undefined => {
  const noIndex = market.outcomes.findIndex((outcome) => outcome.trim().toLowerCase() === "no");
  return noIndex >= 0 ? market.tokenIds[noIndex] : undefined;
};

const getOutcomeTitle = (market: BinaryMarket): string =>
  market.groupItemTitle?.trim() || market.question;

const parseQuestionId = (
  questionId: string
): {
  marketId: string;
  questionIndex: number;
} | undefined => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(questionId)) {
    return undefined;
  }

  const questionIdValue = BigInt(questionId);
  const marketId = `0x${(questionIdValue & QUESTION_ID_MASK).toString(16).padStart(64, "0")}`;
  return {
    marketId,
    questionIndex: Number(questionIdValue & 0xffn)
  };
};

const buildBuyExecutionPlan = (
  shares: number,
  worstPrice: number,
  tickSize: number
): {
  limitPrice: number;
  orderNotional: number;
  rejectReason?: NegativeRiskRejectReason;
} => {
  const limitPrice = clampPrice(roundUpToTick(worstPrice + BUY_PRICE_BUFFER, tickSize), tickSize);
  const orderNotional = shares * limitPrice;

  if (orderNotional + DECIMAL_TOLERANCE < MARKETABLE_BUY_MIN_NOTIONAL) {
    return {
      limitPrice,
      orderNotional,
      rejectReason: "marketable_buy_min_notional"
    };
  }

  if (
    !hasMaxDecimals(shares, MAX_ORDER_SIZE_DECIMALS) ||
    !hasMaxDecimals(orderNotional, MAX_MARKETABLE_BUY_MAKER_DECIMALS)
  ) {
    return {
      limitPrice,
      orderNotional,
      rejectReason: "marketable_buy_precision_invalid"
    };
  }

  return {
    limitPrice,
    orderNotional
  };
};

const buildSellExecutionPlan = (
  worstPrice: number,
  tickSize: number
): {
  limitPrice: number;
} => ({
  limitPrice: clampPrice(roundDownToTick(worstPrice, tickSize), tickSize)
});

const sortOpportunities = (
  opportunities: NegativeRiskOpportunity[]
): NegativeRiskOpportunity[] =>
  [...opportunities].sort((left, right) => {
    if (Math.abs(right.netEdge - left.netEdge) > DECIMAL_TOLERANCE) {
      return right.netEdge - left.netEdge;
    }

    if (Math.abs(right.netEdgeBpsOnPar - left.netEdgeBpsOnPar) > DECIMAL_TOLERANCE) {
      return right.netEdgeBpsOnPar - left.netEdgeBpsOnPar;
    }

    return left.kind.localeCompare(right.kind);
  });

const buildGroupContexts = (
  group: NegativeRiskGroup,
  booksByTokenId: ReadonlyMap<string, NormalizedOrderBook>,
  feeRatesByTokenId: ReadonlyMap<string, number>
): GroupValidation => {
  // Fix C: minGroupMarkets gate. Default 3 — 2-outcome events are usually standard
  // binary markets (not negRisk). The Adapter's no-to-yes-conversion math (output =
  // (|indexSet| - 1) × shares) requires at least 3 outcomes for any meaningful arb.
  const minMarkets = Math.max(2, config.negativeRisk.minGroupMarkets);
  if (group.markets.length < minMarkets) {
    return {
      status: "rejected",
      reason: "not_enough_markets",
      detail: `groupMarkets(${group.markets.length}) < minGroupMarkets(${minMarkets})`
    };
  }

  if (group.markets.length > config.negativeRisk.maxGroupMarkets) {
    return {
      status: "rejected",
      reason: "too_many_markets",
      detail: `groupMarkets(${group.markets.length}) > maxGroupMarkets(${config.negativeRisk.maxGroupMarkets})`
    };
  }

  // Fix A: Group completeness gate.
  // The Negative Risk Adapter only returns $1 collateral when ALL outcomes of a negRisk
  // event are converted together. Universe filters can return only a subset of an event's
  // active markets (e.g., 2 of 19 candidates). Without this gate, yes-basket "arb" is a
  // directional bet on those specific outcomes winning — typical EV is strongly negative.
  if (config.negativeRisk.requireCompleteGroup) {
    if (
      group.expectedActiveMarketCount === undefined ||
      group.expectedQuestionIds === undefined
    ) {
      return {
        status: "rejected",
        reason: "missing_event_metadata",
        detail: `${group.eventSlug} has no expected market count from gamma — registry not yet populated`
      };
    }

    if (group.markets.length < group.expectedActiveMarketCount) {
      return {
        status: "rejected",
        reason: "incomplete_group",
        detail: `${group.eventSlug} groupMarkets(${group.markets.length}) < expectedActiveMarketCount(${group.expectedActiveMarketCount})`
      };
    }

    const localQuestionIds = new Set(
      group.markets
        .map((market) => market.questionId?.toLowerCase())
        .filter((qid): qid is string => Boolean(qid))
    );
    for (const expectedQid of group.expectedQuestionIds) {
      if (!localQuestionIds.has(expectedQid)) {
        return {
          status: "rejected",
          reason: "incomplete_group",
          detail: `${group.eventSlug} is missing expected questionId(${expectedQid})`
        };
      }
    }
  }

  const contexts: GroupLegContext[] = [];
  const evaluatedAtMs = Date.now();

  for (const market of group.markets) {
    const yesTokenId = getYesTokenId(market);

    if (!yesTokenId) {
      return {
        status: "rejected",
        reason: "missing_yes_token",
        detail: `${market.slug} does not expose an explicit Yes token`
      };
    }

    const yesBook = booksByTokenId.get(yesTokenId);

    if (!yesBook) {
      return {
        status: "rejected",
        reason: "insufficient_depth",
        detail: `${market.slug} is missing an orderbook for the Yes token`
      };
    }

    const yesBookAgeMs = getBookAgeMs(yesBook.updatedAtMs, evaluatedAtMs);

    if (yesBookAgeMs > config.strategy.maxBookStalenessMs) {
      return {
        status: "rejected",
        reason: "stale_book",
        detail: `${market.slug} yesBookAgeMs(${yesBookAgeMs}) > maxBookStalenessMs(${config.strategy.maxBookStalenessMs})`
      };
    }

    const noTokenId = getNoTokenId(market);
    const rawNoBook = noTokenId ? booksByTokenId.get(noTokenId) : undefined;
    const noBook =
      rawNoBook &&
      getBookAgeMs(rawNoBook.updatedAtMs, evaluatedAtMs) <= config.strategy.maxBookStalenessMs
        ? rawNoBook
        : undefined;

    const conversionMeta = parseQuestionId(market.questionId);

    contexts.push({
      market,
      yesTokenId,
      noTokenId,
      outcomeTitle: getOutcomeTitle(market),
      yesBook,
      noBook,
      yesFeeRateBps: feeRatesByTokenId.get(yesTokenId) ?? 0,
      noFeeRateBps: noTokenId ? feeRatesByTokenId.get(noTokenId) ?? 0 : 0,
      marketId: conversionMeta?.marketId,
      questionIndex: conversionMeta?.questionIndex
    });
  }

  return {
    status: "ok",
    contexts,
    evaluatedAtMs
  };
};

const resolveYesBasketShares = (contexts: readonly GroupLegContext[]): number => {
  const effectiveOrderMinSize = contexts.reduce(
    (current, context) =>
      Math.max(
        current,
        getPositiveMinOrderSize(context.market.orderMinSize),
        getPositiveMinOrderSize(context.yesBook.minOrderSize)
      ),
    0
  );
  const minimumShares = Math.max(config.negativeRisk.targetShares, effectiveOrderMinSize);
  let shares = roundUpToOrderSizePrecision(minimumShares);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    let nextShares = minimumShares;
    let allExecutable = true;

    for (const context of contexts) {
      const fill = calculateBuyFill(context.yesBook.asks, shares);

      if (!fill) {
        allExecutable = false;
        break;
      }

      const tickSize = getExecutableTickSize(
        context.yesBook.tickSize,
        context.market.orderPriceMinTickSize
      );
      const executionPlan = buildBuyExecutionPlan(shares, fill.worstPrice, tickSize);
      nextShares = Math.max(
        nextShares,
        getAutoAdjustedSharesForLimitPrice(executionPlan.limitPrice, minimumShares)
      );
    }

    if (!allExecutable || nextShares <= shares + DECIMAL_TOLERANCE) {
      break;
    }

    shares = nextShares;
  }

  return shares;
};

const evaluateYesBasketOpportunity = (
  group: NegativeRiskGroup,
  contexts: readonly GroupLegContext[],
  evaluatedAtMs: number
): GroupEvaluationResult => {
  const oldestBook = Math.min(...contexts.map((context) => context.yesBook.updatedAtMs));
  const newestBook = Math.max(...contexts.map((context) => context.yesBook.updatedAtMs));
  const bookTimestampSkewMs = newestBook - oldestBook;

  if (bookTimestampSkewMs > config.strategy.maxBookSkewMs) {
    return {
      status: "rejected",
      reason: "book_timestamp_skew_too_wide",
      detail: `yesBasket bookTimestampSkewMs(${bookTimestampSkewMs}) > maxBookSkewMs(${config.strategy.maxBookSkewMs})`
    };
  }

  const shares = resolveYesBasketShares(contexts);
  const effectiveOrderMinSize = contexts.reduce(
    (current, context) =>
      Math.max(
        current,
        getPositiveMinOrderSize(context.market.orderMinSize),
        getPositiveMinOrderSize(context.yesBook.minOrderSize)
      ),
    0
  );

  if (shares < effectiveOrderMinSize) {
    return {
      status: "rejected",
      reason: "target_shares_below_order_min_size",
      detail: `yesBasket shares(${shares}) < effectiveOrderMinSize(${effectiveOrderMinSize})`
    };
  }

  const executedLegs: NegativeRiskLeg[] = [];

  for (const context of contexts) {
    const fill = calculateBuyFill(context.yesBook.asks, shares);

    if (!fill) {
      return {
        status: "rejected",
        reason: "insufficient_depth",
        detail: `${context.market.slug} does not have enough Yes ask depth for ${shares} shares`
      };
    }

    const tickSize = getExecutableTickSize(
      context.yesBook.tickSize,
      context.market.orderPriceMinTickSize
    );
    const executionPlan = buildBuyExecutionPlan(shares, fill.worstPrice, tickSize);

    if (executionPlan.rejectReason) {
      return {
        status: "rejected",
        reason: executionPlan.rejectReason,
        detail: `${context.market.slug} failed Yes-basket marketable BUY constraints at limitPrice(${executionPlan.limitPrice.toFixed(4)})`
      };
    }

    executedLegs.push({
      market: context.market,
      tokenId: context.yesTokenId,
      outcomeTitle: context.outcomeTitle,
      fill,
      tickSize,
      limitPrice: executionPlan.limitPrice,
      feeRateBps: context.yesFeeRateBps
    });
  }

  const grossCost = executedLegs.reduce((total, leg) => total + leg.fill.totalCost, 0);
  const grossCostPerShare = grossCost / shares;

  if (grossCostPerShare > config.negativeRisk.maxEntryGrossCostPerShare) {
    return {
      status: "rejected",
      reason: "gross_cost_above_entry_cap",
      detail: `yesBasket grossCostPerShare(${grossCostPerShare.toFixed(4)}) > maxEntryGrossCostPerShare(${config.negativeRisk.maxEntryGrossCostPerShare.toFixed(4)})`
    };
  }

  const grossEdge = shares - grossCost;

  if (grossEdge <= 0) {
    return {
      status: "rejected",
      reason: "gross_edge_non_positive",
      detail: `yesBasket grossEdge(${grossEdge.toFixed(4)}) <= 0`
    };
  }

  const feeCost = executedLegs.reduce(
    (total, leg) =>
      total + estimateBuyFee(leg.fill, leg.feeRateBps, config.strategy.feePriceExponent),
    0
  );
  const netEdge = grossEdge - feeCost;
  const netEdgeBpsOnPar = (netEdge / shares) * 10_000;

  if (netEdge < config.negativeRisk.minNetEdgeUsdc) {
    return {
      status: "rejected",
      reason: "net_edge_below_min_usdc",
      detail: `yesBasket netEdge(${netEdge.toFixed(4)}) < minNetEdgeUsdc(${config.negativeRisk.minNetEdgeUsdc.toFixed(4)})`
    };
  }

  if (netEdgeBpsOnPar < config.negativeRisk.minNetEdgeBps) {
    return {
      status: "rejected",
      reason: "net_edge_below_min_bps",
      detail: `yesBasket netEdgeBpsOnPar(${netEdgeBpsOnPar.toFixed(2)}) < minNetEdgeBps(${config.negativeRisk.minNetEdgeBps.toFixed(2)})`
    };
  }

  return {
    status: "opportunity",
    opportunity: {
      kind: "yes-basket",
      group,
      shares,
      grossCost,
      grossCostPerShare,
      grossEdge,
      feeCost,
      netEdge,
      netEdgeBpsOnPar,
      legs: executedLegs,
      detectedAtMs: evaluatedAtMs
    }
  };
};

const getConversionOutputMultiplier = (feeRateBps: number): number =>
  Math.max(0, 1 - feeRateBps / 10_000);

const resolveNoConversionShares = (
  source: GroupLegContext,
  complements: readonly GroupLegContext[],
  conversionOutputMultiplier: number
): number => {
  const minimumComplementShares =
    conversionOutputMultiplier > DECIMAL_TOLERANCE
      ? complements.reduce(
          (current, complement) =>
            Math.max(
              current,
              getPositiveMinOrderSize(complement.market.orderMinSize),
              getPositiveMinOrderSize(complement.yesBook.minOrderSize)
            ),
          0
        ) / conversionOutputMultiplier
      : Number.POSITIVE_INFINITY;
  const effectiveOrderMinSize = Math.max(
    getPositiveMinOrderSize(source.market.orderMinSize),
    getPositiveMinOrderSize(source.noBook?.minOrderSize),
    minimumComplementShares
  );
  const minimumShares = Math.max(config.negativeRisk.targetShares, effectiveOrderMinSize);
  let shares = roundUpToOrderSizePrecision(minimumShares);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sourceNoBook = source.noBook;

    if (!sourceNoBook) {
      break;
    }

    const entryFill = calculateBuyFill(sourceNoBook.asks, shares);

    if (!entryFill) {
      break;
    }

    const tickSize = getExecutableTickSize(
      sourceNoBook.tickSize,
      source.market.orderPriceMinTickSize
    );
    const executionPlan = buildBuyExecutionPlan(shares, entryFill.worstPrice, tickSize);
    const nextShares = Math.max(
      minimumShares,
      getAutoAdjustedSharesForLimitPrice(executionPlan.limitPrice, minimumShares)
    );
    const convertedShares = roundDownToOrderSizePrecision(shares * conversionOutputMultiplier);
    const exitsExecutable = complements.every(
      (complement) => Boolean(calculateSellFill(complement.yesBook.bids, convertedShares))
    );

    if (
      exitsExecutable &&
      nextShares <= shares + DECIMAL_TOLERANCE
    ) {
      break;
    }

    if (nextShares <= shares + DECIMAL_TOLERANCE) {
      break;
    }

    shares = nextShares;
  }

  return shares;
};

const evaluateNoConversionCandidates = (
  group: NegativeRiskGroup,
  contexts: readonly GroupLegContext[],
  evaluatedAtMs: number
): {
  opportunities: NegativeRiskNoConversionOpportunity[];
  rejection?: GroupContextRejection;
} => {
  const opportunities: NegativeRiskNoConversionOpportunity[] = [];
  let rejection: GroupContextRejection | undefined;

  for (const source of contexts) {
    if (!source.noTokenId) {
      rejection ??= {
        reason: "missing_no_token",
        detail: `${source.market.slug} does not expose an explicit No token`
      };
      continue;
    }

    if (!source.noBook) {
      rejection ??= {
        reason: "insufficient_depth",
        detail: `${source.market.slug} is missing an orderbook for the No token`
      };
      continue;
    }

    if (!source.marketId || typeof source.questionIndex !== "number") {
      rejection ??= {
        reason: "missing_conversion_metadata",
        detail: `${source.market.slug} is missing questionId-derived conversion metadata`
      };
      continue;
    }

    const complements = contexts.filter((context) => context.market.id !== source.market.id);

    if (complements.length === 0) {
      continue;
    }

    const conversionOutputMultiplier = getConversionOutputMultiplier(source.noFeeRateBps);

    if (conversionOutputMultiplier <= DECIMAL_TOLERANCE) {
      rejection ??= {
        reason: "net_edge_below_min_usdc",
        detail: `${source.market.slug} conversionOutputMultiplier(${conversionOutputMultiplier.toFixed(6)}) <= 0`
      };
      continue;
    }

    const oldestBook = Math.min(
      source.noBook.updatedAtMs,
      ...complements.map((context) => context.yesBook.updatedAtMs)
    );
    const newestBook = Math.max(
      source.noBook.updatedAtMs,
      ...complements.map((context) => context.yesBook.updatedAtMs)
    );
    const bookTimestampSkewMs = newestBook - oldestBook;

    if (bookTimestampSkewMs > config.strategy.maxBookSkewMs) {
      rejection ??= {
        reason: "book_timestamp_skew_too_wide",
        detail: `${source.market.slug} noConversion bookTimestampSkewMs(${bookTimestampSkewMs}) > maxBookSkewMs(${config.strategy.maxBookSkewMs})`
      };
      continue;
    }

    const shares = resolveNoConversionShares(source, complements, conversionOutputMultiplier);
    const convertedSharesPerLeg = roundDownToOrderSizePrecision(shares * conversionOutputMultiplier);
    const effectiveExitOrderMinSize = complements.reduce(
      (current, complement) =>
        Math.max(
          current,
          getPositiveMinOrderSize(complement.market.orderMinSize),
          getPositiveMinOrderSize(complement.yesBook.minOrderSize)
        ),
      0
    );

    if (convertedSharesPerLeg < effectiveExitOrderMinSize) {
      rejection ??= {
        reason: "target_shares_below_order_min_size",
        detail: `${source.market.slug} convertedSharesPerLeg(${convertedSharesPerLeg}) < effectiveExitOrderMinSize(${effectiveExitOrderMinSize})`
      };
      continue;
    }

    const entryFill = calculateBuyFill(source.noBook.asks, shares);

    if (!entryFill) {
      rejection ??= {
        reason: "insufficient_depth",
        detail: `${source.market.slug} does not have enough No ask depth for ${shares} shares`
      };
      continue;
    }

    const entryTickSize = getExecutableTickSize(
      source.noBook.tickSize,
      source.market.orderPriceMinTickSize
    );
    const entryExecutionPlan = buildBuyExecutionPlan(shares, entryFill.worstPrice, entryTickSize);

    if (entryExecutionPlan.rejectReason) {
      rejection ??= {
        reason: entryExecutionPlan.rejectReason,
        detail: `${source.market.slug} failed No-conversion marketable BUY constraints at limitPrice(${entryExecutionPlan.limitPrice.toFixed(4)})`
      };
      continue;
    }

    const exitLegs: NegativeRiskExitLeg[] = [];
    let missingExitDepth = false;

    for (const complement of complements) {
      const exitFill = calculateSellFill(complement.yesBook.bids, convertedSharesPerLeg);

      if (!exitFill) {
        rejection ??= {
          reason: "insufficient_depth",
          detail: `${complement.market.slug} does not have enough Yes bid depth for convertedSharesPerLeg(${convertedSharesPerLeg})`
        };
        missingExitDepth = true;
        break;
      }

      const exitTickSize = getExecutableTickSize(
        complement.yesBook.tickSize,
        complement.market.orderPriceMinTickSize
      );
      const exitExecutionPlan = buildSellExecutionPlan(exitFill.worstPrice, exitTickSize);

      exitLegs.push({
        market: complement.market,
        tokenId: complement.yesTokenId,
        outcomeTitle: complement.outcomeTitle,
        fill: exitFill,
        tickSize: exitTickSize,
        limitPrice: exitExecutionPlan.limitPrice,
        feeRateBps: complement.yesFeeRateBps
      });
    }

    if (missingExitDepth) {
      continue;
    }

    const entry: NegativeRiskLeg = {
      market: source.market,
      tokenId: source.noTokenId,
      outcomeTitle: `No: ${source.outcomeTitle}`,
      fill: entryFill,
      tickSize: entryTickSize,
      limitPrice: entryExecutionPlan.limitPrice,
      feeRateBps: source.noFeeRateBps
    };
    const grossCost = entry.fill.totalCost;
    const grossCostPerShare = grossCost / shares;

    if (grossCostPerShare > config.negativeRisk.maxEntryGrossCostPerShare) {
      rejection ??= {
        reason: "gross_cost_above_entry_cap",
        detail: `${source.market.slug} noConversion grossCostPerShare(${grossCostPerShare.toFixed(4)}) > maxEntryGrossCostPerShare(${config.negativeRisk.maxEntryGrossCostPerShare.toFixed(4)})`
      };
      continue;
    }

    const grossProceeds = exitLegs.reduce((total, leg) => total + leg.fill.totalProceeds, 0);
    const grossEdge = grossProceeds - grossCost;

    if (grossEdge <= 0) {
      rejection ??= {
        reason: "gross_edge_non_positive",
        detail: `${source.market.slug} noConversion grossEdge(${grossEdge.toFixed(4)}) <= 0`
      };
      continue;
    }

    const feeCost =
      estimateBuyFee(entry.fill, entry.feeRateBps, config.strategy.feePriceExponent) +
      exitLegs.reduce(
        (total, leg) =>
          total + estimateSellFee(leg.fill, leg.feeRateBps, config.strategy.feePriceExponent),
        0
      );
    // Fix I: subtract conversion gas reserve from edge so we never enter trades whose
    // post-gas PnL is below the configured minimum. Gas is per-trade (one convertPositions
    // call), not per-share.
    const gasReserveUsdc = config.negativeRisk.conversionGasReserveUsdc;
    const netEdge = grossEdge - feeCost - gasReserveUsdc;
    const netEdgeBpsOnPar = (netEdge / shares) * 10_000;

    if (netEdge < config.negativeRisk.minNetEdgeUsdc) {
      rejection ??= {
        reason: "net_edge_below_min_usdc",
        detail: `${source.market.slug} noConversion netEdge(${netEdge.toFixed(4)}, after gas reserve ${gasReserveUsdc}) < minNetEdgeUsdc(${config.negativeRisk.minNetEdgeUsdc.toFixed(4)})`
      };
      continue;
    }

    if (netEdgeBpsOnPar < config.negativeRisk.minNetEdgeBps) {
      rejection ??= {
        reason: "net_edge_below_min_bps",
        detail: `${source.market.slug} noConversion netEdgeBpsOnPar(${netEdgeBpsOnPar.toFixed(2)}) < minNetEdgeBps(${config.negativeRisk.minNetEdgeBps.toFixed(2)})`
      };
      continue;
    }

    opportunities.push({
      kind: "no-to-yes-conversion",
      group,
      shares,
      grossCost,
      grossCostPerShare,
      grossEdge,
      feeCost,
      netEdge,
      netEdgeBpsOnPar,
      entry,
      exitLegs,
      grossProceeds,
      convertedSharesPerLeg,
      conversionFeeBps: source.noFeeRateBps,
      conversionMarketId: source.marketId,
      conversionIndexSet: `0x${(1n << BigInt(source.questionIndex)).toString(16)}`,
      sourceQuestionIndex: source.questionIndex,
      detectedAtMs: evaluatedAtMs
    });
  }

  return {
    opportunities,
    rejection
  };
};

const resolveGroupMarketId = (markets: readonly BinaryMarket[]): string | undefined => {
  const marketIds = new Set(
    markets
      .map((market) => parseQuestionId(market.questionId)?.marketId)
      .filter((marketId): marketId is string => Boolean(marketId))
  );

  return marketIds.size === 1 ? [...marketIds][0] : undefined;
};

export const buildNegativeRiskGroups = (markets: readonly BinaryMarket[]): NegativeRiskGroup[] => {
  const grouped = new Map<string, BinaryMarket[]>();

  for (const market of markets) {
    if (
      !market.negRisk ||
      !market.eventId ||
      market.enableNegRisk === false ||
      market.cumulativeMarkets === true
    ) {
      continue;
    }

    const current = grouped.get(market.eventId) ?? [];
    current.push(market);
    grouped.set(market.eventId, current);
  }

  return [...grouped.entries()]
    .map<NegativeRiskGroup | undefined>(([eventId, eventMarkets]) => {
      const [first] = eventMarkets;

      if (!first) {
        return undefined;
      }

      const marketId = resolveGroupMarketId(eventMarkets);
      const group: NegativeRiskGroup = {
        eventId,
        eventSlug: first.eventSlug ?? first.slug,
        eventTitle: first.eventTitle ?? first.question,
        markets: [...eventMarkets].sort((left, right) =>
          getOutcomeTitle(left).localeCompare(getOutcomeTitle(right))
        )
      };

      if (marketId) {
        group.marketId = marketId;
      }

      return group;
    })
    .filter((group): group is NegativeRiskGroup => group !== undefined);
};

export const evaluateNegativeRiskOpportunity = (
  group: NegativeRiskGroup,
  booksByTokenId: ReadonlyMap<string, NormalizedOrderBook>,
  feeRatesByTokenId: ReadonlyMap<string, number>
): NegativeRiskEvaluation => {
  const validation = buildGroupContexts(group, booksByTokenId, feeRatesByTokenId);

  if (validation.status === "rejected") {
    return validation;
  }

  // Fix B: yes-basket disabled by default. The Adapter has no immediate YES→collateral
  // conversion path; profits would only realize at event resolution (capital locked).
  // Operators must explicitly opt-in with POLYBOT_NEG_RISK_ENABLE_YES_BASKET=true.
  const yesBasketEvaluation: GroupEvaluationResult = config.negativeRisk.enableYesBasket
    ? evaluateYesBasketOpportunity(group, validation.contexts, validation.evaluatedAtMs)
    : {
        status: "rejected",
        reason: "yes_basket_disabled",
        detail:
          "Yes-basket evaluation skipped because POLYBOT_NEG_RISK_ENABLE_YES_BASKET=false (no immediate Adapter conversion path; profits realize only at resolution)."
      };
  const noConversionEvaluation = evaluateNoConversionCandidates(
    group,
    validation.contexts,
    validation.evaluatedAtMs
  );
  const opportunities = sortOpportunities(
    [
      yesBasketEvaluation.status === "opportunity" ? yesBasketEvaluation.opportunity : undefined,
      ...noConversionEvaluation.opportunities
    ].filter((opportunity): opportunity is NegativeRiskOpportunity => Boolean(opportunity))
  );

  if (opportunities.length > 0) {
    const [opportunity, ...alternativeOpportunities] = opportunities;

    if (!opportunity) {
      throw new Error("Negative Risk opportunity sorting returned an empty first element.");
    }

    return {
      status: "opportunity",
      opportunity,
      alternativeOpportunities
    };
  }

  if (yesBasketEvaluation.status === "rejected") {
    return yesBasketEvaluation;
  }

  if (noConversionEvaluation.rejection) {
    return {
      status: "rejected",
      reason: noConversionEvaluation.rejection.reason,
      detail: noConversionEvaluation.rejection.detail
    };
  }

  return {
    status: "rejected",
    reason: "net_edge_below_min_usdc",
    detail: `${group.eventSlug} has no negative-risk path above configured edge thresholds`
  };
};
