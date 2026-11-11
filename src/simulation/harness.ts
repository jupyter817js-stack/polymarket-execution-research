import { readFileSync } from "node:fs";

import { z } from "zod";

import { ExecutionEngine } from "../core/execution-engine.js";
import { buildMarketMakingIntents } from "../core/market-making-intents.js";
import { buildNegativeRiskIntents } from "../core/negative-risk-intents.js";
import { deriveExecutionNetPnlBreakdown } from "../core/net-pnl.js";
import { PnLEngine } from "../core/pnl-engine.js";
import { PositionManager } from "../core/position-manager.js";
import { RiskManager, type RiskThresholdConfig } from "../core/risk-manager.js";
import { buildSameMarketArbIntents } from "../core/same-market-arb-intents.js";
import { StrategyCoordinator } from "../core/strategy-coordinator.js";
import type {
  ActiveOrderState,
  CoordinationResult,
  OrderIntent,
  PortfolioPnlSnapshot,
  RejectedIntentReason,
  RiskState,
  StrategyName
} from "../core/types.js";
import {
  assessNegativeRiskPaperFillConfidence,
  assessSameMarketPaperFillConfidence,
  type PaperFillConfidence
} from "../paper-trading/fill-confidence.js";
import { buildNegativeRiskGroups, evaluateNegativeRiskOpportunity } from "../strategy/negative-risk.js";
import { inspectSameMarketEvaluation } from "../strategy/arb.js";
import { evaluateMarketMakerPlan } from "../strategy/market-maker.js";
import { OrderBookStore } from "../polymarket/orderbook-store.js";
import type { BinaryMarket, BookSnapshotEvent, NormalizedOrderBook } from "../types.js";

export type SimulationStrategy = "market-making" | "same-market-arb" | "negative-risk";

export type SimulationBookLevelInput = {
  price: number;
  size: number;
};

export type SimulationBookSnapshotInput = {
  tokenId: string;
  bids: SimulationBookLevelInput[];
  asks: SimulationBookLevelInput[];
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  lastTradePrice?: number;
  updatedAtMs?: number;
};

export type SimulationRiskEventInput =
  | {
      type: "trade_closed";
      realizedPnlUsdc: number;
      source?: string;
      detail?: string;
    }
  | {
      type: "api_error" | "order_failure" | "state_mismatch";
      source?: string;
      detail?: string;
    };

export type SimulationExecutionProfileInput = {
  fillRatio?: number;
  latencyMs?: number;
  reason?: string;
};

export type SimulationExecutionTradeOverrideInput = SimulationExecutionProfileInput & {
  tradeId?: string;
  strategy?: SimulationStrategy;
  marketScope?: string;
  conditionId?: string;
};

export type SimulationExecutionModelInput = SimulationExecutionProfileInput & {
  defaultFillRatio?: number;
  defaultLatencyMs?: number;
  byStrategy?: Partial<Record<SimulationStrategy, SimulationExecutionProfileInput>>;
  tradeOverrides?: SimulationExecutionTradeOverrideInput[];
};

export type SimulationStep = {
  id?: string;
  atMs: number;
  notes?: string;
  bookSnapshots?: SimulationBookSnapshotInput[];
  evaluate?: SimulationStrategy[];
  riskEvents?: SimulationRiskEventInput[];
  execution?: SimulationExecutionModelInput;
};

export type SimulationScenario = {
  name: string;
  description?: string;
  markets: BinaryMarket[];
  initialBooks?: SimulationBookSnapshotInput[];
  steps: SimulationStep[];
  feeRatesByTokenId: Readonly<Record<string, number>>;
  riskThresholds?: Partial<RiskThresholdConfig>;
  execution?: SimulationExecutionModelInput;
};

export type SimulationRiskEventResult = {
  type: SimulationRiskEventInput["type"];
  source: string;
  state: RiskState;
  reason?: string;
  detail?: string;
};

export type SimulationStrategyStepSummary = {
  strategy: SimulationStrategy;
  evaluatedTargets: number;
  opportunityCount: number;
  unsupportedOpportunityCount: number;
  generatedIntentCount: number;
  rejectedTargetCount: number;
  rejectionReasons: Record<string, number>;
  detectedOpportunityKinds: string[];
};

type SimulationTradeCandidate = {
  id: string;
  strategy: StrategyName;
  intentIds: string[];
  marketScope: string;
  conditionId?: string;
  shares?: number;
  grossRealizedPnlUsdc: number;
  feeCostUsdc: number;
  expectedGrossEdgeUsdc?: number;
  depthCoverageRatio?: number;
  fillConfidence?: PaperFillConfidence;
  detail: string;
  tags: string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
};

export type SimulationTradeResult = {
  id: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  status: "filled" | "partial_filled";
  expectedRealizedPnlUsdc: number;
  expectedGrossEdgeUsdc: number;
  realizedPnlUsdc: number;
  grossRealizedPnlUsdc: number;
  feeCostUsdc: number;
  simulatedFillLatencyMs?: number;
  simulatedFillRatio?: number;
  filledShares?: number;
  missedExpectedRealizedPnlUsdc?: number;
  depthCoverageRatio?: number;
  fillConfidence?: PaperFillConfidence;
  shares?: number;
  reason?: string;
  tags: string[];
};

export type SimulationPaperTradeRecord = {
  id: string;
  strategy: StrategyName;
  marketScope: string;
  conditionId?: string;
  status: "filled" | "partial_filled" | "not_filled";
  expectedRealizedPnlUsdc: number;
  expectedGrossEdgeUsdc: number;
  realizedPnlUsdc?: number;
  grossRealizedPnlUsdc?: number;
  feeCostUsdc: number;
  simulatedFillLatencyMs?: number;
  simulatedFillRatio?: number;
  filledShares?: number;
  missedExpectedRealizedPnlUsdc?: number;
  depthCoverageRatio?: number;
  fillConfidence?: PaperFillConfidence;
  shares?: number;
  reason?: string;
  tags: string[];
};

