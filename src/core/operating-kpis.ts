import { config } from "../config.js";
import type { InventoryLotSnapshot } from "./inventory-lot-tracker.js";
import type { PnlTradeRecord } from "./types.js";

type OperatingKpiTradeLike = Pick<PnlTradeRecord, "dayKey" | "expectedEdgeUsdc">;
type OperatingKpiLotLike = Pick<InventoryLotSnapshot, "shares" | "totalCostUsdc" | "outcome">;

export type OperatingKpiSummary = {
  tradeCount: number;
  averageTradeExpectedEdgeUsdc: number;
  averageTradeNetPnlUsdc: number;
  rewardIncomeUsdc: number;
  rebateIncomeUsdc: number;
  rewardShareOfPositiveCreditsPct: number;
  rebateShareOfPositiveCreditsPct: number;
  dailyRoiPct: number;
  residualInventoryCostUsdc: number;
  residualInventoryUtilizationPct: number;
  yesNoImbalancePct?: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const normalizeOutcome = (outcome?: string): "yes" | "no" | undefined => {
  const normalized = outcome?.trim().toLowerCase();

  if (normalized === "yes") {
    return "yes";
  }

  if (normalized === "no") {
    return "no";
  }

  return undefined;
};

export const buildOperatingKpiSummary = (input: {
  dayKey?: string;
  dailyTradeCount: number;
  dailyRealizedPnlUsdc: number;
  dailyGrossRealizedPnlUsdc: number;
  dailyRewardUsdc: number;
  dailyRebateUsdc: number;
  trades?: readonly OperatingKpiTradeLike[];
  openLots?: readonly OperatingKpiLotLike[];
  capitalBaseUsdc?: number;
}): OperatingKpiSummary => {
  const relevantTrades =
    input.dayKey === undefined
      ? [...(input.trades ?? [])]
      : (input.trades ?? []).filter((trade) => trade.dayKey === input.dayKey);
  const tradeCount =
    input.dailyTradeCount > 0 ? input.dailyTradeCount : relevantTrades.length;
  const totalExpectedEdgeUsdc = relevantTrades.reduce(
    (total, trade) => total + (trade.expectedEdgeUsdc ?? 0),
    0
  );
  const positiveCreditBase =
    Math.max(0, input.dailyGrossRealizedPnlUsdc) +
    Math.max(0, input.dailyRewardUsdc) +
    Math.max(0, input.dailyRebateUsdc);
  const capitalBaseUsdc = input.capitalBaseUsdc ?? config.capital.totalActiveBuyBudgetUsdc;
  const openLots = [...(input.openLots ?? [])];
  const residualInventoryCostUsdc = openLots.reduce(
    (total, lot) => total + lot.totalCostUsdc,
    0
  );
  const yesShares = openLots.reduce((total, lot) => {
    const normalizedOutcome = normalizeOutcome(lot.outcome);
    return normalizedOutcome === "yes" ? total + lot.shares : total;
  }, 0);
  const noShares = openLots.reduce((total, lot) => {
    const normalizedOutcome = normalizeOutcome(lot.outcome);
    return normalizedOutcome === "no" ? total + lot.shares : total;
  }, 0);
  const yesNoTrackedShares = yesShares + noShares;

  return {
    tradeCount,
    averageTradeExpectedEdgeUsdc:
      tradeCount > 0 ? round(totalExpectedEdgeUsdc / tradeCount) : 0,
    averageTradeNetPnlUsdc:
      tradeCount > 0 ? round(input.dailyRealizedPnlUsdc / tradeCount) : 0,
    rewardIncomeUsdc: round(input.dailyRewardUsdc),
    rebateIncomeUsdc: round(input.dailyRebateUsdc),
    rewardShareOfPositiveCreditsPct:
      positiveCreditBase > 0
        ? round((Math.max(0, input.dailyRewardUsdc) / positiveCreditBase) * 100)
        : 0,
    rebateShareOfPositiveCreditsPct:
      positiveCreditBase > 0
        ? round((Math.max(0, input.dailyRebateUsdc) / positiveCreditBase) * 100)
        : 0,
    dailyRoiPct:
      capitalBaseUsdc > 0 ? round((input.dailyRealizedPnlUsdc / capitalBaseUsdc) * 100) : 0,
    residualInventoryCostUsdc: round(residualInventoryCostUsdc),
    residualInventoryUtilizationPct:
      capitalBaseUsdc > 0 ? round((residualInventoryCostUsdc / capitalBaseUsdc) * 100) : 0,
    yesNoImbalancePct:
      yesNoTrackedShares > 0 ? round((Math.abs(yesShares - noShares) / yesNoTrackedShares) * 100) : undefined
  };
};
