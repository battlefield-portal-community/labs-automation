import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { Logger } from "./logger.ts";
import type { PostgresSettings } from "./config.ts";

export const MIGRATION_TABLE = "labs_automation_migration";

export type MigrationResult = { applied: string[]; skipped: string[] };

/**
 * Applies every `sql/*.sql` file that has not been recorded yet, in filename
 * order, each in its own transaction.
 *
 * The files stay re-runnable on purpose: a fresh Kaneo database, a restore, or
 * someone re-running by hand should never need a special state.
 */
export async function runMigrations(options: {
  settings: PostgresSettings;
  directory: string;
  logger: Logger;
  Client?: typeof pg.Client;
}): Promise<MigrationResult> {
  const Client = options.Client ?? pg.Client;
  const client = new Client(options.settings);
  await client.connect();

  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = (await readdir(options.directory))
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    const { rows } = await client.query<{ name: string }>(`SELECT name FROM ${MIGRATION_TABLE}`);
    const applied = new Set(rows.map((row) => row.name));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      if (applied.has(file)) {
        result.skipped.push(file);
        continue;
      }

      const sql = await readFile(path.join(options.directory, file), "utf8");
      options.logger.info("applying migration", { file });

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO ${MIGRATION_TABLE} (name) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
        await client.query("COMMIT");
        result.applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
    }

    return result;
  } finally {
    await client.end().catch(() => {});
  }
}
