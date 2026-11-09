import { FastifyRequest } from "fastify";
import type { BarDTO } from "../repositories/barRepository.js";
import { databaseService } from "../services/databaseService.js";

export async function resolveOwnedBarForRequest(request: FastifyRequest): Promise<BarDTO | null> {
  const userId = (request as any).userId;
  if (!userId) {
    return null;
  }

  const rawBarId = request.headers["x-bar-id"];
  const barId = Array.isArray(rawBarId) ? rawBarId[0] : rawBarId;

  if (barId) {
    const result = await databaseService.getPool().query(
      `SELECT b.* FROM bars b
       LEFT JOIN bar_team_members tm ON tm.bar_id = b.id AND tm.user_id = $2 AND tm.status = 'active'
       WHERE b.id = $1 AND (b.user_id = $2 OR tm.user_id = $2)
       LIMIT 1`,
      [String(barId), userId],
    );
    return (result.rows[0] as BarDTO | undefined) ?? null;
  }

  const accessible = await databaseService.getPool().query(
    `SELECT b.* FROM bars b
     LEFT JOIN bar_team_members tm ON tm.bar_id = b.id AND tm.user_id = $1 AND tm.status = 'active'
     WHERE b.user_id = $1 OR tm.user_id = $1
     ORDER BY b.created_at
     LIMIT 2`,
    [userId],
  );
  return accessible.rows.length === 1 ? accessible.rows[0] as BarDTO : null;
}

/**
 * Per azioni distruttive: true se l'utente ha più bar e non ha indicato quale con X-Bar-Id.
 */
export async function isBarSelectionMissing(request: FastifyRequest): Promise<boolean> {
  const userId = (request as any).userId;
  if (!userId || request.headers["x-bar-id"]) {
    return false;
  }

  const accessibleBars = await databaseService.getPool().query(
    `SELECT b.id FROM bars b
     LEFT JOIN bar_team_members tm ON tm.bar_id = b.id AND tm.user_id = $1 AND tm.status = 'active'
     WHERE b.user_id = $1 OR tm.user_id = $1
     LIMIT 2`,
    [userId],
  );
  return accessibleBars.rows.length > 1;
}