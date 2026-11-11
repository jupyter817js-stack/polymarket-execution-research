import type { StrategyName } from "./types.js";

export interface InventoryLotInput {
  lotId: string;
  strategy: StrategyName;
  tokenId: string;
  marketScope: string;
  conditionId?: string;
  outcome?: string;
  shares: number;
  totalCostUsdc: number;
  openedAtMs: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface TrackedInventoryPosition {
  tokenId: string;
  marketScope: string;
  conditionId?: string;
  outcome?: string;
  shares: number;
  totalCostUsdc: number;
  openedAtMs: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface InventoryCloseInput {
  tokenId: string;
  shares: number;
  proceedsUsdc: number;
  closedAtMs: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface InventoryRealizationPiece {
  lotId: string;
  strategy: StrategyName;
  tokenId: string;
  marketScope: string;
  conditionId?: string;
  outcome?: string;
  shares: number;
  costBasisUsdc: number;
  proceedsUsdc: number;
  realizedPnlUsdc: number;
  openedAtMs: number;
  closedAtMs: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface InventoryCloseResult {
  pieces: InventoryRealizationPiece[];
  closedKnownShares: number;
  closedUnknownShares: number;
  recognizedCostBasisUsdc: number;
  recognizedProceedsUsdc: number;
  unrecognizedProceedsUsdc: number;
}

export interface InventoryLotSnapshot {
  lotId: string;
  strategy: StrategyName;
  tokenId: string;
  marketScope: string;
  conditionId?: string;
  outcome?: string;
  shares: number;
  totalCostUsdc: number;
  openedAtMs: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface VenueInventoryReconciliationInput {
  tokenId: string;
  marketScope: string;
  conditionId?: string;
  outcome?: string;
  venueBalance: number;
  estimatedAverageCostUsdcPerShare: number;
  reconciledAtMs: number;
  strategy?: StrategyName;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export type InventoryLotState = Omit<InventoryLotInput, "shares" | "totalCostUsdc"> & {
  sharesRemaining: number;
  totalCostRemainingUsdc: number;
};

const EPSILON = 1e-9;
const VENUE_SYNC_LOT_PREFIX = "venue-sync:";

const cloneMetadata = (
  metadata?: Record<string, string | number | boolean | null | undefined>
): Record<string, string | number | boolean | null | undefined> | undefined =>
  metadata ? { ...metadata } : undefined;

const isVenueSyncLotId = (lotId: string): boolean => lotId.startsWith(VENUE_SYNC_LOT_PREFIX);

export class InventoryLotTracker {
  private readonly lotsByTokenId = new Map<string, InventoryLotState[]>();

  addLot(input: InventoryLotInput): void {
    if (!(input.shares > EPSILON) || !(input.totalCostUsdc >= 0)) {
      return;
    }

    const existing = this.lotsByTokenId.get(input.tokenId) ?? [];
    existing.push({
      ...input,
      sharesRemaining: input.shares,
      totalCostRemainingUsdc: input.totalCostUsdc,
      metadata: cloneMetadata(input.metadata)
    });
    this.lotsByTokenId.set(input.tokenId, existing);
  }

  closeLots(input: InventoryCloseInput): InventoryCloseResult {
    if (!(input.shares > EPSILON)) {
      return {
        pieces: [],
        closedKnownShares: 0,
        closedUnknownShares: 0,
        recognizedCostBasisUsdc: 0,
        recognizedProceedsUsdc: 0,
        unrecognizedProceedsUsdc: 0
      };
    }

    const lots = this.lotsByTokenId.get(input.tokenId) ?? [];
    const pieces: InventoryRealizationPiece[] = [];
    let remainingShares = input.shares;
    let recognizedCostBasisUsdc = 0;
    let recognizedProceedsUsdc = 0;

    while (remainingShares > EPSILON && lots.length > 0) {
      const currentLot = lots[0]!;
      const closedShares = Math.min(currentLot.sharesRemaining, remainingShares);

      if (!(closedShares > EPSILON)) {
        lots.shift();
        continue;
      }

      const costBasisUsdc =
        currentLot.totalCostRemainingUsdc * (closedShares / currentLot.sharesRemaining);
      const proceedsUsdc = input.proceedsUsdc * (closedShares / input.shares);

      currentLot.sharesRemaining -= closedShares;
      currentLot.totalCostRemainingUsdc -= costBasisUsdc;
      remainingShares -= closedShares;
      recognizedCostBasisUsdc += costBasisUsdc;
      recognizedProceedsUsdc += proceedsUsdc;

      pieces.push({
        lotId: currentLot.lotId,
        strategy: currentLot.strategy,
        tokenId: currentLot.tokenId,
        marketScope: currentLot.marketScope,
        conditionId: currentLot.conditionId,
        outcome: currentLot.outcome,
        shares: closedShares,
        costBasisUsdc,
        proceedsUsdc,
        realizedPnlUsdc: proceedsUsdc - costBasisUsdc,
        openedAtMs: currentLot.openedAtMs,
        closedAtMs: input.closedAtMs,
        metadata: {
          ...cloneMetadata(currentLot.metadata),
          ...cloneMetadata(input.metadata)
        }
      });

      if (currentLot.sharesRemaining <= EPSILON) {
        lots.shift();
      }
    }

    if (lots.length === 0) {
      this.lotsByTokenId.delete(input.tokenId);
    } else {
      this.lotsByTokenId.set(input.tokenId, lots);
    }

    const closedUnknownShares = Math.max(0, remainingShares);
    const unrecognizedProceedsUsdc =
      closedUnknownShares > EPSILON ? input.proceedsUsdc * (closedUnknownShares / input.shares) : 0;

    return {
      pieces,
      closedKnownShares: pieces.reduce((total, piece) => total + piece.shares, 0),
      closedUnknownShares,
      recognizedCostBasisUsdc,
      recognizedProceedsUsdc,
      unrecognizedProceedsUsdc
    };
  }

  /** Force-remove ALL lots for a tokenId. Used when reconciliation detects the venue
   * actually has zero sellable shares while our tracker still holds phantom lots
   * (e.g. from missed user-ws fill events that were already confirmed on-chain).
   * Returns the number of lots removed. */
  purgeTokenLots(tokenId: string, reason: string): number {
    const lots = this.lotsByTokenId.get(tokenId);
    if (!lots || lots.length === 0) return 0;
    const removed = lots.length;
    this.lotsByTokenId.delete(tokenId);
    return removed;
  }

  /**
   * Fix N: dust auto-cleanup.
   *
   * Removes lots whose sharesRemaining is at or below the configured dust threshold
   * (typical: < 0.05 shares). Returns the list of removed lots so callers can record
   * the foregone cost basis as realized loss in the PnL engine.
   *
   * Why this exists: emergency unwind sometimes leaves residual fragments (≤ 0.01 share)
   * that cannot be re-sold (Polymarket rejects orders below MIN_ORDER_SIZE). Without
   * cleanup these dust lots keep the bot in DEGRADED state forever.
   */
  pruneDustLots(thresholdShares: number): InventoryLotState[] {
    if (!(thresholdShares > 0)) return [];
    const removed: InventoryLotState[] = [];

    for (const [tokenId, lots] of this.lotsByTokenId.entries()) {
      const surviving: InventoryLotState[] = [];
      for (const lot of lots) {
        if (lot.sharesRemaining > thresholdShares + EPSILON) {
          surviving.push(lot);
        } else {
          removed.push(lot);
        }
      }
      if (surviving.length === 0) {
        this.lotsByTokenId.delete(tokenId);
      } else if (surviving.length !== lots.length) {
        this.lotsByTokenId.set(tokenId, surviving);
      }
    }

    return removed;
  }

  consumeVenueSyncShares(tokenId: string, shares: number): number {
    if (!(shares > EPSILON)) {
      return 0;
    }

    const lots = this.lotsByTokenId.get(tokenId) ?? [];

    if (lots.length === 0) {
      return 0;
    }

    let remainingShares = shares;
    let consumedShares = 0;
    const nextLots: InventoryLotState[] = [];

    for (const lot of lots) {
      if (!isVenueSyncLotId(lot.lotId) || remainingShares <= EPSILON) {
        nextLots.push(lot);
        continue;
      }

      const removedShares = Math.min(lot.sharesRemaining, remainingShares);

      if (!(removedShares > EPSILON)) {
        nextLots.push(lot);
        continue;
      }

      const nextSharesRemaining = lot.sharesRemaining - removedShares;
      const nextTotalCostRemainingUsdc =
        lot.sharesRemaining > EPSILON
          ? lot.totalCostRemainingUsdc * (nextSharesRemaining / lot.sharesRemaining)
          : 0;

      consumedShares += removedShares;
      remainingShares -= removedShares;

      if (nextSharesRemaining > EPSILON) {
        nextLots.push({
          ...lot,
          sharesRemaining: nextSharesRemaining,
          totalCostRemainingUsdc: nextTotalCostRemainingUsdc
        });
      }
    }

    if (nextLots.length === 0) {
      this.lotsByTokenId.delete(tokenId);
    } else {
      this.lotsByTokenId.set(tokenId, nextLots);
    }

    return consumedShares;
  }

  reconcileVenuePosition(input: VenueInventoryReconciliationInput): boolean {
    if (!(input.venueBalance >= 0) || !(input.reconciledAtMs > 0)) {
      return false;
    }

    const lots = this.lotsByTokenId.get(input.tokenId) ?? [];
    const realLots = lots.filter((lot) => !isVenueSyncLotId(lot.lotId));
    const venueSyncLots = lots.filter((lot) => isVenueSyncLotId(lot.lotId));
    const realShares = realLots.reduce((total, lot) => total + lot.sharesRemaining, 0);
    const existingVenueSyncLot = venueSyncLots[0];
    const desiredVenueSyncShares = Math.max(0, input.venueBalance - realShares);
    const nextLots = [...realLots];
    let changed = venueSyncLots.length > 1;

    if (desiredVenueSyncShares > EPSILON) {
      const estimatedAverageCostUsdcPerShare =
        existingVenueSyncLot && existingVenueSyncLot.sharesRemaining > EPSILON
          ? existingVenueSyncLot.totalCostRemainingUsdc / existingVenueSyncLot.sharesRemaining
          : Math.max(0, input.estimatedAverageCostUsdcPerShare);
      const nextVenueSyncLot: InventoryLotState = {
        lotId: `${VENUE_SYNC_LOT_PREFIX}${input.tokenId}`,
        strategy: input.strategy ?? "market-making",
        tokenId: input.tokenId,
        marketScope: input.marketScope,
        conditionId: input.conditionId,
        outcome: input.outcome,
        openedAtMs: existingVenueSyncLot?.openedAtMs ?? input.reconciledAtMs,
        metadata: {
          inventorySource: "venue-sync",
          costBasis: "estimated",
          ...cloneMetadata(existingVenueSyncLot?.metadata),
          ...cloneMetadata(input.metadata)
        },
        sharesRemaining: desiredVenueSyncShares,
        totalCostRemainingUsdc: desiredVenueSyncShares * estimatedAverageCostUsdcPerShare
      };
      const existingVenueSyncShares = existingVenueSyncLot?.sharesRemaining ?? 0;
      const existingVenueSyncCostUsdc = existingVenueSyncLot?.totalCostRemainingUsdc ?? 0;

      if (
        Math.abs(existingVenueSyncShares - nextVenueSyncLot.sharesRemaining) > EPSILON ||
        Math.abs(existingVenueSyncCostUsdc - nextVenueSyncLot.totalCostRemainingUsdc) > EPSILON ||
        existingVenueSyncLot?.marketScope !== nextVenueSyncLot.marketScope ||
        existingVenueSyncLot?.conditionId !== nextVenueSyncLot.conditionId ||
        existingVenueSyncLot?.outcome !== nextVenueSyncLot.outcome
      ) {
        changed = true;
      }

      nextLots.push(nextVenueSyncLot);
    } else if (venueSyncLots.length > 0) {
      changed = true;
    }

    if (nextLots.length === 0) {
      this.lotsByTokenId.delete(input.tokenId);
    } else {
      this.lotsByTokenId.set(
        input.tokenId,
        nextLots.sort(
          (left, right) =>
            left.openedAtMs - right.openedAtMs ||
            left.tokenId.localeCompare(right.tokenId) ||
            left.lotId.localeCompare(right.lotId)
        )
      );
    }

    return changed;
  }

  getOpenShares(tokenId: string): number {
    return (this.lotsByTokenId.get(tokenId) ?? []).reduce(
      (total, lot) => total + lot.sharesRemaining,
      0
    );
  }

  getOpenPosition(tokenId: string): TrackedInventoryPosition | undefined {
    const lots = this.lotsByTokenId.get(tokenId) ?? [];

    if (lots.length === 0) {
      return undefined;
    }

    const firstLot = lots[0]!;
    const shares = lots.reduce((total, lot) => total + lot.sharesRemaining, 0);
    const totalCostUsdc = lots.reduce(
      (total, lot) => total + lot.totalCostRemainingUsdc,
      0
    );
    const openedAtMs = Math.min(...lots.map((lot) => lot.openedAtMs));

    return {
      tokenId,
      marketScope: firstLot.marketScope,
      conditionId: firstLot.conditionId,
      outcome: firstLot.outcome,
      shares,
      totalCostUsdc,
      openedAtMs,
      metadata: cloneMetadata(firstLot.metadata)
    };
  }

  getOpenLotCount(tokenId?: string): number {
    if (tokenId) {
      return (this.lotsByTokenId.get(tokenId) ?? []).length;
    }

    return [...this.lotsByTokenId.values()].reduce((total, lots) => total + lots.length, 0);
  }

  exportOpenLots(): InventoryLotSnapshot[] {
    return [...this.lotsByTokenId.values()]
      .flatMap((lots) =>
        lots.map((lot) => ({
          lotId: lot.lotId,
          strategy: lot.strategy,
          tokenId: lot.tokenId,
          marketScope: lot.marketScope,
          conditionId: lot.conditionId,
          outcome: lot.outcome,
          shares: lot.sharesRemaining,
          totalCostUsdc: lot.totalCostRemainingUsdc,
          openedAtMs: lot.openedAtMs,
          metadata: cloneMetadata(lot.metadata)
        }))
      )
      .sort(
        (left, right) =>
          left.openedAtMs - right.openedAtMs ||
          left.tokenId.localeCompare(right.tokenId) ||
          left.lotId.localeCompare(right.lotId)
      );
  }
}
