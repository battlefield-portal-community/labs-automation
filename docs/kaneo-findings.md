# Research notes: auto-joining a workspace in Kaneo

> Background for the root `README.md`. Verified against Kaneo's docs and source
> (`usekaneo/kaneo`, `apps/api/src`) plus a live Postgres 16, on 2026-11-11.
> Kept because the *why* matters more than the code.

Situation: self-hosted Kaneo (Docker Compose, `ghcr.io/usekaneo/kaneo:latest`), GitHub OAuth
already configured, users' email addresses **not known in advance**, and every new account
should land inside one workspace automatically.

Everything below was verified against Kaneo's docs **and** the source (`usekaneo/kaneo`,
`apps/api/src`), not against the LLM answer that prompted this.

---

## 1. What the original plan got wrong

| Claim | Reality |
| - | - |
| Callback URL `https://yourdomain.com` | Must be `https://yourdomain.com/api/auth/callback/github`. |
| "Kaneo fires a `user.created` webhook" on GitHub signup | **No such thing.** Project webhooks cover only task/comment events. Instance webhooks (`/api/admin/webhooks`, category `user`) fire only for **admin-audited** actions; `user.created` is emitted from the admin *Create user* endpoint (`admin/audit/describe-auth-admin-action.ts`). A self-signup writes no audit entry → nothing fires. |
| A webhook handler injects the user into a workspace | Not possible with any built-in Kaneo event. |
| "Default workspace" can be configured | Does not exist. GH #1955 → closed *not planned* → feedback.kaneo.app/requests/65 (still open). |
| GitHub org/team restriction | Not available. The provider is registered with `scope: ["user:email"]` only (`apps/api/src/auth.ts`). The built-in equivalent of an allowlist is **invite-only**: `DISABLE_REGISTRATION=true` still permits GitHub signup when a pending invitation matches the *verified* email (`utils/check-registration-allowed.ts`). |

So: not a `user.created` webhook problem, and not a "complex custom OIDC" problem. It is a
**missing feature** (auto-join / default workspace), plus one wrong assumption about webhooks.

## 2. What the app already gives you

* **GitHub-only sign-in** — `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
  `DISABLE_LOGIN_FORM=true`, `DISABLE_PASSWORD_REGISTRATION=true`. Leave
  `DISABLE_REGISTRATION` unset/false while signups must be open (it blocks SSO too).
  Reference: `kaneo.app/docs/core/social-providers/github`, `.../environment-variables#access-control`.
* **Membership = one row in `workspace_member`** (`id, workspace_id, user_id, role, joined_at`).
  No row in `workspace_member_access` means "access to all projects"
  (`project-access/get-member-project-access.ts`), so a single insert *is* a complete,
  normal membership — not a hack around permissions.
* **`POST /api/admin/workspaces/{id}/members`** adds an existing account (needs
  `workspaces:manage`, **rejects API keys**, so it needs a real session).
  `POST /api/auth/organization/invite-member` **does** accept workspace API keys
  (`utils/native-auth-api-key.ts`), but invitations are per email address.
* **Device auth exists** (`kaneo-cli`, `kaneo-mcp` client IDs; `bearer()` plugin is enabled), so a
  poller with an admin bearer token is technically possible — it just needs token refresh
  bookkeeping and a state store for "users already seen". More moving parts than either option below.

Because the email list is unknown, invitations/API-key loops are out. Two real options remain.

---

## 3. Option 1 — Postgres trigger (recommended for this deployment)

`docs/alternatives/direct-insert-trigger.sql`. No image build, keeps you on
`ghcr.io/usekaneo/kaneo:latest`, reversible with three `DROP` statements.

```bash
# find the workspace id
docker compose exec postgres psql -U kaneo -d kaneo -c \
  "SELECT id, name FROM workspace ORDER BY created_at;"

# put it in the file, then apply (also backfills existing accounts)
sed -i '' "s/REPLACE_WITH_WORKSPACE_ID/<your-workspace-id>/" docs/alternatives/direct-insert-trigger.sql
docker compose exec -T postgres psql -U kaneo -d kaneo < docs/alternatives/direct-insert-trigger.sql
```

