import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "pino";

import type { MarketModeFilter, OperatorControl } from "../core/operator-control.js";

type FlattenCallback = () => Promise<void>;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
};

/**
 * Minimal localhost-only HTTP control plane.
 *
 * Endpoints:
 *   GET  /status                        — current operator state
 *   POST /pause                         — stop posting new quotes
 *   POST /resume                        — resume normal operation
 *   POST /flatten                       — cancel all quotes + reduce inventory
 *   POST /market/:conditionId/disable   — disable one market
 *   POST /market/:conditionId/enable    — enable one market
 *   POST /filter/:mode                  — set all | live-only | pregame-only
 */
export const startControlServer = (
  port: number,
  operatorControl: OperatorControl,
  onFlatten: FlattenCallback,
  logger: Logger
): void => {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      void handleRequest(req, res, operatorControl, onFlatten, logger);
    }
  );

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port }, "Operator control server listening on localhost.");
  });

  server.on("error", (err) => {
    logger.error({ err }, "Operator control server error.");
  });
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  control: OperatorControl,
  onFlatten: FlattenCallback,
  logger: Logger
): Promise<void> => {
  const method = req.method?.toUpperCase() ?? "GET";
  const url = req.url ?? "/";

  logger.debug({ method, url }, "Control server request.");

  try {
    if (method === "GET" && url === "/status") {
      sendJson(res, 200, control.getStatus());
      return;
    }

    if (method === "POST" && url === "/pause") {
      control.pause();
      logger.warn("Operator PAUSED all market-making via control API.");
      sendJson(res, 200, { ok: true, paused: true });
      return;
    }

    if (method === "POST" && url === "/resume") {
      control.resume();
      logger.info("Operator RESUMED market-making via control API.");
      sendJson(res, 200, { ok: true, paused: false });
      return;
    }

    if (method === "POST" && url === "/flatten") {
      logger.warn("Operator triggered FLATTEN via control API — cancelling all quotes and reducing inventory.");
      sendJson(res, 202, { ok: true, message: "flatten initiated" });
      await onFlatten();
      return;
    }

    // POST /market/:conditionId/disable  or  /enable
    const marketMatch = /^\/market\/([^/]+)\/(disable|enable)$/.exec(url);
    if (method === "POST" && marketMatch) {
      const conditionId = decodeURIComponent(marketMatch[1]!);
      const action = marketMatch[2] as "disable" | "enable";

      if (action === "disable") {
        control.disableMarket(conditionId);
        logger.warn({ conditionId }, "Market disabled via control API.");
      } else {
        control.enableMarket(conditionId);
        logger.info({ conditionId }, "Market re-enabled via control API.");
      }

      sendJson(res, 200, { ok: true, conditionId, action });
      return;
    }

    // POST /filter/:mode
    const filterMatch = /^\/filter\/(all|live-only|pregame-only)$/.exec(url);
    if (method === "POST" && filterMatch) {
      const mode = filterMatch[1] as MarketModeFilter;
      control.setModeFilter(mode);
      logger.info({ mode }, "Market mode filter updated via control API.");
      sendJson(res, 200, { ok: true, modeFilter: mode });
      return;
    }

    await readBody(req); // drain
    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    logger.error({ err }, "Control server handler error.");
    sendJson(res, 500, { error: "internal_error" });
  }
};
