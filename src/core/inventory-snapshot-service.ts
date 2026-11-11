import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";
import { InventoryLotTracker } from "./inventory-lot-tracker.js";

type InventorySnapshotServiceOptions = {
  tracker: InventoryLotTracker;
  logger: Logger;
  runtime: string;
  outputFile?: string;
  intervalMs?: number;
  cwd?: string;
};

export class InventorySnapshotService {
  private readonly intervalMs: number;
  private readonly outputFile: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InventorySnapshotServiceOptions) {
    this.intervalMs = options.intervalMs ?? config.inventory.snapshotIntervalMs;
    this.outputFile = options.outputFile ?? config.inventory.snapshotFile;
  }

  start(): void {
    if (!this.outputFile || this.timer) {
      return;
    }

    this.flushSnapshot("startup");
    this.timer = setInterval(() => {
      this.flushSnapshot("checkpoint");
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

    this.flushSnapshot("stop");
  }

  flushSnapshot(reason: "startup" | "checkpoint" | "stop" | "manual"): void {
    if (!this.outputFile) {
      return;
    }

    const resolvedPath = path.resolve(this.options.cwd ?? process.cwd(), this.outputFile);
    const snapshot = this.options.tracker.exportOpenLots();
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const tempPath = `${resolvedPath}.tmp`;

    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(tempPath, serialized, "utf8");
    renameSync(tempPath, resolvedPath);

    this.options.logger.info(
      {
        runtime: this.options.runtime,
        reason,
        inventorySnapshotFile: resolvedPath,
        openLotCount: snapshot.length,
        openShares: Number(snapshot.reduce((total, lot) => total + lot.shares, 0).toFixed(5)),
        openCostUsdc: Number(snapshot.reduce((total, lot) => total + lot.totalCostUsdc, 0).toFixed(8))
      },
      "Inventory lot snapshot updated."
    );
  }
}
