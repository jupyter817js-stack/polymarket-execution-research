import "dotenv/config";

import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";

interface ScoredCandidate {
  conditionId: string;
  ratePerDayUsdc: number;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  score: number;
}

interface EnrichedMarket extends ScoredCandidate {
  question: string;
  slug: string;
  liquidity: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  active: boolean;
  closed: boolean;
}

const main = async (): Promise<void> => {
  const host = process.env.POLYBOT_HOST ?? "https://clob.polymarket.com";
  const gammaHost = process.env.POLYBOT_GAMMA_HOST ?? "https://gamma-api.polymarket.com";
  const chainId = Number(process.env.POLYBOT_CHAIN_ID ?? 137);
  const privateKey = process.env.POLYBOT_PRIVATE_KEY!;
  const funder = process.env.POLYBOT_FUNDER_ADDRESS!;
  const apiKey = process.env.POLYBOT_API_KEY!;
  const apiSecret = process.env.POLYBOT_API_SECRET!;
  const apiPassphrase = process.env.POLYBOT_API_PASSPHRASE!;
  const signatureType = Number(process.env.POLYBOT_SIGNATURE_TYPE ?? 2);
  const operatorBudgetUsdc = Number(
    process.env.POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE ?? "3000"
  );

  const signer = new Wallet(privateKey);
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

  console.log("Step 1: getCurrentRewards()…");
  const t0 = Date.now();
  const rewards = await Promise.race([
    client.getCurrentRewards(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("getCurrentRewards timed out after 120s")), 120_000)
    )
  ]);
  console.log(`  OK in ${Date.now() - t0}ms — ${rewards.length} reward-eligible markets`);

  // 운영자 capacity 충족 + score 계산
  const perMarketBudget = operatorBudgetUsdc / 3;
  console.log(`  자본 $${operatorBudgetUsdc.toFixed(2)} / 3 = 시장당 $${perMarketBudget.toFixed(2)}`);

  const candidates: ScoredCandidate[] = [];
  for (const market of rewards as Array<{
    condition_id: string;
    rewards_config?: Array<{ rate_per_day?: number; end_date?: string }>;
    rewards_max_spread?: number;
    rewards_min_size?: number;
    total_daily_rate?: number;
    native_daily_rate?: number;
  }>) {
    const totalRate =
      market.total_daily_rate ??
      (market.rewards_config ?? []).reduce((sum, cfg) => sum + (cfg.rate_per_day ?? 0), 0);
    if (totalRate <= 0) continue;

    const minSize = market.rewards_min_size ?? 0;
    if (minSize <= 0) continue;
    // 운영자 budget 으로 minSize 충족 가능한지 (가격 $0.5 가정)
    const estimatedShares = perMarketBudget / 0.5;
    if (estimatedShares < minSize) continue;

    candidates.push({
      conditionId: market.condition_id,
      ratePerDayUsdc: totalRate,
      rewardsMaxSpread: market.rewards_max_spread ?? 0,
      rewardsMinSize: minSize,
      score: totalRate
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  // 큰 outlier (deprecated/pre-launch) 제외 위해 reasonable rate 만
  const reasonableCandidates = candidates.filter((c) => c.ratePerDayUsdc <= 1000);
  // 더 많은 후보 enrich 시도 — top 200 chunked fetch
  const topN = reasonableCandidates.slice(0, 200);
  console.log(`Step 2: top ${topN.length} 후보 (rate ≤ $1000/day) chunked gamma 조회…`);

  type GammaMarket = {
    conditionId: string;
    question?: string;
    slug?: string;
    liquidity?: number | string;
    bestBid?: number | string;
    bestAsk?: number | string;
    spread?: number | string;
    active?: boolean;
    closed?: boolean;
    endDate?: string;
    enableOrderBook?: boolean;
    acceptingOrders?: boolean;
  };
  const gammaByConditionId = new Map<string, GammaMarket>();

  // gamma batch: ?condition_ids=A&condition_ids=B (repeated param). chunked 50씩.
  const chunkSize = 50;
  for (let i = 0; i < topN.length; i += chunkSize) {
    const chunk = topN.slice(i, i + chunkSize);
    const url = new URL("/markets", gammaHost);
    for (const c of chunk) {
      url.searchParams.append("condition_ids", c.conditionId);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const data = (await r.json()) as GammaMarket[];
      for (const m of data) {
        if (m.conditionId) gammaByConditionId.set(m.conditionId, m);
      }
    } catch {
      // 한 chunk 실패는 무시
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`  → gamma response: ${gammaByConditionId.size} matched`);

  const now = Date.now();
  const minRemainingMs = 24 * 60 * 60 * 1000; // 만기 24시간 이상 남은 시장만

  const enriched: EnrichedMarket[] = [];
  for (const candidate of topN) {
    const gamma = gammaByConditionId.get(candidate.conditionId);
    if (!gamma) continue;
    if (gamma.closed) continue;
    if (gamma.active === false) continue;
    if (gamma.enableOrderBook === false) continue;
    if (gamma.acceptingOrders === false) continue;
    if (!gamma.slug) continue;
    // 만기 시간 검증 — 24시간 이상 남은 시장만 (단기 만기 시장은 사장님 가이드의
    // "Iran/대선/Hormuz" 같은 mid-term reward 시장과 다름)
    if (gamma.endDate) {
      const endMs = Date.parse(gamma.endDate);
      if (Number.isFinite(endMs) && endMs - now < minRemainingMs) continue;
    }
    enriched.push({
      ...candidate,
      question: gamma.question ?? "(no question)",
      slug: gamma.slug,
      liquidity: Number(gamma.liquidity ?? 0),
      bestBid: Number(gamma.bestBid ?? 0),
      bestAsk: Number(gamma.bestAsk ?? 0),
      spread: Number(gamma.spread ?? 0),
      active: gamma.active ?? true,
      closed: gamma.closed ?? false
    });
  }

  console.log(`  → ${enriched.length} markets enriched (active + tradeable)`);
  console.log("");
  console.log("============================================================");
  console.log(`Top ${Math.min(10, enriched.length)} reward markets:`);
  console.log("============================================================");
  for (let i = 0; i < Math.min(10, enriched.length); i++) {
    const m = enriched[i];
    if (!m) continue;
    console.log(`\n[${i + 1}] ${m.question.slice(0, 70)}`);
    console.log(`    slug: ${m.slug}`);
    console.log(
      `    rate/day=$${m.ratePerDayUsdc.toFixed(2)} | maxSpread=${m.rewardsMaxSpread} | minSize=${m.rewardsMinSize}`
    );
    console.log(
      `    liquidity=$${m.liquidity.toFixed(0)} | bestBid=${m.bestBid} | bestAsk=${m.bestAsk} | spread=${m.spread}`
    );
  }

  const top3 = enriched.slice(0, 3);
  if (top3.length < 3) {
    console.log(`\n⚠️ enriched 결과 ${top3.length} < 3 — gamma 응답 부족.`);
    return;
  }

  const allowedSlugs = top3.map((m) => m.slug).join(",");
  console.log("\n============================================================");
  console.log("권장 ALLOWED_SLUGS (top 3):");
  console.log("============================================================");
  console.log("");
  console.log(`POLYBOT_ALLOWED_SLUGS=${allowedSlugs}`);
  console.log("");
  const totalRate = top3.reduce((sum, m) => sum + m.ratePerDayUsdc, 0);
  console.log(`총 일일 reward pool = $${totalRate.toFixed(2)} (3개 시장)`);
  console.log("운영자 점유율은 quote 의 mid 근접도 + 유지 시간 + 경쟁자 수에 따라 결정");
  console.log("");

  // .env 자동 업데이트
  const fs = await import("node:fs");
  const path = await import("node:path");
  const envPath = path.resolve(process.cwd(), ".env");
  let envContent = fs.readFileSync(envPath, "utf-8");
  const slugLineRegex = /^POLYBOT_ALLOWED_SLUGS=.*$/m;
  if (slugLineRegex.test(envContent)) {
    envContent = envContent.replace(slugLineRegex, `POLYBOT_ALLOWED_SLUGS=${allowedSlugs}`);
  } else {
    envContent += `\nPOLYBOT_ALLOWED_SLUGS=${allowedSlugs}\n`;
  }
  fs.writeFileSync(envPath, envContent, "utf-8");
  console.log(`✅ .env 자동 업데이트 완료: POLYBOT_ALLOWED_SLUGS`);
};

main().catch((e) => {
  console.error("Failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
