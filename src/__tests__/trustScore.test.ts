import { describe, it, expect } from "vitest";
import {
  computeTrustScore,
  applyTrustScore,
  type UserBehaviorStats,
  type DuplicationContext,
} from "../services/trustScoreService.js";
import type { ParsedReceiptData, ExifInfo } from "../services/receiptValidationService.js";

// ── Helpers ──────────────────────────────────────────────

function makeParsed(overrides: Partial<ParsedReceiptData> = {}): ParsedReceiptData {
  return {
    docId: "0001-0001",
    merchantTaxId: "12345678901",
    merchantName: "Bar Test",
    totalAmount: 5.5,
    date: new Date().toISOString().slice(0, 10),
    time: "14:30",
    merchantAddress: "Via Roma 1",
    rawText: "sample",
    ...overrides,
  };
}

function makeExif(overrides: Partial<ExifInfo> = {}): ExifInfo {
  return {
    hasExif: true,
    timestamp: "2024-01-01T12:00:00",
    cameraModel: "Apple",
    software: null,
    isScreenshot: false,
    isEdited: false,
    ...overrides,
  };
}

function makeNoDuplication(): DuplicationContext {
  return { isImageDuplicate: false, isDocIdDuplicate: false, similarReceiptsCount: 0 };
}

function makeGoodUser(): UserBehaviorStats {
  return {
    receiptsToday: 1,
    pointsToday: 5,
    avgTrustScore: 90,
    totalReceipts: 10,
    isFlagged: false,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("computeTrustScore", () => {
  it("gives high score for a perfect receipt", () => {
    const score = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    expect(score.total).toBeGreaterThanOrEqual(80);
    expect(score.ocrCompleteness).toBeGreaterThan(0);
    expect(score.dataConsistency).toBeGreaterThan(0);
    expect(score.duplicationRisk).toBe(25);
    expect(score.userBehavior).toBeGreaterThan(0);
  });

  it("gives 0 duplicationRisk for duplicate image", () => {
    const score = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      { isImageDuplicate: true, isDocIdDuplicate: false, similarReceiptsCount: 0 },
      makeGoodUser(),
    );
    expect(score.duplicationRisk).toBe(0);
  });

  it("penalizes screenshots in data consistency", () => {
    const normal = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    const screenshot = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif({ isScreenshot: true }) },
      makeNoDuplication(),
      makeGoodUser(),
    );
    expect(screenshot.dataConsistency).toBeLessThan(normal.dataConsistency);
  });

  it("penalizes edited images", () => {
    const normal = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    const edited = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif({ isEdited: true, software: "Photoshop" }) },
      makeNoDuplication(),
      makeGoodUser(),
    );
    expect(edited.dataConsistency).toBeLessThan(normal.dataConsistency);
  });

  it("penalizes flagged users", () => {
    const normal = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    const flagged = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      { ...makeGoodUser(), isFlagged: true },
    );
    expect(flagged.userBehavior).toBeLessThan(normal.userBehavior);
  });

  it("penalizes too many uploads today", () => {
    const score = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      { ...makeGoodUser(), receiptsToday: 15 },
    );
    expect(score.userBehavior).toBeLessThanOrEqual(10);
  });

  it("reduces score when OCR fields are missing", () => {
    const full = computeTrustScore(
      makeParsed(),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    const partial = computeTrustScore(
      makeParsed({ merchantName: null, time: null, merchantAddress: null }),
      { barPivaMatches: true, exif: makeExif() },
      makeNoDuplication(),
      makeGoodUser(),
    );
    expect(partial.ocrCompleteness).toBeLessThan(full.ocrCompleteness);
  });
});

describe("applyTrustScore", () => {
  it("gives full points for score >= 80", () => {
    const result = applyTrustScore(85, 10);
    expect(result.status).toBe("approved");
    expect(result.effectivePoints).toBe(10);
  });

  it("gives partial points for score 50-79", () => {
    const result = applyTrustScore(65, 10);
    expect(result.status).toBe("partial");
    expect(result.effectivePoints).toBe(5); // 50% of 10
  });

  it("gives 0 points for score < 50", () => {
    const result = applyTrustScore(30, 10);
    expect(result.status).toBe("rejected");
    expect(result.effectivePoints).toBe(0);
  });

  it("returns at least 1 point in partial band", () => {
    const result = applyTrustScore(55, 1);
    expect(result.status).toBe("partial");
    expect(result.effectivePoints).toBeGreaterThanOrEqual(1);
  });
});
