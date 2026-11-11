import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { PnLEngine } from "../src/core/pnl-engine.js";
import { RealizedTradingSessionService } from "../src/session-report/realized-session-service.js";

describe("RealizedTradingSessionService", () => {
  it("writes a realized live session report from the shared pnl ledger", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-realized-session-"));
    const outputFile = path.join(tempDir, "realized-session.json");
    const logger = pino({ level: "silent" });
    const pnlEngine = new PnLEngine();
    const service = new RealizedTradingSessionService({
      logger,
      pnlEngine,
      runtime: "integrated",
      outputFile,
      intervalMs: 60_000
    });

    pnlEngine.recordTrade({
      id: "live-1",
      strategy: "same-market-arb",
      marketScope: "btc-above-120k",
      conditionId: "condition-1",
      expectedEdgeUsdc: 0.3,
      realizedPnlUsdc: 0.2,
      grossRealizedPnlUsdc: 0.25,
      feeCostUsdc: 0.05,
      closedAtMs: Date.now(),
      tags: ["live"]
    });

    service.start();
    service.noteRiskSnapshot({
      state: "RUNNING",
      dayKey: "2026-03-31",
      dailyRealizedPnlUsdc: 0.2,
      dailyLossUsdc: 0,
      consecutiveLosses: 0,
      apiErrors: 0,
      orderFailures: 0,
      stateMismatches: 0,
      lastEventAtMs: Date.now()
    });
    service.stop();

    const written = JSON.parse(readFileSync(outputFile, "utf8")) as {
      source: string;
      finalRiskState: string;
      tradeCount: number;
      totalExpectedEdgeUsdc: number;
      totalRealizedPnlUsdc: number;
      trades: Array<{ id: string; strategy: string }>;
    };

    expect(written.source).toBe("live-runtime");
    expect(written.finalRiskState).toBe("RUNNING");
    expect(written.tradeCount).toBe(1);
    expect(written.totalExpectedEdgeUsdc).toBeCloseTo(0.3, 8);
    expect(written.totalRealizedPnlUsdc).toBeCloseTo(0.2, 8);
    expect(written.trades[0]?.id).toBe("live-1");
    expect(written.trades[0]?.strategy).toBe("same-market-arb");
  });
});
