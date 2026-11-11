import type { ClobClient } from "@polymarket/clob-client-v2";
import type { Logger } from "pino";

import { config } from "../config.js";

export class OrderHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private heartbeatId: string | null = null;

  constructor(
    private readonly client: ClobClient,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (!config.ws.enableOrderHeartbeat || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, config.ws.orderHeartbeatMs);

    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.heartbeatId = null;
  }

  private async tick(): Promise<void> {
    try {
      const response = await this.client.postHeartbeat(this.heartbeatId ?? undefined);
      this.heartbeatId = response.heartbeat_id;
      this.logger.debug(
        {
          heartbeatId: this.heartbeatId,
          intervalMs: config.ws.orderHeartbeatMs
        },
        "Posted order heartbeat."
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Order heartbeat failed.");
    }
  }
}
