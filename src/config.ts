import "dotenv/config";

import { z } from "zod";

const runModeSchema = z.enum(["dry-run", "live"]);
const strategyModeSchema = z.enum(["integrated", "market-maker", "same-market-arb"]);
const alertSeveritySchema = z.enum(["info", "warning", "critical"]);
const alertWebhookFormatSchema = z.enum(["json", "slack", "discord", "telegram"]);
const emptyToUndefined = (value: unknown): unknown =>
  value === "" || value === null ? undefined : value;
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalInt = z.preprocess(emptyToUndefined, z.coerce.number().int().optional());
const optionalPositiveInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().positive().optional()
);
const optionalNonNegativeNumber = z.preprocess(
  emptyToUndefined,
  z.coerce.number().nonnegative().optional()
);

export interface RebateCategoryRule {
  feeRate: number;
  exponent: number;
  makerRebatePct: number;
}

const rebateCategoryRuleSchema = z.object({
  feeRate: z.coerce.number().positive(),
  exponent: z.coerce.number().positive(),
  makerRebatePct: z.coerce.number().min(0).max(1)
});

const envSchema = z.object({
  POLYBOT_MODE: runModeSchema.default("dry-run"),
  POLYBOT_STRATEGY_MODE: strategyModeSchema.default("integrated"),
  POLYBOT_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  POLYBOT_FILE_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("warn"),
  POLYBOT_HOST: z.string().url().default("https://clob.polymarket.com"),
  POLYBOT_GAMMA_HOST: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYBOT_CHAIN_ID: z.coerce.number().int().default(137),
  POLYBOT_CHAIN_RPC_URL: optionalUrl,
  POLYBOT_RELAYER_URL: optionalUrl,
  POLYBOT_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),
  POLYBOT_FUNDER_ADDRESS: optionalString,
  POLYBOT_PRIVATE_KEY: optionalString,
  POLYBOT_API_KEY: optionalString,
  POLYBOT_API_SECRET: optionalString,
  POLYBOT_API_PASSPHRASE: optionalString,
  POLYBOT_BUILDER_API_KEY: optionalString,
  POLYBOT_BUILDER_SECRET: optionalString,
  POLYBOT_BUILDER_PASSPHRASE: optionalString,
  POLYBOT_BUILDER_CODE: optionalString,
  POLYBOT_API_NONCE: optionalInt,
  POLYBOT_TARGET_SHARES: z.coerce.number().positive().default(10),
  POLYBOT_TARGET_ORDER_NOTIONAL_USDC: z.coerce.number().positive().default(1.2),
  POLYBOT_MIN_NET_EDGE_USDC: z.coerce.number().nonnegative().default(0.02),
  POLYBOT_MIN_NET_EDGE_BPS: z.coerce.number().nonnegative().default(15),
  POLYBOT_MAX_ENTRY_GROSS_COST_PER_SHARE: z.coerce.number().positive().max(1).default(0.98),
  POLYBOT_ENTRY_MIN_DEPTH_RATIO: z.coerce.number().min(1).default(1.25),
  POLYBOT_MIN_MARKET_LIQUIDITY: z.coerce.number().nonnegative().default(100_000),
  POLYBOT_MAX_MARKETS: z.coerce.number().int().positive().default(250),
  POLYBOT_MARKET_SCAN_CAP: z.coerce.number().int().positive().default(1_000),
  POLYBOT_MARKET_PAGE_SIZE: z.coerce.number().int().positive().max(500).default(200),
  POLYBOT_MARKET_SELECTION_LOG_TOP_N: z.coerce.number().int().positive().default(5),
  POLYBOT_MARKET_SELECTION_STICKINESS_BOOST: z.coerce.number().min(0).max(1).default(0.08),
  POLYBOT_MARKET_SELECTION_MIN_HOLD_MS: z.coerce.number().int().nonnegative().default(900_000),
  POLYBOT_MARKET_SELECTION_REENTRY_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(300_000),
  POLYBOT_MARKET_SELECTION_MIN_SPREAD: z.coerce.number().nonnegative().default(0.01),
  POLYBOT_MARKET_SELECTION_MIN_ACTIVITY_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  POLYBOT_MARKET_SELECTION_MIN_BEST_BID_NOTIONAL_USDC: z.coerce.number().nonnegative().default(100),
  POLYBOT_MARKET_SELECTION_MIN_BEST_ASK_NOTIONAL_USDC: z.coerce.number().nonnegative().default(100),
  POLYBOT_MARKET_SELECTION_ACTIVITY_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_MARKET_SELECTION_MIN_RECENT_ACTIVITY_EVENTS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  /** Minimum number of ACTUAL trades observed in the activity window required for entry.
   * Distinct from minRecentActivityEvents (which counts all book updates). A market with
   * only price-level churn but zero fills will fail this gate — protecting against
   * "can-buy but cant-sell" markets. */
  POLYBOT_MARKET_SELECTION_MIN_RECENT_TRADE_EVENTS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  /** Minimum exit-side depth multiplier: best-bid notional must be >= mySellSize * price * this.
   * Default 1.5 = require 1.5x our quote size in best-bid liquidity. Set 0 to disable. */
  POLYBOT_MARKET_SELECTION_MIN_EXIT_DEPTH_MULTIPLIER: z.coerce.number()
    .nonnegative()
    .default(1.5),
  /** Comma-separated list of market categories to EXCLUDE (case-insensitive).
   * Examples: "Sports,Esports" rejects all sports markets entirely.
   * Useful to avoid live in-play markets where prices move too fast for maker quotes. */
  POLYBOT_EXCLUDED_CATEGORIES: optionalString,
  /** When true, reject markets whose gameStartTime is in the past (i.e. live/in-play sports).
   * Pre-game sports markets are still allowed. Default false (don't filter by live status). */
  POLYBOT_EXCLUDE_LIVE_SPORTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Sports prematch 시간 윈도우 (사장님 가이드 2026-05-01).
  // 시작 X분 전부터 신규 진입 차단 (cancel) — 가격 erratic 직전.
  POLYBOT_SPORTS_PREMATCH_MIN_MINUTES_BEFORE: z.coerce.number().min(0).default(10),
  // 시작 Y분 전부터 진입 허용 — 너무 일찍 진입하면 long-tail.
  POLYBOT_SPORTS_PREMATCH_MAX_MINUTES_BEFORE: z.coerce.number().min(10).default(120),
  /** Comma-separated substrings that, when present in a market's slug, cause the market
   * to be rejected. More reliable than category filtering since Polymarket's category
   * field is often empty. Examples:
   *   "nba-,nfl-,mlb-,epl-,ucl-,ufc-,-spread-,-spread+,-ou-,-ml-,-1h-"
   * Case-insensitive substring match. */
  POLYBOT_EXCLUDED_SLUG_PATTERNS: optionalString,
  /** Minimum midpoint price for market entry. Markets below this (e.g. $0.05) rarely
   * get two-sided taker flow — maker SELL quotes sit forever. Default 0.15. */
  POLYBOT_MIN_MIDPOINT_PRICE: z.coerce.number().min(0).max(1).default(0.15),
  /** Maximum midpoint price for market entry. Symmetric with MIN — markets above 0.85
   * have the same illiquidity problem on the opposite side. Default 0.85. */
  POLYBOT_MAX_MIDPOINT_PRICE: z.coerce.number().min(0).max(1).default(0.85),
  /** Real-time price shock threshold in absolute price units (0.05 = $0.05).
   * When observed midpoint range within volatilityWindowMs exceeds this,
   * ALL quotes for that market are cancelled and the market is paused. */
  POLYBOT_MM_PRICE_SHOCK_ABS_THRESHOLD: z.coerce.number().min(0).default(0.05),
  /** Cooldown in ms after a price shock before the market can be re-quoted.
   * Default 10 minutes. */
  POLYBOT_MM_PRICE_SHOCK_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(600000),
  POLYBOT_MARKET_SELECTION_VOLATILITY_WINDOW_MS: z.coerce.number().int().positive().default(30_000),
  POLYBOT_MARKET_SELECTION_MAX_MIDPOINT_RANGE: z.coerce.number().nonnegative().default(0.03),
  POLYBOT_MARKET_QUERY: optionalString,
  POLYBOT_ALLOWED_SLUGS: optionalString,
  POLYBOT_MARKET_REFRESH_MS: z.coerce.number().int().positive().default(300_000),
  POLYBOT_WS_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  POLYBOT_WS_RECONNECT_MS: z.coerce.number().int().positive().default(5_000),
  POLYBOT_WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
  POLYBOT_EXECUTION_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  POLYBOT_SIGNAL_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  POLYBOT_EXECUTION_AGGRESSIVE_ENTRY_ORDER_TYPE: z
    .enum(["IOC", "GTC", "FOK"])
    .default("IOC"),
  POLYBOT_EXECUTION_AGGRESSIVE_EXIT_ORDER_TYPE: z
    .enum(["GTC", "IOC", "FOK"])
    .default("IOC"),
  POLYBOT_MIN_CASH_MULTIPLE_FOR_ORDER: z.coerce.number().positive().default(4),
  POLYBOT_USER_ORDER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  POLYBOT_ORDER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  POLYBOT_ENABLE_ORDER_HEARTBEAT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_ORDER_HEARTBEAT_MS: z.coerce.number().int().positive().default(9_000),
  POLYBOT_MIN_SECONDS_TO_END: z.coerce.number().int().nonnegative().default(900),
  POLYBOT_MAX_SECONDS_TO_END: optionalPositiveInt,
  POLYBOT_HEDGE_MAX_GROSS_COST_PER_SHARE: z.coerce.number().positive().default(1.02),
  // Fix P: small overpay buffer above $1.00 par for recovery BUY. Allows the bot to
  // accept a guaranteed micro-loss at resolution ($0.005/share = 50bps over par) when
  // it's still smaller than the alternative (emergency SELL slippage). Default 0.005.
  // Set to 0 to revert to the strict "no recovery above $1.00" behavior.
  POLYBOT_RECOVERY_MAX_OVERPAY_PER_SHARE: z.coerce.number().nonnegative().max(0.05).default(0.005),
  POLYBOT_BUY_PRICE_BUFFER: z.coerce.number().nonnegative().default(0),
  POLYBOT_MAX_BOOK_STALENESS_MS: z.coerce.number().int().nonnegative().default(5_000),
  POLYBOT_MAX_BOOK_SKEW_MS: z.coerce.number().int().nonnegative().default(1_000),
  POLYBOT_FEE_RATE_OVERRIDE_BPS: optionalNonNegativeNumber,
  POLYBOT_FEE_PRICE_EXPONENT: z.coerce.number().positive().default(1),
  POLYBOT_SKIP_FEE_ENABLED_MARKETS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_MM_QUOTE_SIZE: z.coerce.number().positive().default(25),
  // Minimum shares to attempt a SELL quote. Positions smaller than this are dust
  // and will be dropped to prevent Polymarket "invalid amounts" rejections.
  POLYBOT_MM_MIN_SELL_SHARES: z.coerce.number().positive().default(1.0),
  POLYBOT_MM_LIVE_QUOTE_SIZE_MULTIPLIER: z.coerce.number().positive().default(0.5),
  POLYBOT_MM_LIVE_SPREAD_TICKS_MULTIPLIER: z.coerce.number().positive().default(2.0),
  POLYBOT_MM_LIVE_REQUOTE_COOLDOWN_MS: z.coerce.number().int().positive().default(1_500),
  /**
   * Multiplier applied to signal and execution cooldowns for in-play (live) markets.
   * Values < 1 reduce the cooldown so the bot re-evaluates and acts faster on rapidly
   * moving live-market prices. Clamped to (0, 1] to prevent inadvertent cooldown
   * extension (use the spread/size multipliers for that instead).
   */
  POLYBOT_MM_LIVE_COOLDOWN_MULTIPLIER: z.coerce.number().min(0.01).max(1).default(0.5),
  /** Maximum number of active quote layers allowed per token in live markets (smaller than pregame). */
  POLYBOT_MM_LIVE_MAX_ACTIVE_SELL_LAYERS: z.coerce.number().int().min(1).default(1),
  POLYBOT_MM_MIN_SPREAD_TICKS: z.coerce.number().int().positive().default(2),
  POLYBOT_MM_QUOTE_HALF_SPREAD_TICKS: z.coerce.number().int().nonnegative().default(1),
  // 🚫 bestBid 추격 금지. BUY 호가는 bestBid에서 최소 N틱 아래에 배치.
  // 설명: bestBid에 맞춰 매수하면 avgCost == bestBid이 되어 수익 청산 불가능.
  // 1틱 아래로 내리면 BUY 체결 확률은 감소하지만 체결 시 즉시 1틱 스프레드 확보.
  // 0은 레거시(bestBid 추격 허용) 동작.
  POLYBOT_MM_BUY_MIN_INWARD_FROM_BID_TICKS: z.coerce.number().int().nonnegative().default(1),
  // SELL 호가는 bestAsk에서 최소 N틱 위에 배치 (대칭 정책).
  POLYBOT_MM_SELL_MIN_OUTWARD_FROM_ASK_TICKS: z.coerce.number().int().nonnegative().default(1),
  // 시장 진입 최소 스프레드 (bestAsk - bestBid). 이보다 좁은 시장은 거절.
  // minSpreadTicks와 별개: minSpreadTicks는 레거시 필터, minMarketSpreadTicks는
  // 사용자 요구사항 #2에 대응하는 "수익 구조상 진입 불가" 필터.
  // ⚠️ 주의: 폴리마켓 대부분의 유동 시장은 1-tick 스프레드로 거래됨. 2로 설정
  // 시 거의 모든 시장이 탈락 (실측: 210건 중 210건 rejected). 기본값 1은
  // "1-tick 이상"이라는 loose 제약. 보수 운영 원할 때만 2로 상향.
  POLYBOT_MM_MIN_MARKET_SPREAD_TICKS: z.coerce.number().int().positive().default(1),
  POLYBOT_MM_EXIT_MIN_SPREAD_TICKS: z.coerce.number().int().positive().default(1),
  POLYBOT_MM_EXIT_MIN_PROFIT_TICKS: z.coerce.number().int().nonnegative().default(1),
  // 📌 #4 본전 청산 조건부 허용.
  // 재고 보유 시간이 이 임계치를 초과하면 profit floor를 avgCost 이하로도
  // 허용 (최대 POLYBOT_MM_BREAK_EVEN_EXIT_MAX_LOSS_TICKS 틱만큼).
  // 기본값 4시간: 장기 정체 시장에서 빠져나올 수 있도록 함. 0은 비활성.
  POLYBOT_MM_BREAK_EVEN_EXIT_AFTER_MS: z.coerce.number().int().nonnegative().default(14_400_000),
  // 본전 청산 허용 시 avgCost 아래로 몇 틱까지 SELL 허용할지.
  // 0 = 정확히 avgCost (break-even), 1 = avgCost - 1틱 (소손절), 2 = 소손절 2틱 등.
  POLYBOT_MM_BREAK_EVEN_EXIT_MAX_LOSS_TICKS: z.coerce.number().int().nonnegative().default(0),
  POLYBOT_MM_CONDITIONAL_EXIT_MAX_LOSS_BPS: z.coerce.number().nonnegative().default(200),
  POLYBOT_MM_CONDITIONAL_EXIT_OVERWEIGHT_RATIO: z.coerce.number().positive().default(0.8),
  POLYBOT_MM_MIN_TOP_BOOK_LIQUIDITY_USDC: z.coerce.number().nonnegative().default(1_000),
  POLYBOT_MM_THIN_TOP_BOOK_REJECTION_THRESHOLD: z.coerce.number()
    .int()
    .nonnegative()
    .default(0),
  POLYBOT_MM_THIN_TOP_BOOK_REJECTION_COOLDOWN_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(0),
  POLYBOT_MM_REQUOTE_COOLDOWN_MS: z.coerce.number().int().positive().default(4_000),
  POLYBOT_MM_STALE_REQUOTE_AFTER_MS: z.coerce.number().int().nonnegative().default(15_000),
  POLYBOT_MM_PASSIVE_REFRESH_MIN_REST_MS: z.coerce.number().int().nonnegative().default(15_000),
  // Hard ceiling on passive quote lifetime. After this, the quote is force-
  // replaced regardless of safer-drift protection, so a quote sitting at a
  // stale price (e.g. 0.30 SELL while bestAsk dropped to 0.27) eventually
  // gets re-anchored. Shorter = faster response, more churn. Operator's
  // "빠른 회전" principle argues for shorter — default tightened to 90s.
  POLYBOT_MM_PASSIVE_QUOTE_MAX_LIFETIME_MS: z.coerce.number().int().nonnegative().default(90_000),
  POLYBOT_MM_PASSIVE_REFRESH_MAX_SAFER_DRIFT_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(2),
  POLYBOT_MM_ENABLE_PASSIVE_SELL_TRACKING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_PASSIVE_SELL_TRACKING_TRIGGER_BPS: z.coerce.number()
    .nonnegative()
    .default(50),
  POLYBOT_MM_PASSIVE_SELL_TRACKING_TRIGGER_ABS: z.coerce.number()
    .nonnegative()
    .default(0.005),
  /** Independent age timer: refresh resting SELL orders that have not filled within this many
   * milliseconds since posting, regardless of price drift. Default 0 = disabled (rely on
   * displacement trigger only). Set to 5_000–10_000 in production env to enable time-based
   * SELL refresh — useful for stationary books where the touch is right but no fills come. */
  POLYBOT_MM_PASSIVE_SELL_MAX_AGE_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(0),
  /** Maximum resting lifetime for passive BUY quotes in healthy markets. */
  POLYBOT_MM_PASSIVE_BUY_MAX_AGE_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(90_000),
  /** Shorter resting lifetime when recent trade flow or exitability weakens. */
  POLYBOT_MM_PASSIVE_BUY_WEAK_SIGNAL_MAX_AGE_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(45_000),
  /** Tightest resting lifetime for low-trade or stale-book BUY quotes. */
  POLYBOT_MM_PASSIVE_BUY_NO_TRADE_MAX_AGE_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(30_000),
  /** Expected exit slower than this pushes passive BUYs onto a shorter freshness lease. */
  POLYBOT_MM_PASSIVE_BUY_MAX_EXPECTED_EXIT_SECONDS: z.coerce.number()
    .positive()
    .default(90),
  /** Require at least this many best-bid shares relative to our quote size before allowing a passive BUY.
   * 1.0 = best bid must show at least our own size; higher values demand stronger nearby support. */
  POLYBOT_MM_PASSIVE_BUY_MIN_BEST_BID_SUPPORT_MULTIPLIER: z.coerce.number()
    .positive()
    .default(1),
  /** Reject/shorten passive BUYs when the maker queue already waiting at the target 1-tick exit
   * price is too large versus our order size. Example: 500 means 10-share BUYs reject if
   * > 5,000 shares are already ahead at the intended exit. */
  POLYBOT_MM_PASSIVE_BUY_MAX_TARGET_EXIT_QUEUE_MULTIPLIER: z.coerce.number()
    .positive()
    .default(2_000),
  /** If midpoint moves this many ticks inside the volatility window, passive BUYs get a much shorter
   * freshness lease because the touch is no longer stable enough for 1-tick MM. */
  POLYBOT_MM_PASSIVE_BUY_MAX_ADVERSE_MIDPOINT_RANGE_TICKS: z.coerce.number()
    .positive()
    .default(2),
  POLYBOT_MM_MIN_PASSIVE_BUY_PRICE: z.coerce.number()
    .min(0)
    .max(1)
    .default(0),
  POLYBOT_MM_MAX_PASSIVE_BUY_PRICE: z.coerce.number()
    .min(0)
    .max(1)
    .default(1),
  POLYBOT_MM_SELL_REPOST_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(5_000),
  // 🔔 매수 체결 후 SELL 호가를 보류할 시간. 과거 10s였으나 #7 "매수 후 반드시
  // SELL 활성 유지" 요구에 맞춰 2s로 단축. venue-aware 재고 필터(#0)가
  // 잔고 race를 이미 막아주므로 긴 cooldown은 불필요.
  POLYBOT_MM_BUY_FILL_SETTLEMENT_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(2_000),
  // 🔔 재고 보유 중 SELL이 비어있는 상태를 감지하는 watchdog 주기.
  // 주기마다 체크해서 inventory > 0 && SELL active == 0 이면 warning + 즉시
  // 재평가 트리거. 더 짧으면 SELL 복구 더 빠름. "빠른 회전" 원칙에 맞춰 10s.
  POLYBOT_MM_SELL_COVERAGE_WATCHDOG_INTERVAL_MS: z.coerce.number().int().nonnegative().default(10_000),
  POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_AFTER_GAP_COUNT: z.coerce.number()
    .int()
    .positive()
    .default(6),
  POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_REDUCTION_SHARES: z.coerce.number()
    .positive()
    .default(5),
  POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_LOSS_USDC: z.coerce.number()
    .nonnegative()
    .default(0),
  POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_LOSS_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(0),
  POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_COOLDOWN_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(120_000),
  POLYBOT_MM_BUY_REENTRY_AFTER_FILL_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(300_000),
  // 🔒 Condition-level BUY suppression after ANY BUY fill on that condition.
  // Applies to BOTH sides of the pair (prevents buying opposite outcome right
  // after one side fills — that flips MM into directional betting). Typically
  // should equal or exceed buyReentryAfterFillCooldownMs. 0 disables.
  POLYBOT_MM_CONDITION_BUY_SUPPRESSION_MS: z.coerce.number().int().nonnegative().default(300_000),
  // 📌 Pair imbalance 제어. YES와 NO 재고 차이가 이 임계치 초과 시, overweight
  // 쪽 BUY 차단. 양측 balanced MM 유지가 목적. 0은 비활성.
  // 예: YES 20주, NO 40주 → 차이 20주. 임계치 20이면 NO side BUY 차단.
  POLYBOT_MM_MAX_PAIR_IMBALANCE_SHARES: z.coerce.number().nonnegative().default(40),
  POLYBOT_MM_POST_RISK_REDUCTION_REENTRY_COOLDOWN_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(120_000),
  POLYBOT_MM_BALANCE_REFRESH_MS: z.coerce.number().int().positive().default(15_000),
  POLYBOT_MM_MAX_TOKEN_EXPOSURE_SHARES: z.coerce.number().positive().default(250),
  POLYBOT_MM_MAX_TOKEN_EXPOSURE_PORTFOLIO_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  // Hard inventory cap multiplier — when a token's inventory exceeds
  // (maxTokenExposureShares × multiplier) we suppress further BUYs and force
  // an inventory-trim SELL (still subject to the profit floor). 1.0 = trim
  // exactly at the per-token exposure ceiling. Set higher (e.g. 1.2) to allow
  // a buffer before trimming kicks in.
  POLYBOT_MM_INVENTORY_CAP_MULTIPLIER: z.coerce.number().positive().default(1),
  // Inward ticks added to the trim SELL when inventory is over the cap. The
  // SELL still respects the profit floor; this only sets how aggressively the
  // floor-respecting quote is priced toward bestBid.
  POLYBOT_MM_INVENTORY_CAP_TRIM_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  // Auto-deactivate a market with no fill activity for this long. 0 disables.
  // The reactivation timeout is independent so a market can come back later.
  POLYBOT_MM_DEAD_MARKET_DEACTIVATION_MS: z.coerce.number().int().nonnegative().default(1_800_000),
  POLYBOT_MM_DEAD_MARKET_REACTIVATION_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  POLYBOT_MM_DEAD_MARKET_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_MM_MAX_CATEGORY_EXPOSURE_USDC: z.coerce.number().nonnegative().default(250),
  POLYBOT_MM_USE_REWARD_MIN_SIZE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_ENABLE_REWARD_CONSTRAINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_MM_ENABLE_TOUCH_QUOTE_ANCHORING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_TOUCH_BID_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_MM_TOUCH_ASK_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_MM_ENABLE_REBATE_BIAS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_ENABLE_INVENTORY_SKEW: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_INVENTORY_SKEW_MAX_TICK_OFFSET: z.coerce.number().int().nonnegative().default(2),
  POLYBOT_MM_ENABLE_ONE_SIDE_FILL_RESPONSE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // Hedge mode disables aggressive exit on the filled side and instead relies
  // on a sharper opposing-side BUY (POLYBOT_MM_ONE_SIDE_FILL_HEDGE_OPPOSING_BUY_INWARD_TICKS)
  // to flat the pair via natural fills. "exit" preserves legacy aggressive-exit behavior.
  POLYBOT_MM_ONE_SIDE_FILL_RESPONSE_MODE: z.enum(["exit", "hedge"]).default("exit"),
  POLYBOT_MM_ONE_SIDE_FILL_HEDGE_OPPOSING_BUY_INWARD_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(2),
  POLYBOT_MM_ONE_SIDE_FILL_MIN_IMBALANCE_SHARES: z.coerce.number().nonnegative().default(1),
  POLYBOT_MM_ONE_SIDE_FILL_UNWIND_AFTER_MS: z.coerce.number().int().nonnegative().default(120_000),
  POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_OPPOSING_BUY_INWARD_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_FILLED_BUY_OUTWARD_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_FILLED_SELL_INWARD_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  POLYBOT_MM_ONE_SIDE_FILL_UNWIND_SELL_INWARD_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(2),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_AFTER_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(5_000),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_MIN_CHUNK_SHARES: z.coerce.number()
    .positive()
    .default(1),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_MAX_CHUNK_SHARES: z.coerce.number()
    .positive()
    .default(2),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_CHUNK_RATIO: z.coerce.number()
    .positive()
    .max(1)
    .default(0.25),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REPRICE_AFTER_REJECTS: z.coerce.number()
    .int()
    .positive()
    .default(3),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REJECT_PRICE_CONCESSION_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(1),
  POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REJECT_SIZE_MULTIPLIER: z.coerce.number()
    .positive()
    .max(1)
    .default(0.5),
  POLYBOT_MM_ONE_SIDE_FILL_STOP_MAX_LOSS_BPS: z.coerce.number()
    .nonnegative()
    .default(100),
  POLYBOT_MM_ONE_SIDE_FILL_UNWIND_SUPPRESS_FILLED_BUY: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_ONE_SIDE_INVENTORY_HARD_GATE_RATIO: z.coerce.number().min(0.5).max(1).default(0.8),
  POLYBOT_MM_ENABLE_TAKE_PROFIT_UNWIND: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_ENABLE_NET_PAIR_EXIT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_NET_PAIR_TAKE_PROFIT_MIN_PNL_USDC: z.coerce.number().nonnegative().default(0.05),
  POLYBOT_MM_NET_PAIR_STOP_MAX_LOSS_USDC: z.coerce.number().nonnegative().default(0.05),
  POLYBOT_MM_NET_PAIR_TAKE_PROFIT_MIN_EDGE_BPS: optionalNonNegativeNumber,
  POLYBOT_MM_NET_PAIR_STOP_MAX_LOSS_BPS: optionalNonNegativeNumber,
  POLYBOT_MM_NET_PAIR_SPREAD_COLLAPSE_MAX_OBSERVED_SPREAD_TICKS: z.coerce.number().int().positive().default(1),
  POLYBOT_MM_TAKE_PROFIT_MIN_PNL_USDC: z.coerce.number().nonnegative().default(0.05),
  POLYBOT_MM_TAKE_PROFIT_MIN_EDGE_BPS: z.coerce.number().nonnegative().default(100),
  POLYBOT_MM_ENABLE_AGE_BASED_UNWIND: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_AGE_BASED_UNWIND_AFTER_MS: z.coerce.number().int().nonnegative().default(300_000),
  POLYBOT_MM_AGE_BASED_UNWIND_STEP_MS: z.coerce.number().int().positive().default(120_000),
  POLYBOT_MM_AGE_BASED_UNWIND_MAX_INWARD_TICKS: z.coerce.number().int().positive().default(2),
  POLYBOT_MM_ENABLE_STALE_BREAK_EVEN_UNWIND: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_MM_STALE_BREAK_EVEN_UNWIND_AFTER_MS: z.coerce.number()
    .int()
    .positive()
    .default(1_200_000),
  POLYBOT_MM_STALE_BREAK_EVEN_UNWIND_MIN_EDGE_BPS: z.coerce.number().default(0),
  POLYBOT_MM_ENABLE_MAX_HOLD_HARD_EXIT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_MAX_HOLD_HARD_EXIT_AFTER_MS: z.coerce.number().int().nonnegative().default(14_400_000),
  POLYBOT_MM_MAX_HOLD_HARD_EXIT_POST_CANCEL_SETTLEMENT_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(2_000),
  POLYBOT_MM_MAX_HOLD_HARD_EXIT_RETRY_COOLDOWN_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(300_000),
  POLYBOT_MM_MAX_HOLD_HARD_EXIT_SUPPRESS_BUYS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_ENABLE_REWARD_REBATE_SCHEDULING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // V2 cutover (2026-04-28) 이후 getCurrentRewards() 가 운영 환경에서 일관되게
  // 180s timeout 됨. selection 의 reward 신호는 gamma 응답의 rewardsMaxSpread /
  // rewardsMinSize / makerBaseFee 만으로 충분하므로 이 호출은 default 로 skip.
  POLYBOT_MM_DISABLE_REWARD_METADATA_FETCH: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_REWARD_SCHEDULING_MAX_QUOTE_SIZE_MULTIPLIER: z.coerce.number().min(1).default(1.5),
  POLYBOT_MM_REWARD_SCHEDULING_RATE_CAP_PER_DAY: z.coerce.number().positive().default(3),
  POLYBOT_MM_REBATE_SCHEDULING_EXTRA_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_MM_ENABLE_FILL_RATE_FEEDBACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_FILL_RATE_FEEDBACK_WINDOW_MS: z.coerce.number().int().positive().default(1_800_000),
  POLYBOT_MM_FILL_RATE_FEEDBACK_MIN_POSTED_QUOTES: z.coerce.number().int().positive().default(8),
  POLYBOT_MM_FILL_RATE_FEEDBACK_TARGET: z.coerce.number().min(0).max(1).default(0.25),
  POLYBOT_MM_FILL_RATE_FEEDBACK_MAX_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_MM_ENABLE_TAPE_PRESSURE_BIAS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_TAPE_PRESSURE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Sliding window for fill-share ratio computation (my fills vs total market fills). */
  POLYBOT_MM_FILL_SHARE_WINDOW_MS: z.coerce.number().int().min(60_000).default(15 * 60_000),
  POLYBOT_MM_TAPE_PRESSURE_MIN_TRADES: z.coerce.number().int().positive().default(4),
  POLYBOT_MM_TAPE_PRESSURE_MIN_TRADES_PER_MINUTE: z.coerce.number().positive().default(4),
  POLYBOT_MM_TAPE_PRESSURE_IMBALANCE_THRESHOLD: z.coerce.number()
    .min(0)
    .max(1)
    .default(0.25),
  POLYBOT_MM_TAPE_PRESSURE_MAX_INWARD_TICKS: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_MM_ENABLE_PASSIVE_TO_AGGRESSIVE_TRANSITION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_PASSIVE_TO_AGGRESSIVE_AFTER_MS: z.coerce.number().int().positive().default(45_000),
  POLYBOT_MM_PASSIVE_TO_AGGRESSIVE_PRICE_BUFFER_TICKS: z.coerce.number()
    .int()
    .nonnegative()
    .default(0),
  POLYBOT_MM_ENABLE_RESOLVED_CLAIM: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_MM_RESOLVED_CLAIM_REFRESH_MS: z.coerce.number().int().positive().default(300_000),
  POLYBOT_MM_REBATE_PRIORITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  POLYBOT_MM_REBATE_MAX_INWARD_TICKS: z.coerce.number().int().positive().default(1),
  POLYBOT_MM_ORDER_TYPE: z.enum(["GTC", "GTD"]).default("GTC"),
  POLYBOT_MM_GTD_BUFFER_SECONDS: z.coerce.number().int().positive().default(300),
  POLYBOT_MM_SELL_LAYERS: z.coerce.number().int().min(1).max(5).default(3),
  POLYBOT_MM_SELL_LAYER_TICK_SPACING: z.coerce.number().int().positive().default(1),
  // Comma-separated relative weights per layer, e.g. "1,1,2" → 25%/25%/50%.
  // Must have exactly POLYBOT_MM_SELL_LAYERS entries when layers > 1.
  POLYBOT_MM_SELL_LAYER_WEIGHTS: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z.string().optional()
  ),
  // 📌 #3 매도 2-layer 분리. POLYBOT_MM_SELL_LAYER_WEIGHTS 미지정 시 Layer 0
  // (빠른 청산용, floor 가격)이 받을 재고 비율. 나머지는 수익 실현 레이어들
  // (floor + N틱)에 균등 분배. 0.5 = Layer 0 50%, 나머지 2개 레이어 각 25%.
  POLYBOT_MM_SELL_LAYER_QUICK_EXIT_WEIGHT_RATIO: z.coerce.number().min(0.05).max(0.95).default(0.5),
  // 📌 #6 one-side aggressive exit chunks에 tier별 가격 스프레드를 적용할지.
  // 0 = 모든 chunk 동일 가격 (legacy). >0 = chunk N은 base + N틱 위 (분산 체결).
  POLYBOT_MM_ONE_SIDE_AGGRESSIVE_EXIT_TIER_TICK_SPACING: z.coerce.number().int().nonnegative().default(1),
  // 📌 #5 Queue 혼잡도 반영. 우리 호가 가격 레벨의 총 사이즈 대비 우리 사이즈
  // 비율을 계산. 이 비율이 낮을수록 우리는 "작은 참가자"로 queue 뒤쪽에 있을
  // 가능성이 높음. threshold 이하면 1틱 inward로 재배치해서 우선순위 개선.
  // 0은 queue 반영 비활성 (기본 비활성 — 로그만 기록).
  POLYBOT_MM_QUEUE_FRONT_RATIO_THRESHOLD: z.coerce.number().min(0).max(1).default(0),
  // Queue 혼잡도 기록용 로그 주기 (min 간격). 0은 매 reconcile마다 기록.
  POLYBOT_MM_QUEUE_METRICS_LOG_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),
  POLYBOT_CAPITAL_TOTAL_ACTIVE_BUY_BUDGET_USDC: z.coerce.number().nonnegative().default(1_000),
  POLYBOT_CAPITAL_MARKET_MAKER_BUDGET_USDC: z.coerce.number().nonnegative().default(750),
  POLYBOT_CAPITAL_SAME_MARKET_ARB_BUDGET_USDC: z.coerce.number().nonnegative().default(150),
  POLYBOT_CAPITAL_NEGATIVE_RISK_BUDGET_USDC: z.coerce.number().nonnegative().default(150),
  POLYBOT_CAPITAL_CONDITION_BUY_BUDGET_USDC: z.coerce.number().nonnegative().default(150),
  POLYBOT_CAPITAL_EVENT_BUY_BUDGET_USDC: z.coerce.number().nonnegative().default(200),
  POLYBOT_CAPITAL_ENABLE_DYNAMIC_STRATEGY_REALLOCATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_CAPITAL_STRATEGY_REALLOCATION_INTENSITY: z.coerce.number().min(0).max(1).default(0.35),
  POLYBOT_CAPITAL_STRATEGY_SIGNAL_FLOOR: z.coerce.number().min(0).max(1).default(0.15),
  POLYBOT_CAPITAL_ENABLE_DYNAMIC_SCOPE_REALLOCATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_CAPITAL_SCOPE_REALLOCATION_INTENSITY: z.coerce.number().min(0).max(1).default(0.35),
  POLYBOT_CAPITAL_SCOPE_SIGNAL_FLOOR: z.coerce.number().min(0).max(1).default(0.15),
  POLYBOT_CAPITAL_ENABLE_INTRADAY_STRATEGY_REALLOCATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_CAPITAL_INTRADAY_PERFORMANCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.3),
  POLYBOT_CAPITAL_INTRADAY_PNL_SCALE_USDC: z.coerce.number().positive().default(10),
  POLYBOT_CAPITAL_DEGRADED_BUY_BUDGET_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.6),
  POLYBOT_CAPITAL_DEGRADED_MARKET_MAKER_BUDGET_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.5),
  POLYBOT_CAPITAL_DEGRADED_SAME_MARKET_ARB_BUDGET_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.8),
  POLYBOT_CAPITAL_DEGRADED_NEGATIVE_RISK_BUDGET_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.7),
  POLYBOT_CAPITAL_ENABLE_DYNAMIC_DEGRADED_CURVE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_CAPITAL_DEGRADED_CURVE_FLOOR_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.5),
  POLYBOT_CAPITAL_DEGRADED_CURVE_EXPONENT: z.coerce.number().positive().default(1.5),
  /** Maximum total buy notional allowed within a rolling 1-hour window. 0 = unlimited. */
  POLYBOT_CAPITAL_HOURLY_BUY_BUDGET_USDC: z.coerce.number().nonnegative().default(0),
  POLYBOT_REWARD_SCORING_REFRESH_MS: z.coerce.number().int().positive().default(30_000),
  POLYBOT_REWARD_PERCENTAGES_REFRESH_MS: z.coerce.number().int().positive().default(300_000),
  POLYBOT_REWARD_EARNINGS_REFRESH_MS: z.coerce.number().int().positive().default(300_000),
  POLYBOT_REWARD_AUTO_CANCEL_NON_SCORING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_REBATE_TRADES_REFRESH_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_REBATE_SUMMARY_REFRESH_MS: z.coerce.number().int().positive().default(300_000),
  POLYBOT_REBATE_CATEGORY_RULES_JSON: optionalString,
  POLYBOT_INTEGRATED_ENABLE_MARKET_MAKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_INTEGRATED_ENABLE_SAME_MARKET_ARB: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_INTEGRATED_ENABLE_NEGATIVE_RISK: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_RISK_MAX_DAILY_LOSS_USDC: z.coerce.number().positive().default(10),
  POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO: z.coerce.number().min(0).max(1).default(0.5),
  POLYBOT_RISK_MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(5),
  POLYBOT_RISK_DEGRADE_CONSECUTIVE_LOSSES: z.coerce.number().int().nonnegative().default(3),
  POLYBOT_RISK_MIN_LOSS_USDC_FOR_CONSECUTIVE_LOSS: z.coerce.number().nonnegative().default(0.03),
  POLYBOT_RISK_MAX_API_ERRORS: z.coerce.number().int().positive().default(10),
  POLYBOT_RISK_DEGRADE_API_ERRORS: z.coerce.number().int().nonnegative().default(5),
  POLYBOT_RISK_MAX_ORDER_FAILURES: z.coerce.number().int().positive().default(3),
  POLYBOT_RISK_DEGRADE_ORDER_FAILURES: z.coerce.number().int().nonnegative().default(2),
  POLYBOT_RISK_MAX_STATE_MISMATCHES: z.coerce.number().int().positive().default(2),
  POLYBOT_RISK_DEGRADE_STATE_MISMATCHES: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_RISK_BLOCK_NEW_BUY_INTENTS_ON_DEGRADED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_RISK_CANCEL_MM_BUY_QUOTES_ON_DEGRADED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_RISK_ENABLE_MM_INVENTORY_REDUCTION_ON_HALT: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_RISK_DEGRADED_MM_QUOTE_SIZE_FLOOR_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.3),
  POLYBOT_RISK_DEGRADED_MM_HALF_SPREAD_MAX_MULTIPLIER: z.coerce.number().min(1).default(2.5),
  POLYBOT_RISK_DEGRADED_SIGNAL_COOLDOWN_MAX_MULTIPLIER: z.coerce.number().min(1).default(3),
  POLYBOT_RISK_DEGRADED_EXECUTION_COOLDOWN_MAX_MULTIPLIER: z.coerce.number().min(1).default(4),
  POLYBOT_RISK_RESET_SESSION_ON_NEW_DAY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_RISK_WARN_DAILY_LOSS_RATIO: z.coerce.number().min(0).max(1).default(0.25),
  POLYBOT_RISK_WARN_CONSECUTIVE_LOSSES: z.coerce.number().int().nonnegative().default(2),
  POLYBOT_RISK_WARN_API_ERRORS: z.coerce.number().int().nonnegative().default(2),
  POLYBOT_RISK_WARN_ORDER_FAILURES: z.coerce.number().int().nonnegative().default(2),
  POLYBOT_RISK_WARN_STATE_MISMATCHES: z.coerce.number().int().nonnegative().default(1),
  POLYBOT_RISK_RECOVERY_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(300_000),
  POLYBOT_RISK_WARNING_MM_QUOTE_SIZE_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.75),
  POLYBOT_RISK_RECOVERY_MM_QUOTE_SIZE_MULTIPLIER: z.coerce.number().min(0).max(1).default(0.6),
  POLYBOT_INITIAL_INVENTORY_LOTS_FILE: optionalString,
  POLYBOT_INITIAL_INVENTORY_LOTS_JSON: optionalString,
  POLYBOT_INVENTORY_SNAPSHOT_FILE: optionalString,
  POLYBOT_INVENTORY_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  // Fix N: dust threshold. Lots with sharesRemaining <= this value are auto-pruned at
  // bot startup and after each emergency unwind. Default 0.05 — Polymarket rejects
  // orders below 5 shares (per-market) so anything below 0.05 cannot be unwound.
  POLYBOT_INVENTORY_DUST_THRESHOLD_SHARES: z.coerce.number().nonnegative().default(0.05),
  POLYBOT_RUNTIME_CHECKPOINT_FILE: optionalString,
  POLYBOT_RUNTIME_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_PAPER_REPORT_FILE: optionalString,
  POLYBOT_PAPER_REPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_PAPER_MAX_CHECKPOINT_STALENESS_MS: z.coerce.number().int().positive().default(120_000),
  POLYBOT_PAPER_HIGH_CONFIDENCE_DEPTH_RATIO: z.coerce.number().positive().default(1.5),
  POLYBOT_PAPER_MEDIUM_CONFIDENCE_DEPTH_RATIO: z.coerce.number().positive().default(1.1),
  POLYBOT_REALIZED_REPORT_FILE: optionalString,
  POLYBOT_REALIZED_REPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_ALERTS_FILE: optionalString,
  POLYBOT_INCIDENTS_FILE: optionalString,
  POLYBOT_ALERT_WEBHOOK_URL: optionalUrl,
  POLYBOT_ALERT_INFO_WEBHOOK_URL: optionalUrl,
  POLYBOT_ALERT_WARNING_WEBHOOK_URL: optionalUrl,
  POLYBOT_ALERT_CRITICAL_WEBHOOK_URL: optionalUrl,
  POLYBOT_ALERT_TELEGRAM_CHAT_ID: optionalString,
  POLYBOT_ALERT_MIN_SEVERITY: alertSeveritySchema.default("warning"),
  POLYBOT_INCIDENT_MIN_SEVERITY: alertSeveritySchema.default("warning"),
  POLYBOT_ALERT_WEBHOOK_FORMAT: alertWebhookFormatSchema.default("json"),
  POLYBOT_ALERT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  POLYBOT_ALERT_ENABLE_QUOTE_POSTED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_ALERT_QUOTE_POST_MIN_INTERVAL_MS: z.coerce.number()
    .int()
    .nonnegative()
    .default(60_000),
  POLYBOT_ALERT_QUOTE_POST_INCLUDE_PASSIVE_SELLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_ALERT_INITIAL_CAPITAL_USDC: optionalNonNegativeNumber,
  // 운영자가 startup capital 을 .env 로 강제 설정. 비워두면 wallet balance 자동 감지.
  // budget multiplier 들이 이 값을 기준으로 계산되므로 라이브 운영 시 명시 권장.
  POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE: optionalNonNegativeNumber,
  POLYBOT_OPERATOR_STATUS_ALERT_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300_000),
  POLYBOT_NEG_RISK_TARGET_SHARES: z.coerce.number().positive().default(5),
  POLYBOT_NEG_RISK_MAX_ENTRY_GROSS_COST_PER_SHARE: z.coerce.number().positive().max(1).default(0.985),
  POLYBOT_NEG_RISK_MIN_NET_EDGE_USDC: z.coerce.number().nonnegative().default(0.03),
  POLYBOT_NEG_RISK_MIN_NET_EDGE_BPS: z.coerce.number().nonnegative().default(25),
  POLYBOT_NEG_RISK_MAX_GROUP_MARKETS: z.coerce.number().int().positive().max(15).default(12),
  POLYBOT_NEG_RISK_ENABLE_LIVE_CONVERSION_BRIDGE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_NEG_RISK_AUTO_APPROVE_ADAPTER: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Fix A (group completeness): require gamma-confirmed full event group before yes-basket arb.
  // Default true. Disable only for tests / temporary diagnostics.
  POLYBOT_NEG_RISK_REQUIRE_COMPLETE_GROUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // Event group metadata cache TTL (gamma /events polling interval).
  POLYBOT_NEG_RISK_GROUP_METADATA_TTL_MS: z.coerce.number().int().positive().default(600_000),
  // Fix B (yes-basket disabled by default): yes-basket profits cannot be realized until
  // event resolution. The Adapter has no YES-of-all → collateral function. Enabling this
  // means capital is locked until the negRisk event resolves (potentially weeks/months).
  POLYBOT_NEG_RISK_ENABLE_YES_BASKET: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Fix C (require bridge): refuse to enter any negative-risk arb if the conversion bridge
  // is not configured. Default true to prevent silent residual exposure on no-to-yes paths.
  POLYBOT_NEG_RISK_REQUIRE_CONVERSION_BRIDGE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // Fix C (min group markets): minimum outcomes required in a negRisk group before
  // any arb evaluation. Default 3 (2-outcome events are usually standard binary, not negRisk).
  POLYBOT_NEG_RISK_MIN_GROUP_MARKETS: z.coerce.number().int().positive().default(3),
  // Fix D/E/I (gas accounting): conservative USDC reserve subtracted from edge math
  // and required as cash buffer beyond grossCost. Polygon gas for convertPositions +
  // setApprovalForAll (first time) is typically ~$0.01-0.10 worth of MATIC. Default
  // $0.30 covers a few txns of headroom.
  POLYBOT_NEG_RISK_CONVERSION_GAS_RESERVE_USDC: z.coerce.number().nonnegative().default(0.3),
  // Fix F (signer/funder pre-flight): when set, refuse to start the executor unless
  // the signer-derived holder matches funderAddress. Default true to prevent silent
  // conversion failures (conversion runs against the holder address; if it's wrong,
  // the bot would burn NO tokens with no compensating credit).
  POLYBOT_NEG_RISK_VERIFY_HOLDER_AT_STARTUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_NEG_RISK_CONVERSION_HOLDER_ADDRESS: optionalString,
  POLYBOT_NEG_RISK_ALLOWED_RELAYER_HOLDER_ADDRESSES: optionalString,
  POLYBOT_NEG_RISK_RELAYER_TX_TYPE: z.preprocess(
    emptyToUndefined,
    z.enum(["proxy", "safe", "auto"]).optional()
  ),
  POLYBOT_ENABLE_USER_WS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_ENABLE_EMERGENCY_SELL: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_EMERGENCY_SELL_PRICE_BUFFER: z.coerce.number().nonnegative().default(0.01),
  // Fix J: balance poll before emergency SELL. After a BUY fills, Polymarket's REST
  // balance API can lag 1–3 s behind. The order matching engine checks balance at
  // acceptance, so a SELL fired immediately after BUY is rejected with "balance: 0".
  // The poll waits up to this many ms for backend balance to reflect the new tokens.
  POLYBOT_EMERGENCY_SELL_BALANCE_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  POLYBOT_EMERGENCY_SELL_BALANCE_POLL_FORCE_UPDATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  POLYBOT_CONTROL_PORT: optionalPositiveInt,
  POLYBOT_VERBOSE_MARKET_LOGS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_VERBOSE_MARKET_LOG_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  POLYBOT_MONITORING_SUMMARY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  POLYBOT_MANUAL_TEST_MARKET_SLUG: optionalString,
  POLYBOT_MANUAL_TEST_FORCE_OPPORTUNITY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_MANUAL_TEST_ALLOW_LIVE_EXECUTION: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  POLYBOT_MANUAL_TEST_MAX_GROSS_COST_PER_SHARE: z.coerce.number().positive().default(1.01),
  POLYBOT_MANUAL_TEST_RUN_ONCE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true")
});

