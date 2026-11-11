import type { StrategyName } from "../core/types.js";
import type { PaperTradingSessionReport } from "../paper-trading/report.js";
import type { RealizedTradingSessionReport } from "./realized-report.js";

export type PaperLiveComparisonBucket = {
  label: "high" | "medium" | "low" | "unclassified";
  paperTradeCount: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveTradeCount: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
};

export type PaperLiveComparisonObservedLatencyBucket = {
  label: "fast" | "moderate" | "slow" | "unclassified";
  paperTradeCount: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveTradeCount: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
  averageObservedVenueLatencyMs?: number;
  averageObservedBookSkewMs?: number;
};

export type PaperLiveComparisonStrategy = {
  strategy: StrategyName;
  paperTradeCount: number;
  paperExpectedRealizedPnlUsdc: number;
  matchedLiveTradeCount: number;
  matchedLiveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
};

export type PaperLiveComparisonMatch = {
  key: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  paperTradeCount: number;
  paperExpectedRealizedPnlUsdc: number;
  paperFillConfidence: "high" | "medium" | "low" | "unclassified";
  paperObservedLatencyBucket: "fast" | "moderate" | "slow" | "unclassified";
  paperAverageObservedVenueLatencyMs?: number;
  paperAverageObservedBookSkewMs?: number;
  liveTradeCount: number;
  liveRealizedPnlUsdc: number;
  liveVsPaperDeltaUsdc: number;
};

export type PaperLiveComparisonReport = {
  paperSessionName: string;
  realizedSessionName: string;
  matchedKeyCount: number;
  unmatchedPaperTradeCount: number;
  unmatchedLiveTradeCount: number;
  byConfidence: PaperLiveComparisonBucket[];
  byObservedLatency: PaperLiveComparisonObservedLatencyBucket[];
  byStrategy: PaperLiveComparisonStrategy[];
  matches: PaperLiveComparisonMatch[];
};

type AggregatedPaperTrade = {
  key: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  tradeCount: number;
  expectedRealizedPnlUsdc: number;
  fillConfidence: "high" | "medium" | "low" | "unclassified";
  observedVenueLatencyTotalMs: number;
  observedVenueLatencyCount: number;
  observedBookSkewTotalMs: number;
  observedBookSkewCount: number;
};

