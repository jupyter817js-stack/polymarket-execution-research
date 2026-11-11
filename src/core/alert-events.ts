import type { RestartDrillReport } from "../session-report/restart-drill-report.js";
import type { SmallLiveReport } from "../session-report/small-live-report.js";
import type { RuntimeCheckpointSummary } from "./runtime-checkpoint-service.js";
import type { RiskStatusSnapshot } from "./types.js";
import type { AlertEvent } from "./alert-dispatcher.js";

const round = (value: number): number => Number(value.toFixed(8));

export const buildRiskStateAlert = (input: {
  runtime: string;
  snapshot: RiskStatusSnapshot;
}): AlertEvent => {
  const { runtime, snapshot } = input;
  const severity =
    snapshot.state === "HALTED"
      ? "critical"
      : snapshot.state === "DEGRADED" || snapshot.state === "WARNING"
        ? "warning"
        : "info";

  const summary =
    snapshot.state === "RUNNING"
      ? `Runtime ${runtime} returned to RUNNING state.`
      : snapshot.state === "RECOVERY"
        ? `Runtime ${runtime} entered RECOVERY state. BUY intents paused; normal operations resume after cooldown.`
        : `Runtime ${runtime} entered ${snapshot.state} state (${snapshot.haltReason ?? snapshot.warnReason ?? "threshold warning"}).`;

  return {
    schemaVersion: 1,
    category: "risk_state",
    severity,
    title: `Polybot risk state is ${snapshot.state}`,
    summary,
    occurredAtMs: snapshot.lastEventAtMs,
    runtime,
    tags: ["risk", snapshot.state.toLowerCase()],
    details: {
      dayKey: snapshot.dayKey,
      dailyRealizedPnlUsdc: round(snapshot.dailyRealizedPnlUsdc),
      dailyLossUsdc: round(snapshot.dailyLossUsdc),
      consecutiveLosses: snapshot.consecutiveLosses,
      apiErrors: snapshot.apiErrors,
      orderFailures: snapshot.orderFailures,
      stateMismatches: snapshot.stateMismatches,
      haltReason: snapshot.haltReason,
      haltDetail: snapshot.haltDetail,
      warnReason: snapshot.warnReason,
      recoveryUntilMs: snapshot.recoveryUntilMs
    }
  };
};

export const buildSmallLiveAlert = (report: SmallLiveReport): AlertEvent => {
  const criticalFlagCount = report.flags.filter((flag) => flag.severity === "critical").length;
  const severity =
    report.overallStatus === "halted"
      ? "critical"
      : report.overallStatus === "review"
        ? "warning"
        : "info";

  return {
    schemaVersion: 1,
    category: "small_live_report",
    severity,
    title: `Small-live session ${report.overallStatus}: ${report.sessionName}`,
    summary:
      report.overallStatus === "ok"
        ? `Live session closed cleanly with ${round(report.realizedSession.totalRealizedPnlUsdc)} USDC realized PnL.`
        : `Live session needs review. finalRiskState=${report.finalRiskState}, livePnl=${round(report.realizedSession.totalRealizedPnlUsdc)}, paperDelta=${round(report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0)}.`,
    occurredAtMs: report.generatedAtMs,
    runtime: report.checkpoint?.runtime,
    sessionName: report.sessionName,
    tags: ["small-live", report.overallStatus, report.finalRiskState.toLowerCase()],
    details: {
      finalRiskState: report.finalRiskState,
      liveTradeCount: report.realizedSession.tradeCount,
      totalRealizedPnlUsdc: round(report.realizedSession.totalRealizedPnlUsdc),
      totalPaperVsLiveDeltaUsdc: round(report.comparison?.totalPaperVsLiveDeltaUsdc ?? 0),
      openLotCount: report.checkpoint?.openLotCount ?? 0,
      activeOrderCount: report.checkpoint?.activeOrderCount ?? 0,
      paperCheckpointRecoveryReady: report.paperSession?.checkpointRecoveryReady,
      paperCheckpointAgeMs: report.paperSession?.checkpointAgeMs,
      restartDrillOutcome: report.restartDrill?.outcome,
      flagCodes: report.flags.map((flag) => flag.code),
      criticalFlagCount
    }
  };
};

