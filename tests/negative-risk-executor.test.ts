import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { NegativeRiskExecutor } from "../src/trading/negative-risk-executor.js";
import type { BinaryMarket } from "../src/types.js";
import type {
  NegativeRiskNoConversionOpportunity,
  NegativeRiskYesBasketOpportunity
} from "../src/strategy/negative-risk.js";

const makeMarket = (id: string, slug: string): BinaryMarket => ({
  id,
  conditionId: `condition-${id}`,
  questionId: `question-${id}`,
  question: `Question ${id}`,
  slug,
  eventId: "event-1",
  eventSlug: "sample-event",
  eventTitle: "Sample event",
  groupItemTitle: slug,
  category: "Politics",
  outcomes: ["Yes", "No"],
  tokenIds: [`yes-${id}`, `no-${id}`],
  active: true,
  closed: false,
  acceptingOrders: true,
  enableOrderBook: true,
  orderMinSize: 1,
  orderPriceMinTickSize: 0.01,
  feesEnabled: false,
  negRisk: true,
  enableNegRisk: true,
  cumulativeMarkets: false,
  showAllOutcomes: true
});

const opportunity: NegativeRiskYesBasketOpportunity = {
  kind: "yes-basket",
  group: {
    eventId: "event-1",
    eventSlug: "sample-event",
    eventTitle: "Sample event",
    marketId: "market-1",
    markets: [makeMarket("1", "outcome-a"), makeMarket("2", "outcome-b")]
  },
  shares: 5,
  grossCost: 4.5,
  grossCostPerShare: 0.9,
  grossEdge: 0.5,
  feeCost: 0,
  netEdge: 0.5,
  netEdgeBpsOnPar: 1000,
  detectedAtMs: Date.now(),
  legs: [
    {
      market: makeMarket("1", "outcome-a"),
      tokenId: "yes-1",
      outcomeTitle: "Outcome A",
      fill: {
        shares: 5,
        totalCost: 2,
        averagePrice: 0.4,
        worstPrice: 0.4
      },
      tickSize: 0.01,
      limitPrice: 0.4,
      feeRateBps: 0
    },
    {
      market: makeMarket("2", "outcome-b"),
      tokenId: "yes-2",
      outcomeTitle: "Outcome B",
      fill: {
        shares: 5,
        totalCost: 2.5,
        averagePrice: 0.5,
        worstPrice: 0.5
      },
      tickSize: 0.01,
      limitPrice: 0.5,
      feeRateBps: 0
    }
  ]
};

const conversionOpportunity: NegativeRiskNoConversionOpportunity = {
  kind: "no-to-yes-conversion",
  group: {
    eventId: "event-1",
    eventSlug: "sample-event",
    eventTitle: "Sample event",
    marketId: "market-1",
    markets: [makeMarket("1", "outcome-a"), makeMarket("2", "outcome-b"), makeMarket("3", "outcome-c")]
  },
  shares: 5,
  grossCost: 2,
  grossCostPerShare: 0.4,
  grossEdge: 2.8,
  feeCost: 0,
  netEdge: 2.8,
  netEdgeBpsOnPar: 5600,
  detectedAtMs: Date.now(),
  entry: {
    market: makeMarket("1", "outcome-a"),
    tokenId: "no-1",
    outcomeTitle: "No: Outcome A",
    fill: {
      shares: 5,
      totalCost: 2,
      averagePrice: 0.4,
      worstPrice: 0.4
    },
    tickSize: 0.01,
    limitPrice: 0.4,
    feeRateBps: 0
  },
  exitLegs: [
    {
      market: makeMarket("2", "outcome-b"),
      tokenId: "yes-2",
      outcomeTitle: "Outcome B",
      fill: {
        shares: 4.5,
        totalProceeds: 2.7,
        averagePrice: 0.6,
        worstPrice: 0.6
      },
      tickSize: 0.01,
      limitPrice: 0.6,
      feeRateBps: 0
    },
    {
      market: makeMarket("3", "outcome-c"),
      tokenId: "yes-3",
      outcomeTitle: "Outcome C",
      fill: {
        shares: 4.5,
        totalProceeds: 2.1,
        averagePrice: 0.46666667,
        worstPrice: 0.46
      },
      tickSize: 0.01,
      limitPrice: 0.46,
      feeRateBps: 0
    }
  ],
  grossProceeds: 4.8,
  convertedSharesPerLeg: 4.5,
  conversionFeeBps: 0,
  conversionMarketId: "0x0000000000000000000000000000000000000000000000000000000000000100",
  conversionIndexSet: "0x2",
  sourceQuestionIndex: 1
};

