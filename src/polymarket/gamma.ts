import type { MarketReward } from "@polymarket/clob-client-v2";

import { config } from "../config.js";
import type { BinaryMarket, GammaMarketResponse } from "../types.js";

export interface ClosedBinaryMarketResolution {
  market: BinaryMarket;
  payoutFractions: readonly [number, number];
  closedTime?: string;
}

type MarketUniverseRejectReason =
  | "notBinaryOrMalformed"
  | "inactiveClosedUntradeable"
  | "liquidityBelowMinimum"
  | "expiryTooSoon"
  | "expiryTooFar"
  | "slugNotAllowlisted"
  | "queryMiss"
  | "feeEnabledSkipped"
  | "categoryExcluded"
  | "liveSportsExcluded"
  | "sportsPrematchTooEarly"
  | "sportsPrematchTooLate"
  | "slugPatternExcluded"
  | "duplicateCondition";

export interface MarketUniverseFetchDiagnostics {
  scanCap: number;
  pagesFetched: number;
  rawMarketsFetched: number;
  normalizedBinaryMarkets: number;
  eligibleMarketsBeforeDedup: number;
  selectedMarkets: number;
  rejected: Record<MarketUniverseRejectReason, number>;
}

export interface MarketUniverseFetchResult {
  markets: BinaryMarket[];
  diagnostics: MarketUniverseFetchDiagnostics;
}

const gammaMarketOrderFields = ["volume24hr", "volume", "liquidity"] as const;

const parseStringArray = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
};

const parseNumericArray = (value: string | undefined): number[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .map((item) =>
            typeof item === "number" ? item : typeof item === "string" ? Number(item) : Number.NaN
          )
          .filter((item) => Number.isFinite(item))
      : [];
  } catch {
    return [];
  }
};

