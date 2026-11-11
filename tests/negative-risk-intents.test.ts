import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  buildNegativeRiskIntents,
  getNegativeRiskConditionIds
} from "../src/core/negative-risk-intents.js";
import type {
  NegativeRiskGroup,
  NegativeRiskNoConversionOpportunity,
  NegativeRiskYesBasketOpportunity
} from "../src/strategy/negative-risk.js";
import type { BinaryMarket } from "../src/types.js";

const makeMarket = (
  id: string,
  slug: string,
  groupItemTitle: string
): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: `question-${id}`,
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

const group: NegativeRiskGroup = {
  eventId: "event-1",
  eventSlug: "sample-event",
  eventTitle: "Sample event",
  marketId: "market-id",
  markets: [
    makeMarket("1", "outcome-a", "Outcome A"),
    makeMarket("2", "outcome-b", "Outcome B")
  ]
};

const opportunity: NegativeRiskYesBasketOpportunity = {
  kind: "yes-basket",
  group,
  shares: 6,
  grossCost: 5.4,
  grossCostPerShare: 0.9,
  grossEdge: 0.6,
  feeCost: 0,
  netEdge: 0.6,
  netEdgeBpsOnPar: 1000,
  detectedAtMs: 123,
  legs: [
    {
      market: group.markets[0]!,
      tokenId: "yes-1",
      outcomeTitle: "Outcome A",
      fill: {
        shares: 6,
        totalCost: 1.8,
        averagePrice: 0.3,
        worstPrice: 0.3
      },
      tickSize: 0.01,
      limitPrice: 0.3,
      feeRateBps: 0
    },
    {
      market: group.markets[1]!,
      tokenId: "yes-2",
      outcomeTitle: "Outcome B",
      fill: {
        shares: 6,
        totalCost: 3.6,
        averagePrice: 0.6,
        worstPrice: 0.6
      },
      tickSize: 0.01,
      limitPrice: 0.6,
      feeRateBps: 0
    }
  ]
};

const conversionOpportunity: NegativeRiskNoConversionOpportunity = {
  kind: "no-to-yes-conversion",
  group,
  shares: 4,
  grossCost: 1.6,
  grossCostPerShare: 0.4,
  grossEdge: 0.7,
  feeCost: 0.05,
  netEdge: 0.65,
  netEdgeBpsOnPar: 1625,
  detectedAtMs: 456,
  entry: {
    market: group.markets[0]!,
    tokenId: "no-1",
    outcomeTitle: "No: Outcome A",
    fill: {
      shares: 4,
      totalCost: 1.6,
      averagePrice: 0.4,
      worstPrice: 0.4
    },
    tickSize: 0.01,
    limitPrice: 0.4,
    feeRateBps: 0
  },
  exitLegs: [
    {
      market: group.markets[1]!,
      tokenId: "yes-2",
      outcomeTitle: "Outcome B",
      fill: {
        shares: 4,
        totalProceeds: 2.1,
        averagePrice: 0.525,
        worstPrice: 0.52
      },
      tickSize: 0.01,
      limitPrice: 0.52,
      feeRateBps: 0
    }
  ],
  grossProceeds: 2.1,
  convertedSharesPerLeg: 4,
  conversionFeeBps: 0,
  conversionMarketId: "0x0000000000000000000000000000000000000000000000000000000000000100",
  conversionIndexSet: "0x2",
  sourceQuestionIndex: 1
};

describe("negative-risk intent adapters", () => {
  it("builds one aggressive BUY intent per yes-basket leg", () => {
    const intents = buildNegativeRiskIntents(opportunity);

    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.strategy === "negative-risk")).toBe(true);
    expect(intents.every((intent) => intent.side === "BUY")).toBe(true);
    expect(
      intents.every((intent) => intent.tif === config.execution.aggressiveEntryOrderType)
    ).toBe(true);
    expect(intents.map((intent) => intent.conditionId)).toEqual([
      "condition-1",
      "condition-2"
    ]);
  });

  it("returns unique condition ids for market-maker preemption", () => {
    expect(getNegativeRiskConditionIds(opportunity)).toEqual([
      "condition-1",
      "condition-2"
    ]);
  });

  it("builds one aggressive BUY intent for a conversion entry and preempts all touched conditions", () => {
    const intents = buildNegativeRiskIntents(conversionOpportunity);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual(
      expect.objectContaining({
        strategy: "negative-risk",
        conditionId: "condition-1",
        tokenId: "no-1",
        side: "BUY",
        tif: config.execution.aggressiveEntryOrderType
      })
    );
    expect(getNegativeRiskConditionIds(conversionOpportunity)).toEqual([
      "condition-1",
      "condition-2"
    ]);
  });
});