export const buildRestartDrillAlert = (report: RestartDrillReport): AlertEvent => {
  const severity =
    report.outcome === "failed"
      ? "critical"
      : report.outcome === "warning"
        ? "warning"
        : "info";

  return {
    schemaVersion: 1,
    category: "restart_drill_report",
    severity,
    title: `Restart drill ${report.outcome}: ${report.sessionName}`,
    summary:
      report.outcome === "passed"
        ? "Restart drill matched recovered lots without material diffs."
        : `Restart drill reported lot diffs. missing=${report.totals.missingLotCount}, unexpected=${report.totals.unexpectedLotCount}.`,
    occurredAtMs: report.generatedAtMs,
    runtime: report.runtime,
    sessionName: report.sessionName,
    tags: ["restart-drill", report.outcome],
    details: {
      matchedLotCount: report.totals.matchedLotCount,
      missingLotCount: report.totals.missingLotCount,
      unexpectedLotCount: report.totals.unexpectedLotCount,
      sharesDelta: round(report.totals.sharesDelta),
      costDeltaUsdc: round(report.totals.costDeltaUsdc),
      flagCodes: report.flags.map((flag) => flag.code)
    }
  };
};

export const buildOrderFillAlert = (input: {
  runtime: string;
  strategy: string;
  market: string;
  outcome: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  notionalUsdc: number;
  occurredAtMs: number;
  realizedPnlUsdc?: number;
  positionBeforeShares?: number;
  positionAfterShares?: number;
  averageCostUsdcPerShare?: number;
  currentPriceUsdc?: number;
  unrealizedPnlUsdc?: number;
  totalNetPnlUsdc?: number;
  positionBiasPct?: number;
  reason?: string;
  expectedPriceUsdc?: number;
  slippageUsdcPerShare?: number;
  quotePostedAtMs?: number;
  quoteAgeMs?: number;
  quoteMaxRestingAgeMs?: number;
  orderType?: string;
  tags?: string[];
}): AlertEvent => ({
  schemaVersion: 1,
  category: "order_fill",
  severity: "info",
  title: input.tags?.includes("venue-sync")
    ? `포지션 감지 (미추적)`
    : `${input.side} 체결`,
  summary: input.tags?.includes("venue-sync")
    ? `[venue-sync] ${input.market} · ${input.outcome} · 보유수량: ${round(input.positionBeforeShares ?? 0)}주 → ${round(input.positionAfterShares ?? input.shares)}주`
    : `${input.market} · ${input.outcome} · ${round(input.shares)}주 @ ${round(input.price)} · $${round(input.notionalUsdc)}`,
  occurredAtMs: input.occurredAtMs,
  runtime: input.runtime,
  tags: [input.strategy, input.side.toLowerCase(), ...(input.tags ?? [])],
  details: {
    strategy: input.strategy,
    market: input.market,
    outcome: input.outcome,
    side: input.side,
    shares: round(input.shares),
    price: round(input.price),
    notionalUsdc: round(input.notionalUsdc),
    positionBeforeShares:
      typeof input.positionBeforeShares === "number" ? round(input.positionBeforeShares) : undefined,
    positionAfterShares:
      typeof input.positionAfterShares === "number" ? round(input.positionAfterShares) : undefined,
    averageCostUsdcPerShare:
      typeof input.averageCostUsdcPerShare === "number"
        ? round(input.averageCostUsdcPerShare)
        : undefined,
    currentPriceUsdc:
      typeof input.currentPriceUsdc === "number" ? round(input.currentPriceUsdc) : undefined,
    unrealizedPnlUsdc:
      typeof input.unrealizedPnlUsdc === "number" ? round(input.unrealizedPnlUsdc) : undefined,
    totalNetPnlUsdc:
      typeof input.totalNetPnlUsdc === "number" ? round(input.totalNetPnlUsdc) : undefined,
    positionBiasPct:
      typeof input.positionBiasPct === "number" ? round(input.positionBiasPct) : undefined,
    reason: input.reason,
    expectedPriceUsdc:
      typeof input.expectedPriceUsdc === "number" ? round(input.expectedPriceUsdc) : undefined,
    slippageUsdcPerShare:
      typeof input.slippageUsdcPerShare === "number"
        ? round(input.slippageUsdcPerShare)
        : undefined,
    quotePostedAtMs:
      typeof input.quotePostedAtMs === "number" ? Math.round(input.quotePostedAtMs) : undefined,
    quoteAgeMs:
      typeof input.quoteAgeMs === "number" ? Math.round(input.quoteAgeMs) : undefined,
    quoteMaxRestingAgeMs:
      typeof input.quoteMaxRestingAgeMs === "number"
        ? Math.round(input.quoteMaxRestingAgeMs)
        : undefined,
    orderType: input.orderType,
    realizedPnlUsdc:
      typeof input.realizedPnlUsdc === "number" ? round(input.realizedPnlUsdc) : undefined
  }
});