export type SimulationStepReport = {
  id: string;
  atMs: number;
  notes?: string;
  evaluatedStrategies: SimulationStrategy[];
  riskState: RiskState;
  riskEventsApplied: SimulationRiskEventResult[];
  generatedIntentCount: number;
  approvedIntentCount: number;
  rejectedIntentCount: number;
  acceptedActions: {
    create: number;
    replace: number;
    keep: number;
  };
  coordinatorRejections: Record<RejectedIntentReason, number>;
  strategySummaries: SimulationStrategyStepSummary[];
  simulatedTradeCount: number;
  simulatedRealizedPnlUsdc: number;
  simulatedGrossRealizedPnlUsdc: number;
  simulatedTrades: SimulationTradeResult[];
  paperTrades: SimulationPaperTradeRecord[];
  portfolio: {
    dailyRealizedPnlUsdc: number;
    dailyTradeCount: number;
    lifetimeRealizedPnlUsdc: number;
    lifetimeTradeCount: number;
  };
  activeOrderCount: number;
};

export type SimulationStrategyTotals = SimulationStrategyStepSummary;

export type SimulationReport = {
  scenarioName: string;
  description?: string;
  stepCount: number;
  finalRiskState: RiskState;
  finalActiveOrderCount: number;
  totalGeneratedIntentCount: number;
  totalApprovedIntentCount: number;
  totalRejectedIntentCount: number;
  totalSimulatedTradeCount: number;
  totalSimulatedRealizedPnlUsdc: number;
  totalPaperTradeCount: number;
  finalPortfolio: {
    dailyRealizedPnlUsdc: number;
    dailyTradeCount: number;
    lifetimeRealizedPnlUsdc: number;
    lifetimeTradeCount: number;
  };
  strategyTotals: SimulationStrategyTotals[];
  steps: SimulationStepReport[];
};

const simulationStrategySchema = z.enum(["market-making", "same-market-arb", "negative-risk"]);
const levelSchema = z.object({
  price: z.coerce.number().nonnegative(),
  size: z.coerce.number().nonnegative()
});
const bookSnapshotSchema = z.object({
  tokenId: z.string().min(1),
  bids: z.array(levelSchema),
  asks: z.array(levelSchema),
  tickSize: z.coerce.number().positive().optional(),
  minOrderSize: z.coerce.number().positive().optional(),
  negRisk: z.boolean().optional(),
  lastTradePrice: z.coerce.number().nonnegative().optional(),
  updatedAtMs: z.coerce.number().int().positive().optional()
});
const riskEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("trade_closed"),
    realizedPnlUsdc: z.coerce.number(),
    source: z.string().min(1).optional(),
    detail: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("api_error"),
    source: z.string().min(1).optional(),
    detail: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("order_failure"),
    source: z.string().min(1).optional(),
    detail: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("state_mismatch"),
    source: z.string().min(1).optional(),
    detail: z.string().min(1).optional()
  })
]);
const executionProfileSchema = z.object({
  fillRatio: z.coerce.number().min(0).max(1).optional(),
  latencyMs: z.coerce.number().int().nonnegative().optional(),
  reason: z.string().min(1).optional()
});
const executionTradeOverrideSchema = executionProfileSchema.extend({
  tradeId: z.string().min(1).optional(),
  strategy: simulationStrategySchema.optional(),
  marketScope: z.string().min(1).optional(),
  conditionId: z.string().min(1).optional()
});
const executionModelSchema = executionProfileSchema.extend({
  defaultFillRatio: z.coerce.number().min(0).max(1).optional(),
  defaultLatencyMs: z.coerce.number().int().nonnegative().optional(),
  byStrategy: z.record(simulationStrategySchema, executionProfileSchema).optional(),
  tradeOverrides: z.array(executionTradeOverrideSchema).optional()
});
const stepSchema = z.object({
  id: z.string().min(1).optional(),
  atMs: z.coerce.number().int().positive(),
  notes: z.string().min(1).optional(),
  bookSnapshots: z.array(bookSnapshotSchema).optional(),
  evaluate: z.array(simulationStrategySchema).optional(),
  riskEvents: z.array(riskEventSchema).optional(),
  execution: executionModelSchema.optional()
});
const marketSchema = z.object({
  id: z.string().min(1),
  conditionId: z.string().min(1),
  questionId: z.string().min(1).optional(),
  question: z.string().min(1),
  slug: z.string().min(1),
  eventId: z.string().min(1).optional(),
  eventSlug: z.string().min(1).optional(),
  eventTitle: z.string().min(1).optional(),
  groupItemTitle: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  liquidity: z.coerce.number().nonnegative().optional(),
  outcomes: z.tuple([z.string().min(1), z.string().min(1)]),
  tokenIds: z.tuple([z.string().min(1), z.string().min(1)]),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  enableOrderBook: z.boolean().optional(),
  orderMinSize: z.coerce.number().positive().optional(),
  orderPriceMinTickSize: z.coerce.number().positive().optional(),
  endDate: z.string().min(1).optional(),
  gameStartTime: z.string().min(1).optional(),
  feesEnabled: z.boolean().optional(),
  feeType: z.string().min(1).optional(),
  negRisk: z.boolean().optional(),
  enableNegRisk: z.boolean().optional(),
  cumulativeMarkets: z.boolean().optional(),
  showAllOutcomes: z.boolean().optional(),
  rewardsMaxSpread: z.coerce.number().positive().optional(),
  rewardsMinSize: z.coerce.number().positive().optional(),
  rewardRatePerDay: z.coerce.number().nonnegative().optional()
});
const scenarioSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  markets: z.array(marketSchema).min(1),
  initialBooks: z.array(bookSnapshotSchema).optional(),
  steps: z.array(stepSchema).min(1),
  feeRatesByTokenId: z.record(z.string(), z.coerce.number().nonnegative()).optional(),
  execution: executionModelSchema.optional(),
  riskThresholds: z
    .object({
      maxDailyLossUsdc: z.coerce.number().positive().optional(),
      degradeDailyLossRatio: z.coerce.number().min(0).max(1).optional(),
      maxConsecutiveLosses: z.coerce.number().int().positive().optional(),
      degradeConsecutiveLosses: z.coerce.number().int().nonnegative().optional(),
      maxApiErrors: z.coerce.number().int().positive().optional(),
      degradeApiErrors: z.coerce.number().int().nonnegative().optional(),
      maxOrderFailures: z.coerce.number().int().positive().optional(),
      degradeOrderFailures: z.coerce.number().int().nonnegative().optional(),
      maxStateMismatches: z.coerce.number().int().positive().optional(),
      degradeStateMismatches: z.coerce.number().int().nonnegative().optional(),
      blockNewBuyIntentsOnDegraded: z.boolean().optional(),
      cancelMmBuyQuotesOnDegraded: z.boolean().optional(),
      enableMmInventoryReductionOnHalt: z.boolean().optional(),
      resetSessionOnNewDay: z.boolean().optional()
    })
    .optional()
});

