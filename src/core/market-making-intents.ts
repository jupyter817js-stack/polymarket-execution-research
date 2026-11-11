import { OrderType, Side } from "@polymarket/clob-client-v2";

import { config } from "../config.js";
import type { ActiveQuote } from "../trading/quote-executor.js";
import type { MarketMakerPlan, QuoteInstruction } from "../strategy/market-maker.js";
import type { ActiveOrderState, OrderIntent, RejectedIntent } from "./types.js";
import type { TrackedInventoryPosition } from "./inventory-lot-tracker.js";
import { getDefaultStrategyPriority } from "./types.js";
import { clampPrice, roundDownToTick, roundUpToTick } from "../utils.js";

const EPSILON = 1e-9;
const POLYMARKET_MIN_ORDER_SIZE = 5;
const quoteSideKey = (tokenId: string, side: string): string => `${tokenId}:${side}`;
const quoteKey = (tokenId: string, side: string, quoteSlot?: string): string =>
  `${tokenId}:${side}:${quoteSlot ?? "primary"}`;
type MarketMakerTokenPlan = MarketMakerPlan["tokenPlans"][number];
const ONE_SIDE_AGGRESSIVE_EXIT_MAX_ACTIVE_LAYERS = 3;

export interface MarketMakerPairInventorySideState {
  tokenId: string;
  outcome: string;
  shares: number;
  totalCostUsdc: number;
  averageCostPerShare: number;
  currentBestBid: number;
  currentMarkValueUsdc: number;
  unrealizedPnlUsdc: number;
}

export interface MarketMakerPairInventoryState {
  marketScope: string;
  conditionId?: string;
  sideA: MarketMakerPairInventorySideState;
  sideB: MarketMakerPairInventorySideState;
  totalCostUsdc: number;
  totalMarkValueUsdc: number;
  totalNetPnlUsdc: number;
  matchedShares: number;
  matchedCostUsdc: number;
  matchedMarkValueUsdc: number;
  matchedNetPnlUsdc: number;
  matchedNetEdgeBps: number;
  imbalanceShares: number;
  overweightTokenId?: string;
}

export type MarketMakerNetPairExitMode = "take-profit" | "stop" | "spread-collapse";

export interface MarketMakerOneSideFillRecoveryContext {
  conditionId: string;
  filledTokenId: string;
  activatedAtMs: number;
}

export type MarketMakerOneSideFillResponseMode = "rebalance" | "unwind-priority";

export interface MarketMakerOneSideFillResponseState {
  mode: MarketMakerOneSideFillResponseMode;
  marketScope: string;
  conditionId: string;
  filledTokenId: string;
  opposingTokenId: string;
  activatedAtMs: number;
  ageMs: number;
  imbalanceShares: number;
  filledInventoryShares: number;
  opposingInventoryShares: number;
}

type MarketMakerOneSideAggressiveExitOptions = {
  filledInventoryShares: number;
  minimumOrderSize: number;
  rejectionCount: number;
  priceConcessionTicks?: number;
};

export interface MarketMakerMaxHoldHardExitState {
  marketScope: string;
  conditionId?: string;
  agedTokenIds: readonly string[];
  oldestPositionAgeMs: number;
}

const getAverageCostPerShare = (
  position: TrackedInventoryPosition | undefined
): number | undefined => {
  if (!position || position.shares <= EPSILON || position.totalCostUsdc <= EPSILON) {
    return undefined;
  }

  return position.totalCostUsdc / position.shares;
};

const getMarkEdgeBps = (
  tokenPlan: MarketMakerTokenPlan,
  position: TrackedInventoryPosition | undefined
): number | undefined => {
  const averageCostPerShare = getAverageCostPerShare(position);

  if (averageCostPerShare === undefined || averageCostPerShare <= EPSILON) {
    return undefined;
  }

  return ((tokenPlan.bestBid - averageCostPerShare) / averageCostPerShare) * 10_000;
};

const quoteInstructionChanged = (
  originalQuote: QuoteInstruction | undefined,
  adjustedQuote: QuoteInstruction
): boolean =>
  !originalQuote ||
  originalQuote.quoteSlot !== adjustedQuote.quoteSlot ||
  Math.abs(originalQuote.price - adjustedQuote.price) > EPSILON ||
  Math.abs(originalQuote.size - adjustedQuote.size) > EPSILON ||
  originalQuote.orderType !== adjustedQuote.orderType ||
  originalQuote.postOnly !== adjustedQuote.postOnly ||
  originalQuote.executionStyle !== adjustedQuote.executionStyle ||
  originalQuote.expiration !== adjustedQuote.expiration;

const hasConditionalExitTrigger = (
  tokenPlan: MarketMakerTokenPlan,
  position: TrackedInventoryPosition | undefined
): boolean => {
  if (!position || position.shares <= EPSILON) {
    return false;
  }

  const overweightThresholdShares =
    config.marketMaker.maxTokenExposureShares *
    config.marketMaker.conditionalExitOverweightRatio;

  if (position.shares + EPSILON >= overweightThresholdShares) {
    return true;
  }

  const markEdgeBps = getMarkEdgeBps(tokenPlan, position);

  if (markEdgeBps === undefined) {
    return false;
  }

  return markEdgeBps <= -(config.marketMaker.conditionalExitMaxLossBps + EPSILON);
};

export const resolveMinimumExitPriceForPosition = (
  position: TrackedInventoryPosition | undefined,
  tickSize: number,
  nowMs: number = Date.now()
): number | undefined => {
  const averageCostPerShare = getAverageCostPerShare(position);

  if (averageCostPerShare === undefined) {
    return undefined;
  }

  let effectiveMinProfitTicks = config.marketMaker.exitMinProfitTicks;
  const breakEvenAfterMs = config.marketMaker.breakEvenExitAfterMs;

  if (breakEvenAfterMs > 0 && position) {
    const ageMs = Math.max(0, nowMs - position.openedAtMs);

    if (ageMs + EPSILON >= breakEvenAfterMs) {
      // After the stale-age threshold, allow the configured bounded loss exit.
      effectiveMinProfitTicks = -config.marketMaker.breakEvenExitMaxLossTicks;
    }
  }

  return clampPrice(
    roundUpToTick(
      averageCostPerShare + effectiveMinProfitTicks * tickSize,
      tickSize
    ),
    tickSize
  );
};

export const resolveBoundedLossExitPriceForPosition = (
  position: TrackedInventoryPosition | undefined,
  tickSize: number,
  maxLossTicks: number = config.marketMaker.breakEvenExitMaxLossTicks
): number | undefined => {
  const averageCostPerShare = getAverageCostPerShare(position);

  if (averageCostPerShare === undefined) {
    return undefined;
  }

  const boundedLossTicks = Math.max(0, maxLossTicks);
  const rawFloor = averageCostPerShare - boundedLossTicks * tickSize;
  const roundedFloor =
    boundedLossTicks > 0
      ? roundDownToTick(rawFloor, tickSize)
      : roundUpToTick(rawFloor, tickSize);

  return clampPrice(roundedFloor, tickSize);
};

const enforceSellQuoteSpreadAndProfitFloor = (
  tokenPlan: MarketMakerTokenPlan,
  buyQuote: QuoteInstruction,
  sellQuote: QuoteInstruction,
  position: TrackedInventoryPosition | undefined,
  allowLossExit: boolean,
  nowMs: number = Date.now()
): QuoteInstruction => {
  let adjustedSellPrice = sellQuote.price;
  const antiInversionFloor = clampPrice(
    Math.max(tokenPlan.bestBid + sellQuote.tickSize, buyQuote.price + sellQuote.tickSize),
    sellQuote.tickSize
  );
  adjustedSellPrice = Math.max(adjustedSellPrice, antiInversionFloor);

  const averageCostPerShare = getAverageCostPerShare(position);

  if (!allowLossExit) {
    const minSpreadFloor = clampPrice(
      buyQuote.price + config.marketMaker.exitMinSpreadTicks * sellQuote.tickSize,
      sellQuote.tickSize
    );
    adjustedSellPrice = Math.max(adjustedSellPrice, minSpreadFloor);
  }

  // 🔒 Profit floor is ABSOLUTE by default — it applies even when allowLossExit
  // is true. Floor now sits OUTSIDE the allowLossExit guard and `roundUpToTick`
  // keeps it strictly above cost rather than collapsing via banker's rounding.
  //
  // 📌 #4 Conditional break-even exit: after `breakEvenExitAfterMs` of hold
  // time we relax the floor by up to `breakEvenExitMaxLossTicks` ticks. This
  // lets long-stuck positions clear in stagnant markets where the floor would
  // otherwise trap the inventory forever. Still bounded by exitMinProfitTicks
  // as the default; only kicks in when the position is genuinely "old".
  if (averageCostPerShare !== undefined) {
    const minProfitFloor = resolveMinimumExitPriceForPosition(
      position,
      sellQuote.tickSize,
      nowMs
    );

    if (minProfitFloor !== undefined) {
      adjustedSellPrice = Math.max(adjustedSellPrice, minProfitFloor);
    }
  }

  if (Math.abs(adjustedSellPrice - sellQuote.price) <= EPSILON) {
    return sellQuote;
  }

  return {
    ...sellQuote,
    price: clampPrice(adjustedSellPrice, sellQuote.tickSize)
  };
};

