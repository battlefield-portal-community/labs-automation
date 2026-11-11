import { readFileSync } from "node:fs";

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export type PostgresSettings = {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

export type Config = {
  /** Automations to run. Unknown names are a startup error. */
  automations: string[];
  kaneo: {
    apiUrl: string;
    token: string;
    workspaceId: string;
    workspaceRole: string;
  };
  database: PostgresSettings;
  reconcileMinutes: number;
  skipInstanceAdmins: boolean;
  healthPort: number;
  logLevel: "debug" | "info" | "warn" | "error";
  migrateOnStart: boolean;
};

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const apiUrl = (env.KANEO_API_URL ?? "http://kaneo:5173/api").replace(/\/+$/, "");
  const workspaceId = (env.KANEO_WORKSPACE_ID ?? "").trim();
  if (!workspaceId) problems.push("KANEO_WORKSPACE_ID is required");

  const token = readToken(env, problems);

  const reconcileMinutes = readNumber(env.RECONCILE_INTERVAL_MIN, 10, "RECONCILE_INTERVAL_MIN", problems, {
    min: 1,
  });
  const healthPort = readNumber(env.HEALTH_PORT, 8080, "HEALTH_PORT", problems, { min: 1, max: 65535 });

  const logLevel = (env.LOG_LEVEL ?? "info").trim();
  if (!isLogLevel(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);

  const automations = (env.AUTOMATIONS ?? "auto-join")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const database = collectPostgres(env, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    automations,
    kaneo: {
      apiUrl,
      token,
      workspaceId,
      workspaceRole: (env.KANEO_WORKSPACE_ROLE ?? "member").trim(),
    },
    database,
    reconcileMinutes,
    skipInstanceAdmins: env.SKIP_INSTANCE_ADMINS === "true",
    healthPort,
    logLevel: logLevel as Config["logLevel"],
    migrateOnStart: env.MIGRATE_ON_START === "true",
  };
}

function readToken(env: NodeJS.ProcessEnv, problems: string[]): string {
  const inline = (env.KANEO_ADMIN_TOKEN ?? "").trim();
  if (inline) return inline;

  const file = (env.KANEO_ADMIN_TOKEN_FILE ?? "").trim();
  if (!file) {
    problems.push("set KANEO_ADMIN_TOKEN_FILE (preferred) or KANEO_ADMIN_TOKEN; mint one with `npm run device-auth`");
    return "";
  }
  try {
    const value = readFileSync(file, "utf8").trim();
    if (!value) problems.push(`KANEO_ADMIN_TOKEN_FILE (${file}) is empty`);
    return value;
  } catch (error) {
    problems.push(`cannot read KANEO_ADMIN_TOKEN_FILE (${file}): ${(error as Error).message}`);
    return "";
  }
}

/** Postgres settings alone — used by `migrate`, which needs no Kaneo token. */
export function loadDatabaseSettings(env: NodeJS.ProcessEnv = process.env): PostgresSettings {
  const problems: string[] = [];
  const settings = collectPostgres(env, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return settings;
}

function collectPostgres(env: NodeJS.ProcessEnv, problems: string[]): PostgresSettings {
  const connectionString = (env.DATABASE_URL ?? "").trim();
  if (connectionString) return { connectionString };

  if (!env.PGHOST && !env.PGHOSTADDR) {
    problems.push("set DATABASE_URL, or PGHOST (plus PGUSER/PGPASSWORD/PGDATABASE) so the listener can LISTEN");
    return {};
  }

  const port = env.PGPORT ? Number(env.PGPORT) : undefined;
  if (env.PGPORT && (!Number.isInteger(port) || (port ?? 0) <= 0)) {
    problems.push("PGPORT must be a positive integer");
  }

  return {
    ...(env.PGHOST ? { host: env.PGHOST } : {}),
    ...(port === undefined ? {} : { port }),
    ...(env.PGUSER ? { user: env.PGUSER } : {}),
    ...(env.PGPASSWORD ? { password: env.PGPASSWORD } : {}),
    ...(env.PGDATABASE ? { database: env.PGDATABASE } : {}),
  };
}

function readNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
  bounds: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${name} must be a number`);
    return fallback;
  }
  if (bounds.min !== undefined && value < bounds.min) problems.push(`${name} must be >= ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) problems.push(`${name} must be <= ${bounds.max}`);
  return value;
}

function isLogLevel(value: string): value is Config["logLevel"] {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
