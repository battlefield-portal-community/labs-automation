import http from "node:http";
import type { AutomationStatus } from "./automation.ts";
import type { Logger } from "./logger.ts";

export type HealthSnapshot = {
  healthy: boolean;
  startedAt: string;
  automations: AutomationStatus[];
};

export type HealthServerOptions = {
  port: number;
  getStatuses: () => AutomationStatus[];
  logger: Logger;
  startedAt?: string;
};

export type HealthServer = {
  snapshot: () => HealthSnapshot;
  /** The bound port — useful when 0 was requested (tests). */
  port: () => number;
  close: () => Promise<void>;
};

/**
 * Two endpoints, both plain JSON:
 *   GET /healthz — 200 when every automation is healthy, 503 otherwise (for the
 *                  container healthcheck, so an expired token shows up in `docker ps`)
 *   GET /status  — always 200 with per-automation detail
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const startedAt = options.startedAt ?? new Date().toISOString();

  const snapshot = (): HealthSnapshot => {
    const automations = options.getStatuses();
    return {
      healthy: automations.every((automation) => automation.healthy),
      startedAt,
      automations,
    };
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = request.url ?? "/";

      if (url === "/healthz" || url === "/status") {
        const body = snapshot();
        const status = url === "/healthz" ? (body.healthy ? 200 : 503) : 200;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
        return;
      }

      if (url === "/") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "kaneo-labs-automation", endpoints: ["/healthz", "/status"] }));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });

    server.once("error", reject);
    server.listen(options.port, "0.0.0.0", () => {
      options.logger.info("health server", { port: options.port });
      const address = server.address();
      resolve({
        snapshot,
        port: () => (typeof address === "object" && address !== null ? address.port : options.port),
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
