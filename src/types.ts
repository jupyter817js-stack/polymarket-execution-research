export interface BinaryMarket {
  id: string;
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  eventId?: string;
  eventSlug?: string;
  eventTitle?: string;
  groupItemTitle?: string;
  category?: string;
  liquidity?: number;
  volume?: number;
  volume24hr?: number;
  competitive?: number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  marketLastTradePrice?: number;
  marketScore?: number;
  outcomes: readonly [string, string];
  tokenIds: readonly [string, string];
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  orderMinSize: number;
  orderPriceMinTickSize: number;
  endDate?: string;
  gameStartTime?: string;
  feesEnabled: boolean;
  feeType?: string;
  negRisk: boolean;
  enableNegRisk?: boolean;
  cumulativeMarkets?: boolean;
  showAllOutcomes?: boolean;
  rewardsMaxSpread?: number;
  rewardsMinSize?: number;
  rewardRatePerDay?: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface NormalizedOrderBook {
  assetId: string;
  market: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  lastTradePrice: number | undefined;
  hash: string | undefined;
  updatedAtMs: number;
  tapePressure?: TradeTapePressureSnapshot;
}

export interface TradeTapePressureSnapshot {
  windowMs: number;
  recentTradeCount: number;
  buyTradeCount: number;
  sellTradeCount: number;
  buyVolume: number;
  sellVolume: number;
  tradesPerMinute: number;
  signedTradeImbalance: number;
  signedVolumeImbalance: number;
  pressureScore: number;
  biasTicks: number;
  dominantSide?: "BUY" | "SELL";
  lastTradeSide?: "BUY" | "SELL";
}

export interface BuyFill {
  shares: number;
  totalCost: number;
  averagePrice: number;
  worstPrice: number;
}

export interface SellFill {
  shares: number;
  totalProceeds: number;
  averagePrice: number;
  worstPrice: number;
}

export interface OpportunityLeg {
  tokenId: string;
  outcome: string;
  fill: BuyFill;
  tickSize: number;
  limitPrice: number;
  feeRateBps: number;
}

export interface SameMarketOpportunity {
  market: BinaryMarket;
  shares: number;
  grossCost: number;
  grossCostPerShare: number;
  grossEdge: number;
  feeCost: number;
  netEdge: number;
  netEdgeBpsOnPar: number;
  legs: readonly [OpportunityLeg, OpportunityLeg];
  detectedAtMs: number;
}

export type SameMarketRejectReason =
  | "stale_book_leg_a"
  | "stale_book_leg_b"
  | "book_timestamp_skew_too_wide"
  | "target_shares_below_order_min_size"
  | "insufficient_depth_leg_a"
  | "insufficient_depth_leg_b"
  | "entry_depth_ratio_too_shallow_leg_a"
  | "entry_depth_ratio_too_shallow_leg_b"
  | "gross_cost_above_entry_cap"
  | "gross_edge_non_positive"
  | "marketable_buy_min_notional_leg_a"
  | "marketable_buy_min_notional_leg_b"
  | "marketable_buy_precision_invalid_leg_a"
  | "marketable_buy_precision_invalid_leg_b"
  | "net_edge_below_min_usdc"
  | "net_edge_below_min_bps";

export interface EvaluationLegDiagnostics {
  tokenId: string;
  outcome: string;
  updatedAtMs: number;
  bookAgeMs: number;
  bestAsk?: number;
  availableDepth?: number;
  averagePrice?: number;
  worstPrice?: number;
  limitPrice?: number;
  orderNotional?: number;
  executableDepthAtLimit?: number;
  requiredDepthAtLimit?: number;
  feeRateBps: number;
}

export interface SameMarketEvaluationDiagnostics {
  market: BinaryMarket;
  evaluatedAtMs: number;
  configuredTargetShares: number;
  shares: number;
  sharesAutoAdjusted: boolean;
  marketOrderMinSize: number;
  bookOrderMinSizeA: number;
  bookOrderMinSizeB: number;
  effectiveOrderMinSize: number;
  targetOrderNotionalUsdc: number;
  maxBookStalenessMs: number;
  maxBookSkewMs: number;
  maxEntryGrossCostPerShare: number;
  entryMinDepthRatio: number;
  bookTimestampSkewMs: number;
  topOfBookSum?: number;
  grossCost?: number;
  grossCostPerShare?: number;
  grossEdge?: number;
  feeCost?: number;
  netEdge?: number;
  netEdgeBpsOnPar?: number;
  legA: EvaluationLegDiagnostics;
  legB: EvaluationLegDiagnostics;
}

export type SameMarketEvaluation =
  | {
      status: "opportunity";
      opportunity: SameMarketOpportunity;
      diagnostics: SameMarketEvaluationDiagnostics;
    }
  | {
      status: "rejected";
      reason: SameMarketRejectReason;
      diagnostics: SameMarketEvaluationDiagnostics;
    };

export interface OrderResolution {
  state: "filled" | "partially_filled" | "cancelled" | "failed" | "timed_out";
  size: number;
  price?: number;
  notional?: number;
  source?: "immediate" | "user_ws" | "rest_poll" | "timeout" | "response_status";
}

export interface PostedOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  status?: string;
  takingAmount?: string;
  makingAmount?: string;
  tradeIDs?: string[];
}

