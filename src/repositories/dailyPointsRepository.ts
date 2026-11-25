import type { PoolClient, Pool } from "pg";

/**
 * Punti già assegnati "oggi" (giornata Europe/Rome), base dei tetti giornalieri.
 *
 * Regole, uguali per semaforo, approvazione e accredito manuale:
 * - contano solo le richieste approved/credited;
 * - il giorno è quello dell'assegnazione dei punti (approved_at), non della creazione:
 *   una richiesta creata ieri e approvata oggi pesa su oggi. Gli accrediti manuali non hanno
 *   approved_at e usano created_at, che coincide con il momento dell'accredito;
 * - per l'utente si sommano i punti ricevuti come partecipante (points_allocated), non solo
 *   quelli delle richieste di cui è il richiedente; per le richieste senza partecipanti
 *   (accrediti manuali, dati storici) vale points_preview del richiedente.
 */

const TODAY_WINDOW = (column: string) => `
  ${column} >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
  AND ${column} < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day') AT TIME ZONE 'Europe/Rome'`;

const AWARDED_AT = "COALESCE(cr.approved_at, cr.created_at)";

type Queryable = Pick<PoolClient | Pool, "query">;

export async function getUserDailyPoints(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    `SELECT
       COALESCE((
         SELECT SUM(p.points_allocated)
         FROM consumption_request_participants p
         JOIN consumption_requests cr ON cr.id = p.request_id
         WHERE p.user_id = $1
           AND cr.status IN ('approved', 'credited')
           AND ${TODAY_WINDOW(AWARDED_AT)}
       ), 0)
       +
       COALESCE((
         SELECT SUM(cr.points_preview)
         FROM consumption_requests cr
         WHERE cr.requester_user_id = $1
           AND cr.status IN ('approved', 'credited')
           AND ${TODAY_WINDOW(AWARDED_AT)}
           AND NOT EXISTS (SELECT 1 FROM consumption_request_participants p WHERE p.request_id = cr.id)
       ), 0) AS total`,
    [userId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function getBarDailyPoints(db: Queryable, barId: string): Promise<number> {
  const result = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(cr.points_preview), 0) AS total
     FROM consumption_requests cr
     WHERE cr.bar_id = $1
       AND cr.status IN ('approved', 'credited')
       AND ${TODAY_WINDOW(AWARDED_AT)}`,
    [barId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export type DailyCapViolation =
  | { scope: "user"; userId: string; alreadyToday: number; adding: number; limit: number }
  | { scope: "bar"; alreadyToday: number; adding: number; limit: number };

/**
 * Verifica i tetti giornalieri per un'assegnazione di punti già ripartita tra i destinatari.
 * Va chiamata dentro la transazione, dopo il lock `consumption-bar:<barId>`, così due
 * assegnazioni concorrenti nello stesso locale non superano il tetto insieme.
 * Il lock per bar serializza il tetto del bar; quello per utente è esatto per le assegnazioni
 * nello stesso locale (tra locali diversi resta possibile una piccola sovrapposizione).
 */
export async function findDailyCapViolation(
  db: Queryable,
  input: {
    barId: string;
    allocations: Array<{ userId: string; points: number }>;
    maxPointsPerUserPerDay: number;
    maxPointsPerBarPerDay: number;
  },
): Promise<DailyCapViolation | null> {
  const totalAdding = input.allocations.reduce((sum, a) => sum + a.points, 0);
  const barToday = await getBarDailyPoints(db, input.barId);
  if (barToday + totalAdding > input.maxPointsPerBarPerDay) {
    return { scope: "bar", alreadyToday: barToday, adding: totalAdding, limit: input.maxPointsPerBarPerDay };
  }
  for (const allocation of input.allocations) {
    if (allocation.points <= 0) continue;
    const userToday = await getUserDailyPoints(db, allocation.userId);
    if (userToday + allocation.points > input.maxPointsPerUserPerDay) {
      return {
        scope: "user",
        userId: allocation.userId,
        alreadyToday: userToday,
        adding: allocation.points,
        limit: input.maxPointsPerUserPerDay,
      };
    }
  }
  return null;
}

export class DailyPointsCapError extends Error {
  readonly code = "DAILY_POINTS_CAP_REACHED";
  constructor(readonly violation: DailyCapViolation) {
    super("DAILY_POINTS_CAP_REACHED");
  }

  /** Messaggio per il barista: dice quale tetto e quanti punti restano oggi. */
  get userMessage(): string {
    const remaining = Math.max(0, this.violation.limit - this.violation.alreadyToday);
    return this.violation.scope === "bar"
      ? `Il locale ha raggiunto il tetto giornaliero di punti (restano ${remaining} pt oggi).`
      : `Il cliente ha raggiunto il tetto giornaliero di punti (restano ${remaining} pt oggi).`;
  }
}
