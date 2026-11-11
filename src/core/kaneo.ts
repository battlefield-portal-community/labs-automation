import type { Logger } from "./logger.ts";

/** The API rejected our credentials or permissions — retrying cannot help. */
export class KaneoAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Kaneo rejected the session (${status}): ${detail}`);
    this.name = "KaneoAuthError";
    this.status = status;
  }
}

export type KaneoUser = {
  id: string;
  email: string;
  name?: string;
  role?: string | null;
  banned?: boolean;
  isAnonymous?: boolean;
};

export type KaneoUserPage = { users: KaneoUser[]; total: number };

export type AddMemberResult = "added" | "already-member";

export type KaneoAdminClientOptions = {
  apiUrl: string;
  token: string;
  logger?: Logger;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
};

const DEFAULT_RETRY_DELAYS_MS = [500, 1500];

/**
 * Thin client over the Kaneo admin API. Only the endpoints this image needs.
 *
 * Everything under /api/admin requires a real session: Kaneo rejects API keys
 * there (`requireUserSession`), which is why the token comes from the device
 * authorization flow instead.
 */
export class KaneoAdminClient {
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #logger: Logger | undefined;
  readonly #fetch: typeof fetch;
  readonly #retryDelaysMs: number[];

  constructor(options: KaneoAdminClientOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async addWorkspaceMember(workspaceId: string, userId: string, role: string): Promise<AddMemberResult> {
    const path = `/admin/workspaces/${encodeURIComponent(workspaceId)}/members`;
    for (let attempt = 0; ; attempt++) {
      const response = await this.#request(path, {
        method: "POST",
        body: JSON.stringify({ userId, role }),
      });

      if (response.status === 409) return "already-member";
      if (response.ok) return "added";

      const detail = await readDetail(response);
      if (isRetryable(response.status) && attempt < this.#retryDelaysMs.length) {
        await delay(this.#retryDelaysMs[attempt] ?? 0);
        continue;
      }
      throw new Error(`add member ${userId}: ${response.status} ${detail}`);
    }
  }

  async listWorkspaceMemberIds(workspaceId: string): Promise<Set<string>> {
    const response = await this.#request(`/admin/workspaces/${encodeURIComponent(workspaceId)}/members`);
    if (!response.ok) {
      throw new Error(`list members: ${response.status} ${await readDetail(response)}`);
    }
    const body = (await response.json()) as Array<{ userId?: string }>;
    if (!Array.isArray(body)) throw new Error("list members: unexpected response shape");
    return new Set(body.map((member) => member.userId).filter((id): id is string => Boolean(id)));
  }

  async listUsers(page: number, limit: number): Promise<KaneoUserPage> {
    const response = await this.#request(`/admin/users?page=${page}&limit=${limit}`);
    if (!response.ok) {
      throw new Error(`list users page ${page}: ${response.status} ${await readDetail(response)}`);
    }
    const body = (await response.json()) as Partial<KaneoUserPage>;
    if (!Array.isArray(body.users)) throw new Error("list users: unexpected response shape");
    return { users: body.users, total: typeof body.total === "number" ? body.total : body.users.length };
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#fetch(`${this.#apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new KaneoAuthError(response.status, await readDetail(response));
    }
    if (!response.ok && !isRetryable(response.status)) {
      this.#logger?.debug("kaneo request failed", { path, status: response.status });
    }
    return response;
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function readDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
