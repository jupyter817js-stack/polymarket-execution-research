// Post-run analyzer for negative-risk operations.
//
// Reads the live log + alerts JSONL and produces the 6 operator metrics:
//  1. incomplete_group ratio over time
//  2. complete_group formation count
//  3. negative-risk evaluation step entry count
//  4. UCL / single-market concentration
//  5. deep-liquidity opportunities (single-level fills)
//  6. stale_book / duplicate detection counts
//
// Usage:  npm run analyze:neg-risk -- [--log <path>] [--alerts <path>] [--since <iso>]

import fs from "node:fs";
import path from "node:path";

interface UniverseHealthSnapshot {
  candidateGroupCount: number;
  eligibleGroupCount: number;
  selectedGroupCount: number;
  completeGroupCount: number;
  incompleteGroupCount: number;
  missingMetadataGroupCount: number;
  completionRatio: number;
  selectedMarketsTotal: number;
  groupSizeStats: { min: number; max: number; avg: number };
  eligibleMarketsTotal: number;
  occurredAtMs: number;
}

interface AlertEntry {
  category: string;
  severity: string;
  title: string;
  summary: string;
  occurredAtMs: number;
  runtime?: string;
  tags?: string[];
  details?: Record<string, unknown>;
}

const parseArgs = (argv: string[]): { logPath: string; alertsPath: string; sinceMs?: number } => {
  const args = argv.slice(2);
  let logPath = "server_tmp/logs/log_26_05_07.txt";
  let alertsPath = "server_tmp/reports/alerts-live-mm.jsonl";
  let sinceMs: number | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--log" && next) {
      logPath = next;
      i += 1;
    } else if (arg === "--alerts" && next) {
      alertsPath = next;
      i += 1;
    } else if (arg === "--since" && next) {
      sinceMs = Date.parse(next);
      if (!Number.isFinite(sinceMs)) {
        throw new Error(`--since accepts ISO-8601, got: ${next}`);
      }
      i += 1;
    }
  }
  return { logPath, alertsPath, sinceMs };
};

const readAlerts = (alertsPath: string, sinceMs?: number): AlertEntry[] => {
  if (!fs.existsSync(alertsPath)) return [];
  const content = fs.readFileSync(alertsPath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: AlertEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AlertEntry;
      if (sinceMs && parsed.occurredAtMs < sinceMs) continue;
      entries.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return entries;
};

// Universe health snapshots are emitted from negative-risk-bot.ts as the alert
// `category: "operator_status", title: "Neg-risk universe health"`. They include
// detailed group counts. Plus older snapshots may only exist in the log file.
const extractUniverseHealthFromAlerts = (
  alerts: AlertEntry[]
): UniverseHealthSnapshot[] => {
  const snapshots: UniverseHealthSnapshot[] = [];
  for (const alert of alerts) {
    if (
      alert.runtime === "negative-risk" &&
      alert.tags?.includes("universe-health") &&
      alert.details
    ) {
      const d = alert.details as Record<string, unknown>;
      snapshots.push({
        candidateGroupCount: Number(d.candidateGroupCount ?? 0),
        eligibleGroupCount: Number(d.eligibleGroupCount ?? 0),
        selectedGroupCount: Number(d.selectedGroupCount ?? 0),
        completeGroupCount: Number(d.completeGroupCount ?? 0),
        incompleteGroupCount: Number(d.incompleteGroupCount ?? 0),
        missingMetadataGroupCount: Number(d.missingMetadataGroupCount ?? 0),
        completionRatio: Number(d.completionRatio ?? 0),
        selectedMarketsTotal: Number(d.selectedMarketsTotal ?? 0),
        groupSizeStats:
          typeof d.groupSizeStats === "object" && d.groupSizeStats !== null
            ? (d.groupSizeStats as { min: number; max: number; avg: number })
            : { min: 0, max: 0, avg: 0 },
        eligibleMarketsTotal: Number(d.eligibleMarketsTotal ?? 0),
        occurredAtMs: alert.occurredAtMs
      });
    }
  }
  return snapshots;
};

const REJECT_REGEX = /"reason":\s*"([a-z_]+)"/g;
const STALE_BOOK_REGEX = /stale_book/g;
const SAME_MARKET_EVAL_REGEX = /Same-market arbitrage evaluation summary/g;
const NEG_RISK_OPP_DETECTED_REGEX = /Negative Risk YES basket opportunity|Negative Risk NO-to-YES conversion opportunity/g;
const ARB_OPPORTUNITY_DETECTED_REGEX = /Arbitrage opportunity (detected|accepted)/g;
const DEPTH_DEEP_HINT = /\"depth\":\s*\{[^}]*\"singleLevelLegs\":\s*(\d+),\s*\"multiLevelLegs\":\s*(\d+)/g;
const MARKET_FIELD_REGEX = /^\s*market:\s*"([^"]+)"/gm;

