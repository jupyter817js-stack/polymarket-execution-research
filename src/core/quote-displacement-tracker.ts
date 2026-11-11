const ROLLING_WINDOW_MS = 10 * 60 * 1_000; // 10-minute sliding window
const MIN_DATA_POINTS = 3; // need at least 3 posted quotes before reporting a rate

type TimestampedEvent = { timestampMs: number };

export class QuoteDisplacementTracker {
  private readonly posted = new Map<string, TimestampedEvent[]>();
  private readonly displaced = new Map<string, TimestampedEvent[]>();

  recordQuotePosted(conditionId: string, nowMs = Date.now()): void {
    this.append(this.posted, conditionId, nowMs);
  }

  recordPriceDisplacement(conditionId: string, nowMs = Date.now()): void {
    this.append(this.displaced, conditionId, nowMs);
  }

  /**
   * Returns the fraction of posted quotes that were price-displaced in the rolling
   * window, or 0 if there are fewer than MIN_DATA_POINTS posted events.
   */
  getDisplacementRate(conditionId: string, nowMs = Date.now()): number {
    const postedWindow = this.window(this.posted, conditionId, nowMs);

    if (postedWindow.length < MIN_DATA_POINTS) {
      return 0;
    }

    const displacedWindow = this.window(this.displaced, conditionId, nowMs);
    return displacedWindow.length / postedWindow.length;
  }

  private append(
    map: Map<string, TimestampedEvent[]>,
    conditionId: string,
    nowMs: number
  ): void {
    const cutoff = nowMs - ROLLING_WINDOW_MS;
    const events = map.get(conditionId) ?? [];
    events.push({ timestampMs: nowMs });
    map.set(conditionId, events.filter((e) => e.timestampMs >= cutoff));
  }

  private window(
    map: Map<string, TimestampedEvent[]>,
    conditionId: string,
    nowMs: number
  ): TimestampedEvent[] {
    const cutoff = nowMs - ROLLING_WINDOW_MS;
    return (map.get(conditionId) ?? []).filter((e) => e.timestampMs >= cutoff);
  }
}
