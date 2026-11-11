import "dotenv/config";

import { AssetType, Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

const main = async (): Promise<void> => {
  const host = process.env.POLYBOT_HOST ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLYBOT_CHAIN_ID ?? 137);
  const privateKey = process.env.POLYBOT_PRIVATE_KEY;
  const funder = process.env.POLYBOT_FUNDER_ADDRESS;
  const signatureType = Number(process.env.POLYBOT_SIGNATURE_TYPE ?? 0);
  const apiKey = process.env.POLYBOT_API_KEY;
  const apiSecret = process.env.POLYBOT_API_SECRET;
  const apiPassphrase = process.env.POLYBOT_API_PASSPHRASE;

  if (!privateKey || !funder || !apiKey || !apiSecret || !apiPassphrase) {
    console.error("Missing env vars. Need POLYBOT_PRIVATE_KEY, POLYBOT_FUNDER_ADDRESS, POLYBOT_API_KEY/SECRET/PASSPHRASE");
    process.exit(1);
  }

  const signer = new Wallet(privateKey);
  const eoa = await signer.getAddress();

  console.log("==== Diagnostic Info ====");
  console.log("EOA (signer):        ", eoa);
  console.log("Funder (proxy):      ", funder);
  console.log("SignatureType:       ", signatureType);
  console.log("Host:                ", host);
  console.log("");

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

  const tokenIds = process.argv.slice(2);

  // Check pUSD/USDC (collateral) first — runs even without tokenId args
  console.log("==== COLLATERAL (pUSD on V2) ====");
  try {
    const before = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("Before update (raw):");
    console.log(JSON.stringify(before, null, 2));
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const after = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log("After  update (raw):");
    console.log(JSON.stringify(after, null, 2));

    const allowanceField = (after as { allowance?: unknown }).allowance;
    const allowancesField = (after as { allowances?: unknown }).allowances;
    console.log("\n>>> Diagnosis:");
    if (typeof allowanceField === "string" && allowanceField.length > 0 && allowanceField !== "0") {
      console.log("    Singular .allowance is populated — V2 SDK type matches wire. OK.");
    } else if (allowancesField && typeof allowancesField === "object") {
      console.log("    Plural .allowances object present — V2 wire still uses plural shape.");
      console.log("    Bot code reading singular .allowance will see undefined → null cashAllowanceUsdc.");
      console.log("    Fix: also read .allowances and take max across exchange addresses.");
    } else {
      console.log("    .allowance is empty/zero/null. Either approve missing or unexpected wire shape.");
    }
  } catch (error) {
    console.error("COLLATERAL error:", error instanceof Error ? error.message : error);
  }
  console.log("");

  if (tokenIds.length === 0) {
    console.log("(No tokenId args passed — skipping per-token CONDITIONAL diagnosis.)");
    console.log("To check a specific outcome token's ERC-1155 allowance, pass tokenId(s):");
    console.log("  npx tsx src/scripts/diagnose-allowance.ts <tokenId>");
    return;
  }

  for (const tokenId of tokenIds) {
    console.log(`==== CONDITIONAL token ${tokenId.slice(0, 12)}... ====`);
    try {
      const before = await client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId
      });
      console.log("Before update:", before);

      await client.updateBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId
      });

      const after = await client.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId
      });
      console.log("After update: ", after);

      const balance = Number(after.balance);
      const allowance = Number(after.allowance);
      if (allowance === 0 && balance > 0) {
        console.log(">>> DIAGNOSIS: balance>0 but allowance=0 -> setApprovalForAll NOT granted for this exchange.");
      } else if (allowance > 0) {
        console.log(">>> DIAGNOSIS: allowance OK. Bot should be able to SELL.");
      } else if (balance === 0) {
        console.log(">>> DIAGNOSIS: balance=0 at this address. Check FUNDER_ADDRESS matches token holder.");
      }
    } catch (error) {
      console.error("CONDITIONAL error:", error instanceof Error ? error.message : error);
    }
    console.log("");
  }
};

main().catch((error) => {
  console.error("Diagnostic failed:", error);
  process.exit(1);
});
