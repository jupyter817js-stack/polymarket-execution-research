export interface ExecutionNetPnlBreakdown {
  realizedPnlUsdc: number;
  grossRealizedPnlUsdc: number;
  feeCostUsdc: number;
  rebateUsdc: number;
  rewardUsdc: number;
  slippageCostUsdc: number;
  unfilledCostUsdc: number;
  gasCostUsdc: number;
}

export const deriveExecutionNetPnlBreakdown = (input: {
  grossRealizedPnlUsdc: number;
  expectedGrossEdgeUsdc?: number;
  feeCostUsdc?: number;
  rebateUsdc?: number;
  rewardUsdc?: number;
  gasCostUsdc?: number;
  completion:
    | "fully-filled"
    | "recovered-pair"
    | "emergency-unwind"
    | "residual-exposure";
}): ExecutionNetPnlBreakdown => {
  const feeCostUsdc = input.feeCostUsdc ?? 0;
  const rebateUsdc = input.rebateUsdc ?? 0;
  const rewardUsdc = input.rewardUsdc ?? 0;
  const gasCostUsdc = input.gasCostUsdc ?? 0;
  const adverseEdgeDelta =
    typeof input.expectedGrossEdgeUsdc === "number"
      ? Math.max(0, input.expectedGrossEdgeUsdc - input.grossRealizedPnlUsdc)
      : 0;
  const slippageCostUsdc =
    input.completion === "fully-filled" || input.completion === "recovered-pair"
      ? adverseEdgeDelta
      : 0;
  const unfilledCostUsdc =
    input.completion === "emergency-unwind" || input.completion === "residual-exposure"
      ? adverseEdgeDelta
      : 0;
  const realizedPnlUsdc =
    input.grossRealizedPnlUsdc -
    feeCostUsdc -
    slippageCostUsdc -
    unfilledCostUsdc -
    gasCostUsdc +
    rebateUsdc +
    rewardUsdc;

  return {
    realizedPnlUsdc,
    grossRealizedPnlUsdc: input.grossRealizedPnlUsdc,
    feeCostUsdc,
    rebateUsdc,
    rewardUsdc,
    slippageCostUsdc,
    unfilledCostUsdc,
    gasCostUsdc
  };
};
