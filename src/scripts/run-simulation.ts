import path from "node:path";

import {
  loadSimulationScenarioFromFile,
  runSimulationScenario
} from "../simulation/harness.js";

const scenarioArg = process.argv[2];

if (!scenarioArg) {
  console.error("Usage: npm run simulate -- <scenario.json>");
  process.exitCode = 1;
} else {
  const resolvedPath = path.resolve(process.cwd(), scenarioArg);

  try {
    const scenario = loadSimulationScenarioFromFile(resolvedPath);
    const report = runSimulationScenario(scenario);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(
      `Failed to run simulation scenario at ${resolvedPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  }
}
