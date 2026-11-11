import { describe, expect, it } from "vitest";

import { calculateBuyFill, calculateSellFill } from "../src/strategy/vwap.js";
import { estimateBuyFee, estimateSellFee } from "../src/strategy/fees.js";

describe("VWAP helpers", () => {
  it("computes the buy-side cost for target shares", () => {
    const fill = calculateBuyFill(
      [
        { price: 0.48, size: 10 },
        { price: 0.49, size: 10 }
      ],
      15
    );

    expect(fill).toBeDefined();
    expect(fill?.totalCost).toBeCloseTo(7.25);
    expect(fill?.averagePrice).toBeCloseTo(0.4833333333);
    expect(fill?.worstPrice).toBeCloseTo(0.49);
  });

  it("returns undefined when ask depth is too shallow", () => {
    const fill = calculateBuyFill([{ price: 0.48, size: 2 }], 5);
    expect(fill).toBeUndefined();
  });

  it("computes the sell-side proceeds for target shares", () => {
    const fill = calculateSellFill(
      [
        { price: 0.51, size: 10 },
        { price: 0.5, size: 10 }
      ],
      15
    );

    expect(fill).toBeDefined();
    expect(fill?.totalProceeds).toBeCloseTo(7.6);
    expect(fill?.averagePrice).toBeCloseTo(0.5066666667);
    expect(fill?.worstPrice).toBeCloseTo(0.5);
  });
});

describe("Fee estimation", () => {
  it("returns zero when the base fee is zero", () => {
    const fee = estimateBuyFee(
      {
        shares: 10,
        totalCost: 4.8,
        averagePrice: 0.48,
        worstPrice: 0.48
      },
      0,
      1
    );

    expect(fee).toBe(0);
  });

  it("uses the symmetric probability factor", () => {
    const fee = estimateBuyFee(
      {
        shares: 100,
        totalCost: 80,
        averagePrice: 0.8,
        worstPrice: 0.81
      },
      100,
      1
    );

    expect(fee).toBeCloseTo(0.2);
  });

  it("applies the same symmetric fee model on sells", () => {
    const fee = estimateSellFee(
      {
        shares: 100,
        totalProceeds: 20,
        averagePrice: 0.2,
        worstPrice: 0.19
      },
      100,
      1
    );

    expect(fee).toBeCloseTo(0.2);
  });
});
