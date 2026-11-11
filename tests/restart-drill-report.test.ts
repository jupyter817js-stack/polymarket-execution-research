import { describe, expect, it } from "vitest";

import { buildRestartDrillReport } from "../src/session-report/restart-drill-report.js";
import type { RuntimeCheckpointReport } from "../src/session-report/small-live-report.js";

const baseCheckpoint = (): RuntimeCheckpointReport => ({
  checkpointType: "runtime_checkpoint",
  schemaVersion: 1,
  runtime: "integrated",
  reason: "stop",
  generatedAtMs: 1_700_000_000_000,
  monitoringSnapshot: {
    summaryType: "monitoring_snapshot",
    runtime: "integrated",
    risk: {
      state: "RUNNING"
    },
    portfolio: {
      dailyRealizedPnlUsdc: 0.4
    },
    activeOrders: {
      total: 0,
      activeConditions: 0
    }
  },
  inventory: {
    openLotCount: 2,
    openShares: 5,
    openCostUsdc: 2.1,
    openLots: [
      {
        lotId: "lot-a",
        strategy: "same-market-arb",
        tokenId: "yes-a",
        marketScope: "btc-above-150k",
        conditionId: "condition-a",
        outcome: "Yes",
        shares: 2,
        totalCostUsdc: 0.8,
        openedAtMs: 100
      },
      {
        lotId: "lot-b",
        strategy: "negative-risk",
        tokenId: "yes-b",
        marketScope: "election-basket",
        conditionId: "condition-b",
        outcome: "Outcome B",
        shares: 3,
        totalCostUsdc: 1.3,
        openedAtMs: 200
      }
    ]
  }
});

describe("Restart drill report", () => {
  it("passes when recovered lots exactly match the runtime checkpoint snapshot", () => {
    const checkpoint = baseCheckpoint();
    const report = buildRestartDrillReport({
      sessionName: "restart-drill-pass",
      generatedAtMs: 1_700_000_000_500,
      checkpoint,
      recoveredLots: checkpoint.inventory.openLots ?? []
    });

    expect(report.outcome).toBe("passed");
    expect(report.totals).toEqual({
      matchedLotCount: 2,
      missingLotCount: 0,
      unexpectedLotCount: 0,
      sharesDelta: 0,
      costDeltaUsdc: 0
    });
    expect(report.flags).toEqual([]);
    expect(report.lotDiffs).toEqual([]);
  });

  it("fails when recovered inventory diverges from the checkpoint baseline", () => {
    const checkpoint = baseCheckpoint();
    const report = buildRestartDrillReport({
      checkpoint,
      recoveredLots: [
        {
          lotId: "lot-a",
          strategy: "same-market-arb",
          tokenId: "yes-a",
          marketScope: "btc-above-150k",
          conditionId: "condition-a",
          outcome: "Yes",
          shares: 1.5,
          totalCostUsdc: 0.7,
          openedAtMs: 100
        },
        {
          lotId: "lot-c",
          strategy: "market-making",
          tokenId: "yes-c",
          marketScope: "eth-above-6k",
          conditionId: "condition-c",
          outcome: "Yes",
          shares: 4,
          totalCostUsdc: 1.9,
          openedAtMs: 300
        }
      ]
    });

    expect(report.outcome).toBe("failed");
    expect(report.totals.matchedLotCount).toBe(0);
    expect(report.totals.missingLotCount).toBe(1);
    expect(report.totals.unexpectedLotCount).toBe(1);
    expect(report.flags.map((flag) => flag.code)).toEqual(
      expect.arrayContaining([
        "missing_checkpoint_lot",
        "unexpected_recovered_lot",
        "share_mismatch",
        "cost_mismatch"
      ])
    );
    expect(report.lotDiffs.map((diff) => diff.lotId)).toEqual(["lot-a", "lot-b", "lot-c"]);
  });
});
