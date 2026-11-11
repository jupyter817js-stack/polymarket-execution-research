import { describe, expect, it } from "vitest";

import { summarizeObservedVenueLatency } from "../src/paper-trading/observed-venue-latency.js";

describe("summarizeObservedVenueLatency", () => {
  it("computes worst-case book age and skew across the involved books", () => {
    const summary = summarizeObservedVenueLatency({
      detectedAtMs: 1_000,
      books: [
        {
          assetId: "yes-token",
          market: "condition-1",
          bids: [],
          asks: [],
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          lastTradePrice: undefined,
          hash: undefined,
          updatedAtMs: 940
        },
        {
          assetId: "no-token",
          market: "condition-1",
          bids: [],
          asks: [],
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          lastTradePrice: undefined,
          hash: undefined,
          updatedAtMs: 980
        }
      ]
    });

    expect(summary.observedVenueLatencyMs).toBe(60);
    expect(summary.observedBookSkewMs).toBe(40);
  });

  it("returns an empty summary when no usable book timestamps are available", () => {
    const summary = summarizeObservedVenueLatency({
      detectedAtMs: 1_000,
      books: [undefined]
    });

    expect(summary).toEqual({});
  });
});