const zeroCoordinatorRejections = (): Record<RejectedIntentReason, number> => ({
  duplicate_intent: 0,
  higher_priority_active_order: 0,
  active_order_already_matches: 0,
  condition_preempted_by_higher_priority_strategy: 0,
  risk_blocked: 0,
  position_blocked: 0
});

const zeroStrategySummary = (strategy: SimulationStrategy): SimulationStrategyStepSummary => ({
  strategy,
  evaluatedTargets: 0,
  opportunityCount: 0,
  unsupportedOpportunityCount: 0,
  generatedIntentCount: 0,
  rejectedTargetCount: 0,
  rejectionReasons: {},
  detectedOpportunityKinds: []
});

const incrementCount = (bucket: Record<string, number>, key: string): void => {
  bucket[key] = (bucket[key] ?? 0) + 1;
};

const normalizeMarket = (raw: z.infer<typeof marketSchema>): BinaryMarket => ({
  id: raw.id,
  conditionId: raw.conditionId,
  questionId: raw.questionId ?? `simulation-question-${raw.conditionId}`,
  question: raw.question,
  slug: raw.slug,
  eventId: raw.eventId,
  eventSlug: raw.eventSlug,
  eventTitle: raw.eventTitle,
  groupItemTitle: raw.groupItemTitle,
  category: raw.category,
  liquidity: raw.liquidity,
  outcomes: raw.outcomes,
  tokenIds: raw.tokenIds,
  active: raw.active ?? true,
  closed: raw.closed ?? false,
  acceptingOrders: raw.acceptingOrders ?? true,
  enableOrderBook: raw.enableOrderBook ?? true,
  orderMinSize: raw.orderMinSize ?? 1,
  orderPriceMinTickSize: raw.orderPriceMinTickSize ?? 0.01,
  endDate: raw.endDate,
  gameStartTime: raw.gameStartTime,
  feesEnabled: raw.feesEnabled ?? false,
  feeType: raw.feeType,
  negRisk: raw.negRisk ?? false,
  enableNegRisk: raw.enableNegRisk,
  cumulativeMarkets: raw.cumulativeMarkets,
  showAllOutcomes: raw.showAllOutcomes,
  rewardsMaxSpread: raw.rewardsMaxSpread,
  rewardsMinSize: raw.rewardsMinSize,
  rewardRatePerDay: raw.rewardRatePerDay
});

const withPatchedDateNow = <T>(nowMs: number, fn: () => T): T => {
  const originalDateNow = Date.now;
  Date.now = () => nowMs;

  try {
    return fn();
  } finally {
    Date.now = originalDateNow;
  }
};

const toBookSnapshotEvent = (
  snapshot: SimulationBookSnapshotInput,
  tokenToMarket: ReadonlyMap<string, BinaryMarket>,
  fallbackTimestampMs: number
): BookSnapshotEvent => {
  const market = tokenToMarket.get(snapshot.tokenId);

  if (!market) {
    throw new Error(`Simulation snapshot referenced unknown tokenId: ${snapshot.tokenId}`);
  }

  return {
    asset_id: snapshot.tokenId,
    market: market.conditionId,
    bids: snapshot.bids.map((level) => ({
      price: String(level.price),
      size: String(level.size)
    })),
    asks: snapshot.asks.map((level) => ({
      price: String(level.price),
      size: String(level.size)
    })),
    timestamp: String(snapshot.updatedAtMs ?? fallbackTimestampMs),
    tick_size: String(snapshot.tickSize ?? market.orderPriceMinTickSize),
    min_order_size: String(snapshot.minOrderSize ?? market.orderMinSize),
    neg_risk: snapshot.negRisk ?? market.negRisk,
    last_trade_price:
      typeof snapshot.lastTradePrice === "number" ? String(snapshot.lastTradePrice) : undefined
  };
};

const toActiveOrderState = (
  intent: OrderIntent,
  orderId: string,
  openedAtMs: number
): ActiveOrderState => ({
  orderId,
  strategy: intent.strategy,
  priority: intent.priority,
  conditionId: intent.conditionId,
  tokenId: intent.tokenId,
  side: intent.side,
  price: intent.price,
  size: intent.size,
  tif: intent.tif,
  postOnly: intent.postOnly,
  openedAtMs,
  intentId: intent.id
});

const updateReferencePrices = (
  positionManager: PositionManager,
  tokenToMarket: ReadonlyMap<string, BinaryMarket>,
  orderBookStore: OrderBookStore
): void => {
  for (const tokenId of tokenToMarket.keys()) {
    const book = orderBookStore.get(tokenId);

    if (!book) {
      continue;
    }

    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;
    const referencePrice =
      typeof bestBid === "number" && typeof bestAsk === "number"
        ? (bestBid + bestAsk) / 2
        : book.lastTradePrice ?? bestAsk ?? bestBid ?? 0.5;

    positionManager.updateReferencePrice(tokenId, referencePrice);
  }
};

const buildBooksByTokenId = (
  tokenToMarket: ReadonlyMap<string, BinaryMarket>,
  orderBookStore: OrderBookStore
): Map<string, NormalizedOrderBook> => {
  const booksByTokenId = new Map<string, NormalizedOrderBook>();

  for (const tokenId of tokenToMarket.keys()) {
    const book = orderBookStore.get(tokenId);

    if (book) {
      booksByTokenId.set(tokenId, book);
    }
  }

  return booksByTokenId;
};

const applyAcceptedPlan = (
  coordinationResult: CoordinationResult,
  executionEngine: ExecutionEngine,
  stepId: string,
  atMs: number
): {
  acceptedActions: { create: number; replace: number; keep: number };
  orderIdByIntentId: Map<string, string>;
} => {
  const acceptedActions = {
    create: 0,
    replace: 0,
    keep: 0
  };
  const orderIdByIntentId = new Map<string, string>();

  for (const [index, planItem] of coordinationResult.executionPlan.accepted.entries()) {
    acceptedActions[planItem.action] += 1;

    if (planItem.orderToCancel) {
      executionEngine.releaseActiveOrder(planItem.orderToCancel.orderId);
    }

    const orderId = `sim:${stepId}:${index}:${planItem.intent.id}`;
    executionEngine.upsertActiveOrder(toActiveOrderState(planItem.intent, orderId, atMs));
    orderIdByIntentId.set(planItem.intent.id, orderId);
  }

  return {
    acceptedActions,
    orderIdByIntentId
  };
};