export const buildMarketMakingIntents = (plan: MarketMakerPlan): OrderIntent[] =>
  plan.quotes.map((quote, index) => ({
    id: [
      "mm",
      plan.market.conditionId,
      quote.tokenId,
      quote.side,
      quote.quoteSlot ?? "primary",
      String(index),
      String(plan.generatedAtMs)
    ].join(":"),
    strategy: "market-making",
    priority: getDefaultStrategyPriority("market-making"),
    conditionId: plan.market.conditionId,
    tokenId: quote.tokenId,
    side: quote.side,
    quoteSlot: quote.quoteSlot,
    price: quote.price,
    size: quote.size,
    tif: quote.orderType,
    postOnly: quote.postOnly,
    createdAtMs: plan.generatedAtMs,
    reason: plan.rewardActive
      ? "market-making quote generation with reward-aware sizing"
      : "market-making quote generation",
    tags: [
      "market-making",
      quote.outcome.toLowerCase(),
      quote.side.toLowerCase(),
      ...(plan.rewardActive ? ["reward-active"] : [])
    ],
    metadata: {
      marketSlug: plan.market.slug,
      outcome: quote.outcome,
      rewardActive: plan.rewardActive,
      quoteSlot: quote.quoteSlot
    }
  }));

export const filterMarketMakerPlanByApprovedIntents = (
  plan: MarketMakerPlan,
  approvedIntents: readonly OrderIntent[]
): MarketMakerPlan => {
  const approvedKeys = new Set(
    approvedIntents
      .filter((intent) => intent.strategy === "market-making")
      .map((intent) => quoteKey(intent.tokenId, intent.side, intent.quoteSlot))
  );

  const filteredQuotes = plan.quotes.filter((quote) =>
    approvedKeys.has(quoteKey(quote.tokenId, quote.side, quote.quoteSlot))
  );

  return {
    ...plan,
    quotes: filteredQuotes
  };
};

export const buildRetainedMarketMakingIntents = (
  approvedIntents: readonly OrderIntent[],
  rejectedIntents: readonly RejectedIntent[]
): OrderIntent[] => [
  ...approvedIntents.filter((intent) => intent.strategy === "market-making"),
  ...rejectedIntents
    .filter(
      (rejected) =>
        rejected.intent.strategy === "market-making" &&
        rejected.reason === "active_order_already_matches"
    )
    .map((rejected) => rejected.intent)
];

export const filterMarketMakerPlanByTrackedInventory = (
  plan: MarketMakerPlan,
  getOpenShares: (tokenId: string) => number,
  // 🔒 Optional venue-balance getter. When supplied, the SELL filter clamps to
  // `min(localTrackedShares, venueShares)` so layered SELLs cannot total more
  // than the exchange actually holds. Without this, post-fill stale state
  // produces "not enough balance" rejects that escalate to DEGRADED.
  getKnownVenueShares?: (tokenId: string) => number | undefined
): MarketMakerPlan => {
  const reservedSellSizeByTokenId = new Map<string, number>();
  const adjustedQuotes: QuoteInstruction[] = [];
  const sellQuoteCountByTokenId = new Map<string, number>();
  const minimumSellQuoteSize = Math.max(
    config.marketMaker.minSellShares,
    plan.market.orderMinSize,
    POLYMARKET_MIN_ORDER_SIZE,
    EPSILON
  );
  const normalizeQuoteSize = (size: number): number => Number(size.toFixed(8));
  const effectiveOpenShares = (tokenId: string): number => {
    const local = getOpenShares(tokenId);
    if (!getKnownVenueShares) return local;
    const venue = getKnownVenueShares(tokenId);
    if (typeof venue !== "number") return local;
    // V2 wire / venue indexer can briefly report balance=0 right after a maker
    // BUY fill while the conditional token credit is still propagating. If the
    // local lot tracker says we hold shares but the cached venue snapshot says
    // 0, trust the local view so we do not suppress SELL coverage during the
    // ~minutes it takes the venue snapshot to catch up. Real venue=0 (operator
    // sold externally) will surface as a venue reject and the bot resyncs on
    // the next cycle — that's preferable to leaving inventory uncovered.
    if (venue <= 0 && local > 0) return local;
    return Math.min(local, Math.max(0, venue));
  };

  for (const quote of plan.quotes) {
    if (quote.side !== "SELL") {
      continue;
    }

    sellQuoteCountByTokenId.set(
      quote.tokenId,
      (sellQuoteCountByTokenId.get(quote.tokenId) ?? 0) + 1
    );
  }

  // First pass: identify tokenIds whose inventory is dust (too small to SELL).
  // We also suppress BUY for those tokens to avoid one-directional accumulation.
  const dustTokenIds = new Set<string>();
  for (const quote of plan.quotes) {
    if (quote.side !== "SELL") continue;
    const availableShares = effectiveOpenShares(quote.tokenId);
    if (availableShares > EPSILON && availableShares < minimumSellQuoteSize - EPSILON) {
      dustTokenIds.add(quote.tokenId);
    }
  }

  for (const quote of plan.quotes) {
    // Drop both sides for dust tokens — prevents one-directional BUY accumulation.
    if (dustTokenIds.has(quote.tokenId)) {
      continue;
    }

    if (quote.side !== "SELL") {
      adjustedQuotes.push(quote);
      continue;
    }

    const alreadyReserved = reservedSellSizeByTokenId.get(quote.tokenId) ?? 0;
    const availableShares = effectiveOpenShares(quote.tokenId) - alreadyReserved;

    if (availableShares <= EPSILON) {
      // No inventory left for this token at all — drop the quote.
      continue;
    }

    const shouldExpandSinglePassiveSell =
      quote.executionStyle !== "one-side-aggressive-exit" &&
      (sellQuoteCountByTokenId.get(quote.tokenId) ?? 0) === 1 &&
      availableShares > quote.size + EPSILON;

    if (shouldExpandSinglePassiveSell) {
      const expandedSellSize = normalizeQuoteSize(availableShares);
      reservedSellSizeByTokenId.set(quote.tokenId, alreadyReserved + expandedSellSize);
      adjustedQuotes.push(
        Math.abs(expandedSellSize - quote.size) <= EPSILON
          ? quote
          : { ...quote, size: expandedSellSize }
      );
      continue;
    }

    if (availableShares + EPSILON >= quote.size) {
      // Sufficient inventory — keep as-is.
      reservedSellSizeByTokenId.set(quote.tokenId, alreadyReserved + quote.size);
      adjustedQuotes.push(quote);
    } else {
      if (availableShares + EPSILON < minimumSellQuoteSize) {
        // Do not leave a residual SELL layer below the venue minimum.
        continue;
      }

      // Partial inventory — clamp SELL size to what is available.
      // This allows the bot to exit positions that are smaller than the
      // standard quote size rather than skipping the SELL entirely.
      const clampedSellSize = normalizeQuoteSize(availableShares);
      reservedSellSizeByTokenId.set(quote.tokenId, alreadyReserved + clampedSellSize);
      adjustedQuotes.push({ ...quote, size: clampedSellSize });
    }
  }

  if (adjustedQuotes.length === plan.quotes.length &&
      adjustedQuotes.every((q, i) => q === plan.quotes[i])) {
    return plan;
  }

  return { ...plan, quotes: adjustedQuotes };
};

