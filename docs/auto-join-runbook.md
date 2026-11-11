# Auto-join runbook

> Operational reference for the `auto-join` automation. Setup steps live in the root
> `README.md`.

Every new account is added to one workspace, through Kaneo's own admin API:

```
sign-up (GitHub OAuth)
   └─ INSERT INTO "user"
        └─ trigger → pg_notify('kaneo_new_user', {id, email})
             └─ listener (this folder) → POST /api/admin/workspaces/{ws}/members  {userId, role}
                  └─ Kaneo writes the membership itself: role validation,
                     project-access publish, seat sync, workspace.member_added audit entry
   └─ safety net: listener reconciles GET /api/admin/users every 10 min
```

Why this shape, and why not the obvious alternatives:

- **No writes from our side.** The trigger only reads `"user"`; the membership change goes through
  `POST /api/admin/workspaces/{workspaceId}/members`, so every side effect and invariant stays in
  the application.
- **API keys do not work here.** `/api/admin/*` is guarded by `requireUserSession`, which rejects any
  request that carries an API key (`utils/require-user-session.ts`), regardless of the owner's role.
  A workspace-admin API key can create an *invitation* (`POST /api/auth/organization/invite-member`,
  scope `invitation:create`) but not add a member, and there is no `/organization/add-member` route in
  better-auth 1.7.14 at all. Hence the session token from the device flow.
- **The token does not need babysitting while the listener runs.** Sessions slide forward on use
  (better-auth defaults: 7-day expiry, refreshed once the session is ~1 day old). The 10-minute
  reconcile counts as use, so an instance where nobody signs up for months is fine. Only a listener
  that stays **off** for the whole lifetime needs a fresh device authorization.
- **NOTIFY is lossy on purpose.** No queue, no delivery guarantees: notifications fired while the
  listener is down are gone. The reconcile is the correctness mechanism; NOTIFY only makes it instant.

## Files

| File | Purpose |
| - | - |
| `sql/001-auto-join-notify.sql` | `AFTER INSERT ON "user"` → `pg_notify`; wrapped in an exception block so a schema change can never abort a sign-up |
| `src/automations/auto-join.ts` | `LISTEN kaneo_new_user`, admin API calls, periodic reconcile |
| `src/index.ts` | Hub: config, registry, health server, graceful shutdown |
| `src/cli/device-auth.ts` | Device-authorization helper that mints the session token |
| `Dockerfile`, `package.json` | The image (`pg` is the only runtime dependency) |
| `compose.yml` | Service definition with healthcheck |
| `tests/*.test.ts` | Unit + contract tests (36 assertions, `npm test`, no Postgres) |
| `tests/psql/verify-sql.sh` | The SQL against a real Postgres, throwaway database (11 assertions) |
| `tests/psql/integration.sh` | End-to-end: real Postgres + migration + hub + real `pg` + mock API |

## Setup

```bash
# 1. Which workspace should everyone join?
docker compose exec postgres psql -U kaneo -d kaneo -c 'SELECT id, name, archived_at FROM workspace;'

# 2. Mint the token (approve in the browser as an account with users:read + workspaces:manage)
KANEO_API_URL=https://yourdomain.com/api npm run device-auth -- ./secrets/kaneo_admin_token
chmod 600 ./secrets/kaneo_admin_token
# Portainer: run this in the container console instead, then paste the line into
# the stack's environment variables:
#   KANEO_API_URL=http://kaneo:5173/api node src/cli/device-auth.ts --env

# 3. Install the trigger (re-runnable; also re-run after a major upgrade)
docker compose run --rm automations node src/cli/migrate.ts

# 4. Add KANEO_WORKSPACE_ID to .env, merge docker-compose.fragment.yml, then:
docker compose pull automations && docker compose up -d automations

# 5. Verify
curl -s 127.0.0.1:8080/healthz | jq   # {healthy:true, listening:true, authOk:true, ...}
docker compose exec -T postgres psql -U kaneo -d kaneo -c \
  "SELECT pg_notify('kaneo_new_user', json_build_object('id', u.id, 'email', u.email)::text)
   FROM \"user\" u ORDER BY created_at DESC LIMIT 1;"
docker compose logs -f automations      # expect: "new account" result "already-member"
```

