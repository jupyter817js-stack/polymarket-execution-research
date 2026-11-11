import { isLiveMarket } from "./live-market-detector.js";
import type { BinaryMarket } from "../types.js";

export type MarketModeFilter = "all" | "live-only" | "pregame-only";

export type OperatorControlStatus = {
  paused: boolean;
  disabledMarkets: string[];
  modeFilter: MarketModeFilter;
};

/**
 * Runtime operator control plane.
 *
 * All methods are synchronous and side-effect free so they can be called
 * safely from an HTTP handler, signal handler, or test without mocking.
 */
export class OperatorControl {
  private paused = false;
  private readonly disabledConditionIds = new Set<string>();
  private modeFilter: MarketModeFilter = "all";

  // ---- pause / resume -------------------------------------------------------

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ---- per-market disable ---------------------------------------------------

  disableMarket(conditionId: string): void {
    this.disabledConditionIds.add(conditionId);
  }

  enableMarket(conditionId: string): void {
    this.disabledConditionIds.delete(conditionId);
  }

  isMarketDisabled(conditionId: string): boolean {
    return this.disabledConditionIds.has(conditionId);
  }

  // ---- live / pregame filter ------------------------------------------------

  setModeFilter(mode: MarketModeFilter): void {
    this.modeFilter = mode;
  }

  getModeFilter(): MarketModeFilter {
    return this.modeFilter;
  }

  /**
   * Returns false when the market should be skipped due to any active control
   * (pause is checked separately — this only handles market-level gates).
   */
  isMarketAllowed(market: BinaryMarket, nowMs = Date.now()): boolean {
    if (this.disabledConditionIds.has(market.conditionId)) {
      return false;
    }

    if (this.modeFilter === "live-only") {
      return isLiveMarket(market, nowMs);
    }

    if (this.modeFilter === "pregame-only") {
      return !isLiveMarket(market, nowMs);
    }

    return true;
  }

  // ---- status ---------------------------------------------------------------

  getStatus(): OperatorControlStatus {
    return {
      paused: this.paused,
      disabledMarkets: [...this.disabledConditionIds],
      modeFilter: this.modeFilter
    };
  }
}