export const expandSellQuotesToLayers = (
  plan: MarketMakerPlan,
  layers: number,
  layerTickSpacing: number,
  // Normalised weights (must sum to 1). If omitted, equal distribution is used.
  layerWeights?: readonly number[]
): MarketMakerPlan => {
  if (layers <= 1) return plan;

  const normalizeWeights = (rawWeights: readonly number[]): number[] => {
    const sanitizedWeights = rawWeights.map((weight) => (weight > 0 ? weight : 0));
    const totalWeight = sanitizedWeights.reduce((sum, weight) => sum + weight, 0);

    if (totalWeight <= EPSILON) {
      return Array.from({ length: rawWeights.length }, () => 1 / rawWeights.length);
    }

    return sanitizedWeights.map((weight) => weight / totalWeight);
  };

  const collapseWeights = (rawWeights: readonly number[], targetLayerCount: number): number[] => {
    if (targetLayerCount >= rawWeights.length) {
      return [...rawWeights];
    }

    if (targetLayerCount <= 1) {
      return [rawWeights.reduce((sum, weight) => sum + weight, 0)];
    }

    return [
      ...rawWeights.slice(0, targetLayerCount - 1),
      rawWeights.slice(targetLayerCount - 1).reduce((sum, weight) => sum + weight, 0)
    ];
  };

  const roundShareSize = (size: number): number =>
    Math.max(0, Math.round(size * 1_000_000) / 1_000_000);

  const repairRoundedLayerSizes = (roundedSizes: number[], totalSize: number): number[] | undefined => {
    if (roundedSizes.length <= 1) {
      return roundedSizes;
    }

    const repairedSizes = [...roundedSizes];
    let tailSize = repairedSizes[repairedSizes.length - 1] ?? 0;

    if (tailSize + EPSILON < POLYMARKET_MIN_ORDER_SIZE) {
      let deficit = POLYMARKET_MIN_ORDER_SIZE - tailSize;

      for (let index = repairedSizes.length - 2; index >= 0 && deficit > EPSILON; index -= 1) {
        const donorAvailable = repairedSizes[index]! - POLYMARKET_MIN_ORDER_SIZE;
        if (donorAvailable <= EPSILON) {
          continue;
        }

        const borrowed = Math.min(donorAvailable, deficit);
        repairedSizes[index] = roundShareSize(repairedSizes[index]! - borrowed);
        deficit -= borrowed;
      }

      if (deficit > 1e-6) {
        return undefined;
      }

      const allocatedBeforeTail = repairedSizes
        .slice(0, -1)
        .reduce((total, size) => total + size, 0);
      tailSize = roundShareSize(totalSize - allocatedBeforeTail);
      repairedSizes[repairedSizes.length - 1] = tailSize;
    }

    return repairedSizes.every((size) => size + EPSILON >= POLYMARKET_MIN_ORDER_SIZE)
      ? repairedSizes
      : undefined;
  };

  const buildLayerSizes = (totalSize: number): number[] | undefined => {
    const baseWeights =
      layerWeights && layerWeights.length === layers
        ? [...layerWeights]
        : Array.from({ length: layers }, () => 1 / layers);

    for (let layerCount = layers; layerCount >= 1; layerCount -= 1) {
      if (layerCount > 1 && totalSize + EPSILON < POLYMARKET_MIN_ORDER_SIZE * layerCount) {
        continue;
      }

      const weights = normalizeWeights(collapseWeights(baseWeights, layerCount));
      const provisionalSizes = weights.map((weight) => totalSize * weight);

      if (layerCount > 1) {
        let deficit = 0;
        for (let index = 0; index < provisionalSizes.length; index += 1) {
          const size = provisionalSizes[index] ?? 0;
          if (size + EPSILON >= POLYMARKET_MIN_ORDER_SIZE) {
            continue;
          }

          deficit += POLYMARKET_MIN_ORDER_SIZE - size;
          provisionalSizes[index] = POLYMARKET_MIN_ORDER_SIZE;
        }

        if (deficit > EPSILON) {
          const donorIndices = provisionalSizes
            .map((size, index) => ({ size, index }))
            .sort((left, right) => right.size - left.size)
            .map((entry) => entry.index);

          for (const donorIndex of donorIndices) {
            if (deficit <= EPSILON) {
              break;
            }

            const donorSize = provisionalSizes[donorIndex] ?? 0;
            const donorAvailable = donorSize - POLYMARKET_MIN_ORDER_SIZE;
            if (donorAvailable <= EPSILON) {
              continue;
            }

            const borrowed = Math.min(donorAvailable, deficit);
            provisionalSizes[donorIndex] = donorSize - borrowed;
            deficit -= borrowed;
          }

          if (deficit > 1e-6) {
            continue;
          }
        }
      }

      const roundedSizes = provisionalSizes.map((size) => roundShareSize(size));
      const allocatedBeforeTail = roundedSizes
        .slice(0, -1)
        .reduce((total, size) => total + size, 0);
      roundedSizes[roundedSizes.length - 1] = roundShareSize(totalSize - allocatedBeforeTail);

      const repairedSizes = repairRoundedLayerSizes(roundedSizes, totalSize);
      if (repairedSizes) {
        return repairedSizes;
      }
    }

    return undefined;
  };

  const expandedQuotes: QuoteInstruction[] = [];
  let changed = false;

  for (const quote of plan.quotes) {
    if (quote.side !== "SELL") {
      expandedQuotes.push(quote);
      continue;
    }

    // Aggressive exit quotes are already chunked intentionally by the recovery path.
    // Re-layering them here can create sub-minimum venue sizes and repeated rejects.
    if (quote.executionStyle === "one-side-aggressive-exit") {
      expandedQuotes.push(quote);
      continue;
    }

    // If the smallest layer (smallest weight × total size) would be below minimum,
    // skip expansion entirely and keep this quote as a single layer.
    const layerSizes = buildLayerSizes(quote.size);
    if (!layerSizes || layerSizes.length <= 1) {
      expandedQuotes.push(quote);
      continue;
    }

    changed = true;

    for (let i = 0; i < layerSizes.length; i++) {
      const layerSize = layerSizes[i] ?? 0;
      if (layerSize <= EPSILON) continue;

      // Each successive layer is layerTickSpacing tick(s) further from best bid.
      const layerPrice = clampPrice(
        Math.min(1 - quote.tickSize, quote.price + i * layerTickSpacing * quote.tickSize),
        quote.tickSize
      );

      expandedQuotes.push({
        ...quote,
        price: layerPrice,
        size: layerSize,
        quoteSlot: `sell-layer-${i}`
      });
    }
  }

  if (!changed) return plan;
  return { ...plan, quotes: expandedQuotes };
};

export const filterMarketMakerPlanBySellRepostCooldown = (
  plan: MarketMakerPlan,
  shouldSuppressSell: (tokenId: string) => boolean
): MarketMakerPlan => ({
  ...plan,
  quotes: plan.quotes.filter(
    (quote) => quote.side !== "SELL" || !shouldSuppressSell(quote.tokenId)
  )
});

export const filterMarketMakerPlanByBuySuppression = (
  plan: MarketMakerPlan,
  shouldSuppressBuy: (tokenId: string) => boolean
): MarketMakerPlan => ({
  ...plan,
  quotes: plan.quotes.filter(
    (quote) => quote.side !== Side.BUY || !shouldSuppressBuy(quote.tokenId)
  )
});

export const filterMarketMakerPlanByPassiveBuyPriceBand = (
  plan: MarketMakerPlan
): MarketMakerPlan => {
  const minPassiveBuyPrice = Math.max(0, config.marketMaker.minPassiveBuyPrice);
  const maxPassiveBuyPrice = Math.min(1, config.marketMaker.maxPassiveBuyPrice);

  if (minPassiveBuyPrice > maxPassiveBuyPrice + EPSILON) {
    return plan;
  }

  if (minPassiveBuyPrice <= EPSILON && maxPassiveBuyPrice >= 1 - EPSILON) {
    return plan;
  }

  const quotes = plan.quotes.filter((quote) => {
    if (
      quote.side !== Side.BUY ||
      !quote.postOnly ||
      quote.executionStyle === "one-side-aggressive-exit"
    ) {
      return true;
    }

    return (
      quote.price + EPSILON >= minPassiveBuyPrice &&
      quote.price <= maxPassiveBuyPrice + EPSILON
    );
  });

  return quotes.length === plan.quotes.length ? plan : { ...plan, quotes };
};

const maybeConvertPassiveQuoteToAggressive = (
  quote: QuoteInstruction,
  tokenPlan: MarketMakerTokenPlan,
  activeQuote: ActiveQuote | undefined,
  nowMs: number
): QuoteInstruction => {
  if (
    !config.marketMaker.enablePassiveToAggressiveTransition ||
    !activeQuote ||
    !activeQuote.postOnly ||
    !quote.postOnly ||
    nowMs - activeQuote.openedAtMs + EPSILON < config.marketMaker.passiveToAggressiveAfterMs
  ) {
    return quote;
  }

  const bufferTicks = config.marketMaker.passiveToAggressivePriceBufferTicks;
  const aggressivePrice =
    quote.side === Side.BUY
      ? clampPrice(tokenPlan.bestAsk + bufferTicks * quote.tickSize, quote.tickSize)
      : clampPrice(tokenPlan.bestBid - bufferTicks * quote.tickSize, quote.tickSize);

  if (
    (quote.side === Side.BUY && aggressivePrice <= quote.price + EPSILON) ||
    (quote.side === Side.SELL && aggressivePrice + EPSILON >= quote.price)
  ) {
    return quote;
  }

  if (quote.side === Side.BUY && aggressivePrice * quote.size + EPSILON < 1) {
    return quote;
  }

  return {
    ...quote,
    price: aggressivePrice,
    postOnly: false,
    orderType: OrderType.GTC,
    expiration: undefined
  };
};

export const applyPassiveToAggressiveTransitionToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getActiveQuote: (tokenId: string, side: Side) => ActiveQuote | undefined,
  nowMs: number = Date.now()
): MarketMakerPlan => {
  if (!config.marketMaker.enablePassiveToAggressiveTransition) {
    return plan;
  }

  let hasMeaningfulChange = false;
  const adjustTokenPlan = (tokenPlan: MarketMakerTokenPlan): MarketMakerTokenPlan => {
    const adjustedQuotes = tokenPlan.quotes.map((quote) => {
      const adjustedQuote = maybeConvertPassiveQuoteToAggressive(
        quote,
        tokenPlan,
        getActiveQuote(quote.tokenId, quote.side),
        nowMs
      );

      if (
        adjustedQuote !== quote &&
        (
          Math.abs(adjustedQuote.price - quote.price) > EPSILON ||
          adjustedQuote.orderType !== quote.orderType ||
          adjustedQuote.postOnly !== quote.postOnly ||
          adjustedQuote.expiration !== quote.expiration
        )
      ) {
        hasMeaningfulChange = true;
      }

      return adjustedQuote;
    }) as [QuoteInstruction, QuoteInstruction];

    return {
      ...tokenPlan,
      quotes: adjustedQuotes
    };
  };

  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (!hasMeaningfulChange) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: adjustedTokenPlans.flatMap((tokenPlan) => tokenPlan.quotes)
  };
};

