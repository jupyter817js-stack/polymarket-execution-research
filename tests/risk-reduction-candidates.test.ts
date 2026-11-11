import { describe, expect, it } from "vitest";

import { buildMaxHoldRiskReductionBatchesFromOpenLots } from "../src/core/risk-reduction-candidates.js";
import type { InventoryLotSnapshot } from "../src/core/inventory-lot-tracker.js";
import type { BinaryMarket } from "../src/types.js";

const market: BinaryMarket = {
  id: "market-1",
  conditionId: "condition-1",
  questionId: "question-1",
  question: "Will BTC be above 120k?",
  slug: "btc-above-120k",
  category: "Crypto",
  outcomes: ["Yes", "No"],
  tokenIds: ["yes-token", "no-token"],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: false
};

describe("buildMaxHoldRiskReductionBatchesFromOpenLots", () => {
  it("builds an off-universe stale inventory batch for aged market-making lots", () => {
    const nowMs = Date.now();
    const lots: InventoryLotSnapshot[] = [
      {
        lotId: "lot-1",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: market.slug,
        conditionId: market.conditionId,
        outcome: "Yes",
        shares: 8,
        totalCostUsdc: 4,
        openedAtMs: nowMs - 7_200_000
      },
      {
        lotId: "lot-2",
        strategy: "market-making",
        tokenId: "no-token",
        marketScope: market.slug,
        conditionId: market.conditionId,
        outcome: "No",
        shares: 4,
        totalCostUsdc: 2,
        openedAtMs: nowMs - 5_400_000
      }
    ];

    const batches = buildMaxHoldRiskReductionBatchesFromOpenLots(
      lots,
      () => market,
      {
        nowMs,
        maxHoldAfterMs: 3_600_000,
        selectedConditionIds: new Set(["another-condition"])
      }
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(
      expect.objectContaining({
        market,
        conditionId: market.conditionId,
        marketScope: market.slug,
        agedTokenIds: ["yes-token", "no-token"]
      })
    );
    expect(batches[0]?.candidates).toEqual([
      {
        market,
        tokenId: "yes-token",
        outcome: "Yes"
      },
      {
        market,
        tokenId: "no-token",
        outcome: "No"
      }
    ]);
  });

  it("skips conditions that are still inside the selected universe", () => {
    const nowMs = Date.now();
    const lots: InventoryLotSnapshot[] = [
      {
        lotId: "lot-1",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: market.slug,
        conditionId: market.conditionId,
        outcome: "Yes",
        shares: 8,
        totalCostUsdc: 4,
        openedAtMs: nowMs - 7_200_000
      }
    ];

    const batches = buildMaxHoldRiskReductionBatchesFromOpenLots(
      lots,
      () => market,
      {
        nowMs,
        maxHoldAfterMs: 3_600_000,
        selectedConditionIds: new Set([market.conditionId])
      }
    );

    expect(batches).toHaveLength(0);
  });

  it("includes selected-universe stale lots when no selected condition filter is provided", () => {
    const nowMs = Date.now();
    const lots: InventoryLotSnapshot[] = [
      {
        lotId: "lot-1",
        strategy: "market-making",
        tokenId: "yes-token",
        marketScope: market.slug,
        conditionId: market.conditionId,
        outcome: "Yes",
        shares: 8,
        totalCostUsdc: 4,
        openedAtMs: nowMs - 7_200_000
      }
    ];

    const batches = buildMaxHoldRiskReductionBatchesFromOpenLots(
      lots,
      () => market,
      {
        nowMs,
        maxHoldAfterMs: 3_600_000
      }
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(
      expect.objectContaining({
        conditionId: market.conditionId,
        agedTokenIds: ["yes-token"]
      })
    );
  });
});