const evaluateMarketMaking = (
  markets: readonly BinaryMarket[],
  orderBookStore: OrderBookStore
): {
  intents: OrderIntent[];
  summary: SimulationStrategyStepSummary;
  tradeCandidates: SimulationTradeCandidate[];
} => {
  const summary = zeroStrategySummary("market-making");
  const intents: OrderIntent[] = [];

  for (const market of markets) {
    const bookA = orderBookStore.get(market.tokenIds[0]);
    const bookB = orderBookStore.get(market.tokenIds[1]);
    summary.evaluatedTargets += 1;

    if (!bookA || !bookB) {
      summary.rejectedTargetCount += 1;
      incrementCount(summary.rejectionReasons, "missing_orderbook");
      continue;
    }

    const evaluation = evaluateMarketMakerPlan(market, bookA, bookB);

    if (evaluation.status === "rejected") {
      summary.rejectedTargetCount += 1;
      incrementCount(summary.rejectionReasons, evaluation.reason);
      continue;
    }

    summary.opportunityCount += 1;
    const builtIntents = buildMarketMakingIntents(evaluation.plan);
    summary.generatedIntentCount += builtIntents.length;
    intents.push(...builtIntents);
  }

  return {
    intents,
    summary,
    tradeCandidates: []
  };
};

const evaluateSameMarketArb = (
  markets: readonly BinaryMarket[],
  orderBookStore: OrderBookStore,
  feeRatesByTokenId: Readonly<Record<string, number>>
): {
  intents: OrderIntent[];
  summary: SimulationStrategyStepSummary;
  tradeCandidates: SimulationTradeCandidate[];
} => {
  const summary = zeroStrategySummary("same-market-arb");
  const intents: OrderIntent[] = [];
  const tradeCandidates: SimulationTradeCandidate[] = [];

  for (const market of markets) {
    const bookA = orderBookStore.get(market.tokenIds[0]);
    const bookB = orderBookStore.get(market.tokenIds[1]);
    summary.evaluatedTargets += 1;

    if (!bookA || !bookB) {
      summary.rejectedTargetCount += 1;
      incrementCount(summary.rejectionReasons, "missing_orderbook");
      continue;
    }

    const evaluation = inspectSameMarketEvaluation(
      market,
      bookA,
      bookB,
      feeRatesByTokenId[market.tokenIds[0]] ?? 0,
      feeRatesByTokenId[market.tokenIds[1]] ?? 0
    );

    if (evaluation.status === "rejected") {
      summary.rejectedTargetCount += 1;
      incrementCount(summary.rejectionReasons, evaluation.reason);
      continue;
    }

    summary.opportunityCount += 1;
    const builtIntents = buildSameMarketArbIntents(evaluation.opportunity);
    const fillAssessment = assessSameMarketPaperFillConfidence(
      evaluation.opportunity,
      new Map([
        [market.tokenIds[0], bookA],
        [market.tokenIds[1], bookB]
      ])
    );
    summary.generatedIntentCount += builtIntents.length;
    intents.push(...builtIntents);
    tradeCandidates.push({
      id: `sim-trade:same-market-arb:${market.conditionId}:${evaluation.opportunity.detectedAtMs}`,
      strategy: "same-market-arb",
      intentIds: builtIntents.map((intent) => intent.id),
      marketScope: market.slug,
      conditionId: market.conditionId,
      shares: evaluation.opportunity.shares,
      grossRealizedPnlUsdc: evaluation.opportunity.grossEdge,
      feeCostUsdc: evaluation.opportunity.feeCost,
      expectedGrossEdgeUsdc: evaluation.opportunity.grossEdge,
      depthCoverageRatio: fillAssessment.depthCoverageRatio,
      fillConfidence: fillAssessment.fillConfidence,
      detail: "simulated same-market arbitrage locked-in settlement",
      tags: ["simulation", "same-market-arb", "locked-in"],
      metadata: {
        marketSlug: market.slug,
        netEdge: Number(evaluation.opportunity.netEdge.toFixed(8))
      }
    });
  }

  return {
    intents,
    summary,
    tradeCandidates
  };
};

const evaluateNegativeRisk = (
  markets: readonly BinaryMarket[],
  orderBookStore: OrderBookStore,
  feeRatesByTokenId: Readonly<Record<string, number>>
): {
  intents: OrderIntent[];
  summary: SimulationStrategyStepSummary;
  tradeCandidates: SimulationTradeCandidate[];
} => {
  const summary = zeroStrategySummary("negative-risk");
  const intents: OrderIntent[] = [];
  const tradeCandidates: SimulationTradeCandidate[] = [];
  const booksByTokenId = buildBooksByTokenId(
    new Map(markets.flatMap((market) => market.tokenIds.map((tokenId) => [tokenId, market] as const))),
    orderBookStore
  );
  const groups = buildNegativeRiskGroups(markets);

  for (const group of groups) {
    summary.evaluatedTargets += 1;
    const evaluation = evaluateNegativeRiskOpportunity(
      group,
      booksByTokenId,
      new Map(Object.entries(feeRatesByTokenId))
    );

    if (evaluation.status === "rejected") {
      summary.rejectedTargetCount += 1;
      incrementCount(summary.rejectionReasons, evaluation.reason);
      continue;
    }

    summary.opportunityCount += 1;
    summary.detectedOpportunityKinds.push(evaluation.opportunity.kind);

    if (evaluation.opportunity.kind !== "yes-basket") {
      summary.unsupportedOpportunityCount += 1;
      continue;
    }

    const builtIntents = buildNegativeRiskIntents(evaluation.opportunity);
    const fillAssessment = assessNegativeRiskPaperFillConfidence(
      evaluation.opportunity,
      booksByTokenId
    );
    summary.generatedIntentCount += builtIntents.length;
    intents.push(...builtIntents);
    tradeCandidates.push({
      id: `sim-trade:negative-risk:${group.eventId}:${evaluation.opportunity.detectedAtMs}`,
      strategy: "negative-risk",
      intentIds: builtIntents.map((intent) => intent.id),
      marketScope: group.eventSlug,
      shares: evaluation.opportunity.shares,
      grossRealizedPnlUsdc: evaluation.opportunity.grossEdge,
      feeCostUsdc: evaluation.opportunity.feeCost,
      expectedGrossEdgeUsdc: evaluation.opportunity.grossEdge,
      depthCoverageRatio: fillAssessment.depthCoverageRatio,
      fillConfidence: fillAssessment.fillConfidence,
      detail: "simulated negative-risk yes-basket locked-in settlement",
      tags: ["simulation", "negative-risk", "yes-basket", "locked-in"],
      metadata: {
        eventId: group.eventId,
        eventSlug: group.eventSlug,
        conditionIds: evaluation.opportunity.legs.map((leg) => leg.market.conditionId).join(","),
        netEdge: Number(evaluation.opportunity.netEdge.toFixed(8))
      }
    });
  }

  return {
    intents,
    summary,
    tradeCandidates
  };
};

