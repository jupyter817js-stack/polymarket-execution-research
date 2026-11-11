import path from "node:path";

import {
  buildPaperTradingReportFromSimulation
} from "../paper-trading/report.js";
import { toPaperTradingCsv } from "../paper-trading/report.js";
import {
  loadSimulationScenarioFromFile,
  runSimulationScenario
} from "../simulation/harness.js";

const scenarioArg = process.argv[2];

if (!scenarioArg) {
  console.error("Usage: npm run paper-csv -- <scenario.json>");
  console.error("");
  console.error("Runs the simulation scenario and outputs a CSV report to stdout.");
  console.error("Redirect to a file:  npm run paper-csv -- scenario.json > report.csv");
  process.exitCode = 1;
} else {
  const resolvedPath = path.resolve(process.cwd(), scenarioArg);

  try {
    const scenario = loadSimulationScenarioFromFile(resolvedPath);
    const simulationReport = runSimulationScenario(scenario);
    const paperReport = buildPaperTradingReportFromSimulation(simulationReport);
    process.stdout.write(toPaperTradingCsv(paperReport) + "\n");
  } catch (error) {
    console.error(
      `Failed to generate CSV at ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}
