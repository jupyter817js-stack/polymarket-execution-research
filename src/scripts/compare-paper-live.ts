import { readFileSync } from "node:fs";
import path from "node:path";

import type { PaperTradingSessionReport } from "../paper-trading/report.js";
import { comparePaperAndRealizedSessions } from "../session-report/paper-live-comparison.js";
import type { RealizedTradingSessionReport } from "../session-report/realized-report.js";

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, "")) as T;

const paperPathArg = process.argv[2];
const realizedPathArg = process.argv[3];

if (!paperPathArg || !realizedPathArg) {
  console.error("Usage: npm run compare:paper-live -- <paper-report.json> <realized-report.json>");
  process.exitCode = 1;
} else {
  const paperPath = path.resolve(process.cwd(), paperPathArg);
  const realizedPath = path.resolve(process.cwd(), realizedPathArg);

  try {
    const paper = readJsonFile<PaperTradingSessionReport>(paperPath);
    const realized = readJsonFile<RealizedTradingSessionReport>(realizedPath);
    const report = comparePaperAndRealizedSessions({
      paper,
      realized
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(
      `Failed to compare paper and realized reports: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}
