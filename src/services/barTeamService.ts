import { ulid } from "ulid";
import { databaseService } from "./databaseService.js";
import { hasBarPermission, type BarPermission, type BarTeamRole } from "../utils/barPermissions.js";
import { canInviteRole, getTeamMutationDenial } from "../utils/barTeamPolicy.js";

const INVITATION_TTL_DAYS = 7;

export interface BarAccess {
  barId: string;
  barName: string;
  role: BarTeamRole;
  permissions: BarPermission[];
}

export class BarTeamService {
  async listAccessibleBars(userId: string) {
    const result = await databaseService.getPool().query(
      `SELECT DISTINCT b.id, b.name, b.user_id,
         CASE WHEN b.user_id = $1 THEN 'manager' ELSE tm.role END AS role
       FROM bars b
       LEFT JOIN bar_team_members tm ON tm.bar_id = b.id AND tm.user_id = $1 AND tm.status = 'active'
       WHERE b.user_id = $1 OR tm.user_id = $1
       ORDER BY b.name`,
      [userId],
    );
    return result.rows as Array<{ id: string; name: string; user_id: string; role: BarTeamRole }>;
  }

  async getAccess(userId: string, requestedBarId?: string): Promise<BarAccess | null> {
    const bars = await this.listAccessibleBars(userId);
    const bar = requestedBarId
      ? bars.find((item) => item.id === requestedBarId)
      : bars.length === 1 ? bars[0] : undefined;
    if (!bar) return null;

    const allPermissions: BarPermission[] = [
      "offers.validate",
      "consumptions.manage",
      "offers.edit",
      "business.edit",
      "stats.view",
      "staff.view",
      "staff.manage",
    ];
    return {
      barId: bar.id,
      barName: bar.name,
      role: bar.role,
      permissions: allPermissions.filter((permission) => hasBarPermission(bar.role, permission)),
    };
  }

  async listTeam(barId: string, currentUserId = "") {
    await databaseService.getPool().query(
      `UPDATE bar_team_members SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE bar_id = $1 AND status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`,
      [barId],
    );
    const result = await databaseService.getPool().query(
      `SELECT tm.id, tm.email, tm.role, tm.status, tm.user_id = $2 AS "isCurrentUser",
         tm.expires_at AS "expiresAt",
         tm.created_at AS "createdAt", tm.accepted_at AS "acceptedAt",
         u.name AS "fullName"
       FROM bar_team_members tm
       LEFT JOIN utenti u ON u.id = tm.user_id
       WHERE tm.bar_id = $1 AND tm.status IN ('active', 'pending')
       ORDER BY CASE tm.role WHEN 'manager' THEN 0 WHEN 'co_manager' THEN 1 ELSE 2 END, tm.created_at`,
      [barId, currentUserId],
    );
    return result.rows;
  }

  async listReceivedInvitations(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    await databaseService.getPool().query(
      `UPDATE bar_team_members SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE lower(email) = $1 AND status = 'pending' AND expires_at <= CURRENT_TIMESTAMP`,
      [normalizedEmail],
    );
    const result = await databaseService.getPool().query(
      `SELECT tm.id, tm.bar_id AS "barId", tm.email, tm.role,
         tm.expires_at AS "expiresAt", b.name AS "barName"
       FROM bar_team_members tm JOIN bars b ON b.id = tm.bar_id
       WHERE lower(tm.email) = $1 AND tm.status = 'pending' AND tm.expires_at > CURRENT_TIMESTAMP
       ORDER BY tm.created_at DESC`,
      [normalizedEmail],
    );
    return result.rows;
  }

