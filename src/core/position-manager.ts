import { config } from "../config.js";
import {
  CapitalAllocator,
  computeDynamicScopedCapUsdc,
  mergeScopedSignalsBySource,
  setScopedSignalsBySource,
  type ScopedCapitalSignalEntries
} from "./capital-allocator.js";
import type { BinaryMarket } from "../types.js";
import type { InventoryLotSnapshot } from "./inventory-lot-tracker.js";
import type { RiskState } from "./types.js";
import type {
  ActiveOrderState,
  OrderIntent,
  PositionGateDecision,
  PositionManagerLike,
  RiskStatusSnapshot,
  StrategyName
} from "./types.js";

const EPSILON = 1e-9;

type TokenInventorySnapshot = {
  balance: number;
  allowance: number;
  refreshedAtMs: number;
};

const quoteKey = (
  tokenId: string,
  side: OrderIntent["side"],
  quoteSlot?: string
): string => `${tokenId}:${side}:${quoteSlot ?? "primary"}`;

const isPassiveStrategy = (strategy: StrategyName): boolean =>
  strategy === "market-making" ||
  strategy === "liquidity-rewards" ||
  strategy === "maker-rebates";

export class PositionManager implements PositionManagerLike {
  private readonly capitalAllocator = new CapitalAllocator();
  private readonly marketByTokenId = new Map<string, BinaryMarket>();
  private readonly marketUniverseBySource = new Map<string, readonly BinaryMarket[]>();
  private readonly activeOrderByKey = new Map<string, ActiveOrderState>();
  private readonly inventoryByTokenId = new Map<string, TokenInventorySnapshot>();
  private readonly referencePriceByTokenId = new Map<string, number>();
  private readonly reservedCategoryBuyNotionalByCategory = new Map<string, number>();
  private readonly reservedSellSizeByTokenId = new Map<string, number>();
  private readonly categorySignalsBySource = new Map<string, Map<string, number>>();
  private openInventoryLots: readonly InventoryLotSnapshot[] = [];

  setMarketUniverse(markets: readonly BinaryMarket[], source = "default"): void {
    this.marketUniverseBySource.set(source, markets);
    this.marketByTokenId.clear();

    for (const marketSlice of this.marketUniverseBySource.values()) {
      for (const market of marketSlice) {
        this.marketByTokenId.set(market.tokenIds[0], market);
        this.marketByTokenId.set(market.tokenIds[1], market);
      }
    }
  }

  syncActiveOrders(activeOrders: readonly ActiveOrderState[]): void {
    this.activeOrderByKey.clear();

    for (const activeOrder of activeOrders) {
      this.activeOrderByKey.set(
        quoteKey(activeOrder.tokenId, activeOrder.side, activeOrder.quoteSlot),
        activeOrder
      );
    }
  }

  updateReferencePrice(tokenId: string, referencePrice: number): void {
    this.referencePriceByTokenId.set(tokenId, referencePrice);
  }

  updateTokenInventory(tokenId: string, snapshot: TokenInventorySnapshot): void {
    this.inventoryByTokenId.set(tokenId, snapshot);
  }

  getTokenInventorySnapshot(tokenId: string): TokenInventorySnapshot | undefined {
    const snapshot = this.inventoryByTokenId.get(tokenId);
    return snapshot ? { ...snapshot } : undefined;
  }

  /**
   * Immediately deduct sold shares from the cached balance after a SELL fill.
   * Prevents aggressive-exit intents from being approved against a stale balance
   * when the venue has already committed the shares in "sum of matched orders".
   */
  deductTokenInventoryShares(tokenId: string, shares: number, atMs: number = Date.now()): void {
    const existing = this.inventoryByTokenId.get(tokenId);
    if (!existing) return;
    this.inventoryByTokenId.set(tokenId, {
      balance: Math.max(0, existing.balance - shares),
      allowance: existing.allowance,
      refreshedAtMs: atMs
    });
  }

  syncTrackedInventoryLots(openInventoryLots: readonly InventoryLotSnapshot[]): void {
    this.openInventoryLots = openInventoryLots.map((lot) => ({
      ...lot,
      metadata: lot.metadata ? { ...lot.metadata } : undefined
    }));
  }

  setStrategyCapitalSignal(strategy: StrategyName, score: number): void {
    this.capitalAllocator.setStrategySignal(strategy, score);
  }

  setConditionCapitalSignals(signals: ScopedCapitalSignalEntries, source = "default"): void {
    this.capitalAllocator.setConditionSignals(signals, source);
  }

  setEventCapitalSignals(signals: ScopedCapitalSignalEntries, source = "default"): void {
    this.capitalAllocator.setEventSignals(signals, source);
  }

