import type { ClobClient, UserRewardsEarning } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";
import type { ActiveQuote } from "./quote-executor.js";
import { QuoteExecutor } from "./quote-executor.js";

type MarketQuoteSummary = {
  conditionId: string;
  marketSlug: string;
  totalQuotes: number;
  scoringQuotes: number;
  nonScoringOrderIds: string[];
};

export type RewardEarningsDelta = {
  date: string;
  deltaRewardUsdc: number;
  totalEstimatedEarningsUsdc: number;
  marketCount: number;
  marketDeltas: Array<{
    conditionId: string;
    marketSlug: string;
    deltaRewardUsdc: number;
    totalEstimatedEarningsUsdc: number;
    earningPercentage: number;
    marketCompetitiveness: number;
  }>;
};

const formatUtcDate = (value: Date): string => value.toISOString().slice(0, 10);

const sumMarketEarnings = (earning: UserRewardsEarning): number =>
  earning.earnings.reduce((total, item) => total + item.earnings, 0);

export class RewardMonitor {
  private scoringTimer: NodeJS.Timeout | undefined;
  private percentagesTimer: NodeJS.Timeout | undefined;
  private earningsTimer: NodeJS.Timeout | undefined;
  private readonly lastScoringSignature = new Map<string, string>();
  private readonly lastPercentageValue = new Map<string, number>();
  private lastEarningsSignature = "";
  private lastPublishedDate = "";
  private lastPublishedTotalEstimatedEarningsUsdc = 0;
  private readonly lastPublishedEarningsByConditionId = new Map<string, number>();

  constructor(
    private readonly client: ClobClient,
    private readonly quoteExecutor: QuoteExecutor,
    private readonly logger: Logger,
    private readonly onRewardEarningsDelta?: (delta: RewardEarningsDelta) => void
  ) {}

  start(): void {
    this.scoringTimer = setInterval(() => {
      void this.checkOrderScoring();
    }, config.rewards.scoringRefreshMs);
    this.percentagesTimer = setInterval(() => {
      void this.logRewardPercentages();
    }, config.rewards.percentagesRefreshMs);
    this.earningsTimer = setInterval(() => {
      void this.logDailyEarnings();
    }, config.rewards.earningsRefreshMs);

    void this.checkOrderScoring();
    void this.logRewardPercentages();
    void this.logDailyEarnings();
  }

  stop(): void {
    if (this.scoringTimer) {
      clearInterval(this.scoringTimer);
      this.scoringTimer = undefined;
    }

    if (this.percentagesTimer) {
      clearInterval(this.percentagesTimer);
      this.percentagesTimer = undefined;
    }

    if (this.earningsTimer) {
      clearInterval(this.earningsTimer);
      this.earningsTimer = undefined;
    }
  }

