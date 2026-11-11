import { readFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";
import type { RiskManager } from "./risk-manager.js";

/**
 * Reads the runtime checkpoint file and, if it recorded an active RECOVERY
 * state that has not yet expired, restores that state on the provided
 * RiskManager. This prevents the bot from skipping a RECOVERY cooldown
 * when it is restarted mid-session.
 *
 * Silently no-ops if the file is missing, unreadable, or the recovery
 * period has already expired.
 */
export const restoreRiskRecoveryFromCheckpoint = (
  riskManager: RiskManager,
  logger?: Logger,
  options?: { checkpointFile?: string; cwd?: string }
): void => {
  const filePath = options?.checkpointFile ?? config.checkpoint.file;
  if (!filePath) return;

  const resolvedPath = path.resolve(options?.cwd ?? process.cwd(), filePath);

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch {
    // File not present on first start — normal, nothing to restore.
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn({ file: resolvedPath }, "Risk recovery: checkpoint file is not valid JSON; skipping restore.");
    return;
  }

  const risk = (parsed as { monitoringSnapshot?: { risk?: unknown } })
    ?.monitoringSnapshot?.risk;

  if (
    typeof risk !== "object" ||
    risk === null ||
    (risk as { state?: unknown }).state !== "RECOVERY" ||
    typeof (risk as { recoveryUntilMs?: unknown }).recoveryUntilMs !== "number"
  ) {
    return;
  }

  const recoveryUntilMs = (risk as { recoveryUntilMs: number }).recoveryUntilMs;

  if (recoveryUntilMs <= Date.now()) {
    // Already expired — no need to restore.
    return;
  }

  riskManager.restoreRecoveryState(recoveryUntilMs);
  logger?.info(
    { recoveryUntilMs, expiresIn: Math.round((recoveryUntilMs - Date.now()) / 1000) + "s" },
    "RECOVERY state restored from checkpoint."
  );
};