export const buildQuotePostedAlert = (input: {
  runtime: string;
  strategy: string;
  market: string;
  outcome: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  occurredAtMs: number;
  orderId?: string;
  quoteSlot?: string;
  orderType?: string;
  executionStyle?: string;
  postOnly?: boolean;
  maxRestingAgeMs?: number;
  tags?: string[];
}): AlertEvent => ({
  schemaVersion: 1,
  category: "quote_posted",
  severity: "info",
  title: `${input.side} 주문 게시`,
  summary: `${input.market} · ${input.outcome} · ${input.side} ${round(input.size)}주 @ ${round(input.price)}${input.postOnly ? " · maker" : ""}`,
  occurredAtMs: input.occurredAtMs,
  runtime: input.runtime,
  tags: [
    input.strategy,
    "quote-posted",
    input.side.toLowerCase(),
    ...(input.postOnly ? ["maker-quote"] : ["aggressive-quote"]),
    ...(input.tags ?? [])
  ],
  details: {
    strategy: input.strategy,
    market: input.market,
    outcome: input.outcome,
    side: input.side,
    size: round(input.size),
    price: round(input.price),
    orderId: input.orderId,
    quoteSlot: input.quoteSlot,
    orderType: input.orderType,
    executionStyle: input.executionStyle,
    postOnly: input.postOnly,
    maxRestingAgeMs:
      typeof input.maxRestingAgeMs === "number" ? Math.round(input.maxRestingAgeMs) : undefined
  }
});

export const buildQuotePostRejectedAlert = (input: {
  runtime: string;
  strategy: string;
  market: string;
  outcome: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  error?: string;
  occurredAtMs: number;
  nextRetryAfterMs?: number;
}): AlertEvent => ({
  schemaVersion: 1,
  category: "quote_post_rejected",
  severity: "warning",
  title: "주문 거절 / 재시도 대기",
  summary: `${input.market} · ${input.outcome} · ${input.side} ${round(input.size)}주 @ ${round(input.price)}${input.error ? ` · ${input.error}` : ""}`,
  occurredAtMs: input.occurredAtMs,
  runtime: input.runtime,
  tags: [input.strategy, "quote-rejected", input.side.toLowerCase()],
  details: {
    strategy: input.strategy,
    market: input.market,
    outcome: input.outcome,
    side: input.side,
    size: round(input.size),
    price: round(input.price),
    error: input.error,
    nextRetryAfterMs: input.nextRetryAfterMs
  }
});

export const buildTimeBasedUnwindAlert = (input: {
  runtime: string;
  market: string;
  outcome: string;
  tokenId: string;
  shares: number;
  holdDurationMs: number;
  mode: "age-based-unwind" | "hard-exit";
  occurredAtMs: number;
}): AlertEvent => ({
  schemaVersion: 1,
  category: "time_based_unwind",
  severity: input.mode === "hard-exit" ? "warning" : "info",
  title: input.mode === "hard-exit" ? "강제 시간 청산 시작" : "시간기반 청산 시작",
  summary: `${input.market} · ${input.outcome} · ${round(input.shares)}주 · 보유 ${Math.round(input.holdDurationMs / 60_000)}분`,
  occurredAtMs: input.occurredAtMs,
  runtime: input.runtime,
  tags: ["time-unwind", input.mode],
  details: {
    market: input.market,
    outcome: input.outcome,
    tokenId: input.tokenId,
    shares: round(input.shares),
    holdDurationMs: input.holdDurationMs,
    holdDurationMinutes: Math.round(input.holdDurationMs / 60_000),
    mode: input.mode
  }
});

export type TopInventoryPosition = {
  market: string;
  outcome: string;
  shares: number;
  costUsdc: number;
  unrealizedPnlUsdc?: number;
};