  setCategoryCapitalSignals(signals: ScopedCapitalSignalEntries, source = "default"): void {
    const normalizedSignals = new Map<string, number>();

    for (const [category, score] of signals) {
      const normalizedCategory = category.trim().toLowerCase();

      if (normalizedCategory.length === 0 || !Number.isFinite(score)) {
        continue;
      }

      normalizedSignals.set(normalizedCategory, score);
    }

    setScopedSignalsBySource(this.categorySignalsBySource, normalizedSignals, source);
  }

  setRiskState(state: RiskState): void {
    this.capitalAllocator.setRiskState(state);
  }

  setRiskSnapshot(snapshot: RiskStatusSnapshot): void {
    this.capitalAllocator.setRiskSnapshot(snapshot);
  }

  beginBatch(): void {
    this.reservedCategoryBuyNotionalByCategory.clear();
    this.reservedSellSizeByTokenId.clear();
    this.capitalAllocator.beginBatch();
  }

  commitApprovedIntent(intent: OrderIntent): void {
    const existingActiveOrder = this.activeOrderByKey.get(
      quoteKey(intent.tokenId, intent.side, intent.quoteSlot)
    );
    this.capitalAllocator.commitApprovedIntent(
      intent,
      this.marketByTokenId,
      existingActiveOrder
    );
    const category = this.getNormalizedCategory(intent.tokenId);

    if (intent.side === "SELL") {
      const existingActiveSellSize =
        existingActiveOrder?.side === "SELL" ? existingActiveOrder.size : 0;
      const incrementalReservedSellSize = Math.max(0, intent.size - existingActiveSellSize);
      const reservedSellSize = this.reservedSellSizeByTokenId.get(intent.tokenId) ?? 0;
      this.reservedSellSizeByTokenId.set(
        intent.tokenId,
        reservedSellSize + incrementalReservedSellSize
      );
      return;
    }

    if (!category || intent.side !== "BUY" || !isPassiveStrategy(intent.strategy)) {
      return;
    }

    const existingBuyNotionalUsdc =
      existingActiveOrder?.strategy === intent.strategy
        ? existingActiveOrder.price * existingActiveOrder.size
        : 0;
    const incrementalBuyNotionalUsdc = Math.max(
      0,
      intent.price * intent.size - existingBuyNotionalUsdc
    );
    const reservedBuyNotionalUsdc =
      this.reservedCategoryBuyNotionalByCategory.get(category) ?? 0;

    this.reservedCategoryBuyNotionalByCategory.set(
      category,
      reservedBuyNotionalUsdc + incrementalBuyNotionalUsdc
    );
  }

  endBatch(): void {
    this.reservedCategoryBuyNotionalByCategory.clear();
    this.reservedSellSizeByTokenId.clear();
    this.capitalAllocator.endBatch();
  }

