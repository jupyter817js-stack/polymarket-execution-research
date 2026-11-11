import { Contract, Signer, constants } from "ethers";
import { getContractConfig, type ClobClient } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";
import { recordInventoryCloseResult } from "../core/inventory-pnl.js";
import type {
  InventoryLotSnapshot,
  InventoryLotTracker
} from "../core/inventory-lot-tracker.js";
import type { PnLEngineLike, RiskManagerLike } from "../core/types.js";
import {
  fetchClosedBinaryMarketResolutionBySlug,
  type ClosedBinaryMarketResolution
} from "../polymarket/gamma.js";

const CONDITIONAL_TOKENS_REDEEM_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
];

type EthersLikeSigner = Signer & {
  getAddress(): Promise<string>;
  provider?: unknown;
};

type ClosedMarketResolutionFetcher = (
  slug: string
) => Promise<ClosedBinaryMarketResolution | undefined>;

type ClaimExecutor = (
  market: ClosedBinaryMarketResolution
) => Promise<{ txHash: string }>;

type ResolvedMarketClaimServiceOptions = {
  client: ClobClient;
  logger: Logger;
  inventoryTracker: InventoryLotTracker;
  pnlEngine: PnLEngineLike;
  riskManager?: RiskManagerLike;
  onInventoryChanged?: () => void;
  fetchResolution?: ClosedMarketResolutionFetcher;
  executeClaim?: ClaimExecutor;
  intervalMs?: number;
};

const asEthersLikeSigner = (signer: unknown): EthersLikeSigner | undefined =>
  signer &&
  typeof signer === "object" &&
  typeof (signer as { getAddress?: unknown }).getAddress === "function" &&
  typeof (signer as { provider?: unknown }).provider !== "undefined"
    ? (signer as EthersLikeSigner)
    : undefined;

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const buildConditionIdSignature = (lots: readonly InventoryLotSnapshot[]): string =>
  [...new Set(lots.map((lot) => lot.conditionId).filter((value): value is string => Boolean(value)))]
    .sort()
    .join(",");

