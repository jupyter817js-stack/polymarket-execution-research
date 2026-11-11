import "dotenv/config";

import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

type Mode = "auto" | "create" | "derive";

interface Options {
  mode: Mode;
  privateKey?: string;
  nonce?: number;
  host: string;
  chainId: number;
  signatureType?: number;
  funderAddress?: string;
}

const readArgValue = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  return item ? item.slice(prefix.length) : undefined;
};

const parseOptionalNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mask = (value: string): string => {
  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const parseOptions = (): Options => {
  const modeArg = readArgValue("mode");
  const mode: Mode =
    modeArg === "create" || modeArg === "derive" || modeArg === "auto" ? modeArg : "auto";

  return {
    mode,
    privateKey:
      readArgValue("private-key") ??
      process.env.POLYBOT_PRIVATE_KEY ??
      process.env.POLY_PK,
    nonce: parseOptionalNumber(readArgValue("nonce") ?? process.env.POLYBOT_API_NONCE),
    host: readArgValue("host") ?? process.env.POLYBOT_HOST ?? "https://clob.polymarket.com",
    chainId: parseOptionalNumber(readArgValue("chain-id") ?? process.env.POLYBOT_CHAIN_ID) ?? 137,
    signatureType: parseOptionalNumber(
      readArgValue("signature-type") ?? process.env.POLYBOT_SIGNATURE_TYPE
    ),
    funderAddress: readArgValue("funder") ?? process.env.POLYBOT_FUNDER_ADDRESS
  };
};

const printUsage = (): void => {
  console.log("Usage:");
  console.log("  npm run gen:key");
  console.log("  npm run gen:key -- --mode=auto --nonce=0");
  console.log("  npm run gen:key -- --private-key=0x... --signature-type=2 --funder=0x...");
  console.log("");
  console.log("Accepted modes:");
  console.log("  auto   -> createOrDeriveApiKey (recommended)");
  console.log("  create -> createApiKey");
  console.log("  derive -> deriveApiKey");
  console.log("");
  console.log("Private key source priority:");
  console.log("  --private-key > POLYBOT_PRIVATE_KEY > POLY_PK");
};

const buildEnvBlock = (
  creds: { key: string; secret: string; passphrase: string },
  options: Options
): string => {
  const lines = [
    `POLYBOT_API_KEY=${creds.key}`,
    `POLYBOT_API_SECRET=${creds.secret}`,
    `POLYBOT_API_PASSPHRASE=${creds.passphrase}`
  ];

  if (typeof options.nonce === "number") {
    lines.push(`POLYBOT_API_NONCE=${options.nonce}`);
  }

  if (typeof options.signatureType === "number") {
    lines.push(`POLYBOT_SIGNATURE_TYPE=${options.signatureType}`);
  }

  if (options.funderAddress) {
    lines.push(`POLYBOT_FUNDER_ADDRESS=${options.funderAddress}`);
  }

  return lines.join("\n");
};

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const isCreateApiKeyFailure = (error: unknown): boolean => {
  const message = describeError(error).toLowerCase();
  return message.includes("could not create api key");
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions();

  if (!options.privateKey) {
    console.error("Missing private key.");
    console.error("Set POLYBOT_PRIVATE_KEY in .env or pass --private-key=0x...");
    process.exit(1);
  }

  const signer = new Wallet(options.privateKey);
  const address = await signer.getAddress();
  const client = new ClobClient({
    host: options.host,
    chain: options.chainId as Chain,
    signer,
    signatureType: options.signatureType as SignatureTypeV2 | undefined,
    funderAddress: options.funderAddress,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true
  });

  console.log("Generating Polymarket CLOB API credentials...");
  console.log(`Signer address: ${address}`);
  console.log(`Host: ${options.host}`);
  console.log(`Chain ID: ${options.chainId}`);
  console.log(`Mode: ${options.mode}`);
  console.log(`Nonce: ${typeof options.nonce === "number" ? options.nonce : "(default 0)"}`);

  if (typeof options.signatureType === "number") {
    console.log(`Signature type hint: ${options.signatureType}`);
  }

  if (options.funderAddress) {
    console.log(`Funder address hint: ${options.funderAddress}`);
  }

  const creds =
    options.mode === "create"
      ? await client.createApiKey(options.nonce)
      : options.mode === "derive"
        ? await client.deriveApiKey(options.nonce)
        : await (async () => {
            try {
              return await client.createApiKey(options.nonce);
            } catch (error) {
              if (!isCreateApiKeyFailure(error)) {
                throw error;
              }

              console.log("");
              console.log("Create step failed. Falling back to derive with the same nonce...");
              return client.deriveApiKey(options.nonce);
            }
          })();

  console.log("");
  console.log("CLOB API credentials generated.");
  console.log(JSON.stringify(creds, null, 2));
  console.log("");
  console.log("Suggested .env block:");
  console.log(buildEnvBlock(creds, options));
  console.log("");
  console.log("Masked summary:");
  console.log(`POLYBOT_API_KEY=${mask(creds.key)}`);
  console.log(`POLYBOT_API_SECRET=${mask(creds.secret)}`);
  console.log(`POLYBOT_API_PASSPHRASE=${mask(creds.passphrase)}`);
  console.log("");
  console.log("Keep these credentials secure. Anyone with them can submit trading requests for this signer.");
  console.log("If you use a Polymarket proxy account, orders still need the correct POLYBOT_SIGNATURE_TYPE and POLYBOT_FUNDER_ADDRESS.");
};

main().catch((error) => {
  console.error("Failed to generate CLOB API credentials.");
  console.error(describeError(error));
  console.error("");
  console.error("Common fixes:");
  console.error("- Check that your private key starts with 0x and matches the intended account.");
  console.error("- If you use a Polymarket proxy wallet, make sure the account already exists on Polymarket.com.");
  console.error("- If you know the original nonce, try --mode=derive --nonce=<same nonce>.");
  process.exit(1);
});
