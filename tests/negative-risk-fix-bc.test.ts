// Fix B + Fix C tests — exercise default-disabled yes-basket and minGroupMarkets gates.
// This file deliberately does NOT override POLYBOT_NEG_RISK_ENABLE_YES_BASKET so the
// default (false) is in effect. minGroupMarkets is set to 3 (default) here.
process.env.POLYBOT_NEG_RISK_MIN_GROUP_MARKETS = "3";
delete process.env.POLYBOT_NEG_RISK_ENABLE_YES_BASKET;

import { describe, expect, it } from "vitest";

import {
  buildNegativeRiskGroups,
  evaluateNegativeRiskOpportunity,
  type NegativeRiskGroup
} from "../src/strategy/negative-risk.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

const makeQuestionId = (index: number): string =>
  `0xaa0edfa656a0e70bf8c63f09438cd70979fef8e31fcc62d80840b5a375a554${index
    .toString(16)
    .padStart(2, "0")}`;

const makeMarket = (
  id: string,
  slug: string,
  groupItemTitle: string,
  questionIndex: number
): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: makeQuestionId(questionIndex),
  question: `Will outcome ${groupItemTitle} happen?`,
  slug,
  eventId: "event-1",
  eventSlug: "sample-event",
  eventTitle: "Sample event",
  groupItemTitle,
  category: "Politics",
  outcomes: ["Yes", "No"],
  tokenIds: [`yes-${id}`, `no-${id}`],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: true,
  enableNegRisk: true,
  cumulativeMarkets: false,
  showAllOutcomes: true
});

const makeBook = (
  assetId: string,
  bestBid: number,
  bestAsk: number,
  updatedAtMs = Date.now()
): NormalizedOrderBook => ({
  assetId,
  market: "market",
  bids: [{ price: bestBid, size: 1000 }],
  asks: [{ price: bestAsk, size: 1000 }],
  tickSize: 0.01,
  minOrderSize: 1,
  negRisk: true,
  lastTradePrice: bestAsk,
  hash: undefined,
  updatedAtMs
});

const markComplete = (group: NegativeRiskGroup): NegativeRiskGroup => ({
  ...group,
  expectedActiveMarketCount: group.markets.length,
  expectedQuestionIds: new Set(
    group.markets
      .map((market) => market.questionId.toLowerCase())
      .filter((qid): qid is string => Boolean(qid))
  ),
  metadataFetchedAtMs: Date.now()
});

describe("Fix B: yes-basket disabled by default", () => {
  it("rejects yes-basket evaluation with yes_basket_disabled when toggle is off", () => {
    // Build a group with prices that would normally produce a yes-basket opportunity
    // (sum 0.20 + 0.30 + 0.40 = 0.90 < 1.0). With Fix B's default, the strategy should
    // skip yes-basket entirely. The no-to-yes-conversion path also can't produce an
    // opportunity here because no NO books are provided.
    const group = markComplete(
      buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!
    );
    const booksByTokenId = new Map<string, NormalizedOrderBook>([
      ["yes-1", makeBook("yes-1", 0.18, 0.2)],
      ["yes-2", makeBook("yes-2", 0.28, 0.3)],
      ["yes-3", makeBook("yes-3", 0.38, 0.4)]
    ]);

    const evaluation = evaluateNegativeRiskOpportunity(group, booksByTokenId, new Map());

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      // Either yes_basket_disabled (yes-basket path) or a downstream reason from the
      // no-to-yes-conversion path. The important property is that no opportunity is
      // returned.
      expect(["yes_basket_disabled", "missing_no_token", "insufficient_depth"]).toContain(
        evaluation.reason
      );
    }
  });
});

describe("Fix C: minGroupMarkets gate", () => {
  it("rejects 2-market groups when minGroupMarkets default is 3", () => {
    // 2-outcome events are usually standard binary markets, not negRisk multi-outcome
    // events. Even if Polymarket flags them as negRisk, the Adapter math (n-1 collateral
    // output) gives 1 × shares = $1 for n=2 which is the same as standard binary merge.
    const group = markComplete(
      buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1)
      ])[0]!
    );
    const booksByTokenId = new Map<string, NormalizedOrderBook>([
      ["yes-1", makeBook("yes-1", 0.34, 0.36)],
      ["yes-2", makeBook("yes-2", 0.36, 0.39)]
    ]);

    const evaluation = evaluateNegativeRiskOpportunity(group, booksByTokenId, new Map());

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      expect(evaluation.reason).toBe("not_enough_markets");
      expect(evaluation.detail).toContain("minGroupMarkets(3)");
    }
  });

  it("accepts 3+ market groups (passes the minGroupMarkets gate)", () => {
    const group = markComplete(
      buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!
    );
    const booksByTokenId = new Map<string, NormalizedOrderBook>([
      ["yes-1", makeBook("yes-1", 0.18, 0.2)],
      ["no-1", makeBook("no-1", 0.1, 0.35)],
      ["yes-2", makeBook("yes-2", 0.32, 0.45)],
      ["no-2", makeBook("no-2", 0.52, 0.55)],
      ["yes-3", makeBook("yes-3", 0.3, 0.4)],
      ["no-3", makeBook("no-3", 0.58, 0.6)]
    ]);

    const evaluation = evaluateNegativeRiskOpportunity(group, booksByTokenId, new Map());

    // 3 markets clears the gate; with NO books providing a profitable conversion path,
    // the no-to-yes-conversion strategy should produce an opportunity.
    expect(evaluation.status).toBe("opportunity");
    if (evaluation.status === "opportunity") {
      expect(evaluation.opportunity.kind).toBe("no-to-yes-conversion");
    }
  });
});