const applyRiskEvents = (
  riskManager: RiskManager,
  riskEvents: readonly SimulationRiskEventInput[] | undefined
): SimulationRiskEventResult[] => {
  if (!riskEvents || riskEvents.length === 0) {
    return [];
  }

  return riskEvents.map((event, index) => {
    const source = event.source ?? `simulation-risk-event-${index + 1}`;
    const decision =
      event.type === "trade_closed"
        ? riskManager.noteTradeClosed(event.realizedPnlUsdc, source, event.detail)
        : event.type === "api_error"
          ? riskManager.noteApiError(source, event.detail)
          : event.type === "order_failure"
            ? riskManager.noteOrderFailure(source, event.detail)
            : riskManager.noteStateMismatch(source, event.detail);

    return {
      type: event.type,
      source,
      state: decision.state,
      reason: decision.reason,
      detail: decision.detail
    };
  });
};

const aggregateStrategyTotals = (
  totals: Map<SimulationStrategy, SimulationStrategyTotals>,
  stepSummaries: readonly SimulationStrategyStepSummary[]
): void => {
  for (const summary of stepSummaries) {
    const current = totals.get(summary.strategy) ?? zeroStrategySummary(summary.strategy);

    current.evaluatedTargets += summary.evaluatedTargets;
    current.opportunityCount += summary.opportunityCount;
    current.unsupportedOpportunityCount += summary.unsupportedOpportunityCount;
    current.generatedIntentCount += summary.generatedIntentCount;
    current.rejectedTargetCount += summary.rejectedTargetCount;

    for (const [reason, count] of Object.entries(summary.rejectionReasons)) {
      current.rejectionReasons[reason] = (current.rejectionReasons[reason] ?? 0) + count;
    }

    current.detectedOpportunityKinds = [
      ...new Set([...current.detectedOpportunityKinds, ...summary.detectedOpportunityKinds])
    ];
    totals.set(summary.strategy, current);
  }
};

const buildCoordinatorRejections = (
  rejected: readonly { reason: RejectedIntentReason }[]
): Record<RejectedIntentReason, number> => {
  const counts = zeroCoordinatorRejections();

  for (const rejection of rejected) {
    counts[rejection.reason] += 1;
  }

  return counts;
};

const buildPortfolioSummary = (portfolio: PortfolioPnlSnapshot) => ({
  dailyRealizedPnlUsdc: Number(portfolio.dailyRealizedPnlUsdc.toFixed(8)),
  dailyTradeCount: portfolio.dailyTradeCount,
  lifetimeRealizedPnlUsdc: Number(portfolio.lifetimeRealizedPnlUsdc.toFixed(8)),
  lifetimeTradeCount: portfolio.lifetimeTradeCount
});

const roundSimulationNumber = (value: number): number => Number(value.toFixed(8));
const clampSimulationFillRatio = (value: number | undefined): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }

  return Math.max(0, Math.min(1, value));
};

const mergeExecutionModel = (
  base: SimulationExecutionModelInput | undefined,
  override: SimulationExecutionModelInput | undefined
): SimulationExecutionModelInput | undefined => {
  if (!base && !override) {
    return undefined;
  }

  const mergedByStrategy: Partial<Record<SimulationStrategy, SimulationExecutionProfileInput>> = {
    ...(base?.byStrategy ?? {})
  };

  for (const [strategy, profile] of Object.entries(override?.byStrategy ?? {})) {
    mergedByStrategy[strategy as SimulationStrategy] = {
      ...(mergedByStrategy[strategy as SimulationStrategy] ?? {}),
      ...profile
    };
  }

  return {
    fillRatio: override?.fillRatio ?? base?.fillRatio,
    latencyMs: override?.latencyMs ?? base?.latencyMs,
    defaultFillRatio: override?.defaultFillRatio ?? base?.defaultFillRatio,
    defaultLatencyMs: override?.defaultLatencyMs ?? base?.defaultLatencyMs,
    reason: override?.reason ?? base?.reason,
    byStrategy: Object.keys(mergedByStrategy).length > 0 ? mergedByStrategy : undefined,
    tradeOverrides: [...(base?.tradeOverrides ?? []), ...(override?.tradeOverrides ?? [])]
  };
};

const tradeOverrideMatches = (
  candidate: SimulationTradeCandidate,
  override: SimulationExecutionTradeOverrideInput
): boolean => {
  if (override.tradeId && override.tradeId !== candidate.id) {
    return false;
  }

  if (override.strategy && override.strategy !== candidate.strategy) {
    return false;
  }

  if (override.marketScope && override.marketScope !== candidate.marketScope) {
    return false;
  }

  if (override.conditionId && override.conditionId !== candidate.conditionId) {
    return false;
  }

  return true;
};

type SimulationTradeSettlement = {
  id: string;
  status: "filled" | "partial_filled" | "not_filled";
  simulatedFillRatio: number;
  simulatedFillLatencyMs: number;
  filledShares?: number;
  realizedPnlUsdc?: number;
  grossRealizedPnlUsdc?: number;
  feeCostUsdc?: number;
  missedExpectedRealizedPnlUsdc?: number;
  reason: string;
};

