import { describe, expect, it } from "vitest";

import { estimateMakerRebate } from "../src/strategy/rebates.js";

describe("maker rebate estimation", () => {
  it("uses the configured crypto fee curve near 50%", () => {
    const estimate = estimateMakerRebate({
      shares: 100,
      price: 0.5,
      category: "Crypto"
    });

    expect(estimate.categoryRuleApplied).toBe(true);
    expect(estimate.feeEquivalentUsdc).toBeCloseTo(6.25, 8);
    expect(estimate.maxPotentialRebateUsdc).toBeCloseTo(1.25, 8);
    expect(estimate.makerRebatePct).toBeCloseTo(0.2, 8);
  });

  it("uses the configured sports fee curve near 50%", () => {
    const estimate = estimateMakerRebate({
      shares: 100,
      price: 0.5,
      category: "Sports"
    });

    expect(estimate.categoryRuleApplied).toBe(true);
    expect(estimate.feeEquivalentUsdc).toBeCloseTo(0.875, 8);
    expect(estimate.maxPotentialRebateUsdc).toBeCloseTo(0.21875, 8);
    expect(estimate.makerRebatePct).toBeCloseTo(0.25, 8);
  });

  it("returns zero when the category has no rebate rule", () => {
    const estimate = estimateMakerRebate({
      shares: 100,
      price: 0.5,
      category: "Politics"
    });

    expect(estimate.categoryRuleApplied).toBe(false);
    expect(estimate.feeEquivalentUsdc).toBe(0);
    expect(estimate.maxPotentialRebateUsdc).toBe(0);
    expect(estimate.makerRebatePct).toBe(0);
  });
});
