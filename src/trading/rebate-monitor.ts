import type { ClobClient, Trade } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";
import { estimateMakerRebate } from "../strategy/rebates.js";
import type { BinaryMarket, CurrentRebateEntry } from "../types.js";

export type MakerFillRecord = {
  tradeId: string;
  orderId?: string;
  date: string;
  matchedAt: string;
  conditionId: string;
  marketSlug: string;
  category?: string;
  feesEnabled: boolean;
  assetId: string;
  outcome: string;
  side: string;
  shares: number;
  price: number;
  notionalUsdc: number;
  feeEquivalentUsdc: number;
  maxPotentialRebateUsdc: number;
  makerRebatePct: number;
};

type DailyEstimateSummary = {
  fillCount: number;
  totalNotionalUsdc: number;
  totalFeeEquivalentUsdc: number;
  estimatedMaxRebateUsdc: number;
  markets: Array<{
    conditionId: string;
    marketSlug: string;
    category?: string;
    feesEnabled: boolean;
    fillCount: number;
    totalNotionalUsdc: number;
    totalFeeEquivalentUsdc: number;
    estimatedMaxRebateUsdc: number;
  }>;
};

export type ActualRebateDelta = {
  date: string;
  deltaRebateUsdc: number;
  totalActualRebatedUsdc: number;
  fillCount: number;
  marketDeltas: Array<{
    conditionId?: string;
    marketSlug?: string;
    category?: string;
    deltaRebateUsdc: number;
    totalActualRebatedUsdc: number;
  }>;
};

const MAX_TRADE_PAGES_PER_REFRESH = 25;
const END_TRADE_CURSOR = "LTE=";

const formatUtcDate = (value: Date): string => value.toISOString().slice(0, 10);

const startOfUtcDayMs = (value: Date): number =>
  Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());

const asFiniteNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const isInvalidTradeParamsPayloadError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    status?: unknown;
    message?: unknown;
    data?: { error?: unknown };
  };
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.data?.error === "string"
        ? candidate.data.error
        : "";

  return status === 400 && /invalid trade params payload/i.test(message);
};

const normalizeActualRebatePayload = (payload: unknown): CurrentRebateEntry[] => {
  if (payload === null || payload === undefined) {
    return [];
  }

  const rows =
    Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? ((payload as { data: unknown[] }).data ?? [])
        : [payload];

  const normalized: CurrentRebateEntry[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const candidate = row as Record<string, unknown>;
    const rebatedFeesUsdc =
      asFiniteNumber(candidate.rebated_fees_usdc) ??
      asFiniteNumber(candidate.rebatedFeesUsdc) ??
      asFiniteNumber(candidate.rebated_fees) ??
      asFiniteNumber(candidate.rebatedFees) ??
      asFiniteNumber(candidate.amount) ??
      0;
    const date =
      typeof candidate.date === "string"
        ? candidate.date
        : typeof candidate.day === "string"
          ? candidate.day
          : formatUtcDate(new Date());
    const makerAddress =
      typeof candidate.maker_address === "string"
        ? candidate.maker_address
        : typeof candidate.makerAddress === "string"
          ? candidate.makerAddress
          : "";
    const conditionId =
      typeof candidate.condition_id === "string"
        ? candidate.condition_id
        : typeof candidate.conditionId === "string"
          ? candidate.conditionId
          : undefined;
    const marketSlug =
      typeof candidate.market_slug === "string"
        ? candidate.market_slug
        : typeof candidate.marketSlug === "string"
          ? candidate.marketSlug
          : undefined;

    normalized.push({
      date,
      makerAddress,
      conditionId,
      marketSlug,
      rebatedFeesUsdc
    });
  }

  return normalized;
};

export class RebateMonitor {
  private tradesTimer: NodeJS.Timeout | undefined;
  private summaryTimer: NodeJS.Timeout | undefined;
  private activeDate = formatUtcDate(new Date());
  private readonly ledger = new Map<string, MakerFillRecord>();
  private lastSummarySignature = "";
  private lastPublishedActualRebateUsdc = 0;
  private readonly lastPublishedActualRebateByConditionId = new Map<string, number>();
  private tradeRefreshDisabled = false;