const analyzeLog = (logPath: string, sinceMs?: number) => {
  if (!fs.existsSync(logPath)) {
    return {
      rejections: {} as Record<string, number>,
      sameMarketEvalCount: 0,
      negRiskOpportunityCount: 0,
      sameMarketOpportunityCount: 0,
      staleBookCount: 0,
      depthSingleLevelCount: 0,
      depthMultiLevelCount: 0,
      marketCounts: {} as Record<string, number>
    };
  }
  const content = fs.readFileSync(logPath, "utf-8");
  // Rough timestamp filter: split on log timestamp prefix lines and skip lines that
  // start with a timestamp before sinceMs.
  const filtered = sinceMs
    ? content
        .split("\n")
        .filter((line) => {
          const ts = line.match(/^\[(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}\.\d{3}\s[+-]\d{4})\]/);
          const tsValue = ts?.[1];
          if (!tsValue) return true; // continuation lines pass through
          const parsed = Date.parse(tsValue.replace(" ", "T").replace(/\.\d+/, "")); // crude
          return !Number.isFinite(parsed) || parsed >= sinceMs;
        })
        .join("\n")
    : content;

  const rejections: Record<string, number> = {};
  let m: RegExpExecArray | null;
  REJECT_REGEX.lastIndex = 0;
  while ((m = REJECT_REGEX.exec(filtered)) !== null) {
    const reason = m[1];
    if (!reason) continue;
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  }
  const sameMarketEvalCount = (filtered.match(SAME_MARKET_EVAL_REGEX) ?? []).length;
  const negRiskOpportunityCount = (filtered.match(NEG_RISK_OPP_DETECTED_REGEX) ?? []).length;
  const sameMarketOpportunityCount = (filtered.match(ARB_OPPORTUNITY_DETECTED_REGEX) ?? []).length;
  const staleBookCount = (filtered.match(STALE_BOOK_REGEX) ?? []).length;

  let depthSingleLevelCount = 0;
  let depthMultiLevelCount = 0;
  DEPTH_DEEP_HINT.lastIndex = 0;
  while ((m = DEPTH_DEEP_HINT.exec(filtered)) !== null) {
    depthSingleLevelCount += Number(m[1] ?? 0);
    depthMultiLevelCount += Number(m[2] ?? 0);
  }

  const marketCounts: Record<string, number> = {};
  MARKET_FIELD_REGEX.lastIndex = 0;
  while ((m = MARKET_FIELD_REGEX.exec(filtered)) !== null) {
    const slug = m[1];
    if (!slug) continue;
    marketCounts[slug] = (marketCounts[slug] ?? 0) + 1;
  }

  return {
    rejections,
    sameMarketEvalCount,
    negRiskOpportunityCount,
    sameMarketOpportunityCount,
    staleBookCount,
    depthSingleLevelCount,
    depthMultiLevelCount,
    marketCounts
  };
};

