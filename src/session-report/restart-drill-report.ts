import type { InventoryLotSnapshot } from "../core/inventory-lot-tracker.js";
import type { RiskState, StrategyName } from "../core/types.js";
import type { RuntimeCheckpointReport } from "./small-live-report.js";

const EPSILON = 1e-8;

export type RestartDrillOutcome = "passed" | "warning" | "failed";

export type RestartDrillFlagCode =
  | "missing_checkpoint_lot"
  | "unexpected_recovered_lot"
  | "strategy_mismatch"
  | "token_mismatch"
  | "market_scope_mismatch"
  | "condition_mismatch"
  | "outcome_mismatch"
  | "share_mismatch"
  | "cost_mismatch";

export type RestartDrillFlag = {
  code: RestartDrillFlagCode;
  severity: "warning" | "critical";
  detail: string;
  lotId?: string;
};

export type RestartDrillLotDiff = {
  lotId: string;
  checkpointStrategy?: StrategyName;
  recoveredStrategy?: StrategyName;
  checkpointTokenId?: string;
  recoveredTokenId?: string;
  checkpointMarketScope?: string;
  recoveredMarketScope?: string;
  checkpointConditionId?: string;
  recoveredConditionId?: string;
  checkpointOutcome?: string;
  recoveredOutcome?: string;
  checkpointShares?: number;
  recoveredShares?: number;
  sharesDelta?: number;
  checkpointCostUsdc?: number;
  recoveredCostUsdc?: number;
  costDeltaUsdc?: number;
  issues: RestartDrillFlagCode[];
};

export type RestartDrillReport = {
  reportType: "restart_drill_report";
  schemaVersion: 1;
  sessionName: string;
  generatedAtMs: number;
  runtime: string;
  outcome: RestartDrillOutcome;
  checkpoint: {
    generatedAtMs: number;
    riskState: RiskState;
    openLotCount: number;
    openShares: number;
    openCostUsdc: number;
  };
  recovery: {
    recoveredLotCount: number;
    recoveredShares: number;
    recoveredCostUsdc: number;
  };
  totals: {
    matchedLotCount: number;
    missingLotCount: number;
    unexpectedLotCount: number;
    sharesDelta: number;
    costDeltaUsdc: number;
  };
  lotDiffs: RestartDrillLotDiff[];
  flags: RestartDrillFlag[];
};

const round = (value: number): number => Number(value.toFixed(8));

const buildFlag = (
  code: RestartDrillFlagCode,
  detail: string,
  options?: {
    severity?: RestartDrillFlag["severity"];
    lotId?: string;
  }
): RestartDrillFlag => ({
  code,
  severity: options?.severity ?? "warning",
  detail,
  lotId: options?.lotId
});

const nearlyEqual = (left: number | undefined, right: number | undefined): boolean =>
  Math.abs((left ?? 0) - (right ?? 0)) <= EPSILON;

