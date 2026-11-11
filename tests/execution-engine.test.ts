import { describe, expect, it } from "vitest";

import { ExecutionEngine } from "../src/core/execution-engine.js";
import type { ActiveOrderState, OrderIntent } from "../src/core/types.js";
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

const makeActiveOrder = (overrides: Partial<ActiveOrderState> = {}): ActiveOrderState => ({
  orderId: "order-1",
  strategy: "market-making",
  priority: getDefaultStrategyPriority("market-making"),
  conditionId: "condition-1",
  tokenId: "token-1",
  side: "BUY",
  price: 0.49,
  size: 25,
  tif: "GTC",
  postOnly: true,
  openedAtMs: 1,
  ...overrides
});

describe("ExecutionEngine", () => {
  it("creates a new order when no active conflict exists", () => {
    const engine = new ExecutionEngine();
    const plan = engine.plan([makeIntent()]);

    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.action).toBe("create");
    expect(plan.rejected).toHaveLength(0);
  });

  it("replaces a lower-priority active order when a higher-priority intent arrives", () => {
    const engine = new ExecutionEngine();
    engine.upsertActiveOrder(makeActiveOrder());

    const plan = engine.plan([
      makeIntent({
        id: "intent-arb",
        strategy: "same-market-arb",
        priority: getDefaultStrategyPriority("same-market-arb"),
        tif: "FOK",
        postOnly: false,
        price: 0.5
      })
    ]);

    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.action).toBe("replace");
    expect(plan.accepted[0]?.orderToCancel?.orderId).toBe("order-1");
    expect(plan.rejected).toHaveLength(0);
  });

  it("rejects lower-priority duplicate intents for the same token and side", () => {
    const engine = new ExecutionEngine();
    const plan = engine.plan([
      makeIntent({
        id: "intent-mm",
        strategy: "market-making",
        priority: getDefaultStrategyPriority("market-making"),
        createdAtMs: 2
      }),
      makeIntent({
        id: "intent-reward",
        strategy: "liquidity-rewards",
        priority: getDefaultStrategyPriority("liquidity-rewards"),
        createdAtMs: 1
      })
    ]);

    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.intent.id).toBe("intent-mm");
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toBe("duplicate_intent");
  });

  it("rejects intents that already match the active order terms", () => {
    const engine = new ExecutionEngine();
    engine.upsertActiveOrder(makeActiveOrder());

    const plan = engine.plan([makeIntent()]);

    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toBe("active_order_already_matches");
  });
});
