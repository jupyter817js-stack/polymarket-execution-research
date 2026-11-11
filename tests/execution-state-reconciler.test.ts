import { describe, expect, it, vi } from "vitest";

import { reconcileExpectedConditionalBalances } from "../src/trading/execution-state-reconciler.js";

describe("execution-state-reconciler", () => {
  it("passes when balances converge to expected values within the timeout window", async () => {
    const client = {
      getBalanceAllowance: vi
        .fn()
        .mockResolvedValueOnce({ balance: "0", allowance: "0" })
        .mockResolvedValueOnce({ balance: "1", allowance: "1" })
        .mockResolvedValueOnce({ balance: "5", allowance: "5" })
        .mockResolvedValueOnce({ balance: "3", allowance: "3" })
    };

    const result = await reconcileExpectedConditionalBalances(
      client as never,
      [
        { tokenId: "token-a", expectedBalance: 5 },
        { tokenId: "token-b", expectedBalance: 3 }
      ],
      {
        timeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    expect(result.matched).toBe(true);
    expect(result.snapshots).toHaveLength(2);
  });

  it("returns a mismatch detail when balances do not converge", async () => {
    const client = {
      getBalanceAllowance: vi.fn().mockResolvedValue({ balance: "0", allowance: "0" })
    };

    const result = await reconcileExpectedConditionalBalances(
      client as never,
      [{ tokenId: "token-a", expectedBalance: 5, label: "market-a:Yes" }],
      {
        timeoutMs: 10,
        pollIntervalMs: 1
      }
    );

    expect(result.matched).toBe(false);
    expect(result.detail).toContain("market-a:Yes");
  });
});
