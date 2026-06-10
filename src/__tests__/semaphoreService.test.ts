import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Receipt code pattern validation ────────────────────────────────────────
const RECEIPT_CODE_RE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;

describe("Receipt code validation", () => {
  it("accepts valid numeric format", () => {
    expect(RECEIPT_CODE_RE.test("0817-0046")).toBe(true);
  });

  it("accepts alphanumeric blocks", () => {
    expect(RECEIPT_CODE_RE.test("A1B2-C3D4")).toBe(true);
  });

  it("rejects missing dash", () => {
    expect(RECEIPT_CODE_RE.test("08170046")).toBe(false);
  });

  it("rejects wrong block length", () => {
    expect(RECEIPT_CODE_RE.test("081-0046")).toBe(false);
    expect(RECEIPT_CODE_RE.test("08177-0046")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(RECEIPT_CODE_RE.test("")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(RECEIPT_CODE_RE.test("0817-00#6")).toBe(false);
  });
});

// ─── Semaphore signal logic (pure unit tests, no DB) ─────────────────────────

type Signal = { code: string; reason: string; duplicateRequestId?: string };

interface BarConfig {
  gpsRadiusMeters: number;
  autoCreditEnabled: boolean;
  capEnabled: boolean;
  capAmount: number;
  anomalyEnabled: boolean;
  youngAccountEnabled: boolean;
}

interface PlatformCfg {
  anomalyMultiplier: number;
  youngAccountMinDays: number;
  youngAccountMinRequests: number;
  youngAccountMaxAmount: number;
  rateLimitPerUserPerBarPerDay: number;
}

/** Pure signal evaluation extracted for unit testing (no DB side effects) */
function evaluateSignals(
  amount: number,
  barConfig: BarConfig,
  platform: PlatformCfg,
  opts: {
    duplicateExists?: boolean;
    duplicateRequestId?: string;
    historicalAvg?: number | null;
    accountAgeDays?: number;
    approvedRequestCount?: number;
    todayCount?: number;
  },
): { signals: Signal[]; rateLimitExceeded: boolean } {
  const signals: Signal[] = [];

  if ((opts.todayCount ?? 0) >= platform.rateLimitPerUserPerBarPerDay) {
    return { signals, rateLimitExceeded: true };
  }

  if (opts.duplicateExists) {
    signals.push({
      code: "DUPLICATE",
      reason: "Duplicate receipt code",
      duplicateRequestId: opts.duplicateRequestId,
    });
  }

  if (barConfig.capEnabled && amount > barConfig.capAmount) {
    signals.push({ code: "CAP_EXCEEDED", reason: `Amount ${amount} exceeds cap ${barConfig.capAmount}` });
  }

  if (barConfig.anomalyEnabled && opts.historicalAvg !== null && opts.historicalAvg !== undefined) {
    if (opts.historicalAvg > 0 && amount > opts.historicalAvg * platform.anomalyMultiplier) {
      signals.push({ code: "ANOMALY", reason: `Amount ${amount} > ${platform.anomalyMultiplier}× avg ${opts.historicalAvg}` });
    }
  }

  if (barConfig.youngAccountEnabled) {
    const isYoung =
      (opts.accountAgeDays ?? Infinity) < platform.youngAccountMinDays ||
      (opts.approvedRequestCount ?? Infinity) < platform.youngAccountMinRequests;
    if (isYoung && amount > platform.youngAccountMaxAmount) {
      signals.push({ code: "YOUNG_ACCOUNT", reason: "Young account with high amount" });
    }
  }

  return { signals, rateLimitExceeded: false };
}

const defaultBarConfig: BarConfig = {
  gpsRadiusMeters: 100,
  autoCreditEnabled: true,
  capEnabled: false,
  capAmount: 100,
  anomalyEnabled: false,
  youngAccountEnabled: false,
};

const defaultPlatform: PlatformCfg = {
  anomalyMultiplier: 3,
  youngAccountMinDays: 7,
  youngAccountMinRequests: 3,
  youngAccountMaxAmount: 40,
  rateLimitPerUserPerBarPerDay: 15,
};

describe("Semaphore signal evaluation", () => {
  // ── Green path ──────────────────────────────────────────────────────────────
  it("returns green (no signals) for a clean request", () => {
    const { signals } = evaluateSignals(15, defaultBarConfig, defaultPlatform, {});
    expect(signals).toHaveLength(0);
  });

  // ── Rate limit ──────────────────────────────────────────────────────────────
  it("triggers rate limit when todayCount >= 15", () => {
    const { rateLimitExceeded } = evaluateSignals(10, defaultBarConfig, defaultPlatform, { todayCount: 15 });
    expect(rateLimitExceeded).toBe(true);
  });

  it("does NOT trigger rate limit when todayCount == 14", () => {
    const { rateLimitExceeded } = evaluateSignals(10, defaultBarConfig, defaultPlatform, { todayCount: 14 });
    expect(rateLimitExceeded).toBe(false);
  });

  // ── Signal 1: Duplicate ─────────────────────────────────────────────────────
  it("signals DUPLICATE when receipt code already exists today", () => {
    const { signals } = evaluateSignals(20, defaultBarConfig, defaultPlatform, {
      duplicateExists: true,
      duplicateRequestId: "01JX00000000000000000001",
    });
    expect(signals.some((s) => s.code === "DUPLICATE")).toBe(true);
    expect(signals.find((s) => s.code === "DUPLICATE")?.duplicateRequestId).toBe("01JX00000000000000000001");
  });

  it("duplicate is still flagged even when amount is small (always active)", () => {
    const { signals } = evaluateSignals(1, defaultBarConfig, defaultPlatform, { duplicateExists: true });
    expect(signals.some((s) => s.code === "DUPLICATE")).toBe(true);
  });

  // ── Signal 2: Cap ───────────────────────────────────────────────────────────
  it("does NOT signal CAP_EXCEEDED when cap is disabled", () => {
    const { signals } = evaluateSignals(200, { ...defaultBarConfig, capEnabled: false, capAmount: 100 }, defaultPlatform, {});
    expect(signals.some((s) => s.code === "CAP_EXCEEDED")).toBe(false);
  });

  it("signals CAP_EXCEEDED when cap is enabled and amount exceeds it", () => {
    const { signals } = evaluateSignals(150, { ...defaultBarConfig, capEnabled: true, capAmount: 100 }, defaultPlatform, {});
    expect(signals.some((s) => s.code === "CAP_EXCEEDED")).toBe(true);
  });

  it("does NOT signal CAP_EXCEEDED when amount equals cap exactly", () => {
    const { signals } = evaluateSignals(100, { ...defaultBarConfig, capEnabled: true, capAmount: 100 }, defaultPlatform, {});
    expect(signals.some((s) => s.code === "CAP_EXCEEDED")).toBe(false);
  });

  // ── Signal 3: Anomaly ───────────────────────────────────────────────────────
  it("does NOT signal ANOMALY when anomaly flag is disabled", () => {
    const { signals } = evaluateSignals(
      100,
      { ...defaultBarConfig, anomalyEnabled: false },
      defaultPlatform,
      { historicalAvg: 10 },
    );
    expect(signals.some((s) => s.code === "ANOMALY")).toBe(false);
  });

  it("signals ANOMALY when amount > 3× historical average (anomaly enabled)", () => {
    const { signals } = evaluateSignals(
      100,
      { ...defaultBarConfig, anomalyEnabled: true },
      defaultPlatform,
      { historicalAvg: 20 },
    );
    // 100 > 20 * 3 = 60 → anomaly
    expect(signals.some((s) => s.code === "ANOMALY")).toBe(true);
  });

  it("does NOT signal ANOMALY when amount is exactly 3× avg", () => {
    const { signals } = evaluateSignals(
      60,
      { ...defaultBarConfig, anomalyEnabled: true },
      defaultPlatform,
      { historicalAvg: 20 },
    );
    expect(signals.some((s) => s.code === "ANOMALY")).toBe(false);
  });

  it("does NOT signal ANOMALY when no historical data", () => {
    const { signals } = evaluateSignals(
      1000,
      { ...defaultBarConfig, anomalyEnabled: true },
      defaultPlatform,
      { historicalAvg: null },
    );
    expect(signals.some((s) => s.code === "ANOMALY")).toBe(false);
  });

  // ── Signal 4: Young account ─────────────────────────────────────────────────
  it("does NOT signal YOUNG_ACCOUNT when flag is disabled", () => {
    const { signals } = evaluateSignals(50, { ...defaultBarConfig, youngAccountEnabled: false }, defaultPlatform, {
      accountAgeDays: 1,
      approvedRequestCount: 0,
    });
    expect(signals.some((s) => s.code === "YOUNG_ACCOUNT")).toBe(false);
  });

  it("signals YOUNG_ACCOUNT for account < 7 days with amount > 40 (flag enabled)", () => {
    const { signals } = evaluateSignals(50, { ...defaultBarConfig, youngAccountEnabled: true }, defaultPlatform, {
      accountAgeDays: 3,
      approvedRequestCount: 10,
    });
    expect(signals.some((s) => s.code === "YOUNG_ACCOUNT")).toBe(true);
  });

  it("signals YOUNG_ACCOUNT for account with < 3 approved requests with amount > 40", () => {
    const { signals } = evaluateSignals(50, { ...defaultBarConfig, youngAccountEnabled: true }, defaultPlatform, {
      accountAgeDays: 30,
      approvedRequestCount: 2,
    });
    expect(signals.some((s) => s.code === "YOUNG_ACCOUNT")).toBe(true);
  });

  it("does NOT signal YOUNG_ACCOUNT when amount <= 40 even for young account", () => {
    const { signals } = evaluateSignals(40, { ...defaultBarConfig, youngAccountEnabled: true }, defaultPlatform, {
      accountAgeDays: 1,
      approvedRequestCount: 0,
    });
    expect(signals.some((s) => s.code === "YOUNG_ACCOUNT")).toBe(false);
  });

  it("does NOT signal YOUNG_ACCOUNT for established account with normal amount", () => {
    const { signals } = evaluateSignals(50, { ...defaultBarConfig, youngAccountEnabled: true }, defaultPlatform, {
      accountAgeDays: 30,
      approvedRequestCount: 5,
    });
    expect(signals.some((s) => s.code === "YOUNG_ACCOUNT")).toBe(false);
  });

  // ── Multiple signals can fire simultaneously ────────────────────────────────
  it("can fire multiple signals at once (duplicate + cap)", () => {
    const { signals } = evaluateSignals(
      150,
      { ...defaultBarConfig, capEnabled: true, capAmount: 100 },
      defaultPlatform,
      { duplicateExists: true },
    );
    const codes = signals.map((s) => s.code);
    expect(codes).toContain("DUPLICATE");
    expect(codes).toContain("CAP_EXCEEDED");
  });
});

// ─── Consumption detail tolerance validation (±20%) ──────────────────────────

function evaluateDetailTolerance(
  declaredAmount: number,
  itemsTotal: number,
  tolerancePct = 20,
): { status: "verified" | "low_quality"; bonusAwarded: boolean } {
  const min = declaredAmount * (1 - tolerancePct / 100);
  const max = declaredAmount * (1 + tolerancePct / 100);
  const withinTolerance = itemsTotal >= min && itemsTotal <= max;
  return {
    status: withinTolerance ? "verified" : "low_quality",
    bonusAwarded: withinTolerance,
  };
}

describe("Consumption detail tolerance (±20%)", () => {
  it("verifies detail when items total is exactly declared amount", () => {
    expect(evaluateDetailTolerance(20, 20)).toMatchObject({ status: "verified", bonusAwarded: true });
  });

  it("verifies detail when items total is exactly at lower bound (−20%)", () => {
    expect(evaluateDetailTolerance(20, 16)).toMatchObject({ status: "verified", bonusAwarded: true });
  });

  it("verifies detail when items total is exactly at upper bound (+20%)", () => {
    expect(evaluateDetailTolerance(20, 24)).toMatchObject({ status: "verified", bonusAwarded: true });
  });

  it("marks low_quality when items total is just below lower bound", () => {
    expect(evaluateDetailTolerance(20, 15.99)).toMatchObject({ status: "low_quality", bonusAwarded: false });
  });

  it("marks low_quality when items total is just above upper bound", () => {
    expect(evaluateDetailTolerance(20, 24.01)).toMatchObject({ status: "low_quality", bonusAwarded: false });
  });

  it("verifies detail within tolerance with real-world values", () => {
    // declared 18.50 €, items total 17 € — within ±20% (min 14.80, max 22.20)
    expect(evaluateDetailTolerance(18.5, 17)).toMatchObject({ status: "verified", bonusAwarded: true });
  });
});
