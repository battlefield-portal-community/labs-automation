import assert from "node:assert/strict";
import { test } from "node:test";
import { KaneoAdminClient, KaneoAuthError } from "../src/core/kaneo.ts";

type Call = { url: string; init: RequestInit };

function stubFetch(responder: (call: Call, index: number) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function client(fetchImpl: typeof fetch, retryDelaysMs: number[] = []) {
  return new KaneoAdminClient({
    apiUrl: "https://kaneo.test/api/",
    token: "secret-token",
    fetchImpl,
    retryDelaysMs,
  });
}

test("adds a member with a bearer token and the configured role", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(200, [{ userId: "u1" }]));
  const result = await client(fetchImpl).addWorkspaceMember("ws1", "u1", "member");

  assert.equal(result, "added");
  assert.equal(calls[0]?.url, "https://kaneo.test/api/admin/workspaces/ws1/members");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { userId: "u1", role: "member" });
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer secret-token");
});

test("409 means the user is already a member", async () => {
  const { fetchImpl } = stubFetch(() => json(409, { message: "already a member" }));
  assert.equal(await client(fetchImpl).addWorkspaceMember("ws1", "u1", "member"), "already-member");
});

test("401 and 403 raise KaneoAuthError, without retrying", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl, calls } = stubFetch(() => json(status, { code: "SESSION_REQUIRED" }));
    await assert.rejects(
      () => client(fetchImpl, [1, 1]).addWorkspaceMember("ws1", "u1", "member"),
      (error: unknown) => error instanceof KaneoAuthError && error.status === status,
    );
    assert.equal(calls.length, 1, "auth failures must not be retried");
  }
});

test("5xx and 429 are retried, then succeed", async () => {
  const { fetchImpl, calls } = stubFetch((_call, index) =>
    index === 0 ? json(503, { message: "unavailable" }) : json(200, []),
  );
  const result = await client(fetchImpl, [1, 1]).addWorkspaceMember("ws1", "u1", "member");

  assert.equal(result, "added");
  assert.equal(calls.length, 2);
});

test("retries are bounded and the last error is surfaced", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(500, { message: "boom" }));
  await assert.rejects(() => client(fetchImpl, [1, 1]).addWorkspaceMember("ws1", "u1", "member"), /500/);
  assert.equal(calls.length, 3);
});

test("400 is not retried", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(400, { message: "Unknown role" }));
  await assert.rejects(() => client(fetchImpl, [1, 1]).addWorkspaceMember("ws1", "u1", "nope"), /Unknown role/);
  assert.equal(calls.length, 1);
});

test("lists member ids, ignoring malformed rows", async () => {
  const { fetchImpl } = stubFetch(() => json(200, [{ userId: "u1" }, {}, { userId: null }]));
  const ids = await client(fetchImpl).listWorkspaceMemberIds("ws1");
  assert.deepEqual([...ids], ["u1"]);
});

test("lists users with paging metadata", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(200, { users: [{ id: "u1", email: "a@example.com" }], total: 42 }));
  const page = await client(fetchImpl).listUsers(2, 100);

  assert.equal(page.total, 42);
  assert.equal(page.users.length, 1);
  assert.equal(calls[0]?.url, "https://kaneo.test/api/admin/users?page=2&limit=100");
});

test("an unexpected users payload is an error, not an empty page", async () => {
  const { fetchImpl } = stubFetch(() => json(200, { error: "nope" }));
  await assert.rejects(() => client(fetchImpl).listUsers(1, 100), /unexpected response shape/);
});

test("a network failure names the cause and the host", async () => {
  const fetchImpl = (async () => {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = {
      code: "ENOTFOUND",
      message: "getaddrinfo ENOTFOUND kaneo",
      hostname: "kaneo",
      port: 5173,
    };
    throw error;
  }) as typeof fetch;

  await assert.rejects(
    () => client(fetchImpl).listWorkspaceMemberIds("ws1"),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /cannot reach Kaneo at https:\/\/kaneo\.test\/api/);
      assert.match(message, /ENOTFOUND/);
      assert.match(message, /kaneo:5173/);
      return true;
    },
  );
});

test("the api url trailing slash does not double up", async () => {
  const { fetchImpl, calls } = stubFetch(() => json(200, []));
  await client(fetchImpl).listWorkspaceMemberIds("ws1");
  assert.equal(calls[0]?.url, "https://kaneo.test/api/admin/workspaces/ws1/members");
});
