/**
 * Applies the SQL this image needs (triggers, functions) to the Kaneo database.
 *
 *   docker compose run --rm automations migrate
 *
 * Tracks applied files in `labs_automation_migration`; files are re-runnable, so
 * a fresh database or a restored dump is handled without extra steps.
 */
import path from "node:path";
import { ConfigError, loadDatabaseSettings } from "../core/config.ts";
import { createLogger, errorMessage } from "../core/logger.ts";
import { runMigrations } from "../core/migrations.ts";

const SQL_DIR = process.env.SQL_DIR ?? path.join(import.meta.dirname, "..", "..", "sql");
const logger = createLogger({ level: (process.env.LOG_LEVEL as "debug" | "info") ?? "info" });

async function main(): Promise<void> {
  const settings = loadDatabaseSettings();
  const result = await runMigrations({ settings, directory: SQL_DIR, logger });

  logger.info("migrate finished", {
    applied: result.applied,
    skipped: result.skipped,
    directory: SQL_DIR,
  });
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    logger.error("configuration", { problems: error.problems });
  } else {
    logger.error("migrate failed", { error: errorMessage(error) });
  }
  process.exit(1);
});
