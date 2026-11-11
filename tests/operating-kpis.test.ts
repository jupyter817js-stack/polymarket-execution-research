import { describe, expect, it } from "vitest";

import { buildOperatingKpiSummary } from "../src/core/operating-kpis.js";

describe("Operating KPI summary", () => {
  it("builds ROI, reward/rebate share, and yes/no imbalance from trades and open lots", () => {
    const summary = buildOperatingKpiSummary({
      dayKey: "2026-04-06",
      dailyTradeCount: 2,
      dailyRealizedPnlUsdc: 4,
      dailyGrossRealizedPnlUsdc: 5,
      dailyRewardUsdc: 1.5,
      dailyRebateUsdc: 0.5,
      capitalBaseUsdc: 200,
      trades: [
        {
          dayKey: "2026-04-06",
          expectedEdgeUsdc: 2.5
        },
        {
          dayKey: "2026-04-06",
          expectedEdgeUsdc: 1.5
        }
      ],
      openLots: [
        {
          shares: 3,
          totalCostUsdc: 1.2,
          outcome: "Yes"
        },
        {
          shares: 1,
          totalCostUsdc: 0.4,
          outcome: "No"
        }
      ]
    });

    expect(summary).toEqual({
      tradeCount: 2,
      averageTradeExpectedEdgeUsdc: 2,
      averageTradeNetPnlUsdc: 2,
      rewardIncomeUsdc: 1.5,
      rebateIncomeUsdc: 0.5,
      rewardShareOfPositiveCreditsPct: 21.42857143,
      rebateShareOfPositiveCreditsPct: 7.14285714,
      dailyRoiPct: 2,
      residualInventoryCostUsdc: 1.6,
      residualInventoryUtilizationPct: 0.8,
      yesNoImbalancePct: 50
    });
  });
});
