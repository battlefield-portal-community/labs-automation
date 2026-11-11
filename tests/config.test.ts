import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig, loadDatabaseSettings } from "../src/core/config.ts";

const baseEnv = {
  KANEO_WORKSPACE_ID: "ws1",
  KANEO_ADMIN_TOKEN: "tok",
  DATABASE_URL: "postgres://kaneo:test@postgres:5432/kaneo",
};

test("minimal environment is enough", () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.kaneo.workspaceId, "ws1");
  assert.equal(config.kaneo.apiUrl, "http://kaneo:5173/api");
  assert.equal(config.kaneo.workspaceRole, "member");
  assert.equal(config.reconcileMinutes, 10);
  assert.equal(config.healthPort, 8080);
  assert.equal(config.skipInstanceAdmins, false);
  assert.equal(config.migrateOnStart, false);
  assert.deepEqual(config.automations, ["auto-join"]);
});

test("reports every problem at once", () => {
  assert.throws(
    () => loadConfig({ LOG_LEVEL: "loud" }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 4, error.problems.join(" | "));
      assert.match(error.message, /KANEO_WORKSPACE_ID/);
      assert.match(error.message, /KANEO_ADMIN_TOKEN_FILE/);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /LOG_LEVEL/);
      return true;
    },
  );
});

test("reads the token from a file when no inline value is set", () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "cfg-"));
  const file = path.join(dir, "token");
  writeFileSync(file, "  from-file\n");

  const config = loadConfig({ ...baseEnv, KANEO_ADMIN_TOKEN: "", KANEO_ADMIN_TOKEN_FILE: file });
  assert.equal(config.kaneo.token, "from-file");

  // Kaneo convention: the inline variable wins when both are set.
  const inline = loadConfig({ ...baseEnv, KANEO_ADMIN_TOKEN_FILE: file });
  assert.equal(inline.kaneo.token, "tok");
});

test("an empty token file is a configuration error", () => {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "cfg-"));
  const file = path.join(dir, "empty");
  writeFileSync(file, "\n");

  assert.throws(() => loadConfig({ ...baseEnv, KANEO_ADMIN_TOKEN: "", KANEO_ADMIN_TOKEN_FILE: file }), /is empty/);
});

test("PG* variables work when DATABASE_URL is absent", () => {
  const config = loadConfig({ ...baseEnv, DATABASE_URL: "", PGHOST: "db", PGPORT: "6432", PGUSER: "kaneo" });
  assert.deepEqual(config.database, { host: "db", port: 6432, user: "kaneo" });
});

test("numbers are validated with bounds", () => {
  assert.throws(() => loadConfig({ ...baseEnv, RECONCILE_INTERVAL_MIN: "0" }), /RECONCILE_INTERVAL_MIN must be >= 1/);
  assert.throws(() => loadConfig({ ...baseEnv, HEALTH_PORT: "70000" }), /HEALTH_PORT must be <= 65535/);
  assert.throws(() => loadConfig({ ...baseEnv, HEALTH_PORT: "http" }), /HEALTH_PORT must be a number/);
});

test("automations are parsed from a comma list", () => {
  const config = loadConfig({ ...baseEnv, AUTOMATIONS: "auto-join, other " });
  assert.deepEqual(config.automations, ["auto-join", "other"]);
});

test("flags are opt-in only", () => {
  const config = loadConfig({
    ...baseEnv,
    SKIP_INSTANCE_ADMINS: "TRUE",
    MIGRATE_ON_START: "1",
  });
  assert.equal(config.skipInstanceAdmins, false);
  assert.equal(config.migrateOnStart, false);
});

test("loadDatabaseSettings needs no Kaneo credentials", () => {
  const settings = loadDatabaseSettings({ DATABASE_URL: "postgres://x/y" });
  assert.deepEqual(settings, { connectionString: "postgres://x/y" });
  assert.throws(() => loadDatabaseSettings({}), /DATABASE_URL/);
});
