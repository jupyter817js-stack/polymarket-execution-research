import type { SameMarketOpportunity } from "../types.js";
import type { OrderIntent } from "./types.js";
import { getDefaultStrategyPriority } from "./types.js";
import { getAggressiveEntryTif } from "../trading/order-type-policy.js";

export const buildSameMarketArbIntents = (
  opportunity: SameMarketOpportunity
): OrderIntent[] =>
  opportunity.legs.map((leg, index) => ({
    id: [
      "same-market-arb",
      opportunity.market.conditionId,
      leg.tokenId,
      "BUY",
      String(index),
      String(opportunity.detectedAtMs)
    ].join(":"),
    strategy: "same-market-arb",
    priority: getDefaultStrategyPriority("same-market-arb"),
    conditionId: opportunity.market.conditionId,
    tokenId: leg.tokenId,
    side: "BUY",
    price: leg.limitPrice,
    size: opportunity.shares,
    tif: getAggressiveEntryTif(),
    postOnly: false,
    createdAtMs: opportunity.detectedAtMs,
    reason: "same-market arbitrage full-set entry",
    tags: [
      "same-market-arb",
      leg.outcome.toLowerCase(),
      opportunity.market.negRisk ? "neg-risk-market" : "standard-market"
    ],
    metadata: {
      marketSlug: opportunity.market.slug,
      outcome: leg.outcome,
      grossCostPerShare: Number(opportunity.grossCostPerShare.toFixed(6)),
      netEdge: Number(opportunity.netEdge.toFixed(6))
    }
  }));
