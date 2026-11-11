import { afterEach, describe, expect, it, vi } from "vitest";

import { Polybot1 } from "../src/bot.js";
import { config } from "../src/config.js";
import type {
  BinaryMarket,
  SameMarketEvaluation,
  SameMarketRejectReason
} from "../src/types.js";

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
  feesEnabled: true,
  negRisk: false
};

const buildRejectedEvaluation = (reason: SameMarketRejectReason): SameMarketEvaluation => ({
  status: "rejected",
  reason,
  diagnostics: {
    market,
    evaluatedAtMs: 0,
    configuredTargetShares: 5,
    shares: 5,
    sharesAutoAdjusted: false,
    marketOrderMinSize: 1,
    bookOrderMinSizeA: 1,
    bookOrderMinSizeB: 1,
    effectiveOrderMinSize: 1,
    targetOrderNotionalUsdc: 0.8,
    maxBookStalenessMs: 20_000,
    maxBookSkewMs: 2_000,
    maxEntryGrossCostPerShare: 0.99,
    entryMinDepthRatio: 1.05,
    bookTimestampSkewMs: 0,
    netEdge: 0.01,
    netEdgeBpsOnPar: 10,
    legA: {
      tokenId: market.tokenIds[0],
      outcome: market.outcomes[0],
      updatedAtMs: 0,
      bookAgeMs: 0,
      feeRateBps: 0
    },
    legB: {
      tokenId: market.tokenIds[1],
      outcome: market.outcomes[1],
      updatedAtMs: 0,
      bookAgeMs: 0,
      feeRateBps: 0
    }
  }
});

describe("Polybot1", () => {
  const originalVerboseMarketLogs = config.observability.verboseMarketLogs;
  const originalVerboseMarketLogIntervalMs = config.observability.verboseMarketLogIntervalMs;

  afterEach(() => {
    const observability = config.observability as {
      verboseMarketLogs: boolean;
      verboseMarketLogIntervalMs: number;
    };
    observability.verboseMarketLogs = originalVerboseMarketLogs;
    observability.verboseMarketLogIntervalMs = originalVerboseMarketLogIntervalMs;
  });

  it("logs aggregated same-market rejection summaries when verbose logs are disabled", () => {
    const observability = config.observability as {
      verboseMarketLogs: boolean;
      verboseMarketLogIntervalMs: number;
    };
    observability.verboseMarketLogs = false;
    observability.verboseMarketLogIntervalMs = 1_000;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const bot = Object.create(Polybot1.prototype) as any;

    bot.logger = logger;
    bot.lastRejectionSummaryLogAt = new Map();
    bot.rejectionSummaryByMarketId = new Map();
    bot.describeRejectionReason = vi.fn(
      (evaluation: SameMarketEvaluation) => `detail:${evaluation.status === "rejected" ? evaluation.reason : "n/a"}`
    );

    bot.maybeLogRejectionSummary(buildRejectedEvaluation("net_edge_below_min_usdc"), 1_000);
    bot.maybeLogRejectionSummary(buildRejectedEvaluation("net_edge_below_min_usdc"), 1_500);

    expect(logger.info).not.toHaveBeenCalled();

    bot.maybeLogRejectionSummary(buildRejectedEvaluation("gross_cost_above_entry_cap"), 2_100);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        market: market.slug,
        totalRejectedEvaluations: 3,
        rejectionReasons: [
          { reason: "net_edge_below_min_usdc", count: 2 },
          { reason: "gross_cost_above_entry_cap", count: 1 }
        ],
        latestRejectionReason: "gross_cost_above_entry_cap",
        latestRejectionReasonDetail: "detail:gross_cost_above_entry_cap"
      }),
      "Same-market arbitrage evaluation summary."
    );
  });
});