  private async checkOrderScoring(): Promise<void> {
    const activeQuotes = this.quoteExecutor.getActiveQuotes();

    if (activeQuotes.length === 0) {
      return;
    }

    try {
      const scoring = await this.client.areOrdersScoring({
        orderIds: activeQuotes.map((quote) => quote.orderId)
      });
      this.quoteExecutor.updateRewardScoring(scoring);
      const summaries = this.summarizeScoring(activeQuotes, scoring);
      const staleOrderIds: string[] = [];

      for (const summary of summaries) {
        const signature = `${summary.scoringQuotes}/${summary.totalQuotes}:${summary.nonScoringOrderIds.join(",")}`;
        const previousSignature = this.lastScoringSignature.get(summary.conditionId);

        if (signature !== previousSignature) {
          this.lastScoringSignature.set(summary.conditionId, signature);
          this.logger.info(
            {
              market: summary.marketSlug,
              conditionId: summary.conditionId,
              scoringQuotes: summary.scoringQuotes,
              totalQuotes: summary.totalQuotes,
              nonScoringOrderIds: summary.nonScoringOrderIds
            },
            "Reward scoring status updated."
          );
        }

        staleOrderIds.push(...summary.nonScoringOrderIds);
      }

      if (config.rewards.autoCancelNonScoring && staleOrderIds.length > 0) {
        await this.quoteExecutor.cancelQuotesByOrderIds(
          staleOrderIds,
          "reward scoring returned false"
        );
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Reward scoring check failed.");
    }
  }

  private summarizeScoring(
    activeQuotes: readonly ActiveQuote[],
    scoring: Record<string, boolean>
  ): MarketQuoteSummary[] {
    const grouped = new Map<string, MarketQuoteSummary>();

    for (const quote of activeQuotes) {
      const summary = grouped.get(quote.conditionId) ?? {
        conditionId: quote.conditionId,
        marketSlug: quote.marketSlug,
        totalQuotes: 0,
        scoringQuotes: 0,
        nonScoringOrderIds: []
      };

      summary.totalQuotes += 1;

      if (scoring[quote.orderId]) {
        summary.scoringQuotes += 1;
      } else {
        summary.nonScoringOrderIds.push(quote.orderId);
      }

      grouped.set(quote.conditionId, summary);
    }

    return [...grouped.values()];
  }

  private async logRewardPercentages(): Promise<void> {
    const activeQuotes = this.quoteExecutor.getActiveQuotes();

    if (activeQuotes.length === 0) {
      return;
    }

    try {
      const percentages = await this.client.getRewardPercentages();
      const seenConditions = new Set<string>();

      for (const quote of activeQuotes) {
        if (seenConditions.has(quote.conditionId)) {
          continue;
        }

        seenConditions.add(quote.conditionId);
        const percentage = percentages[quote.conditionId] ?? percentages[quote.marketSlug];
        const previous = this.lastPercentageValue.get(quote.conditionId);

        if (typeof percentage !== "number") {
          continue;
        }

        if (previous !== percentage) {
          this.lastPercentageValue.set(quote.conditionId, percentage);
          this.logger.info(
            {
              market: quote.marketSlug,
              conditionId: quote.conditionId,
              earningPercentage: percentage
            },
            "Reward percentage updated."
          );
        }
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Reward percentages fetch failed.");
    }
  }

  private async logDailyEarnings(): Promise<void> {
    // V2 검증 (2026-04-30 진단 결과):
    //   getUserEarningsAndMarketsConfig() 는 시장별 best-eligible maker 정보를 반환 —
    //   운영자 자기 데이터 아님. 모든 maker_address 가 다른 user (예: 0x5750f9c4...).
    //   봇이 이걸 누적해서 "리워드 +$31.95" 같은 misleading 표시를 만들었음.
    //
    //   getTotalEarningsForUserForDay() 는 인증된 사용자 (funder maker_address) 의
    //   일일 confirmed earnings 만 반환 — 진짜 운영자 reward.
    try {
      const date = formatUtcDate(new Date());
      const totalEarnings = await this.client.getTotalEarningsForUserForDay(date);
      const totalEstimatedEarningsUsdc = (totalEarnings ?? []).reduce(
        (sum, earning) => sum + (earning.earnings ?? 0),
        0
      );
      const signature = (totalEarnings ?? [])
        .map((e) => `${e.asset_address}:${e.earnings.toFixed(6)}`)
        .sort()
        .join("|");

      if (signature === this.lastEarningsSignature) {
        return;
      }

      this.lastEarningsSignature = signature;
      this.publishRewardDelta({
        date,
        totalEstimatedEarningsUsdc,
        marketCount: 0,
        markets: []
      });
      this.logger.info(
        {
          date,
          totalConfirmedEarningsUsdc: totalEstimatedEarningsUsdc,
          assetEntries: (totalEarnings ?? []).map((e) => ({
            assetAddress: e.asset_address,
            makerAddress: e.maker_address,
            earnings: e.earnings,
            assetRate: e.asset_rate
          }))
        },
        "Daily reward earnings snapshot updated (confirmed source)."
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Daily reward earnings fetch failed.");
    }
  }

  private publishRewardDelta(input: {
    date: string;
    totalEstimatedEarningsUsdc: number;
    marketCount: number;
    markets: Array<{
      conditionId: string;
      marketSlug: string;
      totalEstimatedEarningsUsdc: number;
      earningPercentage: number;
      marketCompetitiveness: number;
    }>;
  }): void {
    if (!this.onRewardEarningsDelta) {
      return;
    }

    if (this.lastPublishedDate !== input.date) {
      this.lastPublishedDate = input.date;
      this.lastPublishedTotalEstimatedEarningsUsdc = 0;
      this.lastPublishedEarningsByConditionId.clear();
    }

    const deltaRewardUsdc =
      input.totalEstimatedEarningsUsdc - this.lastPublishedTotalEstimatedEarningsUsdc;
    const marketDeltas = input.markets
      .map((market) => {
        const previous =
          this.lastPublishedEarningsByConditionId.get(market.conditionId) ?? 0;
        const delta = market.totalEstimatedEarningsUsdc - previous;

        return {
          conditionId: market.conditionId,
          marketSlug: market.marketSlug,
          deltaRewardUsdc: delta,
          totalEstimatedEarningsUsdc: market.totalEstimatedEarningsUsdc,
          earningPercentage: market.earningPercentage,
          marketCompetitiveness: market.marketCompetitiveness
        };
      })
      .filter((market) => Math.abs(market.deltaRewardUsdc) > 1e-9);

    if (Math.abs(deltaRewardUsdc) <= 1e-9 && marketDeltas.length === 0) {
      return;
    }

    this.lastPublishedTotalEstimatedEarningsUsdc = input.totalEstimatedEarningsUsdc;
    for (const market of input.markets) {
      this.lastPublishedEarningsByConditionId.set(
        market.conditionId,
        market.totalEstimatedEarningsUsdc
      );
    }
    this.onRewardEarningsDelta({
      date: input.date,
      deltaRewardUsdc,
      totalEstimatedEarningsUsdc: input.totalEstimatedEarningsUsdc,
      marketCount: input.marketCount,
      marketDeltas
    });
  }
}
