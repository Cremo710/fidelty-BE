import { describe, it, expect, vi } from "vitest";

// Mock databaseService before importing fraudDetectionService
vi.mock("../services/databaseService.js", () => ({
  databaseService: {
    getPool: () => ({ query: vi.fn() }),
    getReceipt: vi.fn(),
  },
}));

import {
  detectFraudPatterns,
  checkRateLimit,
} from "../services/fraudDetectionService.js";
import type { DuplicationContext, UserBehaviorStats } from "../services/trustScoreService.js";

// ── Helpers ──────────────────────────────────────────────

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

// ── detectFraudPatterns ──────────────────────────────────

describe("detectFraudPatterns", () => {
  it("returns no flags for clean receipt", () => {
    const flags = detectFraudPatterns(makeNoDuplication(), makeGoodUser(), 0);
    expect(flags).toHaveLength(0);
  });

  it("flags image duplicate", () => {
    const flags = detectFraudPatterns(
      { isImageDuplicate: true, isDocIdDuplicate: false, similarReceiptsCount: 0 },
      makeGoodUser(),
      0,
    );
    expect(flags.some((f) => f.reason.includes("Immagine duplicata"))).toBe(true);
    expect(flags.find((f) => f.reason.includes("Immagine"))!.severity).toBe("high");
  });

  it("flags doc ID duplicate", () => {
    const flags = detectFraudPatterns(
      { isImageDuplicate: false, isDocIdDuplicate: true, similarReceiptsCount: 0 },
      makeGoodUser(),
      0,
    );
    expect(flags.some((f) => f.reason.includes("documento"))).toBe(true);
  });

  it("flags similar receipts", () => {
    const flags = detectFraudPatterns(
      { isImageDuplicate: false, isDocIdDuplicate: false, similarReceiptsCount: 3 },
      makeGoodUser(),
      0,
    );
    expect(flags.some((f) => f.reason.includes("simili"))).toBe(true);
  });

  it("flags daily receipt limit exceeded", () => {
    const flags = detectFraudPatterns(
      makeNoDuplication(),
      { ...makeGoodUser(), receiptsToday: 15 },
      0,
    );
    expect(flags.some((f) => f.reason.includes("limite giornaliero"))).toBe(true);
  });

  it("flags daily point limit exceeded", () => {
    const flags = detectFraudPatterns(
      makeNoDuplication(),
      { ...makeGoodUser(), pointsToday: 600 },
      0,
    );
    expect(flags.some((f) => f.reason.includes("punti"))).toBe(true);
  });

  it("flags identical totals", () => {
    const flags = detectFraudPatterns(makeNoDuplication(), makeGoodUser(), 5);
    expect(flags.some((f) => f.reason.includes("importo identico"))).toBe(true);
  });
});

// ── Rate Limiter ─────────────────────────────────────────

describe("checkRateLimit", () => {
  it("allows first request", () => {
    // Use a unique user ID to avoid test interference
    const uid = `test-user-${Date.now()}`;
    expect(checkRateLimit(uid)).toBe(true);
  });

  it("blocks after exceeding limit", () => {
    const uid = `test-bulk-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(uid);
    }
    // 6th request should be blocked (limit is 5/min)
    expect(checkRateLimit(uid)).toBe(false);
  });
});
