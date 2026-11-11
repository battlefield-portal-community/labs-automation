# kaneo-labs-automation

A sidecar image for Kaneo automations. One container, one process, one health endpoint —
automations are modules inside it, and `AUTOMATIONS` picks which ones run.

Today there is exactly one: **`auto-join`** puts every new account into a chosen workspace, so
GitHub sign-in delivers people straight into the workspace instead of an empty start screen.

| Piece | What it does |
| - | - |
| `src/index.ts` | Hub: loads config, runs migrations if asked, starts the enabled automations, serves `/healthz` + `/status`, shuts down cleanly |
| `src/automations/*` | One module per automation; `src/automations/index.ts` is the registry |
| `src/core/*` | Config validation, JSON logging, health server, Kaneo admin client, `LISTEN` wrapper, migration runner |
| `src/cli/*` | `migrate` (applies `sql/`) and `device-auth` (mints the admin session token) |
| `sql/*.sql` | Database-side pieces, applied by `migrate` and tracked in `labs_automation_migration` |
| `tests/*.test.ts` | Unit + contract tests (`npm test`, no database needed) |
| `tests/psql/*.sh` | The SQL and an end-to-end run against a real Postgres |
| `Dockerfile`, `.github/workflows/build.yml` | The image, and the CI that tests it and publishes it to GHCR |
| `docs/` | `portainer.md` (deploy), `auto-join-runbook.md` (operations), `kaneo-findings.md` (research) |

TypeScript is executed directly by Node 24 (type stripping) — no build step, no emitted JS, and
`pg` is the only runtime dependency.

## Why it is built this way

