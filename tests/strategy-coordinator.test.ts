import { describe, expect, it } from "vitest";

import { ExecutionEngine } from "../src/core/execution-engine.js";
import { StrategyCoordinator } from "../src/core/strategy-coordinator.js";
import type {
  OrderIntent,
  PositionGateDecision,
  PositionManagerLike,
  RiskGateDecision,
  RiskManagerLike
} from "../src/core/types.js";
import { getDefaultStrategyPriority } from "../src/core/types.js";

const makeIntent = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  id: "intent-1",
  strategy: "market-making",
  priority: getDefaultStrategyPriority("market-making"),
  conditionId: "condition-1",
  tokenId: "token-1",
  side: "BUY",
  price: 0.49,
  size: 25,
  tif: "GTC",
  postOnly: true,
  createdAtMs: 1,
  reason: "test",
  tags: [],
  ...overrides
});

describe("StrategyCoordinator", () => {
  it("preempts lower-priority intents on the same condition", () => {
    const coordinator = new StrategyCoordinator({
      executionEngine: new ExecutionEngine()
    });

    const result = coordinator.coordinate([
      makeIntent({
        id: "mm-buy",
        strategy: "market-making",
        side: "BUY",
        tokenId: "token-yes"
      }),
      makeIntent({
        id: "arb-buy",
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        side: "BUY",
        tokenId: "token-no",
        tif: "FOK",
        postOnly: false
      })
    ]);

    expect(result.executionPlan.accepted).toHaveLength(1);
    expect(result.executionPlan.accepted[0]?.intent.id).toBe("arb-buy");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("condition_preempted_by_higher_priority_strategy");
  });

  it("keeps same-priority intents on the same condition when they do not conflict by token and side", () => {
    const coordinator = new StrategyCoordinator({
      executionEngine: new ExecutionEngine()
    });

    const result = coordinator.coordinate([
      makeIntent({
        id: "mm-yes-buy",
        tokenId: "token-yes",
        side: "BUY"
      }),
      makeIntent({
        id: "mm-no-sell",
        tokenId: "token-no",
        side: "SELL",
        createdAtMs: 2,
        price: 0.51
      })
    ]);

    expect(result.executionPlan.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
  });

  it("blocks intents when the risk manager halts trading", () => {
    const riskManager: RiskManagerLike = {
      evaluateIntent(): RiskGateDecision {
        return {
          allowed: false,
          state: "HALTED",
          reason: "daily loss exceeded"
        };
      }
    };

    const coordinator = new StrategyCoordinator({
      executionEngine: new ExecutionEngine(),
      riskManager
    });

    const result = coordinator.coordinate([makeIntent()]);

    expect(result.executionPlan.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("risk_blocked");
  });

  it("blocks intents when the projected position would exceed limits", () => {
    const positionManager: PositionManagerLike = {
      evaluateIntent(): PositionGateDecision {
        return {
          allowed: false,
          reason: "category exposure exceeded",
          projectedExposureUsdc: 320
        };
      }
    };

    const coordinator = new StrategyCoordinator({
      executionEngine: new ExecutionEngine(),
      positionManager
    });

    const result = coordinator.coordinate([makeIntent()]);

    expect(result.executionPlan.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("position_blocked");
  });
});
