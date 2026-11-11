import type { PnlTradeRecord, RiskState, StrategyName } from "../core/types.js";

export type RealizedTradingSessionTrade = PnlTradeRecord;

export type RealizedTradingStrategyReport = {
  strategy: StrategyName;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  totalExpectedEdgeUsdc: number;
  totalRealizedPnlUsdc: number;
  realizedVsExpectedDeltaUsdc: number;
};

export type RealizedTradingSessionReport = {
  sessionName: string;
  source: "live-runtime";
  startedAtMs?: number;
  endedAtMs?: number;
  finalRiskState: RiskState;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  totalExpectedEdgeUsdc: number;
  totalRealizedPnlUsdc: number;
  realizedVsExpectedDeltaUsdc: number;
  byStrategy: RealizedTradingStrategyReport[];
  trades: RealizedTradingSessionTrade[];
};

type Aggregate = {
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  flatTrades: number;
  totalExpectedEdgeUsdc: number;
  totalRealizedPnlUsdc: number;
};

const round = (value: number): number => Number(value.toFixed(8));

const createEmptyAggregate = (): Aggregate => ({
  tradeCount: 0,
  winningTrades: 0,
  losingTrades: 0,
  flatTrades: 0,
  totalExpectedEdgeUsdc: 0,
  totalRealizedPnlUsdc: 0
});

const toStrategyReport = (
  strategy: StrategyName,
  aggregate: Aggregate
): RealizedTradingStrategyReport => ({
  strategy,
  tradeCount: aggregate.tradeCount,
  winningTrades: aggregate.winningTrades,
  losingTrades: aggregate.losingTrades,
  flatTrades: aggregate.flatTrades,
  totalExpectedEdgeUsdc: round(aggregate.totalExpectedEdgeUsdc),
  totalRealizedPnlUsdc: round(aggregate.totalRealizedPnlUsdc),
  realizedVsExpectedDeltaUsdc: round(
    aggregate.totalRealizedPnlUsdc - aggregate.totalExpectedEdgeUsdc
  )
});

export const buildRealizedTradingSessionReport = (input: {
  sessionName: string;
  startedAtMs?: number;
  endedAtMs?: number;
  finalRiskState: RiskState;
  trades: readonly PnlTradeRecord[];
}): RealizedTradingSessionReport => {
  const aggregate = createEmptyAggregate();
  const byStrategy = new Map<StrategyName, Aggregate>();
  const trades = input.trades.map((trade) => ({
    ...trade,
    tags: [...trade.tags],
    metadata: trade.metadata ? { ...trade.metadata } : undefined
  }));

  for (const trade of trades) {
    const strategyAggregate = byStrategy.get(trade.strategy) ?? createEmptyAggregate();
    const expectedEdgeUsdc = trade.expectedEdgeUsdc ?? 0;

    aggregate.tradeCount += 1;
    aggregate.totalExpectedEdgeUsdc += expectedEdgeUsdc;
    aggregate.totalRealizedPnlUsdc += trade.realizedPnlUsdc;

    strategyAggregate.tradeCount += 1;
    strategyAggregate.totalExpectedEdgeUsdc += expectedEdgeUsdc;
    strategyAggregate.totalRealizedPnlUsdc += trade.realizedPnlUsdc;

    if (trade.realizedPnlUsdc > 0) {
      aggregate.winningTrades += 1;
      strategyAggregate.winningTrades += 1;
    } else if (trade.realizedPnlUsdc < 0) {
      aggregate.losingTrades += 1;
      strategyAggregate.losingTrades += 1;
    } else {
      aggregate.flatTrades += 1;
      strategyAggregate.flatTrades += 1;
    }

    byStrategy.set(trade.strategy, strategyAggregate);
  }

  return {
    sessionName: input.sessionName,
    source: "live-runtime",
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    finalRiskState: input.finalRiskState,
    tradeCount: aggregate.tradeCount,
    winningTrades: aggregate.winningTrades,
    losingTrades: aggregate.losingTrades,
    flatTrades: aggregate.flatTrades,
    totalExpectedEdgeUsdc: round(aggregate.totalExpectedEdgeUsdc),
    totalRealizedPnlUsdc: round(aggregate.totalRealizedPnlUsdc),
    realizedVsExpectedDeltaUsdc: round(
      aggregate.totalRealizedPnlUsdc - aggregate.totalExpectedEdgeUsdc
    ),
    byStrategy: [...byStrategy.entries()]
      .map(([strategy, strategyAggregate]) => toStrategyReport(strategy, strategyAggregate))
      .sort((left, right) => left.strategy.localeCompare(right.strategy)),
    trades
  };
};
