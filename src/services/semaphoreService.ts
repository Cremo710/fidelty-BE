import { databaseService } from "./databaseService.js";
import type { BarConfigDTO } from "../repositories/barConfigRepository.js";
import { platformConfigRepository } from "../repositories/platformConfigRepository.js";

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
    | "MANUAL_ENTRY"       // Fase 2 — giallo
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
  // Fase 2 — nuovi campi opzionali (default sicuro se assenti)
  barPiva?: string | null;          // P.IVA del bar: per PIVA_MISMATCH
  ocrVatNumber?: string | null;     // P.IVA letta dall'OCR
  ocrReceiptDate?: string | null;   // data ISO letta dall'OCR (yyyy-mm-dd)
  hasOcrSession?: boolean;          // false = digitazione manuale → MANUAL_ENTRY
  isMockedLocation?: boolean;       // per MOCK_LOCATION
  imageSha256?: string | null;      // per DUPLICATE_IMAGE
  ocrFieldsFound?: { amount: boolean; vatNumber: boolean } | null; // per OCR_LOW_CONFIDENCE
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
        severity: "review",
        reason: `Tetto punti giornaliero utente raggiunto (${userDailyPoints} pt oggi, limite ${platform.maxPointsPerUserPerDay} pt).`,
      });
    } else if (barDailyPoints + pointsPreview > platform.maxPointsPerBarPerDay) {
      signals.push({
        code: "DAILY_POINTS_CAP",
        severity: "review",
        reason: `Tetto punti giornaliero del bar raggiunto (${barDailyPoints} pt oggi, limite ${platform.maxPointsPerBarPerDay} pt).`,
      });
    }

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
    if (barConfig.capEnabled && amount > barConfig.capAmount) {
      signals.push({
        code: "CAP_EXCEEDED",
        severity: "review",
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
          severity: "review",
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
            severity: "review",
            reason: `Account giovane (${accountAgeDays} giorni, ${approvedRequestCount} consumazioni) con importo elevato (${amount.toFixed(2)} €).`,
          });
        }
      }
    }

    // ── Segnali Fase 2 ────────────────────────────────────────────────────────

    // MOCK_LOCATION (rifiuto): posizione simulata su Android
    if (input.isMockedLocation && platform.mockLocationReject) {
      signals.push({
        code: "MOCK_LOCATION",
        severity: "reject",
        reason: "Posizione simulata rilevata. La richiesta non può essere accettata.",
      });
    }

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

    // PIVA_MISMATCH (rifiuto): P.IVA letta ≠ P.IVA del bar
    // Nota: se ocrVatNumber è null (non letta) NON è un mismatch — è OCR_LOW_CONFIDENCE
    if (
      input.ocrVatNumber !== null && input.ocrVatNumber !== undefined &&
      input.barPiva !== null && input.barPiva !== undefined
    ) {
      const cleanOcr = input.ocrVatNumber.replace(/\D/g, "");
      const cleanBar = input.barPiva.replace(/\D/g, "");
      if (cleanOcr && cleanBar && cleanOcr !== cleanBar) {
        signals.push({
          code: "PIVA_MISMATCH",
          severity: "reject",
          reason: `La P.IVA sullo scontrino (${cleanOcr}) non corrisponde a quella del bar.`,
        });
      }
    }

    // DATE_MISMATCH (giallo): data scontrino ≠ oggi (fuso Europe/Rome)
    if (input.ocrReceiptDate) {
      const todayRome = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
      if (input.ocrReceiptDate !== todayRome) {
        signals.push({
          code: "DATE_MISMATCH",
          severity: "review",
          reason: `Data sullo scontrino (${input.ocrReceiptDate}) non corrisponde a oggi (${todayRome}).`,
        });
      }
    }

    // MANUAL_ENTRY (giallo): nessuna sessione OCR — solo quando ocr_enabled
    if (platform.ocrEnabled && input.hasOcrSession === false) {
      signals.push({
        code: "MANUAL_ENTRY",
        severity: "review",
        reason: "Dati inseriti manualmente. La richiesta richiede conferma del barista.",
      });
    }

    // OCR_LOW_CONFIDENCE (giallo): importo o P.IVA non letti dall'OCR
    if (input.hasOcrSession === true && input.ocrFieldsFound) {
      const missingFields: string[] = [];
      if (!input.ocrFieldsFound.amount)    missingFields.push("importo");
      if (!input.ocrFieldsFound.vatNumber) missingFields.push("P.IVA");
      if (missingFields.length > 0) {
        signals.push({
          code: "OCR_LOW_CONFIDENCE",
          severity: "review",
          reason: `OCR non ha rilevato: ${missingFields.join(", ")}. Richiede verifica del barista.`,
        });
      }
    }

    // ── Aggregazione finale ───────────────────────────────────────────────────
    const hasReject = signals.some((s) => s.severity === "reject");
    return {
      status: hasReject ? "red" : signals.length === 0 ? "green" : "yellow",
      signals,
    };
  }
}

export const semaphoreService = new SemaphoreService();
