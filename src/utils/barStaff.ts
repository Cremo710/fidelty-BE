import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Restituisce gli id (tra quelli passati) che appartengono allo staff del bar:
 * il titolare (bars.user_id) o un membro attivo di bar_team_members.
 * Usato per impedire allo staff di accreditarsi, approvarsi o validarsi punti nel proprio bar.
 */
export async function findBarStaffUserIds(db: Queryable, barId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) {
    return [];
  }
  const result = await db.query<{ user_id: string }>(
    `SELECT b.user_id
     FROM bars b
     WHERE b.id = $1 AND b.user_id = ANY($2::varchar[])
     UNION
     SELECT tm.user_id
     FROM bar_team_members tm
     WHERE tm.bar_id = $1 AND tm.status = 'active' AND tm.user_id = ANY($2::varchar[])`,
    [barId, userIds],
  );
  return result.rows.map((row) => row.user_id);
}

export async function isBarStaff(db: Queryable, barId: string, userId: string): Promise<boolean> {
  return (await findBarStaffUserIds(db, barId, [userId])).length > 0;
}
