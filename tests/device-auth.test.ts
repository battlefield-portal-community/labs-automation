import assert from "node:assert/strict";
import { test } from "node:test";
import { mintToken } from "../src/cli/device-auth.ts";

type Reply = { status: number; body: unknown };

/** Minimal stand-in for the device-authorization endpoints. */
function stubDeviceFlow(replies: Reply[]): { prompts: string[]; restore: () => void } {
  const prompts: string[] = [];
  const original = globalThis.fetch;
  let index = 0;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    const reply: Reply = path.includes("/auth/device/code")
      ? {
          status: 200,
          body: {
            device_code: "dev-code",
            user_code: "ABCD-1234",
            verification_uri: "https://kaneo.test/device",
            verification_uri_complete: "https://kaneo.test/device?user_code=ABCD-1234",
            expires_in: 600,
            interval: 1,
          },
        }
      : (replies[index++] ?? { status: 400, body: { error: "invalid_request" } });

    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;

  return { prompts, restore: () => (globalThis.fetch = original) };
}

test("prints the prompt, waits out authorization_pending, returns the token", async () => {
  const stub = stubDeviceFlow([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 200, body: { access_token: "session-token", expires_in: 604800 } },
  ]);

  try {
    let prompt: { userCode: string; verificationUri: string } | undefined;
    const result = await mintToken({
      apiUrl: "https://kaneo.test/api",
      clientId: "kaneo-cli",
      onPrompt: (value) => {
        prompt = value;
      },
      sleep: async () => {},
    });

    assert.equal(result.token, "session-token");
    assert.equal(result.expiresIn, 604800);
    assert.equal(prompt?.userCode, "ABCD-1234");
    assert.equal(prompt?.verificationUri, "https://kaneo.test/device?user_code=ABCD-1234");
  } finally {
    stub.restore();
  }
});

test("a denied request fails loudly", async () => {
  const stub = stubDeviceFlow([{ status: 400, body: { error: "access_denied", error_description: "user denied" } }]);
  try {
    await assert.rejects(
      () => mintToken({ apiUrl: "https://kaneo.test/api", clientId: "kaneo-cli", onPrompt: () => {}, sleep: async () => {} }),
      /access_denied/,
    );
  } finally {
    stub.restore();
  }
});

test("an expired device code stops the loop", async () => {
  const stub = stubDeviceFlow([
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "expired_token" } },
  ]);
  try {
    await assert.rejects(
      () => mintToken({ apiUrl: "https://kaneo.test/api", clientId: "kaneo-cli", onPrompt: () => {}, sleep: async () => {} }),
      /expired_token/,
    );
  } finally {
    stub.restore();
  }
});

test("a rejected client id surfaces the status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(
      () => mintToken({ apiUrl: "https://kaneo.test/api", clientId: "nope", onPrompt: () => {}, sleep: async () => {} }),
      /device code request failed: 400/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
