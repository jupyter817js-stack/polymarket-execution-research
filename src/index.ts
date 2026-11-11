import { config } from "./config.js";
import { IntegratedBot } from "./integrated-bot.js";
import { logger, logFilePath } from "./logger.js";
import { MarketMakerBot } from "./market-maker-bot.js";
import { UserWsTracker } from "./polymarket/user-ws.js";
import { Polybot1 } from "./bot.js";
import { createConfiguredAlertDispatcher } from "./core/alert-dispatcher.js";
import { createClients } from "./trading/clob-client.js";

const main = async (): Promise<void> => {
  const { client, readonlyClient, creds, makerAddress } = await createClients(logger);
  const createUserTracker = (): UserWsTracker | undefined =>
    config.mode === "live" && creds
      ? new UserWsTracker(
          {
            apiKey: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase
          },
          logger
        )
      : undefined;

  const userTracker = createUserTracker();
  const bot =
    config.strategyMode === "integrated"
      ? new IntegratedBot(
          readonlyClient,
          logger,
          client,
          createUserTracker(),
          config.integrated.enableSameMarketArb ? createUserTracker() : undefined,
          config.integrated.enableNegativeRisk ? createUserTracker() : undefined,
          makerAddress
        )
      : config.strategyMode === "market-maker"
        ? new MarketMakerBot(readonlyClient, logger, client, userTracker, makerAddress)
        : new Polybot1(readonlyClient, logger, client, userTracker, {
            alertDispatcher: createConfiguredAlertDispatcher(logger)
          });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down bot.");
    try {
      const stopResult = bot.stop();
      if (stopResult && typeof (stopResult as Promise<void>).then === "function") {
        await stopResult;
      }
    } catch (err) {
      logger.error({ err }, "Error during bot shutdown.");
    }
    // Grace period for any in-flight webhook requests (Telegram etc.) to complete.
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  logger.info(
    {
      logFilePath,
      mode: config.mode,
      strategyMode: config.strategyMode,
      minMarketLiquidity: config.marketUniverse.minMarketLiquidity,
      marketScanCap: config.marketUniverse.scanCap,
      marketSelectionStickinessBoost: config.marketUniverse.selectionStickinessBoost,
      targetShares: config.strategy.targetShares,
      targetOrderNotionalUsdc: config.strategy.targetOrderNotionalUsdc,
      maxEntryGrossCostPerShare: config.strategy.maxEntryGrossCostPerShare,
      minNetEdgeUsdc: config.strategy.minNetEdgeUsdc,
      minNetEdgeBps: config.strategy.minNetEdgeBps,
      emergencySellEnabled: config.execution.enableEmergencySell,
      marketMakerQuoteSize: config.marketMaker.quoteSize,
      marketMakerOrderType: config.marketMaker.orderType,
      maxCategoryExposureUsdc: config.marketMaker.maxCategoryExposureUsdc,
      capital: config.capital,
      rebateBiasEnabled: config.marketMaker.enableRebateBias,
      rewardScoringRefreshMs: config.rewards.scoringRefreshMs,
      rebateTradesRefreshMs: config.rebates.tradesRefreshMs,
      rebateSummaryRefreshMs: config.rebates.summaryRefreshMs,
      inventorySeedFile: config.inventory.initialLotsFile,
      inventorySeedJsonConfigured: Boolean(config.inventory.initialLotsJson),
      inventorySnapshotFile: config.inventory.snapshotFile,
      inventorySnapshotIntervalMs: config.inventory.snapshotIntervalMs,
      runtimeCheckpointFile: config.checkpoint.file,
      runtimeCheckpointIntervalMs: config.checkpoint.intervalMs,
      chainRpcConfigured: Boolean(config.chainRpcUrl),
      relayerConfigured: Boolean(config.relayerUrl),
      builderAuthConfigured: Boolean(config.builderAuth),
      paperReportFile: config.paper.reportFile,
      paperReportIntervalMs: config.paper.reportIntervalMs,
      realizedReportFile: config.realized.reportFile,
      realizedReportIntervalMs: config.realized.reportIntervalMs,
      alertsFile: config.alerting.alertsFile,
      incidentsFile: config.alerting.incidentsFile,
      alertWebhookConfigured: Boolean(config.alerting.webhookUrl),
      alertInfoWebhookConfigured: Boolean(config.alerting.infoWebhookUrl),
      alertWarningWebhookConfigured: Boolean(config.alerting.warningWebhookUrl),
      alertCriticalWebhookConfigured: Boolean(config.alerting.criticalWebhookUrl),
      alertMinSeverity: config.alerting.minSeverity,
      incidentMinSeverity: config.alerting.incidentMinSeverity,
      alertWebhookFormat: config.alerting.webhookFormat,
      negativeRiskLiveConversionBridgeEnabled: config.negativeRisk.enableLiveConversionBridge,
      negativeRiskAutoApproveAdapter: config.negativeRisk.autoApproveAdapter,
      negativeRisk: config.negativeRisk,
      integrated: config.integrated
    },
    "Starting Polybot."
  );

  if (
    config.mode === "live" &&
    config.strategyMode === "same-market-arb" &&
    !config.execution.enableEmergencySell
  ) {
    logger.warn(
      "Live mode is running with emergency sell disabled. A one-leg fill can remain as an open directional position."
    );
  }

  await bot.start();
};

main().catch((error) => {
  logger.error({ err: error }, "Fatal startup error.");
  process.exit(1);
});
