import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createConfiguredAlertDispatcher } from "../core/alert-dispatcher.js";
import { buildRestartDrillAlert } from "../core/alert-events.js";
import { parseInventoryLotSeedPayload } from "../core/inventory-lot-seed.js";
import { logger } from "../logger.js";
import type { InventoryLotSnapshot } from "../core/inventory-lot-tracker.js";
import {
  buildRestartDrillReport,
  type RestartDrillReport
} from "../session-report/restart-drill-report.js";
import type { RuntimeCheckpointReport } from "../session-report/small-live-report.js";

type ParsedArgs = {
  checkpointPath: string;
  recoveredLotsPath: string;
  outputPath?: string;
  sessionName?: string;
};

const usage =
  "Usage: npm run report:restart-drill -- <runtime-checkpoint.json> <recovered-lots.json> [--output <restart-drill-report.json>] [--session-name <name>]";

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;

const extractRecoveredLots = (
  payload: string,
  sourceLabel: string
): InventoryLotSnapshot[] => {
  const parsedJson = JSON.parse(payload) as unknown;

  if (Array.isArray(parsedJson)) {
    return parseInventoryLotSeedPayload(payload, {
      sourceLabel
    });
  }

  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    "inventory" in parsedJson &&
    Array.isArray((parsedJson as { inventory?: { openLots?: unknown } }).inventory?.openLots)
  ) {
    return parseInventoryLotSeedPayload(
      JSON.stringify((parsedJson as { inventory: { openLots: unknown[] } }).inventory.openLots),
      {
        sourceLabel
      }
    );
  }

  throw new Error(
    `Recovered lots input must be either an inventory lot array or a runtime checkpoint payload with inventory.openLots. source=${sourceLabel}`
  );
};

const parseArgs = (argv: string[]): ParsedArgs | undefined => {
  const [checkpointPath, recoveredLotsPath, ...rest] = argv;
  if (!checkpointPath || !recoveredLotsPath) {
    return undefined;
  }

  const parsed: ParsedArgs = {
    checkpointPath,
    recoveredLotsPath
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const nextValue = rest[index + 1];

    if (token === "--output" && nextValue) {
      parsed.outputPath = nextValue;
      index += 1;
      continue;
    }

    if (token === "--session-name" && nextValue) {
      parsed.sessionName = nextValue;
      index += 1;
      continue;
    }

    return undefined;
  }

  return parsed;
};

const parsedArgs = parseArgs(process.argv.slice(2));

if (!parsedArgs) {
  console.error(usage);
  process.exitCode = 1;
} else {
  void (async () => {
    try {
      const checkpointPath = path.resolve(process.cwd(), parsedArgs.checkpointPath);
      const recoveredLotsPath = path.resolve(process.cwd(), parsedArgs.recoveredLotsPath);
      const checkpoint = readJsonFile<RuntimeCheckpointReport>(checkpointPath);
      const recoveredPayload = readFileSync(recoveredLotsPath, "utf8").replace(/^\uFEFF/, "");
      const recoveredLots = extractRecoveredLots(recoveredPayload, recoveredLotsPath);
      const report = buildRestartDrillReport({
        sessionName: parsedArgs.sessionName,
        checkpoint,
        recoveredLots
      });
      const serialized = `${JSON.stringify(report satisfies RestartDrillReport, null, 2)}\n`;

      if (parsedArgs.outputPath) {
        const outputPath = path.resolve(process.cwd(), parsedArgs.outputPath);
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, serialized, "utf8");
      } else {
        process.stdout.write(serialized);
      }

      await createConfiguredAlertDispatcher(logger).dispatch(buildRestartDrillAlert(report));
    } catch (error) {
      console.error(
        `Failed to build restart drill report: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  })();
}
