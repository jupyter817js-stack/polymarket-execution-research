import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { PositionManager } from "../src/core/position-manager.js";
import { StrategyCoordinator } from "../src/core/strategy-coordinator.js";
import { ExecutionEngine } from "../src/core/execution-engine.js";
import type { OrderIntent } from "../src/core/types.js";
import { getDefaultStrategyPriority } from "../src/core/types.js";
import type { BinaryMarket } from "../src/types.js";

const makeMarket = (
  conditionId: string,
  tokenIds: readonly [string, string],
  category = "Crypto"
): BinaryMarket => ({
  id: conditionId,
  conditionId,
  questionId: `${conditionId}-question`,
  question: `${conditionId} question`,
  slug: conditionId,
  category,
  outcomes: ["Yes", "No"],
  tokenIds,
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: true,
  negRisk: false
});

const makeIntent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  id: "intent-1",
  strategy: "market-making",
  priority: getDefaultStrategyPriority("market-making"),
  conditionId: "condition-1",
  tokenId: "yes-token",
  side: "BUY",
  price: 0.5,
  size: 25,
  tif: "GTC",
  postOnly: true,
  createdAtMs: 1,
  reason: "test",
  tags: [],
  ...overrides
});

describe("PositionManager", () => {
  const originalMaxCategoryExposureUsdc = config.marketMaker.maxCategoryExposureUsdc;
  const originalTotalActiveBuyBudgetUsdc = config.capital.totalActiveBuyBudgetUsdc;
  const originalMarketMakingBudgetUsdc = config.capital.marketMakingBudgetUsdc;
  const originalSameMarketArbBudgetUsdc = config.capital.sameMarketArbBudgetUsdc;
  const originalNegativeRiskBudgetUsdc = config.capital.negativeRiskBudgetUsdc;
  const originalEventBuyBudgetUsdc = config.capital.eventBuyBudgetUsdc;
  const originalConditionBuyBudgetUsdc = config.capital.conditionBuyBudgetUsdc;
  const originalHourlyBuyBudgetUsdc = config.capital.hourlyBuyBudgetUsdc;
  const originalEnableDynamicStrategyReallocation =
    config.capital.enableDynamicStrategyReallocation;
  const originalStrategyReallocationIntensity =
    config.capital.strategyReallocationIntensity;
  const originalStrategySignalFloor = config.capital.strategySignalFloor;
  const originalEnableDynamicScopeReallocation =
    config.capital.enableDynamicScopeReallocation;
  const originalScopeReallocationIntensity =
    config.capital.scopeReallocationIntensity;
  const originalScopeSignalFloor = config.capital.scopeSignalFloor;
  const originalDegradedBuyBudgetMultiplier =
    config.capital.degradedBuyBudgetMultiplier;
  const originalDegradedMarketMakingBudgetMultiplier =
    config.capital.degradedMarketMakingBudgetMultiplier;
  const originalDegradedSameMarketArbBudgetMultiplier =
    config.capital.degradedSameMarketArbBudgetMultiplier;
  const originalDegradedNegativeRiskBudgetMultiplier =
    config.capital.degradedNegativeRiskBudgetMultiplier;
  const originalEnableDynamicDegradedCurve =
    config.capital.enableDynamicDegradedCurve;
  const originalDegradedCurveFloorMultiplier =
    config.capital.degradedCurveFloorMultiplier;
  const originalDegradedCurveExponent =
    config.capital.degradedCurveExponent;

  const applyDeterministicBudgetBaseline = (): void => {
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 1_000;
    (config.capital as { totalActiveBuyBudgetUsdc: number }).totalActiveBuyBudgetUsdc = 1_000;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 400;
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc = 300;
    (config.capital as { negativeRiskBudgetUsdc: number }).negativeRiskBudgetUsdc = 300;
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 1_000;
    (config.capital as { conditionBuyBudgetUsdc: number }).conditionBuyBudgetUsdc = 1_000;
    (config.capital as { hourlyBuyBudgetUsdc: number }).hourlyBuyBudgetUsdc = 1_000;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;
    (config.capital as { strategyReallocationIntensity: number }).strategyReallocationIntensity = 0;
    (config.capital as { strategySignalFloor: number }).strategySignalFloor = 0;
    (
      config.capital as { enableDynamicScopeReallocation: boolean }
    ).enableDynamicScopeReallocation = false;
    (config.capital as { scopeReallocationIntensity: number }).scopeReallocationIntensity = 0;
    (config.capital as { scopeSignalFloor: number }).scopeSignalFloor = 0;
    (config.capital as { degradedBuyBudgetMultiplier: number }).degradedBuyBudgetMultiplier = 1;
    (
      config.capital as { degradedMarketMakingBudgetMultiplier: number }
    ).degradedMarketMakingBudgetMultiplier = 1;
    (
      config.capital as { degradedSameMarketArbBudgetMultiplier: number }
    ).degradedSameMarketArbBudgetMultiplier = 1;
    (
      config.capital as { degradedNegativeRiskBudgetMultiplier: number }
    ).degradedNegativeRiskBudgetMultiplier = 1;
    (
      config.capital as { enableDynamicDegradedCurve: boolean }
    ).enableDynamicDegradedCurve = false;
    (
      config.capital as { degradedCurveFloorMultiplier: number }
    ).degradedCurveFloorMultiplier = 1;
    (config.capital as { degradedCurveExponent: number }).degradedCurveExponent = 1;
  };

  beforeEach(() => {
    applyDeterministicBudgetBaseline();
  });

  afterEach(() => {
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc =
      originalMaxCategoryExposureUsdc;
    (config.capital as { totalActiveBuyBudgetUsdc: number }).totalActiveBuyBudgetUsdc =
      originalTotalActiveBuyBudgetUsdc;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc =
      originalMarketMakingBudgetUsdc;
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc =
      originalSameMarketArbBudgetUsdc;
    (config.capital as { negativeRiskBudgetUsdc: number }).negativeRiskBudgetUsdc =
      originalNegativeRiskBudgetUsdc;
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc =
      originalEventBuyBudgetUsdc;
    (config.capital as { conditionBuyBudgetUsdc: number }).conditionBuyBudgetUsdc =
      originalConditionBuyBudgetUsdc;
    (config.capital as { hourlyBuyBudgetUsdc: number }).hourlyBuyBudgetUsdc =
      originalHourlyBuyBudgetUsdc;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = originalEnableDynamicStrategyReallocation;
    (
      config.capital as { strategyReallocationIntensity: number }
    ).strategyReallocationIntensity = originalStrategyReallocationIntensity;
    (config.capital as { strategySignalFloor: number }).strategySignalFloor =
      originalStrategySignalFloor;
    (
      config.capital as { enableDynamicScopeReallocation: boolean }
    ).enableDynamicScopeReallocation = originalEnableDynamicScopeReallocation;
    (
      config.capital as { scopeReallocationIntensity: number }
    ).scopeReallocationIntensity = originalScopeReallocationIntensity;
    (config.capital as { scopeSignalFloor: number }).scopeSignalFloor =
      originalScopeSignalFloor;
    (config.capital as { degradedBuyBudgetMultiplier: number }).degradedBuyBudgetMultiplier =
      originalDegradedBuyBudgetMultiplier;
    (
      config.capital as { degradedMarketMakingBudgetMultiplier: number }
    ).degradedMarketMakingBudgetMultiplier = originalDegradedMarketMakingBudgetMultiplier;
    (
      config.capital as { degradedSameMarketArbBudgetMultiplier: number }
    ).degradedSameMarketArbBudgetMultiplier = originalDegradedSameMarketArbBudgetMultiplier;
    (
      config.capital as { degradedNegativeRiskBudgetMultiplier: number }
    ).degradedNegativeRiskBudgetMultiplier = originalDegradedNegativeRiskBudgetMultiplier;
    (
      config.capital as { enableDynamicDegradedCurve: boolean }
    ).enableDynamicDegradedCurve = originalEnableDynamicDegradedCurve;
    (
      config.capital as { degradedCurveFloorMultiplier: number }
    ).degradedCurveFloorMultiplier = originalDegradedCurveFloorMultiplier;
    (config.capital as { degradedCurveExponent: number }).degradedCurveExponent =
      originalDegradedCurveExponent;
  });

  it("rejects market-making buys when category exposure would exceed the configured cap", () => {
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 80;

    const manager = new PositionManager();
    manager.setMarketUniverse([
      makeMarket("condition-1", ["yes-token", "no-token"]),
      makeMarket("condition-2", ["eth-yes", "eth-no"])
    ]);
    manager.updateReferencePrice("yes-token", 0.5);
    manager.updateReferencePrice("eth-yes", 0.4);
    manager.updateTokenInventory("yes-token", {
      balance: 100,
      allowance: 100,
      refreshedAtMs: Date.now()
    });
    manager.updateTokenInventory("eth-yes", {
      balance: 50,
      allowance: 50,
      refreshedAtMs: Date.now()
    });

    const decision = manager.evaluateIntent(
      makeIntent({
        tokenId: "eth-no",
        conditionId: "condition-2",
        price: 0.49,
        size: 25
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("category_exposure_cap_exceeded");
  });

  it("rejects sells when allowance-backed inventory is insufficient", () => {
    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])]);
    manager.updateTokenInventory("yes-token", {
      balance: 10,
      allowance: 3,
      refreshedAtMs: Date.now()
    });

    const decision = manager.evaluateIntent(
      makeIntent({
        side: "SELL",
        size: 5
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("insufficient_sellable_inventory");
  });

  it("rejects sells when no inventory snapshot is available yet", () => {
    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])]);

    const decision = manager.evaluateIntent(
      makeIntent({
        side: "SELL",
        size: 1
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("insufficient_sellable_inventory");
    expect(decision.detail).toContain("No inventory snapshot");
  });

  it("reserves approved passive intents within the same batch", () => {
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 200;

    const manager = new PositionManager();
    manager.setMarketUniverse([
      makeMarket("condition-1", ["yes-token", "no-token"], "Sports"),
      makeMarket("condition-2", ["eth-yes", "eth-no"], "Sports")
    ]);
    manager.updateReferencePrice("yes-token", 0.5);
    manager.updateReferencePrice("eth-yes", 0.5);
    const coordinator = new StrategyCoordinator({
      executionEngine: new ExecutionEngine(),
      positionManager: manager
    });

    const result = coordinator.coordinate([
      makeIntent({
        id: "first",
        tokenId: "yes-token",
        conditionId: "condition-1",
        price: 0.49,
        size: 250
      }),
      makeIntent({
        id: "second",
        tokenId: "eth-yes",
        conditionId: "condition-2",
        price: 0.49,
        size: 250,
        createdAtMs: 2
      })
    ]);

    expect(result.executionPlan.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("position_blocked");
  });

  it("rejects same-market-arb buys when the strategy budget would be exceeded", () => {
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc = 30;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;

    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])], "market-maker");
    manager.syncActiveOrders([
      {
        orderId: "mm-buy-1",
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        conditionId: "condition-1",
        tokenId: "no-token",
        side: "BUY",
        price: 0.5,
        size: 40,
        tif: "FOK",
        postOnly: false,
        openedAtMs: Date.now()
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        tif: "FOK",
        postOnly: false,
        size: 25,
        price: 0.49
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("strategy_buy_budget_exceeded");
  });

  it("rejects market-making buys when tracked open lots already consume most of the strategy budget", () => {
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 40;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;

    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])], "market-maker");
    manager.updateReferencePrice("yes-token", 0.6);
    manager.syncTrackedInventoryLots([
      {
        lotId: "mm-lot-1",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: "condition-1",
        conditionId: "condition-1",
        shares: 50,
        totalCostUsdc: 25,
        openedAtMs: Date.now()
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 25
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("strategy_buy_budget_exceeded");
  });

  it("boosts the market-making budget when reward and rebate signals are strong", () => {
    (config.capital as { totalActiveBuyBudgetUsdc: number }).totalActiveBuyBudgetUsdc = 100;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 50;
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc = 25;
    (config.capital as { negativeRiskBudgetUsdc: number }).negativeRiskBudgetUsdc = 25;
    (config.capital as { conditionBuyBudgetUsdc: number }).conditionBuyBudgetUsdc = 100;
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 100;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = true;
    (config.capital as { strategyReallocationIntensity: number }).strategyReallocationIntensity =
      0.5;
    (config.capital as { strategySignalFloor: number }).strategySignalFloor = 0.05;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [{ ...makeMarket("condition-1", ["yes-token", "no-token"]), eventId: "event-1" }],
      "market-maker"
    );
    manager.setStrategyCapitalSignal("market-making", 1);
    manager.setStrategyCapitalSignal("same-market-arb", 0.1);
    manager.setStrategyCapitalSignal("negative-risk", 0.1);
    manager.syncTrackedInventoryLots([
      {
        lotId: "mm-lot-boosted",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: "condition-1",
        conditionId: "condition-1",
        shares: 100,
        totalCostUsdc: 55,
        openedAtMs: Date.now(),
        metadata: {
          eventId: "event-1"
        }
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 20
      })
    );

    expect(decision.allowed).toBe(true);
  });

  it("rejects Negative Risk buys when the event budget would be exceeded across grouped markets", () => {
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 20;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [
        makeMarket("condition-1", ["yes-token", "no-token"], "Politics"),
        {
          ...makeMarket("condition-2", ["alt-yes", "alt-no"], "Politics"),
          eventId: "shared-event"
        },
        {
          ...makeMarket("condition-1", ["yes-token", "no-token"], "Politics"),
          eventId: "shared-event"
        }
      ],
      "negative-risk"
    );
    manager.syncActiveOrders([
      {
        orderId: "nr-buy-1",
        strategy: "negative-risk",
        priority: getDefaultStrategyPriority("negative-risk"),
        conditionId: "condition-1",
        tokenId: "yes-token",
        side: "BUY",
        price: 0.5,
        size: 20,
        tif: "FOK",
        postOnly: false,
        openedAtMs: Date.now()
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "negative-risk",
        priority: getDefaultStrategyPriority("negative-risk"),
        conditionId: "condition-2",
        tokenId: "alt-yes",
        tif: "FOK",
        postOnly: false,
        price: 0.5,
        size: 25,
        metadata: {
          eventId: "shared-event"
        }
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("event_buy_budget_exceeded");
  });

  it("rejects Negative Risk buys when tracked open lots already consume the event budget", () => {
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 30;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [
        {
          ...makeMarket("condition-1", ["yes-token", "no-token"], "Politics"),
          eventId: "shared-event"
        },
        {
          ...makeMarket("condition-2", ["alt-yes", "alt-no"], "Politics"),
          eventId: "shared-event"
        }
      ],
      "negative-risk"
    );
    manager.syncTrackedInventoryLots([
      {
        lotId: "nr-lot-1",
        strategy: "negative-risk",
        tokenId: "yes-token",
        marketScope: "shared-event",
        conditionId: "condition-1",
        shares: 20,
        totalCostUsdc: 18,
        openedAtMs: Date.now(),
        metadata: {
          eventId: "shared-event"
        }
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "negative-risk",
        priority: getDefaultStrategyPriority("negative-risk"),
        conditionId: "condition-2",
        tokenId: "alt-yes",
        tif: "FOK",
        postOnly: false,
        price: 0.55,
        size: 25,
        metadata: {
          eventId: "shared-event"
        }
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("event_buy_budget_exceeded");
  });

  it("cuts the same-market-arb strategy budget when higher-priority signals shift capital elsewhere", () => {
    (config.capital as { totalActiveBuyBudgetUsdc: number }).totalActiveBuyBudgetUsdc = 100;
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 50;
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc = 25;
    (config.capital as { negativeRiskBudgetUsdc: number }).negativeRiskBudgetUsdc = 25;
    (config.capital as { conditionBuyBudgetUsdc: number }).conditionBuyBudgetUsdc = 100;
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 100;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = true;
    (config.capital as { strategyReallocationIntensity: number }).strategyReallocationIntensity =
      0.5;
    (config.capital as { strategySignalFloor: number }).strategySignalFloor = 0.05;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [{ ...makeMarket("condition-1", ["yes-token", "no-token"]), eventId: "event-1" }],
      "same-market-arb"
    );
    manager.setStrategyCapitalSignal("market-making", 1);
    manager.setStrategyCapitalSignal("same-market-arb", 0.1);
    manager.setStrategyCapitalSignal("negative-risk", 0.1);
    manager.syncTrackedInventoryLots([
      {
        lotId: "arb-lot-reduced",
        strategy: "same-market-arb",
        tokenId: "yes-token",
        marketScope: "condition-1",
        conditionId: "condition-1",
        shares: 40,
        totalCostUsdc: 15,
        openedAtMs: Date.now(),
        metadata: {
          eventId: "event-1"
        }
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        tif: "FOK",
        postOnly: false,
        price: 0.5,
        size: 10
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("strategy_buy_budget_exceeded");
  });

  it("boosts the per-condition budget for higher-scoring selected conditions", () => {
    (config.capital as { conditionBuyBudgetUsdc: number }).conditionBuyBudgetUsdc = 20;
    (
      config.capital as { enableDynamicScopeReallocation: boolean }
    ).enableDynamicScopeReallocation = true;
    (config.capital as { scopeReallocationIntensity: number }).scopeReallocationIntensity = 0.6;
    (config.capital as { scopeSignalFloor: number }).scopeSignalFloor = 0.05;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [
        { ...makeMarket("condition-strong", ["yes-token", "no-token"]), eventId: "event-1" },
        { ...makeMarket("condition-weak", ["alt-yes", "alt-no"]), eventId: "event-2" }
      ],
      "same-market-arb"
    );
    manager.setConditionCapitalSignals(
      new Map([
        ["condition-strong", 1],
        ["condition-weak", 0.1]
      ]),
      "same-market-arb"
    );

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        conditionId: "condition-strong",
        tokenId: "yes-token",
        tif: "FOK",
        postOnly: false,
        price: 0.5,
        size: 45
      })
    );

    expect(decision.allowed).toBe(true);
  });

  it("cuts the per-event budget for lower-scoring events even when the static cap would allow entry", () => {
    (config.capital as { eventBuyBudgetUsdc: number }).eventBuyBudgetUsdc = 20;
    (
      config.capital as { enableDynamicScopeReallocation: boolean }
    ).enableDynamicScopeReallocation = true;
    (config.capital as { scopeReallocationIntensity: number }).scopeReallocationIntensity = 0.6;
    (config.capital as { scopeSignalFloor: number }).scopeSignalFloor = 0.05;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [
        {
          ...makeMarket("condition-strong", ["yes-token", "no-token"], "Politics"),
          eventId: "event-strong"
        },
        {
          ...makeMarket("condition-weak", ["alt-yes", "alt-no"], "Politics"),
          eventId: "event-weak"
        }
      ],
      "negative-risk"
    );
    manager.setEventCapitalSignals(
      new Map([
        ["event-strong", 1],
        ["event-weak", 0.1]
      ]),
      "negative-risk"
    );
    manager.syncTrackedInventoryLots([
      {
        lotId: "nr-weak-event-lot",
        strategy: "negative-risk",
        tokenId: "alt-yes",
        marketScope: "event-weak",
        conditionId: "condition-weak",
        shares: 20,
        totalCostUsdc: 10,
        openedAtMs: Date.now(),
        metadata: {
          eventId: "event-weak"
        }
      }
    ]);

    const decision = manager.evaluateIntent(
      makeIntent({
        strategy: "negative-risk",
        priority: getDefaultStrategyPriority("negative-risk"),
        conditionId: "condition-weak",
        tokenId: "alt-yes",
        tif: "FOK",
        postOnly: false,
        price: 0.5,
        size: 12,
        metadata: {
          eventId: "event-weak"
        }
      })
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("event_buy_budget_exceeded");
  });

  it("boosts market-maker category exposure caps for stronger categories", () => {
    (config.marketMaker as { maxCategoryExposureUsdc: number }).maxCategoryExposureUsdc = 50;
    (
      config.capital as { enableDynamicScopeReallocation: boolean }
    ).enableDynamicScopeReallocation = true;
    (config.capital as { scopeReallocationIntensity: number }).scopeReallocationIntensity = 0.6;
    (config.capital as { scopeSignalFloor: number }).scopeSignalFloor = 0.05;

    const manager = new PositionManager();
    manager.setMarketUniverse(
      [
        {
          ...makeMarket("condition-crypto", ["yes-token", "no-token"], "Crypto"),
          eventId: "event-crypto"
        },
        {
          ...makeMarket("condition-sports", ["alt-yes", "alt-no"], "Sports"),
          eventId: "event-sports"
        }
      ],
      "market-maker"
    );
    manager.updateReferencePrice("yes-token", 0.5);
    manager.updateTokenInventory("yes-token", {
      balance: 80,
      allowance: 80,
      refreshedAtMs: Date.now()
    });
    manager.setCategoryCapitalSignals(
      new Map([
        ["crypto", 1],
        ["sports", 0.1]
      ]),
      "market-maker"
    );

    const decision = manager.evaluateIntent(
      makeIntent({
        tokenId: "no-token",
        conditionId: "condition-crypto",
        price: 0.5,
        size: 30
      })
    );

    expect(decision.allowed).toBe(true);
  });

  it("shrinks BUY budgets when the shared risk state is degraded", () => {
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 100;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;
    (config.capital as { degradedBuyBudgetMultiplier: number }).degradedBuyBudgetMultiplier = 0.6;

    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])], "market-maker");
    manager.syncTrackedInventoryLots([
      {
        lotId: "mm-lot-degraded",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: "condition-1",
        conditionId: "condition-1",
        shares: 80,
        totalCostUsdc: 40,
        openedAtMs: Date.now()
      }
    ]);

    const runningDecision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 60
      })
    );
    manager.setRiskState("DEGRADED");
    const degradedDecision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 60
      })
    );

    expect(runningDecision.allowed).toBe(true);
    expect(degradedDecision.allowed).toBe(false);
    expect(degradedDecision.reason).toBe("strategy_buy_budget_exceeded");
  });

  it("applies stricter degraded haircuts to market-making than same-market-arb", () => {
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 100;
    (config.capital as { sameMarketArbBudgetUsdc: number }).sameMarketArbBudgetUsdc = 100;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;
    (config.capital as { degradedBuyBudgetMultiplier: number }).degradedBuyBudgetMultiplier = 1;
    (
      config.capital as { degradedMarketMakingBudgetMultiplier: number }
    ).degradedMarketMakingBudgetMultiplier = 0.5;
    (
      config.capital as { degradedSameMarketArbBudgetMultiplier: number }
    ).degradedSameMarketArbBudgetMultiplier = 0.9;

    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])], "shared");
    manager.setRiskState("DEGRADED");

    const marketMakingDecision = manager.evaluateIntent(
      makeIntent({
        strategy: "market-making",
        priority: getDefaultStrategyPriority("market-making"),
        price: 0.5,
        size: 120
      })
    );
    const sameMarketArbDecision = manager.evaluateIntent(
      makeIntent({
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        tif: "FOK",
        postOnly: false,
        price: 0.5,
        size: 120
      })
    );

    expect(marketMakingDecision.allowed).toBe(false);
    expect(marketMakingDecision.reason).toBe("strategy_buy_budget_exceeded");
    expect(sameMarketArbDecision.allowed).toBe(true);
  });

  it("tightens degraded budget headroom as the risk snapshot approaches halt thresholds", () => {
    (config.capital as { marketMakingBudgetUsdc: number }).marketMakingBudgetUsdc = 100;
    (
      config.capital as { enableDynamicStrategyReallocation: boolean }
    ).enableDynamicStrategyReallocation = false;
    (config.capital as { degradedBuyBudgetMultiplier: number }).degradedBuyBudgetMultiplier = 0.8;
    (
      config.capital as { degradedMarketMakingBudgetMultiplier: number }
    ).degradedMarketMakingBudgetMultiplier = 1;
    (
      config.capital as { enableDynamicDegradedCurve: boolean }
    ).enableDynamicDegradedCurve = true;
    (
      config.capital as { degradedCurveFloorMultiplier: number }
    ).degradedCurveFloorMultiplier = 0.5;
    (config.capital as { degradedCurveExponent: number }).degradedCurveExponent = 1;

    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])], "market-maker");

    manager.setRiskSnapshot({
      state: "DEGRADED",
      dayKey: "2026-04-06",
      dailyRealizedPnlUsdc: -5,
      dailyLossUsdc: config.risk.maxDailyLossUsdc * config.risk.degradeDailyLossRatio,
      consecutiveLosses: config.risk.degradeConsecutiveLosses,
      apiErrors: 0,
      orderFailures: 0,
      stateMismatches: 0,
      lastEventAtMs: Date.now()
    });

    const earlyDegradedDecision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 130
      })
    );

    manager.setRiskSnapshot({
      state: "DEGRADED",
      dayKey: "2026-04-06",
      dailyRealizedPnlUsdc: -9,
      dailyLossUsdc: config.risk.maxDailyLossUsdc * 0.9,
      consecutiveLosses: config.risk.degradeConsecutiveLosses,
      apiErrors: 0,
      orderFailures: 0,
      stateMismatches: 0,
      lastEventAtMs: Date.now()
    });

    const lateDegradedDecision = manager.evaluateIntent(
      makeIntent({
        price: 0.5,
        size: 130
      })
    );

    expect(earlyDegradedDecision.allowed).toBe(true);
    expect(lateDegradedDecision.allowed).toBe(false);
    expect(lateDegradedDecision.reason).toBe("strategy_buy_budget_exceeded");
  });

  it("blocks a SELL intent when other active quoteSlots already commit the full balance", () => {
    // Reproduces the live incident: sell-layer-0/1/2 occupy the full YES token balance,
    // then one-side-aggressive-exit:1/2/3 try to sell on top — PositionManager must reject them.
    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])]);

    const balance = 19.646;
    manager.updateTokenInventory("yes-token", {
      balance,
      allowance: 1e18,
      refreshedAtMs: Date.now()
    });

    // Simulate 3 active sell-layer orders totalling 19.640 — all venue-committed
    manager.syncActiveOrders([
      {
        orderId: "order-sl-0",
        tokenId: "yes-token",
        conditionId: "condition-1",
        side: "SELL",
        price: 0.41,
        size: 5,
        strategy: "market-making",
        quoteSlot: "sell-layer-0",
        placedAtMs: 1
      },
      {
        orderId: "order-sl-1",
        tokenId: "yes-token",
        conditionId: "condition-1",
        side: "SELL",
        price: 0.42,
        size: 5,
        strategy: "market-making",
        quoteSlot: "sell-layer-1",
        placedAtMs: 1
      },
      {
        orderId: "order-sl-2",
        tokenId: "yes-token",
        conditionId: "condition-1",
        side: "SELL",
        price: 0.43,
        size: 9.640,
        strategy: "market-making",
        quoteSlot: "sell-layer-2",
        placedAtMs: 1
      }
    ]);

    manager.beginBatch();

    // exit:1 — should be blocked: effectiveSellable = 19.646 - 19.640 = 0.006 < 5
    const exit1 = manager.evaluateIntent(
      makeIntent({ side: "SELL", size: 5, quoteSlot: "one-side-aggressive-exit:1" })
    );
    expect(exit1.allowed).toBe(false);
    expect(exit1.reason).toBe("insufficient_sellable_inventory");
    expect(exit1.detail).toContain("effectiveSellableSize");

    manager.endBatch();
  });

  it("allows a SELL intent when other quoteSlots leave just enough headroom", () => {
    const manager = new PositionManager();
    manager.setMarketUniverse([makeMarket("condition-1", ["yes-token", "no-token"])]);

    manager.updateTokenInventory("yes-token", {
      balance: 20,
      allowance: 1e18,
      refreshedAtMs: Date.now()
    });

    // 10 shares committed in other slots → 10 shares free
    manager.syncActiveOrders([
      {
        orderId: "order-sl-0",
        tokenId: "yes-token",
        conditionId: "condition-1",
        side: "SELL",
        price: 0.41,
        size: 10,
        strategy: "market-making",
        quoteSlot: "sell-layer-0",
        placedAtMs: 1
      }
    ]);

    manager.beginBatch();

    const exit1 = manager.evaluateIntent(
      makeIntent({ side: "SELL", size: 9, quoteSlot: "one-side-aggressive-exit:1" })
    );
    expect(exit1.allowed).toBe(true);

    manager.endBatch();
  });
});
