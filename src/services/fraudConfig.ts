/**
 * Fraud Prevention Configuration
 * All thresholds are configurable via environment variables.
 */

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export const fraudConfig = {
  // ── Layer 1: Basic Validation ──
  /** Max receipt age in days (older receipts are rejected) */
  get maxReceiptAgeDays(): number {
    return envInt("FRAUD_MAX_RECEIPT_AGE_DAYS", 30);
  },

  // ── Layer 2: Duplicate & Pattern Detection ──
  /** Max receipts a single user can upload per day */
  get maxReceiptsPerDay(): number {
    return envInt("FRAUD_MAX_RECEIPTS_PER_DAY", 10);
  },
  /** Max points a single user can earn per day */
  get maxPointsPerDay(): number {
    return envInt("FRAUD_MAX_POINTS_PER_DAY", 500);
  },
  /** Number of identical-total receipts before flagging */
  get identicalTotalThreshold(): number {
    return envInt("FRAUD_IDENTICAL_TOTAL_THRESHOLD", 3);
  },
  /** Time window (hours) for similar-receipt detection */
  get similarReceiptWindowHours(): number {
    return envInt("FRAUD_SIMILAR_RECEIPT_WINDOW_HOURS", 24);
  },

  // ── Layer 4: Trust Scoring ──
  /** Trust score at or above which full points are awarded */
  get trustFullPointsThreshold(): number {
    return envInt("FRAUD_TRUST_FULL_POINTS", 80);
  },
  /** Trust score at or above which partial points are awarded (below → 0 points + flag) */
  get trustPartialPointsThreshold(): number {
    return envInt("FRAUD_TRUST_PARTIAL_POINTS", 50);
  },
  /** Fraction of points awarded in the partial band (0‑1) */
  get partialPointsFraction(): number {
    return envFloat("FRAUD_PARTIAL_POINTS_FRACTION", 0.5);
  },

  // ── Anti-Abuse ──
  /** Rate limit: max upload requests per user per minute */
  get rateLimitPerMinute(): number {
    return envInt("FRAUD_RATE_LIMIT_PER_MINUTE", 5);
  },
} as const;