type AggregatedLiveTrade = {
  key: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  tradeCount: number;
  realizedPnlUsdc: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const makeKey = (input: {
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
}): string => `${input.strategy}::${input.marketScope}::${input.conditionId ?? "*"}`;

const normalizeConfidence = (
  fillConfidence: "high" | "medium" | "low" | undefined
): "high" | "medium" | "low" | "unclassified" => fillConfidence ?? "unclassified";

const classifyObservedLatency = (
  observedVenueLatencyMs: number | undefined
): PaperLiveComparisonObservedLatencyBucket["label"] => {
  if (typeof observedVenueLatencyMs !== "number" || Number.isNaN(observedVenueLatencyMs)) {
    return "unclassified";
  }

  if (observedVenueLatencyMs <= 250) {
    return "fast";
  }

  if (observedVenueLatencyMs <= 1_000) {
    return "moderate";
  }

  return "slow";
};

export const comparePaperAndRealizedSessions = (input: {
  paper: PaperTradingSessionReport;
  realized: RealizedTradingSessionReport;
}): PaperLiveComparisonReport => {
  const paperByKey = new Map<string, AggregatedPaperTrade>();
  const liveByKey = new Map<string, AggregatedLiveTrade>();
  const byConfidence = new Map<
    PaperLiveComparisonBucket["label"],
    Omit<PaperLiveComparisonBucket, "label">
  >();
  const byObservedLatency = new Map<
    PaperLiveComparisonObservedLatencyBucket["label"],
    Omit<
      PaperLiveComparisonObservedLatencyBucket,
      "label" | "averageObservedVenueLatencyMs" | "averageObservedBookSkewMs"
    > & {
      observedVenueLatencyTotalMs: number;
      observedVenueLatencyCount: number;
      observedBookSkewTotalMs: number;
      observedBookSkewCount: number;
    }
  >();
  const byStrategy = new Map<StrategyName, Omit<PaperLiveComparisonStrategy, "strategy">>();

  for (const trade of input.paper.trades) {
    const key = makeKey(trade);
    const aggregated = paperByKey.get(key) ?? {
      key,
      strategy: trade.strategy,
      marketScope: trade.marketScope,
      conditionId: trade.conditionId,
      tradeCount: 0,
      expectedRealizedPnlUsdc: 0,
      fillConfidence: normalizeConfidence(trade.fillConfidence),
      observedVenueLatencyTotalMs: 0,
      observedVenueLatencyCount: 0,
      observedBookSkewTotalMs: 0,
      observedBookSkewCount: 0
    };

    aggregated.tradeCount += 1;
    aggregated.expectedRealizedPnlUsdc += trade.expectedRealizedPnlUsdc;
    if (typeof trade.observedVenueLatencyMs === "number") {
      aggregated.observedVenueLatencyTotalMs += trade.observedVenueLatencyMs;
      aggregated.observedVenueLatencyCount += 1;
    }
    if (typeof trade.observedBookSkewMs === "number") {
      aggregated.observedBookSkewTotalMs += trade.observedBookSkewMs;
      aggregated.observedBookSkewCount += 1;
    }
    paperByKey.set(key, aggregated);
  }

  for (const trade of input.realized.trades) {
    const key = makeKey(trade);
    const aggregated = liveByKey.get(key) ?? {
      key,
      strategy: trade.strategy,
      marketScope: trade.marketScope,
      conditionId: trade.conditionId,
      tradeCount: 0,
      realizedPnlUsdc: 0
    };

    aggregated.tradeCount += 1;
    aggregated.realizedPnlUsdc += trade.realizedPnlUsdc;
    liveByKey.set(key, aggregated);
  }

  const allKeys = new Set([...paperByKey.keys(), ...liveByKey.keys()]);
  const matches: PaperLiveComparisonMatch[] = [];
  let unmatchedPaperTradeCount = 0;
  let unmatchedLiveTradeCount = 0;

  for (const key of allKeys) {
    const paperTrade = paperByKey.get(key);
    const liveTrade = liveByKey.get(key);

    if (!paperTrade) {
      unmatchedLiveTradeCount += liveTrade?.tradeCount ?? 0;
      continue;
    }

    if (!liveTrade) {
      unmatchedPaperTradeCount += paperTrade.tradeCount;
    }

    const confidence = paperTrade.fillConfidence;
    const paperAverageObservedVenueLatencyMs =
      paperTrade.observedVenueLatencyCount > 0
        ? paperTrade.observedVenueLatencyTotalMs / paperTrade.observedVenueLatencyCount
        : undefined;
    const paperAverageObservedBookSkewMs =
      paperTrade.observedBookSkewCount > 0
        ? paperTrade.observedBookSkewTotalMs / paperTrade.observedBookSkewCount
        : undefined;
    const observedLatencyBucket = classifyObservedLatency(paperAverageObservedVenueLatencyMs);
    const confidenceBucket = byConfidence.get(confidence) ?? {
      paperTradeCount: 0,
      paperExpectedRealizedPnlUsdc: 0,
      matchedLiveTradeCount: 0,
      matchedLiveRealizedPnlUsdc: 0,
      liveVsPaperDeltaUsdc: 0
    };
    confidenceBucket.paperTradeCount += paperTrade.tradeCount;
    confidenceBucket.paperExpectedRealizedPnlUsdc += paperTrade.expectedRealizedPnlUsdc;
    confidenceBucket.matchedLiveTradeCount += liveTrade?.tradeCount ?? 0;
    confidenceBucket.matchedLiveRealizedPnlUsdc += liveTrade?.realizedPnlUsdc ?? 0;
    confidenceBucket.liveVsPaperDeltaUsdc +=
      (liveTrade?.realizedPnlUsdc ?? 0) - paperTrade.expectedRealizedPnlUsdc;
    byConfidence.set(confidence, confidenceBucket);

    const latencyBucket = byObservedLatency.get(observedLatencyBucket) ?? {
      paperTradeCount: 0,
      paperExpectedRealizedPnlUsdc: 0,
      matchedLiveTradeCount: 0,
      matchedLiveRealizedPnlUsdc: 0,
      liveVsPaperDeltaUsdc: 0,
      observedVenueLatencyTotalMs: 0,
      observedVenueLatencyCount: 0,
      observedBookSkewTotalMs: 0,
      observedBookSkewCount: 0
    };
    latencyBucket.paperTradeCount += paperTrade.tradeCount;
    latencyBucket.paperExpectedRealizedPnlUsdc += paperTrade.expectedRealizedPnlUsdc;
    latencyBucket.matchedLiveTradeCount += liveTrade?.tradeCount ?? 0;
    latencyBucket.matchedLiveRealizedPnlUsdc += liveTrade?.realizedPnlUsdc ?? 0;
    latencyBucket.liveVsPaperDeltaUsdc +=
      (liveTrade?.realizedPnlUsdc ?? 0) - paperTrade.expectedRealizedPnlUsdc;
    latencyBucket.observedVenueLatencyTotalMs += paperTrade.observedVenueLatencyTotalMs;
    latencyBucket.observedVenueLatencyCount += paperTrade.observedVenueLatencyCount;
    latencyBucket.observedBookSkewTotalMs += paperTrade.observedBookSkewTotalMs;
    latencyBucket.observedBookSkewCount += paperTrade.observedBookSkewCount;
    byObservedLatency.set(observedLatencyBucket, latencyBucket);

    const strategyBucket = byStrategy.get(paperTrade.strategy) ?? {
      paperTradeCount: 0,
      paperExpectedRealizedPnlUsdc: 0,
      matchedLiveTradeCount: 0,
      matchedLiveRealizedPnlUsdc: 0,
      liveVsPaperDeltaUsdc: 0
    };
    strategyBucket.paperTradeCount += paperTrade.tradeCount;
    strategyBucket.paperExpectedRealizedPnlUsdc += paperTrade.expectedRealizedPnlUsdc;
    strategyBucket.matchedLiveTradeCount += liveTrade?.tradeCount ?? 0;
    strategyBucket.matchedLiveRealizedPnlUsdc += liveTrade?.realizedPnlUsdc ?? 0;
    strategyBucket.liveVsPaperDeltaUsdc +=
      (liveTrade?.realizedPnlUsdc ?? 0) - paperTrade.expectedRealizedPnlUsdc;
    byStrategy.set(paperTrade.strategy, strategyBucket);

    matches.push({
      key,
      strategy: paperTrade.strategy,
      marketScope: paperTrade.marketScope,
      conditionId: paperTrade.conditionId,
      paperTradeCount: paperTrade.tradeCount,
      paperExpectedRealizedPnlUsdc: round(paperTrade.expectedRealizedPnlUsdc),
      paperFillConfidence: paperTrade.fillConfidence,
      paperObservedLatencyBucket: observedLatencyBucket,
      paperAverageObservedVenueLatencyMs:
        paperAverageObservedVenueLatencyMs === undefined
          ? undefined
          : round(paperAverageObservedVenueLatencyMs),
      paperAverageObservedBookSkewMs:
        paperAverageObservedBookSkewMs === undefined
          ? undefined
          : round(paperAverageObservedBookSkewMs),
      liveTradeCount: liveTrade?.tradeCount ?? 0,
      liveRealizedPnlUsdc: round(liveTrade?.realizedPnlUsdc ?? 0),
      liveVsPaperDeltaUsdc: round((liveTrade?.realizedPnlUsdc ?? 0) - paperTrade.expectedRealizedPnlUsdc)
    });
  }

  return {
    paperSessionName: input.paper.sessionName,
    realizedSessionName: input.realized.sessionName,
    matchedKeyCount: matches.length,
    unmatchedPaperTradeCount,
    unmatchedLiveTradeCount,
    byConfidence: [...byConfidence.entries()]
      .map(([label, bucket]) => ({
        label,
        paperTradeCount: bucket.paperTradeCount,
        paperExpectedRealizedPnlUsdc: round(bucket.paperExpectedRealizedPnlUsdc),
        matchedLiveTradeCount: bucket.matchedLiveTradeCount,
        matchedLiveRealizedPnlUsdc: round(bucket.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(bucket.liveVsPaperDeltaUsdc)
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byObservedLatency: [...byObservedLatency.entries()]
      .map(([label, bucket]) => ({
        label,
        paperTradeCount: bucket.paperTradeCount,
        paperExpectedRealizedPnlUsdc: round(bucket.paperExpectedRealizedPnlUsdc),
        matchedLiveTradeCount: bucket.matchedLiveTradeCount,
        matchedLiveRealizedPnlUsdc: round(bucket.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(bucket.liveVsPaperDeltaUsdc),
        averageObservedVenueLatencyMs:
          bucket.observedVenueLatencyCount > 0
            ? round(bucket.observedVenueLatencyTotalMs / bucket.observedVenueLatencyCount)
            : undefined,
        averageObservedBookSkewMs:
          bucket.observedBookSkewCount > 0
            ? round(bucket.observedBookSkewTotalMs / bucket.observedBookSkewCount)
            : undefined
      }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    byStrategy: [...byStrategy.entries()]
      .map(([strategy, bucket]) => ({
        strategy,
        paperTradeCount: bucket.paperTradeCount,
        paperExpectedRealizedPnlUsdc: round(bucket.paperExpectedRealizedPnlUsdc),
        matchedLiveTradeCount: bucket.matchedLiveTradeCount,
        matchedLiveRealizedPnlUsdc: round(bucket.matchedLiveRealizedPnlUsdc),
        liveVsPaperDeltaUsdc: round(bucket.liveVsPaperDeltaUsdc)
      }))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    matches: matches.sort((left, right) => left.key.localeCompare(right.key))
  };
};