Then sign in once with a fresh GitHub account in a private window: the workspace appears
immediately, with the `member` role.

What it deliberately does *not* do (all irrelevant on a self-hosted instance, worth knowing):

* no `project_members.updated` realtime broadcast — the account has no open socket yet;
* no seat sync (Kaneo Cloud billing only);
* no audit-log entry ("member added by system");
* `skip_admins` only sees the instance role at insert time, so the **first** user (promoted to
  admin in a later hook) is still added — harmless, admins bypass workspace checks;
* **schema coupling:** the function names `workspace_member`, `"user"`, `is_anonymous`,
  `banned`, `role`. If upstream renames one, the trigger starts failing *inside* the
  signup INSERT — i.e. signups 500, not just "auto-join stops". Mitigate by wrapping the
  body in `BEGIN ... EXCEPTION WHEN OTHERS THEN RETURN NEW; END;` (degrades to silently
  doing nothing) and keep the verification query from step 4 in a weekly check.
  Prefer Option 2 if that failure mode is unacceptable.

## 4. Option 2 — Fork patch (if you want it inside the app)

`docs/alternatives/fork-patch-default-workspace.ts` goes to `apps/api/src/utils/default-workspace.ts`, and in
`apps/api/src/auth.ts`, in `databaseHooks.user.create.after` next to
`promoteInitialAdministrator(user.id)`, add:

```ts
await joinDefaultWorkspace(user.id);   // import { joinDefaultWorkspace } from "./utils/default-workspace";
```

Build and pin it:

```bash
git clone https://github.com/usekaneo/kaneo.git && cd kaneo && git switch -c kaneo-default-workspace
# apply the file + the one-line hook
docker build -f Dockerfile.kaneo -t kaneo:default-workspace .
```

Then in your compose file: `image: kaneo:default-workspace` plus
`KANEO_DEFAULT_WORKSPACE_ID=<workspace id>` in `.env`.

