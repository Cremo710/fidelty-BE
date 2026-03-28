import { databaseService } from "./databaseService.js";
import { fraudConfig } from "./fraudConfig.js";
import type { UserBehaviorStats, DuplicationContext } from "./trustScoreService.js";

// ────────────────────────────────────────────────────────────
//  Fraud Flags
// ────────────────────────────────────────────────────────────

export type FlagSeverity = "low" | "medium" | "high";

export interface FraudFlag {
  reason: string;
  severity: FlagSeverity;
}

// ────────────────────────────────────────────────────────────
//  Duplicate / similarity detection (Layer 2)
// ────────────────────────────────────────────────────────────

export async function checkImageDuplicate(imageHash: string): Promise<boolean> {
  const pool = databaseService.getPool();
  const { rows } = await pool.query(
    "SELECT 1 FROM receipts WHERE image_hash = $1 LIMIT 1",
    [imageHash],
  );
  return rows.length > 0;
}

export async function checkDocIdDuplicate(docId: string): Promise<boolean> {
  const existing = await databaseService.getReceipt(docId);
  return existing !== null;
}

/**
 * Counts recent receipts with the same total + same date + similar merchant tax id.
 */
export async function countSimilarReceipts(
  totalAmount: number | null,
  date: string | null,
  merchantTaxId: string | null,
  userId: string,
): Promise<number> {
  if (!totalAmount || !date) return 0;

  const pool = databaseService.getPool();
  const windowHours = fraudConfig.similarReceiptWindowHours;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM receipts
     WHERE user_id = $1
       AND total_amount = $2
       AND purchase_date::date = $3::date
       AND ($4::text IS NULL OR merchant_tax_id = $4)
       AND created_at > NOW() - INTERVAL '1 hour' * $5`,
    [userId, totalAmount, date, merchantTaxId, windowHours],
  );
  return rows[0]?.cnt ?? 0;
}

export async function buildDuplicationContext(
  imageHash: string,
  docId: string | null,
  totalAmount: number | null,
  date: string | null,
  merchantTaxId: string | null,
  userId: string,
): Promise<DuplicationContext> {
  const isImageDuplicate = await checkImageDuplicate(imageHash);
  const isDocIdDuplicate = docId ? await checkDocIdDuplicate(docId) : false;
  const similarReceiptsCount = await countSimilarReceipts(totalAmount, date, merchantTaxId, userId);

  return { isImageDuplicate, isDocIdDuplicate, similarReceiptsCount };
}

// ────────────────────────────────────────────────────────────
//  User stats & pattern detection
// ────────────────────────────────────────────────────────────

export async function getUserBehaviorStats(userId: string): Promise<UserBehaviorStats> {
  const pool = databaseService.getPool();

  // Single query: receipts today, points today, avg trust, total count
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN 1 ELSE 0 END), 0)::int AS receipts_today,
       COALESCE(SUM(CASE WHEN created_at::date = CURRENT_DATE THEN points_earned ELSE 0 END), 0)::int AS points_today,
       AVG(trust_score)::float AS avg_trust_score,
       COUNT(*)::int AS total_receipts
     FROM receipts
     WHERE user_id = $1`,
    [userId],
  );

  const row = rows[0] || {};

  // Check if user is flagged/banned
  const flagResult = await pool.query(
    "SELECT is_flagged FROM user_fraud_stats WHERE user_id = $1",
    [userId],
  );
  const isFlagged = flagResult.rows[0]?.is_flagged ?? false;

  return {
    receiptsToday: row.receipts_today ?? 0,
    pointsToday: row.points_today ?? 0,
    avgTrustScore: row.avg_trust_score ?? null,
    totalReceipts: row.total_receipts ?? 0,
    isFlagged,
  };
}

// ────────────────────────────────────────────────────────────
//  Fraud pattern detection – returns flags to store
// ────────────────────────────────────────────────────────────

export function detectFraudPatterns(
  dup: DuplicationContext,
  stats: UserBehaviorStats,
  identicalTotalCount: number,
): FraudFlag[] {
  const flags: FraudFlag[] = [];

  if (dup.isImageDuplicate) {
    flags.push({ reason: "Immagine duplicata (hash identico)", severity: "high" });
  }
  if (dup.isDocIdDuplicate) {
    flags.push({ reason: "Numero documento già presente", severity: "high" });
  }
  if (dup.similarReceiptsCount >= 2) {
    flags.push({
      reason: `${dup.similarReceiptsCount} ricevute simili (stesso importo/data) nelle ultime ${fraudConfig.similarReceiptWindowHours}h`,
      severity: dup.similarReceiptsCount >= 3 ? "high" : "medium",
    });
  }

  if (stats.receiptsToday >= fraudConfig.maxReceiptsPerDay) {
    flags.push({ reason: `Superato limite giornaliero di ${fraudConfig.maxReceiptsPerDay} ricevute`, severity: "high" });
  }
  if (stats.pointsToday >= fraudConfig.maxPointsPerDay) {
    flags.push({ reason: `Superato limite giornaliero di ${fraudConfig.maxPointsPerDay} punti`, severity: "high" });
  }

  if (identicalTotalCount >= fraudConfig.identicalTotalThreshold) {
    flags.push({
      reason: `${identicalTotalCount} ricevute con importo identico recenti`,
      severity: "medium",
    });
  }

  return flags;
}

