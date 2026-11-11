import "dotenv/config";

import { fetchBinaryMarketsWithDiagnostics } from "../polymarket/gamma.js";

const main = async (): Promise<void> => {
  console.log("Calling fetchBinaryMarketsWithDiagnostics()...");
  const t0 = Date.now();
  try {
    const result = await fetchBinaryMarketsWithDiagnostics();
    console.log(
      `OK in ${Date.now() - t0}ms — ${result.markets.length} markets, diagnostics:`,
      result.diagnostics
    );
  } catch (error) {
    console.error(
      `FAILED after ${Date.now() - t0}ms:`,
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error("script error:", err);
  process.exitCode = 1;
});
