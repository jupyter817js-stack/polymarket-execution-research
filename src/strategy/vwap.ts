import type { BuyFill, OrderBookLevel, SellFill } from "../types.js";

const EPSILON = 1e-9;

export const calculateBuyFill = (
  asksBestFirst: readonly OrderBookLevel[],
  shares: number
): BuyFill | undefined => {
  if (shares <= 0) {
    return undefined;
  }

  let remaining = shares;
  let totalCost = 0;
  let worstPrice = 0;

  for (const level of asksBestFirst) {
    if (remaining <= EPSILON) {
      break;
    }

    if (level.size <= EPSILON) {
      continue;
    }

    const matched = Math.min(remaining, level.size);
    totalCost += matched * level.price;
    remaining -= matched;
    worstPrice = level.price;
  }

  if (remaining > EPSILON) {
    return undefined;
  }

  return {
    shares,
    totalCost,
    averagePrice: totalCost / shares,
    worstPrice
  };
};

export const calculateSellFill = (
  bidsBestFirst: readonly OrderBookLevel[],
  shares: number
): SellFill | undefined => {
  if (shares <= 0) {
    return undefined;
  }

  let remaining = shares;
  let totalProceeds = 0;
  let worstPrice = 0;

  for (const level of bidsBestFirst) {
    if (remaining <= EPSILON) {
      break;
    }

    if (level.size <= EPSILON) {
      continue;
    }

    const matched = Math.min(remaining, level.size);
    totalProceeds += matched * level.price;
    remaining -= matched;
    worstPrice = level.price;
  }

  if (remaining > EPSILON) {
    return undefined;
  }

  return {
    shares,
    totalProceeds,
    averagePrice: totalProceeds / shares,
    worstPrice
  };
};
