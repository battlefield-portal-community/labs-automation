import type { Config } from "../../src/core/config.ts";
import type { KaneoAdminClient } from "../../src/core/kaneo.ts";
import type { Listener, ListenerOptions } from "../../src/core/pg-listen.ts";
import { createLogger } from "../../src/core/logger.ts";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    automations: ["auto-join"],
    kaneo: {
      apiUrl: "http://kaneo.test/api",
      token: "test-token",
      workspaceId: "ws1",
      workspaceRole: "member",
    },
    database: { connectionString: "postgres://stub" },
    reconcileMinutes: 60,
    skipInstanceAdmins: false,
    healthPort: 0,
    logLevel: "error",
    migrateOnStart: false,
    ...overrides,
  };
}

export const silentLogger = createLogger({ level: "error", write: () => {} });

/** Captures the listener a caller would start, so tests can push notifications. */
export function captureListener(): {
  startListener: (options: ListenerOptions) => Listener;
  options: () => ListenerOptions;
  emit: (payload: string) => void;
  closed: () => boolean;
} {
  const captured: ListenerOptions[] = [];
  let connected = true;
  let isClosed = false;

  return {
    startListener: (options) => {
      captured.push(options);
      return {
        state: () => ({ connected, channel: options.channel }),
        close: async () => {
          connected = false;
          isClosed = true;
        },
      };
    },
    options: () => {
      const first = captured[0];
      if (!first) throw new Error("no listener was started");
      return first;
    },
    emit: (payload) => {
      const first = captured[0];
      if (!first) throw new Error("no listener was started");
      first.onPayload(payload);
    },
    closed: () => isClosed,
  };
}

export type KaneoStub = {
  addCalls: Array<{ workspaceId: string; userId: string; role: string }>;
  client: KaneoAdminClient;
};

export function stubKaneo(options: {
  users?: Array<Record<string, unknown>>;
  total?: number;
  members?: string[];
  onAdd?: (userId: string) => "added" | "already-member";
}): KaneoStub {
  const addCalls: KaneoStub["addCalls"] = [];
  const members = new Set(options.members ?? []);

  const client = {
    async addWorkspaceMember(workspaceId: string, userId: string, role: string) {
      addCalls.push({ workspaceId, userId, role });
      const result = options.onAdd?.(userId) ?? (members.has(userId) ? "already-member" : "added");
      members.add(userId);
      return result;
    },
    async listWorkspaceMemberIds() {
      return new Set(members);
    },
    async listUsers(page: number, limit: number) {
      const users = options.users ?? [];
      const start = (page - 1) * limit;
      return { users: users.slice(start, start + limit) as never, total: options.total ?? users.length };
    },
  } as unknown as KaneoAdminClient;

  return { addCalls, client };
}

export const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
