import type { Logger } from "pino";

import { config } from "../config.js";

export interface EventGroupMetadata {
  eventId: string;
  eventSlug?: string;
  activeMarketCount: number;
  questionIds: ReadonlySet<string>;
  // Fix C: tokenIds from clobTokenIds across the full event (used by event-wide
  // hasOpenGroupExposure check). Includes both YES and NO token IDs of every
  // active market in the negRisk group.
  tokenIds: ReadonlySet<string>;
  fetchedAtMs: number;
}

interface GammaEventMarketLike {
  questionID?: string;
  question_id?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  accepting_orders?: boolean;
  clobTokenIds?: string | readonly string[];
}

interface GammaEventLike {
  id?: string | number;
  slug?: string;
  markets?: GammaEventMarketLike[];
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface EventGroupRegistryOptions {
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class EventGroupRegistry {
  private readonly cache = new Map<string, EventGroupMetadata>();
  private readonly inflightFetches = new Map<string, Promise<EventGroupMetadata | undefined>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly logger: Logger,
    options: EventGroupRegistryOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async get(eventId: string): Promise<EventGroupMetadata | undefined> {
    const cached = this.cache.get(eventId);
    if (cached && Date.now() - cached.fetchedAtMs < this.ttlMs) {
      return cached;
    }

    const inflight = this.inflightFetches.get(eventId);
    if (inflight) return inflight;

    const promise = this.fetch(eventId).finally(() => {
      this.inflightFetches.delete(eventId);
    });
    this.inflightFetches.set(eventId, promise);
    return promise;
  }

  async getMany(
    eventIds: readonly string[]
  ): Promise<Map<string, EventGroupMetadata>> {
    const unique = [...new Set(eventIds)];
    const entries = await Promise.all(
      unique.map((id) => this.get(id).then((meta) => [id, meta] as const))
    );
    const map = new Map<string, EventGroupMetadata>();
    for (const [id, meta] of entries) {
      if (meta) map.set(id, meta);
    }
    return map;
  }

  invalidate(eventId: string): void {
    this.cache.delete(eventId);
  }

  // gamma sometimes returns clobTokenIds as a JSON-stringified array (e.g., "[\"123\",\"456\"]")
  // and sometimes as a real array. This helper handles the string variant.
  private parseTokenIdsField(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[")) {
      // Single-token comma-separated fallback (defensive; not observed in practice)
      return trimmed
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // fall through
    }
    return [];
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async fetch(eventId: string): Promise<EventGroupMetadata | undefined> {
    try {
      const url = new URL("/events", config.gammaHost);
      url.searchParams.set("id", eventId);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        this.logger.warn(
          { eventId, status: response.status },
          "Event group registry: gamma /events fetch returned non-OK status."
        );
        return undefined;
      }

      const payload = (await response.json()) as GammaEventLike[] | GammaEventLike;
      const event = Array.isArray(payload) ? payload[0] : payload;

      if (!event || !event.markets) {
        this.logger.warn(
          { eventId, hasEvent: Boolean(event) },
          "Event group registry: gamma response missing event or markets."
        );
        return undefined;
      }

      const activeMarkets = event.markets.filter((market) => {
        if (market.active === false) return false;
        if (market.closed === true) return false;
        const accepting = market.acceptingOrders ?? market.accepting_orders;
        if (accepting === false) return false;
        return true;
      });

      const questionIds = new Set<string>();
      const tokenIds = new Set<string>();
      for (const market of activeMarkets) {
        const qid = market.questionID ?? market.question_id;
        if (typeof qid === "string" && qid.length > 0) {
          questionIds.add(qid.toLowerCase());
        }
        const rawTokenIds = market.clobTokenIds;
        const parsed = Array.isArray(rawTokenIds)
          ? rawTokenIds
          : typeof rawTokenIds === "string"
            ? this.parseTokenIdsField(rawTokenIds)
            : [];
        for (const tokenId of parsed) {
          if (typeof tokenId === "string" && tokenId.length > 0) {
            tokenIds.add(tokenId);
          }
        }
      }

      const meta: EventGroupMetadata = {
        eventId,
        eventSlug: event.slug,
        activeMarketCount: activeMarkets.length,
        questionIds,
        tokenIds,
        fetchedAtMs: Date.now()
      };
      this.cache.set(eventId, meta);

      this.logger.debug(
        {
          eventId,
          eventSlug: event.slug,
          activeMarketCount: activeMarkets.length,
          totalMarkets: event.markets.length,
          questionIdCount: questionIds.size,
          tokenIdCount: tokenIds.size
        },
        "Event group registry: cached event metadata."
      );

      return meta;
    } catch (error) {
      this.logger.warn(
        { err: error, eventId },
        "Event group registry: gamma /events fetch failed."
      );
      return undefined;
    }
  }
}