const resolveTradeSettlementProfile = (
  candidate: SimulationTradeCandidate,
  executionModel: SimulationExecutionModelInput | undefined
): {
  fillRatio: number;
  latencyMs: number;
  reason?: string;
} => {
  let fillRatio = clampSimulationFillRatio(
    executionModel?.defaultFillRatio ?? executionModel?.fillRatio
  );
  let latencyMs = executionModel?.defaultLatencyMs ?? executionModel?.latencyMs ?? 0;
  let reason = executionModel?.reason;

  const strategyProfile = executionModel?.byStrategy?.[candidate.strategy as SimulationStrategy];
  if (strategyProfile) {
    fillRatio = clampSimulationFillRatio(strategyProfile.fillRatio ?? fillRatio);
    latencyMs = strategyProfile.latencyMs ?? latencyMs;
    reason = strategyProfile.reason ?? reason;
  }

  for (const override of executionModel?.tradeOverrides ?? []) {
    if (!tradeOverrideMatches(candidate, override)) {
      continue;
    }

    fillRatio = clampSimulationFillRatio(override.fillRatio ?? fillRatio);
    latencyMs = override.latencyMs ?? latencyMs;
    reason = override.reason ?? reason;
  }

  return {
    fillRatio,
    latencyMs,
    reason
  };
};

const deriveExpectedSimulatedTradePnl = (candidate: SimulationTradeCandidate): {
  expectedRealizedPnlUsdc: number;
  expectedGrossEdgeUsdc: number;
} => {
  const expectedGrossEdgeUsdc = candidate.expectedGrossEdgeUsdc ?? candidate.grossRealizedPnlUsdc;
  const expectedNet = deriveExecutionNetPnlBreakdown({
    grossRealizedPnlUsdc: expectedGrossEdgeUsdc,
    expectedGrossEdgeUsdc,
    feeCostUsdc: candidate.feeCostUsdc,
    completion: "fully-filled"
  });

  return {
    expectedRealizedPnlUsdc: roundSimulationNumber(expectedNet.realizedPnlUsdc),
    expectedGrossEdgeUsdc: roundSimulationNumber(expectedGrossEdgeUsdc)
  };
};

const recordSimulatedTrades = (input: {
  candidates: readonly SimulationTradeCandidate[];
  approvedIntentIds: ReadonlySet<string>;
  atMs: number;
  pnlEngine: PnLEngine;
  riskManager: RiskManager;
  executionModel?: SimulationExecutionModelInput;
}): {
  settlements: SimulationTradeSettlement[];
  simulatedTrades: SimulationTradeResult[];
  simulatedTradeCount: number;
  simulatedRealizedPnlUsdc: number;
  simulatedGrossRealizedPnlUsdc: number;
} => {
  const settlements: SimulationTradeSettlement[] = [];
  const simulatedTrades: SimulationTradeResult[] = [];
  let simulatedRealizedPnlUsdc = 0;
  let simulatedGrossRealizedPnlUsdc = 0;

  for (const candidate of input.candidates) {
    if (!candidate.intentIds.every((intentId) => input.approvedIntentIds.has(intentId))) {
      continue;
    }

    const expected = deriveExpectedSimulatedTradePnl(candidate);
    const settlementProfile = resolveTradeSettlementProfile(candidate, input.executionModel);
    const filledShares =
      typeof candidate.shares === "number"
        ? roundSimulationNumber(candidate.shares * settlementProfile.fillRatio)
        : undefined;
    const missedExpectedRealizedPnlUsdc = roundSimulationNumber(
      expected.expectedRealizedPnlUsdc * (1 - settlementProfile.fillRatio)
    );

    if (settlementProfile.fillRatio <= 0) {
      settlements.push({
        id: candidate.id,
        status: "not_filled",
        simulatedFillRatio: 0,
        simulatedFillLatencyMs: settlementProfile.latencyMs,
        filledShares,
        missedExpectedRealizedPnlUsdc,
        reason: settlementProfile.reason ?? "execution_model_not_filled"
      });
      continue;
    }

    const realizedGrossEdgeUsdc = candidate.grossRealizedPnlUsdc * settlementProfile.fillRatio;
    const realizedFeeCostUsdc = candidate.feeCostUsdc * settlementProfile.fillRatio;
    const netPnl = deriveExecutionNetPnlBreakdown({
      grossRealizedPnlUsdc: realizedGrossEdgeUsdc,
      expectedGrossEdgeUsdc:
        (candidate.expectedGrossEdgeUsdc ?? candidate.grossRealizedPnlUsdc) *
        settlementProfile.fillRatio,
      feeCostUsdc: realizedFeeCostUsdc,
      completion: "fully-filled"
    });
    input.pnlEngine.recordTrade({
      id: candidate.id,
      strategy: candidate.strategy,
      marketScope: candidate.marketScope,
      conditionId: candidate.conditionId,
      realizedPnlUsdc: netPnl.realizedPnlUsdc,
      grossRealizedPnlUsdc: netPnl.grossRealizedPnlUsdc,
      feeCostUsdc: netPnl.feeCostUsdc,
      slippageCostUsdc: netPnl.slippageCostUsdc,
      unfilledCostUsdc: netPnl.unfilledCostUsdc,
      gasCostUsdc: netPnl.gasCostUsdc,
      shares: candidate.shares,
      closedAtMs: input.atMs,
      detail: candidate.detail,
      tags: candidate.tags,
      metadata: candidate.metadata
    });
    input.riskManager.noteTradeClosed(
      netPnl.realizedPnlUsdc,
      `simulation.${candidate.strategy}`,
      candidate.detail
    );

    const status = settlementProfile.fillRatio >= 1 ? "filled" : "partial_filled";
    const reason =
      settlementProfile.reason ??
      (status === "filled"
        ? "execution_model_filled"
        : `execution_model_partial_fill_${roundSimulationNumber(settlementProfile.fillRatio)}`);
    settlements.push({
      id: candidate.id,
      status,
      simulatedFillRatio: roundSimulationNumber(settlementProfile.fillRatio),
      simulatedFillLatencyMs: settlementProfile.latencyMs,
      filledShares,
      realizedPnlUsdc: roundSimulationNumber(netPnl.realizedPnlUsdc),
      grossRealizedPnlUsdc: roundSimulationNumber(netPnl.grossRealizedPnlUsdc),
      feeCostUsdc: roundSimulationNumber(netPnl.feeCostUsdc),
      missedExpectedRealizedPnlUsdc,
      reason
    });
    simulatedTrades.push({
      id: candidate.id,
      strategy: candidate.strategy,
      marketScope: candidate.marketScope,
      conditionId: candidate.conditionId,
      status,
      expectedRealizedPnlUsdc: expected.expectedRealizedPnlUsdc,
      expectedGrossEdgeUsdc: expected.expectedGrossEdgeUsdc,
      realizedPnlUsdc: roundSimulationNumber(netPnl.realizedPnlUsdc),
      grossRealizedPnlUsdc: roundSimulationNumber(netPnl.grossRealizedPnlUsdc),
      feeCostUsdc: roundSimulationNumber(netPnl.feeCostUsdc),
      simulatedFillLatencyMs: settlementProfile.latencyMs,
      simulatedFillRatio: roundSimulationNumber(settlementProfile.fillRatio),
      filledShares,
      missedExpectedRealizedPnlUsdc,
      depthCoverageRatio: candidate.depthCoverageRatio,
      fillConfidence: candidate.fillConfidence,
      shares: candidate.shares,
      reason,
      tags: candidate.tags
    });
    simulatedRealizedPnlUsdc += netPnl.realizedPnlUsdc;
    simulatedGrossRealizedPnlUsdc += netPnl.grossRealizedPnlUsdc;
  }

  return {
    settlements,
    simulatedTrades,
    simulatedTradeCount: simulatedTrades.length,
    simulatedRealizedPnlUsdc,
    simulatedGrossRealizedPnlUsdc
  };
};

