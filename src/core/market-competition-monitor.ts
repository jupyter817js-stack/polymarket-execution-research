/**
 * #14 — Market Competition Monitoring
 *
 * Combines two independent competition signals into a per-market snapshot:
 *   1. displacementRate  — fraction of MY resting quotes that were price-displaced
 *                          (from QuoteDisplacementTracker, 10-min rolling window)
 *   2. myRewardSharePct  — my estimated share of the reward pool for that market
 *                          (from Polymarket API via RewardMonitor callback)
 *   3. marketCompetitiveness — Polymarket's own competitiveness score (higher = less competitive)
 *
 * Call `updateRewardData` from the RewardEarningsDelta callback.
 * Call `getSnapshot` or `getAllSnapshots` from the monitoring loop.
 */

const STALE_REWARD_DATA_MS = 10 * 60 * 1_000; // treat reward data as stale after 10 min

export interface MarketCompetitionSnapshot {
  conditionId: string;
  marketSlug: string;
  /** Fraction of MY resting quotes that were price-displaced [0–1], or undefined if < 3 data points. */
  displacementRate: number | undefined;
  /** My estimated share of the daily reward pool for this market (0–100). */
  myRewardSharePct: number | undefined;
  /**
   * Polymarket's market_competitiveness value.
   * Higher = LESS competitive (more room for reward earnings).
   */
  marketCompetitiveness: number | undefined;
  /**
   * My share of total market fill volume in the observation window [0–1].
   * Computed as myFillShares / totalMarketFills. Undefined if no market fill data.
   */
  fillShareRatio: number | undefined;
  /** My total filled shares in the observation window. */
  myFillShares: number | undefined;
  /** Total market fill volume in the observation window (shares). */
  totalMarketFills: number | undefined;
  updatedAtMs: number;
}

type StoredRewardEntry = {
  marketSlug: string;
  earningPercentage: number;
  marketCompetitiveness: number;
  updatedAtMs: number;
};

export class MarketCompetitionMonitor {
  private readonly rewardByConditionId = new Map<string, StoredRewardEntry>();

  constructor(
    private readonly getDisplacementRate: (conditionId: string) => number | undefined,
    private readonly getFillShareStats?: (
      conditionId: string
    ) => { myShares: number; totalShares: number } | undefined
  ) {}

  /**
   * Called from the RewardEarningsDelta callback with per-market reward data.
   */
  updateRewardData(
    conditionId: string,
    marketSlug: string,
    earningPercentage: number,
    marketCompetitiveness: number,
    nowMs: number = Date.now()
  ): void {
    this.rewardByConditionId.set(conditionId, {
      marketSlug,
      earningPercentage,
      marketCompetitiveness,
      updatedAtMs: nowMs
    });
  }

  getSnapshot(conditionId: string, nowMs: number = Date.now()): MarketCompetitionSnapshot | undefined {
    const reward = this.rewardByConditionId.get(conditionId);
    const displacementRate = this.getDisplacementRate(conditionId);
    const fillStats = this.getFillShareStats?.(conditionId);
    const myFillShares = fillStats?.myShares;
    const totalMarketFills = fillStats?.totalShares;
    const fillShareRatio =
      totalMarketFills !== undefined && totalMarketFills > 0 && myFillShares !== undefined
        ? myFillShares / totalMarketFills
        : undefined;

    // Return undefined only if we have no signal at all.
    if (reward === undefined && displacementRate === undefined && fillShareRatio === undefined) {
      return undefined;
    }

    const isRewardFresh = reward !== undefined && nowMs - reward.updatedAtMs < STALE_REWARD_DATA_MS;

    return {
      conditionId,
      marketSlug: reward?.marketSlug ?? conditionId,
      displacementRate,
      myRewardSharePct: isRewardFresh ? reward!.earningPercentage : undefined,
      marketCompetitiveness: isRewardFresh ? reward!.marketCompetitiveness : undefined,
      fillShareRatio,
      myFillShares,
      totalMarketFills,
      updatedAtMs: Math.max(reward?.updatedAtMs ?? 0, nowMs)
    };
  }

  getAllSnapshots(conditionIds: readonly string[], nowMs: number = Date.now()): MarketCompetitionSnapshot[] {
    return conditionIds
      .map((id) => this.getSnapshot(id, nowMs))
      .filter((s): s is MarketCompetitionSnapshot => s !== undefined);
  }

  /** Returns summaries for all conditionIds that have reward data stored. */
  getAllKnownSnapshots(nowMs: number = Date.now()): MarketCompetitionSnapshot[] {
    return this.getAllSnapshots([...this.rewardByConditionId.keys()], nowMs);
  }

  /**
   * Returns a compact loggable summary array suitable for including in monitoring snapshots.
   * If conditionIds is omitted, returns summaries for all markets with known reward data.
   */
  getSummaryForLog(
    conditionIds?: readonly string[],
    nowMs: number = Date.now()
  ): Array<{
    market: string;
    displacementRatePct: number | undefined;
    myRewardSharePct: number | undefined;
    marketCompetitiveness: number | undefined;
    fillShareRatioPct: number | undefined;
  }> {
    const snapshots = conditionIds !== undefined
      ? this.getAllSnapshots(conditionIds, nowMs)
      : this.getAllKnownSnapshots(nowMs);
    return snapshots.map((s) => ({
      market: s.marketSlug,
      displacementRatePct:
        s.displacementRate !== undefined
          ? Math.round(s.displacementRate * 1000) / 10
          : undefined,
      myRewardSharePct:
        s.myRewardSharePct !== undefined
          ? Math.round(s.myRewardSharePct * 10) / 10
          : undefined,
      marketCompetitiveness:
        s.marketCompetitiveness !== undefined
          ? Math.round(s.marketCompetitiveness * 100) / 100
          : undefined,
      fillShareRatioPct:
        s.fillShareRatio !== undefined
          ? Math.round(s.fillShareRatio * 1000) / 10
          : undefined
    }));
  }
}
