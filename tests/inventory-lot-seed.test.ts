import { describe, expect, it } from "vitest";

import { parseInventoryLotSeedPayload } from "../src/core/inventory-lot-seed.js";

describe("inventory lot seed parsing", () => {
  it("normalizes lot ids and openedAt timestamps from seed payloads", () => {
    const rows = parseInventoryLotSeedPayload(
      JSON.stringify([
        {
          strategy: "market-making",
          tokenId: "yes-token",
          marketScope: "btc-above-120k",
          conditionId: "condition-1",
          outcome: "Yes",
          shares: 5,
          totalCostUsdc: 2.4,
          openedAt: "2026-03-28T10:00:00.000Z"
        }
      ]),
      {
        sourceLabel: "seed-file"
      }
    );

    expect(rows).toEqual([
      expect.objectContaining({
        lotId: "seed-file:market-making:yes-token:0",
        strategy: "market-making",
        tokenId: "yes-token",
        shares: 5,
        totalCostUsdc: 2.4,
        openedAtMs: Date.parse("2026-03-28T10:00:00.000Z")
      })
    ]);
  });

  it("uses the injected clock when the seed omits an opened timestamp", () => {
    const rows = parseInventoryLotSeedPayload(
      JSON.stringify([
        {
          lotId: "carry-over-1",
          strategy: "negative-risk",
          tokenId: "yes-2",
          marketScope: "sample-event",
          shares: 3,
          totalCostUsdc: 1.95
        }
      ]),
      {
        now: () => 123_456
      }
    );

    expect(rows[0]?.openedAtMs).toBe(123_456);
  });
});
