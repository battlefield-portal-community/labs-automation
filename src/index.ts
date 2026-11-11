import path from "node:path";
import { AUTOMATIONS, AUTOMATION_NAMES } from "./automations/index.ts";
import type { Automation } from "./core/automation.ts";
import { ConfigError, loadConfig, type Config } from "./core/config.ts";
import { startHealthServer } from "./core/health.ts";
import { KaneoAdminClient } from "./core/kaneo.ts";
import { createLogger, errorMessage } from "./core/logger.ts";
import { runMigrations } from "./core/migrations.ts";

const SQL_DIR = process.env.SQL_DIR ?? path.join(import.meta.dirname, "..", "sql");

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      createLogger({ level: "error" }).error("configuration", { problems: error.problems });
      process.exit(1);
    }
    throw error;
  }

  const unknown = config.automations.filter((name) => !(name in AUTOMATIONS));
  if (unknown.length > 0) {
    createLogger({ level: "error" }).error("unknown automation", { unknown, available: AUTOMATION_NAMES });
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  const kaneo = new KaneoAdminClient({
    apiUrl: config.kaneo.apiUrl,
    token: config.kaneo.token,
    logger,
  });

  if (!config.kaneo.token) {
    logger.warn(
      "no admin token configured — automations will fail with 401 until one is set (run `device-auth`, then restart)",
      { hint: "KANEO_ADMIN_TOKEN or KANEO_ADMIN_TOKEN_FILE" },
    );
  }

  logger.info("starting", {
    automations: config.automations,
    apiUrl: config.kaneo.apiUrl,
    workspaceId: config.kaneo.workspaceId,
    role: config.kaneo.workspaceRole,
    reconcileMinutes: config.reconcileMinutes,
    skipInstanceAdmins: config.skipInstanceAdmins,
  });

  if (config.migrateOnStart) {
    const result = await runMigrations({ settings: config.database, directory: SQL_DIR, logger });
    logger.info("migrations", { applied: result.applied, skipped: result.skipped.length });
  }

  const automations: Automation[] = config.automations.map((name) => {
    const factory = AUTOMATIONS[name];
    if (!factory) throw new Error(`unknown automation: ${name}`);
    return factory();
  });

  for (const automation of automations) {
    automation.start({
      config,
      kaneo,
      logger: logger.child({ automation: automation.name }),
      database: config.database,
    });
  }

  const health = await startHealthServer({
    port: config.healthPort,
    getStatuses: () => automations.map((automation) => automation.status()),
    logger,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });

    for (const automation of automations) {
      try {
        await automation.stop();
      } catch (error) {
        logger.error("stop failed", { automation: automation.name, error: errorMessage(error) });
      }
    }
    await health.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  createLogger({ level: "error" }).error("fatal", { error: errorMessage(error) });
  process.exit(1);
});
