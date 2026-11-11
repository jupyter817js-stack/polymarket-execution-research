import {
  AssetType,
  Chain,
  ClobClient,
  SignatureTypeV2,
  type ApiKeyCreds
} from "@polymarket/clob-client-v2";
import { Wallet, providers } from "ethers";

import type { Logger } from "pino";

import { config } from "../config.js";
import { readMaxAllowanceRaw } from "../polymarket/balance-allowance.js";

export interface LiveClients {
  client: ClobClient;
  readonlyClient: ClobClient;
  creds?: ApiKeyCreds;
  makerAddress?: string;
}

export const createClients = async (logger: Logger): Promise<LiveClients> => {
  const chain = config.chainId as Chain;
  const signatureType = config.signatureType as SignatureTypeV2;
  const baseClientOptions = {
    host: config.host,
    chain,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true
  };
  const builderConfig = config.builderCode
    ? { builderCode: config.builderCode }
    : undefined;
  const readonlyClient = new ClobClient(baseClientOptions);

  if (config.mode === "dry-run") {
    // In dry-run, no orders are placed, but if API credentials are available
    // we still create an authenticated client so balance/allowance queries work
    // for operator status reporting and telegram alerts.
    if (config.privateKey && config.apiCreds) {
      try {
        const provider = config.chainRpcUrl
          ? new providers.JsonRpcProvider(config.chainRpcUrl)
          : undefined;
        const wallet = provider ? new Wallet(config.privateKey, provider) : new Wallet(config.privateKey);
        const dryRunAuthClient = new ClobClient({
          ...baseClientOptions,
          signer: wallet,
          creds: config.apiCreds,
          signatureType,
          funderAddress: config.funderAddress,
          builderConfig
        });
        logger.info({ builderCodeConfigured: Boolean(builderConfig) }, "Dry-run: created authenticated client for balance reads.");
        return {
          client: dryRunAuthClient,
          readonlyClient,
          creds: config.apiCreds,
          makerAddress: config.funderAddress ?? wallet.address
        };
      } catch (error) {
        logger.debug({ err: error }, "Dry-run: could not create authenticated client, falling back to readonly.");
      }
    }

    return {
      client: readonlyClient,
      readonlyClient,
      makerAddress: config.funderAddress
    };
  }

  const provider = config.chainRpcUrl
    ? new providers.JsonRpcProvider(config.chainRpcUrl)
    : undefined;
  const wallet = provider ? new Wallet(config.privateKey!, provider) : new Wallet(config.privateKey!);
  const makerAddress = config.funderAddress ?? wallet.address;
  const bootstrapClient = new ClobClient({
    ...baseClientOptions,
    signer: wallet,
    signatureType,
    funderAddress: config.funderAddress
  });
  const creds =
    config.apiCreds ??
    (await bootstrapClient.createOrDeriveApiKey(config.apiNonce));

  const client = new ClobClient({
    ...baseClientOptions,
    signer: wallet,
    creds,
    signatureType,
    funderAddress: config.funderAddress,
    builderConfig
  });

  try {
    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const allowanceRaw = readMaxAllowanceRaw(collateral);
    logger.info(
      {
        collateralBalance: collateral.balance,
        collateralAllowance: allowanceRaw !== undefined ? String(allowanceRaw) : null,
        chainRpcConfigured: Boolean(config.chainRpcUrl),
        builderCodeConfigured: Boolean(builderConfig)
      },
      "Loaded live Polymarket trading client."
    );
  } catch (error) {
    logger.warn({ err: error }, "Collateral allowance preflight failed.");
  }

  if (config.negativeRisk.enableLiveConversionBridge && !provider) {
    if (config.relayerUrl && config.builderAuth) {
      logger.warn(
        "Negative Risk live conversion bridge is enabled without POLYBOT_CHAIN_RPC_URL. Direct signer-held conversion is unavailable, and relayed proxy/safe conversion can only use blind adapter approval unless the approval is already in place."
      );
    } else {
      logger.warn(
        "Negative Risk live conversion bridge is enabled but POLYBOT_CHAIN_RPC_URL is not configured. Direct onchain conversion will stay unavailable, and no relayer bridge credentials were detected."
      );
    }
  }

  if (
    config.negativeRisk.enableLiveConversionBridge &&
    makerAddress.toLowerCase() !== wallet.address.toLowerCase() &&
    (!config.relayerUrl || !config.builderAuth)
  ) {
    logger.warn(
      {
        signerAddress: wallet.address,
        makerAddress,
        relayerConfigured: Boolean(config.relayerUrl),
        builderAuthConfigured: Boolean(config.builderAuth)
      },
      "Negative Risk conversion bridge detected a signer/funder split, but no relayer configuration is available yet. Proxy/safe conversion will remain blocked."
    );
  }

  return {
    client,
    readonlyClient,
    creds,
    makerAddress
  };
};