Kaneo has no default/public workspace (feedback #65, GH #1955 closed *not planned*) and no
`user.created` webhook, and `/api/admin/*` rejects API keys — including keys created by a workspace
owner. The research behind those statements, and the alternatives that were rejected, are in
[`docs/kaneo-findings.md`](docs/kaneo-findings.md).

So auto-join is: a Postgres trigger that only *notifies* (never writes Kaneo tables), plus this
sidecar calling the admin API with a device-flow **session** token. Kaneo still owns the membership
write, so role validation, project-access publishing, seat sync and the audit entry all happen.

## Deploy

**Portainer (primary)** — the image is built for it: no `.env`, configuration in the stack's
environment variables, migrations at boot, one-off commands in the container console.
Step-by-step: [`docs/portainer.md`](docs/portainer.md). Short version, into the stack that already
runs Kaneo:

1. Portainer → your Kaneo stack → **Editor** → paste the `automations:` service from
   [`compose.yml`](compose.yml).
2. **Environment variables**: `KANEO_WORKSPACE_ID`, `DATABASE_URL`, and (after step 4)
   `KANEO_ADMIN_TOKEN`.
3. **Update the stack**. The container starts degraded (no token) and applies `sql/` on boot.
4. Container → **Console** →
   `KANEO_API_URL=http://kaneo:5173/api node src/cli/device-auth.ts --env`, approve the device as an
   administrator, paste the printed `KANEO_ADMIN_TOKEN=…` into the stack variables, update again.

Images come from CI (`.github/workflows/build.yml`), so Portainer only pulls — no git clone, no build
context, no npm access on the Docker host:

| Tag | Produced on | Use |
| - | - | - |
| `latest` | every push to `main` | quick rollouts; Portainer re-pulls when you update the stack |
| `sha-<short>` | every push to `main` | pinning an exact commit / rollback |
| `vX.Y.Z`, `vX.Y` | a `v*` git tag | deliberate releases |

`linux/amd64` only, which matches the Ubuntu x86_64 VPS. If the GHCR package is private, add registry
credentials in Portainer first — [`docs/portainer.md`](docs/portainer.md) §2. A failing `test` job
blocks the image, so a broken commit never reaches `latest`.

**Docker Compose (alternative)**, for when you have shell access:

```bash
cp env.example .env                       # KANEO_WORKSPACE_ID, DATABASE_URL
docker compose pull automations && docker compose up -d automations
docker compose logs -f automations        # expect: listening + reconcile done

# token, once (or from the container console):
docker run --rm -it -v "$PWD/secrets:/secrets" -e KANEO_API_URL=https://yourdomain.com/api \
  ghcr.io/battlefield-portal-community/labs-automation:latest \
  node src/cli/device-auth.ts /secrets/kaneo_admin_token
```

Building locally instead of pulling is fine for development:
`docker compose up -d --build automations` (uncomment `build: .` in `compose.yml`).

`KANEO_WORKSPACE_ID` is the workspace everyone joins:

```bash
docker compose exec postgres psql -U kaneo -d kaneo -c 'SELECT id, name, archived_at FROM workspace;'
```

Full operational detail — every variable, every failure mode, rollback — is in
[`docs/auto-join-runbook.md`](docs/auto-join-runbook.md).

## Configuration

All settings are environment variables; the hub validates them at startup and reports every problem
at once instead of failing on the first.

| Variable | Default | Notes |
| - | - | - |
| `AUTOMATIONS` | `auto-join` | comma-separated module names |
| `KANEO_WORKSPACE_ID` | — | **required** for `auto-join` |
| `KANEO_ADMIN_TOKEN_FILE` | — | path to the device-flow token; `KANEO_ADMIN_TOKEN` wins when both are set |
| `KANEO_ADMIN_TOKEN` | — | the token itself (Portainer-friendly). Missing is not fatal: the automation reports unhealthy until one exists |
| `KANEO_API_URL` | `http://kaneo:5173/api` | the bundled Kaneo image serves the API under `/api` |
| `KANEO_WORKSPACE_ROLE` | `member` | must be assignable in that workspace |
| `DATABASE_URL` | — | or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` |
| `RECONCILE_INTERVAL_MIN` | `10` | keep well under the session lifetime |
| `SKIP_INSTANCE_ADMINS` | `false` | true skips `role = "admin"`; custom admin roles are indistinguishable |
| `HEALTH_PORT` | `8080` | `/healthz` (200/503) and `/status` (detail) |
| `MIGRATE_ON_START` | `false` (compose sets `true`) | apply `sql/` at boot instead of a separate step |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SQL_DIR` | `./sql` | override for unusual layouts |

## Operating it

`/healthz` is what the container healthcheck reads, so an expired token shows up as an unhealthy
container rather than a silent outage:

```bash
curl -s 127.0.0.1:8080/status | jq
# { "healthy": true,
#   "automations": [ { "name": "auto-join", "healthy": true,
#                      "detail": { "listening": true, "authOk": true, "notified": 12,
#                                  "added": 12, "alreadyMember": 0, "failures": 0,
#                                  "lastReconcileAt": "...", "workspaceId": "...", "role": "member" } } ] }
```

The session token slides forward on use (Kaneo's sessions: 7-day expiry, refreshed once ~1 day old)
and the reconcile loop counts as use, so an idle instance never expires it. Only a sidecar that stays
**stopped** for longer than the lifetime needs `device-auth` again — see the runbook's failure table.

## Tests

```bash
npm test                     # 36 assertions: config, client, health, auto-join, device-auth

# against a throwaway Postgres (nothing touches Kaneo data)
docker run --rm -d --name kaneo-pgtest -e POSTGRES_USER=kaneo -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=kaneo -p 127.0.0.1:55432:5432 postgres:16-alpine
export PGPASSWORD=test PGHOST=127.0.0.1 PGPORT=55432 PGUSER=kaneo
sh tests/psql/verify-sql.sh          # 11 assertions: trigger, payload, guest, schema drift, re-run
sh tests/psql/integration.sh         # migrate + hub + real pg + mock Kaneo API, end to end
npm run typecheck                    # tsc --noEmit
```

Last known state: `npm test` 36/36, `verify-sql.sh` 11/11, `integration.sh` all checks passing,
`tsc --noEmit` clean (PostgreSQL 16.15, Node 24.21).

## Adding an automation

1. `src/automations/<name>.ts` exporting `create<Name>Automation(): Automation` — `start(ctx)`,
   `stop()`, `status()`.
2. Register it in `src/automations/index.ts`.
3. If it needs database-side objects, add `sql/00N-<name>.sql` (plain SQL, re-runnable — the runner
   wraps each file in a transaction).
4. Unit-test it against the fakes in `tests/support/fakes.ts`, and add a case to
   `tests/psql/integration.sh` if it touches the real database.

`AutomationContext` gives you the validated config, a `KaneoAdminClient`, a child logger, and the
Postgres settings for `startListener` — the same building blocks `auto-join` uses.
