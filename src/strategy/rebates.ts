import { config, type RebateCategoryRule } from "../config.js";

const EPSILON = 1e-9;

export interface MakerRebateEstimate {
  feeEquivalentUsdc: number;
  maxPotentialRebateUsdc: number;
  makerRebatePct: number;
  categoryRuleApplied: boolean;
}

export const estimateRebateEfficiencyScore = (price: number, category?: string): number => {
  const rule = resolveRebateCategoryRule(category);

  if (!rule || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return 0;
  }

  const current = estimateFeeEquivalentUsdc(1, price, rule);
  const peak = estimateFeeEquivalentUsdc(1, 0.5, rule);

  if (peak <= EPSILON) {
    return 0;
  }

  return Math.max(0, Math.min(1, current / peak));
};

export const normalizeCategoryKey = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const resolveRebateCategoryRule = (
  category: string | undefined
): RebateCategoryRule | undefined => {
  const normalized = normalizeCategoryKey(category);

  if (!normalized) {
    return undefined;
  }

  return config.rebates.categoryRules[normalized];
};

export const estimateFeeEquivalentUsdc = (
  shares: number,
  price: number,
  rule: RebateCategoryRule
): number => {
  if (!Number.isFinite(shares) || !Number.isFinite(price) || shares <= 0 || price <= 0 || price >= 1) {
    return 0;
  }

  const symmetricPrice = Math.min(price, 1 - price);

  if (symmetricPrice <= 0) {
    return 0;
  }

  return shares * rule.feeRate * symmetricPrice ** rule.exponent;
};

export const estimateMakerRebate = (params: {
  shares: number;
  price: number;
  category?: string;
}): MakerRebateEstimate => {
  const rule = resolveRebateCategoryRule(params.category);

  if (!rule) {
    return {
      feeEquivalentUsdc: 0,
      maxPotentialRebateUsdc: 0,
      makerRebatePct: 0,
      categoryRuleApplied: false
    };
  }

  const feeEquivalentUsdc = estimateFeeEquivalentUsdc(params.shares, params.price, rule);
  const maxPotentialRebateUsdc =
    feeEquivalentUsdc > EPSILON ? feeEquivalentUsdc * rule.makerRebatePct : 0;

  return {
    feeEquivalentUsdc,
    maxPotentialRebateUsdc,
    makerRebatePct: rule.makerRebatePct,
    categoryRuleApplied: true
  };
};