describe("NegativeRiskExecutor", () => {
  const originalAggressiveEntryOrderType = config.execution.aggressiveEntryOrderType;
  const originalAggressiveExitOrderType = config.execution.aggressiveExitOrderType;

  afterEach(() => {
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveEntryOrderType = originalAggressiveEntryOrderType;
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveExitOrderType = originalAggressiveExitOrderType;
  });

  it("returns a realized pnl summary when the basket fully fills", async () => {
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "50000000", allowance: "50000000" }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi.fn().mockResolvedValue({
        orders: [
          {
            success: true,
            orderID: "leg-1",
            status: "matched",
            takingAmount: "5",
            makingAmount: "2",
            errorMsg: ""
          },
          {
            success: true,
            orderID: "leg-2",
            status: "matched",
            takingAmount: "5",
            makingAmount: "2.5",
            errorMsg: ""
          }
        ]
      })
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const executor = new NegativeRiskExecutor(
      client as never,
      { get: vi.fn() } as never,
      logger
    );

    const summary = await executor.execute(opportunity);

    expect(summary.status).toBe("fully_filled");
    expect(summary.realizedPnlUsdc).toBeCloseTo(0.5, 8);
    expect(summary.openedPositions).toEqual([
      expect.objectContaining({
        tokenId: "yes-1",
        shares: 5,
        totalCostUsdc: 2
      }),
      expect.objectContaining({
        tokenId: "yes-2",
        shares: 5,
        totalCostUsdc: 2.5
      })
    ]);
  });

  it("uses the unified non-FOK order types for basket entry and converted exits", async () => {
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveEntryOrderType = "IOC";
    (
      config.execution as {
        aggressiveEntryOrderType: "IOC" | "GTC" | "FOK";
        aggressiveExitOrderType: "IOC" | "GTC" | "FOK";
      }
    ).aggressiveExitOrderType = "GTC";

    const client = {
      getBalanceAllowance: vi.fn().mockImplementation((params?: { asset_type?: string }) => {
        if (params?.asset_type === "COLLATERAL") {
          return Promise.resolve({ balance: "50000000", allowance: "50000000" });
        }

        return Promise.resolve({ balance: "0", allowance: "50000000" });
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            {
              success: true,
              orderID: "entry-1",
              status: "matched",
              takingAmount: "5",
              makingAmount: "2",
              errorMsg: ""
            }
          ]
        })
        .mockResolvedValueOnce({
          orders: [
            {
              success: true,
              orderID: "exit-1",
              status: "matched",
              takingAmount: "2.7",
              makingAmount: "4.5",
              errorMsg: ""
            },
            {
              success: true,
              orderID: "exit-2",
              status: "matched",
              takingAmount: "2.1",
              makingAmount: "4.5",
              errorMsg: ""
            }
          ]
        })
    };

    const executor = new NegativeRiskExecutor(
      client as never,
      { get: vi.fn() } as never,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      } as never,
      undefined,
      {
        conversionBridge: {
          execute: vi.fn().mockResolvedValue({
            status: "converted",
            txHash: "0xconvert",
            autoApprovedAdapter: false
          })
        }
      }
    );

    await executor.execute(conversionOpportunity);

    expect(client.postOrders).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([expect.objectContaining({ orderType: "FAK" })])
    );
    expect(client.postOrders).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        expect.objectContaining({ orderType: "GTC" }),
        expect.objectContaining({ orderType: "GTC" })
      ])
    );
  });

  it("executes a NO-to-YES conversion path when the live bridge is available", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockImplementation((params?: { asset_type?: string }) => {
        if (params?.asset_type === "COLLATERAL") {
          return Promise.resolve({ balance: "50000000", allowance: "50000000" });
        }

        return Promise.resolve({ balance: "0", allowance: "50000000" });
      }),
      createOrder: vi.fn().mockResolvedValue({}),
      postOrders: vi
        .fn()
        .mockResolvedValueOnce({
          orders: [
            {
              success: true,
              orderID: "entry-1",
              status: "matched",
              takingAmount: "5",
              makingAmount: "2",
              errorMsg: ""
            }
          ]
        })
        .mockResolvedValueOnce({
          orders: [
            {
              success: true,
              orderID: "exit-1",
              status: "matched",
              takingAmount: "2.7",
              makingAmount: "4.5",
              errorMsg: ""
            },
            {
              success: true,
              orderID: "exit-2",
              status: "matched",
              takingAmount: "2.1",
              makingAmount: "4.5",
              errorMsg: ""
            }
          ]
        })
    };

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;

    const bridge = {
      execute: vi.fn().mockResolvedValue({
        status: "converted",
        txHash: "0xconvert",
        autoApprovedAdapter: false
      })
    };

    const executor = new NegativeRiskExecutor(
      client as never,
      { get: vi.fn() } as never,
      logger,
      undefined,
      {
        conversionBridge: bridge
      }
    );

    const summary = await executor.execute(conversionOpportunity);

    expect(summary.status).toBe("fully_filled");
    expect(summary.realizedPnlUsdc).toBeCloseTo(2.8, 8);
    expect(summary.detail).toContain("0xconvert");
    expect(summary.openedPositions).toBeUndefined();
    expect(bridge.execute).toHaveBeenCalledOnce();
  });
});