// ────────────────────────────────────────────────────────────
//  Persistence helpers
// ────────────────────────────────────────────────────────────

export async function saveFraudFlags(receiptId: string, flags: FraudFlag[]): Promise<void> {
  if (flags.length === 0) return;
  const pool = databaseService.getPool();

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const f of flags) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
    values.push(receiptId, f.reason, f.severity);
    idx += 3;
  }

  await pool.query(
    `INSERT INTO fraud_flags (receipt_id, reason, severity) VALUES ${placeholders.join(", ")}`,
    values,
  );
}

export async function upsertUserFraudStats(
  userId: string,
  trustScore: number,
): Promise<void> {
  const pool = databaseService.getPool();
  await pool.query(
    `INSERT INTO user_fraud_stats (user_id, avg_trust_score, last_receipt_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       avg_trust_score = (
         COALESCE(user_fraud_stats.avg_trust_score, 0) * user_fraud_stats.total_receipts + $2
       ) / (user_fraud_stats.total_receipts + 1),
       total_receipts = user_fraud_stats.total_receipts + 1,
       last_receipt_at = NOW(),
       updated_at = NOW()`,
    [userId, trustScore],
  );
}

/**
 * Count recent receipts with the exact same total amount for this user.
 */
export async function countIdenticalTotals(
  userId: string,
  totalAmount: number,
): Promise<number> {
  const pool = databaseService.getPool();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM receipts
     WHERE user_id = $1
       AND total_amount = $2
       AND created_at > NOW() - INTERVAL '7 days'`,
    [userId, totalAmount],
  );
  return rows[0]?.cnt ?? 0;
}

// ────────────────────────────────────────────────────────────
//  Anti-Abuse: Rate limiter (in-memory, per-user, per-minute)
// ────────────────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60_000 });
    return true; // allowed
  }

  entry.count++;
  return entry.count <= fraudConfig.rateLimitPerMinute;
}

// ────────────────────────────────────────────────────────────
//  Admin helpers: flag / ban / revoke
// ────────────────────────────────────────────────────────────

export async function flagUser(userId: string): Promise<void> {
  const pool = databaseService.getPool();
  await pool.query(
    `INSERT INTO user_fraud_stats (user_id, is_flagged)
     VALUES ($1, TRUE)
     ON CONFLICT (user_id) DO UPDATE SET is_flagged = TRUE, updated_at = NOW()`,
    [userId],
  );
  console.log(`🚩 Utente ${userId} flaggato`);
}

export async function banUser(userId: string): Promise<void> {
  const pool = databaseService.getPool();
  await pool.query(
    `INSERT INTO user_fraud_stats (user_id, is_banned)
     VALUES ($1, TRUE)
     ON CONFLICT (user_id) DO UPDATE SET is_banned = TRUE, updated_at = NOW()`,
    [userId],
  );
  console.log(`🚫 Utente ${userId} bannato`);
}

export async function isUserBanned(userId: string): Promise<boolean> {
  const pool = databaseService.getPool();
  const { rows } = await pool.query(
    "SELECT is_banned FROM user_fraud_stats WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.is_banned ?? false;
}

export async function revokeReceiptPoints(receiptId: string): Promise<void> {
  const pool = databaseService.getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Get receipt info
    const { rows } = await client.query(
      "SELECT user_id, bar_id, points_earned FROM receipts WHERE id = $1",
      [receiptId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const { user_id, bar_id, points_earned } = rows[0];

    // Set points_earned to 0 and status to rejected
    await client.query(
      "UPDATE receipts SET points_earned = 0, status = 'rejected', updated_at = NOW() WHERE id = $1",
      [receiptId],
    );

    // Subtract from loyalty card
    if (user_id && bar_id && points_earned > 0) {
      await client.query(
        `UPDATE loyalty_cards
         SET points = GREATEST(0, points - $1), updated_at = NOW()
         WHERE user_id = $2 AND bar_id = $3`,
        [points_earned, user_id, bar_id],
      );
    }

    await client.query("COMMIT");
    console.log(`🔄 Punti revocati per ricevuta ${receiptId} (${points_earned} punti)`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
