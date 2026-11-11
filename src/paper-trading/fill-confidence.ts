import { config } from "../config.js";
import type { NormalizedOrderBook, SameMarketOpportunity } from "../types.js";
import type { NegativeRiskOpportunity } from "../strategy/negative-risk.js";

export type PaperFillConfidence = "high" | "medium" | "low";

const computeBuyDepthAtLimit = (book: NormalizedOrderBook, limitPrice: number): number =>
  book.asks
    .filter((level) => level.price <= limitPrice + 1e-9)
    .reduce((total, level) => total + level.size, 0);

const computeSellDepthAtLimit = (book: NormalizedOrderBook, limitPrice: number): number =>
  book.bids
    .filter((level) => level.price >= limitPrice - 1e-9)
    .reduce((total, level) => total + level.size, 0);

const getConfidence = (depthCoverageRatio: number): PaperFillConfidence => {
  if (depthCoverageRatio >= config.paper.highConfidenceDepthRatio) {
    return "high";
  }

  if (depthCoverageRatio >= config.paper.mediumConfidenceDepthRatio) {
    return "medium";
  }

  return "low";
};

const safeRatio = (available: number, required: number): number => {
  if (required <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return available / required;
};

export const assessSameMarketPaperFillConfidence = (
  opportunity: SameMarketOpportunity,
  booksByTokenId: ReadonlyMap<string, NormalizedOrderBook>
): {
  depthCoverageRatio: number;
  fillConfidence: PaperFillConfidence;
} => {
  const ratios = opportunity.legs.map((leg) => {
    const book = booksByTokenId.get(leg.tokenId);

    if (!book) {
      return 0;
    }

    return safeRatio(computeBuyDepthAtLimit(book, leg.limitPrice), leg.fill.shares);
  });
  const depthCoverageRatio = Math.min(...ratios);

  return {
    depthCoverageRatio: Number(depthCoverageRatio.toFixed(4)),
    fillConfidence: getConfidence(depthCoverageRatio)
  };
};

export const assessNegativeRiskPaperFillConfidence = (
  opportunity: NegativeRiskOpportunity,
  booksByTokenId: ReadonlyMap<string, NormalizedOrderBook>
): {
  depthCoverageRatio: number;
  fillConfidence: PaperFillConfidence;
} => {
  const ratios =
    opportunity.kind === "yes-basket"
      ? opportunity.legs.map((leg) => {
          const book = booksByTokenId.get(leg.tokenId);

          if (!book) {
            return 0;
          }

          return safeRatio(computeBuyDepthAtLimit(book, leg.limitPrice), leg.fill.shares);
        })
      : [
          (() => {
            const book = booksByTokenId.get(opportunity.entry.tokenId);

            if (!book) {
              return 0;
            }

            return safeRatio(
              computeBuyDepthAtLimit(book, opportunity.entry.limitPrice),
              opportunity.entry.fill.shares
            );
          })(),
          ...opportunity.exitLegs.map((leg) => {
            const book = booksByTokenId.get(leg.tokenId);

            if (!book) {
              return 0;
            }

            return safeRatio(
              computeSellDepthAtLimit(book, leg.limitPrice),
              leg.fill.shares
            );
          })
        ];
  const depthCoverageRatio = Math.min(...ratios);

  return {
    depthCoverageRatio: Number(depthCoverageRatio.toFixed(4)),
    fillConfidence: getConfidence(depthCoverageRatio)
  };
};
