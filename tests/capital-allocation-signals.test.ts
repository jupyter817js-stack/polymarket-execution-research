import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  blendCapitalSignalScores,
  blendScopedCapitalSignals,
  buildMarketScopedCapitalSignals,
  buildNegativeRiskScopedCapitalSignals,
  buildScopedPerformanceCapitalSignals,
  buildStrategyPerformanceCapitalSignal
} from "../src/core/capital-allocation-signals.js";
import type { PnlTradeRecord, StrategyPnlSnapshot } from "../src/core/types.js";
import type {
  RankedMarketSelection,
  RankedNegativeRiskGroupSelection
} from "../src/core/market-selection.js";
import type { BinaryMarket } from "../src/types.js";

const makeSnapshot = (
  overrides: Partial<StrategyPnlSnapshot> = {}
): StrategyPnlSnapshot => ({
  strategy: "same-market-arb",
  dayKey: "2026-04-06",
  dailyRealizedPnlUsdc: 0,
  lifetimeRealizedPnlUsdc: 0,
  dailyGrossRealizedPnlUsdc: 0,
  lifetimeGrossRealizedPnlUsdc: 0,
  dailyFeeCostUsdc: 0,
  lifetimeFeeCostUsdc: 0,
  dailyRebateUsdc: 0,
  lifetimeRebateUsdc: 0,
  dailyRewardUsdc: 0,
  lifetimeRewardUsdc: 0,
  dailySlippageCostUsdc: 0,
  lifetimeSlippageCostUsdc: 0,
  dailyUnfilledCostUsdc: 0,
  lifetimeUnfilledCostUsdc: 0,
  dailyGasCostUsdc: 0,
  lifetimeGasCostUsdc: 0,
  dailyTradeCount: 0,
  lifetimeTradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0,
  ...overrides
});

const makeMarket = (
  overrides: Partial<BinaryMarket> = {}
): BinaryMarket => ({
  id: "market-1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "test question",
  slug: "test-market",
  category: "Crypto",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: true,
  negRisk: false,
  ...overrides
});

const makeTrade = (overrides: Partial<PnlTradeRecord> = {}): PnlTradeRecord => ({
  id: "trade-1",
  dayKey: "2026-04-06",
  strategy: "same-market-arb",
  marketScope: "market-1",
  conditionId: "condition-1",
  realizedPnlUsdc: 0,
  grossRealizedPnlUsdc: 0,
  feeCostUsdc: 0,
  rebateUsdc: 0,
  rewardUsdc: 0,
  slippageCostUsdc: 0,
  unfilledCostUsdc: 0,
  gasCostUsdc: 0,
  closedAtMs: 1,
  tags: [],
  ...overrides
});