const parsed = envSchema.parse(process.env);

const assertConfigInvariant = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(`Invalid POLYBOT configuration: ${message}`);
  }
};

assertConfigInvariant(
  parsed.POLYBOT_MIN_MIDPOINT_PRICE <= parsed.POLYBOT_MAX_MIDPOINT_PRICE,
  "POLYBOT_MIN_MIDPOINT_PRICE must be <= POLYBOT_MAX_MIDPOINT_PRICE."
);

assertConfigInvariant(
  parsed.POLYBOT_MM_MIN_PASSIVE_BUY_PRICE <= parsed.POLYBOT_MM_MAX_PASSIVE_BUY_PRICE,
  "POLYBOT_MM_MIN_PASSIVE_BUY_PRICE must be <= POLYBOT_MM_MAX_PASSIVE_BUY_PRICE."
);

if (parsed.POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO < 1,
    "POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO must be < 1 when enabled, so DEGRADED happens before HALTED."
  );
}

if (parsed.POLYBOT_RISK_WARN_DAILY_LOSS_RATIO > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_WARN_DAILY_LOSS_RATIO <
      parsed.POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO,
    "POLYBOT_RISK_WARN_DAILY_LOSS_RATIO must be lower than POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO."
  );
}

if (parsed.POLYBOT_RISK_DEGRADE_CONSECUTIVE_LOSSES > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_DEGRADE_CONSECUTIVE_LOSSES <
      parsed.POLYBOT_RISK_MAX_CONSECUTIVE_LOSSES,
    "POLYBOT_RISK_DEGRADE_CONSECUTIVE_LOSSES must be lower than POLYBOT_RISK_MAX_CONSECUTIVE_LOSSES."
  );
}