Then sign in with a fresh GitHub account: the workspace should appear within a second or two.

## Environment

| Variable | Default | Notes |
| - | - | - |
| `KANEO_WORKSPACE_ID` | — | required |
| `KANEO_ADMIN_TOKEN` / `KANEO_ADMIN_TOKEN_FILE` | — | needed for any API call; a missing token is not fatal, the automation just reports unhealthy |
| `KANEO_API_URL` | `http://kaneo:5173/api` | bundled image serves the API under `/api`; separate API → `http://api:1337` |
| `KANEO_WORKSPACE_ROLE` | `member` | must be an assignable role (`viewer`/`member`/`admin` or a workspace custom role) |
| `RECONCILE_INTERVAL_MIN` | `10` | keep well under the session lifetime |
| `HEALTH_PORT` | `8080` | `/healthz` → 200 healthy, 503 not (`/status` for detail) |
| `SKIP_INSTANCE_ADMINS` | `false` | only skips `role === "admin"`; custom admin roles are indistinguishable |
| `DATABASE_URL` | — | or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` |

## Failure modes

| Symptom | Meaning | Fix |
| - | - | - |
| `/healthz` 503, logs `auth rejected` | session expired or revoked (listener was off > ~7 days, admin signed it out, password reset) | re-run `npm run device-auth -- ./secrets/kaneo_admin_token`, restart the service |
| `/healthz` 503, logs `listen failed` | database unreachable or wrong `DATABASE_URL` | fix credentials; reconcile keeps working only while the API is reachable |
| Logs `job failed … 400 Unknown role` | `KANEO_WORKSPACE_ROLE` is not assignable in that workspace | use a valid role |
| New users land in the workspace late | notification lost (listener was down) | expected — reconcile catches up within `RECONCILE_INTERVAL_MIN` |
| Nothing at all after sign-up, trigger present | notify fired with no listener connected | start the listener; the next reconcile adds everyone missing |
| Sign-ups start failing loudly with SQL errors | trigger was hardened against this; if you removed the `EXCEPTION` block, restore it | re-run `npm run migrate` |

The trigger swallows its own errors, so a renamed table/column degrades to "auto-join silently stops"
rather than "sign-up breaks". The reconcile health output (`lastReconcileAt`, `added`) is the signal to
watch — alert if `healthy` is false or `added` stops tracking reality.

## Verification status

All three run against a throwaway container database and never touch Kaneo data:

```bash
docker run --rm -d --name kaneo-pgtest -e POSTGRES_USER=kaneo -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=kaneo -p 127.0.0.1:55432:5432 postgres:16-alpine
npm test                                  # 36/36, no database needed
export PGPASSWORD=test PGHOST=127.0.0.1 PGPORT=55432 PGUSER=kaneo
sh tests/psql/verify-sql.sh               # 11/11
sh tests/psql/integration.sh              # end-to-end
```

Results on PostgreSQL 16.15:

-   path, 409-as-success, 403 and 401 → unhealthy, Postgres-unreachable retry loop.

Not covered by these tests, because it needs a live Kaneo: the real `/api/admin/*` response codes
(401/403/409) and the device-flow approval. Those paths are coded against the verified route
definitions (`requireUserSession` + `requireInstancePermission("workspaces:manage")`, 409 when the
user is already a member).

## Rollback

```sql
DROP TRIGGER IF EXISTS kaneo_notify_new_user ON "user";
DROP FUNCTION IF EXISTS kaneo_notify_new_user();
```

then remove the service, and delete the device session it created in **Settings → Administration →
User management → Sessions & API keys** if you want the token revoked.
