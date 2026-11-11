import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  buildSmallLiveRollupReport,
  type SmallLiveRollupReport
} from "../session-report/small-live-rollup.js";
import type { SmallLiveReport } from "../session-report/small-live-report.js";

type ParsedArgs = {
  inputs: string[];
  outputPath?: string;
  groupName?: string;
};

const usage =
  "Usage: npm run report:small-live-rollup -- <small-live-report-or-dir> [more files/dirs...] [--output <rollup.json>] [--group-name <name>]";

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;

const collectJsonFiles = (inputPath: string): string[] => {
  const resolvedPath = path.resolve(process.cwd(), inputPath);
  const stats = statSync(resolvedPath);

  if (stats.isDirectory()) {
    return readdirSync(resolvedPath)
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(resolvedPath, entry))
      .sort((left, right) => left.localeCompare(right));
  }

  return [resolvedPath];
};

const parseArgs = (argv: string[]): ParsedArgs | undefined => {
  const parsed: ParsedArgs = {
    inputs: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = argv[index + 1];

    if (token === undefined) {
      continue;
    }

    if (token === "--output" && nextValue) {
      parsed.outputPath = nextValue;
      index += 1;
      continue;
    }

    if (token === "--group-name" && nextValue) {
      parsed.groupName = nextValue;
      index += 1;
      continue;
    }

    if (token.startsWith("--")) {
      return undefined;
    }

    parsed.inputs.push(token);
  }

  return parsed.inputs.length > 0 ? parsed : undefined;
};

const parsedArgs = parseArgs(process.argv.slice(2));

if (!parsedArgs) {
  console.error(usage);
  process.exitCode = 1;
} else {
  try {
    const inputFiles = [...new Set(parsedArgs.inputs.flatMap((input) => collectJsonFiles(input)))];
    if (inputFiles.length === 0) {
      throw new Error("No small-live JSON files were found in the provided inputs.");
    }

    const reports = inputFiles.map((filePath) => readJsonFile<SmallLiveReport>(filePath));
    const rollup = buildSmallLiveRollupReport({
      groupName: parsedArgs.groupName,
      reports
    });
    const serialized = `${JSON.stringify(rollup satisfies SmallLiveRollupReport, null, 2)}\n`;

    if (parsedArgs.outputPath) {
      const outputPath = path.resolve(process.cwd(), parsedArgs.outputPath);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, serialized, "utf8");
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    console.error(
      `Failed to build small-live rollup: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
