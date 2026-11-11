import { AssetType, type ClobClient } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { Polybot1 } from "./bot.js";
import { config } from "./config.js";
import {
  AlertDispatcher,
  createConfiguredAlertDispatcher
} from "./core/alert-dispatcher.js";
import {
  buildOperatorStatusAlert,
  buildRiskStateAlert
} from "./core/alert-events.js";
import { ExecutionEngine } from "./core/execution-engine.js";
import { InventoryLotTracker } from "./core/inventory-lot-tracker.js";
import { buildInventoryValuationSnapshot } from "./core/inventory-valuation.js";
import { createSeededInventoryLotTracker } from "./core/inventory-lot-seed.js";
import { restoreRiskRecoveryFromCheckpoint } from "./core/risk-manager-seed.js";
import { InventorySnapshotService } from "./core/inventory-snapshot-service.js";
import { MonitoringService } from "./core/monitoring-service.js";
import { PnLEngine } from "./core/pnl-engine.js";
import { PositionManager } from "./core/position-manager.js";
import { RiskManager } from "./core/risk-manager.js";
import { RuntimeCheckpointService } from "./core/runtime-checkpoint-service.js";
import type { RiskStatusSnapshot } from "./core/types.js";
import { MarketMakerBot } from "./market-maker-bot.js";
import { NegativeRiskBot } from "./negative-risk-bot.js";
import { PaperTradingSessionService } from "./paper-trading/session-service.js";
import { RealizedTradingSessionService } from "./session-report/realized-session-service.js";
import { readMaxAllowanceRaw } from "./polymarket/balance-allowance.js";
import { UserWsTracker } from "./polymarket/user-ws.js";
import type { RiskReductionCandidate } from "./trading/risk-reduction-executor.js";

type RunnableBot = {
  start(): Promise<void>;
  stop(): void | Promise<void>;
};

type MarkPriceProvider = RunnableBot & {
  getMarkPriceForToken?(tokenId: string): number | undefined;
};

type RiskReducingBot = RunnableBot & {
  getRiskReductionCandidates(): RiskReductionCandidate[];
  reduceInventoryRiskCandidates(
    candidates: readonly RiskReductionCandidate[],
    reason?: string
  ): Promise<void>;
};

const rawUsdcToDecimal = (rawBalance: string | number): number => Number(rawBalance) / 1_000_000;

export class IntegratedBot {
  private readonly components: RunnableBot[] = [];
  // Optional reference to the MarketMakerBot for accessing MM-specific quality
  // metrics (BUY→SELL fill ratio, hold time). Null when MM strategy is disabled.
  private mmBot: MarketMakerBot | undefined;
  private readonly markPriceProviders: MarkPriceProvider[] = [];
  private readonly executionEngine = new ExecutionEngine();
  private readonly positionManager = new PositionManager();
  private readonly inventoryTracker: InventoryLotTracker;
  private readonly riskManager: RiskManager;
  private readonly pnlEngine: PnLEngine;
  private readonly monitoringService: MonitoringService;
  private readonly inventorySnapshotService: InventorySnapshotService;
  private readonly runtimeCheckpointService: RuntimeCheckpointService;
  private readonly alertDispatcher: AlertDispatcher;
  private readonly paperTradingSessionService?: PaperTradingSessionService;
  private readonly realizedTradingSessionService?: RealizedTradingSessionService;
  private haltInProgress = false;
  private lastOperatorStatusAlertAtMs = 0;
  private lastOperatorStatusFingerprint?: string;
  private lastObservedCashBalanceUsdc?: number;
  private lastObservedCashTradeCount = 0;
  private startupCapitalUsdc?: number;
  private startupAtMs?: number;

