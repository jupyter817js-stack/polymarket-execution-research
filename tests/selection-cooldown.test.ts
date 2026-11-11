import { describe, expect, it } from "vitest";

import { SelectionCooldownState } from "../src/core/selection-cooldown.js";

describe("Selection cooldown state", () => {
  it("holds an incumbent through the minimum hold window", () => {
    const state = new SelectionCooldownState();
    const first = state.apply(
      [
        { id: "incumbent", score: 0.7, value: "incumbent" },
        { id: "challenger", score: 0.6, value: "challenger" }
      ],
      {
        currentSelectedIds: new Set(),
        maxSelectedWeight: 1,
        nowMs: 1_000,
        minHoldMs: 10_000,
        reentryCooldownMs: 5_000
      }
    );

    expect(first.selectedIds).toEqual(["incumbent"]);

    const second = state.apply(
      [
        { id: "challenger", score: 0.95, value: "challenger" },
        { id: "incumbent", score: 0.8, value: "incumbent" }
      ],
      {
        currentSelectedIds: new Set(["incumbent"]),
        maxSelectedWeight: 1,
        nowMs: 5_000,
        minHoldMs: 10_000,
        reentryCooldownMs: 5_000
      }
    );

    expect(second.selectedIds).toEqual(["incumbent"]);
    expect(second.forcedHoldIds).toEqual(["incumbent"]);
  });

  it("blocks immediate reentry during cooldown", () => {
    const state = new SelectionCooldownState();

    state.apply(
      [{ id: "alpha", score: 0.9, value: "alpha" }],
      {
        currentSelectedIds: new Set(),
        maxSelectedWeight: 1,
        nowMs: 1_000,
        minHoldMs: 0,
        reentryCooldownMs: 10_000
      }
    );

    const dropped = state.apply(
      [{ id: "beta", score: 0.92, value: "beta" }],
      {
        currentSelectedIds: new Set(["alpha"]),
        maxSelectedWeight: 1,
        nowMs: 2_000,
        minHoldMs: 0,
        reentryCooldownMs: 10_000
      }
    );

    expect(dropped.selectedIds).toEqual(["beta"]);
    expect(dropped.droppedIds).toEqual(["alpha"]);

    const third = state.apply(
      [
        { id: "alpha", score: 0.99, value: "alpha" },
        { id: "beta", score: 0.7, value: "beta" }
      ],
      {
        currentSelectedIds: new Set(["beta"]),
        maxSelectedWeight: 1,
        nowMs: 4_000,
        minHoldMs: 0,
        reentryCooldownMs: 10_000
      }
    );

    expect(third.selectedIds).toEqual(["beta"]);
    expect(third.blockedReentryIds).toContain("alpha");
  });

  it("respects weighted capacity for grouped selections", () => {
    const state = new SelectionCooldownState();

    const decision = state.apply(
      [
        { id: "group-a", score: 0.95, value: "group-a", weight: 3 },
        { id: "group-b", score: 0.9, value: "group-b", weight: 2 },
        { id: "group-c", score: 0.89, value: "group-c", weight: 2 }
      ],
      {
        currentSelectedIds: new Set(),
        maxSelectedWeight: 5,
        nowMs: 1_000,
        minHoldMs: 0,
        reentryCooldownMs: 0
      }
    );

    expect(decision.selectedIds).toEqual(["group-a", "group-b"]);
  });
});