export const buildMarketMakerPairInventoryState = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPairInventoryState | undefined => {
  const positionA = getOpenPosition(plan.tokenPlans[0].tokenId);
  const positionB = getOpenPosition(plan.tokenPlans[1].tokenId);
  const sharesA = positionA?.shares ?? 0;
  const sharesB = positionB?.shares ?? 0;

  if (sharesA <= EPSILON && sharesB <= EPSILON) {
    return undefined;
  }

  const totalCostA = positionA?.totalCostUsdc ?? 0;
  const totalCostB = positionB?.totalCostUsdc ?? 0;
  const averageCostA = sharesA > EPSILON ? totalCostA / sharesA : 0;
  const averageCostB = sharesB > EPSILON ? totalCostB / sharesB : 0;
  const currentBestBidA = plan.tokenPlans[0].bestBid;
  const currentBestBidB = plan.tokenPlans[1].bestBid;
  const currentMarkValueA = sharesA * currentBestBidA;
  const currentMarkValueB = sharesB * currentBestBidB;
  const matchedShares = Math.min(sharesA, sharesB);
  const matchedCostUsdc = matchedShares * averageCostA + matchedShares * averageCostB;
  const matchedMarkValueUsdc = matchedShares * (currentBestBidA + currentBestBidB);
  const matchedNetPnlUsdc = matchedMarkValueUsdc - matchedCostUsdc;
  const matchedNetEdgeBps =
    matchedCostUsdc > EPSILON ? (matchedNetPnlUsdc / matchedCostUsdc) * 10_000 : 0;
  const imbalanceShares = sharesA - sharesB;

  return {
    marketScope: plan.market.slug,
    conditionId: plan.market.conditionId,
    sideA: {
      tokenId: plan.tokenPlans[0].tokenId,
      outcome: plan.tokenPlans[0].outcome,
      shares: sharesA,
      totalCostUsdc: totalCostA,
      averageCostPerShare: averageCostA,
      currentBestBid: currentBestBidA,
      currentMarkValueUsdc: currentMarkValueA,
      unrealizedPnlUsdc: currentMarkValueA - totalCostA
    },
    sideB: {
      tokenId: plan.tokenPlans[1].tokenId,
      outcome: plan.tokenPlans[1].outcome,
      shares: sharesB,
      totalCostUsdc: totalCostB,
      averageCostPerShare: averageCostB,
      currentBestBid: currentBestBidB,
      currentMarkValueUsdc: currentMarkValueB,
      unrealizedPnlUsdc: currentMarkValueB - totalCostB
    },
    totalCostUsdc: totalCostA + totalCostB,
    totalMarkValueUsdc: currentMarkValueA + currentMarkValueB,
    totalNetPnlUsdc: currentMarkValueA + currentMarkValueB - (totalCostA + totalCostB),
    matchedShares,
    matchedCostUsdc,
    matchedMarkValueUsdc,
    matchedNetPnlUsdc,
    matchedNetEdgeBps,
    imbalanceShares,
    overweightTokenId:
      imbalanceShares > EPSILON
        ? plan.tokenPlans[0].tokenId
        : imbalanceShares < -EPSILON
          ? plan.tokenPlans[1].tokenId
          : undefined
  };
};

export const resolveMarketMakerNetPairExitMode = (
  plan: MarketMakerPlan,
  pairInventoryState: MarketMakerPairInventoryState | undefined
): MarketMakerNetPairExitMode | undefined => {
  if (!config.marketMaker.enableNetPairExit || !pairInventoryState) {
    return undefined;
  }

  if (pairInventoryState.sideA.shares <= EPSILON || pairInventoryState.sideB.shares <= EPSILON) {
    return undefined;
  }

  const takeProfitByPnl =
    pairInventoryState.matchedNetPnlUsdc + EPSILON >=
    config.marketMaker.netPairTakeProfitMinPnlUsdc;
  const takeProfitByEdge =
    typeof config.marketMaker.netPairTakeProfitMinEdgeBps === "number" &&
    pairInventoryState.matchedNetEdgeBps + EPSILON >=
      config.marketMaker.netPairTakeProfitMinEdgeBps;

  if (takeProfitByPnl || takeProfitByEdge) {
    return "take-profit";
  }

  const stopByPnl =
    pairInventoryState.matchedNetPnlUsdc <=
    -(config.marketMaker.netPairStopMaxLossUsdc + EPSILON);
  const stopByEdge =
    typeof config.marketMaker.netPairStopMaxLossBps === "number" &&
    pairInventoryState.matchedNetEdgeBps <=
      -(config.marketMaker.netPairStopMaxLossBps + EPSILON);

  if (stopByPnl || stopByEdge) {
    return "stop";
  }

  const tightestObservedSpreadTicks = Math.min(
    ...plan.tokenPlans.map((tokenPlan) => tokenPlan.observedSpreadTicks)
  );

  if (
    tightestObservedSpreadTicks <=
    config.marketMaker.netPairSpreadCollapseMaxObservedSpreadTicks
  ) {
    return "spread-collapse";
  }

  return undefined;
};

export const resolveMarketMakerOneSideFillResponseState = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined,
  recoveryContext: MarketMakerOneSideFillRecoveryContext | undefined,
  nowMs: number = Date.now()
): MarketMakerOneSideFillResponseState | undefined => {
  if (!config.marketMaker.enableOneSideFillResponse || !recoveryContext) {
    return undefined;
  }

  if (recoveryContext.conditionId !== plan.market.conditionId) {
    return undefined;
  }

  const filledTokenPlan = plan.tokenPlans.find(
    (tokenPlan) => tokenPlan.tokenId === recoveryContext.filledTokenId
  );
  const opposingTokenPlan = plan.tokenPlans.find(
    (tokenPlan) => tokenPlan.tokenId !== recoveryContext.filledTokenId
  );

  if (!filledTokenPlan || !opposingTokenPlan) {
    return undefined;
  }

  const filledInventoryShares = getOpenPosition(filledTokenPlan.tokenId)?.shares ?? 0;
  const opposingInventoryShares = getOpenPosition(opposingTokenPlan.tokenId)?.shares ?? 0;
  const imbalanceShares = filledInventoryShares - opposingInventoryShares;

  if (
    filledInventoryShares <= EPSILON ||
    imbalanceShares + EPSILON < config.marketMaker.oneSideFillMinImbalanceShares
  ) {
    return undefined;
  }

  const ageMs = Math.max(0, nowMs - recoveryContext.activatedAtMs);
  // 🔒 Hedge mode pins the response to "rebalance" forever and skips the
  // unwind-priority escalation. Combined with the aggressive-exit gate in
  // applyOneSideFillResponseToMarketMakerPlan, this prevents the bot from
  // dumping inventory at break-even when one side fills first; instead it
  // relies on a sharper opposing-side BUY to complete the pair naturally.
  const mode: MarketMakerOneSideFillResponseMode =
    config.marketMaker.oneSideFillResponseMode === "hedge"
      ? "rebalance"
      : ageMs >= config.marketMaker.oneSideFillUnwindAfterMs
        ? "unwind-priority"
        : "rebalance";

  return {
    mode,
    marketScope: plan.market.slug,
    conditionId: plan.market.conditionId,
    filledTokenId: filledTokenPlan.tokenId,
    opposingTokenId: opposingTokenPlan.tokenId,
    activatedAtMs: recoveryContext.activatedAtMs,
    ageMs,
    imbalanceShares,
    filledInventoryShares,
    opposingInventoryShares
  };
};

const adjustPassiveBuyQuote = (
  buyQuote: QuoteInstruction,
  sellQuote: QuoteInstruction,
  bestAsk: number,
  inwardTicks: number,
  outwardTicks: number
): QuoteInstruction => {
  let adjustedPrice = buyQuote.price;

  if (inwardTicks > 0) {
    const mostAggressivePassiveBuyPrice = clampPrice(
      Math.min(bestAsk - buyQuote.tickSize, sellQuote.price - buyQuote.tickSize),
      buyQuote.tickSize
    );
    adjustedPrice = clampPrice(
      Math.min(mostAggressivePassiveBuyPrice, adjustedPrice + inwardTicks * buyQuote.tickSize),
      buyQuote.tickSize
    );
  }

  if (outwardTicks > 0) {
    adjustedPrice = clampPrice(
      Math.max(buyQuote.tickSize, adjustedPrice - outwardTicks * buyQuote.tickSize),
      buyQuote.tickSize
    );
  }

  return {
    ...buyQuote,
    price: Math.min(adjustedPrice, sellQuote.price - buyQuote.tickSize)
  };
};

const adjustPassiveSellQuote = (
  sellQuote: QuoteInstruction,
  buyQuote: QuoteInstruction,
  bestBid: number,
  inwardTicks: number
): QuoteInstruction => {
  if (inwardTicks <= 0) {
    return sellQuote;
  }

  const mostAggressivePassiveSellPrice = clampPrice(
    Math.max(bestBid + sellQuote.tickSize, buyQuote.price + sellQuote.tickSize),
    sellQuote.tickSize
  );
  const inwardAdjustedSellPrice = clampPrice(
    sellQuote.price - inwardTicks * sellQuote.tickSize,
    sellQuote.tickSize
  );

  return {
    ...sellQuote,
    price: Math.max(mostAggressivePassiveSellPrice, inwardAdjustedSellPrice)
  };
};

