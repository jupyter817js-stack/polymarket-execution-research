import { config } from "../config.js";
import type { NegativeRiskGroup } from "../strategy/negative-risk.js";
import type { BinaryMarket } from "../types.js";

export type MarketSelectionProfile =
  | "market-making"
  | "same-market-arb"
  // Fix K: negRisk events are multi-outcome (5–20 markets per event). Each individual
  // market needs only YES book depth for yes-basket arb, and NO book depth for
  // no-to-yes-conversion. Applying same-market-arb's two-sided requirement to negRisk
  // markets dropped most of the universe after the first refresh and prevented
  // negative-risk-bot from finding complete groups.
  | "negative-risk";

export interface MarketSelectionSignal {
  spreadScore: number;
  activityScore: number;
  depthScore: number;
  averageSpread?: number;
  topBookLiquidityFloorUsdc?: number;
  bestBidNotionalFloorUsdc?: number;
  bestAskNotionalFloorUsdc?: number;
  bestBidSizeFloorShares?: number;
  bestAskQueueCeilingShares?: number;
  marketableExitNotionalUsdc?: number;
  expectedExitSeconds?: number;
  recentActivityEventsInWindow?: number;
  /** Actual trade events in the activity window (subset of activity events). */
  recentTradeEventsInWindow?: number;
  /** Minimum recent trade count across both outcome tokens. */
  recentTradeEventsFloorInWindow?: number;
  midpointRangeInWindow?: number;
  averageBookAgeMs?: number;
  averageTopLevelCoverage?: number;
  freshBookCount: number;
  twoSidedBookCount: number;
  lastTradeBookCount: number;
  /**
   * Score in [0, 1] derived from the rolling price-displacement rate for this
   * market's passive quotes. 1 = no competition pressure, 0 = all quotes
   * displaced by competitors. Absent until enough data has been collected.
   */
  makerCompetitionScore?: number;
}

export interface MarketSelectionBreakdown {
  liquidity: number;
  reward: number;
  rebate: number;
  expiry: number;
  structure: number;
  spread: number;
  activity: number;
  retentionBonus: number;
  total: number;
  reasons: string[];
}

export interface RankedMarketSelection {
  market: BinaryMarket;
  breakdown: MarketSelectionBreakdown;
}

export interface MarketSelectionDiagnostics {
  profile: MarketSelectionProfile;
  mandatoryCandidateCount: number;
  preferredCandidateCount: number;
  candidateCount: number;
  selectedCount: number;
  maxMarkets: number;
  averageScore: number;
  selectedAverageScore: number;
  usedMandatoryFallback: boolean;
  preferredRejectReasons: Record<string, number>;
  topSelections: Array<{
    slug: string;
    category?: string;
    liquidity?: number;
    rewardRatePerDay?: number;
    feesEnabled: boolean;
    score: number;
    breakdown: Omit<MarketSelectionBreakdown, "reasons">;
    reasons: string[];
  }>;
}

export interface MarketSelectionResult {
  rankedMarkets: RankedMarketSelection[];
  selectedMarkets: BinaryMarket[];
  diagnostics: MarketSelectionDiagnostics;
}

export interface NegativeRiskGroupSelectionBreakdown {
  liquidity: number;
  reward: number;
  rebate: number;
  expiry: number;
  structure: number;
  spread: number;
  activity: number;
  retentionBonus: number;
  total: number;
  reasons: string[];
}

export interface RankedNegativeRiskGroupSelection {
  group: NegativeRiskGroup;
  breakdown: NegativeRiskGroupSelectionBreakdown;
}

export interface NegativeRiskGroupSelectionDiagnostics {
  candidateCount: number;
  selectedGroupCount: number;
  selectedMarketCount: number;
  maxMarkets: number;
  averageScore: number;
  selectedAverageScore: number;
  topSelections: Array<{
    eventSlug: string;
    eventTitle: string;
    marketCount: number;
    totalLiquidity: number;
    averageRewardRatePerDay: number;
    score: number;
    breakdown: Omit<NegativeRiskGroupSelectionBreakdown, "reasons">;
    reasons: string[];
  }>;
}

export interface NegativeRiskGroupSelectionResult {
  rankedGroups: RankedNegativeRiskGroupSelection[];
  selectedGroups: NegativeRiskGroup[];
  diagnostics: NegativeRiskGroupSelectionDiagnostics;
}

type SelectionWeights = {
  liquidity: number;
  reward: number;
  rebate: number;
  expiry: number;
  structure: number;
  spread: number;
  activity: number;
};

const marketSelectionWeights: Record<MarketSelectionProfile, SelectionWeights> = {
  "market-making": {
    liquidity: 0.15,
    reward: 0.2,
    rebate: 0.15,
    expiry: 0.08,
    structure: 0.1,
    spread: 0.12,
    activity: 0.2
  },
  "same-market-arb": {
    liquidity: 0.34,
    reward: 0.03,
    rebate: 0.18,
    expiry: 0.08,
    structure: 0.12,
    spread: 0.15,
    activity: 0.1
  },
  // Fix K: negRisk profile prioritizes liquidity + structure (group completeness) over
  // spread/activity. Inactive long-tail outcomes are still kept in the universe so
  // gamma-confirmed groups can stay complete across refresh cycles.
  "negative-risk": {
    liquidity: 0.4,
    reward: 0.0,
    rebate: 0.0,
    expiry: 0.1,
    structure: 0.2,
    spread: 0.1,
    activity: 0.2
  }
};

const negativeRiskGroupSelectionWeights: SelectionWeights = {
  liquidity: 0.28,
  reward: 0.05,
  rebate: 0.05,
  expiry: 0.12,
  structure: 0.2,
  spread: 0.15,
  activity: 0.15
};
const MARKET_MAKING_NON_EXECUTABLE_REWARD_PENALTY = 0.18;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const roundScore = (value: number): number => Number(value.toFixed(4));

const normalizeLinear = (value: number, minValue: number, maxValue: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (maxValue <= minValue) {
    return value >= maxValue ? 1 : 0;
  }

  return clamp01((value - minValue) / (maxValue - minValue));
};

const normalizeLog = (value: number, minValue: number, maxValue: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return normalizeLinear(
    Math.log10(value + 1),
    Math.log10(Math.max(minValue, 0) + 1),
    Math.log10(Math.max(maxValue, minValue + 1) + 1)
  );
};

