import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AlertDispatcher, type AlertEvent } from "../src/core/alert-dispatcher.js";

describe("AlertDispatcher", () => {
  it("writes alerts to jsonl and applies min severity", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-alert-dispatcher-"));
    const alertsFile = path.join(tempDir, "alerts.jsonl");
    const fetchImpl = vi.fn();
    const dispatcher = new AlertDispatcher({
      alertsFile,
      minSeverity: "warning",
      fetchImpl
    });

    const infoAlert: AlertEvent = {
      schemaVersion: 1,
      category: "risk_state",
      severity: "info",
      title: "Informational alert",
      summary: "This should be filtered out.",
      occurredAtMs: 1
    };
    const criticalAlert: AlertEvent = {
      schemaVersion: 1,
      category: "risk_state",
      severity: "critical",
      title: "Critical alert",
      summary: "This should be persisted.",
      occurredAtMs: 2,
      runtime: "integrated",
      details: {
        haltReason: "daily_loss_limit_exceeded"
      }
    };

    await dispatcher.dispatch(infoAlert);
    await dispatcher.dispatch(criticalAlert);

    const lines = readFileSync(alertsFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AlertEvent);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.title).toBe("Critical alert");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts alert payloads to a configured webhook", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://alerts.example.com/polybot",
      minSeverity: "info",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "small_live_report",
      severity: "warning",
      title: "Small-live review",
      summary: "Session needs operator review.",
      occurredAtMs: 3,
      sessionName: "small-live-1"
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://alerts.example.com/polybot");
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      schemaVersion: 1,
      category: "small_live_report"
    });
  });

  it("formats slack webhook payloads with readable text blocks", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://hooks.slack.test/polybot",
      webhookFormat: "slack",
      minSeverity: "info",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "risk_state",
      severity: "critical",
      title: "Risk halted",
      summary: "Runtime entered HALTED state.",
      occurredAtMs: 10,
      runtime: "integrated",
      tags: ["risk", "halted"]
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      text: string;
      blocks: Array<{ text: { text: string } }>;
    };

    expect(payload.text).toContain("[CRITICAL] Risk halted");
    expect(payload.blocks[0]?.text.text).toContain("[CRITICAL] Risk halted");
    expect(payload.blocks.some((block) => block.text.text.includes("runtime: integrated"))).toBe(
      true
    );
  });

  it("formats discord webhook payloads with content and embeds", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://discord.test/api/webhooks/polybot",
      webhookFormat: "discord",
      minSeverity: "info",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "restart_drill_report",
      severity: "warning",
      title: "Restart drill warning",
      summary: "Recovered lots drifted slightly.",
      occurredAtMs: 20,
      sessionName: "restart-drill-1",
      details: {
        sharesDelta: -0.1
      }
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      content: string;
      embeds: Array<{
        title: string;
        description: string;
        fields: Array<{ name: string; value: string }>;
      }>;
    };

    expect(payload.content).toContain("[WARNING] Restart drill warning");
    expect(payload.embeds[0]?.title).toBe("Restart drill warning");
    expect(payload.embeds[0]?.fields.some((field) => field.value.includes("sharesDelta"))).toBe(
      true
    );
  });

  it("formats telegram operator-status payload as a Korean report card", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://api.telegram.org/bot123/sendMessage",
      webhookFormat: "telegram",
      minSeverity: "info",
      telegramChatId: "-1001234567890",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "operator_status",
      severity: "info",
      title: "운영 현황",
      summary: "risk=RUNNING · cash=$79.59 · openLots=2",
      occurredAtMs: 50,
      runtime: "integrated",
      details: {
        riskState: "RUNNING",
        cashBalanceUsdc: 79_590_000,
        cashBalanceMayBeStale: true,
        activeOrderCount: 2,
        activeConditionCount: 1,
        openLotCount: 2,
        openShares: 12,
        openCostUsdc: 5.16,
        openPositionValueUsdc: 5.4,
        openUnrealizedPnlUsdc: 0.24,
        pricedOpenTokenCount: 2,
        unpricedOpenTokenCount: 0,
        dailyRealizedPnlUsdc: 0,
        dailyTradeCount: 0,
        marketMakingDailyPnlUsdc: 0.14,
        sameMarketArbDailyPnlUsdc: -0.03,
        rewardIncomeUsdc: 0.08,
        rebateIncomeUsdc: 0.02,
        totalNetPnlUsdc: 1.34,
        initialCapitalUsdc: 100
      }
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      chat_id: string;
      text: string;
      parse_mode: string;
    };

    expect(payload.chat_id).toBe("-1001234567890");
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("폴리마켓 통합봇 리포트");
    expect(payload.text).toContain("현재 자산");
    expect(payload.text).toContain("초기 자본");
    expect(payload.text).toContain("총 수익");
    expect(payload.text).toContain("오늘 성과");
    expect(payload.text).toContain("오늘 수익 구조");
    expect(payload.text).toContain("누적 수익 구조");
    expect(payload.text).toContain("열린 포지션");
    expect(payload.text).toContain("보유 평가액");
    expect(payload.text).toContain("미실현 손익");
    expect(payload.text).toContain("봇 상태");
    expect(payload.text).not.toContain("activeOrderCount");
  });

  it("formats telegram order-fill payload as an operator-friendly trade card", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://api.telegram.org/bot123/sendMessage",
      webhookFormat: "telegram",
      minSeverity: "info",
      telegramChatId: "-1001234567890",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "order_fill",
      severity: "info",
      title: "SELL 체결",
      summary: "dummy",
      occurredAtMs: 60,
      runtime: "market-maker",
      tags: ["market-making", "sell", "maker-fill", "inventory-close"],
      details: {
        market: "hawks-vs-cavs",
        outcome: "Hawks",
        side: "SELL",
        shares: 12,
        price: 0.32,
        notionalUsdc: 3.84,
        averageCostUsdcPerShare: 0.30,
        currentPriceUsdc: 0.33,
        positionBeforeShares: 12,
        positionAfterShares: 0,
        realizedPnlUsdc: 0.24,
        unrealizedPnlUsdc: 0,
        totalNetPnlUsdc: 0.24,
        positionBiasPct: 0,
        reason: "profit_take",
        expectedPriceUsdc: 0.32,
        slippageUsdcPerShare: 0,
        quoteAgeMs: 80_000,
        quoteMaxRestingAgeMs: 90_000,
        orderType: "maker"
      }
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      text: string;
    };

    // SELL fills render as simplified close cards (market, buy/sell price, PnL, qty, strategy).
    expect(payload.text).toContain("수익 청산");
    expect(payload.text).toContain("매수");
    expect(payload.text).toContain("매도");
    expect(payload.text).toContain("손익");
    expect(payload.text).toContain("수량");
    expect(payload.text).toContain("80.0초");
    expect(payload.text).toContain("90.0초");
    expect(payload.text).not.toContain("realizedPnlUsdc");
  });

  it("labels losing telegram sell fills as loss closes", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://api.telegram.org/bot123/sendMessage",
      webhookFormat: "telegram",
      minSeverity: "info",
      telegramChatId: "-1001234567890",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "order_fill",
      severity: "info",
      title: "SELL 체결",
      summary: "dummy",
      occurredAtMs: 61,
      runtime: "market-maker",
      tags: ["market-making", "sell", "risk-reduction", "inventory-close"],
      details: {
        market: "btc-test",
        outcome: "Yes",
        side: "SELL",
        shares: 5,
        price: 0.53,
        notionalUsdc: 2.65,
        averageCostUsdcPerShare: 0.55,
        positionBeforeShares: 10,
        positionAfterShares: 5,
        realizedPnlUsdc: -0.1,
        reason: "inventory_reduce"
      }
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      text: string;
    };

    expect(payload.text).toContain("손실 청산");
    expect(payload.text).toContain("$-0.10");
    expect(payload.text).not.toContain("본전 청산");
  });

  it("formats telegram quote-posted payload as an operator-friendly order card", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://api.telegram.org/bot123/sendMessage",
      webhookFormat: "telegram",
      minSeverity: "info",
      telegramChatId: "-1001234567890",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "quote_posted",
      severity: "info",
      title: "BUY 주문 게시",
      summary: "dummy",
      occurredAtMs: 65,
      runtime: "market-maker",
      tags: ["market-making", "quote-posted", "buy", "maker-quote"],
      details: {
        market: "hawks-vs-cavs",
        outcome: "Hawks",
        side: "BUY",
        size: 12,
        price: 0.31,
        quoteSlot: "primary",
        orderType: "GTC",
        executionStyle: "passive-maker",
        postOnly: true,
        maxRestingAgeMs: 90_000
      }
    });

    const payload = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      text: string;
    };

    expect(payload.text).toContain("매수 주문 게시");
    expect(payload.text).toContain("주문 유형");
    expect(payload.text).toContain("주문 성격");
    expect(payload.text).toContain("메이커 대기 주문");
    expect(payload.text).toContain("90.0초");
    expect(payload.text).not.toContain("executionStyle");
  });

  it("routes warning alerts to incident file even when alert threshold is higher", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "polybot-alert-incidents-"));
    const incidentsFile = path.join(tempDir, "incidents.jsonl");
    const fetchImpl = vi.fn();
    const dispatcher = new AlertDispatcher({
      incidentsFile,
      minSeverity: "critical",
      incidentMinSeverity: "warning",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "risk_state",
      severity: "warning",
      title: "Risk degraded",
      summary: "Runtime entered DEGRADED state.",
      occurredAtMs: 30
    });

    const lines = readFileSync(incidentsFile, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AlertEvent);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.severity).toBe("warning");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes alerts to general and severity-specific webhooks without duplication", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => ""
    }));
    const dispatcher = new AlertDispatcher({
      webhookUrl: "https://alerts.example.com/general",
      warningWebhookUrl: "https://alerts.example.com/warning",
      criticalWebhookUrl: "https://alerts.example.com/critical",
      minSeverity: "warning",
      fetchImpl
    });

    await dispatcher.dispatch({
      schemaVersion: 1,
      category: "small_live_report",
      severity: "warning",
      title: "Small-live review",
      summary: "Session needs operator review.",
      occurredAtMs: 40
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://alerts.example.com/general",
      "https://alerts.example.com/warning"
    ]);
  });
});
