import { AssetType, type ClobClient } from "@polymarket/clob-client-v2";

import { config } from "../config.js";
import { readMaxAllowanceRaw } from "../polymarket/balance-allowance.js";
import { sleep } from "../utils.js";

export interface BalanceExpectation {
  tokenId: string;
  expectedBalance: number;
  tolerance?: number;
  label?: string;
}

export interface BalanceSnapshot {
  tokenId: string;
  expectedBalance: number;
  actualBalance: number;
  allowance: number;
  tolerance: number;
  label?: string;
}

export interface BalanceReconciliationResult {
  matched: boolean;
  detail?: string;
  snapshots: BalanceSnapshot[];
}

const DEFAULT_TOLERANCE = 1e-4;

const buildMismatchDetail = (snapshots: readonly BalanceSnapshot[]): string =>
  snapshots
    .map(
      (snapshot) =>
        `${snapshot.label ?? snapshot.tokenId}: actual(${snapshot.actualBalance.toFixed(4)}) != expected(${snapshot.expectedBalance.toFixed(4)})`
    )
    .join("; ");

export const reconcileExpectedConditionalBalances = async (
  client: ClobClient,
  expectations: readonly BalanceExpectation[],
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
  }
): Promise<BalanceReconciliationResult> => {
  if (expectations.length === 0) {
    return {
      matched: true,
      snapshots: []
    };
  }

  const timeoutMs = options?.timeoutMs ?? Math.min(config.ws.userOrderTimeoutMs, 3_000);
  const pollIntervalMs = options?.pollIntervalMs ?? Math.min(config.ws.orderPollIntervalMs, 250);
  const startedAtMs = Date.now();
  let lastResult: BalanceReconciliationResult | undefined;

  while (Date.now() - startedAtMs <= timeoutMs) {
    try {
      const snapshots = await Promise.all(
        expectations.map(async (expectation) => {
          const balanceAllowance = await client.getBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: expectation.tokenId
          });

          const allowanceRaw = readMaxAllowanceRaw(balanceAllowance);
          return {
            tokenId: expectation.tokenId,
            expectedBalance: expectation.expectedBalance,
            actualBalance: Number(balanceAllowance.balance),
            allowance: allowanceRaw ?? 0,
            tolerance: expectation.tolerance ?? DEFAULT_TOLERANCE,
            label: expectation.label
          };
        })
      );

      const mismatches = snapshots.filter(
        (snapshot) =>
          Math.abs(snapshot.actualBalance - snapshot.expectedBalance) > snapshot.tolerance
      );

      if (mismatches.length === 0) {
        return {
          matched: true,
          snapshots
        };
      }

      lastResult = {
        matched: false,
        detail: buildMismatchDetail(mismatches),
        snapshots
      };
    } catch (error) {
      lastResult = {
        matched: false,
        detail: `Balance reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        snapshots: []
      };
    }

    if (Date.now() - startedAtMs >= timeoutMs) {
      break;
    }

    await sleep(pollIntervalMs);
  }

  return (
    lastResult ?? {
      matched: false,
      detail: "Balance reconciliation timed out without a snapshot.",
      snapshots: []
    }
  );
};