const buildPaperTrades = (input: {
  candidates: readonly SimulationTradeCandidate[];
  approvedIntentIds: ReadonlySet<string>;
  rejectedIntents: readonly { intent: OrderIntent; reason: RejectedIntentReason }[];
  settlements: readonly SimulationTradeSettlement[];
}): SimulationPaperTradeRecord[] => {
  const rejectionReasonByIntentId = new Map<string, RejectedIntentReason>();

  for (const rejection of input.rejectedIntents) {
    rejectionReasonByIntentId.set(rejection.intent.id, rejection.reason);
  }

  const settlementById = new Map(input.settlements.map((settlement) => [settlement.id, settlement] as const));

  return input.candidates.map((candidate) => {
    const expected = deriveExpectedSimulatedTradePnl(candidate);
    const settlement = settlementById.get(candidate.id);

    if (settlement) {
      return {
        id: candidate.id,
        strategy: candidate.strategy,
        marketScope: candidate.marketScope,
        conditionId: candidate.conditionId,
        status: settlement.status,
        expectedRealizedPnlUsdc: expected.expectedRealizedPnlUsdc,
        expectedGrossEdgeUsdc: expected.expectedGrossEdgeUsdc,
        realizedPnlUsdc: settlement.realizedPnlUsdc,
        grossRealizedPnlUsdc: settlement.grossRealizedPnlUsdc,
        feeCostUsdc:
          typeof settlement.feeCostUsdc === "number"
            ? roundSimulationNumber(settlement.feeCostUsdc)
            : roundSimulationNumber(candidate.feeCostUsdc),
        simulatedFillLatencyMs: settlement.simulatedFillLatencyMs,
        simulatedFillRatio: settlement.simulatedFillRatio,
        filledShares: settlement.filledShares,
        missedExpectedRealizedPnlUsdc: settlement.missedExpectedRealizedPnlUsdc,
        depthCoverageRatio: candidate.depthCoverageRatio,
        fillConfidence: candidate.fillConfidence,
        shares: candidate.shares,
        reason: settlement.reason,
        tags: candidate.tags
      };
    }

    const rejectionReasons = [
      ...new Set(
        candidate.intentIds
          .map((intentId) => rejectionReasonByIntentId.get(intentId))
          .filter((reason): reason is RejectedIntentReason => typeof reason === "string")
      )
    ];

    return {
      id: candidate.id,
      strategy: candidate.strategy,
      marketScope: candidate.marketScope,
      conditionId: candidate.conditionId,
      status: "not_filled",
      expectedRealizedPnlUsdc: expected.expectedRealizedPnlUsdc,
      expectedGrossEdgeUsdc: expected.expectedGrossEdgeUsdc,
      feeCostUsdc: roundSimulationNumber(candidate.feeCostUsdc),
      depthCoverageRatio: candidate.depthCoverageRatio,
      fillConfidence: candidate.fillConfidence,
      shares: candidate.shares,
      simulatedFillRatio: 0,
      filledShares: 0,
      missedExpectedRealizedPnlUsdc: expected.expectedRealizedPnlUsdc,
      reason:
        rejectionReasons.length > 0
          ? rejectionReasons.join(",")
          : candidate.intentIds.every((intentId) => input.approvedIntentIds.has(intentId))
            ? "approved_without_settlement"
            : "not_fully_approved",
      tags: candidate.tags
    };
  });
};

const settleAggressiveOrders = (
  coordinationResult: CoordinationResult,
  executionEngine: ExecutionEngine,
  orderIdByIntentId: ReadonlyMap<string, string>
): void => {
  for (const planItem of coordinationResult.executionPlan.accepted) {
    if (planItem.intent.postOnly) {
      continue;
    }

    if (planItem.intent.tif !== "FOK" && planItem.intent.tif !== "IOC") {
      continue;
    }

    const orderId = orderIdByIntentId.get(planItem.intent.id);

    if (orderId) {
      executionEngine.releaseActiveOrder(orderId);
    }
  }
};

export const parseSimulationScenario = (input: unknown): SimulationScenario => {
  const parsed = scenarioSchema.parse(input);

  return {
    name: parsed.name,
    description: parsed.description,
    markets: parsed.markets.map(normalizeMarket),
    initialBooks: parsed.initialBooks,
    steps: [...parsed.steps].sort((left, right) => left.atMs - right.atMs),
    feeRatesByTokenId: parsed.feeRatesByTokenId ?? {},
    riskThresholds: parsed.riskThresholds,
    execution: parsed.execution
  };
};

export const loadSimulationScenarioFromFile = (scenarioFile: string): SimulationScenario =>
  parseSimulationScenario(JSON.parse(readFileSync(scenarioFile, "utf8")) as unknown);

