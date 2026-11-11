import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutoJoinAutomation, parsePayload, shouldJoin } from "../src/automations/auto-join.ts";
import { KaneoAuthError, type KaneoAdminClient } from "../src/core/kaneo.ts";
import { captureListener, silentLogger, stubKaneo, testConfig, tick } from "./support/fakes.ts";

const users = [
  { id: "u1", email: "a@example.com", role: "user" },
  { id: "u2", email: "b@example.com", role: "user" },
  { id: "guest", email: "guest@kaneo.app", isAnonymous: true },
  { id: "admin", email: "admin@example.com", role: "admin" },
  { id: "banned", email: "banned@example.com", banned: true },
  { id: "member", email: "existing@example.com" },
];

test("payload parsing tolerates the object payload and a bare id", () => {
  assert.deepEqual(parsePayload('{"id":"u1","email":"a@example.com"}'), { id: "u1", email: "a@example.com" });
  assert.deepEqual(parsePayload('{"id":"u1"}'), { id: "u1" });
  assert.deepEqual(parsePayload("  raw-id  "), { id: "raw-id" });
  assert.equal(parsePayload(""), null);
  assert.equal(parsePayload("   "), null);
  assert.equal(parsePayload("{not json"), null);
  assert.equal(parsePayload('{"email":"x@y.z"}'), null);
  assert.equal(parsePayload('{"id":""}'), null);
});

test("eligibility: guests, banned, existing members, optionally admins", () => {
  const members = new Set(["member"]);
  assert.equal(shouldJoin({ id: "u1", email: "a@example.com" }, members, false), true);
  assert.equal(shouldJoin({ id: "guest", email: "g@kaneo.app", isAnonymous: true }, members, false), false);
  assert.equal(shouldJoin({ id: "banned", email: "b@example.com", banned: true }, members, false), false);
  assert.equal(shouldJoin({ id: "member", email: "m@example.com" }, members, false), false);
  assert.equal(shouldJoin({ id: "admin", email: "a@example.com", role: "admin" }, members, true), false);
  assert.equal(shouldJoin({ id: "admin", email: "a@example.com", role: "admin" }, members, false), true);
});

test("reconcile adds everyone eligible and skips the rest", async () => {
  const kaneo = stubKaneo({ users, members: ["member"] });
  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });

  automation.start({
    config: testConfig(),
    kaneo: kaneo.client,
    logger: silentLogger,
    database: testConfig().database,
  });
  await tick(30);

  assert.deepEqual(
    kaneo.addCalls.map((call) => call.userId).sort(),
    ["admin", "u1", "u2"],
  );
  for (const call of kaneo.addCalls) {
    assert.equal(call.workspaceId, "ws1");
    assert.equal(call.role, "member");
  }

  const status = automation.status();
  assert.equal(status.healthy, true);
  assert.equal(status.detail.added, 3);
  assert.equal(status.detail.listening, true);
  assert.ok(status.detail.lastReconcileAt);

  await automation.stop();
  assert.equal(listener.closed(), true);
});

test("skipInstanceAdmins leaves administrators out", async () => {
  const kaneo = stubKaneo({ users, members: ["member"] });
  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });

  automation.start({
    config: testConfig({ skipInstanceAdmins: true }),
    kaneo: kaneo.client,
    logger: silentLogger,
    database: testConfig().database,
  });
  await tick(30);

  assert.deepEqual(kaneo.addCalls.map((call) => call.userId).sort(), ["u1", "u2"]);
  await automation.stop();
});

test("a notification joins the account immediately", async () => {
  const kaneo = stubKaneo({ users: [], members: ["member"] });
  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });

  automation.start({
    config: testConfig(),
    kaneo: kaneo.client,
    logger: silentLogger,
    database: testConfig().database,
  });
  await tick(20);

  listener.emit('{"id":"new1","email":"new@example.com"}');
  listener.emit("new2");
  await tick(30);

  assert.deepEqual(kaneo.addCalls.map((call) => call.userId), ["new1", "new2"]);
  const status = automation.status();
  assert.equal(status.detail.notified, 2);
  assert.equal(status.detail.added, 2);

  await automation.stop();
});

test("an unparsable notification is ignored, not fatal", async () => {
  const kaneo = stubKaneo({ users: [] });
  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });

  automation.start({
    config: testConfig(),
    kaneo: kaneo.client,
    logger: silentLogger,
    database: testConfig().database,
  });
  await tick(20);

  listener.emit("{broken");
  await tick(20);

  assert.equal(kaneo.addCalls.length, 0);
  assert.equal(automation.status().detail.failures, 0);
  assert.equal(automation.status().healthy, true);
  await automation.stop();
});

test("already a member counts as handled", async () => {
  const kaneo = stubKaneo({ users: [{ id: "u1", email: "a@example.com" }], onAdd: () => "already-member" });
  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });

  automation.start({
    config: testConfig(),
    kaneo: kaneo.client,
    logger: silentLogger,
    database: testConfig().database,
  });
  await tick(30);

  const status = automation.status();
  assert.equal(status.detail.alreadyMember, 1);
  assert.equal(status.detail.added, 0);
  assert.equal(status.healthy, true);
  await automation.stop();
});

test("a rejected session turns the automation unhealthy", async () => {
  const client = {
    async listWorkspaceMemberIds() {
      return new Set<string>();
    },
    async listUsers() {
      return { users: [{ id: "u1", email: "a@example.com" }], total: 1 };
    },
    async addWorkspaceMember() {
      throw new KaneoAuthError(401, "session expired");
    },
  } as unknown as KaneoAdminClient;

  const listener = captureListener();
  const automation = createAutoJoinAutomation({ startListener: listener.startListener });
  automation.start({ config: testConfig(), kaneo: client, logger: silentLogger, database: testConfig().database });
  await tick(30);

  const status = automation.status();
  assert.equal(status.detail.authOk, false);
  assert.equal(status.healthy, false);
  await automation.stop();
});

test("an unreachable listener reports unhealthy", async () => {
  const kaneo = stubKaneo({ users: [] });
  const automation = createAutoJoinAutomation({
    startListener: (options) => ({
      state: () => ({ connected: false, channel: options.channel }),
      close: async () => {},
    }),
  });

  automation.start({ config: testConfig(), kaneo: kaneo.client, logger: silentLogger, database: testConfig().database });
  await tick(20);

  assert.equal(automation.status().healthy, false);
  assert.equal(automation.status().detail.listening, false);
  await automation.stop();
});
