// Fix J test — verify pollConditionalBalanceUntilSufficient correctly handles the
// post-BUY balance lag scenario.
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pollConditionalBalanceUntilSufficient } from "../src/polymarket/balance-poller.js";

const silentLogger = pino({ level: "silent" });

const buildClient = (
  balanceSequence: Array<string | Error>
): {
  getBalanceAllowance: ReturnType<typeof vi.fn>;
  updateBalanceAllowance: ReturnType<typeof vi.fn>;
} => {
  let i = 0;
  const getBalanceAllowance = vi.fn().mockImplementation(async () => {
    const next = balanceSequence[Math.min(i, balanceSequence.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return { balance: next ?? "0", allowance: "1e+71" };
  });
  const updateBalanceAllowance = vi.fn().mockResolvedValue(undefined);
  return { getBalanceAllowance, updateBalanceAllowance };
};

const sharesToRaw = (shares: number): string => String(Math.round(shares * 1_000_000));

describe("pollConditionalBalanceUntilSufficient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when balance is already sufficient on first poll", async () => {
    const client = buildClient([sharesToRaw(10)]);
    const promise = pollConditionalBalanceUntilSufficient(
      client as never,
      silentLogger,
      {
        tokenId: "tok-1",
        requiredShares: 10,
        timeoutMs: 5_000,
        forceUpdate: false
      }
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("sufficient");
    expect(result.observedBalance).toBeCloseTo(10, 6);
    expect(result.pollCount).toBe(1);
    expect(client.getBalanceAllowance).toHaveBeenCalledTimes(1);
  });

  it("retries until balance reaches required shares (post-BUY lag scenario)", async () => {
    // Polymarket backend reports 0 for first 2 polls (balance still propagating),
    // then 5 (still not enough), then 10 (full).
    const client = buildClient([
      sharesToRaw(0),
      sharesToRaw(0),
      sharesToRaw(5),
      sharesToRaw(10)
    ]);
    const promise = pollConditionalBalanceUntilSufficient(
      client as never,
      silentLogger,
      {
        tokenId: "tok-1",
        requiredShares: 10,
        timeoutMs: 10_000,
        initialDelayMs: 100,
        forceUpdate: false
      }
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("sufficient");
    expect(result.observedBalance).toBeCloseTo(10, 6);
    expect(result.pollCount).toBeGreaterThanOrEqual(4);
  });

  it("times out cleanly when balance never reaches required shares", async () => {
    const client = buildClient([sharesToRaw(0)]);
    const promise = pollConditionalBalanceUntilSufficient(
      client as never,
      silentLogger,
      {
        tokenId: "tok-1",
        requiredShares: 10,
        timeoutMs: 500,
        initialDelayMs: 100,
        forceUpdate: false
      }
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("timeout");
    expect(result.observedBalance).toBe(0);
    expect(result.pollCount).toBeGreaterThan(0);
  });

  it("calls updateBalanceAllowance between polls when forceUpdate=true", async () => {
    const client = buildClient([sharesToRaw(10)]);
    const promise = pollConditionalBalanceUntilSufficient(
      client as never,
      silentLogger,
      {
        tokenId: "tok-1",
        requiredShares: 10,
        timeoutMs: 5_000,
        forceUpdate: true
      }
    );
    await vi.runAllTimersAsync();
    await promise;
    expect(client.updateBalanceAllowance).toHaveBeenCalled();
  });

  it("survives transient getBalanceAllowance errors and continues retrying", async () => {
    const client = buildClient([
      new Error("network blip"),
      sharesToRaw(10)
    ]);
    const promise = pollConditionalBalanceUntilSufficient(
      client as never,
      silentLogger,
      {
        tokenId: "tok-1",
        requiredShares: 10,
        timeoutMs: 5_000,
        initialDelayMs: 100,
        forceUpdate: false
      }
    );
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe("sufficient");
    expect(result.observedBalance).toBeCloseTo(10, 6);
    expect(result.pollCount).toBeGreaterThanOrEqual(2);
  });
});