export const runSimulationScenario = (scenario: SimulationScenario): SimulationReport => {
  const orderBookStore = new OrderBookStore();
  const executionEngine = new ExecutionEngine();
  let currentNowMs = scenario.steps[0]?.atMs ?? Date.now();
  const pnlEngine = new PnLEngine(undefined, {
    now: () => currentNowMs
  });
  const positionManager = new PositionManager();
  const tokenToMarket = new Map<string, BinaryMarket>();

  for (const market of scenario.markets) {
    tokenToMarket.set(market.tokenIds[0], market);
    tokenToMarket.set(market.tokenIds[1], market);
  }

  positionManager.setMarketUniverse(scenario.markets);

  const riskManager = new RiskManager(undefined, {
    now: () => currentNowMs,
    thresholds: scenario.riskThresholds
  });
  const coordinator = new StrategyCoordinator({
    executionEngine,
    riskManager
  });

  for (const snapshot of scenario.initialBooks ?? []) {
    orderBookStore.upsertSnapshot(
      toBookSnapshotEvent(snapshot, tokenToMarket, scenario.steps[0]?.atMs ?? Date.now())
    );
  }

  const stepReports: SimulationStepReport[] = [];
  const strategyTotals = new Map<SimulationStrategy, SimulationStrategyTotals>();
  let totalGeneratedIntentCount = 0;
  let totalApprovedIntentCount = 0;
  let totalRejectedIntentCount = 0;
  let totalSimulatedTradeCount = 0;
  let totalSimulatedRealizedPnlUsdc = 0;
  let totalPaperTradeCount = 0;

  for (const [stepIndex, step] of scenario.steps.entries()) {
    currentNowMs = step.atMs;

    for (const snapshot of step.bookSnapshots ?? []) {
      orderBookStore.upsertSnapshot(toBookSnapshotEvent(snapshot, tokenToMarket, step.atMs));
    }

    updateReferencePrices(positionManager, tokenToMarket, orderBookStore);
    positionManager.syncActiveOrders(executionEngine.getActiveOrders());

    const riskEventsApplied = applyRiskEvents(riskManager, step.riskEvents);
    const executionModel = mergeExecutionModel(scenario.execution, step.execution);
    const stepStrategySummaries: SimulationStrategyStepSummary[] = [];
    const generatedIntents: OrderIntent[] = [];
    const tradeCandidates: SimulationTradeCandidate[] = [];

    for (const strategy of step.evaluate ?? []) {
      const evaluationResult = withPatchedDateNow(step.atMs, () => {
        if (strategy === "market-making") {
          return evaluateMarketMaking(scenario.markets, orderBookStore);
        }

        if (strategy === "same-market-arb") {
          return evaluateSameMarketArb(
            scenario.markets,
            orderBookStore,
            scenario.feeRatesByTokenId
          );
        }

        return evaluateNegativeRisk(
          scenario.markets,
          orderBookStore,
          scenario.feeRatesByTokenId
        );
      });

      generatedIntents.push(...evaluationResult.intents);
      stepStrategySummaries.push(evaluationResult.summary);
      tradeCandidates.push(...evaluationResult.tradeCandidates);
    }

    const coordinationResult = withPatchedDateNow(step.atMs, () =>
      coordinator.coordinate(generatedIntents)
    );
    const { acceptedActions, orderIdByIntentId } = applyAcceptedPlan(
      coordinationResult,
      executionEngine,
      step.id ?? `step-${stepIndex + 1}`,
      step.atMs
    );
    const approvedIntentIds = new Set(
      coordinationResult.executionPlan.accepted.map((item) => item.intent.id)
    );
    const simulatedTradeSummary = recordSimulatedTrades({
      candidates: tradeCandidates,
      approvedIntentIds,
      atMs: step.atMs,
      pnlEngine,
      riskManager,
      executionModel
    });
    const paperTrades = buildPaperTrades({
      candidates: tradeCandidates,
      approvedIntentIds,
      rejectedIntents: coordinationResult.rejected,
      settlements: simulatedTradeSummary.settlements
    });
    settleAggressiveOrders(coordinationResult, executionEngine, orderIdByIntentId);
    const coordinatorRejections = buildCoordinatorRejections(coordinationResult.rejected);
    const generatedIntentCount = generatedIntents.length;
    const approvedIntentCount = coordinationResult.executionPlan.accepted.length;
    const rejectedIntentCount = coordinationResult.rejected.length;
    const portfolio = pnlEngine.getPortfolioSnapshot();

    totalGeneratedIntentCount += generatedIntentCount;
    totalApprovedIntentCount += approvedIntentCount;
    totalRejectedIntentCount += rejectedIntentCount;
    totalSimulatedTradeCount += simulatedTradeSummary.simulatedTradeCount;
    totalSimulatedRealizedPnlUsdc += simulatedTradeSummary.simulatedRealizedPnlUsdc;
    totalPaperTradeCount += paperTrades.length;
    aggregateStrategyTotals(strategyTotals, stepStrategySummaries);

    stepReports.push({
      id: step.id ?? `step-${stepIndex + 1}`,
      atMs: step.atMs,
      notes: step.notes,
      evaluatedStrategies: step.evaluate ?? [],
      riskState: riskManager.getState(),
      riskEventsApplied,
      generatedIntentCount,
      approvedIntentCount,
      rejectedIntentCount,
      acceptedActions,
      coordinatorRejections,
      strategySummaries: stepStrategySummaries,
      simulatedTradeCount: simulatedTradeSummary.simulatedTradeCount,
      simulatedRealizedPnlUsdc: Number(simulatedTradeSummary.simulatedRealizedPnlUsdc.toFixed(8)),
      simulatedGrossRealizedPnlUsdc: Number(
        simulatedTradeSummary.simulatedGrossRealizedPnlUsdc.toFixed(8)
      ),
      simulatedTrades: simulatedTradeSummary.simulatedTrades,
      paperTrades,
      portfolio: buildPortfolioSummary(portfolio),
      activeOrderCount: executionEngine.getActiveOrders().length
    });
  }

  const finalPortfolio = pnlEngine.getPortfolioSnapshot();

  return {
    scenarioName: scenario.name,
    description: scenario.description,
    stepCount: scenario.steps.length,
    finalRiskState: riskManager.getState(),
    finalActiveOrderCount: executionEngine.getActiveOrders().length,
    totalGeneratedIntentCount,
    totalApprovedIntentCount,
    totalRejectedIntentCount,
    totalSimulatedTradeCount,
    totalSimulatedRealizedPnlUsdc: Number(totalSimulatedRealizedPnlUsdc.toFixed(8)),
    totalPaperTradeCount,
    finalPortfolio: buildPortfolioSummary(finalPortfolio),
    strategyTotals: [...strategyTotals.values()].sort((left, right) =>
      left.strategy.localeCompare(right.strategy)
    ),
    steps: stepReports
  };
};
