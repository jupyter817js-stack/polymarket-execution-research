import type {
  NegativeRiskNoConversionOpportunity,
  NegativeRiskOpportunity,
  NegativeRiskYesBasketOpportunity
} from "../strategy/negative-risk.js";
import type { OrderIntent } from "./types.js";
import { getDefaultStrategyPriority } from "./types.js";
import { getAggressiveEntryTif } from "../trading/order-type-policy.js";

export const buildNegativeRiskIntents = (
  opportunity: NegativeRiskOpportunity
): OrderIntent[] => {
  const aggressiveEntryTif = getAggressiveEntryTif();

  if (opportunity.kind === "yes-basket") {
    return opportunity.legs.map((leg, index) => ({
      id: [
        "negative-risk",
        opportunity.group.eventId,
        leg.market.conditionId,
        leg.tokenId,
        "BUY",
        String(index),
        String(opportunity.detectedAtMs)
      ].join(":"),
      strategy: "negative-risk",
      priority: getDefaultStrategyPriority("negative-risk"),
      conditionId: leg.market.conditionId,
      tokenId: leg.tokenId,
      side: "BUY",
      price: leg.limitPrice,
      size: opportunity.shares,
      tif: aggressiveEntryTif,
      postOnly: false,
      createdAtMs: opportunity.detectedAtMs,
      reason: "negative-risk yes-basket entry",
      tags: ["negative-risk", "yes-basket", leg.market.slug],
      metadata: {
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        marketSlug: leg.market.slug,
        outcome: leg.outcomeTitle,
        grossCostPerShare: Number(opportunity.grossCostPerShare.toFixed(6)),
        netEdge: Number(opportunity.netEdge.toFixed(6))
      }
    }));
  }

  return buildNegativeRiskConversionIntents(opportunity);
};

const buildNegativeRiskConversionIntents = (
  opportunity: NegativeRiskNoConversionOpportunity
): OrderIntent[] => [
  {
    id: [
      "negative-risk",
      opportunity.group.eventId,
      opportunity.entry.market.conditionId,
      opportunity.entry.tokenId,
      "BUY",
      "conversion-entry",
      String(opportunity.detectedAtMs)
    ].join(":"),
    strategy: "negative-risk",
    priority: getDefaultStrategyPriority("negative-risk"),
    conditionId: opportunity.entry.market.conditionId,
    tokenId: opportunity.entry.tokenId,
    side: "BUY",
    price: opportunity.entry.limitPrice,
    size: opportunity.shares,
    tif: getAggressiveEntryTif(),
    postOnly: false,
    createdAtMs: opportunity.detectedAtMs,
    reason: "negative-risk no-to-yes conversion entry",
    tags: ["negative-risk", "no-to-yes-conversion", opportunity.entry.market.slug],
    metadata: {
      eventId: opportunity.group.eventId,
      eventSlug: opportunity.group.eventSlug,
      marketSlug: opportunity.entry.market.slug,
      outcome: opportunity.entry.outcomeTitle,
      conversionMarketId: opportunity.conversionMarketId,
      conversionIndexSet: opportunity.conversionIndexSet,
      convertedSharesPerLeg: Number(opportunity.convertedSharesPerLeg.toFixed(6)),
      grossCostPerShare: Number(opportunity.grossCostPerShare.toFixed(6)),
      netEdge: Number(opportunity.netEdge.toFixed(6))
    }
  }
];

export const getNegativeRiskConditionIds = (
  opportunity: NegativeRiskOpportunity
): string[] => {
  if (opportunity.kind === "yes-basket") {
    return [...new Set(opportunity.legs.map((leg) => leg.market.conditionId))];
  }

  return [
    ...new Set([
      opportunity.entry.market.conditionId,
      ...opportunity.exitLegs.map((leg) => leg.market.conditionId)
    ])
  ];
};
