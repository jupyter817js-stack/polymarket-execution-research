import type {
  ActiveOrderState,
  ExecutionPlan,
  ExecutionPlanItem,
  OrderIntent,
  OrderIntentSide,
  RejectedIntent
} from "./types.js";

const getOrderConflictKey = (
  tokenId: string,
  side: OrderIntentSide,
  quoteSlot?: string
): string => `${tokenId}:${side}:${quoteSlot ?? "primary"}`;

const compareIntents = (left: OrderIntent, right: OrderIntent): number => {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }

  return left.id.localeCompare(right.id);
};

const sameOrderTerms = (intent: OrderIntent, activeOrder: ActiveOrderState): boolean =>
  Math.abs(intent.price - activeOrder.price) < 1e-9 &&
  Math.abs(intent.size - activeOrder.size) < 1e-9 &&
  intent.tif === activeOrder.tif &&
  intent.postOnly === activeOrder.postOnly;

export class ExecutionEngine {
  private readonly activeOrders = new Map<string, ActiveOrderState>();
  private readonly activeOrderIdByKey = new Map<string, string>();

  getActiveOrders(): ActiveOrderState[] {
    return [...this.activeOrders.values()].map((order) => ({ ...order }));
  }

  getActiveOrdersForCondition(conditionId: string): ActiveOrderState[] {
    return this.getActiveOrders().filter((order) => order.conditionId === conditionId);
  }

  getActiveOrder(
    tokenId: string,
    side: OrderIntentSide,
    quoteSlot?: string
  ): ActiveOrderState | undefined {
    const orderId = this.activeOrderIdByKey.get(getOrderConflictKey(tokenId, side, quoteSlot));
    return orderId ? this.activeOrders.get(orderId) : undefined;
  }

  upsertActiveOrder(order: ActiveOrderState): void {
    const key = getOrderConflictKey(order.tokenId, order.side, order.quoteSlot);
    const previousOrderId = this.activeOrderIdByKey.get(key);

    if (previousOrderId && previousOrderId !== order.orderId) {
      this.activeOrders.delete(previousOrderId);
    }

    this.activeOrderIdByKey.set(key, order.orderId);
    this.activeOrders.set(order.orderId, { ...order });
  }

  releaseActiveOrder(orderId: string): void {
    const existing = this.activeOrders.get(orderId);

    if (!existing) {
      return;
    }

    this.activeOrders.delete(orderId);
    this.activeOrderIdByKey.delete(
      getOrderConflictKey(existing.tokenId, existing.side, existing.quoteSlot)
    );
  }

  clear(): void {
    this.activeOrders.clear();
    this.activeOrderIdByKey.clear();
  }

  plan(intents: readonly OrderIntent[]): ExecutionPlan {
    const accepted: ExecutionPlanItem[] = [];
    const rejected: RejectedIntent[] = [];
    const winningIntentByKey = new Map<string, OrderIntent>();

    for (const intent of [...intents].sort(compareIntents)) {
      const key = getOrderConflictKey(intent.tokenId, intent.side, intent.quoteSlot);
      const existingWinner = winningIntentByKey.get(key);

      if (existingWinner) {
        rejected.push({
          intent,
          reason: "duplicate_intent",
          detail: `Another intent for ${key} with higher or equal priority was already selected.`,
          blockingStrategy: existingWinner.strategy
        });
        continue;
      }

      winningIntentByKey.set(key, intent);
    }

    for (const intent of [...winningIntentByKey.values()].sort(compareIntents)) {
      const activeOrder = this.getActiveOrder(intent.tokenId, intent.side, intent.quoteSlot);

      if (!activeOrder) {
        accepted.push({
          action: "create",
          intent,
          reason: "No active order exists for this token and side."
        });
        continue;
      }

      if (sameOrderTerms(intent, activeOrder)) {
        rejected.push({
          intent,
          reason: "active_order_already_matches",
          detail: `Active order ${activeOrder.orderId} already matches the requested price, size, tif, and postOnly settings.`,
          blockingOrderId: activeOrder.orderId,
          blockingStrategy: activeOrder.strategy
        });
        continue;
      }

      if (activeOrder.priority > intent.priority) {
        rejected.push({
          intent,
          reason: "higher_priority_active_order",
          detail: `Active order ${activeOrder.orderId} from ${activeOrder.strategy} has higher priority (${activeOrder.priority} > ${intent.priority}).`,
          blockingOrderId: activeOrder.orderId,
          blockingStrategy: activeOrder.strategy
        });
        continue;
      }

      if (activeOrder.priority === intent.priority && activeOrder.strategy !== intent.strategy) {
        rejected.push({
          intent,
          reason: "higher_priority_active_order",
          detail: `Active order ${activeOrder.orderId} from ${activeOrder.strategy} has equal priority and keeps the slot until an explicit policy overrides it.`,
          blockingOrderId: activeOrder.orderId,
          blockingStrategy: activeOrder.strategy
        });
        continue;
      }

      accepted.push({
        action: "replace",
        intent,
        reason: `Replacing active order ${activeOrder.orderId} from ${activeOrder.strategy}.`,
        orderToCancel: { ...activeOrder }
      });
    }

    return {
      accepted,
      rejected
    };
  }
}