Pros: uses the real code path (`handleMemberAdded`, project access, seat sync, proper error
logging), survives schema changes, and is small enough to submit upstream (it is exactly what
feedback #65 asks for). Cons: you now own the image build and re-patch on every upstream release.

---

## 5. Prior art: what upstream already has on file (checked 2026-11-11)

Feature requests moved off GitHub on 2026-10-09 (maintainer `tinsever`: "Feature requests now live at
Kaneo Feedback … to keep the issue tracker focused on bug reports"). Status of everything related:

| Item | State | What it says |
| - | - | - |
| GH **#1955** Default Workspace | **closed / not planned** → tracker #65 | *Exactly* this ask: "make a workspace the public or default … zeroconf new user add inside a managed org" |
| Tracker **#65** Default Workspace | open | Same text, carried over. No implementation planned as of today |
| Tracker **#101** Map OIDC groups to workspace roles | open, **9 votes** | "This goes hand in hand with the Default Workspace request (#65). Mapped users need a workspace to land in." |
| GH **#314** User Management Menu (invites, admin controls, SMTP) | open since 2025-06, 15 reactions | Umbrella "manage users without open registration". Partially delivered by PR #1253 (first user bypasses `DISABLE_REGISTRATION`, workspace invites + RBAC, admins bypass workspace perms); the admin UI now exists. Default-workspace is **not** part of it |
| GH **#1474**, **#1551** (closed bugs) | closed | Closed registration + invite flow broken; **OAuth signup via invitation link fails in invite-only mode** — i.e. the invite-by-email path has regressed exactly in the SSO + invite-only combination |
| GH **#1421** trust emails from custom OIDC provider | open | Only matters if you move from GitHub OAuth to OIDC and rely on invite/email matching |
| Tracker **#51** extend invitation expiry (GH #1852) | open | Invitations expire in ~48h — relevant if you ever pre-invite a large group |
| GH **#1640** redirect to default project, **#2145** instance settings (default *role*) | closed | Both are about a *default project* / default *role*, not workspace membership |
| PR **#1994** "feat: add a plugin system" | **open, `mergeable: false`, last push 2026-10-28** | Runtime plugins, no build step: `kaneo.config.ts`, `defineServer` (routes, webhooks, guards, per-workspace storage/settings, `enabledWorkspaces()`, `schedule(name, cron, run)`), `defineWeb` extension points |

The plugin system is the one thing that could retire a fork — but as proposed it cannot do this job:
its event catalog is `task.*` / `comment.created` / `project.moved` only (no `user.created`), and plugins
get no instance-admin user API or DB handle. So even after #1994 lands, auto-join needs one more thing
from upstream: a `user.created` plugin event (or an instance-level "default workspace" setting).
That is the upstream ask to file, since the pattern "one event, then the operator's own automation"
keeps operator logic out of the core.

## 6. Why not instance webhooks? (they exist, they just can't see signups)

Instance webhooks (`Settings → Administration → Webhooks`, `/api/admin/webhooks`) are the
right shape for this: signed (`X-Kaneo-Signature`), queued in Postgres, retried 3×, category
`user`, payload with `action`/`targetId`/`targetLabel`/`metadata`. The problem is the trigger.

Verified chain in `apps/api/src`:

* `admin_audit_log` rows are written by exactly one function, `admin/audit/record-admin-action.ts`,
  and that is also the only caller of `enqueueAuditWebhooks` — so **an instance webhook fires
  iff an audit row exists**.
* Every audit row comes from `recordAdminAction`, called by the admin controllers
  (`create-user`, `update-user`, `archive-workspace`, …), the workspace-member actions, and
  `record-auth-admin-audit`.
* `record-auth-admin-audit` only sees `AUDITED_AUTH_ADMIN_PATHS` — a fixed list of ten
  `/admin/*` better-auth endpoints (`/admin/create-user`, `/admin/ban-user`, …).
* GitHub sign-in goes `/callback/github` and sign-up `/sign-up/*`; neither is in that list,
  and `databaseHooks.user.create.after` in `auth.ts` only calls `promoteInitialAdministrator`.

So `user.created` fires **only** when an admin creates the account in *Settings → Administration
→ User management*. A GitHub self-signup writes no audit row → no webhook. (Kaneo's own docs
imply the same: the audit log lists admin actions, and it notes the first account's promotion
"isn't an administrative action and isn't recorded".)

And even if the event existed, it would not remove the follow-up auth problem: a receiver
cannot use `/api/admin/*` (API keys rejected), so it would need a device-flow bearer token —
whereas `POST /api/auth/organization/invite-member` **does** accept a scoped workspace API key
(`invitation:create`), which merely ends in a pending invitation the person must accept.

Net: webhook-driven onboarding costs *fork (to emit the event) + receiver service + token or
an accept click*. The fork alone does the whole job.

If upstream ever ships it, the minimal change is one line in `databaseHooks.user.create.after`:
record a `user.created` audit entry for non-guest signups. That makes instance webhooks a
first-class "new account" event for everyone, and the auto-join could then live in your own
receiver — but until then it is not a shortcut, it is an extra hop.

## 7. OAuth-only lockdown (verified against the code)

```env
# sign-in provider
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...

# local sign-in and local account creation off
DISABLE_LOGIN_FORM=true
DISABLE_PASSWORD_REGISTRATION=true

# optional, already implied by DISABLE_LOGIN_FORM
DISABLE_GUEST_ACCESS=true
DISABLE_EMAIL_OTP_SIGN_IN=true
```

Do **not** set `DISABLE_REGISTRATION=true` while new GitHub accounts must be able to sign up — it
blocks SSO creation too, leaving only invite-matched verified emails. Do not set `KANEO_CLOUD`.

What each one actually enforces:

| Variable | Effect in the API |
| - | - |
| `DISABLE_LOGIN_FORM=true` | Rejects `/sign-in/email`, `/sign-in/magic-link`, `/magic-link/verify`, `/sign-in/email-otp`, `/email-otp/*`, `/request-password-reset`, `/reset-password*` with `403 LOCAL_SIGN_IN_DISABLED` (`utils/is-local-sign-in-path.ts`, enforced in `auth.ts`), hides the form, and turns guest access off |
| `DISABLE_PASSWORD_REGISTRATION=true` | Any local create path throws `403 LOCAL_REGISTRATION_DISABLED`; OAuth callbacks (`/callback/*`) and invite-matched verified emails still pass (`utils/registration-policy.ts`) |
| both | Locked in Settings → Administration → Settings ("Open registration", "Email and password sign-up"); env wins |

Gotchas, in order of how much they can hurt:

1. **Lockout risk.** An existing local account whose email is not verified cannot be linked to a
   GitHub identity: the sign-in fails with `account_not_linked`, and the password form is gone. Before
   flipping `DISABLE_LOGIN_FORM`, open Settings → Administration → User management and use
   **Mark email as verified** for every account you still need.
2. **First account.** A fresh instance always allows the first signup (`hasRegisteredUsers()` guard) and
   that first non-guest user is promoted to instance admin. Sign in with GitHub once before you need
   anyone else in.
3. **No auto-redirect for GitHub.** `CUSTOM_OAUTH_AUTO_LOGIN` works for the custom OIDC provider only;
   with GitHub people land on a sign-in page that shows just the GitHub button.
4. **Password reset is unavailable** while the login form is disabled (intended: `403` on
   `/request-password-reset`).
5. **Admin-created accounts are pre-verified.** `POST /api/admin/users` writes the row directly with
   `emailVerified: true` when password accounts are off, so their first GitHub sign-in links to it.

Apply with `docker compose up -d --force-recreate kaneo`.

## 8. Chosen: NOTIFY → admin API (implemented in this repo)

Decision: a Postgres trigger only *notifies*, and a tiny listener performs the change through
`POST /api/admin/workspaces/{workspaceId}/members` using a device-flow **session** token. See
[`docs/auto-join-runbook.md`](auto-join-runbook.md) for the setup, env, failure modes and the passing test suite.

Why this over the two options above:

* no writes into `workspace_member` — the app still owns role validation, project-access publishing,
  seat sync and the `workspace.member_added` audit entry;
* schema coupling drops to `"user"` + `NEW.id` (a read, not a write), and the trigger swallows its own
  errors so a rename degrades to "auto-join stops" instead of "sign-up breaks";
* no image build, so upgrades stay `docker compose pull`.

Why a session token rather than an API key (asked explicitly): `/api/admin/*` runs
`requireUserSession`, which rejects any request carrying an API key — **including a key created by the
workspace owner/admin** — because the apiKey plugin would otherwise lend its owner's privileges. An
admin API key can only create a *pending invitation* (`POST /api/auth/organization/invite-member`,
scope `invitation:create`), which needs the person's email and one Accept click. There is no
`/organization/add-member` route in better-auth 1.7.14, so no API-key path exists for a direct add.

The session slides forward on use (7-day expiry, refreshed once ~1 day old), so the 10-minute
reconcile keeps it alive indefinitely; only a listener that stays off for the full lifetime needs one
re-run of `npm run device-auth`.

## 9. Alternatives

* Stay on `latest`, want it working today → **Option 1**.
* Want it "correct", plan to contribute it, or already build your own image → **Option 2**.
* Either way: do **not** enable `DISABLE_REGISTRATION` while signups must stay open, and keep the
  GitHub OAuth app's callback URL at `/api/auth/callback/github`.