export interface GammaMarketResponse {
  id: string;
  question: string;
  questionID: string;
  conditionId: string;
  slug: string;
  category?: string;
  liquidity?: number | string;
  volume?: number | string;
  volumeNum?: number;
  volume24hr?: number;
  liquidityNum?: number;
  liquidityClob?: number;
  outcomes: string;
  clobTokenIds: string;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  orderMinSize?: number;
  orderPriceMinTickSize?: number;
  endDate?: string;
  gameStartTime?: string;
  feesEnabled?: boolean;
  feeType?: string;
  negRisk?: boolean;
  groupItemTitle?: string;
  events?: Array<{
    id: string;
    slug?: string;
    title?: string;
    negRisk?: boolean;
    enableNegRisk?: boolean;
    cumulativeMarkets?: boolean;
    showAllOutcomes?: boolean;
  }>;
  rewardsMaxSpread?: number;
  rewardsMinSize?: number;
  competitive?: number;
  spread?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  score?: number;
  outcomePrices?: string;
  closedTime?: string;
}

export interface UserOrderEvent {
  event_type: "order";
  id: string;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  original_size: string;
  size_matched: string;
  price: string;
  type?: string;
  status?: string;
}

export interface UserTradeEvent {
  event_type: "trade";
  id: string;
  taker_order_id?: string;
  maker_orders?: Array<{
    order_id?: string;
    id?: string;
    asset_id?: string;
    outcome?: string;
    side?: "BUY" | "SELL";
    matched_amount?: string;
    size?: string;
    price?: string;
    maker_address?: string;
  }>;
  market: string;
  asset_id: string;
  side: "BUY" | "SELL";
  size: string;
  price: string;
  status: string;
}

export interface CurrentRebateEntry {
  date: string;
  makerAddress: string;
  conditionId?: string;
  marketSlug?: string;
  rebatedFeesUsdc: number;
}

export interface BookSnapshotEvent {
  event_type?: "book";
  asset_id: string;
  market: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  hash?: string;
  tick_size?: string;
  min_order_size?: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

export interface PriceChangeEvent {
  event_type: "price_change";
  market: string;
  price_changes: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: "BUY" | "SELL";
    hash?: string;
    best_bid?: string;
    best_ask?: string;
  }>;
  timestamp: string;
}

export interface TickSizeChangeEvent {
  event_type: "tick_size_change";
  asset_id: string;
  market: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
}

export interface LastTradePriceEvent {
  event_type: "last_trade_price";
  asset_id: string;
  market: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  fee_rate_bps?: string;
  timestamp: string;
}