const asFiniteNumber = (...values: Array<number | string | undefined>): number => {
  for (const value of values) {
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
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

const createDiagnostics = (scanCap: number): MarketUniverseFetchDiagnostics => ({
  scanCap,
  pagesFetched: 0,
  rawMarketsFetched: 0,
  normalizedBinaryMarkets: 0,
  eligibleMarketsBeforeDedup: 0,
  selectedMarkets: 0,
  rejected: {
    notBinaryOrMalformed: 0,
    inactiveClosedUntradeable: 0,
    liquidityBelowMinimum: 0,
    expiryTooSoon: 0,
    expiryTooFar: 0,
    slugNotAllowlisted: 0,
    queryMiss: 0,
    feeEnabledSkipped: 0,
    categoryExcluded: 0,
    liveSportsExcluded: 0,
    sportsPrematchTooEarly: 0,
    sportsPrematchTooLate: 0,
    slugPatternExcluded: 0,
    duplicateCondition: 0
  }
});

const getEligibilityRejectReason = (
  market: BinaryMarket
): Exclude<MarketUniverseRejectReason, "notBinaryOrMalformed" | "duplicateCondition"> | undefined => {
  if (!market.active || market.closed || !market.enableOrderBook || !market.acceptingOrders) {
    return "inactiveClosedUntradeable";
  }

  if ((market.liquidity ?? 0) < config.marketUniverse.minMarketLiquidity) {
    return "liquidityBelowMinimum";
  }

  const now = Date.now();
  const cutoffTimestamp = getTradeCutoffTimestamp(market);

  if (typeof cutoffTimestamp === "number") {
    const secondsToEnd = Math.floor((cutoffTimestamp - now) / 1000);

    if (secondsToEnd < config.marketUniverse.minSecondsToEnd) {
      return "expiryTooSoon";
    }

    if (
      typeof config.marketUniverse.maxSecondsToEnd === "number" &&
      secondsToEnd > config.marketUniverse.maxSecondsToEnd
    ) {
      return "expiryTooFar";
    }
  }

  if (
    config.marketUniverse.allowedSlugs.length > 0 &&
    !config.marketUniverse.allowedSlugs.includes(market.slug)
  ) {
    return "slugNotAllowlisted";
  }

  if (
    config.marketUniverse.query &&
    !market.question.toLowerCase().includes(config.marketUniverse.query.toLowerCase()) &&
    !market.slug.toLowerCase().includes(config.marketUniverse.query.toLowerCase())
  ) {
    return "queryMiss";
  }

  if (config.strategy.skipFeeEnabledMarkets && market.feesEnabled) {
    return "feeEnabledSkipped";
  }

  // Exclude markets in user-blocked categories (e.g. "Sports", "Esports").
  if (config.marketUniverse.excludedCategories.length > 0) {
    const normalizedCategory = (market.category ?? "").trim().toLowerCase();
    if (
      normalizedCategory.length > 0 &&
      config.marketUniverse.excludedCategories.includes(normalizedCategory)
    ) {
      return "categoryExcluded";
    }
  }

  // Sports prematch 시간 윈도우 (사장님 가이드 2026-05-01):
  //   - 시작 후 (live) → liveSportsExcluded
  //   - 시작 < N분 전 (예: 10분) → sportsPrematchTooLate (cancel/no-entry)
  //   - 시작 > M분 전 (예: 120분) → sportsPrematchTooEarly
  //   - 30~120분 전 = 적정 진입 윈도우
  if (market.gameStartTime) {
    const gameStart = Date.parse(market.gameStartTime);
    if (Number.isFinite(gameStart)) {
      const now = Date.now();
      if (gameStart <= now) {
        if (config.marketUniverse.excludeLiveSports) {
          return "liveSportsExcluded";
        }
      } else {
        const minutesToGame = (gameStart - now) / 60_000;
        if (minutesToGame < config.marketUniverse.sportsPrematchMinMinutesBefore) {
          return "sportsPrematchTooLate";
        }
        if (minutesToGame > config.marketUniverse.sportsPrematchMaxMinutesBefore) {
          return "sportsPrematchTooEarly";
        }
      }
    }
  }

  // Slug-pattern exclusion — more reliable than category filtering since Polymarket's
  // category field is frequently null/empty. Filters out sports market patterns like
  // "nba-", "epl-", "-spread-", etc. via case-insensitive substring match.
  if (config.marketUniverse.excludedSlugPatterns.length > 0) {
    const lowerSlug = market.slug.toLowerCase();
    if (config.marketUniverse.excludedSlugPatterns.some((pattern) => lowerSlug.includes(pattern))) {
      return "slugPatternExcluded";
    }
  }

  return undefined;
};

const normalizeMarket = (market: GammaMarketResponse): BinaryMarket | undefined => {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);

  if (outcomes.length !== 2 || tokenIds.length !== 2) {
    return undefined;
  }

  const [outcomeA, outcomeB] = outcomes as [string, string];
  const [tokenA, tokenB] = tokenIds as [string, string];
  const primaryEvent = market.events?.[0];

  const normalized: BinaryMarket = {
    id: market.id,
    conditionId: market.conditionId,
    questionId: market.questionID,
    question: market.question,
    slug: market.slug,
    eventId: primaryEvent?.id,
    eventSlug: primaryEvent?.slug,
    eventTitle: primaryEvent?.title,
    groupItemTitle:
      typeof market.groupItemTitle === "string" && market.groupItemTitle.trim().length > 0
        ? market.groupItemTitle.trim()
        : undefined,
    category:
      typeof market.category === "string" && market.category.trim().length > 0
        ? market.category.trim()
        : undefined,
    liquidity: asFiniteNumber(market.liquidityNum, market.liquidityClob, market.liquidity),
    volume: asFiniteNumber(market.volumeNum, market.volume),
    volume24hr: asFiniteNumber(market.volume24hr),
    competitive: asFiniteNumber(market.competitive),
    spread: asFiniteNumber(market.spread),
    bestBid: asFiniteNumber(market.bestBid),
    bestAsk: asFiniteNumber(market.bestAsk),
    marketLastTradePrice: asFiniteNumber(market.lastTradePrice),
    marketScore: asFiniteNumber(market.score),
    outcomes: [outcomeA, outcomeB],
    tokenIds: [tokenA, tokenB],
    active: market.active,
    closed: market.closed,
    acceptingOrders: market.acceptingOrders ?? false,
    enableOrderBook: market.enableOrderBook ?? false,
    orderMinSize: Number(market.orderMinSize ?? 0),
    orderPriceMinTickSize: Number(market.orderPriceMinTickSize ?? 0.001),
    endDate: market.endDate,
    gameStartTime: market.gameStartTime,
    feesEnabled: market.feesEnabled ?? false,
    negRisk: market.negRisk ?? false,
    enableNegRisk: primaryEvent?.enableNegRisk,
    cumulativeMarkets: primaryEvent?.cumulativeMarkets,
    showAllOutcomes: primaryEvent?.showAllOutcomes,
    rewardsMaxSpread: asFiniteNumber(market.rewardsMaxSpread),
    rewardsMinSize: asFiniteNumber(market.rewardsMinSize)
  };

  if (market.endDate) {
    normalized.endDate = market.endDate;
  }

  if (market.gameStartTime) {
    normalized.gameStartTime = market.gameStartTime;
  }

  if (market.feeType) {
    normalized.feeType = market.feeType;
  }

  return normalized;
};

export const fetchBinaryMarketsWithDiagnostics = async (): Promise<MarketUniverseFetchResult> => {
  const markets: BinaryMarket[] = [];
  const seenConditionIds = new Set<string>();
  const allowlistedOnly = config.marketUniverse.allowedSlugs.length > 0;
  const scanCap = allowlistedOnly
    ? Math.min(config.marketUniverse.scanCap, config.marketUniverse.allowedSlugs.length)
    : config.marketUniverse.scanCap;
  const diagnostics = createDiagnostics(scanCap);

  // ALLOWED_SLUGS 가 있으면 각 slug 를 gamma 에 직접 query — 페이지네이션 cap 안에
  // 안 들어가는 시장 (volume 낮은 정치/장기 시장) 도 정확히 잡힘. 운영자가 picker 로
  // 명시적으로 고른 시장이 누락되지 않도록 보장.
  if (allowlistedOnly) {
    for (const slug of config.marketUniverse.allowedSlugs) {
      const url = new URL("/markets", config.gammaHost);
      url.searchParams.set("slug", slug);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) continue;
        const payload = (await response.json()) as GammaMarketResponse[];
        diagnostics.pagesFetched += 1;
        diagnostics.rawMarketsFetched += payload.length;
        for (const rawMarket of payload) {
          const market = normalizeMarket(rawMarket);
          if (!market) {
            diagnostics.rejected.notBinaryOrMalformed += 1;
            continue;
          }
          diagnostics.normalizedBinaryMarkets += 1;
          const rejectReason = getEligibilityRejectReason(market);
          if (rejectReason) {
            diagnostics.rejected[rejectReason] += 1;
            continue;
          }
          diagnostics.eligibleMarketsBeforeDedup += 1;
          if (seenConditionIds.has(market.conditionId)) {
            diagnostics.rejected.duplicateCondition += 1;
            continue;
          }
          seenConditionIds.add(market.conditionId);
          markets.push(market);
        }
      } catch {
        clearTimeout(timeoutId);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    diagnostics.selectedMarkets = markets.length;
    return { markets, diagnostics };
  }

  let offset = 0;

  // Hard cap on raw pages so a strict eligibility gate (e.g. minLiquidity high
  // enough that only 0.05% of gamma markets qualify) cannot drag us through
  // 11000+ markets and trigger a connection drop. We accept the universe size
  // we can find within this budget rather than holding the bot's main loop.
  const maxPages = 40;
  let pagesFetched = 0;

  while (markets.length < scanCap && pagesFetched < maxPages) {
    const limit = allowlistedOnly
      ? config.marketUniverse.pageSize
      : Math.min(config.marketUniverse.pageSize, scanCap - markets.length);
    let payload: GammaMarketResponse[] | undefined;
    let lastError: Error | undefined;

    for (const orderField of gammaMarketOrderFields) {
      const url = new URL("/markets", config.gammaHost);
      url.searchParams.set("closed", "false");
      url.searchParams.set("order", orderField);
      url.searchParams.set("ascending", "false");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          // Timeout 도 origin 부하 신호일 수 있음. 같은 backoff 적용.
          lastError = new Error(`Gamma markets request timed out after 20s (orderField=${orderField})`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        // Network/DNS 같은 다른 fetch 오류도 transient 가능 — 다음 orderField 시도.
        lastError = error instanceof Error ? error : new Error(String(error));
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      clearTimeout(timeoutId);

      if (response.ok) {
        payload = (await response.json()) as GammaMarketResponse[];
        break;
      }

      const responseBody = await response.text();
      const responseDetail = responseBody.trim();

      if (
        response.status === 422 &&
        responseDetail.toLowerCase().includes("order fields are not valid")
      ) {
        lastError = new Error(
          `Gamma markets request rejected order field "${orderField}": ${response.status} ${response.statusText}`
        );
        continue;
      }

      // 5xx: Polymarket cloudflare/origin 측 일시 장애. 짧은 간격 연속 호출은
      // origin 부하를 가중시켜 오히려 더 많은 5xx 를 유발 (운영자 진단 4번 케이스).
      // backoff 후 다음 orderField 시도. 그래도 fail 면 다음 cycle 까지 대기.
      if (response.status >= 500 && response.status < 600) {
        lastError = new Error(
          `Gamma markets transient ${response.status} on orderField="${orderField}"`
        );
        // 2초 backoff 으로 origin 부하 감소. cloudflare cache 가 회복할 시간.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const detailSuffix = responseDetail ? ` - ${responseDetail}` : "";
      throw new Error(
        `Gamma markets request failed: ${response.status} ${response.statusText}${detailSuffix}`
      );
    }

    if (!payload) {
      throw (
        lastError ??
        new Error(
          `Gamma markets request failed: no supported order fields were accepted (${gammaMarketOrderFields.join(", ")})`
        )
      );
    }

    diagnostics.pagesFetched += 1;
    diagnostics.rawMarketsFetched += payload.length;
    pagesFetched += 1;

    if (payload.length === 0) {
      break;
    }

    for (const rawMarket of payload) {
      const market = normalizeMarket(rawMarket);

      if (!market) {
        diagnostics.rejected.notBinaryOrMalformed += 1;
        continue;
      }

      diagnostics.normalizedBinaryMarkets += 1;

      const rejectReason = getEligibilityRejectReason(market);

      if (rejectReason) {
        diagnostics.rejected[rejectReason] += 1;
        continue;
      }

      diagnostics.eligibleMarketsBeforeDedup += 1;

      if (seenConditionIds.has(market.conditionId)) {
        diagnostics.rejected.duplicateCondition += 1;
        continue;
      }

      seenConditionIds.add(market.conditionId);
      markets.push(market);

      if (markets.length >= scanCap) {
        break;
      }
    }

    offset += payload.length;

    if (payload.length < limit) {
      break;
    }

    // 페이지 사이 짧은 backoff: cloudflare/origin 부하 감소.
    // 운영자 진단에서 200ms 간격 5번 연속 호출이 모두 500 → 페이지네이션도 같은 패턴
    // 위험. 200ms 간격이면 40 페이지 = 8초 추가 — 봇 동작에 큰 영향 없음.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  diagnostics.selectedMarkets = markets.length;

  return {
    markets: markets.slice(0, scanCap),
    diagnostics
  };
};

export const fetchBinaryMarkets = async (): Promise<BinaryMarket[]> =>
  (await fetchBinaryMarketsWithDiagnostics()).markets;

export const mergeMarketsWithRewards = (
  markets: readonly BinaryMarket[],
  rewards: readonly MarketReward[]
): BinaryMarket[] => {
  const rewardByConditionId = new Map<string, MarketReward>();

  for (const reward of rewards) {
    rewardByConditionId.set(reward.condition_id, reward);
  }

  return markets.map((market) => {
    const reward = rewardByConditionId.get(market.conditionId);

    if (!reward) {
      return market;
    }

    return {
      ...market,
      rewardsMaxSpread: reward.rewards_max_spread,
      rewardsMinSize: reward.rewards_min_size,
      rewardRatePerDay: reward.rewards_config.reduce(
        (total, config) => total + config.rate_per_day,
        0
      )
    };
  });
};

export const fetchClosedBinaryMarketResolutionBySlug = async (
  slug: string
): Promise<ClosedBinaryMarketResolution | undefined> => {
  const url = new URL("/markets", config.gammaHost);
  url.searchParams.set("closed", "true");
  url.searchParams.set("slug", slug);

  const response = await fetch(url);

  if (!response.ok) {
    const detail = (await response.text()).trim();
    const suffix = detail ? ` - ${detail}` : "";
    throw new Error(
      `Gamma closed market resolution request failed: ${response.status} ${response.statusText}${suffix}`
    );
  }

  const payload = (await response.json()) as GammaMarketResponse[];

  if (!Array.isArray(payload) || payload.length === 0) {
    return undefined;
  }

  const rawMarket = payload[0]!;
  const market = normalizeMarket(rawMarket);

  if (!market || !market.closed) {
    return undefined;
  }

  const outcomePrices = parseNumericArray(rawMarket.outcomePrices);

  if (outcomePrices.length !== 2) {
    return undefined;
  }

  const [priceA, priceB] = outcomePrices as [number, number];
  const total = priceA + priceB;

  if (!(total > 0)) {
    return undefined;
  }

  return {
    market,
    payoutFractions: [priceA / total, priceB / total],
    closedTime: rawMarket.closedTime
  };
};
