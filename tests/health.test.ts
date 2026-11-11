import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutomationStatus } from "../src/core/automation.ts";
import { startHealthServer } from "../src/core/health.ts";
import { silentLogger } from "./support/fakes.ts";

const healthy: AutomationStatus = { name: "auto-join", healthy: true, detail: { added: 2 } };

test("serves 200 while every automation is healthy", async () => {
  const server = await startHealthServer({ port: 0, getStatuses: () => [healthy], logger: silentLogger });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port()}/healthz`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { healthy: boolean; automations: AutomationStatus[] };
    assert.equal(body.healthy, true);
    assert.equal(body.automations.length, 1);
  } finally {
    await server.close();
  }
});

test("serves 503 with detail once an automation is unhealthy", async () => {
  const unhealthy: AutomationStatus = { name: "auto-join", healthy: false, detail: { authOk: false } };
  const server = await startHealthServer({ port: 0, getStatuses: () => [unhealthy], logger: silentLogger });
  try {
    const healthz = await fetch(`http://127.0.0.1:${server.port()}/healthz`);
    assert.equal(healthz.status, 503);

    // /status stays 200 so a human can read why.
    const status = await fetch(`http://127.0.0.1:${server.port()}/status`);
    assert.equal(status.status, 200);
    const body = (await status.json()) as { healthy: boolean; automations: AutomationStatus[] };
    assert.equal(body.healthy, false);
    assert.equal(body.automations[0]?.detail.authOk, false);
  } finally {
    await server.close();
  }
});

test("unknown paths are 404 and / lists the endpoints", async () => {
  const server = await startHealthServer({ port: 0, getStatuses: () => [healthy], logger: silentLogger });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port()}/nope`)).status, 404);
    const index = await fetch(`http://127.0.0.1:${server.port()}/`);
    assert.equal(index.status, 200);
  } finally {
    await server.close();
  }
});
