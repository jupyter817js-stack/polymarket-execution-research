import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { PaperTradingSessionService } from "../src/paper-trading/session-service.js";

describe("PaperTradingSessionService", () => {
  it("writes a dry-run paper session report with risk state and trade summary", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-paper-session-"));
    const outputFile = path.join(tempDir, "paper-session.json");
    const logger = pino({ level: "silent" });
    const service = new PaperTradingSessionService({
      logger,
      runtime: "integrated",
      outputFile,
      intervalMs: 60_000
    });

    service.start();
    service.recordTrade({
      id: "paper-1",
      strategy: "same-market-arb",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      status: "filled",
      expectedRealizedPnlUsdc: 0.3,
      expectedGrossEdgeUsdc: 0.3,
      realizedPnlUsdc: 0.3,
      grossRealizedPnlUsdc: 0.3,
      feeCostUsdc: 0,
      simulatedFillLatencyMs: 0,
      observedVenueLatencyMs: 150,
      observedBookSkewMs: 40,
      depthCoverageRatio: 1.8,
      fillConfidence: "high",
      shares: 10,
      reason: "dry_run_coordinator_approved",
      tags: ["dry-run-runtime", "same-market-arb"]
    });
    service.recordTrade({
      id: "paper-2",
      strategy: "negative-risk",
      marketScope: "election-basket",
      status: "not_filled",
      expectedRealizedPnlUsdc: 0.2,
      expectedGrossEdgeUsdc: 0.25,
      feeCostUsdc: 0.05,
      observedVenueLatencyMs: 300,
      observedBookSkewMs: 80,
      depthCoverageRatio: 1.05,
      fillConfidence: "low",
      shares: 5,
      reason: "conversion_live_bridge_missing",
      tags: ["dry-run-runtime", "negative-risk", "no-to-yes-conversion"]
    });
    service.noteRiskSnapshot({
      state: "DEGRADED",
      dayKey: "2026-03-31",
      dailyRealizedPnlUsdc: 0,
      dailyLossUsdc: 0,
      consecutiveLosses: 0,
      apiErrors: 0,
      orderFailures: 0,
      stateMismatches: 0,
      lastEventAtMs: Date.now()
    });
    service.noteCheckpointSnapshot({
      runtime: "integrated",
      reason: "checkpoint",
      generatedAtMs: Date.now(),
      riskState: "DEGRADED",
      activeOrderCount: 1,
      activeConditionCount: 1,
      openLotCount: 2,
      openShares: 3.5,
      openCostUsdc: 1.15
    });
    service.stop();

    const written = JSON.parse(readFileSync(outputFile, "utf8")) as {
      source: string;
      finalRiskState: string;
      expectedTradeCount: number;
      filledTradeCount: number;
      partialFilledTradeCount?: number;
      missedTradeCount: number;
      totalExpectedRealizedPnlUsdc: number;
      totalRealizedPnlUsdc: number;
      averageObservedVenueLatencyMs?: number;
      averageObservedBookSkewMs?: number;
      checkpointValidation?: {
        withinFreshnessWindow: boolean;
        riskStateMatchesSession: boolean;
        recoveryReady: boolean;
        activeOrderCount: number;
        openLotCount: number;
      };
      highConfidenceTradeCount: number;
      lowConfidenceTradeCount: number;
      trades: Array<{ id: string; status: string; reason?: string }>;
      byStrategy: Array<{
        strategy: string;
        filledTradeCount: number;
        partialFilledTradeCount?: number;
        missedTradeCount: number;
        highConfidenceTradeCount: number;
        lowConfidenceTradeCount: number;
      }>;
    };

    expect(written.source).toBe("dry-run-runtime");
    expect(written.finalRiskState).toBe("DEGRADED");
    expect(written.expectedTradeCount).toBe(2);
    expect(written.filledTradeCount).toBe(1);
    expect(written.partialFilledTradeCount).toBe(0);
    expect(written.missedTradeCount).toBe(1);
    expect(written.totalExpectedRealizedPnlUsdc).toBeCloseTo(0.5, 8);
    expect(written.totalRealizedPnlUsdc).toBeCloseTo(0.3, 8);
    expect(written.averageObservedVenueLatencyMs).toBe(225);
    expect(written.averageObservedBookSkewMs).toBe(60);
    expect(written.checkpointValidation?.withinFreshnessWindow).toBe(true);
    expect(written.checkpointValidation?.riskStateMatchesSession).toBe(true);
    expect(written.checkpointValidation?.recoveryReady).toBe(true);
    expect(written.checkpointValidation?.activeOrderCount).toBe(1);
    expect(written.checkpointValidation?.openLotCount).toBe(2);
    expect(written.highConfidenceTradeCount).toBe(1);
    expect(written.lowConfidenceTradeCount).toBe(1);
    expect(written.trades).toHaveLength(2);
    expect(written.trades[0]?.id).toBe("paper-1");
    expect(written.trades[1]?.reason).toBe("conversion_live_bridge_missing");

    const arbSummary = written.byStrategy.find(
      (summary) => summary.strategy === "same-market-arb"
    );
    const negRiskSummary = written.byStrategy.find(
      (summary) => summary.strategy === "negative-risk"
    );

    expect(arbSummary?.filledTradeCount).toBe(1);
    expect(arbSummary?.partialFilledTradeCount).toBe(0);
    expect(arbSummary?.highConfidenceTradeCount).toBe(1);
    expect(negRiskSummary?.missedTradeCount).toBe(1);
    expect(negRiskSummary?.lowConfidenceTradeCount).toBe(1);
  });
});
