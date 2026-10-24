import { databaseService } from "./databaseService.js";
import type { BarConfigDTO } from "../repositories/barConfigRepository.js";
import { platformConfigRepository } from "../repositories/platformConfigRepository.js";
import {
  aggregateStatus,
  checkAnomaly,
  checkCapExceeded,
  checkDailyPointsCap,
  checkDateMismatch,
  checkMockLocation,
  checkOcrLowConfidence,
  checkPivaMismatch,
  checkYoungAccount,
} from "./semaphoreRules.js";

export type SemaphoreStatus = "green" | "yellow" | "red";

export interface SignalFlag {
  code:
    | "DUPLICATE"          // esistente
    | "CAP_EXCEEDED"       // esistente
    | "ANOMALY"            // esistente
    | "YOUNG_ACCOUNT"      // esistente
    | "DAILY_POINTS_CAP"   // Fase 0
    | "MANUAL_BAR_CREDIT"  // Fase 0
    | "PIVA_MISMATCH"      // Fase 2 — rosso
    | "DUPLICATE_IMAGE"    // Fase 2 — rosso
    | "MOCK_LOCATION"      // Fase 2 — rosso
    | "DATE_MISMATCH"      // Fase 2 — giallo
    | "AMOUNT_CORRECTED"   // importo corretto dal barista in approvazione
    | "OCR_LOW_CONFIDENCE";// Fase 2 — giallo
  reason: string;
  /** reject = rosso (rifiuto automatico); review = giallo (coda barista) */
  severity: "reject" | "review";
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
  receiptCodeBlock1: string | null;
  receiptCodeBlock2: string | null;
  barConfig: BarConfigDTO;
  client?: import("pg").PoolClient;
  // Fase 2 — nuovi campi opzionali (default sicuro se assenti)
  barPiva?: string | null;          // P.IVA del bar: per PIVA_MISMATCH
  ocrVatNumber?: string | null;     // P.IVA letta dall'OCR
  ocrReceiptDate?: string | null;   // data ISO letta dall'OCR (yyyy-mm-dd)
  hasOcrSession?: boolean;          // false = digitazione manuale → MANUAL_ENTRY
  isMockedLocation?: boolean;       // per MOCK_LOCATION
  imageSha256?: string | null;      // per DUPLICATE_IMAGE
  ocrFieldsFound?: { amount: boolean; vatNumber: boolean; docId?: boolean; date?: boolean } | null; // per OCR_LOW_CONFIDENCE
}

export class SemaphoreService {
  /**
   * Evaluates all active signals and returns the semaphore result.
   * Throws an error with code RATE_LIMIT_EXCEEDED if the daily hard cap is reached.
   */
  async evaluate(input: SemaphoreInput): Promise<SemaphoreEvaluation> {
    const { userId, barId, amount, receiptCodeBlock1, receiptCodeBlock2, barConfig } = input;
    // Se il chiamante passa un client, le letture avvengono nella sua transazione (dopo il lock utente/bar)
    const pool = (input.client ?? databaseService.getPool()) as import("pg").Pool;
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
         AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
         AND created_at < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day') AT TIME ZONE 'Europe/Rome'`,
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
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
           AND created_at < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day') AT TIME ZONE 'Europe/Rome'`,
        [userId],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(points_preview), 0) AS total
         FROM consumption_requests
         WHERE bar_id = $1
           AND status IN ('approved', 'credited')
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
           AND created_at < (date_trunc('day', NOW() AT TIME ZONE 'Europe/Rome') + INTERVAL '1 day') AT TIME ZONE 'Europe/Rome'`,
        [barId],
      ),
    ]);

    const userDailyPoints = Number(userDailyResult.rows[0]?.total ?? 0);
    const barDailyPoints  = Number(barDailyResult.rows[0]?.total ?? 0);

    const dailyCap = checkDailyPointsCap(userDailyPoints, barDailyPoints, pointsPreview, platform);
    if (dailyCap) signals.push(dailyCap);

    // ── Signal 1: Duplicate receipt code (solo se presente) ─────────────────
    if (receiptCodeBlock1 !== null && receiptCodeBlock2 !== null) {
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
          severity: "reject",
          reason: `Codice scontrino ${receiptCodeBlock1}-${receiptCodeBlock2} già presente oggi per questo bar.`,
          duplicateRequestId: dupResult.rows[0].id,
        });
      }
    }

    // ── Signal 2: Absolute cap (bar flag) ────────────────────────────────────
    const capSignal = checkCapExceeded(amount, barConfig);
    if (capSignal) signals.push(capSignal);

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

      const anomaly = checkAnomaly(amount, avgAmount, platform.anomalyMultiplier);
      if (anomaly) signals.push(anomaly);
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
        const young = checkYoungAccount(amount, accountAgeDays, approvedRequestCount, platform);
        if (young) signals.push(young);
      }
    }

    // ── Segnali Fase 2 ────────────────────────────────────────────────────────

    // MOCK_LOCATION (rifiuto): posizione simulata su Android
    const mock = checkMockLocation(input.isMockedLocation, platform.mockLocationReject);
    if (mock) signals.push(mock);

    // DUPLICATE_IMAGE (rifiuto): stessa foto già consumata da qualunque utente
    if (input.imageSha256) {
      const dupImg = await pool.query<{ id: string }>(
        `SELECT id FROM receipt_ocr_sessions
         WHERE image_sha256 = $1
           AND consumed_at IS NOT NULL
           AND user_id != $2
         LIMIT 1`,
        [input.imageSha256, userId],
      );
      if (dupImg.rows.length > 0) {
        signals.push({
          code: "DUPLICATE_IMAGE",
          severity: "reject",
          reason: "Questa foto scontrino risulta già utilizzata da un altro utente.",
        });
      }
    }

    const pivaMismatch = checkPivaMismatch(input.ocrVatNumber, input.barPiva);
    if (pivaMismatch) signals.push(pivaMismatch);

    const todayRome = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
    const dateMismatch = checkDateMismatch(input.ocrReceiptDate, todayRome);
    if (dateMismatch) signals.push(dateMismatch);

    const ocrLow = checkOcrLowConfidence(input.hasOcrSession, input.ocrFieldsFound);
    if (ocrLow) signals.push(ocrLow);

    // ── Aggregazione finale ───────────────────────────────────────────────────
    return { status: aggregateStatus(signals), signals };
  }
}

export const semaphoreService = new SemaphoreService();