const roundQuoteSize = (size: number): number => Number(size.toFixed(8));

const resolveAggressiveExitChunkSize = (
  filledInventoryShares: number,
  minimumOrderSize: number,
  rejectionCount: number
): number | undefined => {
  if (filledInventoryShares + EPSILON < minimumOrderSize) {
    return undefined;
  }

  const baseChunkSize = Math.max(
    config.marketMaker.oneSideFillAggressiveExitMinChunkShares,
    Math.min(
      config.marketMaker.oneSideFillAggressiveExitMaxChunkShares,
      filledInventoryShares * config.marketMaker.oneSideFillAggressiveExitChunkRatio
    )
  );
  const sizeMultiplier =
    rejectionCount >= config.marketMaker.oneSideFillAggressiveExitRepriceAfterRejects
      ? config.marketMaker.oneSideFillAggressiveExitRejectSizeMultiplier
      : 1;
  const scaledChunkSize = Math.max(
    config.marketMaker.oneSideFillAggressiveExitMinChunkShares,
    baseChunkSize * sizeMultiplier
  );
  let resolvedChunkSize = Math.max(minimumOrderSize, scaledChunkSize);
  const remainingShares = filledInventoryShares - resolvedChunkSize;

  // Avoid leaving a remainder that can no longer be posted on the venue.
  if (remainingShares > EPSILON && remainingShares + EPSILON < minimumOrderSize) {
    resolvedChunkSize = filledInventoryShares;
  }

  return roundQuoteSize(Math.min(filledInventoryShares, resolvedChunkSize));
};

const splitAggressiveExitIntoChunks = (
  filledInventoryShares: number,
  resolvedChunkSize: number,
  minimumOrderSize: number
): number[] => {
  const chunks: number[] = [];
  let remainingShares = roundQuoteSize(filledInventoryShares);

  while (remainingShares > EPSILON) {
    const layersRemaining = ONE_SIDE_AGGRESSIVE_EXIT_MAX_ACTIVE_LAYERS - chunks.length;

    if (layersRemaining <= 1) {
      chunks.push(remainingShares);
      break;
    }

    let nextChunkSize = roundQuoteSize(Math.min(resolvedChunkSize, remainingShares));
    const remainderAfterChunk = roundQuoteSize(remainingShares - nextChunkSize);

    if (remainderAfterChunk > EPSILON && remainderAfterChunk + EPSILON < minimumOrderSize) {
      nextChunkSize = remainingShares;
    }

    chunks.push(nextChunkSize);
    remainingShares = roundQuoteSize(Math.max(0, remainingShares - nextChunkSize));
  }

  return chunks.filter((chunk) => chunk > EPSILON);
};

const buildImmediateExecutableSellQuotes = (
  sellQuote: QuoteInstruction,
  bestBid: number,
  options: MarketMakerOneSideAggressiveExitOptions,
  /** Minimum allowed sell price. Profit exits pass a profit floor; stop exits
   * pass a bounded-loss floor so one bad fill cannot become a many-tick dump. */
  minSellPrice?: number
): QuoteInstruction[] => {
  const resolvedChunkSize = resolveAggressiveExitChunkSize(
    Math.max(options.filledInventoryShares, EPSILON),
    Math.max(options.minimumOrderSize, EPSILON),
    options.rejectionCount
  );

  if (resolvedChunkSize === undefined) {
    return [];
  }

  const chunkSizes = splitAggressiveExitIntoChunks(
    Math.max(options.filledInventoryShares, EPSILON),
    resolvedChunkSize,
    Math.max(options.minimumOrderSize, EPSILON)
  );
  const rejectionConcessionTicks = Math.max(
    0,
    options.rejectionCount -
      config.marketMaker.oneSideFillAggressiveExitRepriceAfterRejects +
      1
  ) * config.marketMaker.oneSideFillAggressiveExitRejectPriceConcessionTicks;
  const ageConcessionTicks = Math.max(0, options.priceConcessionTicks ?? 0);
  const rawExecutablePrice = clampPrice(
    Math.max(
      sellQuote.tickSize,
      bestBid - (rejectionConcessionTicks + ageConcessionTicks) * sellQuote.tickSize
    ),
    sellQuote.tickSize
  );
  // The caller decides whether this is a profit floor or a bounded-loss floor.
  const executablePrice =
    typeof minSellPrice === "number" && minSellPrice > rawExecutablePrice
      ? minSellPrice
      : rawExecutablePrice;

  // 📌 #6 분할 청산. `oneSideAggressiveExitTierTickSpacing` > 0이면 각 chunk를
  // 해당 틱만큼 상위에 배치해서 다양한 taker 가격 민감도에 노출. 0이면 동일
  // 가격 (legacy). Profit floor는 공통이라 최하위 chunk도 floor 아래로 내려가지
  // 않는다.
  const tierTickSpacing =
    config.marketMaker.oneSideAggressiveExitTierTickSpacing * sellQuote.tickSize;
  return chunkSizes.map((chunkSize, index) => {
    const tierPrice =
      tierTickSpacing > 0
        ? clampPrice(
            Math.max(executablePrice, executablePrice + index * tierTickSpacing),
            sellQuote.tickSize
          )
        : executablePrice;
    return {
      ...sellQuote,
      quoteSlot: `one-side-aggressive-exit:${index + 1}`,
      price: tierPrice,
      size: chunkSize,
      postOnly: false,
      orderType: OrderType.GTC,
      executionStyle: "one-side-aggressive-exit" as const,
      expiration: undefined
    };
  });
};

export const applyOneSideFillResponseToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined,
  recoveryContext: MarketMakerOneSideFillRecoveryContext | undefined,
  nowMs: number = Date.now(),
  getAggressiveExitRejectCount: (tokenId: string) => number = () => 0
): MarketMakerPlan => {
  const responseState = resolveMarketMakerOneSideFillResponseState(
    plan,
    getOpenPosition,
    recoveryContext,
    nowMs
  );

  if (!responseState) {
    return plan;
  }

  const suppressedQuoteKeys = new Set<string>();
  const supplementalQuotes: QuoteInstruction[] = [];
  let aggressiveExitEngaged = false;
  const adjustTokenPlan = (tokenPlan: (typeof plan.tokenPlans)[number]) => {
    let buyQuote = tokenPlan.quotes[0];
    let sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote) {
      return tokenPlan;
    }

    if (tokenPlan.tokenId === responseState.filledTokenId) {
      if (responseState.mode === "rebalance") {
        sellQuote = adjustPassiveSellQuote(
          sellQuote,
          buyQuote,
          tokenPlan.bestBid,
          config.marketMaker.oneSideFillRebalanceFilledSellInwardTicks
        );
        buyQuote = adjustPassiveBuyQuote(
          buyQuote,
          sellQuote,
          tokenPlan.bestAsk,
          0,
          config.marketMaker.oneSideFillRebalanceFilledBuyOutwardTicks
        );
      } else {
        sellQuote = adjustPassiveSellQuote(
          sellQuote,
          buyQuote,
          tokenPlan.bestBid,
          config.marketMaker.oneSideFillUnwindSellInwardTicks
        );

        if (config.marketMaker.oneSideFillUnwindSuppressFilledBuy) {
          suppressedQuoteKeys.add(quoteKey(tokenPlan.tokenId, Side.BUY, buyQuote.quoteSlot));
        }
      }

      const filledPosition = getOpenPosition(tokenPlan.tokenId);
      const markEdgeBps = getMarkEdgeBps(tokenPlan, filledPosition);
      // 🔒 Hedge mode disables aggressive exit entirely — the operator forbids
      // dumping inventory when one side fills first. The opposing-side BUY
      // (handled below via oneSideFillHedgeOpposingBuyInwardTicks) is the only
      // recovery action; the filled side just waits for natural pair completion
      // at the profit floor.
      const ageTriggered =
        responseState.ageMs + EPSILON >= config.marketMaker.oneSideFillAggressiveExitAfterMs;
      const stopTriggered =
        typeof markEdgeBps === "number" &&
        markEdgeBps <= -(config.marketMaker.oneSideFillStopMaxLossBps + EPSILON);
      const shouldForceImmediateExit =
        config.marketMaker.oneSideFillResponseMode !== "hedge" &&
        (ageTriggered || stopTriggered);

      if (shouldForceImmediateExit) {
        aggressiveExitEngaged = true;
        const elapsedAfterAggressiveExitMs = Math.max(
          0,
          responseState.ageMs - config.marketMaker.oneSideFillAggressiveExitAfterMs
        );
        const ageBasedConcessionTicks = config.marketMaker.enableAgeBasedUnwind
          ? Math.floor(
              elapsedAfterAggressiveExitMs /
                Math.max(1, config.marketMaker.ageBasedUnwindStepMs)
            )
          : 0;
        const lossSideAgeConcessionTicks =
          typeof markEdgeBps === "number" &&
          markEdgeBps <= -(config.marketMaker.conditionalExitMaxLossBps + EPSILON)
            ? Math.floor(
                elapsedAfterAggressiveExitMs /
                  Math.max(1, config.marketMaker.oneSideFillUnwindAfterMs)
              )
            : 0;
        const priceConcessionTicks = Math.min(
          config.marketMaker.ageBasedUnwindMaxInwardTicks,
          Math.max(
            0,
            stopTriggered ? 1 : 0,
            ageBasedConcessionTicks,
            lossSideAgeConcessionTicks
          )
        );
        const minSellPrice =
          stopTriggered || ageTriggered
            ? resolveBoundedLossExitPriceForPosition(filledPosition, sellQuote.tickSize)
            : resolveMinimumExitPriceForPosition(filledPosition, sellQuote.tickSize, nowMs);
        const aggressiveExitQuotes = buildImmediateExecutableSellQuotes(
          sellQuote,
          tokenPlan.bestBid,
          {
            filledInventoryShares: responseState.filledInventoryShares,
            minimumOrderSize: plan.market.orderMinSize,
            rejectionCount: getAggressiveExitRejectCount(tokenPlan.tokenId),
            priceConcessionTicks
          },
          minSellPrice
        );

        if (aggressiveExitQuotes.length > 0) {
          sellQuote = aggressiveExitQuotes[0]!;
          supplementalQuotes.push(...aggressiveExitQuotes.slice(1));
        }
        suppressedQuoteKeys.add(quoteKey(tokenPlan.tokenId, Side.BUY, buyQuote.quoteSlot));
      }
    }

    if (tokenPlan.tokenId === responseState.opposingTokenId) {
      // 🔒 In hedge mode the opposing BUY is the *only* recovery action, so we
      // step it inward more aggressively than the rebalance default. This
      // raises the chance of a natural pair completion that flat-closes the
      // imbalance without sub-cost selling.
      const opposingInwardTicks =
        config.marketMaker.oneSideFillResponseMode === "hedge"
          ? config.marketMaker.oneSideFillHedgeOpposingBuyInwardTicks
          : config.marketMaker.oneSideFillRebalanceOpposingBuyInwardTicks;
      buyQuote = adjustPassiveBuyQuote(
        buyQuote,
        sellQuote,
        tokenPlan.bestAsk,
        opposingInwardTicks,
        0
      );
    }

    if (aggressiveExitEngaged) {
      suppressedQuoteKeys.add(quoteKey(tokenPlan.tokenId, Side.BUY, buyQuote.quoteSlot));
    }

    return {
      ...tokenPlan,
      quotes: [buyQuote, sellQuote] as [QuoteInstruction, QuoteInstruction]
    };
  };

  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  const rebuiltQuotes = adjustedTokenPlans
    .flatMap((tokenPlan) => tokenPlan.quotes)
    .filter((quote) => !suppressedQuoteKeys.has(quoteKey(quote.tokenId, quote.side, quote.quoteSlot)))
    .concat(supplementalQuotes);
  const originalQuoteByKey = new Map(
    plan.quotes.map((quote) => [quoteKey(quote.tokenId, quote.side, quote.quoteSlot), quote])
  );

  const hasMeaningfulChange =
    suppressedQuoteKeys.size > 0 ||
    supplementalQuotes.length > 0 ||
    rebuiltQuotes.some((quote) =>
      quoteInstructionChanged(
        originalQuoteByKey.get(quoteKey(quote.tokenId, quote.side, quote.quoteSlot)),
        quote
      )
    ) ||
    rebuiltQuotes.length !== plan.quotes.length;

  if (!hasMeaningfulChange) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: rebuiltQuotes
  };
};

export const applyOneSideInventoryHardGateToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPlan => {
  const pairInventoryState = buildMarketMakerPairInventoryState(plan, getOpenPosition);

  if (!pairInventoryState) {
    return plan;
  }

  const totalPairShares = pairInventoryState.sideA.shares + pairInventoryState.sideB.shares;

  if (totalPairShares <= EPSILON) {
    return plan;
  }

  const overweightSide =
    pairInventoryState.sideA.shares >= pairInventoryState.sideB.shares
      ? pairInventoryState.sideA
      : pairInventoryState.sideB;
  const opposingSide =
    overweightSide.tokenId === pairInventoryState.sideA.tokenId
      ? pairInventoryState.sideB
      : pairInventoryState.sideA;
  const overweightRatio = overweightSide.shares / totalPairShares;

  if (overweightRatio + EPSILON < config.marketMaker.oneSideInventoryHardGateRatio) {
    return plan;
  }

  const suppressedQuoteKeys = new Set<string>();
  let hasMeaningfulChange = false;
  const adjustedBuyQuotes = new Map<string, QuoteInstruction>();
  const adjustedSellQuotes = new Map<string, QuoteInstruction>();
  const primaryBuyQuoteByTokenId = new Map<string, QuoteInstruction>();
  const primarySellQuoteByTokenId = new Map<string, QuoteInstruction>();
  const adjustTokenPlan = (tokenPlan: MarketMakerTokenPlan): MarketMakerTokenPlan => {
    let buyQuote = tokenPlan.quotes[0];
    let sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote) {
      return tokenPlan;
    }

    primaryBuyQuoteByTokenId.set(tokenPlan.tokenId, buyQuote);
    primarySellQuoteByTokenId.set(tokenPlan.tokenId, sellQuote);

    if (tokenPlan.tokenId === overweightSide.tokenId) {
      const adjustedSellQuote = adjustPassiveSellQuote(
        sellQuote,
        buyQuote,
        tokenPlan.bestBid,
        config.marketMaker.oneSideFillUnwindSellInwardTicks
      );

      if (adjustedSellQuote !== sellQuote) {
        hasMeaningfulChange = true;
        sellQuote = adjustedSellQuote;
        adjustedSellQuotes.set(tokenPlan.tokenId, adjustedSellQuote);
      }

      suppressedQuoteKeys.add(quoteKey(tokenPlan.tokenId, Side.BUY, buyQuote.quoteSlot));
    }

    if (tokenPlan.tokenId === opposingSide.tokenId) {
      const adjustedBuyQuote = adjustPassiveBuyQuote(
        buyQuote,
        sellQuote,
        tokenPlan.bestAsk,
        config.marketMaker.oneSideFillRebalanceOpposingBuyInwardTicks,
        0
      );

      if (adjustedBuyQuote !== buyQuote) {
        hasMeaningfulChange = true;
        buyQuote = adjustedBuyQuote;
        adjustedBuyQuotes.set(tokenPlan.tokenId, adjustedBuyQuote);
      }
    }

    return {
      ...tokenPlan,
      quotes: [buyQuote, sellQuote] as [QuoteInstruction, QuoteInstruction]
    };
  };

  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];
  const rebuiltQuotes = plan.quotes
    .filter((quote) => !suppressedQuoteKeys.has(quoteKey(quote.tokenId, quote.side, quote.quoteSlot)))
    .map((quote) => {
      if (quote.side === Side.BUY) {
        const primaryBuyQuote = primaryBuyQuoteByTokenId.get(quote.tokenId);
        const adjustedBuyQuote = adjustedBuyQuotes.get(quote.tokenId);

        if (
          primaryBuyQuote &&
          adjustedBuyQuote &&
          quoteKey(quote.tokenId, quote.side, quote.quoteSlot) ===
            quoteKey(primaryBuyQuote.tokenId, primaryBuyQuote.side, primaryBuyQuote.quoteSlot)
        ) {
          return adjustedBuyQuote;
        }

        return quote;
      }

      if (quote.side === Side.SELL) {
        const primarySellQuote = primarySellQuoteByTokenId.get(quote.tokenId);
        const adjustedSellQuote = adjustedSellQuotes.get(quote.tokenId);

        if (!primarySellQuote || !adjustedSellQuote) {
          return quote;
        }

        const rawOffsetTicks = (quote.price - primarySellQuote.price) / quote.tickSize;
        const offsetTicks = Math.round(rawOffsetTicks);
        const adjustedPrice = clampPrice(
          adjustedSellQuote.price + offsetTicks * quote.tickSize,
          quote.tickSize
        );

        return Math.abs(adjustedPrice - quote.price) <= EPSILON
          ? quote
          : { ...quote, price: adjustedPrice };
      }

      return quote;
    });
  const originalQuoteByKey = new Map(
    plan.quotes.map((quote) => [quoteKey(quote.tokenId, quote.side, quote.quoteSlot), quote])
  );
  const quotesChanged =
    rebuiltQuotes.length !== plan.quotes.length ||
    rebuiltQuotes.some((quote) =>
      quoteInstructionChanged(
        originalQuoteByKey.get(quoteKey(quote.tokenId, quote.side, quote.quoteSlot)),
        quote
      )
    );

  if (!hasMeaningfulChange && suppressedQuoteKeys.size === 0 && !quotesChanged) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: rebuiltQuotes
  };
};