describe("capital-allocation-signals", () => {
  const originalEnableIntraDayStrategyReallocation =
    config.capital.enableIntraDayStrategyReallocation;
  const originalIntraDayPerformanceWeight =
    config.capital.intraDayPerformanceWeight;
  const originalIntraDayPnlScaleUsdc = config.capital.intraDayPnlScaleUsdc;

  afterEach(() => {
    (
      config.capital as { enableIntraDayStrategyReallocation: boolean }
    ).enableIntraDayStrategyReallocation = originalEnableIntraDayStrategyReallocation;
    (config.capital as { intraDayPerformanceWeight: number }).intraDayPerformanceWeight =
      originalIntraDayPerformanceWeight;
    (config.capital as { intraDayPnlScaleUsdc: number }).intraDayPnlScaleUsdc =
      originalIntraDayPnlScaleUsdc;
  });

  it("returns a neutral performance signal when no intraday trades exist", () => {
    const signal = buildStrategyPerformanceCapitalSignal([]);

    expect(signal.score).toBe(0.5);
    expect(signal.tradeCount).toBe(0);
  });

  it("raises the performance signal when realized pnl and win rate are strong", () => {
    (config.capital as { intraDayPnlScaleUsdc: number }).intraDayPnlScaleUsdc = 10;

    const signal = buildStrategyPerformanceCapitalSignal([
      makeSnapshot({
        dailyRealizedPnlUsdc: 8,
        dailyTradeCount: 6,
        winningTrades: 5,
        losingTrades: 1
      })
    ]);

    expect(signal.score).toBeGreaterThan(0.7);
    expect(signal.components.pnl).toBeGreaterThan(0.8);
  });

  it("blends selection and performance scores using the configured intraday weight", () => {
    (
      config.capital as { enableIntraDayStrategyReallocation: boolean }
    ).enableIntraDayStrategyReallocation = true;
    (config.capital as { intraDayPerformanceWeight: number }).intraDayPerformanceWeight = 0.25;

    const blendedScore = blendCapitalSignalScores(0.8, 0.4);

    expect(blendedScore).toBe(0.7);
  });

  it("tilts category scoped signals toward higher reward/rebate markets", () => {
    const selectedEntries: RankedMarketSelection[] = [
      {
        market: makeMarket({
          conditionId: "condition-high",
          eventId: "event-high",
          category: "Crypto"
        }),
        breakdown: {
          liquidity: 0.6,
          reward: 1,
          rebate: 0.9,
          expiry: 0.6,
          structure: 0.6,
          spread: 0.6,
          activity: 0.6,
          retentionBonus: 0,
          total: 0.6,
          reasons: []
        }
      },
      {
        market: makeMarket({
          conditionId: "condition-low",
          eventId: "event-low",
          category: "Sports"
        }),
        breakdown: {
          liquidity: 0.8,
          reward: 0.1,
          rebate: 0.1,
          expiry: 0.8,
          structure: 0.8,
          spread: 0.8,
          activity: 0.8,
          retentionBonus: 0,
          total: 0.8,
          reasons: []
        }
      }
    ];

    const scopedSignals = buildMarketScopedCapitalSignals(selectedEntries);

    expect((scopedSignals.byCategory.get("crypto") ?? 0)).toBeGreaterThan(
      scopedSignals.byCategory.get("sports") ?? 0
    );
  });

  it("tilts Negative Risk event scoped signals toward higher reward/rebate groups", () => {
    const selectedEntries: RankedNegativeRiskGroupSelection[] = [
      {
        group: {
          eventId: "event-high",
          eventSlug: "event-high",
          eventTitle: "High event",
          markets: [makeMarket({ conditionId: "condition-high", eventId: "event-high" })]
        },
        breakdown: {
          liquidity: 0.6,
          reward: 1,
          rebate: 0.9,
          expiry: 0.6,
          structure: 0.6,
          spread: 0.6,
          activity: 0.6,
          retentionBonus: 0,
          total: 0.6,
          reasons: []
        }
      },
      {
        group: {
          eventId: "event-low",
          eventSlug: "event-low",
          eventTitle: "Low event",
          markets: [makeMarket({ conditionId: "condition-low", eventId: "event-low" })]
        },
        breakdown: {
          liquidity: 0.8,
          reward: 0.1,
          rebate: 0.1,
          expiry: 0.8,
          structure: 0.8,
          spread: 0.8,
          activity: 0.8,
          retentionBonus: 0,
          total: 0.8,
          reasons: []
        }
      }
    ];

    const scopedSignals = buildNegativeRiskScopedCapitalSignals(selectedEntries);

    expect((scopedSignals.byEventId.get("event-high") ?? 0)).toBeGreaterThan(
      scopedSignals.byEventId.get("event-low") ?? 0
    );
  });

  it("builds scoped performance signals from realized trade outcomes", () => {
    (config.capital as { intraDayPnlScaleUsdc: number }).intraDayPnlScaleUsdc = 5;

    const performanceSignals = buildScopedPerformanceCapitalSignals({
      trades: [
        makeTrade({
          realizedPnlUsdc: 4,
          conditionId: "condition-win",
          metadata: {
            eventId: "event-win",
            category: "crypto"
          }
        }),
        makeTrade({
          id: "trade-2",
          realizedPnlUsdc: -3,
          conditionId: "condition-loss",
          metadata: {
            eventId: "event-loss",
            category: "sports"
          }
        })
      ],
      relevantStrategies: ["same-market-arb"]
    });

    expect((performanceSignals.byConditionId.get("condition-win") ?? 0)).toBeGreaterThan(
      performanceSignals.byConditionId.get("condition-loss") ?? 0
    );
    expect((performanceSignals.byEventId.get("event-win") ?? 0)).toBeGreaterThan(
      performanceSignals.byEventId.get("event-loss") ?? 0
    );
    expect((performanceSignals.byCategory.get("crypto") ?? 0)).toBeGreaterThan(
      performanceSignals.byCategory.get("sports") ?? 0
    );
  });

  it("blends scoped selection and performance signals using intraday weight", () => {
    (
      config.capital as { enableIntraDayStrategyReallocation: boolean }
    ).enableIntraDayStrategyReallocation = true;
    (config.capital as { intraDayPerformanceWeight: number }).intraDayPerformanceWeight = 0.25;

    const blendedSignals = blendScopedCapitalSignals(
      {
        byConditionId: new Map([["condition-1", 0.8]]),
        byEventId: new Map([["event-1", 0.7]]),
        byCategory: new Map([["crypto", 0.6]])
      },
      {
        byConditionId: new Map([["condition-1", 0.4]]),
        byEventId: new Map([["event-1", 0.5]]),
        byCategory: new Map([["crypto", 0.2]])
      }
    );

    expect(blendedSignals.byConditionId.get("condition-1")).toBe(0.7);
    expect(blendedSignals.byEventId.get("event-1")).toBe(0.65);
    expect(blendedSignals.byCategory.get("crypto")).toBe(0.5);
  });
});
