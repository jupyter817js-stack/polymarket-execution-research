import {
  RelayClient,
  RelayerTxType,
  type RelayerTransactionResponse,
  type Transaction as RelayerTransaction
} from "@polymarket/builder-relayer-client";
import { deriveProxyWallet, deriveSafe } from "@polymarket/builder-relayer-client/dist/builder/derive.js";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import type { ClobClient } from "@polymarket/clob-client-v2";
import {
  CONDITIONAL_TOKEN_DECIMALS,
  getContractConfig
} from "@polymarket/clob-client-v2";
import { BigNumber, Contract, Signer, utils } from "ethers";
import type { Logger } from "pino";

import { config } from "../config.js";
import type { NegativeRiskNoConversionOpportunity } from "../strategy/negative-risk.js";

const CONDITIONAL_TOKENS_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
];

const NEG_RISK_ADAPTER_ABI = [
  "function convertPositions(bytes32 marketId, uint256 indexSet, uint256 amount)"
];

const conditionalTokensInterface = new utils.Interface(CONDITIONAL_TOKENS_ABI);
const negRiskAdapterInterface = new utils.Interface(NEG_RISK_ADAPTER_ABI);

type EthersLikeSigner = Signer & {
  getAddress(): Promise<string>;
  provider?: unknown;
};
type ClobSignerLike = ClobClient["signer"];

type NegativeRiskRelayerClientLike = {
  readonly contractConfig: {
    ProxyContracts: {
      ProxyFactory: string;
    };
    SafeContracts: {
      SafeFactory: string;
    };
  };
  execute(
    txns: RelayerTransaction[],
    metadata?: string
  ): Promise<
    Pick<RelayerTransactionResponse, "transactionHash" | "hash" | "wait"> & {
      wait(): Promise<{ transactionHash?: string } | undefined>;
    }
  >;
};

type NegativeRiskConversionBridgeOptions = {
  relayerUrl?: string;
  relayerTxType?: RelayerTxType | "auto";
  builderConfig?: {
    isValid(): boolean;
  };
  autoApproveAdapter?: boolean;
  relayClientFactory?: (
    signer: EthersLikeSigner,
    txType: RelayerTxType,
    builderConfig: {
      isValid(): boolean;
    }
  ) => NegativeRiskRelayerClientLike;
};

export type NegativeRiskConversionBridgeResult =
  | {
      status: "converted";
      txHash: string;
      autoApprovedAdapter: boolean;
    }
  | {
      status:
        | "approval_missing"
        | "unsupported_signer"
        | "funder_mismatch"
        | "relay_unavailable"
        | "conversion_failed";
      detail: string;
    };

export type NegativeRiskHolderVerification =
  | { status: "ok"; holderAddress: string; routeKind: "direct" | "proxy" | "safe" }
  | { status: "mismatch"; detail: string }
  | { status: "unsupported_signer"; detail: string };

export interface NegativeRiskConversionBridgeLike {
  execute(
    opportunity: NegativeRiskNoConversionOpportunity
  ): Promise<NegativeRiskConversionBridgeResult>;
  verifyHolder?(): Promise<NegativeRiskHolderVerification>;
}

const isEthersLikeSigner = (signer: ClobSignerLike): boolean =>
  Boolean(signer) &&
  typeof (signer as { getAddress?: unknown }).getAddress === "function" &&
  typeof (signer as { _signTypedData?: unknown })._signTypedData === "function";

const toConditionalTokenUnits = (shares: number): BigNumber =>
  utils.parseUnits(shares.toFixed(CONDITIONAL_TOKEN_DECIMALS), CONDITIONAL_TOKEN_DECIMALS);

const asErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isBytes32Hex = (value: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(value);
const normalizeAddress = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const uniqueAddresses = (values: readonly (string | undefined)[]): string[] => {
  const normalized = values
    .map((value) => normalizeAddress(value))
    .filter((value): value is string => typeof value === "string");

  return [...new Set(normalized)];
};

const deriveHolderAddress = (
  signerAddress: string,
  txType: RelayerTxType,
  relayClient: NegativeRiskRelayerClientLike
): string =>
  txType === RelayerTxType.PROXY
    ? deriveProxyWallet(
        signerAddress,
        relayClient.contractConfig.ProxyContracts.ProxyFactory
      ).toLowerCase()
    : deriveSafe(signerAddress, relayClient.contractConfig.SafeContracts.SafeFactory).toLowerCase();

type ResolvedRelayerRoute = {
  txType: RelayerTxType;
  relayClient: NegativeRiskRelayerClientLike;
  holderAddress: string;
};

// Fix H: published Polymarket negRisk contract addresses (cross-checked vs Polygonscan
// at the time of writing). The SDK's getContractConfig should match these; if it ever
// diverges (e.g., an SDK upgrade with new deployments), we want to surface a warning
// rather than silently call into an unexpected contract.
export const EXPECTED_NEG_RISK_ADDRESSES = {
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" // gitleaks:allow -- public contract address, not a credential
} as const;

export class NegativeRiskConversionBridge implements NegativeRiskConversionBridgeLike {
  constructor(
    private readonly client: ClobClient,
    private readonly logger: Logger,
    private readonly makerAddress?: string,
    private readonly options?: NegativeRiskConversionBridgeOptions
  ) {
    this.assertContractConfigSanity();
  }

  // Fix H: log a hard-warning if the SDK-resolved contracts don't match the addresses
  // we cross-checked against Polygonscan. This catches SDK regressions where the
  // bundled contract config might point to a stale/incorrect address.
  private assertContractConfigSanity(): void {
    try {
      const cfg = getContractConfig(this.client.chainId);
      const adapter = cfg.negRiskAdapter?.toLowerCase();
      const ctf = cfg.conditionalTokens?.toLowerCase();
      const expectedAdapter = EXPECTED_NEG_RISK_ADDRESSES.negRiskAdapter.toLowerCase();
      const expectedCtf = EXPECTED_NEG_RISK_ADDRESSES.conditionalTokens.toLowerCase();
      if (adapter !== expectedAdapter || ctf !== expectedCtf) {
        this.logger.warn(
          {
            sdkNegRiskAdapter: adapter,
            sdkConditionalTokens: ctf,
            expectedNegRiskAdapter: expectedAdapter,
            expectedConditionalTokens: expectedCtf,
            chainId: this.client.chainId
          },
          "SDK-resolved negative-risk contract addresses differ from expected mainnet deployment. Verify before live execution."
        );
      } else {
        this.logger.debug(
          { chainId: this.client.chainId },
          "Negative Risk conversion bridge contract addresses verified against expected mainnet deployment."
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, chainId: this.client.chainId },
        "Could not resolve SDK contract config for negative-risk address sanity check."
      );
    }
  }

  async execute(
    opportunity: NegativeRiskNoConversionOpportunity
  ): Promise<NegativeRiskConversionBridgeResult> {
    if (!isEthersLikeSigner(this.client.signer)) {
      return {
        status: "unsupported_signer",
        detail:
          "Negative Risk conversion bridge requires an ethers-compatible signer with provider access."
      };
    }

    const signer = this.client.signer as unknown as EthersLikeSigner;
    const signerAddress = (await signer.getAddress()).toLowerCase();
    const preferredHolderAddress = this.getPreferredHolderAddress(signerAddress);

    if (
      !isBytes32Hex(opportunity.conversionMarketId) ||
      !/^0x[0-9a-fA-F]+$/.test(opportunity.conversionIndexSet)
    ) {
      return {
        status: "conversion_failed",
        detail: "Opportunity conversion metadata was not shaped like onchain marketId/indexSet."
      };
    }

    const contractConfig = getContractConfig(this.client.chainId);
    const autoApproveAdapter =
      this.options?.autoApproveAdapter ?? config.negativeRisk.autoApproveAdapter;

    if (signerAddress === preferredHolderAddress) {
      if (!signer.provider) {
        return {
          status: "unsupported_signer",
          detail:
            "Negative Risk conversion bridge needs a signer connected to a Polygon RPC provider. Set POLYBOT_CHAIN_RPC_URL."
        };
      }

      return this.executeDirectConversion({
        signer,
        signerAddress,
        holderAddress: preferredHolderAddress,
        contractConfig,
        opportunity,
        autoApproveAdapter
      });
    }

    return this.executeRelayedConversion({
      signer,
      signerAddress,
      preferredHolderAddress,
      contractConfig,
      opportunity,
      autoApproveAdapter
    });
  }

  private async executeDirectConversion(input: {
    signer: EthersLikeSigner;
    signerAddress: string;
    holderAddress: string;
    contractConfig: ReturnType<typeof getContractConfig>;
    opportunity: NegativeRiskNoConversionOpportunity;
    autoApproveAdapter: boolean;
  }): Promise<NegativeRiskConversionBridgeResult> {
    const conditionalTokens = new Contract(
      input.contractConfig.conditionalTokens,
      CONDITIONAL_TOKENS_ABI,
      input.signer
    );
    const adapter = new Contract(
      input.contractConfig.negRiskAdapter,
      NEG_RISK_ADAPTER_ABI,
      input.signer
    );
    let autoApprovedAdapter = false;

    try {
      const alreadyApproved = await conditionalTokens.isApprovedForAll(
        input.holderAddress,
        input.contractConfig.negRiskAdapter
      );

      if (!alreadyApproved) {
        if (!input.autoApproveAdapter) {
          return {
            status: "approval_missing",
            detail: `Conditional token approval for adapter ${input.contractConfig.negRiskAdapter} is missing. Enable POLYBOT_NEG_RISK_AUTO_APPROVE_ADAPTER or approve it manually first.`
          };
        }

        const approvalTx = await conditionalTokens.setApprovalForAll(
          input.contractConfig.negRiskAdapter,
          true
        );
        await approvalTx.wait();
        autoApprovedAdapter = true;

        this.logger.warn(
          {
            adapter: input.contractConfig.negRiskAdapter,
            txHash: approvalTx.hash,
            signerAddress: input.signerAddress
          },
          "Negative Risk conversion bridge auto-approved the adapter for conditional tokens."
        );
      }
    } catch (error) {
      return {
        status: "conversion_failed",
        detail: `Conditional token approval check failed: ${asErrorMessage(error)}`
      };
    }

    try {
      const tx = await adapter.convertPositions(
        input.opportunity.conversionMarketId,
        BigNumber.from(input.opportunity.conversionIndexSet),
        toConditionalTokenUnits(input.opportunity.shares)
      );
      const receipt = await tx.wait();
      const txHash =
        typeof receipt?.transactionHash === "string" && receipt.transactionHash.length > 0
          ? receipt.transactionHash
          : tx.hash;

      this.logSuccessfulConversion(
        input.opportunity,
        txHash,
        autoApprovedAdapter,
        "Negative Risk conversion bridge completed the onchain NO-to-YES conversion."
      );

      return {
        status: "converted",
        txHash,
        autoApprovedAdapter
      };
    } catch (error) {
      return {
        status: "conversion_failed",
        detail: `Negative Risk conversion transaction failed: ${asErrorMessage(error)}`
      };
    }
  }

  private async executeRelayedConversion(input: {
    signer: EthersLikeSigner;
    signerAddress: string;
    preferredHolderAddress: string;
    contractConfig: ReturnType<typeof getContractConfig>;
    opportunity: NegativeRiskNoConversionOpportunity;
    autoApproveAdapter: boolean;
  }): Promise<NegativeRiskConversionBridgeResult> {
    const relayerUrl = this.options?.relayerUrl ?? config.relayerUrl;
    const builderConfig = this.getBuilderConfig();

    if (!relayerUrl || !builderConfig?.isValid()) {
      return {
        status: "relay_unavailable",
        detail:
          "Negative Risk conversion bridge detected signer/funder separation but no usable Polymarket relayer configuration was available. Configure POLYBOT_RELAYER_URL and local builder credentials."
      };
    }

    const resolvedRoute = this.resolveRelayerRoute({
      relayerUrl,
      builderConfig,
      signer: input.signer,
      signerAddress: input.signerAddress,
      preferredHolderAddress: input.preferredHolderAddress
    });

    if (!resolvedRoute) {
      const allowedHolders = this.getAllowedRelayerHolderAddresses(input.signerAddress);
      const candidateTxTypes = this.getCandidateRelayerTxTypes();
      const derivedByTxType = candidateTxTypes.map((txType) => {
        const relayClient =
          this.options?.relayClientFactory?.(input.signer, txType, builderConfig) ??
          new RelayClient(
            relayerUrl,
            this.client.chainId,
            input.signer as never,
            builderConfig as never,
            txType
          );

        return `${txType.toLowerCase()}:${deriveHolderAddress(
          input.signerAddress,
          txType,
          relayClient
        )}`;
      });

      return {
        status: "funder_mismatch",
        detail: `Negative Risk conversion bridge could not match any relayer holder derived from the signer to the configured custody set. preferredHolder=${input.preferredHolderAddress}; allowedHolders=${allowedHolders.join(",")}; derivedCandidates=${derivedByTxType.join(",")}.`
      };
    }

    const { txType, relayClient, holderAddress } = resolvedRoute;

    const approvalState = await this.readApprovalState(
      holderAddress,
      input.signer,
      input.contractConfig.negRiskAdapter,
      input.contractConfig.conditionalTokens
    );

    if (approvalState === false && !input.autoApproveAdapter) {
      return {
        status: "approval_missing",
        detail: `Conditional token approval for adapter ${input.contractConfig.negRiskAdapter} is missing on ${holderAddress}. Enable POLYBOT_NEG_RISK_AUTO_APPROVE_ADAPTER or approve it before running the relayed conversion bridge.`
      };
    }

    if (approvalState === undefined && !input.autoApproveAdapter) {
      return {
        status: "approval_missing",
        detail:
          "Negative Risk relayed conversion could not verify conditional-token approval because no RPC-backed provider was available. Configure POLYBOT_CHAIN_RPC_URL or enable POLYBOT_NEG_RISK_AUTO_APPROVE_ADAPTER for a blind approval transaction."
      };
    }

    const transactions: RelayerTransaction[] = [];
    const shouldAutoApprove = approvalState !== true && input.autoApproveAdapter;

    if (shouldAutoApprove) {
      transactions.push({
        to: input.contractConfig.conditionalTokens,
        data: conditionalTokensInterface.encodeFunctionData("setApprovalForAll", [
          input.contractConfig.negRiskAdapter,
          true
        ]),
        value: "0"
      });
    }

    transactions.push({
      to: input.contractConfig.negRiskAdapter,
      data: negRiskAdapterInterface.encodeFunctionData("convertPositions", [
        input.opportunity.conversionMarketId,
        BigNumber.from(input.opportunity.conversionIndexSet),
        toConditionalTokenUnits(input.opportunity.shares)
      ]),
      value: "0"
    });

    try {
      const response = await relayClient.execute(
        transactions,
        `negative-risk:${input.opportunity.group.eventSlug}:conversion`
      );
      const result = await response.wait();
      const txHash =
        typeof result?.transactionHash === "string" && result.transactionHash.length > 0
          ? result.transactionHash
          : typeof response.transactionHash === "string" && response.transactionHash.length > 0
            ? response.transactionHash
            : response.hash;

      if (!txHash) {
        return {
          status: "conversion_failed",
          detail: "Negative Risk relayed conversion returned without a transaction hash."
        };
      }

      this.logSuccessfulConversion(
        input.opportunity,
        txHash,
        shouldAutoApprove,
        `Negative Risk conversion bridge completed the relayed ${txType.toLowerCase()} NO-to-YES conversion.`
      );

      return {
        status: "converted",
        txHash,
        autoApprovedAdapter: shouldAutoApprove
      };
    } catch (error) {
      return {
        status: "conversion_failed",
        detail: `Negative Risk relayed conversion transaction failed: ${asErrorMessage(error)}`
      };
    }
  }

  // Fix F: pre-flight verification used at bot startup. Confirms that the signer either
  // matches the funder directly (EOA mode) or that the relayer derives a holder address
  // matching funderAddress (POLY_GNOSIS_SAFE mode). If neither holds, every conversion
  // attempt would silently fail with funder_mismatch — this surfaces the issue early.
  async verifyHolder(): Promise<NegativeRiskHolderVerification> {
    if (!isEthersLikeSigner(this.client.signer)) {
      return {
        status: "unsupported_signer",
        detail: "Signer does not implement ethers-like getAddress/_signTypedData."
      };
    }

    const signer = this.client.signer as unknown as EthersLikeSigner;
    const signerAddress = (await signer.getAddress()).toLowerCase();
    const preferredHolderAddress = this.getPreferredHolderAddress(signerAddress);

    if (signerAddress === preferredHolderAddress) {
      return {
        status: "ok",
        holderAddress: signerAddress,
        routeKind: "direct"
      };
    }

    // Holder is funder/proxy. Try to match via configured relayer routes.
    const relayerUrl = this.options?.relayerUrl ?? config.relayerUrl;
    const builderConfig = this.getBuilderConfig();
    if (!relayerUrl || !builderConfig?.isValid()) {
      return {
        status: "mismatch",
        detail: `Signer ${signerAddress} differs from preferred holder ${preferredHolderAddress} but no relayer/builder credentials are configured.`
      };
    }

    const route = this.resolveRelayerRoute({
      relayerUrl,
      builderConfig,
      signer,
      signerAddress,
      preferredHolderAddress
    });

    if (!route) {
      return {
        status: "mismatch",
        detail: `No relayer route matched preferredHolder ${preferredHolderAddress}. Verify funderAddress / signatureType / builder credentials.`
      };
    }

    return {
      status: "ok",
      holderAddress: route.holderAddress,
      routeKind: route.txType === RelayerTxType.PROXY ? "proxy" : "safe"
    };
  }

  private getPreferredHolderAddress(signerAddress: string): string {
    return (
      normalizeAddress(config.negativeRisk.conversionHolderAddress) ??
      normalizeAddress(this.makerAddress) ??
      signerAddress
    );
  }

  private getAllowedRelayerHolderAddresses(signerAddress: string): string[] {
    return uniqueAddresses([
      config.negativeRisk.conversionHolderAddress,
      this.makerAddress,
      ...config.negativeRisk.allowedRelayerHolderAddresses,
      signerAddress
    ]);
  }

  private getCandidateRelayerTxTypes(): RelayerTxType[] {
    const configuredType =
      this.options?.relayerTxType ?? config.negativeRisk.relayerTxType;

    if (configuredType === "auto") {
      return [RelayerTxType.PROXY, RelayerTxType.SAFE];
    }

    return [configuredType === RelayerTxType.SAFE || configuredType === "safe" ? RelayerTxType.SAFE : RelayerTxType.PROXY];
  }

  private resolveRelayerRoute(input: {
    relayerUrl: string;
    builderConfig: {
      isValid(): boolean;
    };
    signer: EthersLikeSigner;
    signerAddress: string;
    preferredHolderAddress: string;
  }): ResolvedRelayerRoute | undefined {
    const allowedHolderAddresses = this.getAllowedRelayerHolderAddresses(input.signerAddress);

    for (const txType of this.getCandidateRelayerTxTypes()) {
      const relayClient =
        this.options?.relayClientFactory?.(input.signer, txType, input.builderConfig) ??
        new RelayClient(
          input.relayerUrl,
          this.client.chainId,
          input.signer as never,
          input.builderConfig as never,
          txType
        );
      const derivedHolder = deriveHolderAddress(
        input.signerAddress,
        txType,
        relayClient
      );

      if (
        derivedHolder === input.preferredHolderAddress ||
        allowedHolderAddresses.includes(derivedHolder)
      ) {
        return {
          txType,
          relayClient,
          holderAddress: derivedHolder
        };
      }
    }

    return undefined;
  }

  private async readApprovalState(
    holderAddress: string,
    signer: EthersLikeSigner,
    adapterAddress: string,
    conditionalTokensAddress: string
  ): Promise<boolean | undefined> {
    if (!signer.provider) {
      return undefined;
    }

    const conditionalTokens = new Contract(
      conditionalTokensAddress,
      CONDITIONAL_TOKENS_ABI,
      signer.provider as never
    );

    return conditionalTokens.isApprovedForAll(holderAddress, adapterAddress);
  }

  private getBuilderConfig():
    | {
        isValid(): boolean;
      }
    | undefined {
    if (this.options?.builderConfig) {
      return this.options.builderConfig;
    }

    if (!config.builderAuth) {
      return undefined;
    }

    return new BuilderConfig({
      localBuilderCreds: config.builderAuth
    });
  }

  private logSuccessfulConversion(
    opportunity: NegativeRiskNoConversionOpportunity,
    txHash: string,
    autoApprovedAdapter: boolean,
    message: string
  ): void {
    this.logger.info(
      {
        eventId: opportunity.group.eventId,
        eventSlug: opportunity.group.eventSlug,
        conversionMarketId: opportunity.conversionMarketId,
        conversionIndexSet: opportunity.conversionIndexSet,
        shares: opportunity.shares,
        txHash,
        autoApprovedAdapter
      },
      message
    );
  }
}