export const applyNetPairExitToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPlan => {
  const pairInventoryState = buildMarketMakerPairInventoryState(plan, getOpenPosition);
  const exitMode = resolveMarketMakerNetPairExitMode(plan, pairInventoryState);

  if (!pairInventoryState || !exitMode) {
    return plan;
  }

  const adjustedSellPrices = new Map<string, number>();
  const adjustTokenPlan = (tokenPlan: (typeof plan.tokenPlans)[number]) => {
    const buyQuote = tokenPlan.quotes[0];
    const sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote || sellQuote.side !== "SELL") {
      return tokenPlan;
    }

    const position = getOpenPosition(tokenPlan.tokenId);

    if (!position || position.shares <= EPSILON) {
      return tokenPlan;
    }

    const aggressiveSellPrice = clampPrice(
      tokenPlan.bestBid + sellQuote.tickSize,
      sellQuote.tickSize
    );
    // 🔒 Profit floor — never sell below avgCost + EXIT_MIN_PROFIT_TICKS even
    // when net-pair exit is active. Pair-level P&L tracking previously allowed
    // one side to close at a loss as long as the matched pair was net-positive,
    // but the operator explicitly forbade sub-cost sells ("수익 없는 청산 금지").
    // roundUpToTick keeps the floor strictly above cost.
    const avgCostPerShare = position.totalCostUsdc / position.shares;
    const profitFloor = clampPrice(
      roundUpToTick(
        avgCostPerShare + config.marketMaker.exitMinProfitTicks * sellQuote.tickSize,
        sellQuote.tickSize
      ),
      sellQuote.tickSize
    );
    const flooredAggressiveSellPrice = Math.max(aggressiveSellPrice, profitFloor);
    const adjustedSellQuote = {
      ...sellQuote,
      price: Math.max(Math.min(sellQuote.price, flooredAggressiveSellPrice), profitFloor)
    };

    if (Math.abs(adjustedSellQuote.price - sellQuote.price) <= EPSILON) {
      return tokenPlan;
    }

    adjustedSellPrices.set(quoteSideKey(tokenPlan.tokenId, "SELL"), adjustedSellQuote.price);

    const adjustedQuotes: [QuoteInstruction, QuoteInstruction] = [buyQuote, adjustedSellQuote];

    return {
      ...tokenPlan,
      quotes: adjustedQuotes
    };
  };

  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (adjustedSellPrices.size === 0) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: plan.quotes.map((quote) => {
      if (quote.side !== "SELL") {
        return quote;
      }

      const adjustedPrice = adjustedSellPrices.get(quoteSideKey(quote.tokenId, quote.side));
      return typeof adjustedPrice === "number" ? { ...quote, price: adjustedPrice } : quote;
    })
  };
};

// 🔒 Hard inventory cap. When a token's tracked inventory exceeds
// `maxTokenExposureShares × inventoryCapMultiplier`, this transform:
//   1. Suppresses BUY quotes on that token (no new accumulation),
//   2. Steps the SELL quote inward by `inventoryCapTrimInwardTicks`, while
//      `applyInventoryExitGuard` (run after this) still enforces the absolute
//      profit floor so the trim never crosses below cost.
// This is the "trim only when exceeded" behavior the operator asked for —
// distinct from `applyOneSideInventoryHardGate` which gates on PAIR ratio.
export const applyInventoryCapToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPlan => {
  const cap =
    config.marketMaker.maxTokenExposureShares *
    config.marketMaker.inventoryCapMultiplier;
  if (!(cap > EPSILON)) {
    return plan;
  }

  const overCapTokenIds = new Set<string>();
  const adjustedSellPrices = new Map<string, number>();

  const adjustTokenPlan = (tokenPlan: MarketMakerTokenPlan): MarketMakerTokenPlan => {
    const buyQuote = tokenPlan.quotes[0];
    const sellQuote = tokenPlan.quotes[1];
    if (!buyQuote || !sellQuote) {
      return tokenPlan;
    }
    const position = getOpenPosition(tokenPlan.tokenId);
    if (!position || position.shares <= cap + EPSILON) {
      return tokenPlan;
    }

    overCapTokenIds.add(tokenPlan.tokenId);

    if (sellQuote.side !== Side.SELL) {
      return tokenPlan;
    }

    const inwardTicks = config.marketMaker.inventoryCapTrimInwardTicks;
    if (inwardTicks <= 0) {
      return tokenPlan;
    }
    const aggressiveSellPrice = clampPrice(
      tokenPlan.bestBid + sellQuote.tickSize,
      sellQuote.tickSize
    );
    const inwardAdjusted = clampPrice(
      sellQuote.price - inwardTicks * sellQuote.tickSize,
      sellQuote.tickSize
    );
    const trimPrice = Math.max(aggressiveSellPrice, inwardAdjusted);
    if (Math.abs(trimPrice - sellQuote.price) <= EPSILON) {
      return tokenPlan;
    }

    const adjustedSellQuote: QuoteInstruction = { ...sellQuote, price: trimPrice };
    adjustedSellPrices.set(quoteSideKey(tokenPlan.tokenId, Side.SELL), trimPrice);
    return {
      ...tokenPlan,
      quotes: [buyQuote, adjustedSellQuote] as [QuoteInstruction, QuoteInstruction]
    };
  };

  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (overCapTokenIds.size === 0) {
    return plan;
  }

  const rebuiltQuotes = plan.quotes
    .filter(
      (quote) => !(quote.side === Side.BUY && overCapTokenIds.has(quote.tokenId))
    )
    .map((quote) => {
      if (quote.side !== Side.SELL) return quote;
      const adjustedPrice = adjustedSellPrices.get(quoteSideKey(quote.tokenId, Side.SELL));
      return typeof adjustedPrice === "number" ? { ...quote, price: adjustedPrice } : quote;
    });

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: rebuiltQuotes
  };
};

export const applyInventoryExitGuardToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPlan => {
  const adjustedSellQuotes = new Map<string, QuoteInstruction>();
  const primarySellQuoteByTokenId = new Map<string, QuoteInstruction>();
  const adjustTokenPlan = (tokenPlan: MarketMakerTokenPlan): MarketMakerTokenPlan => {
    const buyQuote = tokenPlan.quotes[0];
    const sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote || sellQuote.side !== Side.SELL) {
      return tokenPlan;
    }

    primarySellQuoteByTokenId.set(tokenPlan.tokenId, sellQuote);

    const position = getOpenPosition(tokenPlan.tokenId);
    const allowLossExit = hasConditionalExitTrigger(tokenPlan, position);
    const adjustedSellQuote = enforceSellQuoteSpreadAndProfitFloor(
      tokenPlan,
      buyQuote,
      sellQuote,
      position,
      allowLossExit
    );

    if (adjustedSellQuote === sellQuote) {
      return tokenPlan;
    }

    adjustedSellQuotes.set(tokenPlan.tokenId, adjustedSellQuote);

    return {
      ...tokenPlan,
      quotes: [buyQuote, adjustedSellQuote] as [QuoteInstruction, QuoteInstruction]
    };
  };
  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (adjustedSellQuotes.size === 0) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: plan.quotes.map((quote) => {
      if (quote.side !== Side.SELL) {
        return quote;
      }

      const adjustedQuote = adjustedSellQuotes.get(quote.tokenId);
      const primarySellQuote = primarySellQuoteByTokenId.get(quote.tokenId);

      if (!adjustedQuote || !primarySellQuote) {
        return quote;
      }

      const rawOffsetTicks = (quote.price - primarySellQuote.price) / quote.tickSize;
      const offsetTicks = Math.max(0, Math.round(rawOffsetTicks));
      const adjustedPrice = clampPrice(
        adjustedQuote.price + offsetTicks * quote.tickSize,
        quote.tickSize
      );

      return Math.abs(adjustedPrice - quote.price) <= EPSILON
        ? quote
        : { ...quote, price: adjustedPrice };
    })
  };
};