if (parsed.POLYBOT_RISK_DEGRADE_API_ERRORS > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_DEGRADE_API_ERRORS < parsed.POLYBOT_RISK_MAX_API_ERRORS,
    "POLYBOT_RISK_DEGRADE_API_ERRORS must be lower than POLYBOT_RISK_MAX_API_ERRORS."
  );
}

if (parsed.POLYBOT_RISK_DEGRADE_ORDER_FAILURES > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_DEGRADE_ORDER_FAILURES < parsed.POLYBOT_RISK_MAX_ORDER_FAILURES,
    "POLYBOT_RISK_DEGRADE_ORDER_FAILURES must be lower than POLYBOT_RISK_MAX_ORDER_FAILURES."
  );
}

if (parsed.POLYBOT_RISK_DEGRADE_STATE_MISMATCHES > 0) {
  assertConfigInvariant(
    parsed.POLYBOT_RISK_DEGRADE_STATE_MISMATCHES <
      parsed.POLYBOT_RISK_MAX_STATE_MISMATCHES,
    "POLYBOT_RISK_DEGRADE_STATE_MISMATCHES must be lower than POLYBOT_RISK_MAX_STATE_MISMATCHES."
  );
}

if (parsed.POLYBOT_MODE === "live" && !parsed.POLYBOT_PRIVATE_KEY) {
  throw new Error("POLYBOT_PRIVATE_KEY is required in live mode.");
}

