import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { fetchBinaryMarketsWithDiagnostics } from "../src/polymarket/gamma.js";
import type { GammaMarketResponse } from "../src/types.js";

const originalFetch = globalThis.fetch;

describe("Gamma market normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("keeps only eligible liquid binary YES/NO markets and deduplicates by condition id", async () => {
    const originalMinMarketLiquidity = config.marketUniverse.minMarketLiquidity;
    (config.marketUniverse as { minMarketLiquidity: number }).minMarketLiquidity = 100_000;

    const payload: GammaMarketResponse[] = [
      {
        id: "binary-1",
        question: "Will Team A win?",
        questionID: "q-1",
        conditionId: "condition-1",
        slug: "team-a-win",
        liquidity: "150000",
        outcomes: JSON.stringify(["Yes", "No"]),
        clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: false,
        negRisk: false,
        endDate: new Date(Date.now() + 3_600_000).toISOString()
      },
      {
        id: "ternary-1",
        question: "Who wins the group?",
        questionID: "q-2",
        conditionId: "condition-2",
        slug: "who-wins-group",
        liquidity: "250000",
        outcomes: JSON.stringify(["A", "B", "C"]),
        clobTokenIds: JSON.stringify(["a-token", "b-token", "c-token"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: false,
        negRisk: false,
        endDate: new Date(Date.now() + 3_600_000).toISOString()
      },
      {
        id: "binary-duplicate",
        question: "Will Team A win? duplicate row",
        questionID: "q-1b",
        conditionId: "condition-1",
        slug: "team-a-win-duplicate",
        liquidity: "150000",
        outcomes: JSON.stringify(["Yes", "No"]),
        clobTokenIds: JSON.stringify(["yes-token-2", "no-token-2"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: false,
        negRisk: false,
        endDate: new Date(Date.now() + 3_600_000).toISOString()
      },
      {
        id: "binary-low-liquidity",
        question: "Will Team B win?",
        questionID: "q-3",
        conditionId: "condition-3",
        slug: "team-b-win",
        liquidity: "99999.99",
        outcomes: JSON.stringify(["Yes", "No"]),
        clobTokenIds: JSON.stringify(["yes-token-3", "no-token-3"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: false,
        negRisk: false,
        endDate: new Date(Date.now() + 3_600_000).toISOString()
      }
    ];

    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => payload
      }) as typeof fetch;

      const { markets, diagnostics } = await fetchBinaryMarketsWithDiagnostics();

      expect(markets).toHaveLength(1);
      expect(markets[0]?.conditionId).toBe("condition-1");
      expect(markets[0]?.liquidity).toBe(150000);
      expect(markets[0]?.outcomes).toEqual(["Yes", "No"]);
      expect(markets[0]?.tokenIds).toEqual(["yes-token", "no-token"]);
      expect(diagnostics.pagesFetched).toBe(1);
      expect(diagnostics.rawMarketsFetched).toBe(4);
      expect(diagnostics.normalizedBinaryMarkets).toBe(3);
      expect(diagnostics.eligibleMarketsBeforeDedup).toBe(2);
      expect(diagnostics.selectedMarkets).toBe(1);
      expect(diagnostics.rejected.notBinaryOrMalformed).toBe(1);
      expect(diagnostics.rejected.liquidityBelowMinimum).toBe(1);
      expect(diagnostics.rejected.duplicateCondition).toBe(1);
    } finally {
      (config.marketUniverse as { minMarketLiquidity: number }).minMarketLiquidity =
        originalMinMarketLiquidity;
    }
  });

  it("treats gameStartTime as a trading cutoff even when endDate is far away", async () => {
    const payload: GammaMarketResponse[] = [
      {
        id: "sports-1",
        question: "Will Team A win?",
        questionID: "q-sports-1",
        conditionId: "condition-sports-1",
        slug: "team-a-win-sports",
        liquidity: "250000",
        outcomes: JSON.stringify(["Yes", "No"]),
        clobTokenIds: JSON.stringify(["sports-yes", "sports-no"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: true,
        negRisk: false,
        gameStartTime: new Date(Date.now() + 60_000).toISOString(),
        endDate: new Date(Date.now() + 86_400_000).toISOString()
      }
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload
    }) as typeof fetch;

    const { markets, diagnostics } = await fetchBinaryMarketsWithDiagnostics();

    expect(markets).toHaveLength(0);
    expect(diagnostics.rejected.expiryTooSoon).toBe(1);
  });

  it("falls back to a supported Gamma order field when the preferred one is rejected", async () => {
    const payload: GammaMarketResponse[] = [
      {
        id: "binary-1",
        question: "Will Team A win?",
        questionID: "q-1",
        conditionId: "condition-1",
        slug: "team-a-win",
        liquidity: "150000",
        outcomes: JSON.stringify(["Yes", "No"]),
        clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
        orderMinSize: 1,
        orderPriceMinTickSize: 0.01,
        feesEnabled: false,
        negRisk: false,
        endDate: new Date(Date.now() + 3_600_000).toISOString()
      }
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: async () => '{"type":"validation error","error":"order fields are not valid"}'
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => payload
      });

    globalThis.fetch = fetchMock as typeof fetch;

    const { markets } = await fetchBinaryMarketsWithDiagnostics();

    expect(markets).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("order=volume24hr");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("order=volume");
  });
});
