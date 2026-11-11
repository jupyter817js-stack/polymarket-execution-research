import "dotenv/config";

import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

const formatUtcDate = (date: Date): string => {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

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
  const eoa = await signer.getAddress();
  const today = formatUtcDate(new Date());

  console.log("============================================================");
  console.log("Polymarket V2 Reward API Diagnostic");
  console.log("============================================================");
  console.log("EOA (signer):    ", eoa);
  console.log("Funder (proxy):  ", funder);
  console.log("Today (UTC):     ", today);
  console.log("Host:            ", host);
  console.log("");

  const client = new ClobClient({
    host,
    chain: chainId as Chain,
    signer,
    creds: { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: funder,
    useServerTime: true,
    retryOnError: false,
    throwOnError: true
  });

  // 1. getRewardPercentages — wallet 의 시장별 점유율
  console.log("━━━ [1] getRewardPercentages() — 시장별 점유율 ━━━");
  try {
    const t0 = Date.now();
    const result = await client.getRewardPercentages();
    console.log(`OK in ${Date.now() - t0}ms`);
    const entries = Object.entries(result);
    console.log(`총 ${entries.length}개 시장에 점유율 있음`);
    if (entries.length > 0) {
      console.log("상위 10개 (점유율 높은 순):");
      entries.sort((a, b) => Number(b[1]) - Number(a[1]));
      for (const [market, pct] of entries.slice(0, 10)) {
        console.log(`  ${market.slice(0, 18)}... → ${pct}%`);
      }
    } else {
      console.log("⚠️ 운영자 wallet 의 시장별 점유율 없음. 즉 reward 적립 시장 0.");
    }
  } catch (error) {
    console.error("FAIL:", (error as Error).message);
  }
  console.log("");

  // 2. getTotalEarningsForUserForDay — 일일 확정 적립
  console.log("━━━ [2] getTotalEarningsForUserForDay(today) — 오늘 확정 적립 ━━━");
  try {
    const t0 = Date.now();
    const result = await client.getTotalEarningsForUserForDay(today);
    console.log(`OK in ${Date.now() - t0}ms`);
    if (Array.isArray(result) && result.length > 0) {
      let total = 0;
      for (const earning of result) {
        console.log(JSON.stringify(earning, null, 2));
        total += earning.earnings ?? 0;
      }
      console.log(`>>> 오늘 확정 적립 합: $${total.toFixed(6)}`);
    } else {
      console.log("⚠️ 빈 응답. 오늘 확정 적립 0.");
    }
  } catch (error) {
    console.error("FAIL:", (error as Error).message);
  }
  console.log("");

  // 어제도 시도
  const yesterday = formatUtcDate(new Date(Date.now() - 86400000));
  console.log(`━━━ [2b] getTotalEarningsForUserForDay(${yesterday}) — 어제 확정 적립 ━━━`);
  try {
    const t0 = Date.now();
    const result = await client.getTotalEarningsForUserForDay(yesterday);
    console.log(`OK in ${Date.now() - t0}ms`);
    if (Array.isArray(result) && result.length > 0) {
      let total = 0;
      for (const earning of result) {
        console.log(JSON.stringify(earning, null, 2));
        total += earning.earnings ?? 0;
      }
      console.log(`>>> 어제 확정 적립 합: $${total.toFixed(6)}`);
    } else {
      console.log("⚠️ 빈 응답. 어제 확정 적립 0.");
    }
  } catch (error) {
    console.error("FAIL:", (error as Error).message);
  }
  console.log("");

  // 3. getUserEarningsAndMarketsConfig — 추정 적립 (봇이 사용)
  console.log(`━━━ [3] getUserEarningsAndMarketsConfig(${today}) — 봇이 사용하는 추정 ━━━`);
  try {
    const t0 = Date.now();
    const result = await client.getUserEarningsAndMarketsConfig(today);
    console.log(`OK in ${Date.now() - t0}ms`);
    if (Array.isArray(result) && result.length > 0) {
      console.log(`총 ${result.length}개 시장 응답.`);
      let totalEstimated = 0;
      let totalEarning = 0;
      let makerAddressMismatch = 0;
      for (const earning of result) {
        const earnings = (earning.earnings || []).reduce(
          (sum: number, e: { earnings?: number }) => sum + (e.earnings ?? 0),
          0
        );
        totalEstimated += earnings;
        totalEarning += earning.earning_percentage ?? 0;
        if (
          earning.maker_address &&
          earning.maker_address.toLowerCase() !== funder.toLowerCase() &&
          earning.maker_address.toLowerCase() !== eoa.toLowerCase()
        ) {
          makerAddressMismatch++;
        }
      }
      console.log(`>>> 시장별 earning_percentage 합: ${totalEarning.toFixed(6)}`);
      console.log(`>>> 시장별 earnings 합: $${totalEstimated.toFixed(6)}`);
      console.log(`>>> maker_address 일치 검증: 불일치 ${makerAddressMismatch} / ${result.length}`);

      console.log("\n첫 3개 raw 응답:");
      for (const earning of result.slice(0, 3)) {
        console.log(JSON.stringify(earning, null, 2));
      }
    } else {
      console.log("⚠️ 빈 응답. 봇이 사용하는 추정 reward 0.");
    }
  } catch (error) {
    console.error("FAIL:", (error as Error).message);
  }
  console.log("");

  console.log("============================================================");
  console.log("Diagnostic complete");
  console.log("============================================================");
};

main().catch((e) => {
  console.error("Diagnostic failed:", e);
  process.exitCode = 1;
});
