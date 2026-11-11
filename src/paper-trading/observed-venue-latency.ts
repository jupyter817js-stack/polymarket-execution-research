import type { NormalizedOrderBook } from "../types.js";

export type ObservedVenueLatencySummary = {
  observedVenueLatencyMs?: number;
  observedBookSkewMs?: number;
};

export const summarizeObservedVenueLatency = (input: {
  detectedAtMs: number;
  books: readonly (NormalizedOrderBook | undefined)[];
}): ObservedVenueLatencySummary => {
  const updatedAtMs = input.books
    .map((book) => book?.updatedAtMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (updatedAtMs.length === 0) {
    return {};
  }

  const observedVenueLatencyMs = Math.max(
    ...updatedAtMs.map((timestampMs) => Math.max(0, input.detectedAtMs - timestampMs))
  );
  const observedBookSkewMs =
    updatedAtMs.length > 1 ? Math.max(...updatedAtMs) - Math.min(...updatedAtMs) : 0;

  return {
    observedVenueLatencyMs,
    observedBookSkewMs
  };
};
