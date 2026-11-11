import type { BuyFill, SellFill } from "../types.js";

const estimateTradeFee = (
  shares: number,
  averagePrice: number,
  feeRateBps: number,
  feePriceExponent: number
): number => {
  if (feeRateBps <= 0) {
    return 0;
  }

  const symmetricPrice = Math.min(averagePrice, 1 - averagePrice);
  const probabilityFactor = symmetricPrice ** feePriceExponent;
  return shares * probabilityFactor * (feeRateBps / 10_000);
};

export const estimateBuyFee = (
  fill: BuyFill,
  feeRateBps: number,
  feePriceExponent: number
): number => estimateTradeFee(fill.shares, fill.averagePrice, feeRateBps, feePriceExponent);

export const estimateSellFee = (
  fill: SellFill,
  feeRateBps: number,
  feePriceExponent: number
): number => estimateTradeFee(fill.shares, fill.averagePrice, feeRateBps, feePriceExponent);
