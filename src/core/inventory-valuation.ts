import type { InventoryLotTracker } from "./inventory-lot-tracker.js";
import type { InventoryValuationSnapshot } from "./types.js";

const round = (value: number): number => Number(value.toFixed(8));
const EPSILON = 1e-9;

export const buildInventoryValuationSnapshot = (input: {
  inventoryTracker: InventoryLotTracker;
  getMarkPriceForToken: (tokenId: string) => number | undefined;
  // 🔄 Optional venue-share getter. When supplied, valuation prefers the
  // venue's reported share count over the local lot tracker so the
  // operator-status alert matches what the Polymarket site shows. The local
  // lot count is still used to compute cost basis (since venue doesn't expose
  // per-share cost), but mark value is computed against the venue share count.
  getKnownVenueShares?: (tokenId: string) => number | undefined;
}): InventoryValuationSnapshot => {
  const openLots = input.inventoryTracker.exportOpenLots();
  const uniqueTokenIds = [...new Set(openLots.map((lot) => lot.tokenId))];
  let openInventoryCostUsdc = 0;
  let openInventoryMarkValueUsdc = 0;
  let pricedOpenTokenCount = 0;
  let unpricedOpenTokenCount = 0;
  // 🔄 Drift accounting — quantifies local-vs-venue inventory mismatch in USDC
  // terms so the operator-status alert can flag sync drift to the user.
  let venueDriftAbsValueUsdc = 0;
  let venueDriftSignedShares = 0;
  let venueDriftTokenCount = 0;

  for (const tokenId of uniqueTokenIds) {
    const position = input.inventoryTracker.getOpenPosition(tokenId);

    if (!position) {
      continue;
    }

    openInventoryCostUsdc += position.totalCostUsdc;
    const markPrice = input.getMarkPriceForToken(tokenId);
    const localShares = position.shares;
    const venueShares = input.getKnownVenueShares?.(tokenId);
    const hasVenueShares = typeof venueShares === "number" && Number.isFinite(venueShares);
    // Prefer venue-known shares so the totals reconcile with the on-chain
    // collateral balance the Polymarket site displays. Fall back to local
    // lot tracker when venue data is unavailable.
    const effectiveShares = hasVenueShares ? Math.max(0, venueShares!) : localShares;

    if (hasVenueShares && Math.abs(localShares - venueShares!) > EPSILON) {
      venueDriftTokenCount += 1;
      venueDriftSignedShares += localShares - venueShares!;
      const driftPrice =
        typeof markPrice === "number" && Number.isFinite(markPrice) && markPrice >= 0
          ? markPrice
          : (position.totalCostUsdc / Math.max(localShares, EPSILON));
      venueDriftAbsValueUsdc += Math.abs(localShares - venueShares!) * driftPrice;
    }

    if (typeof markPrice === "number" && Number.isFinite(markPrice) && markPrice >= 0) {
      openInventoryMarkValueUsdc += effectiveShares * markPrice;
      pricedOpenTokenCount += 1;
      continue;
    }

    // Unpriced fallback — value at cost basis. When venue shares differ from
    // local, scale cost proportionally so we don't over-count cost on phantom
    // inventory.
    const costScale = localShares > EPSILON ? effectiveShares / localShares : 0;
    openInventoryMarkValueUsdc += position.totalCostUsdc * costScale;
    unpricedOpenTokenCount += 1;
  }

  return {
    openInventoryCostUsdc: round(openInventoryCostUsdc),
    openInventoryMarkValueUsdc: round(openInventoryMarkValueUsdc),
    openInventoryUnrealizedPnlUsdc: round(openInventoryMarkValueUsdc - openInventoryCostUsdc),
    pricedOpenTokenCount,
    unpricedOpenTokenCount,
    venueDriftTokenCount,
    venueDriftAbsValueUsdc: round(venueDriftAbsValueUsdc),
    venueDriftSignedShares: round(venueDriftSignedShares)
  };
};
