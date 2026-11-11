import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";
import type { PnLEngineLike, RiskState, RiskStatusSnapshot } from "../core/types.js";
import { buildRealizedTradingSessionReport } from "./realized-report.js";

type RealizedTradingSessionServiceOptions = {
  logger: Logger;
  pnlEngine: PnLEngineLike;
  runtime: string;
  outputFile?: string;
  intervalMs?: number;
};

type FlushReason = "startup" | "checkpoint" | "stop" | "manual";

export class RealizedTradingSessionService {
  private readonly logger: Logger;
  private readonly pnlEngine: PnLEngineLike;
  private readonly runtime: string;
  private readonly outputFile?: string;
  private readonly intervalMs: number;
  private readonly startedAtMs = Date.now();
  private interval: NodeJS.Timeout | undefined;
  private latestRiskState: RiskState = "RUNNING";

  constructor(options: RealizedTradingSessionServiceOptions) {
    this.logger = options.logger;
    this.pnlEngine = options.pnlEngine;
    this.runtime = options.runtime;
    this.outputFile = options.outputFile ?? config.realized.reportFile;
    this.intervalMs = options.intervalMs ?? config.realized.reportIntervalMs;
  }

  start(): void {
    if (!this.outputFile) {
      return;
    }

    this.flushReport("startup");
    this.interval = setInterval(() => {
      this.flushReport("checkpoint");
    }, this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    if (this.outputFile) {
      this.flushReport("stop");
    }
  }

  noteRiskSnapshot(snapshot: RiskStatusSnapshot): void {
    this.latestRiskState = snapshot.state;
  }

  private flushReport(reason: FlushReason): void {
    if (!this.outputFile) {
      return;
    }

    const report = buildRealizedTradingSessionReport({
      sessionName: `${this.runtime}:${this.startedAtMs}:realized`,
      startedAtMs: this.startedAtMs,
      endedAtMs: Date.now(),
      finalRiskState: this.latestRiskState,
      trades: this.pnlEngine.exportTrades()
    });
    const resolvedPath = path.resolve(process.cwd(), this.outputFile);

    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    this.logger.info(
      {
        runtime: this.runtime,
        reason,
        reportType: "realized_trading_session",
        outputFile: resolvedPath,
        tradeCount: report.tradeCount,
        totalExpectedEdgeUsdc: report.totalExpectedEdgeUsdc,
        totalRealizedPnlUsdc: report.totalRealizedPnlUsdc,
        finalRiskState: report.finalRiskState
      },
      "Realized trading session report updated."
    );
  }
}
