import type { Logger } from "pino";

import { config } from "../config.js";
import { ExecutionEngine } from "./execution-engine.js";
import { InventoryLotTracker } from "./inventory-lot-tracker.js";
import { buildMonitoringSnapshotPayload } from "./runtime-summary.js";
import type { PnLEngineLike, RiskManagerLike } from "./types.js";

type MonitoringServiceOptions = {
  executionEngine: ExecutionEngine;
  pnlEngine: PnLEngineLike;
  riskManager: RiskManagerLike;
  inventoryTracker?: InventoryLotTracker;
  logger: Logger;
  runtime: string;
  intervalMs?: number;
  /** Optional callback that returns per-market competition summary for inclusion in the snapshot. */
  getCompetitionSummary?: () => unknown[];
};

export class MonitoringService {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: MonitoringServiceOptions) {
    this.intervalMs =
      options.intervalMs ?? config.observability.monitoringSummaryIntervalMs;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.emitSnapshot();
    this.timer = setInterval(() => {
      this.emitSnapshot();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Can be set after construction to inject a competition summary provider. */
  setCompetitionSummaryProvider(fn: () => unknown[]): void {
    this.options.getCompetitionSummary = fn;
  }

  emitSnapshot(): void {
    const payload = buildMonitoringSnapshotPayload({
      executionEngine: this.options.executionEngine,
      pnlEngine: this.options.pnlEngine,
      riskManager: this.options.riskManager,
      inventoryLots: this.options.inventoryTracker?.exportOpenLots(),
      runtime: this.options.runtime,
      monitoringIntervalMs: this.intervalMs
    });

    const competitionSummary = this.options.getCompetitionSummary?.();
    const enrichedPayload =
      competitionSummary && competitionSummary.length > 0
        ? { ...payload, marketCompetition: competitionSummary }
        : payload;

    this.options.logger.info(enrichedPayload, "Monitoring snapshot updated.");
  }
}