export const applyTakeProfitToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined
): MarketMakerPlan => {
  if (!config.marketMaker.enableTakeProfitUnwind) {
    return plan;
  }

  const pairInventoryState = buildMarketMakerPairInventoryState(plan, getOpenPosition);
  const adjustedSellPrices = new Map<string, number>();
  const adjustTokenPlan = (tokenPlan: (typeof plan.tokenPlans)[number]) => {
    const buyQuote = tokenPlan.quotes[0];
    const sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote || sellQuote.side !== "SELL") {
      return tokenPlan;
    }

    const position = getOpenPosition(tokenPlan.tokenId);

    if (!position || position.shares <= EPSILON || position.totalCostUsdc <= EPSILON) {
      return tokenPlan;
    }

    const opposingTokenId =
      tokenPlan.tokenId === plan.tokenPlans[0].tokenId
        ? plan.tokenPlans[1].tokenId
        : plan.tokenPlans[0].tokenId;
    const hasOpposingInventory =
      (pairInventoryState?.sideA.tokenId === opposingTokenId
        ? pairInventoryState.sideA.shares
        : pairInventoryState?.sideB.tokenId === opposingTokenId
          ? pairInventoryState.sideB.shares
          : 0) > EPSILON;

    if (
      hasOpposingInventory &&
      pairInventoryState &&
      (
        pairInventoryState.matchedNetPnlUsdc + EPSILON < config.marketMaker.takeProfitMinPnlUsdc ||
        pairInventoryState.matchedNetEdgeBps + EPSILON < config.marketMaker.takeProfitMinEdgeBps
      )
    ) {
      return tokenPlan;
    }

    const averageCostPerShare = position.totalCostUsdc / position.shares;
    const aggressiveSellPrice = clampPrice(tokenPlan.bestBid + sellQuote.tickSize, sellQuote.tickSize);
    const expectedGrossPnlPerShare = aggressiveSellPrice - averageCostPerShare;
    const expectedGrossPnlUsdc =
      expectedGrossPnlPerShare * Math.min(position.shares, sellQuote.size);
    const expectedGrossEdgeBps =
      averageCostPerShare > EPSILON
        ? (expectedGrossPnlPerShare / averageCostPerShare) * 10_000
        : 0;

    if (
      expectedGrossPnlPerShare <= EPSILON ||
      expectedGrossPnlUsdc + EPSILON < config.marketMaker.takeProfitMinPnlUsdc ||
      expectedGrossEdgeBps + EPSILON < config.marketMaker.takeProfitMinEdgeBps
    ) {
      return tokenPlan;
    }

    // 🔒 Profit floor — also enforce avgCost + EXIT_MIN_PROFIT_TICKS even though
    // gross PnL is already > 0. Without this floor, takeProfit could push the
    // sell price down to bestBid+1tick which can land just barely above cost
    // and effectively zero out spread once fees apply. roundUpToTick keeps
    // the floor strictly above cost rather than collapsing to the cost tick.
    const profitFloor = clampPrice(
      roundUpToTick(
        averageCostPerShare + config.marketMaker.exitMinProfitTicks * sellQuote.tickSize,
        sellQuote.tickSize
      ),
      sellQuote.tickSize
    );
    const flooredAggressiveSellPrice = Math.max(aggressiveSellPrice, profitFloor);
    const adjustedSellQuote = {
      ...sellQuote,
      price: Math.max(Math.min(sellQuote.price, flooredAggressiveSellPrice), profitFloor)
    };
    adjustedSellPrices.set(quoteSideKey(tokenPlan.tokenId, "SELL"), adjustedSellQuote.price);

    const adjustedQuotes: [QuoteInstruction, QuoteInstruction] = [buyQuote, adjustedSellQuote];

    return {
      ...tokenPlan,
      quotes: adjustedQuotes
    };
  };
  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (adjustedSellPrices.size === 0) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: plan.quotes.map((quote) => {
      if (quote.side !== "SELL") {
        return quote;
      }

      const adjustedPrice = adjustedSellPrices.get(quoteSideKey(quote.tokenId, quote.side));
      return typeof adjustedPrice === "number" ? { ...quote, price: adjustedPrice } : quote;
    })
  };
};

export const applyAgeBasedUnwindToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined,
  nowMs: number = Date.now()
): MarketMakerPlan => {
  if (!config.marketMaker.enableAgeBasedUnwind) {
    return plan;
  }

  const adjustedSellPrices = new Map<string, number>();
  const adjustTokenPlan = (tokenPlan: (typeof plan.tokenPlans)[number]) => {
    const buyQuote = tokenPlan.quotes[0];
    const sellQuote = tokenPlan.quotes[1];

    if (!buyQuote || !sellQuote || sellQuote.side !== "SELL") {
      return tokenPlan;
    }

    const position = getOpenPosition(tokenPlan.tokenId);

    if (!position || position.shares <= EPSILON) {
      return tokenPlan;
    }

    const positionAgeMs = Math.max(0, nowMs - position.openedAtMs);
    const markEdgeBps = getMarkEdgeBps(tokenPlan, position) ?? Number.NEGATIVE_INFINITY;
    const staleBreakEvenTrigger =
      config.marketMaker.enableStaleBreakEvenUnwind &&
      positionAgeMs + EPSILON >= config.marketMaker.staleBreakEvenUnwindAfterMs &&
      markEdgeBps + EPSILON >= config.marketMaker.staleBreakEvenUnwindMinEdgeBps;

    if (positionAgeMs + EPSILON < config.marketMaker.ageBasedUnwindAfterMs) {
      return tokenPlan;
    }

    if (!hasConditionalExitTrigger(tokenPlan, position) && !staleBreakEvenTrigger) {
      return tokenPlan;
    }

    const elapsedAfterThresholdMs =
      positionAgeMs - config.marketMaker.ageBasedUnwindAfterMs;
    const inwardTicks = Math.min(
      config.marketMaker.ageBasedUnwindMaxInwardTicks,
      1 + Math.floor(elapsedAfterThresholdMs / config.marketMaker.ageBasedUnwindStepMs)
    );
    const mostAggressivePassiveSellPrice = clampPrice(
      tokenPlan.bestBid + sellQuote.tickSize,
      sellQuote.tickSize
    );
    const inwardAdjustedSellPrice = clampPrice(
      sellQuote.price - inwardTicks * sellQuote.tickSize,
      sellQuote.tickSize
    );
    // 🔒 Profit floor — never sell below avgCost + EXIT_MIN_PROFIT_TICKS.
    // This is what was missing: ageBasedUnwind was bypassing the floor and
    // forcing sub-cost SELL prices, producing the "0.27 buy → 0.26 sell" losses.
    // Round UP so avg 0.172 + 1tick → 0.19 (not the collapsed 0.18 that
    // banker's-rounding toFixed would produce).
    const avgCostPerShare = position.totalCostUsdc / position.shares;
    const profitFloor = clampPrice(
      roundUpToTick(
        avgCostPerShare + config.marketMaker.exitMinProfitTicks * sellQuote.tickSize,
        sellQuote.tickSize
      ),
      sellQuote.tickSize
    );
    const adjustedSellQuote = {
      ...sellQuote,
      price: Math.max(
        mostAggressivePassiveSellPrice,
        inwardAdjustedSellPrice,
        profitFloor
      )
    };

    if (Math.abs(adjustedSellQuote.price - sellQuote.price) <= EPSILON) {
      return tokenPlan;
    }

    adjustedSellPrices.set(quoteSideKey(tokenPlan.tokenId, "SELL"), adjustedSellQuote.price);

    const adjustedQuotes: [QuoteInstruction, QuoteInstruction] = [buyQuote, adjustedSellQuote];

    return {
      ...tokenPlan,
      quotes: adjustedQuotes
    };
  };
  const adjustedTokenPlans: typeof plan.tokenPlans = [
    adjustTokenPlan(plan.tokenPlans[0]),
    adjustTokenPlan(plan.tokenPlans[1])
  ];

  if (adjustedSellPrices.size === 0) {
    return plan;
  }

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: plan.quotes.map((quote) => {
      if (quote.side !== "SELL") {
        return quote;
      }

      const adjustedPrice = adjustedSellPrices.get(quoteSideKey(quote.tokenId, quote.side));
      return typeof adjustedPrice === "number" ? { ...quote, price: adjustedPrice } : quote;
    })
  };
};

export const resolveMarketMakerMaxHoldHardExitState = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined,
  nowMs: number = Date.now()
): MarketMakerMaxHoldHardExitState | undefined => {
  if (!config.marketMaker.enableMaxHoldHardExit) {
    return undefined;
  }

  const agedTokenIds = plan.tokenPlans
    .filter((tokenPlan) => {
      const position = getOpenPosition(tokenPlan.tokenId);

      if (!position || position.shares <= EPSILON) {
        return false;
      }

      if (nowMs - position.openedAtMs + EPSILON < config.marketMaker.maxHoldHardExitAfterMs) {
        return false;
      }

      return hasConditionalExitTrigger(tokenPlan, position);
    })
    .map((tokenPlan) => tokenPlan.tokenId);

  if (agedTokenIds.length === 0) {
    return undefined;
  }

  const oldestPositionAgeMs = Math.max(
    ...agedTokenIds.map((tokenId) => {
      const position = getOpenPosition(tokenId)!;
      return Math.max(0, nowMs - position.openedAtMs);
    })
  );

  return {
    marketScope: plan.market.slug,
    conditionId: plan.market.conditionId,
    agedTokenIds,
    oldestPositionAgeMs
  };
};

export const applyMaxHoldHardExitToMarketMakerPlan = (
  plan: MarketMakerPlan,
  getOpenPosition: (tokenId: string) => TrackedInventoryPosition | undefined,
  nowMs: number = Date.now()
): MarketMakerPlan => {
  const hardExitState = resolveMarketMakerMaxHoldHardExitState(plan, getOpenPosition, nowMs);

  if (!hardExitState) {
    return plan;
  }

  const agedTokenIdSet = new Set(hardExitState.agedTokenIds);
  const adjustedTokenPlans: typeof plan.tokenPlans = [...plan.tokenPlans];

  const adjustedQuotes = plan.quotes.filter((quote) => {
    if (agedTokenIdSet.has(quote.tokenId)) {
      return false;
    }

    if (!(config.marketMaker.maxHoldHardExitSuppressBuys && quote.side === Side.BUY)) {
      return true;
    }

    return !agedTokenIdSet.has(quote.tokenId);
  });

  return {
    ...plan,
    tokenPlans: adjustedTokenPlans,
    quotes: adjustedQuotes
  };
};

export const activeQuoteToActiveOrder = (quote: ActiveQuote): ActiveOrderState => ({
  orderId: quote.orderId,
  strategy: "market-making",
  priority: getDefaultStrategyPriority("market-making"),
  conditionId: quote.conditionId,
  tokenId: quote.tokenId,
  side: quote.side,
  quoteSlot: quote.quoteSlot,
  price: quote.price,
  size: quote.size,
  tif: quote.orderType,
  postOnly: quote.postOnly,
  openedAtMs: quote.openedAtMs
});

export const toQuoteConflictKey = (quote: QuoteInstruction): string =>
  quoteKey(quote.tokenId, quote.side, quote.quoteSlot);