export const buildRestartDrillReport = (input: {
  sessionName?: string;
  generatedAtMs?: number;
  checkpoint: RuntimeCheckpointReport;
  recoveredLots: readonly InventoryLotSnapshot[];
}): RestartDrillReport => {
  const checkpointLots: readonly InventoryLotSnapshot[] = input.checkpoint.inventory.openLots ?? [];
  const recoveredLots: readonly InventoryLotSnapshot[] = [...input.recoveredLots];
  const checkpointByLotId = new Map(checkpointLots.map((lot) => [lot.lotId, lot] as const));
  const recoveredByLotId = new Map(recoveredLots.map((lot) => [lot.lotId, lot] as const));
  const flags: RestartDrillFlag[] = [];
  const lotDiffs: RestartDrillLotDiff[] = [];
  let matchedLotCount = 0;
  let missingLotCount = 0;
  let unexpectedLotCount = 0;

  for (const checkpointLot of checkpointLots) {
    const recoveredLot = recoveredByLotId.get(checkpointLot.lotId);

    if (!recoveredLot) {
      missingLotCount += 1;
      flags.push(
        buildFlag(
          "missing_checkpoint_lot",
          `Checkpoint lot ${checkpointLot.lotId} did not reappear after restart.`,
          {
            severity: "critical",
            lotId: checkpointLot.lotId
          }
        )
      );
      lotDiffs.push({
        lotId: checkpointLot.lotId,
        checkpointStrategy: checkpointLot.strategy,
        checkpointTokenId: checkpointLot.tokenId,
        checkpointMarketScope: checkpointLot.marketScope,
        checkpointConditionId: checkpointLot.conditionId,
        checkpointOutcome: checkpointLot.outcome,
        checkpointShares: round(checkpointLot.shares),
        checkpointCostUsdc: round(checkpointLot.totalCostUsdc),
        issues: ["missing_checkpoint_lot"]
      });
      continue;
    }

    const issues: RestartDrillFlagCode[] = [];
    if (checkpointLot.strategy !== recoveredLot.strategy) {
      issues.push("strategy_mismatch");
      flags.push(
        buildFlag(
          "strategy_mismatch",
          `Lot ${checkpointLot.lotId} changed strategy from ${checkpointLot.strategy} to ${recoveredLot.strategy}.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }
    if (checkpointLot.tokenId !== recoveredLot.tokenId) {
      issues.push("token_mismatch");
      flags.push(
        buildFlag(
          "token_mismatch",
          `Lot ${checkpointLot.lotId} changed tokenId from ${checkpointLot.tokenId} to ${recoveredLot.tokenId}.`,
          {
            severity: "critical",
            lotId: checkpointLot.lotId
          }
        )
      );
    }
    if (checkpointLot.marketScope !== recoveredLot.marketScope) {
      issues.push("market_scope_mismatch");
      flags.push(
        buildFlag(
          "market_scope_mismatch",
          `Lot ${checkpointLot.lotId} changed market scope from ${checkpointLot.marketScope} to ${recoveredLot.marketScope}.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }
    if ((checkpointLot.conditionId ?? "") !== (recoveredLot.conditionId ?? "")) {
      issues.push("condition_mismatch");
      flags.push(
        buildFlag(
          "condition_mismatch",
          `Lot ${checkpointLot.lotId} changed conditionId from ${checkpointLot.conditionId ?? "-"} to ${recoveredLot.conditionId ?? "-"}.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }
    if ((checkpointLot.outcome ?? "") !== (recoveredLot.outcome ?? "")) {
      issues.push("outcome_mismatch");
      flags.push(
        buildFlag(
          "outcome_mismatch",
          `Lot ${checkpointLot.lotId} changed outcome from ${checkpointLot.outcome ?? "-"} to ${recoveredLot.outcome ?? "-"}.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }
    if (!nearlyEqual(checkpointLot.shares, recoveredLot.shares)) {
      issues.push("share_mismatch");
      flags.push(
        buildFlag(
          "share_mismatch",
          `Lot ${checkpointLot.lotId} changed shares from ${round(checkpointLot.shares)} to ${round(recoveredLot.shares)}.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }
    if (!nearlyEqual(checkpointLot.totalCostUsdc, recoveredLot.totalCostUsdc)) {
      issues.push("cost_mismatch");
      flags.push(
        buildFlag(
          "cost_mismatch",
          `Lot ${checkpointLot.lotId} changed cost basis from ${round(checkpointLot.totalCostUsdc)} to ${round(recoveredLot.totalCostUsdc)} USDC.`,
          { lotId: checkpointLot.lotId }
        )
      );
    }

    if (issues.length === 0) {
      matchedLotCount += 1;
      continue;
    }

    lotDiffs.push({
      lotId: checkpointLot.lotId,
      checkpointStrategy: checkpointLot.strategy,
      recoveredStrategy: recoveredLot.strategy,
      checkpointTokenId: checkpointLot.tokenId,
      recoveredTokenId: recoveredLot.tokenId,
      checkpointMarketScope: checkpointLot.marketScope,
      recoveredMarketScope: recoveredLot.marketScope,
      checkpointConditionId: checkpointLot.conditionId,
      recoveredConditionId: recoveredLot.conditionId,
      checkpointOutcome: checkpointLot.outcome,
      recoveredOutcome: recoveredLot.outcome,
      checkpointShares: round(checkpointLot.shares),
      recoveredShares: round(recoveredLot.shares),
      sharesDelta: round(recoveredLot.shares - checkpointLot.shares),
      checkpointCostUsdc: round(checkpointLot.totalCostUsdc),
      recoveredCostUsdc: round(recoveredLot.totalCostUsdc),
      costDeltaUsdc: round(recoveredLot.totalCostUsdc - checkpointLot.totalCostUsdc),
      issues
    });
  }

  for (const recoveredLot of recoveredLots) {
    if (checkpointByLotId.has(recoveredLot.lotId)) {
      continue;
    }

    unexpectedLotCount += 1;
    flags.push(
      buildFlag(
        "unexpected_recovered_lot",
        `Recovered lot ${recoveredLot.lotId} was not present in the checkpoint baseline.`,
        {
          severity: "critical",
          lotId: recoveredLot.lotId
        }
      )
    );
    lotDiffs.push({
      lotId: recoveredLot.lotId,
      recoveredStrategy: recoveredLot.strategy,
      recoveredTokenId: recoveredLot.tokenId,
      recoveredMarketScope: recoveredLot.marketScope,
      recoveredConditionId: recoveredLot.conditionId,
      recoveredOutcome: recoveredLot.outcome,
      recoveredShares: round(recoveredLot.shares),
      recoveredCostUsdc: round(recoveredLot.totalCostUsdc),
      issues: ["unexpected_recovered_lot"]
    });
  }

  const checkpointShares = checkpointLots.reduce(
    (total: number, lot: InventoryLotSnapshot) => total + lot.shares,
    0
  );
  const checkpointCostUsdc = checkpointLots.reduce(
    (total: number, lot: InventoryLotSnapshot) => total + lot.totalCostUsdc,
    0
  );
  const recoveredShares = recoveredLots.reduce(
    (total: number, lot: InventoryLotSnapshot) => total + lot.shares,
    0
  );
  const recoveredCostUsdc = recoveredLots.reduce(
    (total: number, lot: InventoryLotSnapshot) => total + lot.totalCostUsdc,
    0
  );

  let outcome: RestartDrillOutcome = "passed";
  if (flags.some((flag) => flag.severity === "critical")) {
    outcome = "failed";
  } else if (flags.length > 0) {
    outcome = "warning";
  }

  return {
    reportType: "restart_drill_report",
    schemaVersion: 1,
    sessionName:
      input.sessionName ??
      `${input.checkpoint.runtime}:${input.checkpoint.generatedAtMs}:restart-drill`,
    generatedAtMs: input.generatedAtMs ?? Date.now(),
    runtime: input.checkpoint.runtime,
    outcome,
    checkpoint: {
      generatedAtMs: input.checkpoint.generatedAtMs,
      riskState: input.checkpoint.monitoringSnapshot.risk.state,
      openLotCount: checkpointLots.length,
      openShares: round(checkpointShares),
      openCostUsdc: round(checkpointCostUsdc)
    },
    recovery: {
      recoveredLotCount: recoveredLots.length,
      recoveredShares: round(recoveredShares),
      recoveredCostUsdc: round(recoveredCostUsdc)
    },
    totals: {
      matchedLotCount,
      missingLotCount,
      unexpectedLotCount,
      sharesDelta: round(recoveredShares - checkpointShares),
      costDeltaUsdc: round(recoveredCostUsdc - checkpointCostUsdc)
    },
    lotDiffs: lotDiffs.sort((left, right) => left.lotId.localeCompare(right.lotId)),
    flags
  };
};
