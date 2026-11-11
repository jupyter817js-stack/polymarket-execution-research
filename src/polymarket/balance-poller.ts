import {
  AssetType,
  CONDITIONAL_TOKEN_DECIMALS,
  type ClobClient
} from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { sleep } from "../utils.js";

const EPSILON = 1e-9;
const CONDITIONAL_TOKEN_SCALE = 10 ** CONDITIONAL_TOKEN_DECIMALS;

const parseConditionalBalance = (raw: string | undefined): number => {
  if (typeof raw !== "string" || raw.length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return parsed / CONDITIONAL_TOKEN_SCALE;
};

export interface PollConditionalBalanceOptions {
  tokenId: string;
  requiredShares: number;
  timeoutMs?: number;
  initialDelayMs?: number;
  maxIntervalMs?: number;
  forceUpdate?: boolean;
}

export interface PollConditionalBalanceResult {
  status: "sufficient" | "timeout";
  observedBalance: number;
  pollCount: number;
  elapsedMs: number;
}

/**
 * Polls getBalanceAllowance (CONDITIONAL token) until the on-record balance is at least
 * `requiredShares`. Polymarket's order matching engine checks balance at order-acceptance
 * time. After a BUY fill there is a brief lag (~1–3 s typically) where the REST balance
 * API has not yet reflected the new tokens. Subsequent SELL orders fail with
 *   "balance is not enough -> balance: 0"
 * even though the BUY just settled. Without this poll, every IOC one-leg fill that needs
 * an emergency unwind degrades into a stuck position.
 *
 * Strategy: exponential backoff up to maxIntervalMs, optional updateBalanceAllowance
 * between polls to force backend re-read from chain.
 */
export const pollConditionalBalanceUntilSufficient = async (
  client: ClobClient,
  logger: Logger,
  options: PollConditionalBalanceOptions
): Promise<PollConditionalBalanceResult> => {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const initialDelayMs = options.initialDelayMs ?? 250;
  const maxIntervalMs = options.maxIntervalMs ?? 1_000;
  const forceUpdate = options.forceUpdate ?? true;

  const startMs = Date.now();
  let interval = initialDelayMs;
  let pollCount = 0;
  let lastObservedBalance = 0;

  while (Date.now() - startMs < timeoutMs) {
    if (forceUpdate) {
      try {
        await client.updateBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: options.tokenId
        });
      } catch (err) {
        logger.debug(
          { err, tokenId: options.tokenId },
          "updateBalanceAllowance failed during balance poll; continuing with read-only fetch."
        );
      }
    }

    try {
      const response = await client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: options.tokenId
      });
      const balance = parseConditionalBalance(response.balance);
      lastObservedBalance = balance;
      pollCount += 1;

      if (balance + EPSILON >= options.requiredShares) {
        return {
          status: "sufficient",
          observedBalance: balance,
          pollCount,
          elapsedMs: Date.now() - startMs
        };
      }

      logger.debug(
        {
          tokenId: options.tokenId,
          observedBalance: balance,
          requiredShares: options.requiredShares,
          pollCount,
          elapsedMs: Date.now() - startMs
        },
        "Conditional token balance not yet sufficient; will retry."
      );
    } catch (err) {
      pollCount += 1;
      logger.debug(
        { err, tokenId: options.tokenId, pollCount },
        "getBalanceAllowance failed during balance poll; will retry."
      );
    }

    await sleep(interval);
    interval = Math.min(maxIntervalMs, Math.round(interval * 1.5));
  }

  return {
    status: "timeout",
    observedBalance: lastObservedBalance,
    pollCount,
    elapsedMs: Date.now() - startMs
  };
};