const main = (): void => {
  const { logPath, alertsPath, sinceMs } = parseArgs(process.argv);
  console.log("=".repeat(72));
  console.log("Negative-Risk Run Analysis");
  console.log("=".repeat(72));
  console.log(`Log:    ${path.resolve(logPath)}`);
  console.log(`Alerts: ${path.resolve(alertsPath)}`);
  if (sinceMs) console.log(`Since:  ${new Date(sinceMs).toISOString()}`);
  console.log();

  const alerts = readAlerts(alertsPath, sinceMs);
  const universeSnapshots = extractUniverseHealthFromAlerts(alerts);
  const logStats = analyzeLog(logPath, sinceMs);

  // (1) incomplete_group ratio over time
  console.log("─── (1) Incomplete-group ratio over time ───");
  const first = universeSnapshots[0];
  const last = universeSnapshots[universeSnapshots.length - 1];
  if (!first || !last) {
    console.log("  No universe-health snapshots in alerts. (Bot was not yet running with");
    console.log("  the periodic alert; or alerts file is missing/empty.)");
  } else {
    const avgRatio =
      universeSnapshots.reduce((sum, s) => sum + s.completionRatio, 0) / universeSnapshots.length;
    const avgIncomplete =
      universeSnapshots.reduce((sum, s) => sum + s.incompleteGroupCount, 0) /
      universeSnapshots.length;
    console.log(`  Snapshots: ${universeSnapshots.length}`);
    console.log(`  First: complete ${first.completeGroupCount}/${first.selectedGroupCount} (${(first.completionRatio * 100).toFixed(1)}%) at ${new Date(first.occurredAtMs).toISOString()}`);
    console.log(`  Last:  complete ${last.completeGroupCount}/${last.selectedGroupCount} (${(last.completionRatio * 100).toFixed(1)}%) at ${new Date(last.occurredAtMs).toISOString()}`);
    console.log(`  Avg completion ratio: ${(avgRatio * 100).toFixed(1)}%`);
    console.log(`  Avg incomplete count: ${avgIncomplete.toFixed(1)}`);
  }
  console.log();

  // (2) complete_group formation count
  console.log("─── (2) Complete-group formation ───");
  if (universeSnapshots.length === 0) {
    console.log("  N/A (no snapshots)");
  } else {
    const totalComplete = universeSnapshots.reduce((sum, s) => sum + s.completeGroupCount, 0);
    const totalSelected = universeSnapshots.reduce((sum, s) => sum + s.selectedGroupCount, 0);
    console.log(`  Cumulative complete-group instances: ${totalComplete}`);
    console.log(`  Cumulative selected-group instances: ${totalSelected}`);
    console.log(`  Aggregate complete share: ${totalSelected > 0 ? ((totalComplete / totalSelected) * 100).toFixed(1) : "0.0"}%`);
    const maxComplete = Math.max(...universeSnapshots.map((s) => s.completeGroupCount));
    console.log(`  Peak complete groups in one snapshot: ${maxComplete}`);
  }
  console.log();

  // (3) negative-risk evaluation step entries
  console.log("─── (3) Negative-risk evaluation entries ───");
  console.log(`  Negative Risk opportunities detected (log): ${logStats.negRiskOpportunityCount}`);
  console.log(`  Same-market eval count: ${logStats.sameMarketEvalCount}`);
  console.log(`  Same-market opportunities detected: ${logStats.sameMarketOpportunityCount}`);
  console.log();

  // (4) Market concentration (UCL etc.)
  console.log("─── (4) Market concentration (top 10) ───");
  const sortedMarkets = Object.entries(logStats.marketCounts).sort(
    (a, b) => b[1] - a[1]
  );
  const totalEvals = sortedMarkets.reduce((sum, [, count]) => sum + count, 0);
  if (totalEvals === 0) {
    console.log("  No market evaluations found.");
  } else {
    sortedMarkets.slice(0, 10).forEach(([slug, count]) => {
      const pct = ((count / totalEvals) * 100).toFixed(1);
      console.log(`  ${count.toString().padStart(5)} ${pct.padStart(5)}%  ${slug}`);
    });
    const topShare = ((sortedMarkets[0]?.[1] ?? 0) / totalEvals) * 100;
    console.log(`  Top-1 market share: ${topShare.toFixed(1)}%`);
  }
  console.log();

  // (5) Deep-liquidity opportunities
  console.log("─── (5) Depth quality (single-level vs multi-level legs) ───");
  const totalLegs = logStats.depthSingleLevelCount + logStats.depthMultiLevelCount;
  if (totalLegs === 0) {
    console.log("  No opportunity-with-depth records. (No opportunities detected, or depth");
    console.log("  field not yet emitted by the bot version that produced this log.)");
  } else {
    const deepPct = (logStats.depthSingleLevelCount / totalLegs) * 100;
    console.log(`  Single-level (DEEP) legs: ${logStats.depthSingleLevelCount}`);
    console.log(`  Multi-level (THIN) legs:  ${logStats.depthMultiLevelCount}`);
    console.log(`  Deep-liquidity ratio:     ${deepPct.toFixed(1)}%`);
  }
  console.log();

  // (6) Stale book / rejection breakdown
  console.log("─── (6) Stale-book + rejection breakdown ───");
  console.log(`  Stale_book mentions (raw count): ${logStats.staleBookCount}`);
  const sortedRej = Object.entries(logStats.rejections).sort((a, b) => b[1] - a[1]);
  console.log(`  Top rejection reasons:`);
  sortedRej.slice(0, 12).forEach(([reason, count]) => {
    console.log(`    ${count.toString().padStart(6)}  ${reason}`);
  });
  console.log();

  // Final summary
  console.log("─── Operator-facing summary ───");
  const lastSnapshot = universeSnapshots[universeSnapshots.length - 1];
  if (lastSnapshot) {
    console.log(
      `  At last snapshot: ${lastSnapshot.completeGroupCount}/${lastSnapshot.selectedGroupCount} groups complete ` +
        `(${(lastSnapshot.completionRatio * 100).toFixed(1)}%); ` +
        `${lastSnapshot.incompleteGroupCount} incomplete; ` +
        `${lastSnapshot.missingMetadataGroupCount} missing-metadata.`
    );
    console.log(
      `  Group sizes: avg ${lastSnapshot.groupSizeStats.avg}, max ${lastSnapshot.groupSizeStats.max}; ` +
        `selectedMarkets ${lastSnapshot.selectedMarketsTotal} of eligible ${lastSnapshot.eligibleMarketsTotal}.`
    );
  }
  console.log(
    `  Negative-risk opportunities reaching detection: ${logStats.negRiskOpportunityCount}`
  );
  console.log(`  Stale_book signals: ${logStats.staleBookCount}`);
  console.log("=".repeat(72));
};

main();
