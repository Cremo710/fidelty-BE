import { databaseService } from "./databaseService.js";
import type { BarConfigDTO } from "../repositories/barConfigRepository.js";
import { platformConfigRepository } from "../repositories/platformConfigRepository.js";

export type SemaphoreStatus = "green" | "yellow";

export interface SignalFlag {
  code: "DUPLICATE" | "CAP_EXCEEDED" | "ANOMALY" | "YOUNG_ACCOUNT" | "DAILY_POINTS_CAP" | "MANUAL_BAR_CREDIT";
  reason: string;
  duplicateRequestId?: string;
}

export interface SemaphoreEvaluation {
  status: SemaphoreStatus;
  signals: SignalFlag[];
}

export interface SemaphoreInput {
  userId: string;
  barId: string;
  amount: number;
  receiptCodeBlock1: string;
  receiptCodeBlock2: string;
  barConfig: BarConfigDTO;
}

export class SemaphoreService {
  /**
   * Evaluates all active signals and returns the semaphore result.
   * Throws an error with code RATE_LIMIT_EXCEEDED if the daily hard cap is reached.
   */
  async evaluate(input: SemaphoreInput): Promise<SemaphoreEvaluation> {
    const { userId, barId, amount, receiptCodeBlock1, receiptCodeBlock2, barConfig } = input;
    const pool = databaseService.getPool();
    const signals: SignalFlag[] = [];

    // ── Platform config (cached) ──────────────────────────────────────────────
    const platform = await platformConfigRepository.get();

    // ── Rate limit (hard reject — not a yellow) ──────────────────────────────
    const rateLimitResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
       FROM consumption_requests
       WHERE requester_user_id = $1
         AND bar_id = $2
         AND status != 'rejected'
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome')
         AND created_at  < date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day'`,
      [userId, barId],
    );
    const todayCount = Number(rateLimitResult.rows[0]?.cnt ?? 0);
    if (todayCount >= platform.rateLimitPerUserPerBarPerDay) {
      const err = new Error("Hai raggiunto il limite di richieste giornaliere per questo bar.");
      (err as any).code = "RATE_LIMIT_EXCEEDED";
      throw err;
    }

    // ── Signal 0: Daily points cap (user + bar) ────────────────────────────
    const pointsPreview = Math.round(input.amount * (await platformConfigRepository.get()).pointsPerEuro);

    const [userDailyResult, barDailyResult] = await Promise.all([
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(points_preview), 0) AS total
         FROM consumption_requests
         WHERE requester_user_id = $1
           AND status IN ('approved', 'credited')
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome')
           AND created_at  < date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day'`,
        [userId],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(points_preview), 0) AS total
         FROM consumption_requests
         WHERE bar_id = $1
           AND status IN ('approved', 'credited')
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome')
           AND created_at  < date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day'`,
        [barId],
      ),
    ]);

    const userDailyPoints = Number(userDailyResult.rows[0]?.total ?? 0);
    const barDailyPoints  = Number(barDailyResult.rows[0]?.total ?? 0);

    if (userDailyPoints + pointsPreview > platform.maxPointsPerUserPerDay) {
      signals.push({
        code: "DAILY_POINTS_CAP",
        reason: `Tetto punti giornaliero utente raggiunto (${userDailyPoints} pt oggi, limite ${platform.maxPointsPerUserPerDay} pt).`,
      });
    } else if (barDailyPoints + pointsPreview > platform.maxPointsPerBarPerDay) {
      signals.push({
        code: "DAILY_POINTS_CAP",
        reason: `Tetto punti giornaliero del bar raggiunto (${barDailyPoints} pt oggi, limite ${platform.maxPointsPerBarPerDay} pt).`,
      });
    }

    // ── Signal 1: Duplicate receipt code (always active) ─────────────────────
    const dupResult = await pool.query<{ id: string; status: string }>(
      `SELECT id, status
       FROM consumption_requests
       WHERE receipt_code_block1 = $1
         AND receipt_code_block2 = $2
         AND bar_id = $3
         AND status != 'rejected'
         AND date_trunc('day', created_at AT TIME ZONE 'Europe/Rome')
             = date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome')
       LIMIT 1`,
      [receiptCodeBlock1, receiptCodeBlock2, barId],
    );
    if (dupResult.rows.length > 0) {
      signals.push({
        code: "DUPLICATE",
        reason: `Codice scontrino ${receiptCodeBlock1}-${receiptCodeBlock2} già presente oggi per questo bar.`,
        duplicateRequestId: dupResult.rows[0].id,
      });
    }

    // ── Signal 2: Absolute cap (bar flag) ────────────────────────────────────
    if (barConfig.capEnabled && amount > barConfig.capAmount) {
      signals.push({
        code: "CAP_EXCEEDED",
        reason: `Importo (${amount.toFixed(2)} €) supera il limite configurato dal bar (${barConfig.capAmount.toFixed(2)} €).`,
      });
    }

    // ── Signal 3: Historical anomaly (bar flag) ──────────────────────────────
    if (barConfig.anomalyEnabled) {
      const avgResult = await pool.query<{ avg_amount: string | null }>(
        `SELECT AVG(amount::numeric) AS avg_amount
         FROM consumption_requests
         WHERE requester_user_id = $1
           AND bar_id = $2
           AND status IN ('approved', 'credited')`,
        [userId, barId],
      );
      const avgAmount = avgResult.rows[0]?.avg_amount !== null
        ? Number(avgResult.rows[0]?.avg_amount)
        : null;

      if (avgAmount !== null && avgAmount > 0 && amount > avgAmount * platform.anomalyMultiplier) {
        signals.push({
          code: "ANOMALY",
          reason: `Importo (${amount.toFixed(2)} €) supera ${platform.anomalyMultiplier}× la media storica del cliente (${avgAmount.toFixed(2)} €).`,
        });
      }
    }

    // ── Signal 4: Young account + high amount (bar flag) ─────────────────────
    if (barConfig.youngAccountEnabled) {
      const [userResult, requestCountResult] = await Promise.all([
        pool.query<{ created_at: Date }>(
          "SELECT created_at FROM utenti WHERE id = $1",
          [userId],
        ),
        pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
           FROM consumption_requests
           WHERE requester_user_id = $1 AND status IN ('approved', 'credited')`,
          [userId],
        ),
      ]);

      const accountCreatedAt = userResult.rows[0]?.created_at;
      const approvedRequestCount = Number(requestCountResult.rows[0]?.cnt ?? 0);

      if (accountCreatedAt) {
        const accountAgeDays = Math.floor(
          (Date.now() - new Date(accountCreatedAt).getTime()) / 86_400_000,
        );
        const isYoung =
          accountAgeDays < platform.youngAccountMinDays ||
          approvedRequestCount < platform.youngAccountMinRequests;

        if (isYoung && amount > platform.youngAccountMaxAmount) {
          signals.push({
            code: "YOUNG_ACCOUNT",
            reason: `Account giovane (${accountAgeDays} giorni, ${approvedRequestCount} consumazioni) con importo elevato (${amount.toFixed(2)} €).`,
          });
        }
      }
    }

    return {
      status: signals.length === 0 ? "green" : "yellow",
      signals,
    };
  }
}

export const semaphoreService = new SemaphoreService();
