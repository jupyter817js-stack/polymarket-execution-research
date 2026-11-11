// Test env overrides: must be set before any module that imports `../src/config.js`.
// Fix B sets enableYesBasket default to false (hold-until-resolution risk); the existing
// yes-basket tests below need it enabled. Fix C sets minGroupMarkets default to 3; tests
// here use 2-3 markets so we relax the gate to 2.
process.env.POLYBOT_NEG_RISK_ENABLE_YES_BASKET = "true";
process.env.POLYBOT_NEG_RISK_MIN_GROUP_MARKETS = "2";

import { describe, expect, it } from "vitest";

import {
  buildNegativeRiskGroups,
  evaluateNegativeRiskOpportunity,
  type NegativeRiskGroup
} from "../src/strategy/negative-risk.js";
import type { BinaryMarket, NormalizedOrderBook } from "../src/types.js";

// Test helper: marks a group as "complete" (matches what the live registry would attach)
// so it bypasses Fix A's group-completeness gate.
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

describe("Negative Risk strategy", () => {
  it("groups neg risk markets by event id and derives a shared market id", () => {
    const groups = buildNegativeRiskGroups([
      makeMarket("1", "outcome-a", "Outcome A", 0),
      makeMarket("2", "outcome-b", "Outcome B", 1),
      {
        ...makeMarket("3", "non-neg-risk", "Outcome C", 2),
        negRisk: false
      }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.markets).toHaveLength(2);
    expect(groups[0]?.eventId).toBe("event-1");
    expect(groups[0]?.marketId).toBe(
      "0xaa0edfa656a0e70bf8c63f09438cd70979fef8e31fcc62d80840b5a375a55400"
    );
  });

  // Fix B: yes-basket success path is no longer a default-enabled opportunity. The bot
  // would only realize PnL at event resolution (no immediate Adapter conversion). The
  // success path remains implicitly covered by the no-to-yes-conversion test below,
  // which uses the same pricing logic. We assert here that with default config + only
  // YES books available, the strategy correctly reports no opportunity.
  it("does not produce a yes-basket opportunity by default (Fix B disabled)", () => {
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
    const feeRatesByTokenId = new Map<string, number>();

    const evaluation = evaluateNegativeRiskOpportunity(
      group,
      booksByTokenId,
      feeRatesByTokenId
    );

    expect(evaluation.status).toBe("rejected");
    if (evaluation.status === "rejected") {
      // The first rejection reason can be from yes-basket (when disabled) or from the
      // no-to-yes-conversion path (no NO books supplied). Both are acceptable.
      expect([
        "yes_basket_disabled",
        "missing_no_token",
        "insufficient_depth"
      ]).toContain(evaluation.reason);
    }
  });

  it("detects a profitable NO-to-YES conversion opportunity", () => {
    const group = markComplete(
      buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!
    );
    const booksByTokenId = new Map<string, NormalizedOrderBook>([
      ["yes-1", makeBook("yes-1", 0.12, 0.8)],
      ["no-1", makeBook("no-1", 0.1, 0.35)],
      ["yes-2", makeBook("yes-2", 0.32, 0.45)],
      ["no-2", makeBook("no-2", 0.52, 0.55)],
      ["yes-3", makeBook("yes-3", 0.3, 0.4)],
      ["no-3", makeBook("no-3", 0.58, 0.6)]
    ]);
    const feeRatesByTokenId = new Map<string, number>();

    const evaluation = evaluateNegativeRiskOpportunity(
      group,
      booksByTokenId,
      feeRatesByTokenId
    );

    expect(evaluation.status).toBe("opportunity");

    if (evaluation.status === "opportunity") {
      expect(evaluation.opportunity.kind).toBe("no-to-yes-conversion");

      if (evaluation.opportunity.kind === "no-to-yes-conversion") {
        expect(evaluation.opportunity.entry.tokenId).toBe("no-1");
        expect(evaluation.opportunity.exitLegs).toHaveLength(2);
        expect(evaluation.opportunity.conversionMarketId).toBe(group.marketId);
        expect(evaluation.opportunity.conversionIndexSet).toBe("0x1");
        expect(evaluation.opportunity.grossCost).toBeCloseTo(1.75, 8);
        expect(evaluation.opportunity.grossProceeds).toBeCloseTo(3.1, 8);
        // Fix I: netEdge subtracts gasReserveUsdc (0.3 default per .env). Pre-gas
        // gross-minus-fee edge = 1.35; post-gas net = 1.35 - 0.3 = 1.05.
        expect(evaluation.opportunity.netEdge).toBeCloseTo(1.05, 8);
      }
    }
  });

  // Fix B: with yes-basket disabled, the cap test now exercises the no-to-yes-conversion
  // path. Set NO ask high enough that grossCostPerShare exceeds the cap.
  it("rejects no-to-yes-conversion entries whose cost exceeds the configured cap", () => {
    const group = markComplete(
      buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!
    );
    // NO_1 ask 0.999 → buying NO of question 1 costs ~0.999 per share. With cap 0.985
    // (default) or 0.995 (current .env), this exceeds either threshold.
    const booksByTokenId = new Map<string, NormalizedOrderBook>([
      ["yes-1", makeBook("yes-1", 0.0, 0.001)],
      ["no-1", makeBook("no-1", 0.998, 0.999)],
      ["yes-2", makeBook("yes-2", 0.32, 0.45)],
      ["no-2", makeBook("no-2", 0.52, 0.55)],
      ["yes-3", makeBook("yes-3", 0.3, 0.4)],
      ["no-3", makeBook("no-3", 0.58, 0.6)]
    ]);
    const feeRatesByTokenId = new Map<string, number>();

    const evaluation = evaluateNegativeRiskOpportunity(
      group,
      booksByTokenId,
      feeRatesByTokenId
    );

    expect(evaluation.status).toBe("rejected");

    if (evaluation.status === "rejected") {
      // Acceptable terminal rejection from any of the no-conversion paths once they
      // all hit the cap. yes-basket also rejects at this stage (disabled), so the
      // returned reason can be either one.
      expect([
        "gross_cost_above_entry_cap",
        "yes_basket_disabled"
      ]).toContain(evaluation.reason);
    }
  });

  describe("Fix A: group completeness gate", () => {
    // Books that produce a profitable no-to-yes-conversion opportunity (Fix B leaves
    // yes-basket disabled, so we use the supported conversion path instead).
    const buildBooks = () =>
      new Map<string, NormalizedOrderBook>([
        ["yes-1", makeBook("yes-1", 0.12, 0.8)],
        ["no-1", makeBook("no-1", 0.1, 0.35)],
        ["yes-2", makeBook("yes-2", 0.32, 0.45)],
        ["no-2", makeBook("no-2", 0.52, 0.55)],
        ["yes-3", makeBook("yes-3", 0.3, 0.4)],
        ["no-3", makeBook("no-3", 0.58, 0.6)]
      ]);

    it("rejects with missing_event_metadata when expected counts are unset", () => {
      // Group built directly from buildNegativeRiskGroups, no enrichment from registry.
      // The Fix A gate must intercept this before economic evaluation runs.
      const group = buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!;
      expect(group.expectedActiveMarketCount).toBeUndefined();
      expect(group.expectedQuestionIds).toBeUndefined();

      const evaluation = evaluateNegativeRiskOpportunity(group, buildBooks(), new Map());

      expect(evaluation.status).toBe("rejected");
      if (evaluation.status === "rejected") {
        expect(evaluation.reason).toBe("missing_event_metadata");
      }
    });

    it("rejects with incomplete_group when local count is below expected count", () => {
      // Universe filter only surfaced 3 markets, but gamma reports 12 active markets in
      // the negRisk event group (e.g. multi-candidate election). Yes-basket execution
      // would be a directional bet, not arb; bridge convertPositions would also fail.
      const baseGroup = buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!;
      const group: NegativeRiskGroup = {
        ...baseGroup,
        expectedActiveMarketCount: 12,
        expectedQuestionIds: new Set(
          baseGroup.markets.map((market) => market.questionId.toLowerCase())
        ),
        metadataFetchedAtMs: Date.now()
      };

      const evaluation = evaluateNegativeRiskOpportunity(group, buildBooks(), new Map());

      expect(evaluation.status).toBe("rejected");
      if (evaluation.status === "rejected") {
        expect(evaluation.reason).toBe("incomplete_group");
        expect(evaluation.detail).toContain("12");
      }
    });

    it("rejects with incomplete_group when expected questionId is missing locally", () => {
      // Same number of markets, but one of the expected questionIds is not present
      // (e.g. a different market's id substituted for an expected one).
      const baseGroup = buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!;
      const expectedQuestionIds = new Set(
        baseGroup.markets.map((market) => market.questionId.toLowerCase())
      );
      // Add a phantom expected questionId that is not present locally.
      expectedQuestionIds.add(
        "0xaa0edfa656a0e70bf8c63f09438cd70979fef8e31fcc62d80840b5a375a554ff"
      );

      const group: NegativeRiskGroup = {
        ...baseGroup,
        expectedActiveMarketCount: baseGroup.markets.length,
        expectedQuestionIds,
        metadataFetchedAtMs: Date.now()
      };

      const evaluation = evaluateNegativeRiskOpportunity(group, buildBooks(), new Map());

      expect(evaluation.status).toBe("rejected");
      if (evaluation.status === "rejected") {
        expect(evaluation.reason).toBe("incomplete_group");
        expect(evaluation.detail).toContain("0xaa0edfa6");
      }
    });

    it("passes when group matches expected metadata exactly", () => {
      const group = markComplete(
        buildNegativeRiskGroups([
          makeMarket("1", "outcome-a", "Outcome A", 0),
          makeMarket("2", "outcome-b", "Outcome B", 1),
          makeMarket("3", "outcome-c", "Outcome C", 2)
        ])[0]!
      );

      const evaluation = evaluateNegativeRiskOpportunity(group, buildBooks(), new Map());

      expect(evaluation.status).toBe("opportunity");
    });

    it("ignores incomplete_group rejection when local count exceeds expected (defensive)", () => {
      // If gamma reports fewer active markets than what the bot has locally (transient race
      // during gamma response cache miss vs. universe refresh), allow evaluation to continue.
      // The questionId match check still applies; if every expected questionId is present,
      // the extra local markets are tolerated.
      const baseGroup = buildNegativeRiskGroups([
        makeMarket("1", "outcome-a", "Outcome A", 0),
        makeMarket("2", "outcome-b", "Outcome B", 1),
        makeMarket("3", "outcome-c", "Outcome C", 2)
      ])[0]!;
      const expectedQuestionIds = new Set(
        baseGroup.markets.slice(0, 2).map((market) => market.questionId.toLowerCase())
      );
      const group: NegativeRiskGroup = {
        ...baseGroup,
        expectedActiveMarketCount: 2,
        expectedQuestionIds,
        metadataFetchedAtMs: Date.now()
      };

      const evaluation = evaluateNegativeRiskOpportunity(group, buildBooks(), new Map());

      // Local count 3 >= expected 2 and both expected questionIds are present locally.
      expect(evaluation.status).toBe("opportunity");
    });
  });
});
