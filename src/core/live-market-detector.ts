import type { BinaryMarket } from "../types.js";

/**
 * Returns true when the current time is at or past the market's scheduled
 * game-start time. Only relevant for sports markets that carry a gameStartTime.
 * Pre-match and non-sports markets always return false.
 */
export const isLiveMarket = (market: BinaryMarket, nowMs = Date.now()): boolean => {
  if (!market.gameStartTime) {
    return false;
  }

  const gameStartMs = Date.parse(market.gameStartTime);
  return Number.isFinite(gameStartMs) && nowMs >= gameStartMs;
};
