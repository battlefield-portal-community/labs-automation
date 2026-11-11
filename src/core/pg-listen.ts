import pg from "pg";
import type { Logger } from "./logger.ts";
import type { PostgresSettings } from "./config.ts";

export type ListenState = { connected: boolean; channel: string };

export type Listener = {
  state: () => ListenState;
  close: () => Promise<void>;
};

export type ListenerOptions = {
  settings: PostgresSettings;
  channel: string;
  onPayload: (payload: string) => void;
  logger: Logger;
  /** Injected in tests. */
  Client?: typeof pg.Client;
  reconnectDelayMs?: number;
};

/**
 * A dedicated connection that runs LISTEN and reconnects forever.
 *
 * LISTEN/NOTIFY has no delivery guarantee: notifications sent while this
 * connection is down are lost. Callers are expected to reconcile periodically
 * so a missed notification is a delay, not a lost account.
 */
export function startListener(options: ListenerOptions): Listener {
  const channel = options.channel;
  const Client = options.Client ?? pg.Client;
  const reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
  let client: pg.Client | null = null;
  let connected = false;
  let closed = false;

  const logger = options.logger;

  const run = async (): Promise<void> => {
    while (!closed) {
      try {
        const candidate = new Client(options.settings);
        await candidate.connect();
        await candidate.query(`LISTEN ${channel}`);
        client = candidate;
        connected = true;
        logger.info("listening", { channel });

        await new Promise<void>((resolve) => {
          candidate.on("notification", (message: pg.Notification) => {
            if (message.channel === channel) options.onPayload(message.payload ?? "");
          });
          candidate.on("error", (error: Error) => {
            logger.error("postgres error", { error: error.message });
            resolve();
          });
          candidate.on("end", () => resolve());
        });
      } catch (error) {
        logger.error("listen failed", { error: (error as Error).message });
      }

      connected = false;
      client = null;
      if (closed) return;
      await delay(reconnectDelayMs);
    }
  };

  void run();

  return {
    state: () => ({ connected, channel }),
    close: async () => {
      closed = true;
      const current = client;
      client = null;
      connected = false;
      if (current) {
        try {
          await current.end();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
