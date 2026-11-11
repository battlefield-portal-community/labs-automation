# Deploying with Portainer

The image is built by GitHub Actions and published to GHCR, so Portainer only has to **pull** it.
Portainer never needs a git clone, a build context, or npm access — which matters because the VPS is
a plain Ubuntu x86_64 host running Docker.

Configuration comes from the stack's environment variables (no `.env` file), migrations run at boot,
and the one-off token command runs in the container console.

- **Image:** `ghcr.io/battlefield-portal-community/labs-automation`
- **Platform:** `linux/amd64` (matches the VPS; see [§8](#8-platform-and-registry-notes) for ARM)
- **Tags:** `latest` (main), `main`, `sha-<short>`, `vX.Y.Z` / `vX.Y` on release tags

## 1. Prerequisites

| What | How |
| - | - |
| A published image | `.github/workflows/build.yml` runs on every push to `main`; check **Actions** for a green `image (linux/amd64)` job, then **Packages** for the `labs-automation` package |
| Workspace id | on the Kaneo host: `docker compose exec postgres psql -U kaneo -d kaneo -c 'SELECT id, name, archived_at FROM workspace;'` |
| An admin GitHub account | needs `users:read` + `workspaces:manage` — an instance administrator |
| Kaneo API reachable from the container | same stack: `http://kaneo:5173/api` |
| Database credentials | the role Kaneo uses (`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`) |

## 2. Make the image pullable

The first CI run creates the package. Its visibility decides what step you need:

**Public package (simplest):** GitHub → **Packages** → `labs-automation` → *Package settings* →
*Danger zone* → **Change visibility** → public. Portainer pulls anonymously; done. The image contains
no secrets (the token is supplied as an environment variable), so this is usually fine.

**Private package:** Portainer needs credentials that can read packages.

1. GitHub → *Settings* → *Developer settings* → **Personal access tokens (fine-grained)** → new token
   with **read:packages** on this repository (a classic PAT with `read:packages` also works).
2. Portainer → **Registries** → **Add registry** → *Custom registry*:
   - Registry URL: `ghcr.io`
   - Username: your GitHub username
   - Password: the PAT
3. In the stack, select that registry under the service (Portainer asks when the image field points at
   `ghcr.io`, or set it in the stack's **Registry** dropdown).

> The token only needs `read:packages`. Prefer a dedicated machine account over a personal one, and
> rotate it in Portainer → **Registries** if the pull starts failing with `denied` or `unauthorized`.

**If CI itself cannot publish** (`denied: installation not allowed to Create organization package`),
the repository's workflow token lacks package rights: GitHub → repository **Settings** → **Actions** →
**General** → *Workflow permissions* → **Read and write permissions**, then re-run the workflow. The
workflow already requests `packages: write`, this just raises the repository-wide cap.

**Pinning a tag:** replace `:latest` with `:sha-<7 chars>` or `:v0.1.0`. `latest` is rebuilt on every
push to `main`, so a stack using it changes when you update it, not when you deploy next.

## 3. Add the stack

### Option A — into the existing Kaneo stack (recommended)

1. Portainer → **Stacks** → your Kaneo stack → **Editor**.
2. Paste the `automations:` service from [`compose.yml`](../compose.yml) at the end of `services:`.
   If you paste the whole file, keep only the services you need and drop the `build:` comment lines.
3. Uncomment `depends_on:` so the sidecar waits for Postgres.
4. Continue to **§5 Environment variables**, then **Update the stack**.

### Option B — a separate stack

1. Portainer → **Stacks** → **Add stack** → name it `kaneo-automation`.
2. Portainer → **Networks** → note the network your Kaneo stack created, usually
   `<kaneo-stack-name>_default`.
3. Paste [`compose.yml`](../compose.yml) and uncomment the `networks:` blocks at the bottom, setting
   `name:` to that network.
4. Leave `depends_on:` commented — the sidecar retries until the database answers.
5. Continue to **§5 Environment variables**, then **Deploy the stack**.

Deploy method **Web editor** is enough in both cases: there is nothing to build.

## 4. What the service does on boot

1. Validates its environment. Invalid values are reported **all at once** in the log and the container
   exits — e.g. a missing `KANEO_WORKSPACE_ID` or `DATABASE_URL`.
2. Applies `sql/` (`MIGRATE_ON_START=true`, the compose default): the `kaneo_new_user` trigger and its
   function, recorded in `labs_automation_migration`, so restarts are safe.
3. Starts listening for new accounts and runs one reconcile.
4. Serves `/healthz` (what the container healthcheck reads) and `/status` (detail).

Without a token, steps 3–4 still start but report **unhealthy** — every API call returns 401. That is
deliberate: you deploy first, mint the token from the console, then restart.

## 5. Environment variables

Portainer → stack → **Environment variables** → *Add environment variable*. Add at least:

| Name | Value |
| - | - |
| `KANEO_WORKSPACE_ID` | the workspace id from §1 |
| `DATABASE_URL` | `postgres://kaneo:<password>@postgres:5432/kaneo` |
| `KANEO_ADMIN_TOKEN` | filled in at §6 — leave empty on the first deploy |
| `KANEO_API_URL` | `http://kaneo:5173/api` (defaults to this if omitted) |

`KANEO_WORKSPACE_ID` and `DATABASE_URL` use required syntax (`:?`) in the compose file, so a missing
value makes Portainer refuse the deploy with that message instead of starting a crash-looping
container.

Optional, already defaulted in the compose file: `KANEO_WORKSPACE_ROLE=member`,
`MIGRATE_ON_START=true`, `RECONCILE_INTERVAL_MIN=10`, `SKIP_INSTANCE_ADMINS=false`,
`LOG_LEVEL=info`, `AUTOMATIONS=auto-join`.

> **Values live in the stack configuration**, so `KANEO_ADMIN_TOKEN` is readable by anyone with
> Portainer access to the stack. If that is unacceptable, use the file variant: place the token on the
> Docker host (`chmod 600`), uncomment the `volumes:` line, remove `KANEO_ADMIN_TOKEN` from the
> environment. A Portainer **Swarm** endpoint can use a Docker secret instead.

## 6. Mint the token from the Portainer console

1. Portainer → **Containers** → `kaneo-automation` → **Console** → *Connect* (`/bin/sh`).
2. Run:

   ```sh
   KANEO_API_URL=http://kaneo:5173/api node src/cli/device-auth.ts --env
   ```

3. It prints a URL and a code. Open the URL in your browser, sign in **as the administrator**, approve
   the device, and return to the console.
4. It prints one line:

   ```
   KANEO_ADMIN_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

5. Add that line to the stack's **Environment variables** (§5) and **Update the stack** so the
   container is recreated with it.

The token is a Kaneo *session*: 7-day expiry that slides forward on use, and the reconcile loop counts
as use. Only a sidecar that stays **stopped** for a week needs this again — `/healthz` and the
container health column will tell you.

## 7. Verify

| Where | Expectation |
| - | - |
| Container list | `kaneo-automation` is **healthy** |
| Logs | `listening {"channel":"kaneo_new_user"}` then `reconcile done` with a `members` count |
| Console → `wget -qO- localhost:8080/status` | `healthy:true`, `authOk:true`, `added` growing |
| Sign in with a fresh GitHub account | the workspace appears within a second or two |

Console one-liners:

```sh
node src/cli/migrate.ts                       # apply sql/ by hand (MIGRATE_ON_START=false)
wget -qO- localhost:8080/status               # full automation state
```

## 8. Platform and registry notes

- CI builds **linux/amd64 only**, which is what the VPS kernel (`x86_64`) reports to Docker. If an ARM
  machine ever needs the image, add `linux/arm64` to `platforms:` in
  `.github/workflows/build.yml` and the workflow will publish a multi-arch manifest under the same tag.
- `exec format error` in the container log means the tag was built for another architecture — check
  `docker inspect --format '{{.Os}}/{{.Architecture}}' <image>` on the host.
- A pull failure (`denied`, `unauthorized`, `manifest unknown`) is almost always §2: missing registry
  credentials, a PAT without `read:packages`, or a tag that no CI run has produced yet.
- No ports are published. `/healthz` is for the container healthcheck and the console; nothing outside
  the Docker network needs to reach it.

## 9. Updating

| Change | What to do in Portainer |
| - | - |
| New image from `main` | **Stacks** → stack → **Update the stack**, with *re-pull image* enabled (pinned `sha-`/`v*` tags: change the tag first) |
| Environment or token change | edit the variables → **Update the stack** |
| New `sql/00N-*.sql` in the image | nothing: `MIGRATE_ON_START=true` applies it on the next container start |
| Rollback | pin the previous `sha-<short>` tag → **Update the stack** |
| New release | push a `vX.Y.Z` tag; CI publishes `vX.Y.Z` and `vX.Y`. Pin one of them if you want deliberate upgrades |

A CI failure blocks the image (the `image` job needs the `test` job), so a broken commit cannot reach
`latest`.

## 10. Troubleshooting

| What you see | Meaning | Fix |
| - | - | - |
| Stack update fails with `denied`/`unauthorized` | Portainer cannot read the GHCR package | §2 credentials, or make the package public |
| Container exits, log ends with `configuration {"problems":[...]}` | env var missing/invalid — all problems listed | fix names in the stack environment, update |
| Healthy, but `authOk:false` and `401` in logs | no token, expired token, or session revoked | §6, then update the stack |
| `listen failed` repeating | `DATABASE_URL` wrong, or containers on different networks | fix credentials / join Kaneo's network (§3 Option B) |
| `ENOENT … /run/secrets/kaneo_admin_token` | file variant without the host file | create it, or switch to `KANEO_ADMIN_TOKEN` |
| Healthy, new users land nowhere | migrations skipped, or `KANEO_WORKSPACE_ID` points at another workspace | check for `migrations` in the log, run `node src/cli/migrate.ts` |
| `400 Unknown role` in logs | `KANEO_WORKSPACE_ROLE` is not assignable there | use `viewer`/`member`/`admin` or a custom role |
| Notification lost while the stack was down | no queue — by design | nothing; the next reconcile adds whoever is missing |