const getTradeCutoffTimestamp = (market: BinaryMarket): number | undefined => {
  const candidates = [market.gameStartTime, market.endDate]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (candidates.length === 0) {
    return undefined;
  }

  return Math.min(...candidates);
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const average = (values: readonly number[]): number =>
  values.length > 0 ? sum(values) / values.length : 0;

const scoreLiquidity = (liquidity: number | undefined, preferredLiquidity: number): number =>
  roundScore(
    normalizeLinear(
      liquidity ?? 0,
      config.marketUniverse.minMarketLiquidity,
      preferredLiquidity
    )
  );

const hasRewardSignal = (market: BinaryMarket): boolean =>
  (market.rewardRatePerDay ?? 0) > 0 ||
  (market.rewardsMaxSpread ?? 0) > 0 ||
  (market.rewardsMinSize ?? 0) > 0;

const hasExecutableMarketMakerRewardSignal = (market: BinaryMarket): boolean =>
  hasRewardSignal(market) && isMarketMakerRewardExecutable(market);

const getPotentialMarketMakerRewardQuoteSize = (): number =>
  config.marketMaker.quoteSize *
  (config.marketMaker.enableRewardRebateScheduling
    ? config.marketMaker.rewardSchedulingMaxQuoteSizeMultiplier
    : 1);

const getPotentialMarketMakerRewardSpreadFloor = (market: BinaryMarket): number => {
  const tickSize = market.orderPriceMinTickSize;
  const configuredHalfSpread = config.marketMaker.quoteHalfSpreadTicks * tickSize * 2;
  const configuredMinimumSpread = config.marketMaker.minSpreadTicks * tickSize;

  return Math.max(configuredHalfSpread, configuredMinimumSpread);
};

const isMarketMakerRewardExecutable = (market: BinaryMarket): boolean => {
  if ((market.rewardRatePerDay ?? 0) <= 0) {
    return false;
  }

  const rewardSizeSatisfied =
    !(typeof market.rewardsMinSize === "number" && market.rewardsMinSize > 0) ||
    config.marketMaker.useRewardMinSize ||
    getPotentialMarketMakerRewardQuoteSize() + Number.EPSILON >= market.rewardsMinSize;

  const rewardSpreadSatisfied =
    !(typeof market.rewardsMaxSpread === "number" && market.rewardsMaxSpread > 0) ||
    !config.marketMaker.enableRewardConstraints ||
    market.rewardsMaxSpread + Number.EPSILON >= getPotentialMarketMakerRewardSpreadFloor(market);

  return rewardSizeSatisfied && rewardSpreadSatisfied;
};

const scoreReward = (market: BinaryMarket, rewardWeightEnabled: boolean): number => {
  if (!rewardWeightEnabled || !hasRewardSignal(market)) {
    return 0;
  }

  if (!isMarketMakerRewardExecutable(market)) {
    return 0;
  }

  if ((market.rewardRatePerDay ?? 0) > 0) {
    return roundScore(normalizeLinear(market.rewardRatePerDay ?? 0, 0, 3));
  }

  return 0.35;
};

const getCategoryRebateScore = (market: BinaryMarket): number => {
  if (!market.feesEnabled) {
    return 0;
  }

  const categoryKey = market.category?.trim().toLowerCase();

  if (!categoryKey) {
    return 0.6;
  }

  const rule = config.rebates.categoryRules[categoryKey];

  if (!rule) {
    return 0.6;
  }

  const maxKnownMakerRebatePct = Math.max(
    ...Object.values(config.rebates.categoryRules).map((entry) => entry.makerRebatePct),
    0.25
  );

  return roundScore(0.5 + 0.5 * normalizeLinear(rule.makerRebatePct, 0, maxKnownMakerRebatePct));
};

const scoreRebateOrFeeStructure = (
  market: BinaryMarket,
  profile: MarketSelectionProfile
): number => {
  if (profile === "same-market-arb") {
    return market.feesEnabled ? 0.25 : 1;
  }

  if (!market.feesEnabled) {
    return hasExecutableMarketMakerRewardSignal(market) ? 0.35 : 0.2;
  }

  return getCategoryRebateScore(market);
};

const scoreExpiry = (market: BinaryMarket): number => {
  const cutoffTimestamp = getTradeCutoffTimestamp(market);

  if (typeof cutoffTimestamp !== "number") {
    return 0.55;
  }

  const secondsToCutoff = Math.max(0, Math.floor((cutoffTimestamp - Date.now()) / 1000));
  const preferredSecondsToCutoff = Math.min(
    config.marketUniverse.maxSecondsToEnd ?? 86_400,
    86_400
  );
  const normalized = normalizeLinear(
    secondsToCutoff,
    config.marketUniverse.minSecondsToEnd,
    Math.max(config.marketUniverse.minSecondsToEnd + 1, preferredSecondsToCutoff)
  );

  return roundScore(0.4 + 0.6 * normalized);
};

const scoreStructure = (market: BinaryMarket, profile: MarketSelectionProfile): number => {
  if (profile === "same-market-arb") {
    return market.negRisk ? 0.65 : 1;
  }

  let score = hasRewardSignal(market) && !hasExecutableMarketMakerRewardSignal(market) ? 0.48 : 0.55;

  if (hasExecutableMarketMakerRewardSignal(market)) {
    score += 0.2;
  }

  if (market.feesEnabled) {
    score += 0.15;
  }

  if (market.category) {
    score += 0.1;
  }

  return roundScore(Math.min(1, score));
};

const getFallbackSpread = (market: BinaryMarket): number | undefined =>
  typeof market.spread === "number" && Number.isFinite(market.spread) && market.spread > 0
    ? market.spread
    : typeof market.bestBid === "number" &&
        typeof market.bestAsk === "number" &&
        Number.isFinite(market.bestBid) &&
        Number.isFinite(market.bestAsk) &&
        market.bestAsk > market.bestBid
      ? market.bestAsk - market.bestBid
      : undefined;

const getEffectiveSpread = (
  market: BinaryMarket,
  signal: MarketSelectionSignal | undefined
): number | undefined => {
  if (
    typeof signal?.averageSpread === "number" &&
    Number.isFinite(signal.averageSpread) &&
    signal.averageSpread > 0
  ) {
    return signal.averageSpread;
  }

  return getFallbackSpread(market);
};

const scoreSpread = (
  market: BinaryMarket,
  profile: MarketSelectionProfile,
  signal: MarketSelectionSignal | undefined
): number => {
  const fallbackSpread = getFallbackSpread(market);

  if (!signal) {
    if (typeof fallbackSpread !== "number") {
      return 0.5;
    }

    if (profile !== "market-making") {
      return roundScore(1 - clamp01((fallbackSpread - 0.01) / 0.07));
    }

    const preferredSpreadFloor = Math.max(
      market.orderPriceMinTickSize * config.marketMaker.minSpreadTicks,
      0.01
    );

    return roundScore(normalizeLinear(fallbackSpread, preferredSpreadFloor, 0.08));
  }

  if (profile !== "market-making") {
    return signal.spreadScore;
  }

  const averageSpread = signal.averageSpread;

  if (typeof averageSpread !== "number" || !Number.isFinite(averageSpread)) {
    return 0.5;
  }

  const preferredSpreadFloor = Math.max(
    market.orderPriceMinTickSize * config.marketMaker.minSpreadTicks,
    0.01
  );

  return roundScore(normalizeLinear(averageSpread, preferredSpreadFloor, 0.08));
};

const scoreMetadataActivity = (market: BinaryMarket): number => {
  const recentVolumeScore = normalizeLog(market.volume24hr ?? 0, 250, 100_000);
  const cumulativeVolumeScore = normalizeLog(market.volume ?? 0, 1_000, 1_000_000);
  const competitiveScore = normalizeLinear(market.competitive ?? 0, 0, 100);
  const marketScore = normalizeLinear(market.marketScore ?? 0, 0, 100);
  const total =
    recentVolumeScore * 0.5 +
    cumulativeVolumeScore * 0.2 +
    competitiveScore * 0.2 +
    marketScore * 0.1;

  return roundScore(total > 0 ? total : 0.45);
};

const scoreRecentTradeFlow = (signal: MarketSelectionSignal): number => {
  const recentTradeEvents = Math.max(0, signal.recentTradeEventsInWindow ?? 0);
  const minimumTradeEvents = Math.max(config.marketUniverse.minRecentTradeEvents, 1);
  const preferredTradeEvents = Math.max(minimumTradeEvents + 2, 4);

  return roundScore(
    normalizeLinear(recentTradeEvents, minimumTradeEvents, preferredTradeEvents)
  );
};

const scoreTradeParticipation = (signal: MarketSelectionSignal): number => {
  const recentActivityEvents = Math.max(0, signal.recentActivityEventsInWindow ?? 0);
  const recentTradeEvents = Math.max(0, signal.recentTradeEventsInWindow ?? 0);

  if (recentActivityEvents <= 0 || recentTradeEvents <= 0) {
    return 0;
  }

  // A market where a meaningful share of book updates convert into actual fills
  // is materially better for MM than one with pure quote churn. 35% is treated
  // as a strong trade-to-activity ratio.
  const tradeParticipationRatio = recentTradeEvents / recentActivityEvents;
  return roundScore(clamp01(tradeParticipationRatio / 0.35));
};

const getMandatoryExitDepthNotionalUsdc = (): number =>
  config.marketUniverse.minExitDepthMultiplier > 0
    ? config.marketMaker.quoteSize * config.marketUniverse.minExitDepthMultiplier * 0.5
    : 0;

const getTargetQuoteNotionalUsdc = (): number => config.marketMaker.quoteSize * 0.5;

const getMarketMakingPreferredExpectedExitSeconds = (): number =>
  Math.max(1, config.marketMaker.passiveBuyMaxExpectedExitSeconds);

const getMarketMakingMandatoryExpectedExitSeconds = (): number =>
  Math.max(
    getMarketMakingPreferredExpectedExitSeconds(),
    Math.round(getMarketMakingPreferredExpectedExitSeconds() * 2)
  );

const getPreferredExpectedExitSeconds = (profile?: MarketSelectionProfile): number =>
  profile === "market-making"
    ? getMarketMakingPreferredExpectedExitSeconds()
    : Math.max(45, Math.round((config.marketUniverse.activityWindowMs / 1_000) * 1.25));

const getMandatoryExpectedExitSeconds = (profile?: MarketSelectionProfile): number =>
  profile === "market-making"
    ? getMarketMakingMandatoryExpectedExitSeconds()
    : Math.max(60, Math.round((config.marketUniverse.activityWindowMs / 1_000) * 2));

const getRequiredPassiveBuyBestBidSupportShares = (): number =>
  config.marketMaker.quoteSize * config.marketMaker.passiveBuyMinBestBidSupportMultiplier;

const getMaximumPassiveBuyExitQueueAheadShares = (): number =>
  config.marketMaker.quoteSize * config.marketMaker.passiveBuyMaxTargetExitQueueMultiplier;

const hasMarketMakingPreferredExecutionSignal = (
  signal: MarketSelectionSignal | undefined
): signal is MarketSelectionSignal => {
  if (!signal) {
    return false;
  }

  return (
    signal.freshBookCount > 0 &&
    signal.twoSidedBookCount > 0 &&
    typeof signal.recentTradeEventsInWindow === "number" &&
    signal.recentTradeEventsInWindow + Number.EPSILON >=
      Math.max(config.marketUniverse.minRecentTradeEvents, 1) &&
    typeof signal.marketableExitNotionalUsdc === "number" &&
    Number.isFinite(signal.marketableExitNotionalUsdc) &&
    typeof signal.bestBidSizeFloorShares === "number" &&
    Number.isFinite(signal.bestBidSizeFloorShares) &&
    typeof signal.bestAskQueueCeilingShares === "number" &&
    Number.isFinite(signal.bestAskQueueCeilingShares)
  );
};

const scoreExitability = (
  signal: MarketSelectionSignal,
  profile?: MarketSelectionProfile
): number => {
  const requiredExitNotionalUsdc = getTargetQuoteNotionalUsdc();
  const exitNotionalScore =
    typeof signal.marketableExitNotionalUsdc === "number" &&
    Number.isFinite(signal.marketableExitNotionalUsdc)
      ? normalizeLinear(
          signal.marketableExitNotionalUsdc,
          requiredExitNotionalUsdc,
          Math.max(requiredExitNotionalUsdc * 2.5, requiredExitNotionalUsdc + 20)
        )
      : 0;
  const preferredExpectedExitSeconds = getPreferredExpectedExitSeconds(profile);
  const exitVelocityScore =
    typeof signal.expectedExitSeconds === "number" &&
    Number.isFinite(signal.expectedExitSeconds) &&
    signal.expectedExitSeconds > 0
      ? 1 -
        clamp01(
          (signal.expectedExitSeconds - 15) /
            Math.max(1, preferredExpectedExitSeconds - 15)
        )
      : 0;

  if (exitNotionalScore <= 0 && exitVelocityScore <= 0) {
    return 0;
  }

  return roundScore(exitNotionalScore * 0.4 + exitVelocityScore * 0.6);
};

const scoreActivity = (
  market: BinaryMarket,
  signal: MarketSelectionSignal | undefined,
  profile?: MarketSelectionProfile
): number => {
  const metadataScore = scoreMetadataActivity(market);

  if (!signal) {
    // No live trade telemetry yet: keep metadata as a weak fallback, but do not
    // let depth-only markets outrank markets with verified recent fills.
    return roundScore(metadataScore * 0.6);
  }

  const tradeFlowScore = scoreRecentTradeFlow(signal);
  const tradeParticipationScore = scoreTradeParticipation(signal);
  const exitabilityScore = scoreExitability(signal, profile);
  const liveExecutionScore = roundScore(
    tradeFlowScore * 0.5 + tradeParticipationScore * 0.15 + exitabilityScore * 0.35
  );

  return roundScore(
    signal.activityScore * 0.3 +
      liveExecutionScore * 0.55 +
      metadataScore * 0.15
  );
};

const buildMarketReasons = (
  market: BinaryMarket,
  profile: MarketSelectionProfile,
  breakdown: Omit<MarketSelectionBreakdown, "reasons" | "total">,
  signal: MarketSelectionSignal | undefined
): string[] => {
  const reasons: string[] = [];

  if (breakdown.liquidity >= 0.8) {
    reasons.push("high_liquidity");
  }

  if (breakdown.spread >= 0.75) {
    reasons.push(profile === "market-making" ? "quotable_spread_signal" : "tight_spread_signal");
  }

  if (breakdown.activity >= 0.7) {
    reasons.push("fresh_active_books");
  }

  if (
    typeof signal?.recentTradeEventsInWindow === "number" &&
    signal.recentTradeEventsInWindow >= Math.max(config.marketUniverse.minRecentTradeEvents, 1)
  ) {
    reasons.push("recent_trade_flow_verified");
  }

  if (
    typeof signal?.recentTradeEventsFloorInWindow === "number" &&
    signal.recentTradeEventsFloorInWindow >= 1
  ) {
    reasons.push("two_sided_recent_trade_flow_verified");
  }

  if (
    typeof signal?.recentTradeEventsInWindow === "number" &&
    signal.recentTradeEventsInWindow >= Math.max(config.marketUniverse.minRecentTradeEvents * 2, 4)
  ) {
    reasons.push("repeated_recent_fills");
  }

  if (
    typeof signal?.topBookLiquidityFloorUsdc === "number" &&
    signal.topBookLiquidityFloorUsdc + Number.EPSILON >=
      config.marketMaker.minTopBookLiquidityUsdc
  ) {
    reasons.push("top_book_liquidity_verified");
  }

  if (
    typeof signal?.bestBidSizeFloorShares === "number" &&
    signal.bestBidSizeFloorShares + Number.EPSILON >=
      getRequiredPassiveBuyBestBidSupportShares()
  ) {
    reasons.push("best_bid_share_support_verified");
  }

  if (
    typeof signal?.bestAskQueueCeilingShares === "number" &&
    signal.bestAskQueueCeilingShares - Number.EPSILON <=
      getMaximumPassiveBuyExitQueueAheadShares()
  ) {
    reasons.push("touch_exit_queue_reasonable");
  }

  if (
    typeof signal?.marketableExitNotionalUsdc === "number" &&
    signal.marketableExitNotionalUsdc + Number.EPSILON >= getTargetQuoteNotionalUsdc()
  ) {
    reasons.push("multi_level_exit_depth_verified");
  }

  if (
    typeof signal?.expectedExitSeconds === "number" &&
    signal.expectedExitSeconds - Number.EPSILON <= getPreferredExpectedExitSeconds(profile)
  ) {
    reasons.push("fast_expected_exit");
  }

  if ((market.volume24hr ?? 0) > 0) {
    reasons.push("recent_volume_present");
  }

  if ((market.rewardRatePerDay ?? 0) > 0) {
    reasons.push("reward_rate_present");
  } else if (hasRewardSignal(market)) {
    reasons.push("reward_constraints_present");
  }

  if (
    profile === "market-making" &&
    hasRewardSignal(market) &&
    !isMarketMakerRewardExecutable(market)
  ) {
    reasons.push("reward_not_executable_with_current_mm_config");
  }

  if (profile === "market-making" && market.feesEnabled) {
    reasons.push("fee_enabled_rebate_candidate");
  }

  if (profile === "same-market-arb" && !market.feesEnabled) {
    reasons.push("fee_free_entry_preferred");
  }

  if (market.negRisk) {
    reasons.push("neg_risk_market");
  }

  if (breakdown.expiry >= 0.75) {
    reasons.push("comfortable_time_to_expiry");
  }

  if (breakdown.retentionBonus > 0) {
    reasons.push("selection_stickiness_boost");
  }

  return reasons;
};

const scoreMarket = (
  market: BinaryMarket,
  profile: MarketSelectionProfile,
  signal: MarketSelectionSignal | undefined,
  retentionBonus: number
): MarketSelectionBreakdown => {
  const weights = marketSelectionWeights[profile];
  const componentScores = {
    liquidity: scoreLiquidity(
      market.liquidity,
      profile === "market-making" ? 300_000 : 250_000
    ),
    reward: scoreReward(market, profile === "market-making"),
    rebate: scoreRebateOrFeeStructure(market, profile),
    expiry: scoreExpiry(market),
    structure: scoreStructure(market, profile),
    spread: scoreSpread(market, profile, signal),
    activity: scoreActivity(market, signal, profile),
    retentionBonus: roundScore(retentionBonus)
  };
  const weightedTotal =
    componentScores.liquidity * weights.liquidity +
      componentScores.reward * weights.reward +
      componentScores.rebate * weights.rebate +
      componentScores.expiry * weights.expiry +
      componentScores.structure * weights.structure +
      componentScores.spread * weights.spread +
      componentScores.activity * weights.activity +
      componentScores.retentionBonus;
  const executionMismatchPenalty =
    profile === "market-making" &&
    hasRewardSignal(market) &&
    !hasExecutableMarketMakerRewardSignal(market)
      ? MARKET_MAKING_NON_EXECUTABLE_REWARD_PENALTY
      : 0;
  // Penalise markets where competitors frequently displace our passive quotes.
  // Graduated penalty: mild for moderate competition, severe for extreme displacement.
  // makerCompetitionScore 0 = 100% displacement → penalty up to 0.35 (effective exit).
  // makerCompetitionScore 0.5+ = healthy → zero penalty.
  // The field is absent until the tracker has enough data, so the penalty is
  // zero for markets we have not yet observed.
  const makerCompetitionPenalty = (() => {
    if (profile !== "market-making" || typeof signal?.makerCompetitionScore !== "number") {
      return 0;
    }
    const score = signal.makerCompetitionScore;
    // Extreme competition (score < 0.2 = displacement > 80%): steep penalty
    if (score < 0.2) {
      return 0.15 + (0.2 - score) * 1.0; // 0.15–0.35
    }
    // Moderate competition (score 0.2–0.5): graduated penalty
    if (score < 0.5) {
      return Math.max(0, 0.5 - score) * 0.5; // 0–0.15
    }
    return 0;
  })();
  const total = roundScore(
    Math.max(0, weightedTotal - executionMismatchPenalty - makerCompetitionPenalty)
  );

  return {
    ...componentScores,
    total,
    reasons: buildMarketReasons(market, profile, componentScores, signal)
  };
};

const compareRankedMarkets = (left: RankedMarketSelection, right: RankedMarketSelection): number =>
  right.breakdown.total - left.breakdown.total ||
  right.breakdown.activity - left.breakdown.activity ||
  right.breakdown.spread - left.breakdown.spread ||
  (right.market.liquidity ?? 0) - (left.market.liquidity ?? 0) ||
  right.breakdown.reward - left.breakdown.reward ||
  right.breakdown.rebate - left.breakdown.rebate ||
  left.market.slug.localeCompare(right.market.slug);

const passesMandatorySelectionFilters = (
  market: BinaryMarket,
  signal: MarketSelectionSignal | undefined,
  profile?: MarketSelectionProfile
): boolean => {
  if ((market.liquidity ?? 0) + Number.EPSILON < config.marketUniverse.minMarketLiquidity) {
    return false;
  }

  // Hard-gate: reject extreme-price markets where maker fills are almost impossible.
  // Markets priced at $0.05-$0.10 or $0.90-$0.95 rarely get two-sided taker flow —
  // our maker quotes sit forever. A healthy MM zone is typically 0.15-0.85.
  if (typeof market.bestBid === "number" && typeof market.bestAsk === "number") {
    const midpoint = (market.bestBid + market.bestAsk) / 2;
    if (midpoint < config.marketUniverse.minMidpointPrice ||
        midpoint > config.marketUniverse.maxMidpointPrice) {
      return false;
    }
  }

  // Hard-gate: reject markets that are too close to expiry/game-start even if they
  // were previously admitted into the universe. This catches the case where a market
  // drifts past the cutoff while the bot is already quoting on it.
  const cutoffTimestamp = getTradeCutoffTimestamp(market);
  if (cutoffTimestamp !== undefined) {
    const secondsToCutoff = Math.max(0, Math.floor((cutoffTimestamp - Date.now()) / 1000));
    if (secondsToCutoff < config.marketUniverse.minSecondsToEnd) {
      return false;
    }
  }

  const effectiveSpread = getEffectiveSpread(market, signal);

  if (
    typeof effectiveSpread !== "number" ||
    !Number.isFinite(effectiveSpread) ||
    effectiveSpread < config.marketUniverse.minSpread
  ) {
    return false;
  }

  if (
    typeof signal?.recentActivityEventsInWindow === "number" &&
    signal.recentActivityEventsInWindow + Number.EPSILON <
      config.marketUniverse.minRecentActivityEvents
  ) {
    return false;
  }

  // Hard-gate: market must show ACTUAL trade events (not just book-update churn)
  // in the activity window. A market with only price-level updates lets us BUY
  // but cannot give us an exit fill — exactly the "can-buy cant-sell" trap.
  // Fix K: negRisk skips this — long-tail outcomes (e.g., minor election candidates)
  // rarely have recent trades but still belong in the negRisk group; their YES book
  // is the only thing yes-basket arb needs, and the exit-feasibility check below
  // covers no-to-yes-conversion's per-leg exits.
  if (
    profile !== "negative-risk" &&
    config.marketUniverse.minRecentTradeEvents > 0 &&
    typeof signal?.recentTradeEventsInWindow === "number" &&
    signal.recentTradeEventsInWindow + Number.EPSILON <
      config.marketUniverse.minRecentTradeEvents
  ) {
    return false;
  }

  // Exit-feasibility gate: best-bid must have enough notional to absorb our SELL
  // at a reasonable price. If the bid side is thin, we may enter but be unable
  // to exit without significant slippage.
  // Fix K: negRisk does not have a "regular SELL" exit per market — yes-basket holds
  // until resolution and no-to-yes-conversion exits via the conversion bridge, not
  // a regular SELL. Skip this gate to keep long-tail outcomes in the universe.
  if (
    profile !== "negative-risk" &&
    getMandatoryExitDepthNotionalUsdc() > 0 &&
    typeof signal?.bestBidNotionalFloorUsdc === "number"
  ) {
    const requiredExitNotionalUsdc = getMandatoryExitDepthNotionalUsdc();
    if (signal.bestBidNotionalFloorUsdc < requiredExitNotionalUsdc) {
      return false;
    }
  }

  if (
    profile === "market-making" &&
    typeof signal?.topBookLiquidityFloorUsdc === "number" &&
    signal.topBookLiquidityFloorUsdc + Number.EPSILON <
      config.marketMaker.minTopBookLiquidityUsdc
  ) {
    return false;
  }

  if (profile === "market-making" && signal) {
    const severeMinimumBestBidSupportShares =
      getRequiredPassiveBuyBestBidSupportShares() * 0.5;
    if (
      typeof signal.bestBidSizeFloorShares === "number" &&
      signal.bestBidSizeFloorShares + Number.EPSILON <
        severeMinimumBestBidSupportShares
    ) {
      return false;
    }

    const severeMaximumExitQueueAheadShares =
      getMaximumPassiveBuyExitQueueAheadShares() * 2;
    if (
      typeof signal.bestAskQueueCeilingShares === "number" &&
      signal.bestAskQueueCeilingShares - Number.EPSILON >
        severeMaximumExitQueueAheadShares
    ) {
      return false;
    }

    const severeMinimumMarketableExitNotionalUsdc = getTargetQuoteNotionalUsdc() * 0.5;
    if (
      typeof signal.marketableExitNotionalUsdc === "number" &&
      signal.marketableExitNotionalUsdc + Number.EPSILON <
        severeMinimumMarketableExitNotionalUsdc
    ) {
      return false;
    }
  }

  if (
    typeof signal?.expectedExitSeconds === "number" &&
    signal.expectedExitSeconds - Number.EPSILON > getMandatoryExpectedExitSeconds(profile)
  ) {
    return false;
  }

  return true;
};

export const filterMarketsForSelectionEligibility = (
  markets: readonly BinaryMarket[],
  options?: {
    signalsByConditionId?: ReadonlyMap<string, MarketSelectionSignal>;
    profile?: MarketSelectionProfile;
  }
): BinaryMarket[] =>
  markets.filter((market) =>
    passesMandatorySelectionFilters(
      market,
      options?.signalsByConditionId?.get(market.conditionId),
      options?.profile
    )
  );

const passesPreferredSelectionFilters = (
  market: BinaryMarket,
  signal: MarketSelectionSignal | undefined,
  profile?: MarketSelectionProfile,
  requireLiveExecutionSignals = false
): boolean =>
  getPreferredSelectionRejectReasons(
    market,
    signal,
    profile,
    requireLiveExecutionSignals
  ).length === 0;

const passesLiveExecutionFallbackFilters = (
  signal: MarketSelectionSignal | undefined,
  profile?: MarketSelectionProfile,
  requireLiveExecutionSignals = false
): boolean => {
  if (profile !== "market-making" || !requireLiveExecutionSignals) {
    return true;
  }

  if (!signal) {
    return false;
  }

  if (!(signal.freshBookCount > 0) || !(signal.twoSidedBookCount > 0)) {
    return false;
  }

  if (
    typeof signal.recentTradeEventsInWindow !== "number" ||
    signal.recentTradeEventsInWindow + Number.EPSILON <
      Math.max(config.marketUniverse.minRecentTradeEvents, 1)
  ) {
    return false;
  }

  if (
    typeof signal.marketableExitNotionalUsdc !== "number" ||
    !Number.isFinite(signal.marketableExitNotionalUsdc) ||
    signal.marketableExitNotionalUsdc + Number.EPSILON < getTargetQuoteNotionalUsdc() * 0.5
  ) {
    return false;
  }

  if (
    typeof signal.bestBidSizeFloorShares === "number" &&
    signal.bestBidSizeFloorShares + Number.EPSILON <
      getRequiredPassiveBuyBestBidSupportShares()
  ) {
    return false;
  }

  if (
    typeof signal.bestAskQueueCeilingShares === "number" &&
    signal.bestAskQueueCeilingShares - Number.EPSILON >
      getMaximumPassiveBuyExitQueueAheadShares() * 2
  ) {
    return false;
  }

  return true;
};

const getPreferredSelectionRejectReasons = (
  market: BinaryMarket,
  signal: MarketSelectionSignal | undefined,
  profile?: MarketSelectionProfile,
  requireLiveExecutionSignals = false
): string[] => {
  const reasons: string[] = [];

  if (
    profile === "market-making" &&
    requireLiveExecutionSignals
  ) {
    if (!signal) {
      reasons.push("missing_live_execution_signal");
    } else {
      if (!(signal.freshBookCount > 0)) {
        reasons.push("missing_fresh_book");
      }

      if (!(signal.twoSidedBookCount > 0)) {
        reasons.push("missing_two_sided_book");
      }

      if (
        typeof signal.recentTradeEventsInWindow !== "number" ||
        signal.recentTradeEventsInWindow + Number.EPSILON <
          Math.max(config.marketUniverse.minRecentTradeEvents, 1)
      ) {
        reasons.push("recent_trade_flow_below_threshold");
      }

      if (
        typeof signal.marketableExitNotionalUsdc !== "number" ||
        !Number.isFinite(signal.marketableExitNotionalUsdc)
      ) {
        reasons.push("missing_marketable_exit_notional");
      }

      if (
        typeof signal.bestBidSizeFloorShares !== "number" ||
        !Number.isFinite(signal.bestBidSizeFloorShares)
      ) {
        reasons.push("missing_best_bid_size_floor");
      }

      if (
        typeof signal.bestAskQueueCeilingShares !== "number" ||
        !Number.isFinite(signal.bestAskQueueCeilingShares)
      ) {
        reasons.push("missing_best_ask_queue_ceiling");
      }
    }
  }

  if (
    typeof signal?.bestBidNotionalFloorUsdc === "number" &&
    signal.bestBidNotionalFloorUsdc + Number.EPSILON <
      config.marketUniverse.minBestBidNotionalUsdc
  ) {
    reasons.push("best_bid_notional_below_threshold");
  }

  if (
    typeof signal?.bestAskNotionalFloorUsdc === "number" &&
    signal.bestAskNotionalFloorUsdc + Number.EPSILON <
      config.marketUniverse.minBestAskNotionalUsdc
  ) {
    reasons.push("best_ask_notional_below_threshold");
  }

  if (
    typeof signal?.midpointRangeInWindow === "number" &&
    signal.midpointRangeInWindow - Number.EPSILON > config.marketUniverse.maxMidpointRange
  ) {
    reasons.push("midpoint_range_above_threshold");
  }

  if (
    typeof signal?.expectedExitSeconds === "number" &&
    signal.expectedExitSeconds - Number.EPSILON > getPreferredExpectedExitSeconds(profile)
  ) {
    reasons.push("expected_exit_too_slow");
  }

  if (profile === "market-making" && signal) {
    if (
      typeof signal.bestBidSizeFloorShares === "number" &&
      signal.bestBidSizeFloorShares + Number.EPSILON <
        getRequiredPassiveBuyBestBidSupportShares()
    ) {
      reasons.push("best_bid_share_support_below_threshold");
    }

    if (
      typeof signal.bestAskQueueCeilingShares === "number" &&
      signal.bestAskQueueCeilingShares - Number.EPSILON >
        getMaximumPassiveBuyExitQueueAheadShares()
    ) {
      reasons.push("target_exit_queue_too_crowded");
    }

    if (
      typeof signal.marketableExitNotionalUsdc === "number" &&
      signal.marketableExitNotionalUsdc + Number.EPSILON <
        getTargetQuoteNotionalUsdc() * 0.9
    ) {
      reasons.push("marketable_exit_notional_below_threshold");
    }
  }

  const activity = scoreActivity(market, signal, profile);

  if (activity + Number.EPSILON < config.marketUniverse.minActivityScore) {
    reasons.push("activity_score_below_threshold");
  }

  return [...new Set(reasons)];
};

const rankCandidateMarkets = (
  markets: readonly BinaryMarket[],
  options: {
    profile: MarketSelectionProfile;
    signalsByConditionId?: ReadonlyMap<string, MarketSelectionSignal>;
    preferredConditionIds?: ReadonlySet<string>;
    stickinessBoost?: number;
  }
): RankedMarketSelection[] =>
  markets
    .map<RankedMarketSelection>((market) => ({
      market,
      breakdown: scoreMarket(
        market,
        options.profile,
        options.signalsByConditionId?.get(market.conditionId),
        options.preferredConditionIds?.has(market.conditionId)
          ? options.stickinessBoost ?? config.marketUniverse.selectionStickinessBoost
          : 0
      )
    }))
    .sort(compareRankedMarkets);

export const rankMarketsForSelection = (
  markets: readonly BinaryMarket[],
  options: {
    profile: MarketSelectionProfile;
    maxMarkets: number;
    topLogCount?: number;
    signalsByConditionId?: ReadonlyMap<string, MarketSelectionSignal>;
    preferredConditionIds?: ReadonlySet<string>;
    stickinessBoost?: number;
    requireLiveExecutionSignals?: boolean;
  }
): MarketSelectionResult => {
  const mandatoryEligibleMarkets = filterMarketsForSelectionEligibility(markets, {
    signalsByConditionId: options.signalsByConditionId,
    profile: options.profile
  });
  const preferredRejectReasons: Record<string, number> = {};
  const preferredEligibleMarkets = mandatoryEligibleMarkets.filter((market) => {
    const reasons = getPreferredSelectionRejectReasons(
      market,
      options.signalsByConditionId?.get(market.conditionId),
      options.profile,
      options.requireLiveExecutionSignals ?? false
    );

    for (const reason of reasons) {
      preferredRejectReasons[reason] = (preferredRejectReasons[reason] ?? 0) + 1;
    }

    return reasons.length === 0;
  });
  const hasLiveSelectionSignals = (options.signalsByConditionId?.size ?? 0) > 0;
  const fallbackEligibleMarkets =
    options.profile === "market-making" &&
    options.requireLiveExecutionSignals &&
    hasLiveSelectionSignals
      ? mandatoryEligibleMarkets.filter((market) =>
          passesLiveExecutionFallbackFilters(
            options.signalsByConditionId?.get(market.conditionId),
            options.profile,
            true
          )
        )
      : mandatoryEligibleMarkets;
  // Keep a startup watchlist only before live signals exist. Once websocket
  // telemetry is present, fallback also has to be executable enough to avoid
  // selecting markets that runtime immediately suppresses on every cycle.
  const usedMandatoryFallback =
    preferredEligibleMarkets.length === 0 &&
    fallbackEligibleMarkets.length > 0;
  const rankedMarkets = rankCandidateMarkets(
    preferredEligibleMarkets.length > 0 ? preferredEligibleMarkets : fallbackEligibleMarkets,
    options
  );
  const selectedMarkets = rankedMarkets.slice(0, options.maxMarkets).map((entry) => entry.market);
  const topSelections = rankedMarkets.slice(0, options.topLogCount ?? 5).map((entry) => ({
    slug: entry.market.slug,
    category: entry.market.category,
    liquidity: entry.market.liquidity,
    rewardRatePerDay: entry.market.rewardRatePerDay,
    feesEnabled: entry.market.feesEnabled,
    score: entry.breakdown.total,
    breakdown: {
      liquidity: entry.breakdown.liquidity,
      reward: entry.breakdown.reward,
      rebate: entry.breakdown.rebate,
      expiry: entry.breakdown.expiry,
      structure: entry.breakdown.structure,
      spread: entry.breakdown.spread,
      activity: entry.breakdown.activity,
      retentionBonus: entry.breakdown.retentionBonus,
      total: entry.breakdown.total
    },
    reasons: entry.breakdown.reasons
  }));

  return {
    rankedMarkets,
    selectedMarkets,
    diagnostics: {
      profile: options.profile,
      mandatoryCandidateCount: mandatoryEligibleMarkets.length,
      preferredCandidateCount: preferredEligibleMarkets.length,
      candidateCount: rankedMarkets.length,
      selectedCount: selectedMarkets.length,
      maxMarkets: options.maxMarkets,
      averageScore: roundScore(average(rankedMarkets.map((entry) => entry.breakdown.total))),
      selectedAverageScore: roundScore(
        average(rankedMarkets.slice(0, options.maxMarkets).map((entry) => entry.breakdown.total))
      ),
      usedMandatoryFallback,
      preferredRejectReasons,
      topSelections
    }
  };
};

const scoreNegativeRiskGroupLiquidity = (group: NegativeRiskGroup): number =>
  roundScore(
    normalizeLinear(
      sum(group.markets.map((market) => market.liquidity ?? 0)),
      config.marketUniverse.minMarketLiquidity * 2,
      900_000
    )
  );

const scoreNegativeRiskGroupReward = (group: NegativeRiskGroup): number =>
  roundScore(normalizeLinear(average(group.markets.map((market) => market.rewardRatePerDay ?? 0)), 0, 2));

const scoreNegativeRiskGroupRebate = (group: NegativeRiskGroup): number =>
  roundScore(
    average(
      group.markets.map((market) => (market.feesEnabled ? getCategoryRebateScore(market) : 0.2))
    )
  );

const scoreNegativeRiskGroupExpiry = (group: NegativeRiskGroup): number => {
  const cutoffTimestamps = group.markets
    .map((market) => getTradeCutoffTimestamp(market))
    .filter((value): value is number => typeof value === "number");

  if (cutoffTimestamps.length === 0) {
    return 0.55;
  }

  const earliestCutoff = Math.min(...cutoffTimestamps);
  const secondsToCutoff = Math.max(0, Math.floor((earliestCutoff - Date.now()) / 1000));
  const preferredSecondsToCutoff = Math.min(
    config.marketUniverse.maxSecondsToEnd ?? 86_400,
    86_400
  );
  const normalized = normalizeLinear(
    secondsToCutoff,
    config.marketUniverse.minSecondsToEnd,
    Math.max(config.marketUniverse.minSecondsToEnd + 1, preferredSecondsToCutoff)
  );

  return roundScore(0.4 + 0.6 * normalized);
};

const scoreNegativeRiskGroupStructure = (group: NegativeRiskGroup): number => {
  let score = group.markets.length <= 4 ? 1 : group.markets.length <= 6 ? 0.8 : 0.55;

  if (group.marketId) {
    score += 0.1;
  }

  return roundScore(Math.min(1, score));
};

const scoreNegativeRiskGroupSpread = (
  group: NegativeRiskGroup,
  signalsByConditionId: ReadonlyMap<string, MarketSelectionSignal> | undefined
): number => {
  if (!signalsByConditionId) {
    return 0.5;
  }

  const signalScores = group.markets
    .map((market) => signalsByConditionId.get(market.conditionId)?.spreadScore)
    .filter((score): score is number => typeof score === "number");

  return signalScores.length > 0 ? roundScore(average(signalScores)) : 0.5;
};

const scoreNegativeRiskGroupActivity = (
  group: NegativeRiskGroup,
  signalsByConditionId: ReadonlyMap<string, MarketSelectionSignal> | undefined
): number => {
  const metadataScores = group.markets.map((market) => scoreMetadataActivity(market));

  if (!signalsByConditionId) {
    return roundScore(average(metadataScores));
  }

  const signalScores = group.markets.map((market) =>
    scoreActivity(market, signalsByConditionId.get(market.conditionId))
  );

  return signalScores.length > 0
    ? roundScore(average(signalScores))
    : roundScore(average(metadataScores));
};

const buildNegativeRiskGroupReasons = (
  group: NegativeRiskGroup,
  breakdown: Omit<NegativeRiskGroupSelectionBreakdown, "reasons" | "total">
): string[] => {
  const reasons: string[] = [];

  if (breakdown.liquidity >= 0.8) {
    reasons.push("high_group_liquidity");
  }

  if (breakdown.structure >= 0.9) {
    reasons.push("compact_group_structure");
  }

  if (breakdown.spread >= 0.7) {
    reasons.push("tight_group_spread_signal");
  }

  if (breakdown.activity >= 0.7) {
    reasons.push("fresh_group_books");
  }

  if (group.marketId) {
    reasons.push("shared_market_id_derived");
  }

  if (breakdown.expiry >= 0.75) {
    reasons.push("comfortable_time_to_expiry");
  }

  if (breakdown.retentionBonus > 0) {
    reasons.push("selection_stickiness_boost");
  }

  return reasons;
};

const scoreNegativeRiskGroup = (
  group: NegativeRiskGroup,
  signalsByConditionId: ReadonlyMap<string, MarketSelectionSignal> | undefined,
  retentionBonus: number
): NegativeRiskGroupSelectionBreakdown => {
  const componentScores = {
    liquidity: scoreNegativeRiskGroupLiquidity(group),
    reward: scoreNegativeRiskGroupReward(group),
    rebate: scoreNegativeRiskGroupRebate(group),
    expiry: scoreNegativeRiskGroupExpiry(group),
    structure: scoreNegativeRiskGroupStructure(group),
    spread: scoreNegativeRiskGroupSpread(group, signalsByConditionId),
    activity: scoreNegativeRiskGroupActivity(group, signalsByConditionId),
    retentionBonus: roundScore(retentionBonus)
  };
  const total = roundScore(
    componentScores.liquidity * negativeRiskGroupSelectionWeights.liquidity +
      componentScores.reward * negativeRiskGroupSelectionWeights.reward +
      componentScores.rebate * negativeRiskGroupSelectionWeights.rebate +
      componentScores.expiry * negativeRiskGroupSelectionWeights.expiry +
      componentScores.structure * negativeRiskGroupSelectionWeights.structure +
      componentScores.spread * negativeRiskGroupSelectionWeights.spread +
      componentScores.activity * negativeRiskGroupSelectionWeights.activity +
      componentScores.retentionBonus
  );

  return {
    ...componentScores,
    total,
    reasons: buildNegativeRiskGroupReasons(group, componentScores)
  };
};

const compareRankedGroups = (
  left: RankedNegativeRiskGroupSelection,
  right: RankedNegativeRiskGroupSelection
): number =>
  right.breakdown.total - left.breakdown.total ||
  sum(right.group.markets.map((market) => market.liquidity ?? 0)) -
    sum(left.group.markets.map((market) => market.liquidity ?? 0)) ||
  left.group.eventSlug.localeCompare(right.group.eventSlug);

export const rankNegativeRiskGroupsForSelection = (
  groups: readonly NegativeRiskGroup[],
  options: {
    maxMarkets: number;
    topLogCount?: number;
    signalsByConditionId?: ReadonlyMap<string, MarketSelectionSignal>;
    preferredEventIds?: ReadonlySet<string>;
    stickinessBoost?: number;
  }
): NegativeRiskGroupSelectionResult => {
  const rankedGroups = groups
    .map<RankedNegativeRiskGroupSelection>((group) => ({
      group,
      breakdown: scoreNegativeRiskGroup(
        group,
        options.signalsByConditionId,
        options.preferredEventIds?.has(group.eventId)
          ? options.stickinessBoost ?? config.marketUniverse.selectionStickinessBoost
          : 0
      )
    }))
    .sort(compareRankedGroups);
  const selectedGroups: NegativeRiskGroup[] = [];
  let selectedMarketCount = 0;

  for (const entry of rankedGroups) {
    const nextMarketCount = selectedMarketCount + entry.group.markets.length;

    if (selectedGroups.length > 0 && nextMarketCount > options.maxMarkets) {
      continue;
    }

    if (nextMarketCount > options.maxMarkets && entry.group.markets.length > options.maxMarkets) {
      continue;
    }

    selectedGroups.push(entry.group);
    selectedMarketCount = nextMarketCount;

    if (selectedMarketCount >= options.maxMarkets) {
      break;
    }
  }

  const topSelections = rankedGroups.slice(0, options.topLogCount ?? 5).map((entry) => ({
    eventSlug: entry.group.eventSlug,
    eventTitle: entry.group.eventTitle,
    marketCount: entry.group.markets.length,
    totalLiquidity: sum(entry.group.markets.map((market) => market.liquidity ?? 0)),
    averageRewardRatePerDay: roundScore(
      average(entry.group.markets.map((market) => market.rewardRatePerDay ?? 0))
    ),
    score: entry.breakdown.total,
    breakdown: {
      liquidity: entry.breakdown.liquidity,
      reward: entry.breakdown.reward,
      rebate: entry.breakdown.rebate,
      expiry: entry.breakdown.expiry,
      structure: entry.breakdown.structure,
      spread: entry.breakdown.spread,
      activity: entry.breakdown.activity,
      retentionBonus: entry.breakdown.retentionBonus,
      total: entry.breakdown.total
    },
    reasons: entry.breakdown.reasons
  }));

  return {
    rankedGroups,
    selectedGroups,
    diagnostics: {
      candidateCount: rankedGroups.length,
      selectedGroupCount: selectedGroups.length,
      selectedMarketCount,
      maxMarkets: options.maxMarkets,
      averageScore: roundScore(average(rankedGroups.map((entry) => entry.breakdown.total))),
      selectedAverageScore: roundScore(
        average(
          rankedGroups
            .filter((entry) =>
              selectedGroups.some((group) => group.eventId === entry.group.eventId)
            )
            .map((entry) => entry.breakdown.total)
        )
      ),
      topSelections
    }
  };
};
