-- Kaneo: auto-add every new account to one workspace ("default workspace")
--
-- Why this exists: Kaneo has no default/public-workspace feature (feedback #65,
-- GH #1955 closed not-planned) and no signup webhook (project webhooks only
-- cover task/comment events; instance webhooks only fire on *admin-audited*
-- actions, never on a self-signup). Membership lives in one row of
-- `workspace_member`; a missing row in `workspace_member_access` already means
-- "all projects", so a single insert is a complete, normal membership.
--
-- Reversible: see ROLLBACK at the bottom. Idempotent to re-run.
--
-- Run:
--   docker compose exec -T postgres psql -U kaneo -d kaneo < 01-autojoin-trigger.sql
-- or interactively:
--   docker compose exec postgres psql -U kaneo -d kaneo

\set ON_ERROR_STOP on

-- 1) Pick the target workspace. Run this first if you don't know the id:
--      SELECT id, name, archived_at FROM workspace ORDER BY created_at;
--    The function below reads it from this one-row config table, so you can
--    change the target later by updating the row (no need to drop the trigger).

CREATE TABLE IF NOT EXISTS kaneo_autojoin_config (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  workspace_id    text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member',
  skip_admins     boolean NOT NULL DEFAULT true
);

-- Replace the placeholder workspace id with yours, then run the whole file.
INSERT INTO kaneo_autojoin_config (workspace_id, role)
VALUES ('REPLACE_WITH_WORKSPACE_ID', 'member')
ON CONFLICT (id) DO UPDATE
  SET workspace_id = EXCLUDED.workspace_id,
      role         = EXCLUDED.role;

-- 2) The trigger: after a real (non-guest) user row is inserted, add them.
--    Mirrors what POST /api/admin/workspaces/{id}/members writes.

CREATE OR REPLACE FUNCTION kaneo_autojoin_default_workspace()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cfg kaneo_autojoin_config%ROWTYPE;
BEGIN
  -- Guest accounts (anonymous plugin) and deactivated/banned users are skipped.
  IF NEW.is_anonymous IS TRUE OR COALESCE(NEW.banned, false) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cfg FROM kaneo_autojoin_config LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Optional: never auto-join instance administrators (they see every workspace).
  IF cfg.skip_admins AND NEW.role = 'admin' THEN
    RETURN NEW;
  END IF;

  -- workspace_member has no unique(workspace_id, user_id) index upstream,
  -- so guard explicitly to stay idempotent.
  INSERT INTO workspace_member (id, workspace_id, user_id, role, joined_at)
  SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 24),
         cfg.workspace_id,
         NEW.id,
         cfg.role,
         now()
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_member
    WHERE workspace_id = cfg.workspace_id AND user_id = NEW.id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kaneo_autojoin_after_user_insert ON "user";
CREATE TRIGGER kaneo_autojoin_after_user_insert
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION kaneo_autojoin_default_workspace();

-- 3) Backfill accounts that signed up before the trigger existed, so nobody is
--    left outside the workspace. Safe to re-run.

INSERT INTO workspace_member (id, workspace_id, user_id, role, joined_at)
SELECT substr(md5(random()::text || clock_timestamp()::text || u.id), 1, 24),
       cfg.workspace_id,
       u.id,
       cfg.role,
       now()
FROM "user" u
CROSS JOIN kaneo_autojoin_config cfg
WHERE COALESCE(u.is_anonymous, false) = false
  AND COALESCE(u.banned, false) = false
  AND NOT (cfg.skip_admins AND u.role = 'admin')
  AND NOT EXISTS (
    SELECT 1 FROM workspace_member m
    WHERE m.workspace_id = cfg.workspace_id AND m.user_id = u.id
  );

-- 4) Verify

SELECT cfg.workspace_id, w.name, cfg.role, cfg.skip_admins
FROM kaneo_autojoin_config cfg JOIN workspace w ON w.id = cfg.workspace_id;

SELECT u.email, u.role AS instance_role, m.role AS workspace_role, m.joined_at
FROM "user" u
LEFT JOIN workspace_member m
  ON m.user_id = u.id
 AND m.workspace_id = (SELECT workspace_id FROM kaneo_autojoin_config)
ORDER BY u.created_at;

-- ROLLBACK (uncomment to disable auto-join, keeping current memberships):
-- DROP TRIGGER IF EXISTS kaneo_autojoin_after_user_insert ON "user";
-- DROP FUNCTION IF EXISTS kaneo_autojoin_default_workspace();
-- DROP TABLE IF EXISTS kaneo_autojoin_config;
