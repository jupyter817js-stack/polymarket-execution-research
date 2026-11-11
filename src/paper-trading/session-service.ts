import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";
import type { RuntimeCheckpointSummary } from "../core/runtime-checkpoint-service.js";
import type { RiskState, RiskStatusSnapshot } from "../core/types.js";
import {
  buildPaperTradingSessionReport,
  type PaperTradingSessionReport,
  type PaperTradingCheckpointValidation,
  type PaperTradingTradeRecord
} from "./report.js";

type PaperTradingSessionServiceOptions = {
  logger: Logger;
  runtime: string;
  outputFile?: string;
  intervalMs?: number;
  maxCheckpointStalenessMs?: number;
};

type FlushReason = "startup" | "checkpoint" | "stop" | "manual";

export class PaperTradingSessionService {
  private readonly logger: Logger;
  private readonly runtime: string;
  private readonly outputFile?: string;
  private readonly intervalMs: number;
  private readonly maxCheckpointStalenessMs: number;
  private readonly startedAtMs = Date.now();
  private readonly trades: PaperTradingTradeRecord[] = [];
  private interval: NodeJS.Timeout | undefined;
  private latestRiskState: RiskState = "RUNNING";
  private latestCheckpoint: RuntimeCheckpointSummary | undefined;

  constructor(options: PaperTradingSessionServiceOptions) {
    this.logger = options.logger;
    this.runtime = options.runtime;
    this.outputFile = options.outputFile ?? config.paper.reportFile;
    this.intervalMs = options.intervalMs ?? config.paper.reportIntervalMs;
    this.maxCheckpointStalenessMs =
      options.maxCheckpointStalenessMs ?? config.paper.maxCheckpointStalenessMs;
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

  recordTrade(record: PaperTradingTradeRecord): void {
    this.trades.push({
      ...record,
      tags: [...record.tags]
    });
  }

  noteRiskSnapshot(snapshot: RiskStatusSnapshot): void {
    this.latestRiskState = snapshot.state;
  }

  noteCheckpointSnapshot(snapshot: RuntimeCheckpointSummary): void {
    this.latestCheckpoint = snapshot;
  }

  getReport(): PaperTradingSessionReport {
    const endedAtMs = Date.now();

    return buildPaperTradingSessionReport({
      sessionName: `${this.runtime}:${this.startedAtMs}:paper`,
      source: "dry-run-runtime",
      startedAtMs: this.startedAtMs,
      endedAtMs,
      finalRiskState: this.latestRiskState,
      checkpointValidation: this.buildCheckpointValidation(endedAtMs),
      trades: this.trades
    });
  }

  private buildCheckpointValidation(
    endedAtMs: number
  ): PaperTradingCheckpointValidation | undefined {
    if (!this.latestCheckpoint) {
      return undefined;
    }

    const checkpointAgeMs = Math.max(0, endedAtMs - this.latestCheckpoint.generatedAtMs);
    const withinFreshnessWindow = checkpointAgeMs <= this.maxCheckpointStalenessMs;
    const riskStateMatchesSession = this.latestCheckpoint.riskState === this.latestRiskState;

    return {
      runtime: this.latestCheckpoint.runtime,
      checkpointReason: this.latestCheckpoint.reason,
      lastCheckpointGeneratedAtMs: this.latestCheckpoint.generatedAtMs,
      checkpointAgeMs,
      withinFreshnessWindow,
      checkpointRiskState: this.latestCheckpoint.riskState,
      sessionRiskState: this.latestRiskState,
      riskStateMatchesSession,
      recoveryReady: withinFreshnessWindow && riskStateMatchesSession,
      activeOrderCount: this.latestCheckpoint.activeOrderCount,
      activeConditionCount: this.latestCheckpoint.activeConditionCount,
      openLotCount: this.latestCheckpoint.openLotCount,
      openShares: this.latestCheckpoint.openShares,
      openCostUsdc: this.latestCheckpoint.openCostUsdc
    };
  }

  private flushReport(reason: FlushReason): void {
    if (!this.outputFile) {
      return;
    }

    const report = this.getReport();
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    this.logger.info(
      {
        runtime: this.runtime,
        reason,
        reportType: "paper_trading_session",
        outputFile: this.outputFile,
        expectedTradeCount: report.expectedTradeCount,
        filledTradeCount: report.filledTradeCount,
        partialFilledTradeCount: report.partialFilledTradeCount,
        missedTradeCount: report.missedTradeCount,
        totalExpectedRealizedPnlUsdc: report.totalExpectedRealizedPnlUsdc,
        totalRealizedPnlUsdc: report.totalRealizedPnlUsdc,
        finalRiskState: report.finalRiskState,
        averageObservedVenueLatencyMs: report.averageObservedVenueLatencyMs,
        checkpointRecoveryReady: report.checkpointValidation?.recoveryReady,
        checkpointAgeMs: report.checkpointValidation?.checkpointAgeMs
      },
      "Paper trading session report updated."
    );
  }
}
