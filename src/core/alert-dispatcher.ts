import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { config } from "../config.js";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertWebhookFormat = "json" | "slack" | "discord" | "telegram";

export type AlertEvent = {
  schemaVersion: 1;
  category: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  occurredAtMs: number;
  runtime?: string;
  sessionName?: string;
  tags?: string[];
  details?: Record<string, unknown>;
};

type WebhookResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
};

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<WebhookResponse>;

type AlertDispatcherOptions = {
  logger?: Logger;
  alertsFile?: string;
  incidentsFile?: string;
  webhookUrl?: string;
  infoWebhookUrl?: string;
  warningWebhookUrl?: string;
  criticalWebhookUrl?: string;
  telegramChatId?: string;
  minSeverity?: AlertSeverity;
  incidentMinSeverity?: AlertSeverity;
  webhookFormat?: AlertWebhookFormat;
  webhookTimeoutMs?: number;
  fetchImpl?: FetchLike;
};

const severityRank: Record<AlertSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3
};

export class AlertDispatcher {
  private readonly alertsFile?: string;
  private readonly incidentsFile?: string;
  private readonly webhookUrl?: string;
  private readonly infoWebhookUrl?: string;
  private readonly warningWebhookUrl?: string;
  private readonly criticalWebhookUrl?: string;
  private readonly telegramChatId?: string;
  private readonly minSeverity: AlertSeverity;
  private readonly incidentMinSeverity: AlertSeverity;
  private readonly webhookFormat: AlertWebhookFormat;
  private readonly webhookTimeoutMs: number;
  private readonly fetchImpl?: FetchLike;

  constructor(private readonly options: AlertDispatcherOptions = {}) {
    this.alertsFile = options.alertsFile;
    this.incidentsFile = options.incidentsFile;
    this.webhookUrl = options.webhookUrl;
    this.infoWebhookUrl = options.infoWebhookUrl;
    this.warningWebhookUrl = options.warningWebhookUrl;
    this.criticalWebhookUrl = options.criticalWebhookUrl;
    this.telegramChatId = options.telegramChatId;
    this.minSeverity = options.minSeverity ?? "warning";
    this.incidentMinSeverity = options.incidentMinSeverity ?? "warning";
    this.webhookFormat = options.webhookFormat ?? "json";
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? 5_000;
    this.fetchImpl =
      options.fetchImpl ?? ((globalThis.fetch as unknown as FetchLike | undefined) ?? undefined);
  }

  hasSinks(): boolean {
    return Boolean(
      this.alertsFile ||
        this.incidentsFile ||
        this.webhookUrl ||
        this.infoWebhookUrl ||
        this.warningWebhookUrl ||
        this.criticalWebhookUrl
    );
  }

  async dispatch(event: AlertEvent): Promise<void> {
    if (!this.hasSinks()) {
      return;
    }

    const shouldAlert = this.shouldDispatchSeverity(event.severity);
    const shouldIncident = this.incidentsFile
      ? this.shouldDispatchIncidentSeverity(event.severity)
      : false;

    if (this.alertsFile && shouldAlert) {
      this.appendToFile(event);
    }

    if (this.incidentsFile && shouldIncident) {
      this.appendToIncidentFile(event);
    }

    if (shouldAlert) {
      const webhookTargets = this.getWebhookTargets(event.severity);
      for (const webhookUrl of webhookTargets) {
        await this.postWebhook(webhookUrl, event);
      }
    }
  }

  private shouldDispatchSeverity(severity: AlertSeverity): boolean {
    return severityRank[severity] >= severityRank[this.minSeverity];
  }

  private shouldDispatchIncidentSeverity(severity: AlertSeverity): boolean {
    return severityRank[severity] >= severityRank[this.incidentMinSeverity];
  }

