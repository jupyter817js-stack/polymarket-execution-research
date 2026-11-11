import { describe, expect, it } from "vitest";

import {
  buildOperatorStatusAlert,
  buildOrderFillAlert,
  buildQuotePostedAlert,
  buildQuotePostRejectedAlert,
  buildRestartDrillAlert,
  buildRiskStateAlert,
  buildSmallLiveAlert
} from "../src/core/alert-events.js";

describe("Alert event builders", () => {
  it("builds a risk-state alert with severity mapped from the risk state", () => {
    const alert = buildRiskStateAlert({
      runtime: "integrated",
      snapshot: {
        state: "HALTED",
        dayKey: "2026-04-06",
        dailyRealizedPnlUsdc: -12.5,
        dailyLossUsdc: 12.5,
        consecutiveLosses: 4,
        apiErrors: 0,
        orderFailures: 1,
        stateMismatches: 0,
        lastEventAtMs: 100,
        haltReason: "daily_loss_limit_exceeded",
        haltDetail: "Loss threshold hit."
      }
    });

    expect(alert.severity).toBe("critical");
    expect(alert.category).toBe("risk_state");
    expect(alert.runtime).toBe("integrated");
    expect(alert.details?.haltReason).toBe("daily_loss_limit_exceeded");
  });

  it("builds a small-live alert summarizing review-required sessions", () => {
    const alert = buildSmallLiveAlert({
      reportType: "small_live_summary",
      schemaVersion: 1,
      sessionName: "small-live-2026-04-06",
      generatedAtMs: 200,
      overallStatus: "review",
      finalRiskState: "DEGRADED",
      realizedSession: {
        sessionName: "live-session",
        tradeCount: 2,
        winningTrades: 1,
        losingTrades: 1,
        flatTrades: 0,
        totalExpectedEdgeUsdc: 0.4,
        totalRealizedPnlUsdc: -0.1,
        realizedVsExpectedDeltaUsdc: -0.5
      },
      paperSession: {
        sessionName: "paper-session",
        source: "dry-run-runtime",
        expectedTradeCount: 2,
        filledTradeCount: 2,
        missedTradeCount: 0,
        fillRate: 1,
        totalExpectedRealizedPnlUsdc: 0.4,
        totalRealizedPnlUsdc: 0.4,
        expectedVsRealizedDeltaUsdc: 0,
        averageObservedVenueLatencyMs: 280,
        averageObservedBookSkewMs: 60,
        highConfidenceTradeCount: 1,
        mediumConfidenceTradeCount: 1,
        lowConfidenceTradeCount: 0,
        checkpointRecoveryReady: false,
        checkpointAgeMs: 180_000
      },
      comparison: {
        matchedKeyCount: 2,
        unmatchedPaperTradeCount: 0,
        unmatchedLiveTradeCount: 0,
        totalPaperVsLiveDeltaUsdc: -0.5,
        byConfidence: [],
        byObservedLatency: []
      },
      checkpoint: {
        runtime: "integrated",
        generatedAtMs: 180,
        reason: "stop",
        riskState: "DEGRADED",
        dailyRealizedPnlUsdc: -0.1,
        activeOrderCount: 1,
        activeConditionCount: 1,
        openLotCount: 2,
        openShares: 3.5,
        openCostUsdc: 1.15
      },
      byStrategy: [],
      flags: [
        {
          code: "paper_checkpoint_not_ready",
          severity: "warning",
          detail: "Paper checkpoint is stale."
        }
      ]
    });

    expect(alert.severity).toBe("warning");
    expect(alert.category).toBe("small_live_report");
    expect(alert.details?.paperCheckpointRecoveryReady).toBe(false);
    expect(alert.details?.flagCodes).toEqual(["paper_checkpoint_not_ready"]);
  });

  it("builds a restart-drill alert with outcome-based severity", () => {
    const alert = buildRestartDrillAlert({
      reportType: "restart_drill_report",
      schemaVersion: 1,
      sessionName: "restart-drill-1",
      generatedAtMs: 300,
      runtime: "integrated",
      outcome: "warning",
      checkpoint: {
        generatedAtMs: 250,
        riskState: "DEGRADED",
        openLotCount: 2,
        openShares: 3.5,
        openCostUsdc: 1.15
      },
      recovery: {
        recoveredLotCount: 2,
        recoveredShares: 3.4,
        recoveredCostUsdc: 1.1
      },
      totals: {
        matchedLotCount: 2,
        missingLotCount: 0,
        unexpectedLotCount: 0,
        sharesDelta: -0.1,
        costDeltaUsdc: -0.05
      },
      lotDiffs: [],
      flags: [
        {
          code: "share_mismatch",
          severity: "warning",
          detail: "Recovered shares drifted."
        }
      ]
    });

    expect(alert.severity).toBe("warning");
    expect(alert.category).toBe("restart_drill_report");
    expect(alert.details?.sharesDelta).toBe(-0.1);
  });

  it("builds an order fill alert for operator feeds", () => {
    const alert = buildOrderFillAlert({
      runtime: "integrated",
      strategy: "market-making",
      market: "hawks-vs-cavs",
      outcome: "Hawks",
      side: "BUY",
      shares: 12,
      price: 0.43,
      notionalUsdc: 5.16,
      occurredAtMs: 400,
      positionBeforeShares: 0,
      positionAfterShares: 12,
      averageCostUsdcPerShare: 0.43,
      currentPriceUsdc: 0.44,
      unrealizedPnlUsdc: 0.12,
      totalNetPnlUsdc: 0.12,
      positionBiasPct: 100,
      reason: "spread_capture",
      expectedPriceUsdc: 0.43,
      slippageUsdcPerShare: 0,
      quotePostedAtMs: 320,
      quoteAgeMs: 80_000,
      quoteMaxRestingAgeMs: 90_000,
      orderType: "maker"
    });

    expect(alert.category).toBe("order_fill");
    expect(alert.severity).toBe("info");
    expect(alert.title).toContain("BUY");
    expect(alert.details?.notionalUsdc).toBe(5.16);
    expect(alert.details?.positionAfterShares).toBe(12);
    expect(alert.details?.averageCostUsdcPerShare).toBe(0.43);
    expect(alert.details?.totalNetPnlUsdc).toBe(0.12);
    expect(alert.details?.reason).toBe("spread_capture");
    expect(alert.details?.quoteAgeMs).toBe(80000);
    expect(alert.details?.quoteMaxRestingAgeMs).toBe(90000);
  });

  it("builds a quote rejected alert with retry guidance", () => {
    const alert = buildQuotePostRejectedAlert({
      runtime: "market-maker",
      strategy: "market-making",
      market: "hawks-vs-cavs",
      outcome: "Hawks",
      side: "SELL",
      size: 12,
      price: 0.44,
      error: "not enough balance",
      occurredAtMs: 500,
      nextRetryAfterMs: 30000
    });

    expect(alert.category).toBe("quote_post_rejected");
    expect(alert.severity).toBe("warning");
    expect(alert.details?.nextRetryAfterMs).toBe(30000);
  });

  it("builds a quote posted alert for operator feeds", () => {
    const alert = buildQuotePostedAlert({
      runtime: "market-maker",
      strategy: "market-making",
      market: "hawks-vs-cavs",
      outcome: "Hawks",
      side: "BUY",
      size: 12,
      price: 0.31,
      occurredAtMs: 550,
      orderId: "order-123",
      quoteSlot: "primary",
      orderType: "GTC",
      executionStyle: "passive-maker",
      postOnly: true,
      maxRestingAgeMs: 90_000
    });

    expect(alert.category).toBe("quote_posted");
    expect(alert.severity).toBe("info");
    expect(alert.title).toContain("BUY");
    expect(alert.details?.orderId).toBe("order-123");
    expect(alert.details?.quoteSlot).toBe("primary");
    expect(alert.details?.postOnly).toBe(true);
    expect(alert.details?.maxRestingAgeMs).toBe(90000);
  });

  it("builds an operator status alert with cash and checkpoint summary", () => {
    const alert = buildOperatorStatusAlert({
      runtime: "integrated",
      checkpoint: {
        runtime: "integrated",
        reason: "checkpoint",
        generatedAtMs: 600,
        riskState: "RUNNING",
        activeOrderCount: 2,
        activeConditionCount: 1,
        openLotCount: 3,
        openShares: 24,
        openCostUsdc: 11.88
      },
      cashBalanceUsdc: 79.59,
      cashAllowanceUsdc: 79.59,
      cashBalanceMayBeStale: true,
      openPositionValueUsdc: 12.1,
      openUnrealizedPnlUsdc: 0.22,
      pricedOpenTokenCount: 3,
      unpricedOpenTokenCount: 0,
      dailyRealizedPnlUsdc: -0.6,
      lifetimeRealizedPnlUsdc: 3.4,
      marketMakingDailyPnlUsdc: -0.25,
      marketMakingLifetimePnlUsdc: 2.5,
      sameMarketArbDailyPnlUsdc: 0.15,
      sameMarketArbLifetimePnlUsdc: 0.9,
      rewardIncomeUsdc: 0.2,
      rebateIncomeUsdc: 0.1,
      lifetimeRewardIncomeUsdc: 0.4,
      lifetimeRebateIncomeUsdc: 0.3,
      lifetimeTradeCount: 7,
      winningTradeCount: 4,
      losingTradeCount: 3,
      totalNetPnlUsdc: 4.1
    });

    expect(alert.category).toBe("operator_status");
    expect(alert.severity).toBe("info");
    expect(alert.details?.cashBalanceUsdc).toBe(79.59);
    expect(alert.details?.cashBalanceMayBeStale).toBe(true);
    expect(alert.details?.openLotCount).toBe(3);
    expect(alert.details?.marketMakingDailyPnlUsdc).toBe(-0.25);
    expect(alert.details?.lifetimeRealizedPnlUsdc).toBe(3.4);
    expect(alert.details?.lifetimeTradeCount).toBe(7);
    expect(alert.details?.totalNetPnlUsdc).toBe(4.1);
    expect(alert.details?.openPositionValueUsdc).toBe(12.1);
    expect(alert.details?.openUnrealizedPnlUsdc).toBe(0.22);
    expect(alert.details?.pricedOpenTokenCount).toBe(3);
  });
});