export const buildOperatorStatusAlert = (input: {
  runtime: string;
  checkpoint: RuntimeCheckpointSummary;
  cashBalanceUsdc?: number;
  cashAllowanceUsdc?: number;
  cashBalanceMayBeStale?: boolean;
  openPositionValueUsdc?: number;
  openUnrealizedPnlUsdc?: number;
  pricedOpenTokenCount?: number;
  unpricedOpenTokenCount?: number;
  // 🔄 Local-vs-venue inventory drift, surfaced in the Korean operator alert
  // so the user can see immediately when the bot's lot tracker has diverged
  // from the on-chain holdings the Polymarket site shows.
  venueDriftTokenCount?: number;
  venueDriftAbsValueUsdc?: number;
  venueDriftSignedShares?: number;
  initialCapitalUsdc?: number;
  dailyRealizedPnlUsdc: number;
  dailyTradeCount?: number;
  lifetimeRealizedPnlUsdc?: number;
  marketMakingDailyPnlUsdc?: number;
  marketMakingLifetimePnlUsdc?: number;
  // 📌 #13 MM 전용 청산 품질 카운트 (일일 기준).
  marketMakingDailyWinCount?: number;
  marketMakingDailyLossCount?: number;
  marketMakingDailyFlatCount?: number;
  marketMakingLifetimeWinCount?: number;
  marketMakingLifetimeLossCount?: number;
  marketMakingLifetimeFlatCount?: number;
  // 📊 #14 세션 MM 품질 지표.
  marketMakingSessionBuyFills?: number;
  marketMakingSessionSellFills?: number;
  marketMakingSessionBuyToSellRatio?: number;
  marketMakingSessionAverageHoldMs?: number;
  sameMarketArbDailyPnlUsdc?: number;
  sameMarketArbLifetimePnlUsdc?: number;
  rewardIncomeUsdc?: number;
  rebateIncomeUsdc?: number;
  lifetimeRewardIncomeUsdc?: number;
  lifetimeRebateIncomeUsdc?: number;
  lifetimeTradeCount?: number;
  winningTradeCount?: number;
  losingTradeCount?: number;
  totalNetPnlUsdc?: number;
  /** Top inventory positions by cost, for at-a-glance status visibility. */
  topInventoryPositions?: TopInventoryPosition[];
  /** Bot operator startup timestamp in ms (used to compute uptime). */
  operatorStartedAtMs?: number;
}): AlertEvent => ({
  schemaVersion: 1,
  category: "operator_status",
  severity: "info",
  title: "운영 현황",
  summary: `risk=${input.checkpoint.riskState} · cash=$${round(input.cashBalanceUsdc ?? 0)} · openLots=${input.checkpoint.openLotCount} · activeOrders=${input.checkpoint.activeOrderCount} · dailyPnl=$${round(input.dailyRealizedPnlUsdc)}`,
  occurredAtMs: input.checkpoint.generatedAtMs,
  runtime: input.runtime,
  tags: ["operator-status", input.checkpoint.riskState.toLowerCase()],
  details: {
    reason: input.checkpoint.reason,
    riskState: input.checkpoint.riskState,
    cashBalanceUsdc:
      typeof input.cashBalanceUsdc === "number" ? round(input.cashBalanceUsdc) : undefined,
    cashAllowanceUsdc:
      typeof input.cashAllowanceUsdc === "number" ? round(input.cashAllowanceUsdc) : undefined,
    cashBalanceMayBeStale:
      input.cashBalanceMayBeStale === true ? true : undefined,
    openPositionValueUsdc:
      typeof input.openPositionValueUsdc === "number"
        ? round(input.openPositionValueUsdc)
        : undefined,
    openUnrealizedPnlUsdc:
      typeof input.openUnrealizedPnlUsdc === "number"
        ? round(input.openUnrealizedPnlUsdc)
        : undefined,
    pricedOpenTokenCount:
      typeof input.pricedOpenTokenCount === "number" ? input.pricedOpenTokenCount : undefined,
    unpricedOpenTokenCount:
      typeof input.unpricedOpenTokenCount === "number"
        ? input.unpricedOpenTokenCount
        : undefined,
    venueDriftTokenCount:
      typeof input.venueDriftTokenCount === "number" && input.venueDriftTokenCount > 0
        ? input.venueDriftTokenCount
        : undefined,
    venueDriftAbsValueUsdc:
      typeof input.venueDriftAbsValueUsdc === "number" && input.venueDriftAbsValueUsdc > 0
        ? round(input.venueDriftAbsValueUsdc)
        : undefined,
    venueDriftSignedShares:
      typeof input.venueDriftSignedShares === "number" && input.venueDriftSignedShares !== 0
        ? round(input.venueDriftSignedShares)
        : undefined,
    initialCapitalUsdc:
      typeof input.initialCapitalUsdc === "number" ? round(input.initialCapitalUsdc) : undefined,
    activeOrderCount: input.checkpoint.activeOrderCount,
    activeConditionCount: input.checkpoint.activeConditionCount,
    openLotCount: input.checkpoint.openLotCount,
    openShares: round(input.checkpoint.openShares),
    openCostUsdc: round(input.checkpoint.openCostUsdc),
    dailyRealizedPnlUsdc: round(input.dailyRealizedPnlUsdc),
    dailyTradeCount:
      typeof input.dailyTradeCount === "number" ? input.dailyTradeCount : undefined,
    lifetimeRealizedPnlUsdc:
      typeof input.lifetimeRealizedPnlUsdc === "number"
        ? round(input.lifetimeRealizedPnlUsdc)
        : undefined,
    marketMakingDailyPnlUsdc:
      typeof input.marketMakingDailyPnlUsdc === "number"
        ? round(input.marketMakingDailyPnlUsdc)
        : undefined,
    marketMakingLifetimePnlUsdc:
      typeof input.marketMakingLifetimePnlUsdc === "number"
        ? round(input.marketMakingLifetimePnlUsdc)
        : undefined,
    marketMakingDailyWinCount:
      typeof input.marketMakingDailyWinCount === "number" ? input.marketMakingDailyWinCount : undefined,
    marketMakingDailyLossCount:
      typeof input.marketMakingDailyLossCount === "number" ? input.marketMakingDailyLossCount : undefined,
    marketMakingDailyFlatCount:
      typeof input.marketMakingDailyFlatCount === "number" ? input.marketMakingDailyFlatCount : undefined,
    marketMakingLifetimeWinCount:
      typeof input.marketMakingLifetimeWinCount === "number"
        ? input.marketMakingLifetimeWinCount
        : undefined,
    marketMakingLifetimeLossCount:
      typeof input.marketMakingLifetimeLossCount === "number"
        ? input.marketMakingLifetimeLossCount
        : undefined,
    marketMakingLifetimeFlatCount:
      typeof input.marketMakingLifetimeFlatCount === "number"
        ? input.marketMakingLifetimeFlatCount
        : undefined,
    marketMakingSessionBuyFills:
      typeof input.marketMakingSessionBuyFills === "number"
        ? input.marketMakingSessionBuyFills
        : undefined,
    marketMakingSessionSellFills:
      typeof input.marketMakingSessionSellFills === "number"
        ? input.marketMakingSessionSellFills
        : undefined,
    marketMakingSessionBuyToSellRatio:
      typeof input.marketMakingSessionBuyToSellRatio === "number"
        ? Number(input.marketMakingSessionBuyToSellRatio.toFixed(4))
        : undefined,
    marketMakingSessionAverageHoldMs:
      typeof input.marketMakingSessionAverageHoldMs === "number"
        ? Math.round(input.marketMakingSessionAverageHoldMs)
        : undefined,
    sameMarketArbDailyPnlUsdc:
      typeof input.sameMarketArbDailyPnlUsdc === "number"
        ? round(input.sameMarketArbDailyPnlUsdc)
        : undefined,
    sameMarketArbLifetimePnlUsdc:
      typeof input.sameMarketArbLifetimePnlUsdc === "number"
        ? round(input.sameMarketArbLifetimePnlUsdc)
        : undefined,
    rewardIncomeUsdc:
      typeof input.rewardIncomeUsdc === "number" ? round(input.rewardIncomeUsdc) : undefined,
    rebateIncomeUsdc:
      typeof input.rebateIncomeUsdc === "number" ? round(input.rebateIncomeUsdc) : undefined,
    lifetimeRewardIncomeUsdc:
      typeof input.lifetimeRewardIncomeUsdc === "number"
        ? round(input.lifetimeRewardIncomeUsdc)
        : undefined,
    lifetimeRebateIncomeUsdc:
      typeof input.lifetimeRebateIncomeUsdc === "number"
        ? round(input.lifetimeRebateIncomeUsdc)
        : undefined,
    lifetimeTradeCount:
      typeof input.lifetimeTradeCount === "number" ? input.lifetimeTradeCount : undefined,
    winningTradeCount:
      typeof input.winningTradeCount === "number" ? input.winningTradeCount : undefined,
    losingTradeCount:
      typeof input.losingTradeCount === "number" ? input.losingTradeCount : undefined,
    totalNetPnlUsdc:
      typeof input.totalNetPnlUsdc === "number" ? round(input.totalNetPnlUsdc) : undefined,
    topInventoryPositions: input.topInventoryPositions?.map((pos) => ({
      market: pos.market,
      outcome: pos.outcome,
      shares: round(pos.shares),
      costUsdc: round(pos.costUsdc),
      unrealizedPnlUsdc:
        typeof pos.unrealizedPnlUsdc === "number" ? round(pos.unrealizedPnlUsdc) : undefined
    })),
    operatorStartedAtMs:
      typeof input.operatorStartedAtMs === "number" ? input.operatorStartedAtMs : undefined
  }
});
