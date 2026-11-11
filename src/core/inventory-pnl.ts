import type { Logger } from "pino";

import type { InventoryCloseResult } from "./inventory-lot-tracker.js";
import type { PnLEngineLike, RiskManagerLike } from "./types.js";

export type ExecutionQualityRecord = {
  createdAtMs?: number;
  firstFillAtMs?: number;
  requoteCount?: number;
  partialFillCount?: number;
  failureReason?: string;
};

type RecordInventoryCloseInput = {
  closeResult: InventoryCloseResult;
  pnlEngine: PnLEngineLike;
  riskManager?: RiskManagerLike;
  logger?: Logger;
  closeReason: string;
  executionSource: string;
  /** Optional execution quality data from the order that triggered this close. */
  executionQuality?: ExecutionQualityRecord;
};

export const recordInventoryCloseResult = ({
  closeResult,
  pnlEngine,
  riskManager,
  logger,
  closeReason,
  executionSource,
  executionQuality
}: RecordInventoryCloseInput): void => {
  if (closeResult.pieces.length === 0) {
    if (closeResult.closedUnknownShares > 0) {
      logger?.warn(
        {
          executionSource,
          closeReason,
          closedUnknownShares: closeResult.closedUnknownShares,
          unrecognizedProceedsUsdc: closeResult.unrecognizedProceedsUsdc
        },
        "Inventory close could not be recognized in PnL because no tracked cost basis was available."
      );
    }

    return;
  }

  const realizedPnlUsdc = closeResult.pieces.reduce(
    (total, piece) => total + piece.realizedPnlUsdc,
    0
  );

  for (const piece of closeResult.pieces) {
    pnlEngine.recordTrade({
      id: `${executionSource}:${piece.lotId}:${piece.closedAtMs}:${piece.shares.toFixed(5)}`,
      strategy: piece.strategy,
      marketScope: piece.marketScope,
      conditionId: piece.conditionId,
      realizedPnlUsdc: piece.realizedPnlUsdc,
      grossRealizedPnlUsdc: piece.realizedPnlUsdc,
      shares: piece.shares,
      openedAtMs: piece.openedAtMs,
      closedAtMs: piece.closedAtMs,
      createdAtMs: executionQuality?.createdAtMs,
      firstFillAtMs: executionQuality?.firstFillAtMs,
      requoteCount: executionQuality?.requoteCount,
      partialFillCount: executionQuality?.partialFillCount,
      failureReason: executionQuality?.failureReason,
      detail: closeReason,
      tags: [piece.strategy, "inventory-close", executionSource],
      metadata: {
        tokenId: piece.tokenId,
        outcome: piece.outcome,
        costBasisUsdc: Number(piece.costBasisUsdc.toFixed(8)),
        proceedsUsdc: Number(piece.proceedsUsdc.toFixed(8)),
        executionSource,
        ...piece.metadata
      }
    });
  }

  riskManager?.noteTradeClosed?.(
    realizedPnlUsdc,
    `inventory-close.${executionSource}`,
    closeReason
  );

  if (closeResult.closedUnknownShares > 0) {
    logger?.warn(
      {
        executionSource,
        closeReason,
        closedKnownShares: closeResult.closedKnownShares,
        closedUnknownShares: closeResult.closedUnknownShares,
        recognizedProceedsUsdc: closeResult.recognizedProceedsUsdc,
        unrecognizedProceedsUsdc: closeResult.unrecognizedProceedsUsdc
      },
      "Inventory close only had partial cost-basis coverage."
    );
  }
};
