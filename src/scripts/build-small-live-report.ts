import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createConfiguredAlertDispatcher } from "../core/alert-dispatcher.js";
import { buildSmallLiveAlert } from "../core/alert-events.js";
import { logger } from "../logger.js";
import type { PaperTradingSessionReport } from "../paper-trading/report.js";
import type { RestartDrillReport } from "../session-report/restart-drill-report.js";
import type { RealizedTradingSessionReport } from "../session-report/realized-report.js";
import {
  buildSmallLiveReport,
  type RuntimeCheckpointReport
} from "../session-report/small-live-report.js";

type ParsedArgs = {
  realizedPath: string;
  paperPath?: string;
  checkpointPath?: string;
  restartDrillPath?: string;
  outputPath?: string;
  sessionName?: string;
};

const usage =
  "Usage: npm run report:small-live -- <realized-report.json> [--paper <paper-report.json>] [--checkpoint <runtime-checkpoint.json>] [--restart-drill <restart-drill-report.json>] [--output <small-live-report.json>] [--session-name <name>]";

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;

const parseArgs = (argv: string[]): ParsedArgs | undefined => {
  const [realizedPath, ...rest] = argv;
  if (!realizedPath) {
    return undefined;
  }

  const parsed: ParsedArgs = {
    realizedPath
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const nextValue = rest[index + 1];

    if (token === "--paper" && nextValue) {
      parsed.paperPath = nextValue;
      index += 1;
      continue;
    }

    if (token === "--checkpoint" && nextValue) {
      parsed.checkpointPath = nextValue;
      index += 1;
      continue;
    }

    if (token === "--restart-drill" && nextValue) {
      parsed.restartDrillPath = nextValue;
      index += 1;
      continue;
    }

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
      const realizedPath = path.resolve(process.cwd(), parsedArgs.realizedPath);
      const realized = readJsonFile<RealizedTradingSessionReport>(realizedPath);
      const paper = parsedArgs.paperPath
        ? readJsonFile<PaperTradingSessionReport>(path.resolve(process.cwd(), parsedArgs.paperPath))
        : undefined;
      const checkpoint = parsedArgs.checkpointPath
        ? readJsonFile<RuntimeCheckpointReport>(
            path.resolve(process.cwd(), parsedArgs.checkpointPath)
          )
        : undefined;
      const restartDrill = parsedArgs.restartDrillPath
        ? readJsonFile<RestartDrillReport>(
            path.resolve(process.cwd(), parsedArgs.restartDrillPath)
          )
        : undefined;
      const report = buildSmallLiveReport({
        sessionName: parsedArgs.sessionName,
        realized,
        paper,
        checkpoint,
        restartDrill
      });
      const serialized = `${JSON.stringify(report, null, 2)}\n`;

      if (parsedArgs.outputPath) {
        const outputPath = path.resolve(process.cwd(), parsedArgs.outputPath);
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, serialized, "utf8");
      } else {
        process.stdout.write(serialized);
      }

      await createConfiguredAlertDispatcher(logger).dispatch(buildSmallLiveAlert(report));
    } catch (error) {
      console.error(
        `Failed to build small-live report: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  })();
}
