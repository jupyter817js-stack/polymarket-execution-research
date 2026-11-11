import { afterEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  buildSameMarketOpportunitySnapshot,
  getEffectiveOrderMinSize,
  inspectSameMarketEvaluation
} from "../src/strategy/arb.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

const market: BinaryMarket = {
  id: "1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "Will Italy qualify?",
  slug: "will-italy-qualify",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 5,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: false
};

const makeBook = (
  assetId: string,
  minOrderSize: number,
  askPrice = 0.49,
  tickSize = 0.01,
  updatedAtMs = Date.now()
): NormalizedOrderBook => ({
  assetId,
  market: market.conditionId,
  bids: [{ price: 0.49, size: 100 }],
  asks: [{ price: askPrice, size: 100 }],
  tickSize,
  minOrderSize,
  negRisk: false,
  lastTradePrice: undefined,
  hash: undefined,
  updatedAtMs
});

describe("Same-market evaluation", () => {
  const originalTargetShares = config.strategy.targetShares;
  const originalTargetOrderNotionalUsdc = config.strategy.targetOrderNotionalUsdc;

  afterEach(() => {
    (config.strategy as { targetShares: number }).targetShares = originalTargetShares;
    (config.strategy as { targetOrderNotionalUsdc: number }).targetOrderNotionalUsdc =
      originalTargetOrderNotionalUsdc;
  });

  it("uses the strictest minimum order size across market metadata and both books", () => {
    const bookA = makeBook("yes-token", 10);
    const bookB = makeBook("no-token", 7);

    expect(getEffectiveOrderMinSize(market, bookA, bookB)).toBe(10);
  });

  it("auto-adjusts shares upward to satisfy the effective order minimum", () => {
    (config.strategy as { targetShares: number }).targetShares = 5;
    const bookA = makeBook("yes-token", 10, 0.48);
    const bookB = makeBook("no-token", 7, 0.49);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.diagnostics.marketOrderMinSize).toBe(5);
      expect(evaluation.diagnostics.bookOrderMinSizeA).toBe(10);
      expect(evaluation.diagnostics.bookOrderMinSizeB).toBe(7);
      expect(evaluation.diagnostics.effectiveOrderMinSize).toBe(10);
      expect(evaluation.diagnostics.configuredTargetShares).toBe(5);
      expect(evaluation.diagnostics.shares).toBe(10);
      expect(evaluation.diagnostics.sharesAutoAdjusted).toBe(true);
    }
  });

  it("auto-adjusts profitable setups upward when a leg would post below the marketable BUY minimum notional", () => {
    (config.strategy as { targetShares: number }).targetShares = 5;
    (config.strategy as { targetOrderNotionalUsdc: number }).targetOrderNotionalUsdc = 1.2;
    const bookA = makeBook("yes-token", 1, 0.15);
    const bookB = makeBook("no-token", 1, 0.8);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.diagnostics.shares).toBeCloseTo(8);
      expect(evaluation.diagnostics.sharesAutoAdjusted).toBe(true);
      expect(evaluation.diagnostics.legA.orderNotional).toBeCloseTo(1.2);
    }

    expect(buildSameMarketOpportunitySnapshot(market, bookA, bookB, 0, 0)).toBeDefined();
  });

  it("rejects when executable depth at the entry limit lacks a safety cushion", () => {
    (config.strategy as { targetShares: number }).targetShares = 5;
    const bookA: NormalizedOrderBook = {
      ...makeBook("yes-token", 1, 0.42),
      asks: [{ price: 0.42, size: 6 }]
    };
    const bookB = makeBook("no-token", 1, 0.55);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("entry_depth_ratio_too_shallow_leg_a");
      expect(evaluation.diagnostics.entryMinDepthRatio).toBe(config.strategy.entryMinDepthRatio);
      expect(evaluation.diagnostics.legA.executableDepthAtLimit).toBeCloseTo(6);
      expect(evaluation.diagnostics.legA.requiredDepthAtLimit).toBeCloseTo(
        config.strategy.targetShares * config.strategy.entryMinDepthRatio
      );
    }

    expect(buildSameMarketOpportunitySnapshot(market, bookA, bookB, 0, 0)).toBeUndefined();
  });

  it("rejects when one side of the pair is stale", () => {
    const now = Date.now();
    const staleAge = config.strategy.maxBookStalenessMs + 1_000;
    const bookA = makeBook("yes-token", 1, 0.43, 0.01, now - staleAge);
    const bookB = makeBook("no-token", 1, 0.55, 0.01, now);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("stale_book_leg_a");
      expect(evaluation.diagnostics.legA.bookAgeMs).toBeGreaterThan(config.strategy.maxBookStalenessMs);
      expect(evaluation.diagnostics.maxBookStalenessMs).toBe(config.strategy.maxBookStalenessMs);
    }

    expect(buildSameMarketOpportunitySnapshot(market, bookA, bookB, 0, 0)).toBeUndefined();
  });

  it("rejects when the pair costs more than the configured entry cap", () => {
    const bookA = makeBook("yes-token", 1, 0.49);
    const bookB = makeBook("no-token", 1, 0.5);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("gross_cost_above_entry_cap");
      expect(evaluation.diagnostics.grossCostPerShare).toBeCloseTo(0.99);
      expect(evaluation.diagnostics.maxEntryGrossCostPerShare).toBe(0.98);
    }

    expect(buildSameMarketOpportunitySnapshot(market, bookA, bookB, 0, 0)).toBeUndefined();
  });

  it("rejects when the YES/NO books are too far apart in time", () => {
    const now = Date.now();
    const bookA = makeBook("yes-token", 1, 0.43, 0.01, now - 2_000);
    const bookB = makeBook("no-token", 1, 0.55, 0.01, now);

    const evaluation = inspectSameMarketEvaluation(market, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("book_timestamp_skew_too_wide");
      expect(evaluation.diagnostics.bookTimestampSkewMs).toBeGreaterThan(1_000);
      expect(evaluation.diagnostics.maxBookSkewMs).toBe(1_000);
    }

    expect(buildSameMarketOpportunitySnapshot(market, bookA, bookB, 0, 0)).toBeUndefined();
  });

  it("rejects profitable setups when a leg would violate marketable BUY precision", () => {
    (config.strategy as { targetShares: number }).targetShares = 5;
    (config.strategy as { targetOrderNotionalUsdc: number }).targetOrderNotionalUsdc = 1.2;
    const precisionMarket: BinaryMarket = {
      ...market,
      orderPriceMinTickSize: 0.001
    };
    const bookA = makeBook("yes-token", 1, 0.42, 0.001);
    const bookB = makeBook("no-token", 1, 0.557, 0.001);

    const evaluation = inspectSameMarketEvaluation(precisionMarket, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.diagnostics.shares).toBe(10);
      expect(evaluation.diagnostics.sharesAutoAdjusted).toBe(true);
      expect(evaluation.diagnostics.legB.orderNotional).toBeCloseTo(5.57);
    }

    expect(buildSameMarketOpportunitySnapshot(precisionMarket, bookA, bookB, 0, 0)).toBeDefined();
  });

  it("still returns an opportunity when both legs are executable", () => {
    const precisionMarket: BinaryMarket = {
      ...market,
      orderPriceMinTickSize: 0.001
    };
    const bookA = makeBook("yes-token", 1, 0.42, 0.001);
    const bookB = makeBook("no-token", 1, 0.55, 0.001);

    const evaluation = inspectSameMarketEvaluation(precisionMarket, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.opportunity.legs[0].limitPrice).toBeCloseTo(0.42);
      expect(evaluation.opportunity.legs[1].limitPrice).toBeCloseTo(0.55);
    }
  });

  it("uses the market minimum tick size when the book reports a finer increment", () => {
    const coarseMarket: BinaryMarket = {
      ...market,
      orderPriceMinTickSize: 0.01
    };
    const bookA = makeBook("yes-token", 1, 0.421, 0.001);
    const bookB = makeBook("no-token", 1, 0.55, 0.001);

    const evaluation = inspectSameMarketEvaluation(coarseMarket, bookA, bookB, 0, 0);

    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.opportunity.legs[0].tickSize).toBe(0.01);
      expect(evaluation.opportunity.legs[0].limitPrice).toBeCloseTo(0.43);
      expect(evaluation.opportunity.legs[1].tickSize).toBe(0.01);
      expect(evaluation.opportunity.legs[1].limitPrice).toBeCloseTo(0.55);
    }
  });
});