export class ResolvedMarketClaimService {
  private readonly intervalMs: number;
  private readonly fetchResolution: ClosedMarketResolutionFetcher;
  private readonly executeClaim: ClaimExecutor;
  private readonly inFlightMarketScopes = new Set<string>();
  private readonly warnedUnsupportedSigning = new Set<string>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: ResolvedMarketClaimServiceOptions) {
    this.intervalMs =
      options.intervalMs ?? config.marketMaker.resolvedClaimRefreshMs;
    this.fetchResolution =
      options.fetchResolution ?? fetchClosedBinaryMarketResolutionBySlug;
    this.executeClaim =
      options.executeClaim ?? ((market) => this.executeClaimOnchain(market));
  }

  start(): void {
    if (config.mode !== "live" || !config.marketMaker.enableResolvedClaim) {
      return;
    }

    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  async runOnce(): Promise<void> {
    if (!config.marketMaker.enableResolvedClaim) {
      return;
    }

    const openLots = this.options.inventoryTracker
      .exportOpenLots()
      .filter((lot) => lot.strategy === "market-making");

    const lotsByMarketScope = new Map<string, InventoryLotSnapshot[]>();

    for (const lot of openLots) {
      const existing = lotsByMarketScope.get(lot.marketScope) ?? [];
      existing.push(lot);
      lotsByMarketScope.set(lot.marketScope, existing);
    }

    for (const [marketScope, lots] of lotsByMarketScope) {
      if (this.inFlightMarketScopes.has(marketScope)) {
        continue;
      }

      this.inFlightMarketScopes.add(marketScope);

      try {
        await this.processMarketScope(marketScope, lots);
      } catch (error) {
        this.options.logger.warn(
          {
            err: error,
            marketScope
          },
          "Resolved market claim evaluation failed."
        );
      } finally {
        this.inFlightMarketScopes.delete(marketScope);
      }
    }
  }

  private async processMarketScope(
    marketScope: string,
    lots: readonly InventoryLotSnapshot[]
  ): Promise<void> {
    const resolution = await this.fetchResolution(marketScope);

    if (!resolution) {
      return;
    }

    const lotConditionSignature = buildConditionIdSignature(lots);
    const resolutionConditionId = resolution.market.conditionId;

    if (
      lotConditionSignature.length > 0 &&
      !lotConditionSignature.split(",").includes(resolutionConditionId)
    ) {
      this.options.logger.warn(
        {
          marketScope,
          lotConditionIds: lotConditionSignature,
          resolvedConditionId: resolutionConditionId
        },
        "Skipped resolved market claim because inventory condition IDs did not match the Gamma resolution record."
      );
      return;
    }

    const trackedLots = lots.filter((lot) =>
      resolution.market.tokenIds.includes(lot.tokenId)
    );

    if (trackedLots.length === 0) {
      return;
    }

    const { txHash } = await this.executeClaim(resolution);
    const closedAtMs = Date.now();
    let inventoryChanged = false;

    for (const lot of trackedLots) {
      const tokenIndex = resolution.market.tokenIds.indexOf(lot.tokenId);

      if (tokenIndex < 0) {
        continue;
      }

      const payoutFraction = resolution.payoutFractions[tokenIndex] ?? 0;
      const closeResult = this.options.inventoryTracker.closeLots({
        tokenId: lot.tokenId,
        shares: lot.shares,
        proceedsUsdc: lot.shares * payoutFraction,
        closedAtMs,
        metadata: {
          executionSource: "resolved-claim",
          marketSlug: resolution.market.slug,
          txHash,
          payoutFraction: Number(payoutFraction.toFixed(8))
        }
      });

      recordInventoryCloseResult({
        closeResult,
        pnlEngine: this.options.pnlEngine,
        riskManager: this.options.riskManager,
        logger: this.options.logger,
        closeReason: `Resolved market claim redeemed inventory in ${resolution.market.slug}.`,
        executionSource: "resolved-claim"
      });
      inventoryChanged = inventoryChanged || closeResult.pieces.length > 0;
    }

    if (inventoryChanged) {
      this.options.onInventoryChanged?.();
    }

    this.options.logger.info(
      {
        market: resolution.market.slug,
        conditionId: resolution.market.conditionId,
        txHash,
        payoutFractions: resolution.payoutFractions,
        closedLots: trackedLots.map((lot) => ({
          tokenId: lot.tokenId,
          outcome: lot.outcome,
          shares: lot.shares
        }))
      },
      "Resolved market inventory was claimed and settled into realized PnL."
    );
  }

  private async executeClaimOnchain(
    market: ClosedBinaryMarketResolution
  ): Promise<{ txHash: string }> {
    const signer = asEthersLikeSigner(this.options.client.signer);

    if (!signer) {
      const key = `unsupported:${market.market.slug}`;

      if (!this.warnedUnsupportedSigning.has(key)) {
        this.warnedUnsupportedSigning.add(key);
        this.options.logger.warn(
          {
            market: market.market.slug
          },
          "Resolved market auto-claim requires an ethers-compatible signer with provider access."
        );
      }

      throw new Error("Resolved market auto-claim requires an ethers-compatible signer with provider access.");
    }
    const contractConfig = getContractConfig(this.options.client.chainId);
    const conditionalTokens = new Contract(
      contractConfig.conditionalTokens,
      CONDITIONAL_TOKENS_REDEEM_ABI,
      signer
    );
    const tx = await conditionalTokens.redeemPositions(
      contractConfig.collateral,
      constants.HashZero,
      market.market.conditionId,
      [1, 2]
    );
    const receipt = await tx.wait();

    return {
      txHash: tx.hash ?? receipt?.transactionHash ?? "unknown"
    };
  }
}
