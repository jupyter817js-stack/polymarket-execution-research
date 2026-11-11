import path from "node:path";

import { buildPaperTradingReportFromSimulation } from "../paper-trading/report.js";
import {
  loadSimulationScenarioFromFile,
  runSimulationScenario
} from "../simulation/harness.js";

const scenarioArg = process.argv[2];

if (!scenarioArg) {
  console.error("Usage: npm run paper -- <scenario.json>");
  process.exitCode = 1;
} else {
  const resolvedPath = path.resolve(process.cwd(), scenarioArg);

  try {
    const scenario = loadSimulationScenarioFromFile(resolvedPath);
    const simulationReport = runSimulationScenario(scenario);
    const paperReport = buildPaperTradingReportFromSimulation(simulationReport);
    process.stdout.write(`${JSON.stringify(paperReport, null, 2)}\n`);
  } catch (error) {
    console.error(
      `Failed to run paper trading report at ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}