  constructor(
    private readonly client: ClobClient,
    private readonly makerAddress: string,
    private readonly logger: Logger,
    private readonly lookupMarket: (conditionId: string) => BinaryMarket | undefined,
    private readonly onActualRebateDelta?: (delta: ActualRebateDelta) => void,
    private readonly onMakerFillRecorded?: (fill: MakerFillRecord) => void
  ) {}

  start(): void {
    this.tradesTimer = setInterval(() => {
      void this.refreshTrades();
    }, config.rebates.tradesRefreshMs);
    this.summaryTimer = setInterval(() => {
      void this.logDailySummary();
    }, config.rebates.summaryRefreshMs);

    void this.refreshTrades();
    void this.logDailySummary();
  }

  stop(): void {
    if (this.tradesTimer) {
      clearInterval(this.tradesTimer);
      this.tradesTimer = undefined;
    }

    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = undefined;
    }
  }

  private rotateDayIfNeeded(): void {
    const nextDate = formatUtcDate(new Date());

    if (nextDate === this.activeDate) {
      return;
    }

    this.activeDate = nextDate;
    this.ledger.clear();
    this.lastSummarySignature = "";
    this.lastPublishedActualRebateUsdc = 0;
    this.lastPublishedActualRebateByConditionId.clear();
  }

  private async refreshTrades(): Promise<void> {
    this.rotateDayIfNeeded();

    if (this.tradeRefreshDisabled) {
      return;
    }

    try {
      const trades = await this.fetchCurrentDayTrades();

      const chronologicalTrades = [...trades].sort((left, right) => {
        const leftAt = Date.parse(left.match_time);
        const rightAt = Date.parse(right.match_time);
        return (Number.isFinite(leftAt) ? leftAt : 0) - (Number.isFinite(rightAt) ? rightAt : 0);
      });

      for (const trade of chronologicalTrades) {
        this.recordTrade(trade);
      }
    } catch (error) {
      if (isInvalidTradeParamsPayloadError(error)) {
        this.disableTradeRefresh(
          "Trades endpoint rejected rebate trade refresh params; disabling maker fill backfill for this run while keeping daily rebate summaries enabled.",
          error
        );
        return;
      }

      this.logger.warn({ err: error }, "Maker rebate trade refresh failed.");
    }
  }

  private disableTradeRefresh(message: string, error?: unknown): void {
    if (this.tradeRefreshDisabled) {
      return;
    }

    this.tradeRefreshDisabled = true;

    if (this.tradesTimer) {
      clearInterval(this.tradesTimer);
      this.tradesTimer = undefined;
    }

    this.logger.info({ err: error }, message);
  }

  private async fetchCurrentDayTrades(): Promise<Trade[]> {
    const startMs = startOfUtcDayMs(new Date());
    const trades: Trade[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TRADE_PAGES_PER_REFRESH; page += 1) {
      const response = await this.fetchTradesPage(cursor);

      if (!response.trades || response.trades.length === 0) {
        break;
      }

      let reachedOlderTrades = false;

      for (const trade of response.trades) {
        const matchedAtMs = Date.parse(trade.match_time);

        if (Number.isFinite(matchedAtMs) && matchedAtMs < startMs) {
          reachedOlderTrades = true;
          break;
        }

        trades.push(trade);
      }

      if (
        reachedOlderTrades ||
        !response.next_cursor ||
        response.next_cursor === cursor ||
        response.next_cursor === END_TRADE_CURSOR
      ) {
        break;
      }

      cursor = response.next_cursor;
    }

    return trades;
  }

  private async fetchTradesPage(cursor?: string) {
    const currentApiParams = {
      user: this.makerAddress
    } as unknown as Parameters<ClobClient["getTradesPaginated"]>[0];

    try {
      return await this.client.getTradesPaginated(currentApiParams, cursor);
    } catch (error) {
      if (!isInvalidTradeParamsPayloadError(error)) {
        throw error;
      }

      const legacyApiParams = {
        maker_address: this.makerAddress
      } as Parameters<ClobClient["getTradesPaginated"]>[0];

      this.logger.debug?.(
        {
          makerAddress: this.makerAddress
        },
        "Trades endpoint rejected the current user query shape. Retrying rebate trade refresh with legacy maker_address params."
      );

      return this.client.getTradesPaginated(legacyApiParams, cursor);
    }
  }

  private recordTrade(trade: Trade): void {
    if (this.ledger.has(trade.id)) {
      return;
    }

    if (!["MATCHED", "MINED", "CONFIRMED"].includes(String(trade.status ?? "").toUpperCase())) {
      return;
    }

    const matchedAtMs = Date.parse(trade.match_time);

    if (!Number.isFinite(matchedAtMs)) {
      return;
    }

    const makerOrder =
      trade.maker_orders.find(
        (order) => order.maker_address.toLowerCase() === this.makerAddress.toLowerCase()
      ) ?? trade.maker_orders[0];

    if (!makerOrder) {
      return;
    }

    const shares = Number(makerOrder.matched_amount || trade.size);
    const price = Number(makerOrder.price || trade.price);

    if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0) {
      return;
    }

    const market = this.lookupMarket(trade.market);
    const estimate =
      market?.feesEnabled
        ? estimateMakerRebate({
            shares,
            price,
            category: market.category
          })
        : {
            feeEquivalentUsdc: 0,
            maxPotentialRebateUsdc: 0,
            makerRebatePct: 0,
            categoryRuleApplied: false
          };
    const entry: MakerFillRecord = {
      tradeId: trade.id,
      orderId: makerOrder.order_id,
      date: formatUtcDate(new Date(matchedAtMs)),
      matchedAt: trade.match_time,
      conditionId: trade.market,
      marketSlug: market?.slug ?? trade.market,
      category: market?.category,
      feesEnabled: market?.feesEnabled ?? false,
      assetId: makerOrder.asset_id,
      outcome: makerOrder.outcome,
      side: makerOrder.side,
      shares,
      price,
      notionalUsdc: shares * price,
      feeEquivalentUsdc: estimate.feeEquivalentUsdc,
      maxPotentialRebateUsdc: estimate.maxPotentialRebateUsdc,
      makerRebatePct: estimate.makerRebatePct
    };

    this.ledger.set(entry.tradeId, entry);
    this.onMakerFillRecorded?.(entry);
    this.logger.info(
      {
        tradeId: entry.tradeId,
        matchedAt: entry.matchedAt,
        market: entry.marketSlug,
        conditionId: entry.conditionId,
        category: entry.category,
        feesEnabled: entry.feesEnabled,
        outcome: entry.outcome,
        side: entry.side,
        shares: entry.shares,
        price: entry.price,
        notionalUsdc: entry.notionalUsdc,
        feeEquivalentUsdc: entry.feeEquivalentUsdc,
        maxPotentialRebateUsdc: entry.maxPotentialRebateUsdc,
        makerRebatePct: entry.makerRebatePct
      },
      "Maker fill recorded for rebate accounting."
    );
  }

  private summarizeLedger(): DailyEstimateSummary {
    const grouped = new Map<string, DailyEstimateSummary["markets"][number]>();

    for (const entry of this.ledger.values()) {
      if (entry.date !== this.activeDate) {
        continue;
      }

      const marketSummary = grouped.get(entry.conditionId) ?? {
        conditionId: entry.conditionId,
        marketSlug: entry.marketSlug,
        category: entry.category,
        feesEnabled: entry.feesEnabled,
        fillCount: 0,
        totalNotionalUsdc: 0,
        totalFeeEquivalentUsdc: 0,
        estimatedMaxRebateUsdc: 0
      };

      marketSummary.fillCount += 1;
      marketSummary.totalNotionalUsdc += entry.notionalUsdc;
      marketSummary.totalFeeEquivalentUsdc += entry.feeEquivalentUsdc;
      marketSummary.estimatedMaxRebateUsdc += entry.maxPotentialRebateUsdc;
      grouped.set(entry.conditionId, marketSummary);
    }

    const markets = [...grouped.values()].sort(
      (left, right) => right.estimatedMaxRebateUsdc - left.estimatedMaxRebateUsdc
    );

    return {
      fillCount: [...this.ledger.values()].filter((entry) => entry.date === this.activeDate).length,
      totalNotionalUsdc: markets.reduce((total, market) => total + market.totalNotionalUsdc, 0),
      totalFeeEquivalentUsdc: markets.reduce(
        (total, market) => total + market.totalFeeEquivalentUsdc,
        0
      ),
      estimatedMaxRebateUsdc: markets.reduce(
        (total, market) => total + market.estimatedMaxRebateUsdc,
        0
      ),
      markets
    };
  }

  private async fetchCurrentActualRebates(): Promise<CurrentRebateEntry[]> {
    const url = new URL("/rebates/current", config.host);
    url.searchParams.set("date", this.activeDate);
    url.searchParams.set("maker_address", this.makerAddress);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Current rebates request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    return normalizeActualRebatePayload(payload);
  }

  private async logDailySummary(): Promise<void> {
    this.rotateDayIfNeeded();

    try {
      const estimated = this.summarizeLedger();
      const actual = await this.fetchCurrentActualRebates();
      const totalActualRebatedUsdc = actual.reduce(
        (total, entry) => total + entry.rebatedFeesUsdc,
        0
      );
      const signature = JSON.stringify({
        date: this.activeDate,
        estimatedMaxRebateUsdc: Number(estimated.estimatedMaxRebateUsdc.toFixed(8)),
        totalActualRebatedUsdc: Number(totalActualRebatedUsdc.toFixed(8)),
        fills: estimated.fillCount,
        actualRows: actual
          .map((entry) => ({
            conditionId: entry.conditionId,
            marketSlug: entry.marketSlug,
            rebatedFeesUsdc: Number(entry.rebatedFeesUsdc.toFixed(8))
          }))
          .sort((left, right) =>
            (left.conditionId ?? left.marketSlug ?? "").localeCompare(
              right.conditionId ?? right.marketSlug ?? ""
            )
          )
      });

      if (signature === this.lastSummarySignature) {
        return;
      }

      this.lastSummarySignature = signature;
      this.publishActualRebateDelta({
        date: this.activeDate,
        totalActualRebatedUsdc,
        fillCount: estimated.fillCount,
        actualRows: actual
      });
      this.logger.info(
        {
          date: this.activeDate,
          makerAddress: this.makerAddress,
          fillCount: estimated.fillCount,
          totalNotionalUsdc: estimated.totalNotionalUsdc,
          totalFeeEquivalentUsdc: estimated.totalFeeEquivalentUsdc,
          estimatedMaxRebateUsdc: estimated.estimatedMaxRebateUsdc,
          totalActualRebatedUsdc,
          actualCaptureVsMaxPct:
            estimated.estimatedMaxRebateUsdc > 0
              ? totalActualRebatedUsdc / estimated.estimatedMaxRebateUsdc
              : undefined,
          markets: estimated.markets,
          actualRebates: actual
        },
        "Daily maker rebate summary updated."
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Daily maker rebate summary fetch failed.");
    }
  }

  private publishActualRebateDelta(input: {
    date: string;
    totalActualRebatedUsdc: number;
    fillCount: number;
    actualRows?: CurrentRebateEntry[];
  }): void {
    if (!this.onActualRebateDelta) {
      return;
    }

    const deltaRebateUsdc = input.totalActualRebatedUsdc - this.lastPublishedActualRebateUsdc;
    const marketDeltas = (input.actualRows ?? [])
      .map((entry) => {
        const scopeId = entry.conditionId ?? entry.marketSlug;

        if (!scopeId) {
          return undefined;
        }

        const previous = this.lastPublishedActualRebateByConditionId.get(scopeId) ?? 0;
        const delta = entry.rebatedFeesUsdc - previous;
        const market = entry.conditionId ? this.lookupMarket(entry.conditionId) : undefined;

        return Math.abs(delta) > 1e-9
          ? {
              conditionId: entry.conditionId,
              marketSlug: entry.marketSlug ?? market?.slug,
              category: market?.category,
              deltaRebateUsdc: delta,
              totalActualRebatedUsdc: entry.rebatedFeesUsdc
            }
          : undefined;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (Math.abs(deltaRebateUsdc) <= 1e-9 && marketDeltas.length === 0) {
      return;
    }

    this.lastPublishedActualRebateUsdc = input.totalActualRebatedUsdc;
    for (const entry of input.actualRows ?? []) {
      const scopeId = entry.conditionId ?? entry.marketSlug;

      if (!scopeId) {
        continue;
      }

      this.lastPublishedActualRebateByConditionId.set(scopeId, entry.rebatedFeesUsdc);
    }
    this.onActualRebateDelta({
      date: input.date,
      deltaRebateUsdc,
      totalActualRebatedUsdc: input.totalActualRebatedUsdc,
      fillCount: input.fillCount,
      marketDeltas
    });
  }
}