  constructor(
    readonlyClient: ClobClient,
    private readonly logger: Logger,
    private readonly tradingClient?: ClobClient,
    marketMakerUserTracker?: UserWsTracker,
    sameMarketArbUserTracker?: UserWsTracker,
    negativeRiskUserTracker?: UserWsTracker,
    makerAddress?: string
  ) {
    this.inventoryTracker = createSeededInventoryLotTracker(logger);
    this.riskManager = new RiskManager(logger);
    restoreRiskRecoveryFromCheckpoint(this.riskManager, logger);
    this.pnlEngine = new PnLEngine(logger, {
      inventoryValuationProvider: () => this.buildOpenInventoryValuationSummary()
    });
    this.positionManager.setRiskState(this.riskManager.getState());
    this.positionManager.setRiskSnapshot(this.riskManager.getSnapshot());
    this.alertDispatcher = createConfiguredAlertDispatcher(logger);
    this.monitoringService = new MonitoringService({
      executionEngine: this.executionEngine,
      pnlEngine: this.pnlEngine,
      riskManager: this.riskManager,
      inventoryTracker: this.inventoryTracker,
      logger,
      runtime: "integrated"
    });
    this.inventorySnapshotService = new InventorySnapshotService({
      tracker: this.inventoryTracker,
      logger,
      runtime: "integrated"
    });
    this.runtimeCheckpointService = new RuntimeCheckpointService({
      executionEngine: this.executionEngine,
      pnlEngine: this.pnlEngine,
      riskManager: this.riskManager,
      inventoryTracker: this.inventoryTracker,
      logger,
      runtime: "integrated"
    });
    this.paperTradingSessionService =
      config.mode === "dry-run"
        ? new PaperTradingSessionService({
            logger,
            runtime: "integrated"
          })
        : undefined;
    this.realizedTradingSessionService =
      config.mode === "live"
        ? new RealizedTradingSessionService({
            logger,
            pnlEngine: this.pnlEngine,
            runtime: "integrated"
          })
        : undefined;
    let marketMakerBot: MarketMakerBot | undefined;
    let sameMarketArbBot: Polybot1 | undefined;
    let negativeRiskBot: NegativeRiskBot | undefined;

    if (config.integrated.enableMarketMaker) {
      marketMakerBot = new MarketMakerBot(
        readonlyClient,
        logger,
        tradingClient,
        marketMakerUserTracker,
        makerAddress,
        {
          executionEngine: this.executionEngine,
          positionManager: this.positionManager,
          riskManager: this.riskManager,
          pnlEngine: this.pnlEngine,
          inventoryTracker: this.inventoryTracker
        }
      );
      this.monitoringService.setCompetitionSummaryProvider(
        () => marketMakerBot!.getCompetitionSummaryForLog()
      );
      this.components.push(
        marketMakerBot
      );
      this.markPriceProviders.push(marketMakerBot);
      this.mmBot = marketMakerBot;
    }

    if (config.integrated.enableSameMarketArb) {
      sameMarketArbBot = new Polybot1(
        readonlyClient,
        logger,
        tradingClient,
        sameMarketArbUserTracker,
          {
            executionEngine: this.executionEngine,
            positionManager: this.positionManager,
            riskManager: this.riskManager,
            pnlEngine: this.pnlEngine,
            inventoryTracker: this.inventoryTracker,
            paperTradingSessionService: this.paperTradingSessionService,
            alertDispatcher: this.alertDispatcher,
            preemptConditionOrders: async (conditionId, incomingStrategy, incomingPriority) => {
            if (!marketMakerBot) {
              return;
            }

            await marketMakerBot.cancelQuotesForCondition(
              conditionId,
              `${incomingStrategy} preemption at priority ${incomingPriority}`
            );
          }
        }
      );
      this.components.push(sameMarketArbBot);
      this.markPriceProviders.push(sameMarketArbBot);
    }

    if (config.integrated.enableNegativeRisk) {
      negativeRiskBot = new NegativeRiskBot(
        readonlyClient,
        logger,
        tradingClient,
        negativeRiskUserTracker,
        makerAddress,
          {
            executionEngine: this.executionEngine,
            positionManager: this.positionManager,
            riskManager: this.riskManager,
            pnlEngine: this.pnlEngine,
            inventoryTracker: this.inventoryTracker,
            paperTradingSessionService: this.paperTradingSessionService,
            alertDispatcher: this.alertDispatcher,
            preemptConditionOrders: async (conditionIds, incomingStrategy, incomingPriority) => {
            if (!marketMakerBot) {
              return;
            }

            for (const conditionId of conditionIds) {
              await marketMakerBot.cancelQuotesForCondition(
                conditionId,
                `${incomingStrategy} preemption at priority ${incomingPriority}`
              );
            }
          }
        }
      );
      this.components.push(negativeRiskBot);
      this.markPriceProviders.push(negativeRiskBot);
    }

    this.riskManager.subscribe((snapshot) => {
      this.positionManager.setRiskSnapshot(snapshot);
      this.positionManager.setRiskState(snapshot.state);
      this.paperTradingSessionService?.noteRiskSnapshot(snapshot);
      this.realizedTradingSessionService?.noteRiskSnapshot(snapshot);
      void this.alertDispatcher.dispatch(
        buildRiskStateAlert({
          runtime: "integrated",
          snapshot
        })
      );

      if (snapshot.state === "HALTED") {
        void this.handleRiskHalt(snapshot, marketMakerBot, sameMarketArbBot, negativeRiskBot);
        return;
      }

      if (snapshot.state === "DEGRADED") {
        void this.handleRiskDegraded(snapshot, marketMakerBot);
        return;
      }

      if (snapshot.state === "RECOVERY") {
        void this.handleRiskRecovery(snapshot, marketMakerBot);
        return;
      }

      if (snapshot.state === "WARNING") {
        this.logger.warn(
          { risk: snapshot },
          "Integrated trading system entered warning state. Throttle applied, monitoring closely."
        );
      }
    });

    if (this.paperTradingSessionService) {
      this.runtimeCheckpointService.subscribe((snapshot) => {
        this.paperTradingSessionService?.noteCheckpointSnapshot(snapshot);
      });
    }

    this.runtimeCheckpointService.subscribe((snapshot) => {
      void this.maybeDispatchOperatorStatusAlert(snapshot);
    });
  }

