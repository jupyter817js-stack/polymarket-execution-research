import "dotenv/config";

import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

const main = async (): Promise<void> => {
  const host = process.env.POLYBOT_HOST ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLYBOT_CHAIN_ID ?? 137);
  const privateKey = process.env.POLYBOT_PRIVATE_KEY!;
  const funder = process.env.POLYBOT_FUNDER_ADDRESS!;
  const apiKey = process.env.POLYBOT_API_KEY!;
  const apiSecret = process.env.POLYBOT_API_SECRET!;
  const apiPassphrase = process.env.POLYBOT_API_PASSPHRASE!;
  const signatureType = Number(process.env.POLYBOT_SIGNATURE_TYPE ?? 2);

  const signer = new Wallet(privateKey);
  const client = new ClobClient({
    host,
    chain: chainId as Chain,
    signer,
    creds: { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: funder,
    useServerTime: true,
    retryOnError: true,
    throwOnError: true
  });

  console.log("Calling getCurrentRewards()...");
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      client.getCurrentRewards(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT 30s")), 30000))
    ]);
    const elapsedMs = Date.now() - t0;
    const arr = Array.isArray(result) ? result : [];
    console.log(`OK in ${elapsedMs}ms, ${arr.length} rewards entries`);
    if (arr.length > 0) {
      console.log("First entry:", JSON.stringify(arr[0]).slice(0, 400));
    }
  } catch (error) {
    const elapsedMs = Date.now() - t0;
    console.error(`FAILED after ${elapsedMs}ms:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
};

main().catch((err) => {
  console.error("script error:", err);
  process.exitCode = 1;
});
