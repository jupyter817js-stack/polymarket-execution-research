import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";
import { ExecutionEngine } from "./execution-engine.js";
import { InventoryLotTracker } from "./inventory-lot-tracker.js";
import type { PnLEngineLike, RiskManagerLike, RiskState } from "./types.js";
import { buildMonitoringSnapshotPayload } from "./runtime-summary.js";

type RuntimeCheckpointServiceOptions = {
  executionEngine: ExecutionEngine;
  pnlEngine: PnLEngineLike;
  riskManager: RiskManagerLike;
  inventoryTracker: InventoryLotTracker;
  logger: Logger;
  runtime: string;
  outputFile?: string;
  intervalMs?: number;
  cwd?: string;
};

type RuntimeCheckpointReason = "startup" | "checkpoint" | "stop" | "manual";

export type RuntimeCheckpointSummary = {
  runtime: string;
  reason: RuntimeCheckpointReason;
  generatedAtMs: number;
  riskState: RiskState;
  activeOrderCount: number;
  activeConditionCount: number;
  openLotCount: number;
  openShares: number;
  openCostUsdc: number;
};

type RuntimeCheckpointListener = (summary: RuntimeCheckpointSummary) => void;

export class RuntimeCheckpointService {
  private readonly intervalMs: number;
  private readonly outputFile: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<RuntimeCheckpointListener>();
  private latestSummary: RuntimeCheckpointSummary | undefined;

  constructor(private readonly options: RuntimeCheckpointServiceOptions) {
    this.intervalMs = options.intervalMs ?? config.checkpoint.intervalMs;
    this.outputFile = options.outputFile ?? config.checkpoint.file;
  }

  start(): void {
    if (!this.outputFile || this.timer) {
      return;
    }

    this.flushCheckpoint("startup");
    this.timer = setInterval(() => {
      this.flushCheckpoint("checkpoint");
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.outputFile) {
      return;
    }

    this.flushCheckpoint("stop");
  }

  subscribe(listener: RuntimeCheckpointListener): () => void {
    this.listeners.add(listener);

    if (this.latestSummary) {
      listener(this.latestSummary);
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  getLatestSummary(): RuntimeCheckpointSummary | undefined {
    return this.latestSummary;
  }

  flushCheckpoint(reason: RuntimeCheckpointReason): void {
    if (!this.outputFile) {
      return;
    }

    const resolvedPath = path.resolve(this.options.cwd ?? process.cwd(), this.outputFile);
    const openLots = this.options.inventoryTracker.exportOpenLots();
    const monitoringSnapshot = buildMonitoringSnapshotPayload({
      executionEngine: this.options.executionEngine,
      pnlEngine: this.options.pnlEngine,
      riskManager: this.options.riskManager,
      inventoryLots: openLots,
      runtime: this.options.runtime,
      monitoringIntervalMs: config.observability.monitoringSummaryIntervalMs
    });
    const payload = {
      checkpointType: "runtime_checkpoint" as const,
      schemaVersion: 1 as const,
      runtime: this.options.runtime,
      reason,
      generatedAtMs: Date.now(),
      monitoringSnapshot,
      inventory: {
        openLotCount: openLots.length,
        openShares: Number(openLots.reduce((total, lot) => total + lot.shares, 0).toFixed(5)),
        openCostUsdc: Number(
          openLots.reduce((total, lot) => total + lot.totalCostUsdc, 0).toFixed(8)
        ),
        openLots
      }
    };
    const summary: RuntimeCheckpointSummary = {
      runtime: this.options.runtime,
      reason,
      generatedAtMs: payload.generatedAtMs,
      riskState: monitoringSnapshot.risk.state,
      activeOrderCount: monitoringSnapshot.activeOrders.total,
      activeConditionCount: monitoringSnapshot.activeOrders.activeConditions,
      openLotCount: payload.inventory.openLotCount,
      openShares: payload.inventory.openShares,
      openCostUsdc: payload.inventory.openCostUsdc
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tempPath = `${resolvedPath}.tmp`;

    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(tempPath, serialized, "utf8");
    renameSync(tempPath, resolvedPath);
    this.latestSummary = summary;

    for (const listener of this.listeners) {
      listener(summary);
    }

    this.options.logger.info(
      {
        runtime: this.options.runtime,
        reason,
        runtimeCheckpointFile: resolvedPath,
        openLotCount: payload.inventory.openLotCount,
        openShares: payload.inventory.openShares,
        dailyRealizedPnlUsdc: monitoringSnapshot.portfolio.dailyRealizedPnlUsdc,
        riskState: monitoringSnapshot.risk.state
      },
      "Runtime recovery checkpoint updated."
    );
  }
}