  private appendToFile(event: AlertEvent): void {
    const alertsFile = path.resolve(process.cwd(), this.alertsFile!);
    mkdirSync(path.dirname(alertsFile), { recursive: true });
    appendFileSync(alertsFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  private appendToIncidentFile(event: AlertEvent): void {
    const incidentsFile = path.resolve(process.cwd(), this.incidentsFile!);
    mkdirSync(path.dirname(incidentsFile), { recursive: true });
    appendFileSync(incidentsFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  private getWebhookTargets(severity: AlertSeverity): string[] {
    const targets = new Set<string>();

    if (this.webhookUrl) {
      targets.add(this.webhookUrl);
    }

    if (severity === "info" && this.infoWebhookUrl) {
      targets.add(this.infoWebhookUrl);
    }

    if (severity === "warning" && this.warningWebhookUrl) {
      targets.add(this.warningWebhookUrl);
    }

    if (severity === "critical" && this.criticalWebhookUrl) {
      targets.add(this.criticalWebhookUrl);
    }

    return [...targets];
  }

  private async postWebhook(webhookUrl: string, event: AlertEvent): Promise<void> {
    if (!this.fetchImpl) {
      this.options.logger?.warn(
        {
          category: event.category,
          severity: event.severity
        },
        "Alert webhook was configured but no fetch implementation is available."
      );
      return;
    }

    if (this.webhookFormat === "telegram" && !this.telegramChatId) {
      this.options.logger?.warn(
        {
          category: event.category,
          severity: event.severity
        },
        "Telegram webhook format was selected but POLYBOT_ALERT_TELEGRAM_CHAT_ID is missing."
      );
      return;
    }

    const payload = buildWebhookPayload(event, this.webhookFormat, this.telegramChatId);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.webhookTimeoutMs);

    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        this.options.logger?.warn(
          {
            category: event.category,
            severity: event.severity,
            status: response.status,
            statusText: response.statusText,
            responseBody
          },
          "Alert webhook returned a non-success response."
        );
      }
    } catch (error) {
      this.options.logger?.warn(
        {
          err: error,
          category: event.category,
          severity: event.severity
        },
        "Alert webhook delivery failed."
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createConfiguredAlertDispatcher = (logger?: Logger): AlertDispatcher =>
  new AlertDispatcher({
    logger,
    alertsFile: config.alerting.alertsFile,
    incidentsFile: config.alerting.incidentsFile,
    webhookUrl: config.alerting.webhookUrl,
    infoWebhookUrl: config.alerting.infoWebhookUrl,
    warningWebhookUrl: config.alerting.warningWebhookUrl,
    criticalWebhookUrl: config.alerting.criticalWebhookUrl,
    telegramChatId: config.alerting.telegramChatId,
    minSeverity: config.alerting.minSeverity,
    incidentMinSeverity: config.alerting.incidentMinSeverity,
    webhookFormat: config.alerting.webhookFormat,
    webhookTimeoutMs: config.alerting.webhookTimeoutMs
  });

const severityEmoji: Record<AlertSeverity, string> = {
  info: "INFO",
  warning: "WARNING",
  critical: "CRITICAL"
};

const severityIcon: Record<AlertSeverity, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🛑"
};

const escapeTelegramHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const formatDetails = (details: Record<string, unknown> | undefined): string[] => {
  if (!details) {
    return [];
  }

  return Object.entries(details).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
};

const buildPlainLines = (event: AlertEvent): string[] => [
  `[${severityEmoji[event.severity]}] ${event.title}`,
  event.summary,
  ...(event.runtime ? [`runtime: ${event.runtime}`] : []),
  ...(event.sessionName ? [`session: ${event.sessionName}`] : []),
  ...(event.tags && event.tags.length > 0 ? [`tags: ${event.tags.join(", ")}`] : []),
  ...formatDetails(event.details)
];

const normalizeDisplayUsdc = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  if (Number.isInteger(value) && Math.abs(value) >= 100_000) {
    return value / 1_000_000;
  }

  return value;
};

const formatMoney = (value: number | undefined, digits = 2): string =>
  typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(digits)}` : "-";

const formatSignedMoney = (value: number | undefined, digits = 2): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  const prefix = value > 0 ? "+" : "";
  return `${prefix}$${value.toFixed(digits)}`;
};

const formatShares = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(value % 1 === 0 ? 0 : 2)}주` : "-";

// Formats a millisecond duration as "Xm Ys" or "Xh Ym" depending on magnitude.
const formatHoldDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}초`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}분 ${sec}초` : `${min}분`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}시간 ${remMin}분` : `${hr}시간`;
};

const formatPrice = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  return `${value.toFixed(3)} USDC (${(value * 100).toFixed(1)}¢)`;
};

const formatRetrySeconds = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const seconds = Math.round(value / 1000);
  return `${seconds}초 뒤`;
};

const formatPercent = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return `${value.toFixed(1)}%`;
};

const formatReasonLabel = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  const labels: Record<string, string> = {
    spread_capture: "스프레드 수익 진입",
    arbitrage_signal: "차익 신호 진입",
    profit_take: "이익 실현",
    inventory_reduce: "재고 축소",
    inventory_close: "재고 정리",
    time_exit: "시간 초과 정리",
    spread_collapse: "스프레드 붕괴 정리"
  };

  return labels[value] ?? value;
};

const formatStrategyKorean = (value: unknown): string => {
  if (typeof value !== "string") return "-";
  const names: Record<string, string> = {
    "market-making": "마켓메이킹 스프레드 수익",
    "liquidity-rewards": "유동성 리워드",
    "maker-rebates": "메이커 리베이트",
    "same-market-arb": "동일 시장 차익거래",
    "negative-risk": "네거티브 리스크",
    "risk-reduction": "리스크 축소 매도"
  };
  return names[value] ?? value;
};

type TelegramMetric = {
  icon: string;
  label: string;
  value: string;
  emphasizeValue?: boolean;
};

const TELEGRAM_DIVIDER = "<code>────────────────────────</code>";

const formatTelegramMetric = (metric: TelegramMetric): string => {
  const escapedLabel = escapeTelegramHtml(metric.label);
  const escapedValue = escapeTelegramHtml(metric.value);
  const value = metric.emphasizeValue ? `<b>${escapedValue}</b>` : escapedValue;
  return `${metric.icon} <b>${escapedLabel}</b> ${value}`;
};

const formatTelegramMetricPair = (left: TelegramMetric, right?: TelegramMetric): string =>
  right
    ? `${formatTelegramMetric(left)}  <code>│</code>  ${formatTelegramMetric(right)}`
    : formatTelegramMetric(left);

const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formatTelegramAgeSeconds = (valueMs: unknown): string | undefined => {
  const value = toFiniteNumber(valueMs);
  if (value === undefined || value < 0) {
    return undefined;
  }

  const seconds = value / 1_000;
  return `${seconds.toFixed(seconds >= 100 ? 0 : 1)}초`;
};

const pnlIcon = (value: number | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) {
    return "🟡";
  }

  return value > 0 ? "🟢" : "🔴";
};

const renderTelegramOrderFill = (event: AlertEvent): string => {
  const details = event.details ?? {};
  const side = details.side === "SELL" ? "SELL" : "BUY";

  // SELL → 포지션 정리 포맷
  if (side === "SELL") {
    const realizedPnlUsdc = toFiniteNumber(details.realizedPnlUsdc);
    const averageCostUsdcPerShare = toFiniteNumber(details.averageCostUsdcPerShare);
    const price = toFiniteNumber(details.price);
    const shares = details.shares;
    const pnlIcon_ = pnlIcon(realizedPnlUsdc);
    const titleIcon =
      realizedPnlUsdc === undefined
        ? "🟠"
        : realizedPnlUsdc > 0
          ? "🟢"
          : realizedPnlUsdc < 0
            ? "🔴"
            : "🟡";
    const titleLabel =
      realizedPnlUsdc === undefined
        ? "포지션 정리"
        : realizedPnlUsdc > 0
          ? "수익 청산"
          : realizedPnlUsdc < 0
            ? "손실 청산"
            : "본전 청산";

    const reasonLabel = formatReasonLabel(details.reason);
    const expectedPriceUsdc = toFiniteNumber(details.expectedPriceUsdc);
    const slippageUsdcPerShare = toFiniteNumber(details.slippageUsdcPerShare);
    const quoteAge = formatTelegramAgeSeconds(details.quoteAgeMs);
    const quoteMaxAge = formatTelegramAgeSeconds(details.quoteMaxRestingAgeMs);

    const lines: Array<string | undefined> = [
      `<b>${titleIcon} ${titleLabel}</b>`,
      TELEGRAM_DIVIDER,
      `🏟 <b>${escapeTelegramHtml(String(details.market ?? "-"))}</b>  결과: <b>${escapeTelegramHtml(String(details.outcome ?? "-"))}</b>`,
      averageCostUsdcPerShare !== undefined
        ? formatTelegramMetric({ icon: "📊", label: "매수", value: formatPrice(averageCostUsdcPerShare) })
        : undefined,
      formatTelegramMetric({ icon: "💰", label: "매도", value: formatPrice(price), emphasizeValue: true }),
      formatTelegramMetric({ icon: pnlIcon_, label: "손익", value: formatSignedMoney(realizedPnlUsdc), emphasizeValue: true }),
      formatTelegramMetric({ icon: "🔢", label: "수량", value: formatShares(shares) }),
      formatTelegramMetric({ icon: "📝", label: "전략", value: formatStrategyKorean(details.strategy) }),
      reasonLabel !== undefined
        ? formatTelegramMetric({ icon: "📌", label: "청산사유", value: reasonLabel, emphasizeValue: true })
        : undefined,
      expectedPriceUsdc !== undefined
        ? formatTelegramMetricPair(
            { icon: "🎯", label: "기대가", value: formatPrice(expectedPriceUsdc) },
            slippageUsdcPerShare !== undefined && slippageUsdcPerShare !== 0
              ? { icon: "📐", label: "슬리피지", value: `${slippageUsdcPerShare > 0 ? "+" : ""}${slippageUsdcPerShare.toFixed(4)}` }
              : undefined
          )
        : undefined
    ];

    if (quoteAge) {
      lines.push(
        formatTelegramMetricPair(
          { icon: "⏱", label: "대기시간", value: quoteAge, emphasizeValue: true },
          quoteMaxAge
            ? { icon: "⏳", label: "최대대기", value: quoteMaxAge }
            : undefined
        )
      );
    }

    return lines.filter(Boolean).join("\n");
  }

  // BUY → 기존 포맷 유지
  const positionBeforeShares = toFiniteNumber(details.positionBeforeShares);
  const positionAfterShares = toFiniteNumber(details.positionAfterShares);
  const currentPriceUsdc = toFiniteNumber(details.currentPriceUsdc);
  const unrealizedPnlUsdc = toFiniteNumber(details.unrealizedPnlUsdc);
  const totalNetPnlUsdc = toFiniteNumber(details.totalNetPnlUsdc);
  const positionBiasPct = toFiniteNumber(details.positionBiasPct);
  const notionalUsdc = normalizeDisplayUsdc(toFiniteNumber(details.notionalUsdc));
  const isInventoryClose = event.tags?.includes("inventory-close") ?? false;
  const quoteAge = formatTelegramAgeSeconds(details.quoteAgeMs);
  const quoteMaxAge = formatTelegramAgeSeconds(details.quoteMaxRestingAgeMs);

  const lines: Array<string | undefined> = [
    `<b>🔵 매수 체결</b>`,
    TELEGRAM_DIVIDER,
    formatTelegramMetricPair(
      { icon: "🏷️", label: "시장", value: String(details.market ?? "-") },
      { icon: "🎯", label: "결과", value: String(details.outcome ?? "-") }
    ),
    formatTelegramMetricPair(
      { icon: "📊", label: "방향", value: side, emphasizeValue: true },
      { icon: "🔢", label: "수량", value: formatShares(details.shares), emphasizeValue: true }
    ),
    formatTelegramMetricPair(
      { icon: "💰", label: "체결가", value: formatPrice(details.price), emphasizeValue: true },
      { icon: "💵", label: "거래금액", value: formatMoney(notionalUsdc), emphasizeValue: true }
    ),
    currentPriceUsdc !== undefined
      ? formatTelegramMetric({ icon: "📈", label: "현재가", value: formatPrice(currentPriceUsdc) })
      : undefined,
    positionBeforeShares !== undefined && positionAfterShares !== undefined
      ? formatTelegramMetricPair(
          {
            icon: "📦",
            label: "보유수량",
            value: `${formatShares(positionBeforeShares)} → ${formatShares(positionAfterShares)}`,
            emphasizeValue: true
          },
          positionBiasPct !== undefined
            ? { icon: "⚖️", label: "포지션 편향", value: formatPercent(positionBiasPct) ?? "-" }
            : undefined
        )
      : undefined,
    unrealizedPnlUsdc !== undefined
      ? formatTelegramMetricPair(
          {
            icon: pnlIcon(unrealizedPnlUsdc),
            label: "미실현 손익",
            value: formatSignedMoney(unrealizedPnlUsdc),
            emphasizeValue: true
          },
          totalNetPnlUsdc !== undefined
            ? {
                icon: pnlIcon(totalNetPnlUsdc),
                label: "총 Net 손익",
                value: formatSignedMoney(totalNetPnlUsdc),
                emphasizeValue: true
              }
            : undefined
        )
      : undefined,
    TELEGRAM_DIVIDER,
    (() => {
      const reasonLabel = formatReasonLabel(details.reason);
      return reasonLabel !== undefined
        ? formatTelegramMetric({ icon: "📌", label: "진입사유", value: reasonLabel, emphasizeValue: true })
        : formatTelegramMetric({
            icon: "📌",
            label: "의미",
            value: isInventoryClose ? "기존 재��를 정리한 매수 체결" : "새 재고가 생긴 매수 체결"
          });
    })(),
    (() => {
      const expectedPriceUsdc = toFiniteNumber(details.expectedPriceUsdc);
      const slippageUsdcPerShare = toFiniteNumber(details.slippageUsdcPerShare);
      if (expectedPriceUsdc === undefined) return undefined;
      return formatTelegramMetricPair(
        { icon: "🎯", label: "���대가", value: formatPrice(expectedPriceUsdc) },
        slippageUsdcPerShare !== undefined && slippageUsdcPerShare !== 0
          ? { icon: "📐", label: "슬리피지", value: `${slippageUsdcPerShare > 0 ? "+" : ""}${slippageUsdcPerShare.toFixed(4)}` }
          : undefined
      );
    })(),
    `🏃 <b>런타임</b> <code>${escapeTelegramHtml(String(event.runtime ?? "-"))}</code>`
  ];

  if (quoteAge) {
    lines.push(
      formatTelegramMetricPair(
        { icon: "⏱", label: "대기시간", value: quoteAge, emphasizeValue: true },
        quoteMaxAge
          ? { icon: "⏳", label: "최대대기", value: quoteMaxAge }
          : undefined
      )
    );
  }

  return lines.filter(Boolean).join("\n");
};

const renderTelegramQuotePosted = (event: AlertEvent): string => {
  const details = event.details ?? {};
  const side = details.side === "SELL" ? "SELL" : "BUY";
  const titleIcon = side === "BUY" ? "🔵" : details.postOnly === false ? "🟠" : "🟣";
  const title = side === "BUY" ? "매수 주문 게시" : "매도 주문 게시";
  const orderType = typeof details.orderType === "string" ? details.orderType : undefined;
  const executionStyle =
    typeof details.executionStyle === "string" ? details.executionStyle : undefined;
  const quoteSlot = typeof details.quoteSlot === "string" ? details.quoteSlot : undefined;
  const maxRestingAge = formatTelegramAgeSeconds(details.maxRestingAgeMs);
  // Map execution intent to a human-readable Korean label.
  // Priority: executionStyle (strategy intent) > postOnly flag (order mechanics).
  const orderCharacterLabel = (() => {
    if (executionStyle === "one-side-aggressive-exit") return "즉시 청산 (공격적 매도)";
    if (details.postOnly === false) return "시장성 주문 (Taker)";
    return "메이커 대기 주문 (Maker)";
  })();
  const lines: Array<string | undefined> = [
    `<b>${titleIcon} ${escapeTelegramHtml(title)}</b>`,
    TELEGRAM_DIVIDER,
    formatTelegramMetricPair(
      {
        icon: "🏷️",
        label: "시장",
        value: String(details.market ?? "-")
      },
      {
        icon: "🎯",
        label: "결과",
        value: String(details.outcome ?? "-")
      }
    ),
    formatTelegramMetricPair(
      {
        icon: "📊",
        label: "방향",
        value: side,
        emphasizeValue: true
      },
      {
        icon: "🔢",
        label: "수량",
        value: formatShares(details.size),
        emphasizeValue: true
      }
    ),
    formatTelegramMetricPair(
      {
        icon: "💰",
        label: "주문가",
        value: formatPrice(details.price),
        emphasizeValue: true
      },
      orderType
        ? {
            icon: "🧩",
            label: "주문 유형",
            value: orderType.toUpperCase(),
            emphasizeValue: true
          }
        : undefined
    ),
    formatTelegramMetricPair(
      {
        icon: "🎯",
        label: "주문 성격",
        value: orderCharacterLabel,
        emphasizeValue: true
      },
      quoteSlot
        ? {
            icon: "🏷",
            label: "호가 슬롯",
            value: quoteSlot
          }
        : undefined
    ),
    TELEGRAM_DIVIDER,
    formatTelegramMetric({
      icon: "📌",
      label: "의미",
      value:
        side === "BUY"
          ? "호가창에 새 매수 주문을 올렸습니다"
          : details.postOnly === false
            ? "재고 정리 성격의 매도 주문을 올렸습니다"
            : "호가창에 새 매도 주문을 올렸습니다"
    }),
    `🏃 <b>런타임</b> <code>${escapeTelegramHtml(String(event.runtime ?? "-"))}</code>`
  ];

  if (maxRestingAge) {
    lines.push(
      formatTelegramMetric({
        icon: "⏳",
        label: "최대대기",
        value: maxRestingAge,
        emphasizeValue: true
      })
    );
  }

  return lines.filter(Boolean).join("\n");
};

const renderTelegramQuoteRejected = (event: AlertEvent): string => {
  const details = event.details ?? {};
  const retryAfter = formatRetrySeconds(details.nextRetryAfterMs);
  const lines: Array<string | undefined> = [
    `<b>🟠 주문 거절 · 재시도 대기</b>`,
    TELEGRAM_DIVIDER,
    formatTelegramMetricPair(
      {
        icon: "🏷️",
        label: "시장",
        value: String(details.market ?? "-")
      },
      {
        icon: "🎯",
        label: "결과",
        value: String(details.outcome ?? "-")
      }
    ),
    formatTelegramMetricPair(
      {
        icon: "🔁",
        label: "방향",
        value: String(details.side ?? "-"),
        emphasizeValue: true
      },
      {
        icon: "🧾",
        label: "수량",
        value: formatShares(details.size),
        emphasizeValue: true
      }
    ),
    formatTelegramMetricPair(
      {
        icon: "💵",
        label: "주문가",
        value: formatPrice(details.price),
        emphasizeValue: true
      },
      retryAfter
        ? {
            icon: "⏱️",
            label: "다음 시도",
            value: retryAfter,
            emphasizeValue: true
          }
        : undefined
    ),
    TELEGRAM_DIVIDER,
    formatTelegramMetric({
      icon: "❗",
      label: "거절 사유",
      value: String(details.error ?? "거래소가 주문을 거절했습니다.")
    }),
    `🏃 <b>런타임</b> <code>${escapeTelegramHtml(String(event.runtime ?? "-"))}</code>`
  ];

  return lines.filter(Boolean).join("\n");
};

const renderTelegramOperatorStatusLegacy = (event: AlertEvent): string => {
  const details = event.details ?? {};
  const riskState = String(details.riskState ?? "RUNNING");
  const riskIcon = riskState === "HALTED" ? "🔴" : riskState === "DEGRADED" ? "🟠" : "🟢";
  const cashBalanceUsdc = normalizeDisplayUsdc(
    typeof details.cashBalanceUsdc === "number" ? details.cashBalanceUsdc : undefined
  );
  const cashBalanceMayBeStale = details.cashBalanceMayBeStale === true;
  const cashAllowanceUsdc = normalizeDisplayUsdc(
    typeof details.cashAllowanceUsdc === "number" ? details.cashAllowanceUsdc : undefined
  );
  const openCostUsdc = normalizeDisplayUsdc(
    typeof details.openCostUsdc === "number" ? details.openCostUsdc : undefined
  );
  const dailyRealizedPnlUsdc = normalizeDisplayUsdc(
    typeof details.dailyRealizedPnlUsdc === "number" ? details.dailyRealizedPnlUsdc : undefined
  );
  const lifetimeRealizedPnlUsdc = normalizeDisplayUsdc(
    typeof details.lifetimeRealizedPnlUsdc === "number"
      ? details.lifetimeRealizedPnlUsdc
      : undefined
  );
  const marketMakingDailyPnlUsdc = normalizeDisplayUsdc(
    typeof details.marketMakingDailyPnlUsdc === "number"
      ? details.marketMakingDailyPnlUsdc
      : undefined
  );
  const sameMarketArbDailyPnlUsdc = normalizeDisplayUsdc(
    typeof details.sameMarketArbDailyPnlUsdc === "number"
      ? details.sameMarketArbDailyPnlUsdc
      : undefined
  );
  const rewardIncomeUsdc = normalizeDisplayUsdc(
    typeof details.rewardIncomeUsdc === "number" ? details.rewardIncomeUsdc : undefined
  );
  const rebateIncomeUsdc = normalizeDisplayUsdc(
    typeof details.rebateIncomeUsdc === "number" ? details.rebateIncomeUsdc : undefined
  );
  const totalNetPnlUsdc = normalizeDisplayUsdc(
    typeof details.totalNetPnlUsdc === "number" ? details.totalNetPnlUsdc : undefined
  );
  const statusMessage =
    riskState === "RUNNING"
      ? "정상 운전 중입니다."
      : riskState === "DEGRADED"
        ? "주의 상태입니다. 주문 규모와 속도가 줄어들 수 있습니다."
        : "정지 상태입니다. 새 주문보다 위험 축소가 우선입니다.";
  const lines: Array<string | undefined> = [
    `<b>${riskIcon} 운영 현황</b>`,
    statusMessage,
    TELEGRAM_DIVIDER,
    formatTelegramMetricPair(
      {
        icon: "🧭",
        label: "리스크 상태",
        value: riskState,
        emphasizeValue: true
      },
      {
        icon: "💵",
        label: "현금",
        value: formatMoney(cashBalanceUsdc),
        emphasizeValue: true
      }
    ),
    cashAllowanceUsdc !== undefined
      ? formatTelegramMetricPair(
          {
            icon: "🛒",
            label: "주문 가능 한도",
            value: formatMoney(cashAllowanceUsdc),
            emphasizeValue: true
          },
          {
            icon: pnlIcon(dailyRealizedPnlUsdc),
            label: "오늘 확정손익",
            value: formatSignedMoney(dailyRealizedPnlUsdc),
            emphasizeValue: true
          }
        )
      : undefined,
    cashAllowanceUsdc === undefined
      ? formatTelegramMetric({
          icon: pnlIcon(dailyRealizedPnlUsdc),
          label: "오늘 확정손익",
          value: formatSignedMoney(dailyRealizedPnlUsdc),
          emphasizeValue: true
        })
      : undefined,
    formatTelegramMetricPair(
      {
        icon: "📬",
        label: "대기 주문",
        value: `${String(details.activeOrderCount ?? "-")}개`,
        emphasizeValue: true
      },
      {
        icon: "🧪",
        label: "운용 시장",
        value: `${String(details.activeConditionCount ?? "-")}개`,
        emphasizeValue: true
      }
    ),
    formatTelegramMetricPair(
      {
        icon: "📦",
        label: "열린 포지션",
        value: `${String(details.openLotCount ?? "-")}개 · ${formatShares(details.openShares)}`,
        emphasizeValue: true
      },
      {
        icon: "🧾",
        label: "열린 포지션 원가",
        value: formatMoney(openCostUsdc),
        emphasizeValue: true
      }
    ),
    lifetimeRealizedPnlUsdc !== undefined
      ? formatTelegramMetricPair(
          {
            icon: pnlIcon(lifetimeRealizedPnlUsdc),
            label: "누적 확정손익",
            value: formatSignedMoney(lifetimeRealizedPnlUsdc),
            emphasizeValue: true
          },
          totalNetPnlUsdc !== undefined
            ? {
                icon: pnlIcon(totalNetPnlUsdc),
                label: "누적 Net 손익",
                value: formatSignedMoney(totalNetPnlUsdc),
                emphasizeValue: true
              }
            : undefined
        )
      : totalNetPnlUsdc !== undefined
        ? formatTelegramMetric({
            icon: pnlIcon(totalNetPnlUsdc),
            label: "누적 Net 손익",
            value: formatSignedMoney(totalNetPnlUsdc),
            emphasizeValue: true
          })
      : undefined,
    typeof details.lifetimeTradeCount === "number"
      ? formatTelegramMetricPair(
          {
            icon: "📚",
            label: "누적 거래",
            value: `${String(details.lifetimeTradeCount)}건`,
            emphasizeValue: true
          },
          {
            icon: "🏁",
            label: "승/패",
            value: `${String(details.winningTradeCount ?? 0)}/${String(details.losingTradeCount ?? 0)}`
          }
        )
      : undefined,
    formatTelegramMetric({
      icon: "⚙️",
      label: "전략별 오늘 손익",
      value: `MM ${formatSignedMoney(marketMakingDailyPnlUsdc)} · 차익 ${formatSignedMoney(sameMarketArbDailyPnlUsdc)}`
    }),
    formatTelegramMetric({
      icon: "🎁",
      label: "보상 합계",
      value: `리워드 ${formatMoney(rewardIncomeUsdc)} · 리베이트 ${formatMoney(rebateIncomeUsdc)}`
    }),
    TELEGRAM_DIVIDER,
    `🏃 <b>런타임</b> <code>${escapeTelegramHtml(String(event.runtime ?? "-"))}</code>`
  ];

  return lines.filter(Boolean).join("\n");
};

const renderTelegramOperatorStatus = (event: AlertEvent): string => {
  const details = event.details ?? {};
  const riskState = String(details.riskState ?? "RUNNING");
  const botStateLabel = riskState === "HALTED" ? "HALTED" : riskState === "DEGRADED" ? "DEGRADED" : "RUNNING";
  const riskStateLabel = riskState === "HALTED" ? "정지" : riskState === "DEGRADED" ? "주의" : "정상";
  const sectionDivider = "<code>┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</code>";

  const cashBalanceUsdc = normalizeDisplayUsdc(
    typeof details.cashBalanceUsdc === "number" ? details.cashBalanceUsdc : undefined
  );
  const openCostUsdc = normalizeDisplayUsdc(
    typeof details.openCostUsdc === "number" ? details.openCostUsdc : undefined
  );
  const openPositionValueUsdc = normalizeDisplayUsdc(
    typeof details.openPositionValueUsdc === "number"
      ? details.openPositionValueUsdc
      : undefined
  );
  const openUnrealizedPnlUsdc = normalizeDisplayUsdc(
    typeof details.openUnrealizedPnlUsdc === "number"
      ? details.openUnrealizedPnlUsdc
      : undefined
  );
  const pricedOpenTokenCount =
    typeof details.pricedOpenTokenCount === "number" && Number.isFinite(details.pricedOpenTokenCount)
      ? details.pricedOpenTokenCount
      : undefined;
  const unpricedOpenTokenCount =
    typeof details.unpricedOpenTokenCount === "number" &&
    Number.isFinite(details.unpricedOpenTokenCount)
      ? details.unpricedOpenTokenCount
      : undefined;
  const initialCapitalUsdc = normalizeDisplayUsdc(
    typeof details.initialCapitalUsdc === "number" ? details.initialCapitalUsdc : undefined
  );
  const dailyRealizedPnlUsdc = normalizeDisplayUsdc(
    typeof details.dailyRealizedPnlUsdc === "number" ? details.dailyRealizedPnlUsdc : undefined
  );
  const marketMakingDailyPnlUsdc = normalizeDisplayUsdc(
    typeof details.marketMakingDailyPnlUsdc === "number"
      ? details.marketMakingDailyPnlUsdc
      : undefined
  );
  const sameMarketArbDailyPnlUsdc = normalizeDisplayUsdc(
    typeof details.sameMarketArbDailyPnlUsdc === "number"
      ? details.sameMarketArbDailyPnlUsdc
      : undefined
  );
  const rewardIncomeUsdc = normalizeDisplayUsdc(
    typeof details.rewardIncomeUsdc === "number" ? details.rewardIncomeUsdc : undefined
  );
  const rebateIncomeUsdc = normalizeDisplayUsdc(
    typeof details.rebateIncomeUsdc === "number" ? details.rebateIncomeUsdc : undefined
  );
  const fallbackNetPnlUsdc = normalizeDisplayUsdc(
    typeof details.totalNetPnlUsdc === "number" ? details.totalNetPnlUsdc : undefined
  );
  const effectiveOpenPositionValueUsdc =
    typeof openPositionValueUsdc === "number" ? openPositionValueUsdc : openCostUsdc;
  const currentAssetUsdc =
    typeof cashBalanceUsdc === "number" && typeof effectiveOpenPositionValueUsdc === "number"
      ? cashBalanceUsdc + effectiveOpenPositionValueUsdc
      : undefined;
  // Flag when some positions are priced at cost basis (no live mark price) — the total
  // asset figure may jump once those prices become available, so we note it explicitly.
  const hasUnpricedPositions =
    typeof unpricedOpenTokenCount === "number" && unpricedOpenTokenCount > 0;
  const totalProfitUsdc =
    typeof initialCapitalUsdc === "number" && typeof currentAssetUsdc === "number"
      ? currentAssetUsdc - initialCapitalUsdc
      : fallbackNetPnlUsdc;
  const totalProfitPct =
    typeof initialCapitalUsdc === "number" &&
    initialCapitalUsdc > 0 &&
    typeof totalProfitUsdc === "number"
      ? (totalProfitUsdc / initialCapitalUsdc) * 100
      : undefined;
  const rewardRebateDailyPnlUsdc =
    (typeof rewardIncomeUsdc === "number" ? rewardIncomeUsdc : 0) +
    (typeof rebateIncomeUsdc === "number" ? rebateIncomeUsdc : 0);
  const cashBalanceMayBeStale = details.cashBalanceMayBeStale === true;

  const formatProfitLine = (): string => {
    if (typeof totalProfitUsdc !== "number") {
      return "📉 <b>총 수익:</b> -";
    }

    const icon = totalProfitUsdc > 0 ? "📈" : totalProfitUsdc < 0 ? "📉" : "➖";
    const pct =
      typeof totalProfitPct === "number" && Number.isFinite(totalProfitPct)
        ? ` (${totalProfitPct >= 0 ? "+" : ""}${totalProfitPct.toFixed(1)}%)`
        : "";
    return `${icon} <b>총 수익:</b> <b>${escapeTelegramHtml(formatSignedMoney(totalProfitUsdc))}</b>${escapeTelegramHtml(pct)}`;
  };

  const dailyTradeCountText =
    typeof details.dailyTradeCount === "number" && Number.isFinite(details.dailyTradeCount)
      ? `${String(details.dailyTradeCount)}건`
      : "-";
  const valuationCoverageText =
    typeof pricedOpenTokenCount === "number" || typeof unpricedOpenTokenCount === "number"
      ? `${String(pricedOpenTokenCount ?? 0)}개 시세 반영${
          (unpricedOpenTokenCount ?? 0) > 0
            ? ` · ${String(unpricedOpenTokenCount)}개 원가 반영`
            : ""
        }`
      : undefined;

  // Lifetime values for cumulative section and uptime/lifetime trade summary.
  const lifetimeMarketMakingPnlUsdc = normalizeDisplayUsdc(
    typeof details.marketMakingLifetimePnlUsdc === "number"
      ? details.marketMakingLifetimePnlUsdc
      : undefined
  );
  const lifetimeSameMarketArbPnlUsdc = normalizeDisplayUsdc(
    typeof details.sameMarketArbLifetimePnlUsdc === "number"
      ? details.sameMarketArbLifetimePnlUsdc
      : undefined
  );
  const lifetimeRewardIncomeUsdc = normalizeDisplayUsdc(
    typeof details.lifetimeRewardIncomeUsdc === "number"
      ? details.lifetimeRewardIncomeUsdc
      : undefined
  );
  const lifetimeRebateIncomeUsdc = normalizeDisplayUsdc(
    typeof details.lifetimeRebateIncomeUsdc === "number"
      ? details.lifetimeRebateIncomeUsdc
      : undefined
  );
  const lifetimeRewardRebateUsdc =
    (typeof lifetimeRewardIncomeUsdc === "number" ? lifetimeRewardIncomeUsdc : 0) +
    (typeof lifetimeRebateIncomeUsdc === "number" ? lifetimeRebateIncomeUsdc : 0);
  const lifetimeTradeCountText =
    typeof details.lifetimeTradeCount === "number" && Number.isFinite(details.lifetimeTradeCount)
      ? `${String(details.lifetimeTradeCount)}건`
      : "-";
  // Uptime in days computed from operatorStartedAtMs if provided, else falls back to "X".
  const operatorStartedAtMs =
    typeof details.operatorStartedAtMs === "number" ? details.operatorStartedAtMs : undefined;
  const uptimeDaysText = (() => {
    if (typeof operatorStartedAtMs !== "number" || operatorStartedAtMs <= 0) return "-";
    const days = Math.max(0, (event.occurredAtMs - operatorStartedAtMs) / (24 * 60 * 60 * 1000));
    return days < 1 ? `${(days * 24).toFixed(1)}시간` : `${days.toFixed(1)}일`;
  })();

  // 📌 #10, #11, #12: 리워드 제외 순수 MM 수익을 분리 표시하는 것이 핵심.
  // 실현 합계 - 리워드 = 순수 MM+차익 수익 (operator가 요구한 "진짜" 성과 지표).
  const pureTradingDailyPnlUsdc =
    (typeof dailyRealizedPnlUsdc === "number" ? dailyRealizedPnlUsdc : 0) -
    (typeof rewardRebateDailyPnlUsdc === "number" ? rewardRebateDailyPnlUsdc : 0);
  const pureTradingLifetimePnlUsdc =
    (typeof details.lifetimeRealizedPnlUsdc === "number"
      ? (details.lifetimeRealizedPnlUsdc as number)
      : 0) -
    (typeof lifetimeRewardRebateUsdc === "number" ? lifetimeRewardRebateUsdc : 0);

  const lines: string[] = [
    "<b>📊 폴리마켓 통합봇 리포트</b>",
    "",
    `💰 <b>현재 자산:</b> ${escapeTelegramHtml(formatMoney(currentAssetUsdc))} | 💼 <b>초기 자본:</b> ${escapeTelegramHtml(formatMoney(initialCapitalUsdc))}`,
    formatProfitLine(),
    `📅 <b>운영 기간:</b> ${escapeTelegramHtml(uptimeDaysText)}`,
    `📦 <b>누적 거래:</b> ${escapeTelegramHtml(lifetimeTradeCountText)}`,
    "",
    "------------------------------",
    "",
    "<b>📝 오늘 성과</b>",
    `📦 <b>거래 수:</b> ${escapeTelegramHtml(dailyTradeCountText)}`,
    `💸 <b>실현 수익 (전체):</b> ${escapeTelegramHtml(formatSignedMoney(dailyRealizedPnlUsdc))}`,
    `💎 <b>순 MM 수익 (리워드 제외):</b> <b>${escapeTelegramHtml(formatSignedMoney(pureTradingDailyPnlUsdc))}</b>`,
    "",
    "------------------------------",
    "",
    "<b>📊 오늘 수익 구조</b>",
    `1️⃣ <b>마켓메이킹:</b> ${escapeTelegramHtml(formatSignedMoney(marketMakingDailyPnlUsdc))}`,
    `2️⃣ <b>차익거래:</b> ${escapeTelegramHtml(formatSignedMoney(sameMarketArbDailyPnlUsdc))}`,
    `3️⃣ <b>리워드 (운영자 confirmed):</b> ${escapeTelegramHtml(formatSignedMoney(rewardRebateDailyPnlUsdc))}`,
    "",
    "------------------------------",
    "",
    "<b>📊 누적 수익 구조</b>",
    `1️⃣ <b>마켓메이킹:</b> ${escapeTelegramHtml(formatSignedMoney(lifetimeMarketMakingPnlUsdc))}`,
    `2️⃣ <b>차익거래:</b> ${escapeTelegramHtml(formatSignedMoney(lifetimeSameMarketArbPnlUsdc))}`,
    `3️⃣ <b>리워드 (운영자 confirmed):</b> ${escapeTelegramHtml(formatSignedMoney(lifetimeRewardRebateUsdc))}`,
    `💎 <b>누적 순 MM 수익:</b> <b>${escapeTelegramHtml(formatSignedMoney(pureTradingLifetimePnlUsdc))}</b>`,
    "",
    "------------------------------",
    "",
    "<b>📝 현재 상태</b>",
    `📦 <b>열린 포지션:</b> ${escapeTelegramHtml(String(details.openLotCount ?? 0))}개`,
    `💸 <b>대기 주문:</b> ${escapeTelegramHtml(String(details.activeOrderCount ?? 0))}개`,
    `📈 <b>보유 평가액:</b> ${escapeTelegramHtml(formatMoney(effectiveOpenPositionValueUsdc))}`,
    `🧾 <b>미실현 손익:</b> ${escapeTelegramHtml(formatSignedMoney(openUnrealizedPnlUsdc))}`,
    // 📌 #13 MM 청산 품질 — 수익/본전/손절 건수 분리 표시. 리워드 건수와
    // 완전 분리해서 사용자가 "진짜 매매 품질"을 즉시 확인 가능.
    ...(typeof details.marketMakingDailyWinCount === "number" ||
    typeof details.marketMakingDailyLossCount === "number" ||
    typeof details.marketMakingDailyFlatCount === "number"
      ? [
          "",
          "<b>🎯 MM 청산 품질 (오늘)</b>",
          `🟢 <b>수익 청산:</b> ${escapeTelegramHtml(String(details.marketMakingDailyWinCount ?? 0))}건`,
          `🟡 <b>본전 청산:</b> ${escapeTelegramHtml(String(details.marketMakingDailyFlatCount ?? 0))}건`,
          `🔴 <b>손절 청산:</b> ${escapeTelegramHtml(String(details.marketMakingDailyLossCount ?? 0))}건`
        ]
      : []),
    // 📌 #14 정상 MM 검증 지표 — BUY/SELL 체결 비율과 평균 hold 시간.
    // BUY→SELL 비율이 1.0에 가까울수록 정상 MM 회전, 0에 가까우면 재고 정체.
    ...(typeof details.marketMakingSessionBuyFills === "number" &&
    (details.marketMakingSessionBuyFills as number) > 0
      ? [
          "",
          "<b>📊 MM 회전 지표 (세션)</b>",
          `🛒 <b>매수 체결:</b> ${escapeTelegramHtml(String(details.marketMakingSessionBuyFills))}건`,
          `💰 <b>매도 체결/청산:</b> ${escapeTelegramHtml(String(details.marketMakingSessionSellFills ?? 0))}건`,
          `⚖️ <b>BUY→SELL 비율:</b> ${escapeTelegramHtml(
            typeof details.marketMakingSessionBuyToSellRatio === "number"
              ? `${((details.marketMakingSessionBuyToSellRatio as number) * 100).toFixed(1)}%`
              : "-"
          )}`,
          ...(typeof details.marketMakingSessionAverageHoldMs === "number"
            ? [
                `⏱️ <b>평균 hold:</b> ${escapeTelegramHtml(
                  formatHoldDuration(details.marketMakingSessionAverageHoldMs as number)
                )}`
              ]
            : [])
        ]
      : []),
    ...(typeof details.venueDriftTokenCount === "number" && (details.venueDriftTokenCount as number) > 0
      ? [
          `⚠️ <b>재고 동기화:</b> 로컬 ↔ 거래소 ${escapeTelegramHtml(String(details.venueDriftTokenCount))}개 토큰 불일치 (≈ ${escapeTelegramHtml(formatMoney(typeof details.venueDriftAbsValueUsdc === "number" ? (details.venueDriftAbsValueUsdc as number) : undefined))})`
        ]
      : []),
    ...(cashBalanceMayBeStale
      ? [`⚠️ <b>현금 캐시:</b> 거래소 응답 캐시 가능성 — 사이트 잔액 우선 확인`]
      : []),
    "",
    "------------------------------",
    "",
    `🤖 <b>봇 상태:</b> ${escapeTelegramHtml(riskStateLabel)}`
  ];

  return lines.join("\n");
};

const renderTelegramGeneric = (event: AlertEvent): string => {
  const detailLines = formatDetails(event.details);
  const header = `<b>${escapeTelegramHtml(`${severityIcon[event.severity]} ${event.title}`)}</b>`;
  const summary = `📝 ${escapeTelegramHtml(event.summary)}`;
  const meta = [
    event.runtime ? `🏃 <code>${escapeTelegramHtml(event.runtime)}</code>` : undefined,
    event.sessionName ? `🧩 <code>${escapeTelegramHtml(event.sessionName)}</code>` : undefined,
    event.tags && event.tags.length > 0
      ? `🏷️ <code>${escapeTelegramHtml(event.tags.join(", "))}</code>`
      : undefined
  ].filter(Boolean);
  const details =
    detailLines.length > 0
      ? `\n${TELEGRAM_DIVIDER}\n<b>📌 세부 정보</b>\n${detailLines
          .map((line) => `• ${escapeTelegramHtml(line)}`)
          .join("\n")}`
      : "";

  return [header, TELEGRAM_DIVIDER, summary, meta.length > 0 ? meta.join("  <code>│</code>  ") : undefined]
    .filter(Boolean)
    .join("\n") + details;
};

const buildTelegramText = (event: AlertEvent): string => {
  if (event.category === "order_fill") {
    return renderTelegramOrderFill(event);
  }

  if (event.category === "quote_posted") {
    return renderTelegramQuotePosted(event);
  }

  if (event.category === "quote_post_rejected") {
    return renderTelegramQuoteRejected(event);
  }

  if (event.category === "operator_status") {
    return renderTelegramOperatorStatus(event);
  }

  if (event.category === "bot_lifecycle") {
    // Minimal, immediate startup/shutdown message
    return `<b>${escapeTelegramHtml(event.title)}</b>\n\n${escapeTelegramHtml(event.summary)}`;
  }

  return renderTelegramGeneric(event);
};

const buildWebhookPayload = (
  event: AlertEvent,
  format: AlertWebhookFormat,
  telegramChatId?: string
): Record<string, unknown> => {
  const lines = buildPlainLines(event);

  if (format === "slack") {
    return {
      text: `[${severityEmoji[event.severity]}] ${event.title}`,
      blocks: lines.map((line) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: line
        }
      }))
    };
  }

  if (format === "discord") {
    return {
      content: lines.join("\n"),
      embeds: [
        {
          title: event.title,
          description: event.summary,
          color:
            event.severity === "critical"
              ? 0xed4245
              : event.severity === "warning"
                ? 0xfee75c
                : 0x5865f2,
          fields: [
            ...(event.runtime ? [{ name: "runtime", value: event.runtime, inline: true }] : []),
            ...(event.sessionName
              ? [{ name: "session", value: event.sessionName, inline: true }]
              : []),
            ...(event.tags && event.tags.length > 0
              ? [{ name: "tags", value: event.tags.join(", "), inline: false }]
              : []),
            ...formatDetails(event.details).map((line, index) => ({
              name: `detail_${index + 1}`,
              value: line,
              inline: false
            }))
          ]
        }
      ]
    };
  }

  if (format === "telegram") {
    return {
      chat_id: telegramChatId,
      text: buildTelegramText(event),
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
  }

  return event;
};
