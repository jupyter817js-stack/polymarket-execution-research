// Fix K test — verify the negative-risk eligibility profile bypasses the
// recent-trade-events and exit-depth gates that are appropriate for same-market-arb
// but cause long-tail negRisk outcomes (e.g., minor election candidates) to drop out
// of the universe and prevent complete groups from being formed.
import { describe, expect, it } from "vitest";

import {
  filterMarketsForSelectionEligibility,
  type MarketSelectionSignal
} from "../src/core/market-selection.js";
import type { BinaryMarket } from "../src/types.js";

const futureEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const makeMarket = (id: string, overrides: Partial<BinaryMarket> = {}): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: `question-${id}`,
  question: `Will outcome ${id} win?`,
  slug: `market-${id}`,
  eventId: "event-elec-2026",
  eventSlug: "election-2026",
  eventTitle: "Election 2026",
  groupItemTitle: `Candidate ${id}`,
  category: "Politics",
  liquidity: 60_000,
  volume24hr: 800,
  volume: 50_000,
  competitive: 30,
  marketScore: 25,
  outcomes: ["Yes", "No"],
  tokenIds: [`yes-${id}`, `no-${id}`],
  bestBid: 0.34,
  bestAsk: 0.38,
  spread: 0.04,
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  endDate: futureEndDate,
  feesEnabled: false,
  negRisk: true,
  enableNegRisk: true,
  ...overrides
});

const longTailSignal = (): MarketSelectionSignal => ({
  spreadScore: 0.4,
  activityScore: 0.2,
  depthScore: 0.5,
  averageSpread: 0.04,
  averageBookAgeMs: 800,
  // Long-tail outcome: low recent trades (below the typical 5 threshold) but the YES
  // book still has reasonable depth for arb participation.
  recentTradeEventsInWindow: 0,
  recentActivityEventsInWindow: 12,
  // Bid notional is thin (typical for minor candidates) — would fail the same-market-arb
  // exit-feasibility gate but is acceptable for negRisk yes-basket / conversion paths.
  bestBidNotionalFloorUsdc: 5,
  bestAskNotionalFloorUsdc: 200,
  bestBidSizeFloorShares: 15,
  bestAskSizeFloorShares: 600,
  topBookLiquidityFloorUsdc: 60,
  freshBookCount: 1,
  twoSidedBookCount: 1
});

describe("Fix K: negative-risk eligibility profile", () => {
  it("admits long-tail negRisk markets with low trade activity that same-market-arb would drop", () => {
    const market = makeMarket("candidate-k");
    const signals = new Map([[market.conditionId, longTailSignal()]]);

    const sameMarketResult = filterMarketsForSelectionEligibility([market], {
      signalsByConditionId: signals,
      profile: "same-market-arb"
    });
    const negRiskResult = filterMarketsForSelectionEligibility([market], {
      signalsByConditionId: signals,
      profile: "negative-risk"
    });

    expect(sameMarketResult).toHaveLength(0);
    expect(negRiskResult).toHaveLength(1);
    expect(negRiskResult[0]?.id).toBe("candidate-k");
  });

  it("still rejects negRisk markets that fail the universal liquidity gate", () => {
    const tooThin = makeMarket("candidate-thin", { liquidity: 100 });
    const signals = new Map([[tooThin.conditionId, longTailSignal()]]);

    const result = filterMarketsForSelectionEligibility([tooThin], {
      signalsByConditionId: signals,
      profile: "negative-risk"
    });

    expect(result).toHaveLength(0);
  });

  it("still rejects negRisk markets at extreme prices (universal gate)", () => {
    const extreme = makeMarket("candidate-extreme", {
      bestBid: 0.02,
      bestAsk: 0.04
    });
    const signals = new Map([[extreme.conditionId, longTailSignal()]]);

    const result = filterMarketsForSelectionEligibility([extreme], {
      signalsByConditionId: signals,
      profile: "negative-risk"
    });

    expect(result).toHaveLength(0);
  });
});
