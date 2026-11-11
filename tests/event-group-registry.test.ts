import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventGroupRegistry } from "../src/polymarket/event-group-registry.js";

const silentLogger = pino({ level: "silent" });

const buildGammaResponse = (
  eventId: string,
  markets: Array<{
    questionID: string;
    active?: boolean;
    closed?: boolean;
    acceptingOrders?: boolean;
  }>
) => [
  {
    id: eventId,
    slug: `event-${eventId}`,
    markets
  }
];

const mockJsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body
  }) as unknown as Response;

describe("EventGroupRegistry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns active market count and questionIds from gamma response", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        buildGammaResponse("34584", [
          { questionID: "0xaaa", active: true, closed: false, acceptingOrders: true },
          { questionID: "0xbbb", active: true, closed: false, acceptingOrders: true },
          { questionID: "0xccc", active: false, closed: false, acceptingOrders: true },
          { questionID: "0xddd", active: true, closed: true, acceptingOrders: true },
          { questionID: "0xeee", active: true, closed: false, acceptingOrders: false }
        ])
      )
    );

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("34584");

    expect(result?.activeMarketCount).toBe(2);
    expect(result?.questionIds.has("0xaaa")).toBe(true);
    expect(result?.questionIds.has("0xbbb")).toBe(true);
    expect(result?.questionIds.has("0xccc")).toBe(false);
    expect(result?.questionIds.has("0xddd")).toBe(false);
    expect(result?.questionIds.has("0xeee")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches results within TTL and avoids repeat fetches", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        buildGammaResponse("evt-1", [
          { questionID: "0x01", active: true, closed: false, acceptingOrders: true }
        ])
      )
    );

    const registry = new EventGroupRegistry(silentLogger, {
      ttlMs: 60_000,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const first = await registry.get("evt-1");
    const second = await registry.get("evt-1");

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const responseFor = (qid: string) =>
      mockJsonResponse(
        buildGammaResponse("evt-1", [
          { questionID: qid, active: true, closed: false, acceptingOrders: true }
        ])
      );

    fetchMock.mockResolvedValueOnce(responseFor("0x01")).mockResolvedValueOnce(responseFor("0x02"));

    const registry = new EventGroupRegistry(silentLogger, {
      ttlMs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const first = await registry.get("evt-1");
    expect(first?.questionIds.has("0x01")).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await registry.get("evt-1");
    expect(second?.questionIds.has("0x02")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent fetches for the same eventId", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const first = registry.get("evt-1");
    const second = registry.get("evt-1");

    resolveResponse?.(
      mockJsonResponse(
        buildGammaResponse("evt-1", [
          { questionID: "0x01", active: true, closed: false, acceptingOrders: true }
        ])
      )
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on non-OK response without throwing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("evt-1");
    expect(result).toBeUndefined();
  });

  it("returns undefined on fetch throw without throwing to caller", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("evt-1");
    expect(result).toBeUndefined();
  });

  it("getMany dedupes input and aggregates results", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(
          buildGammaResponse("a", [
            { questionID: "0x0a", active: true, closed: false, acceptingOrders: true }
          ])
        )
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          buildGammaResponse("b", [
            { questionID: "0x0b", active: true, closed: false, acceptingOrders: true }
          ])
        )
      );

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.getMany(["a", "b", "a"]);
    expect(result.size).toBe(2);
    expect(result.get("a")?.questionIds.has("0x0a")).toBe(true);
    expect(result.get("b")?.questionIds.has("0x0b")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("captures tokenIds from clobTokenIds field (array form)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: "evt-1",
          slug: "evt-1",
          markets: [
            {
              questionID: "0xaaa",
              active: true,
              closed: false,
              acceptingOrders: true,
              clobTokenIds: ["111", "222"]
            },
            {
              questionID: "0xbbb",
              active: true,
              closed: false,
              acceptingOrders: true,
              clobTokenIds: ["333", "444"]
            }
          ]
        }
      ])
    );

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("evt-1");
    expect(result?.tokenIds.size).toBe(4);
    expect(result?.tokenIds.has("111")).toBe(true);
    expect(result?.tokenIds.has("222")).toBe(true);
    expect(result?.tokenIds.has("333")).toBe(true);
    expect(result?.tokenIds.has("444")).toBe(true);
  });

  it("captures tokenIds when clobTokenIds is JSON-stringified (string form)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: "evt-1",
          slug: "evt-1",
          markets: [
            {
              questionID: "0xaaa",
              active: true,
              closed: false,
              acceptingOrders: true,
              clobTokenIds: '["555","666"]'
            }
          ]
        }
      ])
    );

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("evt-1");
    expect(result?.tokenIds.size).toBe(2);
    expect(result?.tokenIds.has("555")).toBe(true);
    expect(result?.tokenIds.has("666")).toBe(true);
  });

  it("excludes tokenIds from inactive/closed markets", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([
        {
          id: "evt-1",
          slug: "evt-1",
          markets: [
            {
              questionID: "0xactive",
              active: true,
              closed: false,
              acceptingOrders: true,
              clobTokenIds: ["1", "2"]
            },
            {
              questionID: "0xclosed",
              active: true,
              closed: true,
              acceptingOrders: false,
              clobTokenIds: ["99", "100"]
            },
            {
              questionID: "0xinactive",
              active: false,
              closed: false,
              acceptingOrders: true,
              clobTokenIds: ["77", "88"]
            }
          ]
        }
      ])
    );

    const registry = new EventGroupRegistry(silentLogger, {
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const result = await registry.get("evt-1");
    expect(result?.tokenIds.size).toBe(2);
    expect(result?.tokenIds.has("1")).toBe(true);
    expect(result?.tokenIds.has("2")).toBe(true);
    expect(result?.tokenIds.has("99")).toBe(false);
    expect(result?.tokenIds.has("77")).toBe(false);
  });

  it("invalidate forces a fresh fetch on next get", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(
          buildGammaResponse("evt-1", [
            { questionID: "0x01", active: true, closed: false, acceptingOrders: true }
          ])
        )
      )
      .mockResolvedValueOnce(
        mockJsonResponse(
          buildGammaResponse("evt-1", [
            { questionID: "0x99", active: true, closed: false, acceptingOrders: true }
          ])
        )
      );

    const registry = new EventGroupRegistry(silentLogger, {
      ttlMs: 60_000,
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    const first = await registry.get("evt-1");
    expect(first?.questionIds.has("0x01")).toBe(true);

    registry.invalidate("evt-1");

    const second = await registry.get("evt-1");
    expect(second?.questionIds.has("0x99")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