  async start(): Promise<void> {
    if (this.components.length === 0) {
      throw new Error(
        "Integrated mode is enabled but no strategy components were turned on. Check POLYBOT_INTEGRATED_ENABLE_*."
      );
    }

    // Mark startup time for uptime calculation in operator-status alerts.
    this.startupAtMs = Date.now();

    // Send immediate "bot starting" alert so operators know the bot is alive.
    // The full operator-status alert follows 30s~2min later once market universe
    // refresh, WebSocket connect, and balance capture complete.
    void this.alertDispatcher.dispatch({
      schemaVersion: 1,
      category: "bot_lifecycle",
      severity: "info",
      title: "🟢 봇 시작 중",
      summary: "Polybot이 시장 스캔과 WebSocket 연결을 초기화하고 있습니다. 첫 운영 현황 알림이 1~2분 내 도착합니다.",
      occurredAtMs: this.startupAtMs,
      runtime: "integrated",
      tags: ["lifecycle", "starting"]
    });

    // Capture startup capital BEFORE starting components so the first operator-status
    // alert uses the real account balance instead of the config fallback.
    if (typeof config.startupCapitalOverrideUsdc === "number") {
      this.startupCapitalUsdc = config.startupCapitalOverrideUsdc;
      // Wallet balance 도 함께 fetch 해서 첫 5분 알림 전부터 cashBalance 표시 가능하게.
      let liveCashBalanceUsdc: number | undefined;
      if (this.tradingClient) {
        try {
          const collateral = await this.tradingClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL
          });
          liveCashBalanceUsdc = rawUsdcToDecimal(collateral.balance);
        } catch (error) {
          this.logger.debug({ err: error }, "Live cash balance fetch failed under env override; alerts will populate on next cycle.");
        }
      }
      this.logger.info(
        {
          startupCapitalUsdc: this.startupCapitalUsdc,
          currentCashBalanceUsdc: liveCashBalanceUsdc,
          source: "env-override"
        },
        "Using POLYBOT_STARTUP_CAPITAL_USDC_OVERRIDE for startup capital; live cash balance also captured."
      );
    } else if (this.tradingClient) {
      try {
        const collateral = await this.tradingClient.getBalanceAllowance({
          asset_type: AssetType.COLLATERAL
        });
        this.startupCapitalUsdc = rawUsdcToDecimal(collateral.balance);
        this.logger.info(
          { startupCapitalUsdc: this.startupCapitalUsdc, source: "live-balance" },
          "Captured startup capital from live balance."
        );
      } catch (error) {
        this.logger.warn({ err: error }, "Could not read startup balance; falling back to config.");
      }
    }

    for (const component of this.components) {
      await component.start();
    }

    this.monitoringService.start();
    this.inventorySnapshotService.start();
    this.runtimeCheckpointService.start();
    this.paperTradingSessionService?.start();
    this.realizedTradingSessionService?.start();

    this.logger.info(
      {
        integrated: config.integrated,
        activeComponents: this.components.map((component) => component.constructor.name)
      },
      "Integrated trading system started."
    );
  }

  async stop(): Promise<void> {
    this.monitoringService.stop();

    for (const component of [...this.components].reverse()) {
      const stopResult = component.stop();
      if (stopResult && typeof (stopResult as Promise<void>).then === "function") {
        await stopResult;
      }
    }

    this.inventorySnapshotService.stop();
    this.runtimeCheckpointService.stop();
    this.paperTradingSessionService?.stop();
    this.realizedTradingSessionService?.stop();

    // Await shutdown alert so the Telegram webhook completes before process exit.
    try {
      await this.alertDispatcher.dispatch({
        schemaVersion: 1,
        category: "bot_lifecycle",
        severity: "info",
        title: "🔴 봇 종료",
        summary: "Polybot이 종료되었습니다. 모든 주문이 취소되고 서비스가 중단되었습니다.",
        occurredAtMs: Date.now(),
        runtime: "integrated",
        tags: ["lifecycle", "stopped"]
      });
    } catch (err) {
      this.logger.warn({ err }, "Shutdown alert dispatch failed.");
    }
  }

  private async handleRiskHalt(
    snapshot: RiskStatusSnapshot,
    marketMakerBot?: MarketMakerBot,
    sameMarketArbBot?: Polybot1,
    negativeRiskBot?: NegativeRiskBot
  ): Promise<void> {
    if (this.haltInProgress) {
      return;
    }

    this.haltInProgress = true;
    this.monitoringService.stop();
    this.logger.error(
      {
        risk: snapshot
      },
      "Integrated trading system is stopping because the risk manager halted trading."
    );

    try {
      if (marketMakerBot) {
        await marketMakerBot.cancelAllQuotes(
          `risk halt: ${snapshot.haltReason ?? "unspecified"}`
        );
      }

      if (config.risk.enableMmInventoryReductionOnHalt) {
        await this.runRiskReductionPasses(
          [marketMakerBot, sameMarketArbBot, negativeRiskBot],
          `risk halt inventory reduction: ${snapshot.haltReason ?? "unspecified"}`
        );
      }
    } finally {
      this.stop();
    }
  }

  private async handleRiskDegraded(
    snapshot: RiskStatusSnapshot,
    marketMakerBot?: MarketMakerBot
  ): Promise<void> {
    if (!marketMakerBot || !config.risk.cancelMmBuyQuotesOnDegraded) {
      return;
    }

    this.logger.warn(
      {
        risk: snapshot
      },
      "Integrated trading system entered degraded mode. Cancelling market-making BUY quotes."
    );
    await marketMakerBot.cancelBuyQuotes(
      `risk degraded: ${snapshot.haltReason ?? snapshot.haltDetail ?? "threshold warning"}`
    );
  }

  private async handleRiskRecovery(
    snapshot: RiskStatusSnapshot,
    marketMakerBot?: MarketMakerBot
  ): Promise<void> {
    this.logger.warn(
      { risk: snapshot },
      "Integrated trading system entered recovery mode. New BUY intents blocked during cooldown."
    );

    // Cancel existing MM BUY quotes during recovery (same as degraded policy)
    if (marketMakerBot && config.risk.cancelMmBuyQuotesOnDegraded) {
      await marketMakerBot.cancelBuyQuotes(
        `risk recovery: cooldown after degraded episode`
      );
    }
  }

  private async runRiskReductionPasses(
    bots: Array<RiskReducingBot | undefined>,
    reason: string
  ): Promise<void> {
    const seenTokenIds = new Set<string>();

    for (const bot of bots) {
      if (!bot) {
        continue;
      }

      const candidates = bot.getRiskReductionCandidates().filter((candidate) => {
        if (seenTokenIds.has(candidate.tokenId)) {
          return false;
        }

        seenTokenIds.add(candidate.tokenId);
        return true;
      });

      if (candidates.length === 0) {
        continue;
      }

      try {
        await bot.reduceInventoryRiskCandidates(candidates, reason);
      } catch (error) {
        this.riskManager.noteOrderFailure?.(
          "integrated.risk-reduction",
          error instanceof Error ? error.message : String(error)
        );
        this.logger.error(
          {
            err: error,
            reason,
            candidateCount: candidates.length,
            reducer: bot.constructor.name
          },
          "Integrated risk reduction pass failed for one strategy reducer."
        );
      }
    }
  }

  private async maybeDispatchOperatorStatusAlert(
    snapshot: import("./core/runtime-checkpoint-service.js").RuntimeCheckpointSummary
  ): Promise<void> {
    if (
      !this.alertDispatcher.hasSinks() ||
      config.alerting.operatorStatusAlertIntervalMs <= 0
    ) {
      return;
    }

    const portfolioSnapshot = this.pnlEngine.getPortfolioSnapshot();
    const marketMakingSnapshot = this.pnlEngine.getStrategySnapshot("market-making");
    const sameMarketArbSnapshot = this.pnlEngine.getStrategySnapshot("same-market-arb");
    const operatorStatusFingerprint = JSON.stringify({
      riskState: snapshot.riskState,
      openLotCount: snapshot.openLotCount,
      openShares: Number(snapshot.openShares.toFixed(5)),
      openCostUsdc: Number(snapshot.openCostUsdc.toFixed(8)),
      dailyTradeCount: portfolioSnapshot.dailyTradeCount,
      dailyRealizedPnlUsdc: Number(portfolioSnapshot.dailyRealizedPnlUsdc.toFixed(8))
    });
    const hasMaterialChange = operatorStatusFingerprint !== this.lastOperatorStatusFingerprint;

    if (
      !hasMaterialChange &&
      snapshot.generatedAtMs - this.lastOperatorStatusAlertAtMs <
        config.alerting.operatorStatusAlertIntervalMs
    ) {
      return;
    }

    this.lastOperatorStatusAlertAtMs = snapshot.generatedAtMs;
    this.lastOperatorStatusFingerprint = operatorStatusFingerprint;

    let cashBalanceUsdc: number | undefined;
    let cashAllowanceUsdc: number | undefined;
    let cashBalanceMayBeStale = false;
    const totalNetPnlUsdc =
      portfolioSnapshot.lifetimeNetPnlUsdc ?? portfolioSnapshot.lifetimeRealizedPnlUsdc;
    const inventoryValuation = this.buildOpenInventoryValuationSummary();

    // Read cash balance in both live and dry-run modes so operator status
    // reports always show the real account balance. The tradingClient is
    // available whenever API credentials are configured, regardless of mode.
    if (this.tradingClient) {
      try {
        const collateral = await this.tradingClient.getBalanceAllowance({
          asset_type: AssetType.COLLATERAL
        });
        cashBalanceUsdc = rawUsdcToDecimal(collateral.balance);
        const allowanceRaw = readMaxAllowanceRaw(collateral);
        cashAllowanceUsdc = allowanceRaw !== undefined ? rawUsdcToDecimal(allowanceRaw) : undefined;
      } catch (error) {
        this.logger.debug({ err: error }, "Operator status alert could not refresh collateral balance.");
      }
    }

    if (typeof cashBalanceUsdc === "number") {
      const looksStale =
        typeof this.lastObservedCashBalanceUsdc === "number" &&
        portfolioSnapshot.lifetimeTradeCount > this.lastObservedCashTradeCount &&
        Math.abs(cashBalanceUsdc - this.lastObservedCashBalanceUsdc) <= Number.EPSILON;

      // 🔄 Stale-cache mitigation: when the API returns the exact same balance
      // despite trades having happened, the upstream gateway is almost certainly
      // serving a cached response. Wait briefly and retry once before giving
      // up — that single re-query usually clears the cache and avoids posting
      // the "$X.XX (cached)" disclaimer to the operator alert.
      if (looksStale && this.tradingClient) {
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 750));
          const refreshed = await this.tradingClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL
          });
          const refreshedCash = rawUsdcToDecimal(refreshed.balance);
          if (Math.abs(refreshedCash - cashBalanceUsdc) > Number.EPSILON) {
            cashBalanceUsdc = refreshedCash;
            const refreshedAllowanceRaw = readMaxAllowanceRaw(refreshed);
            cashAllowanceUsdc =
              refreshedAllowanceRaw !== undefined ? rawUsdcToDecimal(refreshedAllowanceRaw) : undefined;
            this.logger.debug(
              { cashBalanceUsdc, refreshedCash },
              "Operator status cash refreshed after stale-cache retry."
            );
          } else {
            cashBalanceMayBeStale = true;
            this.logger.debug(
              {
                cashBalanceUsdc,
                lifetimeTradeCount: portfolioSnapshot.lifetimeTradeCount,
                previousObservedCashBalanceUsdc: this.lastObservedCashBalanceUsdc,
                previousObservedCashTradeCount: this.lastObservedCashTradeCount
              },
              "Operator status cash snapshot still stale after refresh retry."
            );
          }
        } catch (error) {
          cashBalanceMayBeStale = true;
          this.logger.debug({ err: error }, "Stale-cache balance retry failed.");
        }
      }

      this.lastObservedCashBalanceUsdc = cashBalanceUsdc;
      this.lastObservedCashTradeCount = portfolioSnapshot.lifetimeTradeCount;
    }

    await this.alertDispatcher.dispatch(
      buildOperatorStatusAlert({
        runtime: "integrated",
        checkpoint: snapshot,
        cashBalanceUsdc,
        cashAllowanceUsdc,
        cashBalanceMayBeStale,
        initialCapitalUsdc: this.startupCapitalUsdc ?? config.alerting.initialCapitalUsdc,
        dailyRealizedPnlUsdc: portfolioSnapshot.dailyRealizedPnlUsdc,
        dailyTradeCount: portfolioSnapshot.dailyTradeCount,
        lifetimeRealizedPnlUsdc: portfolioSnapshot.lifetimeRealizedPnlUsdc,
        marketMakingDailyPnlUsdc: marketMakingSnapshot.dailyRealizedPnlUsdc,
        marketMakingLifetimePnlUsdc: marketMakingSnapshot.lifetimeRealizedPnlUsdc,
        marketMakingDailyWinCount: marketMakingSnapshot.dailyWinningTrades,
        marketMakingDailyLossCount: marketMakingSnapshot.dailyLosingTrades,
        marketMakingDailyFlatCount: marketMakingSnapshot.dailyFlatTrades,
        marketMakingLifetimeWinCount: marketMakingSnapshot.winningTrades,
        marketMakingLifetimeLossCount: marketMakingSnapshot.losingTrades,
        marketMakingLifetimeFlatCount: marketMakingSnapshot.flatTrades,
        ...(this.mmBot
          ? (() => {
              const m = this.mmBot!.getMarketMakingQualityMetrics();
              return {
                marketMakingSessionBuyFills: m.buyFillCount,
                marketMakingSessionSellFills: m.sellFillCount,
                marketMakingSessionBuyToSellRatio: m.buyToSellRatio,
                marketMakingSessionAverageHoldMs: m.averageHoldMs
              };
            })()
          : {}),
        sameMarketArbDailyPnlUsdc: sameMarketArbSnapshot.dailyRealizedPnlUsdc,
        sameMarketArbLifetimePnlUsdc: sameMarketArbSnapshot.lifetimeRealizedPnlUsdc,
        rewardIncomeUsdc: portfolioSnapshot.dailyRewardUsdc,
        rebateIncomeUsdc: portfolioSnapshot.dailyRebateUsdc,
        lifetimeRewardIncomeUsdc: portfolioSnapshot.lifetimeRewardUsdc,
        lifetimeRebateIncomeUsdc: portfolioSnapshot.lifetimeRebateUsdc,
        lifetimeTradeCount: portfolioSnapshot.lifetimeTradeCount,
        winningTradeCount: portfolioSnapshot.winningTrades,
        losingTradeCount: portfolioSnapshot.losingTrades,
        totalNetPnlUsdc,
        openPositionValueUsdc: inventoryValuation.openInventoryMarkValueUsdc,
        openUnrealizedPnlUsdc: inventoryValuation.openInventoryUnrealizedPnlUsdc,
        pricedOpenTokenCount: inventoryValuation.pricedOpenTokenCount,
        unpricedOpenTokenCount: inventoryValuation.unpricedOpenTokenCount,
        venueDriftTokenCount: inventoryValuation.venueDriftTokenCount,
        venueDriftAbsValueUsdc: inventoryValuation.venueDriftAbsValueUsdc,
        venueDriftSignedShares: inventoryValuation.venueDriftSignedShares,
        topInventoryPositions: this.buildTopInventoryPositions(3),
        operatorStartedAtMs: this.startupAtMs
      })
    );
  }

  private buildOpenInventoryValuationSummary() {
    return buildInventoryValuationSnapshot({
      inventoryTracker: this.inventoryTracker,
      getMarkPriceForToken: (tokenId) => this.getMarkPriceForToken(tokenId),
      // 🔄 Pass venue-known shares so the operator-status alert mirrors the
      // Polymarket site's portfolio view. Without this the alert reports the
      // local lot tracker's view, which can drift from venue after missed
      // user-ws fills, manual site interventions, or post-restart races.
      getKnownVenueShares: (tokenId) => this.getKnownVenueSharesAcrossBots(tokenId)
    });
  }

  // Aggregates getKnownVenueShares from every wired bot's quote executor. The
  // first defined value wins — they should all read from the same on-chain
  // collateral in practice, but we accept any non-undefined response.
  //
  // ⚠️ IMPORTANT: must call the method ON the provider (not via a detached
  // `const fn = provider.method; fn(...)` assignment), because detaching
  // would drop `this` binding and crash inside getKnownVenueShares when it
  // references `this.quoteExecutor`. Keep `.call(provider, tokenId)` or the
  // direct-access `provider.method?.(tokenId)` form below.
  private getKnownVenueSharesAcrossBots(tokenId: string): number | undefined {
    for (const provider of this.markPriceProviders) {
      const typedProvider = provider as {
        getKnownVenueShares?: (id: string) => number | undefined;
      };
      if (typeof typedProvider.getKnownVenueShares !== "function") continue;
      const value = typedProvider.getKnownVenueShares(tokenId);
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }

  private getMarkPriceForToken(tokenId: string): number | undefined {
    for (const provider of this.markPriceProviders) {
      const price = provider.getMarkPriceForToken?.(tokenId);

      if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
        return price;
      }
    }

    return undefined;
  }

  private buildTopInventoryPositions(limit: number) {
    const openLots = this.inventoryTracker.exportOpenLots();
    // Aggregate per tokenId: sum shares and cost, compute unrealized PnL from mark price.
    const byToken = new Map<string, { shares: number; costUsdc: number; markValueUsdc: number | undefined; market: string; outcome: string }>();

    for (const lot of openLots) {
      const existing = byToken.get(lot.tokenId);
      const markPrice = this.getMarkPriceForToken(lot.tokenId);
      const markValue = markPrice !== undefined ? lot.shares * markPrice : undefined;
      // Use conditionId as market identifier (slug not available on lots).
      const market = lot.conditionId ?? lot.tokenId.slice(0, 12);
      const outcome = lot.tokenId.slice(0, 8);

      if (existing) {
        existing.shares += lot.shares;
        existing.costUsdc += lot.totalCostUsdc;
        if (markValue !== undefined) {
          existing.markValueUsdc = (existing.markValueUsdc ?? 0) + markValue;
        }
      } else {
        byToken.set(lot.tokenId, {
          shares: lot.shares,
          costUsdc: lot.totalCostUsdc,
          markValueUsdc: markValue,
          market,
          outcome
        });
      }
    }

    return [...byToken.values()]
      .sort((a, b) => b.costUsdc - a.costUsdc)
      .slice(0, limit)
      .map((pos) => ({
        market: pos.market,
        outcome: pos.outcome,
        shares: pos.shares,
        costUsdc: pos.costUsdc,
        unrealizedPnlUsdc: pos.markValueUsdc !== undefined ? pos.markValueUsdc - pos.costUsdc : undefined
      }));
  }
}