  evaluateIntent(intent: OrderIntent): PositionGateDecision {
    const budgetDecision = this.capitalAllocator.evaluateIntent(intent, {
      activeOrders: [...this.activeOrderByKey.values()],
      openInventoryLots: this.openInventoryLots,
      marketByTokenId: this.marketByTokenId,
      referencePriceByTokenId: this.referencePriceByTokenId,
      existingActiveOrder: this.activeOrderByKey.get(
        quoteKey(intent.tokenId, intent.side, intent.quoteSlot)
      )
    });

    if (!budgetDecision.allowed) {
      return budgetDecision;
    }

    const inventory = this.inventoryByTokenId.get(intent.tokenId);

    if (intent.side === "SELL") {
      if (!inventory) {
        return {
          allowed: false,
          reason: "insufficient_sellable_inventory",
          detail: "No inventory snapshot is available for this sell intent yet."
        };
      }

      const sellableSize = Math.min(inventory.balance, inventory.allowance);
      const existingActiveOrder = this.activeOrderByKey.get(
        quoteKey(intent.tokenId, intent.side, intent.quoteSlot)
      );
      const existingActiveSellSize =
        existingActiveOrder?.side === "SELL" ? existingActiveOrder.size : 0;
      // Other quoteSlots' active SELL orders for this token are already committed at the
      // venue level and must be subtracted from sellable capacity to avoid over-committing.
      const otherActiveSlotsSellSize =
        [...this.activeOrderByKey.values()]
          .filter((o) => o.tokenId === intent.tokenId && o.side === "SELL")
          .reduce((sum, o) => sum + o.size, 0) - existingActiveSellSize;
      const effectiveSellableSize = sellableSize - otherActiveSlotsSellSize;
      const projectedReservedSellSize =
        (this.reservedSellSizeByTokenId.get(intent.tokenId) ?? 0) +
        Math.max(0, intent.size - existingActiveSellSize);

      if (effectiveSellableSize + EPSILON < projectedReservedSellSize) {
        return {
          allowed: false,
          reason: "insufficient_sellable_inventory",
          detail: `effectiveSellableSize(${effectiveSellableSize.toFixed(4)}) < projectedReservedSellSize(${projectedReservedSellSize.toFixed(4)})`
        };
      }

      return {
        allowed: true
      };
    }

    if (!isPassiveStrategy(intent.strategy)) {
      return {
        allowed: true
      };
    }

    const currentBalance = inventory?.balance ?? 0;

    if (currentBalance >= config.marketMaker.maxTokenExposureShares - EPSILON) {
      return {
        allowed: false,
        reason: "token_exposure_cap_reached",
        detail: `currentBalance(${currentBalance.toFixed(4)}) >= maxTokenExposureShares(${config.marketMaker.maxTokenExposureShares.toFixed(4)})`
      };
    }

    const normalizedCategory = this.getNormalizedCategory(intent.tokenId);

    if (!normalizedCategory || config.marketMaker.maxCategoryExposureUsdc <= 0) {
      return {
        allowed: true
      };
    }

    const categoryExposure = this.getCategoryExposureSnapshot(normalizedCategory);
    const existingActiveOrder = this.activeOrderByKey.get(
      quoteKey(intent.tokenId, intent.side, intent.quoteSlot)
    );
    const existingBuyNotionalUsdc =
      existingActiveOrder?.strategy === intent.strategy &&
      existingActiveOrder.side === "BUY"
        ? existingActiveOrder.price * existingActiveOrder.size
        : 0;
    const incrementalBuyNotionalUsdc = Math.max(
      0,
      intent.price * intent.size - existingBuyNotionalUsdc
    );
    const reservedBuyNotionalUsdc =
      this.reservedCategoryBuyNotionalByCategory.get(normalizedCategory) ?? 0;
    const projectedCategoryExposureUsdc =
      categoryExposure.inventoryNotionalUsdc +
      categoryExposure.activeBuyNotionalUsdc +
      reservedBuyNotionalUsdc +
      incrementalBuyNotionalUsdc;
    const categoryExposureCapUsdc = this.getCategoryExposureCapUsdc(normalizedCategory);

    if (
      incrementalBuyNotionalUsdc > 0 &&
      projectedCategoryExposureUsdc > categoryExposureCapUsdc + EPSILON
    ) {
      return {
        allowed: false,
        reason: "category_exposure_cap_exceeded",
        detail: `projectedCategoryExposureUsdc(${projectedCategoryExposureUsdc.toFixed(4)}) > categoryExposureCapUsdc(${categoryExposureCapUsdc.toFixed(4)})`,
        projectedExposureUsdc: projectedCategoryExposureUsdc
      };
    }

    return {
      allowed: true,
      projectedExposureUsdc: projectedCategoryExposureUsdc
    };
  }

  private getNormalizedCategory(tokenId: string): string | undefined {
    const category = this.marketByTokenId.get(tokenId)?.category?.trim().toLowerCase();
    return category && category.length > 0 ? category : undefined;
  }

  private getCategoryExposureCapUsdc(normalizedCategory: string): number {
    return computeDynamicScopedCapUsdc({
      staticCapUsdc:
        config.marketMaker.maxCategoryExposureUsdc *
        this.capitalAllocator.getPassiveCategoryRiskBudgetMultiplier(),
      scopeId: normalizedCategory,
      signalByScope: mergeScopedSignalsBySource(this.categorySignalsBySource),
      enableDynamicReallocation: config.capital.enableDynamicScopeReallocation,
      reallocationIntensity: config.capital.scopeReallocationIntensity,
      signalFloor: config.capital.scopeSignalFloor
    });
  }

  private getCategoryExposureSnapshot(normalizedCategory: string): {
    inventoryNotionalUsdc: number;
    activeBuyNotionalUsdc: number;
  } {
    const categoryTokenIds = [...this.marketByTokenId.entries()]
      .filter(([, market]) => market.category?.trim().toLowerCase() === normalizedCategory)
      .map(([tokenId]) => tokenId);
    let inventoryNotionalUsdc = 0;

    for (const tokenId of categoryTokenIds) {
      const snapshot = this.inventoryByTokenId.get(tokenId);
      const referencePrice = this.referencePriceByTokenId.get(tokenId) ?? 0.5;

      if (!snapshot) {
        continue;
      }

      inventoryNotionalUsdc += snapshot.balance * referencePrice;
    }

    const activeBuyNotionalUsdc = [...this.activeOrderByKey.values()]
      .filter(
        (order) =>
          order.side === "BUY" &&
          this.marketByTokenId.get(order.tokenId)?.category?.trim().toLowerCase() === normalizedCategory
      )
      .reduce((total, order) => total + order.price * order.size, 0);

    return {
      inventoryNotionalUsdc,
      activeBuyNotionalUsdc
    };
  }
}
