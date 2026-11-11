import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { buildSameMarketArbIntents } from "../src/core/same-market-arb-intents.js";
import type { BinaryMarket, SameMarketOpportunity } from "../src/types.js";

const market: BinaryMarket = {
  id: "1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "BitBoy convicted?",
  slug: "bitboy-convicted",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: false
};

const opportunity: SameMarketOpportunity = {
  market,
  shares: 5,
  grossCost: 4.9,
  grossCostPerShare: 0.98,
  grossEdge: 0.1,
  feeCost: 0,
  netEdge: 0.1,
  netEdgeBpsOnPar: 200,
  legs: [
    {
      tokenId: "yes-token",
      outcome: "Yes",
      fill: {
        shares: 5,
        totalCost: 1.5,
        averagePrice: 0.3,
        worstPrice: 0.3
      },
      tickSize: 0.01,
      limitPrice: 0.3,
      feeRateBps: 0
    },
    {
      tokenId: "no-token",
      outcome: "No",
      fill: {
        shares: 5,
        totalCost: 3.4,
        averagePrice: 0.68,
        worstPrice: 0.68
      },
      tickSize: 0.01,
      limitPrice: 0.68,
      feeRateBps: 0
    }
  ],
  detectedAtMs: 123
};

describe("same-market arbitrage intent adapters", () => {
  it("builds one aggressive BUY intent per arbitrage leg", () => {
    const intents = buildSameMarketArbIntents(opportunity);

    expect(intents).toHaveLength(2);
    expect(intents.map((intent) => intent.tokenId)).toEqual(["yes-token", "no-token"]);
    expect(intents.every((intent) => intent.strategy === "same-market-arb")).toBe(true);
    expect(intents.every((intent) => intent.side === "BUY")).toBe(true);
    expect(
      intents.every((intent) => intent.tif === config.execution.aggressiveEntryOrderType)
    ).toBe(true);
    expect(intents.every((intent) => intent.postOnly === false)).toBe(true);
  });
});
