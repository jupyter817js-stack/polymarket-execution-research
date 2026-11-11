import { OrderType } from "@polymarket/clob-client-v2";

import { config } from "../config.js";
import type { OrderIntentTimeInForce } from "../core/types.js";

export type AggressiveExecutionTif = Extract<OrderIntentTimeInForce, "GTC" | "IOC" | "FOK">;

export const getAggressiveEntryTif = (): AggressiveExecutionTif =>
  config.execution.aggressiveEntryOrderType;

export const getAggressiveExitTif = (): AggressiveExecutionTif =>
  config.execution.aggressiveExitOrderType;

export const toSdkOrderType = (tif: AggressiveExecutionTif): OrderType => {
  switch (tif) {
    case "IOC":
      return OrderType.FAK;
    case "FOK":
      return OrderType.FOK;
    default:
      return OrderType.GTC;
  }
};
