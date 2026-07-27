/**
 * Pilot metrics script — Fase 0
 * Eseguibile con: npx tsx src/scripts/pilotMetrics.ts
 * Oppure via cron su Render: node dist/scripts/pilotMetrics.js
 *
 * Stampa le metriche chiave del pilota e le invia opzionalmente via mail
 * se METRICS_EMAIL_RECIPIENT è definita in env.
 */
import { config } from "dotenv";
import { databaseService } from "../services/databaseService.js";
import { emailService } from "../services/emailService.js";

config();

export interface PilotMetrics {
  /** Totale utenti registrati */
  totalUsers: number;
  /** Utenti con almeno 2 richieste approved/credited (il numero che decide tutto) */
  usersWithSecondScan: number;
  /** % richieste in yellow nelle ultime 24h */
  yellowPct24h: number;
  /** % richieste in yellow negli ultimi 7 giorni */
  yellowPct7d: number;
  /** Tempo mediano di risposta del barista (minuti) nelle ultime 24h */
  medianBaristaResponseMinutes24h: number | null;
  /** Media scansioni per utente per settimana (ultime 4 settimane) */
  avgScansPerUserPerWeek: number;
  collectedAt: string;
}

export async function collectPilotMetrics(): Promise<PilotMetrics> {
  const pool = databaseService.getPool();

  const [
    usersResult,
    secondScanResult,
    yellow24hResult,
    yellow7dResult,
    responseTimeResult,
    scansPerWeekResult,
  ] = await Promise.all([
    pool.query<{ total: string }>("SELECT COUNT(*) AS total FROM utenti"),

    pool.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT requester_user_id
        FROM consumption_requests
        WHERE status IN ('approved', 'credited')
        GROUP BY requester_user_id
        HAVING COUNT(*) >= 2
      ) AS sub
    `),

    pool.query<{ yellow: string; total: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE semaphore_status = 'yellow') AS yellow,
        COUNT(*) AS total
      FROM consumption_requests
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND status != 'rejected'
    `),

    pool.query<{ yellow: string; total: string }>(`
      SELECT
        COUNT(*) FILTER (WHERE semaphore_status = 'yellow') AS yellow,
        COUNT(*) AS total
      FROM consumption_requests
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND status != 'rejected'
    `),

    pool.query<{ median_minutes: string | null }>(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)) / 60
      ) AS median_minutes
      FROM consumption_requests
      WHERE semaphore_status = 'yellow'
        AND status IN ('approved', 'rejected')
        AND created_at >= NOW() - INTERVAL '24 hours'
    `),

    pool.query<{ avg_per_week: string }>(`
      SELECT
        COALESCE(
          SUM(weekly_count)::numeric / NULLIF(COUNT(DISTINCT requester_user_id), 0) / 4,
          0
        ) AS avg_per_week
      FROM (
        SELECT
          requester_user_id,
          DATE_TRUNC('week', created_at) AS week,
          COUNT(*) AS weekly_count
        FROM consumption_requests
        WHERE created_at >= NOW() - INTERVAL '4 weeks'
          AND status IN ('approved', 'credited')
        GROUP BY requester_user_id, DATE_TRUNC('week', created_at)
      ) AS sub
    `),
  ]);

  const total24h = Number(yellow24hResult.rows[0]?.total ?? 0);
  const total7d  = Number(yellow7dResult.rows[0]?.total ?? 0);

  return {
    totalUsers:                   Number(usersResult.rows[0]?.total ?? 0),
    usersWithSecondScan:          Number(secondScanResult.rows[0]?.cnt ?? 0),
    yellowPct24h:                 total24h > 0 ? Math.round((Number(yellow24hResult.rows[0]?.yellow ?? 0) / total24h) * 100) : 0,
    yellowPct7d:                  total7d  > 0 ? Math.round((Number(yellow7dResult.rows[0]?.yellow ?? 0)  / total7d)  * 100) : 0,
    medianBaristaResponseMinutes24h: responseTimeResult.rows[0]?.median_minutes !== null
      ? Math.round(Number(responseTimeResult.rows[0].median_minutes))
      : null,
    avgScansPerUserPerWeek:       Math.round(Number(scansPerWeekResult.rows[0]?.avg_per_week ?? 0) * 10) / 10,
    collectedAt:                  new Date().toISOString(),
  };
}

function formatMetricsText(m: PilotMetrics): string {
  return [
    `📊 Metriche pilota Fidelty — ${new Date(m.collectedAt).toLocaleString("it-IT")}`,
    ``,
    `👤 Utenti registrati:         ${m.totalUsers}`,
    `🔄 Utenti alla 2ª scansione:  ${m.usersWithSecondScan}  ← il numero che decide tutto`,
    ``,
    `🟡 % richieste in giallo 24h: ${m.yellowPct24h}%`,
    `🟡 % richieste in giallo 7gg: ${m.yellowPct7d}%`,
    ``,
    `⏱  Tempo mediano risposta barista (24h): ${m.medianBaristaResponseMinutes24h !== null ? `${m.medianBaristaResponseMinutes24h} min` : "n/d"}`,
    `📈 Scansioni/utente/settimana:           ${m.avgScansPerUserPerWeek}`,
  ].join("\n");
}

// Entry point quando eseguito direttamente
// Usa solo process.argv[1] — import.meta.url è sempre il file corrente
// anche quando il modulo viene importato, quindi non va usato per isMain.
const isMain = Boolean(
  process.argv[1] &&
  (process.argv[1].endsWith("pilotMetrics.ts") || process.argv[1].endsWith("pilotMetrics.js")),
);

if (isMain) {
  (async () => {
    try {
      // Non serve initializeTables(): il pool si connette al DB già inizializzato
      const metrics = await collectPilotMetrics();
      const text = formatMetricsText(metrics);
      console.log(text);

      const recipient = process.env.METRICS_EMAIL_RECIPIENT;
      if (recipient) {
        // Invia via emailService usando sendWithDefaultSender non esposta — usiamo il metodo di verifica email come canale
        console.log(`📧 Invio metriche a ${recipient}...`);
        await emailService.sendNewConsumptionRequestEmail({
          recipientEmail: recipient,
          barName: "Report Automatico",
          requesterName: "Sistema",
          amount: 0,
          pointsPreview: 0,
          requestId: "metrics-report",
        }).catch(() => console.warn("⚠️ Invio metriche via email fallito"));
      }

      process.exit(0);
    } catch (err) {
      console.error("❌ Errore pilotMetrics:", err);
      process.exit(1);
    }
  })();
}
