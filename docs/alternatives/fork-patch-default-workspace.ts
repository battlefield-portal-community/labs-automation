// Kaneo fork patch — Option 2: auto-join on signup, inside the app instead of SQL.
//
// Drop this file at: apps/api/src/utils/default-workspace.ts
// Then add ONE line to apps/api/src/auth.ts (see the README, "Option 2").
//
// Env:
//   KANEO_DEFAULT_WORKSPACE_ID=<workspace id>     # required to enable
//   KANEO_DEFAULT_WORKSPACE_ROLE=member           # optional, default "member"

import { createId } from "@paralleldrive/cuid2";
import { DEFAULT_ROLE_NAMES } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import db, { schema } from "../database";
import { handleMemberAdded } from "../workspace-members/handle-member-added";

const workspaceId = process.env.KANEO_DEFAULT_WORKSPACE_ID;
const configuredRole = process.env.KANEO_DEFAULT_WORKSPACE_ROLE;

/**
 * Add a freshly created (non-guest) account to the default workspace, the same
 * way POST /api/admin/workspaces/{id}/members does: one workspace_member row
 * (no workspace_member_access row means "all projects"), then the side effects.
 *
 * Best-effort: a failure here must not break sign-in.
 */
export async function joinDefaultWorkspace(userId: string): Promise<void> {
  if (!workspaceId) return;
  const role =
    configuredRole && DEFAULT_ROLE_NAMES.includes(configuredRole)
      ? configuredRole
      : "member";

  try {
    const [workspace] = await db
      .select({ id: schema.workspaceTable.id })
      .from(schema.workspaceTable)
      .where(
        and(
          eq(schema.workspaceTable.id, workspaceId),
          // Archived workspaces cannot take members.
          eq(schema.workspaceTable.archivedAt, null),
        ),
      )
      .limit(1);
    if (!workspace) {
      console.warn(
        `KANEO_DEFAULT_WORKSPACE_ID=${workspaceId} is unknown or archived; skipping auto-join`,
      );
      return;
    }

    const [existing] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          eq(schema.workspaceUserTable.userId, userId),
        ),
      )
      .limit(1);
    if (existing) return;

    await db.insert(schema.workspaceUserTable).values({
      id: createId(),
      workspaceId,
      userId,
      role,
      joinedAt: new Date(),
    });

    // Refresh project visibility and seat counts, as the admin endpoint does.
    await handleMemberAdded(workspaceId, userId);
  } catch (error) {
    console.error("Default workspace join failed:", error);
  }
}
