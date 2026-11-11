import type { InventoryLotSnapshot } from "./inventory-lot-tracker.js";
import type { NegativeRiskGroup } from "../strategy/negative-risk.js";
import type { BinaryMarket } from "../types.js";
import type { RiskReductionCandidate } from "../trading/risk-reduction-executor.js";

const appendMarketCandidates = (
  market: BinaryMarket,
  seenTokenIds: Set<string>,
  candidates: RiskReductionCandidate[]
): void => {
  for (const [index, tokenId] of market.tokenIds.entries()) {
    if (seenTokenIds.has(tokenId)) {
      continue;
    }

    const outcome = market.outcomes[index];

    if (!outcome) {
      continue;
    }

    seenTokenIds.add(tokenId);
    candidates.push({
      market,
      tokenId,
      outcome
    });
  }
};

export const buildRiskReductionCandidatesFromMarkets = (
  markets: readonly BinaryMarket[]
): RiskReductionCandidate[] => {
  const seenTokenIds = new Set<string>();
  const candidates: RiskReductionCandidate[] = [];

  for (const market of markets) {
    appendMarketCandidates(market, seenTokenIds, candidates);
  }

  return candidates;
};

export const buildRiskReductionCandidatesFromNegativeRiskGroups = (
  groups: readonly NegativeRiskGroup[]
): RiskReductionCandidate[] =>
  buildRiskReductionCandidatesFromMarkets(groups.flatMap((group) => group.markets));

export interface MaxHoldRiskReductionBatch {
  market: BinaryMarket;
  conditionId: string;
  marketScope: string;
  agedTokenIds: readonly string[];
  oldestPositionAgeMs: number;
  candidates: readonly RiskReductionCandidate[];
}

type MaxHoldRiskReductionBatchOptions = {
  nowMs: number;
  maxHoldAfterMs: number;
  selectedConditionIds?: ReadonlySet<string>;
  conditionalExitOverweightRatio?: number;
  maxTokenExposureShares?: number;
};

export const buildMaxHoldRiskReductionBatchesFromOpenLots = (
  lots: readonly InventoryLotSnapshot[],
  resolveMarket: (conditionId: string, marketScope: string) => BinaryMarket | undefined,
  options: MaxHoldRiskReductionBatchOptions
): MaxHoldRiskReductionBatch[] => {
  const lotsByConditionId = new Map<string, InventoryLotSnapshot[]>();

  for (const lot of lots) {
    if (lot.strategy !== "market-making" || !lot.conditionId) {
      continue;
    }

    const existing = lotsByConditionId.get(lot.conditionId) ?? [];
    existing.push(lot);
    lotsByConditionId.set(lot.conditionId, existing);
  }

  const batches: MaxHoldRiskReductionBatch[] = [];

  for (const [conditionId, conditionLots] of lotsByConditionId) {
    if (options.selectedConditionIds?.has(conditionId)) {
      continue;
    }

    const sharesByTokenId = new Map<string, number>();

    for (const lot of conditionLots) {
      sharesByTokenId.set(lot.tokenId, (sharesByTokenId.get(lot.tokenId) ?? 0) + lot.shares);
    }

    const overweightThresholdShares =
      typeof options.maxTokenExposureShares === "number" &&
      Number.isFinite(options.maxTokenExposureShares) &&
      options.maxTokenExposureShares > 0 &&
      typeof options.conditionalExitOverweightRatio === "number" &&
      Number.isFinite(options.conditionalExitOverweightRatio) &&
      options.conditionalExitOverweightRatio > 0
        ? options.maxTokenExposureShares * options.conditionalExitOverweightRatio
        : undefined;
    const agedLots = conditionLots.filter((lot) => {
      if (options.nowMs - lot.openedAtMs < options.maxHoldAfterMs) {
        return false;
      }

      if (overweightThresholdShares === undefined) {
        return true;
      }

      return (sharesByTokenId.get(lot.tokenId) ?? 0) >= overweightThresholdShares;
    });

    if (agedLots.length === 0) {
      continue;
    }

    const marketScope = agedLots[0]!.marketScope;
    const market = resolveMarket(conditionId, marketScope);

    if (!market || market.closed || !market.acceptingOrders || !market.enableOrderBook) {
      continue;
    }

    const seenTokenIds = new Set<string>();
    const candidates: RiskReductionCandidate[] = [];

    for (const lot of agedLots) {
      if (seenTokenIds.has(lot.tokenId) || !market.tokenIds.includes(lot.tokenId)) {
        continue;
      }

      const outcomeIndex = market.tokenIds.indexOf(lot.tokenId);
      const outcome = outcomeIndex >= 0 ? market.outcomes[outcomeIndex] : undefined;

      if (!outcome) {
        continue;
      }

      seenTokenIds.add(lot.tokenId);
      candidates.push({
        market,
        tokenId: lot.tokenId,
        outcome
      });
    }

    if (candidates.length === 0) {
      continue;
    }

    batches.push({
      market,
      conditionId,
      marketScope,
      agedTokenIds: [...seenTokenIds],
      oldestPositionAgeMs: Math.max(
        ...agedLots.map((lot) => Math.max(0, options.nowMs - lot.openedAtMs))
      ),
      candidates
    });
  }

  return batches;
};
