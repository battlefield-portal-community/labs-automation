import type { Automation, AutomationContext, AutomationStatus } from "../core/automation.ts";
import { KaneoAuthError, type KaneoUser } from "../core/kaneo.ts";
import { startListener, type Listener } from "../core/pg-listen.ts";
import { errorMessage } from "../core/logger.ts";

export const AUTO_JOIN_CHANNEL = "kaneo_new_user";
const PAGE_SIZE = 100;

export type AutoJoinDeps = {
  /** Injected in tests so notifications can be exercised without Postgres. */
  startListener?: typeof startListener;
};

export function createAutoJoinAutomation(deps: AutoJoinDeps = {}): Automation {
  const openListener = deps.startListener ?? startListener;
  let context: AutomationContext | null = null;
  let listener: Listener | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const counters = {
    notified: 0,
    added: 0,
    alreadyMember: 0,
    failures: 0,
  };
  let authOk = true;
  let lastReconcileAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAt: string | null = null;

  const noteFailure = (message: string) => {
    counters.failures++;
    lastError = message;
    lastFailureAt = new Date().toISOString();
  };

  const status = (): AutomationStatus => {
    const listening = listener?.state().connected ?? false;
    return {
      name: "auto-join",
      healthy: listening && authOk,
      detail: {
        listening,
        authOk,
        ...counters,
        lastReconcileAt,
        lastError,
        lastFailureAt,
        workspaceId: context?.config.kaneo.workspaceId ?? null,
        role: context?.config.kaneo.workspaceRole ?? null,
      },
    };
  };

  const requireContext = (): AutomationContext => {
    if (!context) throw new Error("auto-join was used before start()");
    return context;
  };

  const markAuthOk = () => {
    if (!authOk) requireContext().logger.info("auth recovered");
    authOk = true;
    // `failures` is cumulative for the process lifetime; `lastError` is the
    // current signal, cleared by the next success.
    lastError = null;
  };

  const handleError = (error: unknown) => {
    noteFailure(errorMessage(error));
    if (error instanceof KaneoAuthError) {
      authOk = false;
      requireContext().logger.error("auth rejected — mint a new token with `npm run device-auth`", {
        error: errorMessage(error),
      });
      return;
    }
    requireContext().logger.error("job failed", { error: errorMessage(error) });
  };

  const addMember = async (userId: string, label: string): Promise<void> => {
    const { config, kaneo, logger } = requireContext();
    const result = await kaneo.addWorkspaceMember(config.kaneo.workspaceId, userId, config.kaneo.workspaceRole);
    markAuthOk();
    if (result === "added") counters.added++;
    else counters.alreadyMember++;
    logger.info("account joined", { userId, email: label, result, role: config.kaneo.workspaceRole });
  };

  /** Notification payload: {"id": "...", "email": "..."} (raw id tolerated). */
  const handleNotification = async (payload: string): Promise<void> => {
    const parsed = parsePayload(payload);
    if (!parsed) {
      requireContext().logger.warn("ignoring unparsable notification", { payload: payload.slice(0, 200) });
      return;
    }
    counters.notified++;
    await addMember(parsed.id, parsed.email ?? parsed.id);
  };

  const reconcile = async (): Promise<void> => {
    const { config, kaneo, logger } = requireContext();
    try {
      const members = await kaneo.listWorkspaceMemberIds(config.kaneo.workspaceId);

      let seen = 0;
      let skipped = 0;
      let added = 0;

      for (let page = 1; ; page++) {
        const { users, total } = await kaneo.listUsers(page, PAGE_SIZE);
        for (const user of users) {
          seen++;
          if (!shouldJoin(user, members, config.skipInstanceAdmins)) {
            skipped++;
            continue;
          }
          await addMember(user.id, user.email);
          members.add(user.id);
          added++;
        }
        if (users.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
      }

      lastReconcileAt = new Date().toISOString();
      markAuthOk();
      logger.info("reconcile done", { seen, skipped, added, members: members.size });
    } catch (error) {
      noteFailure(errorMessage(error));
      if (error instanceof KaneoAuthError) {
        authOk = false;
        logger.error("reconcile: auth rejected — mint a new token with `npm run device-auth`", {
          error: errorMessage(error),
        });
        return;
      }
      logger.error("reconcile failed", { error: errorMessage(error) });
    }
  };

  const enqueue = (payload: string) => {
    chain = chain.then(() => handleNotification(payload)).catch(handleError);
  };

  return {
    name: "auto-join",

    start: (ctx) => {
      context = ctx;
      const reconcileMs = ctx.config.reconcileMinutes * 60_000;

      listener = openListener({
        settings: ctx.config.database,
        channel: AUTO_JOIN_CHANNEL,
        onPayload: enqueue,
        logger: ctx.logger.child({ automation: "auto-join" }),
      });

      // Heals notifications lost while we were down, and keeps the session token
      // sliding forward so an idle instance never expires it.
      void reconcile();
      timer = setInterval(() => void reconcile(), reconcileMs);
    },

    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await chain.catch(() => {});
      await listener?.close();
      listener = null;
    },

    status,
  };
}

export function parsePayload(payload: string): { id: string; email?: string } | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown; email?: unknown };
      if (typeof parsed.id !== "string" || parsed.id === "") return null;
      return typeof parsed.email === "string" ? { id: parsed.id, email: parsed.email } : { id: parsed.id };
    } catch {
      return null;
    }
  }

  return { id: trimmed };
}

export function shouldJoin(user: KaneoUser, members: Set<string>, skipInstanceAdmins: boolean): boolean {
  if (!user.id) return false;
  if (user.isAnonymous === true) return false;
  if (user.banned === true) return false;
  if (members.has(user.id)) return false;
  if (skipInstanceAdmins && user.role === "admin") return false;
  return true;
}