export type RunMode = z.infer<typeof runModeSchema>;
export type StrategyMode = z.infer<typeof strategyModeSchema>;

const allowedSlugs = parsed.POLYBOT_ALLOWED_SLUGS
  ? parsed.POLYBOT_ALLOWED_SLUGS.split(",")
      .map((slug) => slug.trim())
      .filter(Boolean)
  : [];

const parseAddressList = (value: string | undefined): string[] =>
  value
    ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
    : [];

const normalizeCategoryKey = (value: string): string => value.trim().toLowerCase();

const defaultRebateCategoryRules: Record<string, RebateCategoryRule> = {
  crypto: {
    feeRate: 0.25,
    exponent: 2,
    makerRebatePct: 0.2
  },
  sports: {
    feeRate: 0.0175,
    exponent: 1,
    makerRebatePct: 0.25
  }
};

const parseRebateCategoryRules = (
  value: string | undefined
): Record<string, RebateCategoryRule> => {
  if (!value) {
    return {};
  }

  try {
    const payload = JSON.parse(value) as Record<string, unknown>;
    const parsedRules = z.record(z.string(), rebateCategoryRuleSchema).parse(payload);

    return Object.fromEntries(
      Object.entries(parsedRules).map(([category, rule]) => [
        normalizeCategoryKey(category),
        rule
      ])
    );
  } catch (error) {
    throw new Error(
      `POLYBOT_REBATE_CATEGORY_RULES_JSON must be valid JSON. ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const rebateCategoryRules = {
  ...defaultRebateCategoryRules,
  ...parseRebateCategoryRules(parsed.POLYBOT_REBATE_CATEGORY_RULES_JSON)
};

export const config = {
  mode: parsed.POLYBOT_MODE,
  strategyMode: parsed.POLYBOT_STRATEGY_MODE,
  logLevel: parsed.POLYBOT_LOG_LEVEL,
  fileLogLevel: parsed.POLYBOT_FILE_LOG_LEVEL,
  startupCapitalOverrideUsdc: parsed.POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE,
  host: parsed.POLYBOT_HOST,
  gammaHost: parsed.POLYBOT_GAMMA_HOST,
  chainId: parsed.POLYBOT_CHAIN_ID,
  chainRpcUrl: parsed.POLYBOT_CHAIN_RPC_URL?.trim() || undefined,
  relayerUrl: parsed.POLYBOT_RELAYER_URL?.trim() || undefined,
  signatureType: parsed.POLYBOT_SIGNATURE_TYPE,
  funderAddress: parsed.POLYBOT_FUNDER_ADDRESS,
  privateKey: parsed.POLYBOT_PRIVATE_KEY,
  apiCreds:
    parsed.POLYBOT_API_KEY && parsed.POLYBOT_API_SECRET && parsed.POLYBOT_API_PASSPHRASE
      ? {
          key: parsed.POLYBOT_API_KEY,
          secret: parsed.POLYBOT_API_SECRET,
          passphrase: parsed.POLYBOT_API_PASSPHRASE
        }
      : undefined,
  builderAuth:
    parsed.POLYBOT_BUILDER_API_KEY &&
    parsed.POLYBOT_BUILDER_SECRET &&
    parsed.POLYBOT_BUILDER_PASSPHRASE
      ? {
          key: parsed.POLYBOT_BUILDER_API_KEY,
          secret: parsed.POLYBOT_BUILDER_SECRET,
          passphrase: parsed.POLYBOT_BUILDER_PASSPHRASE
        }
      : undefined,
  builderCode: parsed.POLYBOT_BUILDER_CODE?.trim() || undefined,
  apiNonce: parsed.POLYBOT_API_NONCE,
  strategy: {
    targetShares: parsed.POLYBOT_TARGET_SHARES,
    targetOrderNotionalUsdc: parsed.POLYBOT_TARGET_ORDER_NOTIONAL_USDC,
    minNetEdgeUsdc: parsed.POLYBOT_MIN_NET_EDGE_USDC,
    minNetEdgeBps: parsed.POLYBOT_MIN_NET_EDGE_BPS,
    maxEntryGrossCostPerShare: parsed.POLYBOT_MAX_ENTRY_GROSS_COST_PER_SHARE,
    entryMinDepthRatio: parsed.POLYBOT_ENTRY_MIN_DEPTH_RATIO,
    hedgeMaxGrossCostPerShare: parsed.POLYBOT_HEDGE_MAX_GROSS_COST_PER_SHARE,
    recoveryMaxOverpayPerShare: parsed.POLYBOT_RECOVERY_MAX_OVERPAY_PER_SHARE,
    buyPriceBuffer: parsed.POLYBOT_BUY_PRICE_BUFFER,
    maxBookStalenessMs: parsed.POLYBOT_MAX_BOOK_STALENESS_MS,
    maxBookSkewMs: parsed.POLYBOT_MAX_BOOK_SKEW_MS,
    feeRateOverrideBps: parsed.POLYBOT_FEE_RATE_OVERRIDE_BPS,
    feePriceExponent: parsed.POLYBOT_FEE_PRICE_EXPONENT,
    skipFeeEnabledMarkets: parsed.POLYBOT_SKIP_FEE_ENABLED_MARKETS
  },
  marketMaker: {
    quoteSize: parsed.POLYBOT_MM_QUOTE_SIZE,
    liveQuoteSizeMultiplier: parsed.POLYBOT_MM_LIVE_QUOTE_SIZE_MULTIPLIER,
    liveSpreadTicksMultiplier: parsed.POLYBOT_MM_LIVE_SPREAD_TICKS_MULTIPLIER,
    liveRequoteCooldownMs: parsed.POLYBOT_MM_LIVE_REQUOTE_COOLDOWN_MS,
    liveCooldownMultiplier: parsed.POLYBOT_MM_LIVE_COOLDOWN_MULTIPLIER,
    liveMaxActiveSellLayers: parsed.POLYBOT_MM_LIVE_MAX_ACTIVE_SELL_LAYERS,
    minSpreadTicks: parsed.POLYBOT_MM_MIN_SPREAD_TICKS,
    quoteHalfSpreadTicks: parsed.POLYBOT_MM_QUOTE_HALF_SPREAD_TICKS,
    buyMinInwardFromBidTicks: parsed.POLYBOT_MM_BUY_MIN_INWARD_FROM_BID_TICKS,
    sellMinOutwardFromAskTicks: parsed.POLYBOT_MM_SELL_MIN_OUTWARD_FROM_ASK_TICKS,
    minMarketSpreadTicks: parsed.POLYBOT_MM_MIN_MARKET_SPREAD_TICKS,
    queueFrontRatioThreshold: parsed.POLYBOT_MM_QUEUE_FRONT_RATIO_THRESHOLD,
    queueMetricsLogIntervalMs: parsed.POLYBOT_MM_QUEUE_METRICS_LOG_INTERVAL_MS,
    oneSideAggressiveExitTierTickSpacing:
      parsed.POLYBOT_MM_ONE_SIDE_AGGRESSIVE_EXIT_TIER_TICK_SPACING,
    exitMinSpreadTicks: parsed.POLYBOT_MM_EXIT_MIN_SPREAD_TICKS,
    exitMinProfitTicks: parsed.POLYBOT_MM_EXIT_MIN_PROFIT_TICKS,
    breakEvenExitAfterMs: parsed.POLYBOT_MM_BREAK_EVEN_EXIT_AFTER_MS,
    breakEvenExitMaxLossTicks: parsed.POLYBOT_MM_BREAK_EVEN_EXIT_MAX_LOSS_TICKS,
    conditionalExitMaxLossBps: parsed.POLYBOT_MM_CONDITIONAL_EXIT_MAX_LOSS_BPS,
    conditionalExitOverweightRatio: parsed.POLYBOT_MM_CONDITIONAL_EXIT_OVERWEIGHT_RATIO,
    priceShockAbsThreshold: parsed.POLYBOT_MM_PRICE_SHOCK_ABS_THRESHOLD,
    priceShockCooldownMs: parsed.POLYBOT_MM_PRICE_SHOCK_COOLDOWN_MS,
    minTopBookLiquidityUsdc: parsed.POLYBOT_MM_MIN_TOP_BOOK_LIQUIDITY_USDC,
    thinTopBookRejectionThreshold: parsed.POLYBOT_MM_THIN_TOP_BOOK_REJECTION_THRESHOLD,
    thinTopBookRejectionCooldownMs: parsed.POLYBOT_MM_THIN_TOP_BOOK_REJECTION_COOLDOWN_MS,
    requoteCooldownMs: parsed.POLYBOT_MM_REQUOTE_COOLDOWN_MS,
    staleRequoteAfterMs: parsed.POLYBOT_MM_STALE_REQUOTE_AFTER_MS,
    passiveRefreshMinRestMs: parsed.POLYBOT_MM_PASSIVE_REFRESH_MIN_REST_MS,
    passiveQuoteMaxLifetimeMs: parsed.POLYBOT_MM_PASSIVE_QUOTE_MAX_LIFETIME_MS,
    passiveRefreshMaxSaferDriftTicks:
      parsed.POLYBOT_MM_PASSIVE_REFRESH_MAX_SAFER_DRIFT_TICKS,
    enablePassiveSellTracking: parsed.POLYBOT_MM_ENABLE_PASSIVE_SELL_TRACKING,
    passiveSellTrackingTriggerBps:
      parsed.POLYBOT_MM_PASSIVE_SELL_TRACKING_TRIGGER_BPS,
    passiveSellTrackingTriggerAbsolute:
      parsed.POLYBOT_MM_PASSIVE_SELL_TRACKING_TRIGGER_ABS,
    passiveSellMaxAgeMs: parsed.POLYBOT_MM_PASSIVE_SELL_MAX_AGE_MS,
    passiveBuyMaxAgeMs: parsed.POLYBOT_MM_PASSIVE_BUY_MAX_AGE_MS,
    passiveBuyWeakSignalMaxAgeMs:
      parsed.POLYBOT_MM_PASSIVE_BUY_WEAK_SIGNAL_MAX_AGE_MS,
    passiveBuyNoTradeMaxAgeMs:
      parsed.POLYBOT_MM_PASSIVE_BUY_NO_TRADE_MAX_AGE_MS,
    passiveBuyMaxExpectedExitSeconds:
      parsed.POLYBOT_MM_PASSIVE_BUY_MAX_EXPECTED_EXIT_SECONDS,
    passiveBuyMinBestBidSupportMultiplier:
      parsed.POLYBOT_MM_PASSIVE_BUY_MIN_BEST_BID_SUPPORT_MULTIPLIER,
    passiveBuyMaxTargetExitQueueMultiplier:
      parsed.POLYBOT_MM_PASSIVE_BUY_MAX_TARGET_EXIT_QUEUE_MULTIPLIER,
    passiveBuyMaxAdverseMidpointRangeTicks:
      parsed.POLYBOT_MM_PASSIVE_BUY_MAX_ADVERSE_MIDPOINT_RANGE_TICKS,
    minPassiveBuyPrice: parsed.POLYBOT_MM_MIN_PASSIVE_BUY_PRICE,
    maxPassiveBuyPrice: parsed.POLYBOT_MM_MAX_PASSIVE_BUY_PRICE,
    sellRepostCooldownMs: parsed.POLYBOT_MM_SELL_REPOST_COOLDOWN_MS,
    buyFillSettlementCooldownMs: parsed.POLYBOT_MM_BUY_FILL_SETTLEMENT_COOLDOWN_MS,
    sellCoverageWatchdogIntervalMs: parsed.POLYBOT_MM_SELL_COVERAGE_WATCHDOG_INTERVAL_MS,
    sellCoverageForceExitAfterGapCount:
      parsed.POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_AFTER_GAP_COUNT,
    sellCoverageForceExitMaxReductionShares:
      parsed.POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_REDUCTION_SHARES,
    sellCoverageForceExitMaxLossUsdc:
      parsed.POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_LOSS_USDC,
    sellCoverageForceExitMaxLossTicks:
      parsed.POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_MAX_LOSS_TICKS,
    sellCoverageForceExitCooldownMs:
      parsed.POLYBOT_MM_SELL_COVERAGE_FORCE_EXIT_COOLDOWN_MS,
    buyReentryAfterFillCooldownMs: parsed.POLYBOT_MM_BUY_REENTRY_AFTER_FILL_COOLDOWN_MS,
    conditionBuySuppressionMs: parsed.POLYBOT_MM_CONDITION_BUY_SUPPRESSION_MS,
    maxPairImbalanceShares: parsed.POLYBOT_MM_MAX_PAIR_IMBALANCE_SHARES,
    postRiskReductionReentryCooldownMs:
      parsed.POLYBOT_MM_POST_RISK_REDUCTION_REENTRY_COOLDOWN_MS,
    balanceRefreshMs: parsed.POLYBOT_MM_BALANCE_REFRESH_MS,
    maxTokenExposureShares: parsed.POLYBOT_MM_MAX_TOKEN_EXPOSURE_SHARES,
    inventoryCapMultiplier: parsed.POLYBOT_MM_INVENTORY_CAP_MULTIPLIER,
    inventoryCapTrimInwardTicks: parsed.POLYBOT_MM_INVENTORY_CAP_TRIM_INWARD_TICKS,
    deadMarketDeactivationMs: parsed.POLYBOT_MM_DEAD_MARKET_DEACTIVATION_MS,
    deadMarketReactivationMs: parsed.POLYBOT_MM_DEAD_MARKET_REACTIVATION_MS,
    deadMarketCheckIntervalMs: parsed.POLYBOT_MM_DEAD_MARKET_CHECK_INTERVAL_MS,
    maxTokenExposurePortfolioRatio: parsed.POLYBOT_MM_MAX_TOKEN_EXPOSURE_PORTFOLIO_RATIO,
    maxCategoryExposureUsdc: parsed.POLYBOT_MM_MAX_CATEGORY_EXPOSURE_USDC,
    useRewardMinSize: parsed.POLYBOT_MM_USE_REWARD_MIN_SIZE,
    enableRewardConstraints: parsed.POLYBOT_MM_ENABLE_REWARD_CONSTRAINTS,
    enableTouchQuoteAnchoring: parsed.POLYBOT_MM_ENABLE_TOUCH_QUOTE_ANCHORING,
    touchBidInwardTicks: parsed.POLYBOT_MM_TOUCH_BID_INWARD_TICKS,
    touchAskInwardTicks: parsed.POLYBOT_MM_TOUCH_ASK_INWARD_TICKS,
    enableRebateBias: parsed.POLYBOT_MM_ENABLE_REBATE_BIAS,
    enableInventorySkew: parsed.POLYBOT_MM_ENABLE_INVENTORY_SKEW,
    inventorySkewMaxTickOffset: parsed.POLYBOT_MM_INVENTORY_SKEW_MAX_TICK_OFFSET,
    enableOneSideFillResponse: parsed.POLYBOT_MM_ENABLE_ONE_SIDE_FILL_RESPONSE,
    oneSideFillResponseMode: parsed.POLYBOT_MM_ONE_SIDE_FILL_RESPONSE_MODE,
    oneSideFillHedgeOpposingBuyInwardTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_HEDGE_OPPOSING_BUY_INWARD_TICKS,
    oneSideFillMinImbalanceShares: parsed.POLYBOT_MM_ONE_SIDE_FILL_MIN_IMBALANCE_SHARES,
    oneSideFillUnwindAfterMs: parsed.POLYBOT_MM_ONE_SIDE_FILL_UNWIND_AFTER_MS,
    oneSideFillRebalanceOpposingBuyInwardTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_OPPOSING_BUY_INWARD_TICKS,
    oneSideFillRebalanceFilledBuyOutwardTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_FILLED_BUY_OUTWARD_TICKS,
    oneSideFillRebalanceFilledSellInwardTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_REBALANCE_FILLED_SELL_INWARD_TICKS,
    oneSideFillUnwindSellInwardTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_UNWIND_SELL_INWARD_TICKS,
    oneSideFillAggressiveExitAfterMs:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_AFTER_MS,
    oneSideFillAggressiveExitMinChunkShares:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_MIN_CHUNK_SHARES,
    oneSideFillAggressiveExitMaxChunkShares:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_MAX_CHUNK_SHARES,
    oneSideFillAggressiveExitChunkRatio:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_CHUNK_RATIO,
    oneSideFillAggressiveExitRepriceAfterRejects:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REPRICE_AFTER_REJECTS,
    oneSideFillAggressiveExitRejectPriceConcessionTicks:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REJECT_PRICE_CONCESSION_TICKS,
    oneSideFillAggressiveExitRejectSizeMultiplier:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_AGGRESSIVE_EXIT_REJECT_SIZE_MULTIPLIER,
    oneSideFillStopMaxLossBps:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_STOP_MAX_LOSS_BPS,
    oneSideFillUnwindSuppressFilledBuy:
      parsed.POLYBOT_MM_ONE_SIDE_FILL_UNWIND_SUPPRESS_FILLED_BUY,
    oneSideInventoryHardGateRatio: parsed.POLYBOT_MM_ONE_SIDE_INVENTORY_HARD_GATE_RATIO,
    enableTakeProfitUnwind: parsed.POLYBOT_MM_ENABLE_TAKE_PROFIT_UNWIND,
    enableNetPairExit: parsed.POLYBOT_MM_ENABLE_NET_PAIR_EXIT,
    netPairTakeProfitMinPnlUsdc: parsed.POLYBOT_MM_NET_PAIR_TAKE_PROFIT_MIN_PNL_USDC,
    netPairStopMaxLossUsdc: parsed.POLYBOT_MM_NET_PAIR_STOP_MAX_LOSS_USDC,
    netPairTakeProfitMinEdgeBps: parsed.POLYBOT_MM_NET_PAIR_TAKE_PROFIT_MIN_EDGE_BPS,
    netPairStopMaxLossBps: parsed.POLYBOT_MM_NET_PAIR_STOP_MAX_LOSS_BPS,
    netPairSpreadCollapseMaxObservedSpreadTicks:
      parsed.POLYBOT_MM_NET_PAIR_SPREAD_COLLAPSE_MAX_OBSERVED_SPREAD_TICKS,
    takeProfitMinPnlUsdc: parsed.POLYBOT_MM_TAKE_PROFIT_MIN_PNL_USDC,
    takeProfitMinEdgeBps: parsed.POLYBOT_MM_TAKE_PROFIT_MIN_EDGE_BPS,
    enableAgeBasedUnwind: parsed.POLYBOT_MM_ENABLE_AGE_BASED_UNWIND,
    ageBasedUnwindAfterMs: parsed.POLYBOT_MM_AGE_BASED_UNWIND_AFTER_MS,
    ageBasedUnwindStepMs: parsed.POLYBOT_MM_AGE_BASED_UNWIND_STEP_MS,
    ageBasedUnwindMaxInwardTicks: parsed.POLYBOT_MM_AGE_BASED_UNWIND_MAX_INWARD_TICKS,
    enableStaleBreakEvenUnwind: parsed.POLYBOT_MM_ENABLE_STALE_BREAK_EVEN_UNWIND,
    staleBreakEvenUnwindAfterMs: parsed.POLYBOT_MM_STALE_BREAK_EVEN_UNWIND_AFTER_MS,
    staleBreakEvenUnwindMinEdgeBps: parsed.POLYBOT_MM_STALE_BREAK_EVEN_UNWIND_MIN_EDGE_BPS,
    enableMaxHoldHardExit: parsed.POLYBOT_MM_ENABLE_MAX_HOLD_HARD_EXIT,
    maxHoldHardExitAfterMs: parsed.POLYBOT_MM_MAX_HOLD_HARD_EXIT_AFTER_MS,
    maxHoldHardExitPostCancelSettlementMs:
      parsed.POLYBOT_MM_MAX_HOLD_HARD_EXIT_POST_CANCEL_SETTLEMENT_MS,
    maxHoldHardExitRetryCooldownMs:
      parsed.POLYBOT_MM_MAX_HOLD_HARD_EXIT_RETRY_COOLDOWN_MS,
    maxHoldHardExitSuppressBuys:
      parsed.POLYBOT_MM_MAX_HOLD_HARD_EXIT_SUPPRESS_BUYS,
    enableRewardRebateScheduling: parsed.POLYBOT_MM_ENABLE_REWARD_REBATE_SCHEDULING,
    disableRewardMetadataFetch: parsed.POLYBOT_MM_DISABLE_REWARD_METADATA_FETCH,
    rewardSchedulingMaxQuoteSizeMultiplier:
      parsed.POLYBOT_MM_REWARD_SCHEDULING_MAX_QUOTE_SIZE_MULTIPLIER,
    rewardSchedulingRateCapPerDay: parsed.POLYBOT_MM_REWARD_SCHEDULING_RATE_CAP_PER_DAY,
    rebateSchedulingExtraInwardTicks:
      parsed.POLYBOT_MM_REBATE_SCHEDULING_EXTRA_INWARD_TICKS,
    enableFillRateFeedback: parsed.POLYBOT_MM_ENABLE_FILL_RATE_FEEDBACK,
    fillRateFeedbackWindowMs: parsed.POLYBOT_MM_FILL_RATE_FEEDBACK_WINDOW_MS,
    fillRateFeedbackMinPostedQuotes: parsed.POLYBOT_MM_FILL_RATE_FEEDBACK_MIN_POSTED_QUOTES,
    fillRateFeedbackTarget: parsed.POLYBOT_MM_FILL_RATE_FEEDBACK_TARGET,
    fillRateFeedbackMaxInwardTicks:
      parsed.POLYBOT_MM_FILL_RATE_FEEDBACK_MAX_INWARD_TICKS,
    enableTapePressureBias: parsed.POLYBOT_MM_ENABLE_TAPE_PRESSURE_BIAS,
    tapePressureWindowMs: parsed.POLYBOT_MM_TAPE_PRESSURE_WINDOW_MS,
    fillShareWindowMs: parsed.POLYBOT_MM_FILL_SHARE_WINDOW_MS,
    tapePressureMinTrades: parsed.POLYBOT_MM_TAPE_PRESSURE_MIN_TRADES,
    tapePressureMinTradesPerMinute: parsed.POLYBOT_MM_TAPE_PRESSURE_MIN_TRADES_PER_MINUTE,
    tapePressureImbalanceThreshold: parsed.POLYBOT_MM_TAPE_PRESSURE_IMBALANCE_THRESHOLD,
    tapePressureMaxInwardTicks: parsed.POLYBOT_MM_TAPE_PRESSURE_MAX_INWARD_TICKS,
    enablePassiveToAggressiveTransition:
      parsed.POLYBOT_MM_ENABLE_PASSIVE_TO_AGGRESSIVE_TRANSITION,
    passiveToAggressiveAfterMs: parsed.POLYBOT_MM_PASSIVE_TO_AGGRESSIVE_AFTER_MS,
    passiveToAggressivePriceBufferTicks:
      parsed.POLYBOT_MM_PASSIVE_TO_AGGRESSIVE_PRICE_BUFFER_TICKS,
    enableResolvedClaim: parsed.POLYBOT_MM_ENABLE_RESOLVED_CLAIM,
    resolvedClaimRefreshMs: parsed.POLYBOT_MM_RESOLVED_CLAIM_REFRESH_MS,
    rebatePriorityThreshold: parsed.POLYBOT_MM_REBATE_PRIORITY_THRESHOLD,
    rebateMaxInwardTicks: parsed.POLYBOT_MM_REBATE_MAX_INWARD_TICKS,
    orderType: parsed.POLYBOT_MM_ORDER_TYPE,
    gtdBufferSeconds: parsed.POLYBOT_MM_GTD_BUFFER_SECONDS,
    minSellShares: parsed.POLYBOT_MM_MIN_SELL_SHARES,
    sellLayers: parsed.POLYBOT_MM_SELL_LAYERS,
    sellLayerTickSpacing: parsed.POLYBOT_MM_SELL_LAYER_TICK_SPACING,
    sellLayerWeights: (() => {
      const raw = parsed.POLYBOT_MM_SELL_LAYER_WEIGHTS;
      if (!raw) {
        // 📌 #3 매도 전략 분리. 기본값: Layer 0(빠른 청산) 50%, 나머지 layer(수익
        // 실현) 균등 분배. 빠른 체결률 확보 + 남은 재고는 더 높은 가격 대기.
        // 환경변수로 "1,1,1" 명시 시 균등 분배(레거시 동작).
        const layers = parsed.POLYBOT_MM_SELL_LAYERS;
        if (layers <= 1) return undefined;
        const quickExitRatio = parsed.POLYBOT_MM_SELL_LAYER_QUICK_EXIT_WEIGHT_RATIO;
        const quickShare = Math.min(0.95, Math.max(0.05, quickExitRatio));
        const rest = (1 - quickShare) / Math.max(1, layers - 1);
        return [quickShare, ...Array.from({ length: layers - 1 }, () => rest)];
      }
      const parts = raw.split(",").map((s) => Number(s.trim()));
      if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return undefined;
      const sum = parts.reduce((a, b) => a + b, 0);
      return parts.map((w) => w / sum);
    })()
  },
  capital: {
    totalActiveBuyBudgetUsdc: parsed.POLYBOT_CAPITAL_TOTAL_ACTIVE_BUY_BUDGET_USDC,
    marketMakingBudgetUsdc: parsed.POLYBOT_CAPITAL_MARKET_MAKER_BUDGET_USDC,
    sameMarketArbBudgetUsdc: parsed.POLYBOT_CAPITAL_SAME_MARKET_ARB_BUDGET_USDC,
    negativeRiskBudgetUsdc: parsed.POLYBOT_CAPITAL_NEGATIVE_RISK_BUDGET_USDC,
    conditionBuyBudgetUsdc: parsed.POLYBOT_CAPITAL_CONDITION_BUY_BUDGET_USDC,
    eventBuyBudgetUsdc: parsed.POLYBOT_CAPITAL_EVENT_BUY_BUDGET_USDC,
    enableDynamicStrategyReallocation:
      parsed.POLYBOT_CAPITAL_ENABLE_DYNAMIC_STRATEGY_REALLOCATION,
    strategyReallocationIntensity: parsed.POLYBOT_CAPITAL_STRATEGY_REALLOCATION_INTENSITY,
    strategySignalFloor: parsed.POLYBOT_CAPITAL_STRATEGY_SIGNAL_FLOOR,
    enableDynamicScopeReallocation:
      parsed.POLYBOT_CAPITAL_ENABLE_DYNAMIC_SCOPE_REALLOCATION,
    scopeReallocationIntensity: parsed.POLYBOT_CAPITAL_SCOPE_REALLOCATION_INTENSITY,
    scopeSignalFloor: parsed.POLYBOT_CAPITAL_SCOPE_SIGNAL_FLOOR,
    enableIntraDayStrategyReallocation:
      parsed.POLYBOT_CAPITAL_ENABLE_INTRADAY_STRATEGY_REALLOCATION,
    intraDayPerformanceWeight: parsed.POLYBOT_CAPITAL_INTRADAY_PERFORMANCE_WEIGHT,
    intraDayPnlScaleUsdc: parsed.POLYBOT_CAPITAL_INTRADAY_PNL_SCALE_USDC,
    degradedBuyBudgetMultiplier: parsed.POLYBOT_CAPITAL_DEGRADED_BUY_BUDGET_MULTIPLIER,
    degradedMarketMakingBudgetMultiplier:
      parsed.POLYBOT_CAPITAL_DEGRADED_MARKET_MAKER_BUDGET_MULTIPLIER,
    degradedSameMarketArbBudgetMultiplier:
      parsed.POLYBOT_CAPITAL_DEGRADED_SAME_MARKET_ARB_BUDGET_MULTIPLIER,
    degradedNegativeRiskBudgetMultiplier:
      parsed.POLYBOT_CAPITAL_DEGRADED_NEGATIVE_RISK_BUDGET_MULTIPLIER,
    enableDynamicDegradedCurve: parsed.POLYBOT_CAPITAL_ENABLE_DYNAMIC_DEGRADED_CURVE,
    degradedCurveFloorMultiplier:
      parsed.POLYBOT_CAPITAL_DEGRADED_CURVE_FLOOR_MULTIPLIER,
    degradedCurveExponent: parsed.POLYBOT_CAPITAL_DEGRADED_CURVE_EXPONENT,
    hourlyBuyBudgetUsdc: parsed.POLYBOT_CAPITAL_HOURLY_BUY_BUDGET_USDC
  },
  rewards: {
    scoringRefreshMs: parsed.POLYBOT_REWARD_SCORING_REFRESH_MS,
    percentagesRefreshMs: parsed.POLYBOT_REWARD_PERCENTAGES_REFRESH_MS,
    earningsRefreshMs: parsed.POLYBOT_REWARD_EARNINGS_REFRESH_MS,
    autoCancelNonScoring: parsed.POLYBOT_REWARD_AUTO_CANCEL_NON_SCORING
  },
  rebates: {
    tradesRefreshMs: parsed.POLYBOT_REBATE_TRADES_REFRESH_MS,
    summaryRefreshMs: parsed.POLYBOT_REBATE_SUMMARY_REFRESH_MS,
    categoryRules: rebateCategoryRules
  },
  integrated: {
    enableMarketMaker: parsed.POLYBOT_INTEGRATED_ENABLE_MARKET_MAKER,
    enableSameMarketArb: parsed.POLYBOT_INTEGRATED_ENABLE_SAME_MARKET_ARB,
    enableNegativeRisk: parsed.POLYBOT_INTEGRATED_ENABLE_NEGATIVE_RISK
  },
  risk: {
    maxDailyLossUsdc: parsed.POLYBOT_RISK_MAX_DAILY_LOSS_USDC,
    degradeDailyLossRatio: parsed.POLYBOT_RISK_DEGRADE_DAILY_LOSS_RATIO,
    maxConsecutiveLosses: parsed.POLYBOT_RISK_MAX_CONSECUTIVE_LOSSES,
    degradeConsecutiveLosses: parsed.POLYBOT_RISK_DEGRADE_CONSECUTIVE_LOSSES,
    minLossUsdcForConsecutiveLoss:
      parsed.POLYBOT_RISK_MIN_LOSS_USDC_FOR_CONSECUTIVE_LOSS,
    maxApiErrors: parsed.POLYBOT_RISK_MAX_API_ERRORS,
    degradeApiErrors: parsed.POLYBOT_RISK_DEGRADE_API_ERRORS,
    maxOrderFailures: parsed.POLYBOT_RISK_MAX_ORDER_FAILURES,
    degradeOrderFailures: parsed.POLYBOT_RISK_DEGRADE_ORDER_FAILURES,
    maxStateMismatches: parsed.POLYBOT_RISK_MAX_STATE_MISMATCHES,
    degradeStateMismatches: parsed.POLYBOT_RISK_DEGRADE_STATE_MISMATCHES,
    blockNewBuyIntentsOnDegraded: parsed.POLYBOT_RISK_BLOCK_NEW_BUY_INTENTS_ON_DEGRADED,
    cancelMmBuyQuotesOnDegraded: parsed.POLYBOT_RISK_CANCEL_MM_BUY_QUOTES_ON_DEGRADED,
    enableMmInventoryReductionOnHalt: parsed.POLYBOT_RISK_ENABLE_MM_INVENTORY_REDUCTION_ON_HALT,
    degradedMmQuoteSizeFloorMultiplier:
      parsed.POLYBOT_RISK_DEGRADED_MM_QUOTE_SIZE_FLOOR_MULTIPLIER,
    degradedMmQuoteHalfSpreadMaxMultiplier:
      parsed.POLYBOT_RISK_DEGRADED_MM_HALF_SPREAD_MAX_MULTIPLIER,
    degradedSignalCooldownMaxMultiplier:
      parsed.POLYBOT_RISK_DEGRADED_SIGNAL_COOLDOWN_MAX_MULTIPLIER,
    degradedExecutionCooldownMaxMultiplier:
      parsed.POLYBOT_RISK_DEGRADED_EXECUTION_COOLDOWN_MAX_MULTIPLIER,
    resetSessionOnNewDay: parsed.POLYBOT_RISK_RESET_SESSION_ON_NEW_DAY,
    warnDailyLossRatio: parsed.POLYBOT_RISK_WARN_DAILY_LOSS_RATIO,
    warnConsecutiveLosses: parsed.POLYBOT_RISK_WARN_CONSECUTIVE_LOSSES,
    warnApiErrors: parsed.POLYBOT_RISK_WARN_API_ERRORS,
    warnOrderFailures: parsed.POLYBOT_RISK_WARN_ORDER_FAILURES,
    warnStateMismatches: parsed.POLYBOT_RISK_WARN_STATE_MISMATCHES,
    recoveryCooldownMs: parsed.POLYBOT_RISK_RECOVERY_COOLDOWN_MS,
    warningMmQuoteSizeMultiplier: parsed.POLYBOT_RISK_WARNING_MM_QUOTE_SIZE_MULTIPLIER,
    recoveryMmQuoteSizeMultiplier: parsed.POLYBOT_RISK_RECOVERY_MM_QUOTE_SIZE_MULTIPLIER
  },
  inventory: {
    dustThresholdShares: parsed.POLYBOT_INVENTORY_DUST_THRESHOLD_SHARES,
    initialLotsFile: parsed.POLYBOT_INITIAL_INVENTORY_LOTS_FILE?.trim() || undefined,
    initialLotsJson: parsed.POLYBOT_INITIAL_INVENTORY_LOTS_JSON?.trim() || undefined,
    snapshotFile: parsed.POLYBOT_INVENTORY_SNAPSHOT_FILE?.trim() || undefined,
    snapshotIntervalMs: parsed.POLYBOT_INVENTORY_SNAPSHOT_INTERVAL_MS
  },
  checkpoint: {
    file: parsed.POLYBOT_RUNTIME_CHECKPOINT_FILE?.trim() || undefined,
    intervalMs: parsed.POLYBOT_RUNTIME_CHECKPOINT_INTERVAL_MS
  },
  paper: {
    reportFile: parsed.POLYBOT_PAPER_REPORT_FILE?.trim() || undefined,
    reportIntervalMs: parsed.POLYBOT_PAPER_REPORT_INTERVAL_MS,
    maxCheckpointStalenessMs: parsed.POLYBOT_PAPER_MAX_CHECKPOINT_STALENESS_MS,
    highConfidenceDepthRatio: parsed.POLYBOT_PAPER_HIGH_CONFIDENCE_DEPTH_RATIO,
    mediumConfidenceDepthRatio: parsed.POLYBOT_PAPER_MEDIUM_CONFIDENCE_DEPTH_RATIO
  },
  realized: {
    reportFile: parsed.POLYBOT_REALIZED_REPORT_FILE?.trim() || undefined,
    reportIntervalMs: parsed.POLYBOT_REALIZED_REPORT_INTERVAL_MS
  },
  alerting: {
    alertsFile: parsed.POLYBOT_ALERTS_FILE?.trim() || undefined,
    incidentsFile: parsed.POLYBOT_INCIDENTS_FILE?.trim() || undefined,
    webhookUrl: parsed.POLYBOT_ALERT_WEBHOOK_URL?.trim() || undefined,
    infoWebhookUrl: parsed.POLYBOT_ALERT_INFO_WEBHOOK_URL?.trim() || undefined,
    warningWebhookUrl: parsed.POLYBOT_ALERT_WARNING_WEBHOOK_URL?.trim() || undefined,
    criticalWebhookUrl: parsed.POLYBOT_ALERT_CRITICAL_WEBHOOK_URL?.trim() || undefined,
    telegramChatId: parsed.POLYBOT_ALERT_TELEGRAM_CHAT_ID?.trim() || undefined,
    minSeverity: parsed.POLYBOT_ALERT_MIN_SEVERITY,
    incidentMinSeverity: parsed.POLYBOT_INCIDENT_MIN_SEVERITY,
    webhookFormat: parsed.POLYBOT_ALERT_WEBHOOK_FORMAT,
    webhookTimeoutMs: parsed.POLYBOT_ALERT_WEBHOOK_TIMEOUT_MS,
    enableQuotePosted: parsed.POLYBOT_ALERT_ENABLE_QUOTE_POSTED,
    quotePostedMinIntervalMs: parsed.POLYBOT_ALERT_QUOTE_POST_MIN_INTERVAL_MS,
    quotePostedIncludePassiveSells:
      parsed.POLYBOT_ALERT_QUOTE_POST_INCLUDE_PASSIVE_SELLS,
    initialCapitalUsdc: parsed.POLYBOT_ALERT_INITIAL_CAPITAL_USDC,
    operatorStatusAlertIntervalMs: parsed.POLYBOT_OPERATOR_STATUS_ALERT_INTERVAL_MS
  },
  negativeRisk: {
    targetShares: parsed.POLYBOT_NEG_RISK_TARGET_SHARES,
    maxEntryGrossCostPerShare: parsed.POLYBOT_NEG_RISK_MAX_ENTRY_GROSS_COST_PER_SHARE,
    minNetEdgeUsdc: parsed.POLYBOT_NEG_RISK_MIN_NET_EDGE_USDC,
    minNetEdgeBps: parsed.POLYBOT_NEG_RISK_MIN_NET_EDGE_BPS,
    maxGroupMarkets: parsed.POLYBOT_NEG_RISK_MAX_GROUP_MARKETS,
    enableLiveConversionBridge: parsed.POLYBOT_NEG_RISK_ENABLE_LIVE_CONVERSION_BRIDGE,
    autoApproveAdapter: parsed.POLYBOT_NEG_RISK_AUTO_APPROVE_ADAPTER,
    requireCompleteGroup: parsed.POLYBOT_NEG_RISK_REQUIRE_COMPLETE_GROUP,
    groupMetadataTtlMs: parsed.POLYBOT_NEG_RISK_GROUP_METADATA_TTL_MS,
    enableYesBasket: parsed.POLYBOT_NEG_RISK_ENABLE_YES_BASKET,
    requireConversionBridge: parsed.POLYBOT_NEG_RISK_REQUIRE_CONVERSION_BRIDGE,
    minGroupMarkets: parsed.POLYBOT_NEG_RISK_MIN_GROUP_MARKETS,
    conversionGasReserveUsdc: parsed.POLYBOT_NEG_RISK_CONVERSION_GAS_RESERVE_USDC,
    verifyHolderAtStartup: parsed.POLYBOT_NEG_RISK_VERIFY_HOLDER_AT_STARTUP,
    conversionHolderAddress:
      parsed.POLYBOT_NEG_RISK_CONVERSION_HOLDER_ADDRESS?.trim() || undefined,
    allowedRelayerHolderAddresses: parseAddressList(
      parsed.POLYBOT_NEG_RISK_ALLOWED_RELAYER_HOLDER_ADDRESSES
    ),
    // SignatureTypeV2: 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE.
    // Map signature type to relayer route: type 1 → proxy, type 2 → safe.
    // Default to "auto" so the bridge tries both PROXY and SAFE if neither maps cleanly.
    // (Earlier this mapped type=2 → "proxy" which silently broke SAFE-funder setups.)
    relayerTxType:
      parsed.POLYBOT_NEG_RISK_RELAYER_TX_TYPE ??
      (parsed.POLYBOT_SIGNATURE_TYPE === 1
        ? "proxy"
        : parsed.POLYBOT_SIGNATURE_TYPE === 2
          ? "safe"
          : "auto")
  },
  marketUniverse: {
    minMarketLiquidity: parsed.POLYBOT_MIN_MARKET_LIQUIDITY,
    maxMarkets: parsed.POLYBOT_MAX_MARKETS,
    scanCap: parsed.POLYBOT_MARKET_SCAN_CAP,
    pageSize: parsed.POLYBOT_MARKET_PAGE_SIZE,
    selectionLogTopN: parsed.POLYBOT_MARKET_SELECTION_LOG_TOP_N,
    selectionStickinessBoost: parsed.POLYBOT_MARKET_SELECTION_STICKINESS_BOOST,
    selectionMinHoldMs: parsed.POLYBOT_MARKET_SELECTION_MIN_HOLD_MS,
    selectionReentryCooldownMs: parsed.POLYBOT_MARKET_SELECTION_REENTRY_COOLDOWN_MS,
    minSpread: parsed.POLYBOT_MARKET_SELECTION_MIN_SPREAD,
    minActivityScore: parsed.POLYBOT_MARKET_SELECTION_MIN_ACTIVITY_SCORE,
    minBestBidNotionalUsdc: parsed.POLYBOT_MARKET_SELECTION_MIN_BEST_BID_NOTIONAL_USDC,
    minBestAskNotionalUsdc: parsed.POLYBOT_MARKET_SELECTION_MIN_BEST_ASK_NOTIONAL_USDC,
    activityWindowMs: parsed.POLYBOT_MARKET_SELECTION_ACTIVITY_WINDOW_MS,
    minRecentActivityEvents: parsed.POLYBOT_MARKET_SELECTION_MIN_RECENT_ACTIVITY_EVENTS,
    minRecentTradeEvents: parsed.POLYBOT_MARKET_SELECTION_MIN_RECENT_TRADE_EVENTS,
    minExitDepthMultiplier: parsed.POLYBOT_MARKET_SELECTION_MIN_EXIT_DEPTH_MULTIPLIER,
    excludedCategories: (parsed.POLYBOT_EXCLUDED_CATEGORIES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    excludeLiveSports: parsed.POLYBOT_EXCLUDE_LIVE_SPORTS,
    sportsPrematchMinMinutesBefore: parsed.POLYBOT_SPORTS_PREMATCH_MIN_MINUTES_BEFORE,
    sportsPrematchMaxMinutesBefore: parsed.POLYBOT_SPORTS_PREMATCH_MAX_MINUTES_BEFORE,
    excludedSlugPatterns: (parsed.POLYBOT_EXCLUDED_SLUG_PATTERNS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    minMidpointPrice: parsed.POLYBOT_MIN_MIDPOINT_PRICE,
    maxMidpointPrice: parsed.POLYBOT_MAX_MIDPOINT_PRICE,
    volatilityWindowMs: parsed.POLYBOT_MARKET_SELECTION_VOLATILITY_WINDOW_MS,
    maxMidpointRange: parsed.POLYBOT_MARKET_SELECTION_MAX_MIDPOINT_RANGE,
    query: parsed.POLYBOT_MARKET_QUERY?.trim() || undefined,
    allowedSlugs,
    refreshMs: parsed.POLYBOT_MARKET_REFRESH_MS,
    minSecondsToEnd: parsed.POLYBOT_MIN_SECONDS_TO_END,
    maxSecondsToEnd: parsed.POLYBOT_MAX_SECONDS_TO_END
  },
  ws: {
    batchSize: parsed.POLYBOT_WS_BATCH_SIZE,
    reconnectMs: parsed.POLYBOT_WS_RECONNECT_MS,
    heartbeatMs: parsed.POLYBOT_WS_HEARTBEAT_MS,
    enableUserWs: parsed.POLYBOT_ENABLE_USER_WS,
    userOrderTimeoutMs: parsed.POLYBOT_USER_ORDER_TIMEOUT_MS,
    orderPollIntervalMs: parsed.POLYBOT_ORDER_POLL_INTERVAL_MS,
    enableOrderHeartbeat: parsed.POLYBOT_ENABLE_ORDER_HEARTBEAT,
    orderHeartbeatMs: parsed.POLYBOT_ORDER_HEARTBEAT_MS
  },
  execution: {
    executionCooldownMs: parsed.POLYBOT_EXECUTION_COOLDOWN_MS,
    signalCooldownMs: parsed.POLYBOT_SIGNAL_COOLDOWN_MS,
    aggressiveEntryOrderType: parsed.POLYBOT_EXECUTION_AGGRESSIVE_ENTRY_ORDER_TYPE,
    aggressiveExitOrderType: parsed.POLYBOT_EXECUTION_AGGRESSIVE_EXIT_ORDER_TYPE,
    enableEmergencySell: parsed.POLYBOT_ENABLE_EMERGENCY_SELL,
    emergencySellPriceBuffer: parsed.POLYBOT_EMERGENCY_SELL_PRICE_BUFFER,
    emergencySellBalancePollTimeoutMs:
      parsed.POLYBOT_EMERGENCY_SELL_BALANCE_POLL_TIMEOUT_MS,
    emergencySellBalancePollForceUpdate:
      parsed.POLYBOT_EMERGENCY_SELL_BALANCE_POLL_FORCE_UPDATE,
    minCashMultipleForOrder: parsed.POLYBOT_MIN_CASH_MULTIPLE_FOR_ORDER
  },
  observability: {
    verboseMarketLogs: parsed.POLYBOT_VERBOSE_MARKET_LOGS,
    verboseMarketLogIntervalMs: parsed.POLYBOT_VERBOSE_MARKET_LOG_INTERVAL_MS,
    monitoringSummaryIntervalMs: parsed.POLYBOT_MONITORING_SUMMARY_INTERVAL_MS
  },
  control: {
    port: parsed.POLYBOT_CONTROL_PORT
  },
  manualTest: {
    marketSlug: parsed.POLYBOT_MANUAL_TEST_MARKET_SLUG,
    forceOpportunity: parsed.POLYBOT_MANUAL_TEST_FORCE_OPPORTUNITY,
    allowLiveExecution: parsed.POLYBOT_MANUAL_TEST_ALLOW_LIVE_EXECUTION,
    maxGrossCostPerShare: parsed.POLYBOT_MANUAL_TEST_MAX_GROSS_COST_PER_SHARE,
    runOnce: parsed.POLYBOT_MANUAL_TEST_RUN_ONCE
  }
} as const;

export type AppConfig = typeof config;
