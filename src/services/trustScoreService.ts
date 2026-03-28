import { fraudConfig } from "./fraudConfig.js";
import type { ParsedReceiptData, ExifInfo } from "./receiptValidationService.js";

/**
 * Trust Score Breakdown — each dimension contributes a weighted sub-score.
 */
export interface TrustScoreBreakdown {
  ocrCompleteness: number;      // 0-25
  dataConsistency: number;      // 0-25
  duplicationRisk: number;      // 0-25
  userBehavior: number;         // 0-25
  total: number;                // 0-100
}

export interface UserBehaviorStats {
  receiptsToday: number;
  pointsToday: number;
  avgTrustScore: number | null;
  totalReceipts: number;
  isFlagged: boolean;
}

// ── OCR Completeness (25 pts) ──────────────────────────────

function scoreOcrCompleteness(parsed: ParsedReceiptData): number {
  let score = 0;
  // Each present field adds points (total up to 25)
  if (parsed.docId) score += 5;
  if (parsed.merchantTaxId) score += 5;
  if (parsed.merchantName) score += 4;
  if (parsed.totalAmount !== null && parsed.totalAmount > 0) score += 5;
  if (parsed.date) score += 4;
  if (parsed.time) score += 2;
  return Math.min(25, score);
}

// ── Data Consistency (25 pts) ────────────────────────────────

interface ConsistencyContext {
  barPivaMatches: boolean;
  exif: ExifInfo | null;
}

function scoreDataConsistency(
  parsed: ParsedReceiptData,
  ctx: ConsistencyContext,
): number {
  let score = 15; // start at 15, deduct for problems

  // P.IVA matches a registered bar → bonus
  if (ctx.barPivaMatches) score += 5;

  // Date sanity – receipt date within last N days is good
  if (parsed.date) {
    const diff = (Date.now() - new Date(parsed.date).getTime()) / 86_400_000;
    if (diff >= 0 && diff <= 7) score += 5;
    else if (diff > fraudConfig.maxReceiptAgeDays) score -= 10;
    else if (diff < 0) score -= 15; // future date
  } else {
    score -= 5;
  }

  // EXIF checks
  if (ctx.exif) {
    if (ctx.exif.isScreenshot) score -= 10;
    if (ctx.exif.isEdited) score -= 10;
    if (!ctx.exif.hasExif) score -= 3; // minor penalty
  }

  return Math.max(0, Math.min(25, score));
}

// ── Duplication Risk (25 pts, higher = better) ──────────────

export interface DuplicationContext {
  isImageDuplicate: boolean;
  isDocIdDuplicate: boolean;
  /** Number of similar receipts (same total + same day + similar merchant) */
  similarReceiptsCount: number;
}

function scoreDuplicationRisk(ctx: DuplicationContext): number {
  if (ctx.isImageDuplicate || ctx.isDocIdDuplicate) return 0;
  let score = 25;
  // Each similar receipt reduces trust
  score -= ctx.similarReceiptsCount * 5;
  return Math.max(0, score);
}

// ── User Behavior (25 pts) ──────────────────────────────────

function scoreUserBehavior(stats: UserBehaviorStats): number {
  let score = 25;

  if (stats.isFlagged) score -= 15;

  // Too many uploads today
  const dailyRatio = stats.receiptsToday / fraudConfig.maxReceiptsPerDay;
  if (dailyRatio >= 1) score -= 15;
  else if (dailyRatio >= 0.7) score -= 5;

  // Low historical trust
  if (stats.avgTrustScore !== null && stats.avgTrustScore < 50) score -= 5;

  return Math.max(0, Math.min(25, score));
}

// ── Public API ──────────────────────────────────────────────

export function computeTrustScore(
  parsed: ParsedReceiptData,
  consistency: ConsistencyContext,
  duplication: DuplicationContext,
  userStats: UserBehaviorStats,
): TrustScoreBreakdown {
  const ocrCompleteness = scoreOcrCompleteness(parsed);
  const dataConsistency = scoreDataConsistency(parsed, consistency);
  const duplicationRisk = scoreDuplicationRisk(duplication);
  const userBehavior = scoreUserBehavior(userStats);
  const total = ocrCompleteness + dataConsistency + duplicationRisk + userBehavior;

  return { ocrCompleteness, dataConsistency, duplicationRisk, userBehavior, total };
}

/**
 * Maps a trust score to a receipt status and effective points multiplier.
 */
export function applyTrustScore(
  trustScore: number,
  rawPoints: number,
): { status: "approved" | "partial" | "rejected"; effectivePoints: number } {
  if (trustScore >= fraudConfig.trustFullPointsThreshold) {
    return { status: "approved", effectivePoints: rawPoints };
  }
  if (trustScore >= fraudConfig.trustPartialPointsThreshold) {
    return {
      status: "partial",
      effectivePoints: Math.max(1, Math.round(rawPoints * fraudConfig.partialPointsFraction)),
    };
  }
  return { status: "rejected", effectivePoints: 0 };
}