  async createInvitation(input: {
    barId: string;
    actorUserId: string;
    actorRole: BarTeamRole;
    email: string;
    role: "co_manager" | "waiter";
  }) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { status: 400 as const, code: "INVALID_EMAIL" };
    }
    if (!canInviteRole(input.actorRole, input.role)) {
      return {
        status: 403 as const,
        code: input.actorRole === "waiter" ? "STAFF_MANAGEMENT_FORBIDDEN" : "ROLE_ASSIGNMENT_FORBIDDEN",
      };
    }

    const client = await databaseService.getPool().connect();
    let invitation: { id: string; barName: string };
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bar-team:${input.barId}`]);
      const emailResult = await client.query<{ id: string }>(
        "SELECT id FROM utenti WHERE lower(email) = $1",
        [email],
      );
      const existingUserId = emailResult.rows[0]?.id ?? null;
      const duplicate = await client.query(
        `SELECT 1 FROM bar_team_members WHERE bar_id = $1 AND
         (lower(email) = $2 AND status IN ('active', 'pending')
          OR user_id = $3 AND status = 'active') LIMIT 1`,
        [input.barId, email, existingUserId],
      );
      if (duplicate.rowCount) {
        await client.query("ROLLBACK");
        return { status: 409 as const, code: "TEAM_MEMBER_EXISTS" };
      }

      const barResult = await client.query<{ name: string }>("SELECT name FROM bars WHERE id = $1", [input.barId]);
      if (!barResult.rows[0]) {
        await client.query("ROLLBACK");
        return { status: 404 as const, code: "BAR_NOT_FOUND" };
      }
      const id = ulid();
      await client.query(
        `INSERT INTO bar_team_members
          (id, bar_id, user_id, email, role, status, invited_by_user_id, expires_at)
         VALUES ($1, $2, NULL, $3, $4, 'pending', $5, CURRENT_TIMESTAMP + ($6 * INTERVAL '1 day'))`,
        [id, input.barId, email, input.role, input.actorUserId, INVITATION_TTL_DAYS],
      );
      await client.query(
        `INSERT INTO bar_team_audit (id, bar_id, actor_user_id, target_email, action, new_role)
         VALUES ($1, $2, $3, $4, 'invited', $5)`,
        [ulid(), input.barId, input.actorUserId, email, input.role],
      );
      await client.query("COMMIT");
      invitation = { id, barName: barResult.rows[0].name };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { status: 201 as const, invitation, email };
  }

  async acceptInvitation(invitationId: string, userId: string, userEmail: string) {
    const client = await databaseService.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string;
        bar_id: string;
        email: string;
        role: "co_manager" | "waiter";
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, bar_id, email, role, status, expires_at FROM bar_team_members
         WHERE id = $1 FOR UPDATE`,
        [invitationId],
      );
      const invite = result.rows[0];
      if (!invite || invite.status !== "pending") {
        await client.query("ROLLBACK");
        return { status: 404 as const, code: "INVITATION_NOT_FOUND" };
      }
      if (new Date(invite.expires_at).getTime() <= Date.now()) {
        await client.query("UPDATE bar_team_members SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [invitationId]);
        await client.query("COMMIT");
        return { status: 410 as const, code: "INVITATION_EXPIRED" };
      }
      if (invite.email !== userEmail.trim().toLowerCase()) {
        await client.query("ROLLBACK");
        return { status: 403 as const, code: "INVITATION_EMAIL_MISMATCH" };
      }

      await client.query(
        `UPDATE bar_team_members
         SET user_id = $2, status = 'active', accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [invitationId, userId],
      );
      await client.query(
        `INSERT INTO bar_team_audit (id, bar_id, actor_user_id, target_email, action, new_role)
         VALUES ($1, $2, $3, $4, 'accepted', $5)`,
        [ulid(), invite.bar_id, userId, invite.email, invite.role],
      );
      await client.query("COMMIT");
      return { status: 200 as const, code: "INVITATION_ACCEPTED" };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        return { status: 409 as const, code: "TEAM_MEMBER_EXISTS" };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateMember(input: {
    barId: string;
    memberId: string;
    actorUserId: string;
    actorRole: BarTeamRole;
    role?: "co_manager" | "waiter";
    remove?: boolean;
  }) {
    const client = await databaseService.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bar-team:${input.barId}`]);
      const result = await client.query<{ id: string; user_id: string | null; email: string; role: BarTeamRole; status: string }>(
        "SELECT id, user_id, email, role, status FROM bar_team_members WHERE id = $1 AND bar_id = $2 FOR UPDATE",
        [input.memberId, input.barId],
      );
      const member = result.rows[0];
      if (!member || !["active", "pending"].includes(member.status)) {
        await client.query("ROLLBACK");
        return { status: 404 as const, code: "TEAM_MEMBER_NOT_FOUND" };
      }
      const denial = getTeamMutationDenial({
        actorRole: input.actorRole,
        actorUserId: input.actorUserId,
        targetRole: member.role,
        targetUserId: member.user_id,
        newRole: input.role,
      });
      if (denial) {
        await client.query("ROLLBACK");
        return { status: 403 as const, code: denial };
      }

      const nextStatus = input.remove ? "revoked" : member.status;
      await client.query(
        `UPDATE bar_team_members SET role = COALESCE($2, role), status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [member.id, input.remove ? null : input.role ?? null, nextStatus],
      );
      await client.query(
        `INSERT INTO bar_team_audit (id, bar_id, actor_user_id, target_email, action, old_role, new_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ulid(), input.barId, input.actorUserId, member.email, input.remove ? "removed" : "role_changed", member.role, input.remove ? null : input.role ?? member.role],
      );
      await client.query("COMMIT");
      return { status: 200 as const, code: input.remove ? "TEAM_MEMBER_REMOVED" : "TEAM_MEMBER_UPDATED" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async leaveTeam(barId: string, userId: string) {
    const client = await databaseService.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ email: string; role: BarTeamRole }>(
        `UPDATE bar_team_members SET status = 'left', updated_at = CURRENT_TIMESTAMP
         WHERE bar_id = $1 AND user_id = $2 AND role <> 'manager' AND status = 'active'
         RETURNING email, role`,
        [barId, userId],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        return { status: 403 as const, code: "MANAGER_CANNOT_LEAVE_OR_NOT_MEMBER" };
      }
      const member = result.rows[0];
      await client.query(
        `INSERT INTO bar_team_audit (id, bar_id, actor_user_id, target_email, action, old_role)
         VALUES ($1, $2, $3, $4, 'left', $5)`,
        [ulid(), barId, userId, member.email, member.role],
      );
      await client.query("COMMIT");
      return { status: 200 as const, code: "TEAM_LEFT" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const barTeamService = new BarTeamService();
