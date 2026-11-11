import { readFileSync } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { config } from "../config.js";
import { InventoryLotTracker, type InventoryLotInput } from "./inventory-lot-tracker.js";

const seedValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const inventoryLotSeedSchema = z.object({
  lotId: z.string().min(1).optional(),
  strategy: z.enum(["market-making", "same-market-arb", "negative-risk"]),
  tokenId: z.string().min(1),
  marketScope: z.string().min(1),
  conditionId: z.string().min(1).optional(),
  outcome: z.string().min(1).optional(),
  shares: z.coerce.number().positive(),
  totalCostUsdc: z.coerce.number().nonnegative(),
  openedAtMs: z.coerce.number().int().positive().optional(),
  openedAt: z.string().min(1).optional(),
  metadata: z.record(z.string(), seedValueSchema).optional()
});

export type InventoryLotSeed = z.infer<typeof inventoryLotSeedSchema>;

const parseOpenedAtMs = (
  seed: InventoryLotSeed,
  now: () => number,
  index: number
): number => {
  if (typeof seed.openedAtMs === "number") {
    return seed.openedAtMs;
  }

  if (seed.openedAt) {
    const parsed = Date.parse(seed.openedAt);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    throw new Error(
      `Inventory seed row ${index} had an invalid openedAt timestamp: ${seed.openedAt}`
    );
  }

  return now();
};

export const parseInventoryLotSeedPayload = (
  payload: string,
  options?: {
    now?: () => number;
    sourceLabel?: string;
  }
): InventoryLotInput[] => {
  const parsedJson = JSON.parse(payload) as unknown;
  const rows = z.array(inventoryLotSeedSchema).parse(parsedJson);
  const now = options?.now ?? (() => Date.now());
  const sourceLabel = options?.sourceLabel ?? "seed";

  return rows.map((row, index) => ({
    lotId: row.lotId ?? `${sourceLabel}:${row.strategy}:${row.tokenId}:${index}`,
    strategy: row.strategy,
    tokenId: row.tokenId,
    marketScope: row.marketScope,
    conditionId: row.conditionId,
    outcome: row.outcome,
    shares: row.shares,
    totalCostUsdc: row.totalCostUsdc,
    openedAtMs: parseOpenedAtMs(row, now, index),
    metadata: row.metadata
  }));
};

export const loadConfiguredInventoryLotSeed = (
  logger?: Logger,
  options?: {
    now?: () => number;
    cwd?: string;
  }
): InventoryLotInput[] => {
  const rows: InventoryLotInput[] = [];
  const seedFilePath = config.inventory.initialLotsFile ?? config.inventory.snapshotFile;

  if (seedFilePath) {
    const resolvedPath = path.resolve(options?.cwd ?? process.cwd(), seedFilePath);

    try {
      const payload = readFileSync(resolvedPath, "utf8");
      rows.push(
        ...parseInventoryLotSeedPayload(payload, {
          now: options?.now,
          sourceLabel: resolvedPath
        })
      );
    } catch (error) {
      const isMissingFile =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT";

      if (isMissingFile) {
        logger?.info(
          {
            seedFile: resolvedPath
          },
          "Inventory lot seed file was not found. Starting with an empty carry-over inventory snapshot."
        );
      } else {
        throw error;
      }
    }
  }

  if (config.inventory.initialLotsJson) {
    rows.push(
      ...parseInventoryLotSeedPayload(config.inventory.initialLotsJson, {
        now: options?.now,
        sourceLabel: "env-json"
      })
    );
  }

  if (rows.length > 0) {
    logger?.info(
      {
        seededLotCount: rows.length,
        seededShares: Number(rows.reduce((total, row) => total + row.shares, 0).toFixed(5)),
        seededCostUsdc: Number(
          rows.reduce((total, row) => total + row.totalCostUsdc, 0).toFixed(8)
        ),
        seedSources: {
          file: seedFilePath,
          json: Boolean(config.inventory.initialLotsJson)
        }
      },
      "Loaded configured inventory lot seed."
    );
  }

  return rows;
};

export const createSeededInventoryLotTracker = (
  logger?: Logger,
  options?: {
    now?: () => number;
    cwd?: string;
  }
): InventoryLotTracker => {
  const tracker = new InventoryLotTracker();

  for (const lot of loadConfiguredInventoryLotSeed(logger, options)) {
    tracker.addLot(lot);
  }

  return tracker;
};
