/**
 * Stand-in for the three Kaneo admin endpoints this image uses, for tests and
 * shell-based integration runs.
 *
 *   PORT=8997 EXPECT_TOKEN=tok PRESEED=u1,u2 node tests/support/mock-kaneo.ts
 *
 * Env:
 *   PORT          listen port (default 8997)
 *   EXPECT_TOKEN  bearer token to accept (default "tok")
 *   PRESEED       comma-separated user ids that are already members
 *   FORCE_STATUS  answer every /admin request with this status (auth tests)
 */
import http from "node:http";

const port = Number(process.env.PORT ?? 8997);
const expectToken = process.env.EXPECT_TOKEN ?? "tok";
const forceStatus = process.env.FORCE_STATUS ? Number(process.env.FORCE_STATUS) : null;
const members = new Set((process.env.PRESEED ?? "").split(",").filter(Boolean));

const users = [
  { id: "u1", email: "a@example.com", role: "user", isAnonymous: false, banned: false },
  { id: "u2", email: "b@example.com", role: "user", isAnonymous: false, banned: false },
  { id: "guest1", email: "guest@kaneo.app", role: "user", isAnonymous: true, banned: false },
  { id: "admin1", email: "admin@example.com", role: "admin", isAnonymous: false, banned: false },
];

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  let body = "";
  for await (const chunk of request) body += chunk;

  const json = (status: number, payload: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  if (forceStatus !== null && url.pathname.startsWith("/admin")) {
    return json(forceStatus, { message: "forced", code: "SESSION_REQUIRED" });
  }

  if (request.headers.authorization !== `Bearer ${expectToken}`) {
    return json(401, { message: "Unauthorized" });
  }

  if (request.method === "GET" && url.pathname === "/admin/workspaces/ws1/members") {
    return json(200, [...members].map((userId) => ({ userId, role: "member" })));
  }

  if (request.method === "GET" && url.pathname === "/admin/users") {
    return json(200, { users, total: users.length });
  }

  if (request.method === "POST" && url.pathname === "/admin/workspaces/ws1/members") {
    const parsed = JSON.parse(body || "{}") as { userId?: string; role?: string };
    if (!parsed.userId) return json(400, { message: "userId is required" });
    if (members.has(parsed.userId)) {
      return json(409, { message: "This user is already a member of the workspace" });
    }
    members.add(parsed.userId);
    console.log(`   mock: add ${parsed.userId} as ${parsed.role}`);
    return json(200, [{ userId: parsed.userId, role: parsed.role }]);
  }

  return json(404, { message: "not found" });
});

server.listen(port, "127.0.0.1", () => console.log(`mock kaneo up on ${port}`));
