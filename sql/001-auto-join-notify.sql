-- 001 — notify on new Kaneo accounts (auto-join input)
--
-- Applied by `npm run migrate` (tracked in labs_automation_migration) inside a
-- transaction. Plain SQL only: no psql meta-commands, since this runs through
-- the pg driver.
--
-- This *reads* `"user"` and never writes Kaneo's tables. The sidecar receives the
-- notification and performs the membership change through
-- POST /api/admin/workspaces/{workspaceId}/members, so role validation,
-- project-access publishing, seat sync and the audit entry stay in the app.

CREATE OR REPLACE FUNCTION kaneo_notify_new_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A trigger failure must never abort a sign-up, so everything is guarded.
  -- The trade-off: a schema change upstream makes this go quiet instead of
  -- breaking auth on the whole instance. The sidecar's reconcile loop is the
  -- safety net, and /status reports how many accounts it has added.
  BEGIN
    IF NEW.is_anonymous IS TRUE THEN
      RETURN NEW;                 -- guest accounts are ephemeral, not people
    END IF;

    PERFORM pg_notify(
      'kaneo_new_user',
      json_build_object('id', NEW.id, 'email', NEW.email)::text
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'kaneo_notify_new_user skipped: % (%)', SQLERRM, SQLSTATE;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kaneo_notify_new_user ON "user";

CREATE TRIGGER kaneo_notify_new_user
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION kaneo_notify_new_user();

-- Manual check (also useful for smoke tests):
--   SELECT pg_notify('kaneo_new_user', json_build_object('id', u.id, 'email', u.email)::text)
--   FROM "user" u ORDER BY u.created_at DESC LIMIT 1;
