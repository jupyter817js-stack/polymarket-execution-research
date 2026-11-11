import { ExecutionEngine } from "./execution-engine.js";
import type {
  CoordinationResult,
  OrderIntent,
  PositionManagerLike,
  PositionGateDecision,
  RejectedIntent,
  RiskGateDecision,
  RiskManagerLike
} from "./types.js";

const compareIntents = (left: OrderIntent, right: OrderIntent): number => {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }

  return left.id.localeCompare(right.id);
};

const ALLOW_ALL_RISK: RiskManagerLike = {
  evaluateIntent(): RiskGateDecision {
    return {
      allowed: true,
      state: "RUNNING"
    };
  },
  getState(): "RUNNING" {
    return "RUNNING";
  }
};

const ALLOW_ALL_POSITION: PositionManagerLike = {
  evaluateIntent(): PositionGateDecision {
    return {
      allowed: true
    };
  }
};

type StrategyCoordinatorOptions = {
  executionEngine: ExecutionEngine;
  riskManager?: RiskManagerLike;
  positionManager?: PositionManagerLike;
};

export class StrategyCoordinator {
  private readonly executionEngine: ExecutionEngine;
  private readonly riskManager: RiskManagerLike;
  private readonly positionManager: PositionManagerLike;

  constructor(options: StrategyCoordinatorOptions) {
    this.executionEngine = options.executionEngine;
    this.riskManager = options.riskManager ?? ALLOW_ALL_RISK;
    this.positionManager = options.positionManager ?? ALLOW_ALL_POSITION;
  }

  coordinate(intents: readonly OrderIntent[]): CoordinationResult {
    const approvedIntents: OrderIntent[] = [];
    const preExecutionRejected: RejectedIntent[] = [];
    const highestPriorityByCondition = new Map<string, number>();

    this.positionManager.beginBatch?.();

    for (const intent of [...intents].sort(compareIntents)) {
      const highestPriority = highestPriorityByCondition.get(intent.conditionId);

      if (typeof highestPriority === "number" && intent.priority < highestPriority) {
        preExecutionRejected.push({
          intent,
          reason: "condition_preempted_by_higher_priority_strategy",
          detail: `Condition ${intent.conditionId} already has a higher-priority strategy intent (${highestPriority} > ${intent.priority}).`
        });
        continue;
      }

      if (typeof highestPriority !== "number" || intent.priority > highestPriority) {
        highestPriorityByCondition.set(intent.conditionId, intent.priority);
      }

      const riskDecision = this.riskManager.evaluateIntent(intent);

      if (!riskDecision.allowed) {
        preExecutionRejected.push({
          intent,
          reason: "risk_blocked",
          detail:
            riskDecision.detail ??
            riskDecision.reason ??
            `Risk manager denied the intent while in ${riskDecision.state} state.`
        });
        continue;
      }

      const positionDecision = this.positionManager.evaluateIntent(intent);

      if (!positionDecision.allowed) {
        preExecutionRejected.push({
          intent,
          reason: "position_blocked",
          detail:
            positionDecision.detail ??
            positionDecision.reason ??
            "Position manager denied the projected exposure."
        });
        continue;
      }

      approvedIntents.push(intent);
      this.positionManager.commitApprovedIntent?.(intent);
    }

    const executionPlan = this.executionEngine.plan(approvedIntents);
    this.positionManager.endBatch?.();

    return {
      approvedIntents: executionPlan.accepted.map((item) => item.intent),
      executionPlan,
      rejected: [...preExecutionRejected, ...executionPlan.rejected]
    };
  }
}
