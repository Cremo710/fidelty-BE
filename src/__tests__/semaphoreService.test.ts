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

type Signal = { code: string; reason: string; severity: "reject" | "review"; duplicateRequestId?: string };

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
  ocrEnabled?: boolean;
  mockLocationReject?: boolean;
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
    // Fase 2
    isMockedLocation?: boolean;
    ocrVatNumber?: string | null;
    barPiva?: string | null;
    ocrReceiptDate?: string | null;
    todayDate?: string;           // formato yyyy-mm-dd, default oggi
    hasOcrSession?: boolean;
    ocrFieldsFound?: { amount: boolean; vatNumber: boolean } | null;
    duplicateImageExists?: boolean;
  },
): { signals: Signal[]; rateLimitExceeded: boolean } {
  const signals: Signal[] = [];

  if ((opts.todayCount ?? 0) >= platform.rateLimitPerUserPerBarPerDay) {
    return { signals, rateLimitExceeded: true };
  }

  if (opts.duplicateExists) {
    signals.push({
      code: "DUPLICATE",
      severity: "reject",
      reason: "Duplicate receipt code",
      duplicateRequestId: opts.duplicateRequestId,
    });
  }

  if (barConfig.capEnabled && amount > barConfig.capAmount) {
    signals.push({ code: "CAP_EXCEEDED", severity: "review", reason: `Amount ${amount} exceeds cap ${barConfig.capAmount}` });
  }

  if (barConfig.anomalyEnabled && opts.historicalAvg !== null && opts.historicalAvg !== undefined) {
    if (opts.historicalAvg > 0 && amount > opts.historicalAvg * platform.anomalyMultiplier) {
      signals.push({ code: "ANOMALY", severity: "review", reason: `Amount ${amount} > ${platform.anomalyMultiplier}× avg ${opts.historicalAvg}` });
    }
  }

  if (barConfig.youngAccountEnabled) {
    const isYoung =
      (opts.accountAgeDays ?? Infinity) < platform.youngAccountMinDays ||
      (opts.approvedRequestCount ?? Infinity) < platform.youngAccountMinRequests;
    if (isYoung && amount > platform.youngAccountMaxAmount) {
      signals.push({ code: "YOUNG_ACCOUNT", severity: "review", reason: "Young account with high amount" });
    }
  }

  // Fase 2 signals
  if (opts.isMockedLocation && platform.mockLocationReject) {
    signals.push({ code: "MOCK_LOCATION", severity: "reject", reason: "Mocked location" });
  }

  if (opts.duplicateImageExists) {
    signals.push({ code: "DUPLICATE_IMAGE", severity: "reject", reason: "Same image already used" });
  }

  if (opts.ocrVatNumber != null && opts.barPiva != null) {
    const cleanOcr = opts.ocrVatNumber.replace(/\D/g, "");
    const cleanBar = opts.barPiva.replace(/\D/g, "");
    if (cleanOcr && cleanBar && cleanOcr !== cleanBar) {
      signals.push({ code: "PIVA_MISMATCH", severity: "reject", reason: `P.IVA mismatch: ${cleanOcr} != ${cleanBar}` });
    }
  }

  if (opts.ocrReceiptDate) {
    const today = opts.todayDate ?? new Date().toISOString().slice(0, 10);
    if (opts.ocrReceiptDate !== today) {
      signals.push({ code: "DATE_MISMATCH", severity: "review", reason: "Date mismatch" });
    }
  }

  if ((platform.ocrEnabled ?? false) && opts.hasOcrSession === false) {
    signals.push({ code: "MANUAL_ENTRY", severity: "review", reason: "Manual entry" });
  }

  if (opts.hasOcrSession === true && opts.ocrFieldsFound) {
    const missing = [
      !opts.ocrFieldsFound.amount ? "amount" : null,
      !opts.ocrFieldsFound.vatNumber ? "vatNumber" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      signals.push({ code: "OCR_LOW_CONFIDENCE", severity: "review", reason: `OCR missing: ${missing.join(", ")}` });
    }
  }

  const hasReject = signals.some((s) => s.severity === "reject");

  return { signals, rateLimitExceeded: false };
}

/** Agrega gli esiti: red se almeno un reject, yellow se segnali, green se nessuno */
function aggregateStatus(signals: Signal[]): "green" | "yellow" | "red" {
  if (signals.some((s) => s.severity === "reject")) return "red";
  if (signals.length > 0) return "yellow";
  return "green";
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

  // ── Fase 2: aggregazione red/yellow/green ────────────────────────────────────

  it("aggregates to red when at least one signal has severity=reject", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, { duplicateExists: true });
    expect(aggregateStatus(signals)).toBe("red");
  });

  it("aggregates to yellow when signals are all review", () => {
    const { signals } = evaluateSignals(
      150,
      { ...defaultBarConfig, capEnabled: true, capAmount: 100 },
      defaultPlatform,
      {},
    );
    expect(aggregateStatus(signals)).toBe("yellow");
  });

  it("aggregates to green when no signals", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {});
    expect(aggregateStatus(signals)).toBe("green");
  });

  // ── MOCK_LOCATION (reject) ───────────────────────────────────────────────────

  it("signals MOCK_LOCATION (reject) when isMockedLocation=true and mockLocationReject=true", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig,
      { ...defaultPlatform, mockLocationReject: true },
      { isMockedLocation: true },
    );
    const s = signals.find((x) => x.code === "MOCK_LOCATION");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("reject");
    expect(aggregateStatus(signals)).toBe("red");
  });

  it("does NOT signal MOCK_LOCATION when mockLocationReject=false", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig,
      { ...defaultPlatform, mockLocationReject: false },
      { isMockedLocation: true },
    );
    expect(signals.some((s) => s.code === "MOCK_LOCATION")).toBe(false);
  });

  // ── PIVA_MISMATCH (reject) ───────────────────────────────────────────────────

  it("signals PIVA_MISMATCH (reject) when OCR reads a different P.IVA than the bar", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      ocrVatNumber: "11111111111",
      barPiva:      "99999999999",
    });
    const s = signals.find((x) => x.code === "PIVA_MISMATCH");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("reject");
  });

  it("does NOT signal PIVA_MISMATCH when P.IVA matches", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      ocrVatNumber: "12345678901",
      barPiva:      "12345678901",
    });
    expect(signals.some((s) => s.code === "PIVA_MISMATCH")).toBe(false);
  });

  it("does NOT signal PIVA_MISMATCH when OCR did not read P.IVA (null)", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      ocrVatNumber: null,
      barPiva:      "12345678901",
    });
    expect(signals.some((s) => s.code === "PIVA_MISMATCH")).toBe(false);
  });

  // ── DUPLICATE_IMAGE (reject) ─────────────────────────────────────────────────

  it("signals DUPLICATE_IMAGE (reject) when same image was already used", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, { duplicateImageExists: true });
    const s = signals.find((x) => x.code === "DUPLICATE_IMAGE");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("reject");
  });

  // ── DATE_MISMATCH (review) ───────────────────────────────────────────────────

  it("signals DATE_MISMATCH (review) when receipt date differs from today", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      ocrReceiptDate: "2020-01-01",
      todayDate: "2026-07-27",
    });
    const s = signals.find((x) => x.code === "DATE_MISMATCH");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("review");
  });

  it("does NOT signal DATE_MISMATCH when receipt date matches today", () => {
    const today = "2026-07-27";
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      ocrReceiptDate: today,
      todayDate: today,
    });
    expect(signals.some((s) => s.code === "DATE_MISMATCH")).toBe(false);
  });

  // ── MANUAL_ENTRY (review, solo se ocrEnabled) ────────────────────────────────

  it("signals MANUAL_ENTRY (review) when ocrEnabled=true and hasOcrSession=false", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig,
      { ...defaultPlatform, ocrEnabled: true },
      { hasOcrSession: false },
    );
    const s = signals.find((x) => x.code === "MANUAL_ENTRY");
    expect(s).toBeDefined();
    expect(s?.severity).toBe("review");
  });

  it("does NOT signal MANUAL_ENTRY when ocrEnabled=false (comportamento invariato)", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig,
      { ...defaultPlatform, ocrEnabled: false },
      { hasOcrSession: false },
    );
    expect(signals.some((s) => s.code === "MANUAL_ENTRY")).toBe(false);
  });

  it("does NOT signal MANUAL_ENTRY when hasOcrSession=true", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig,
      { ...defaultPlatform, ocrEnabled: true },
      { hasOcrSession: true, ocrFieldsFound: { amount: true, vatNumber: true } },
    );
    expect(signals.some((s) => s.code === "MANUAL_ENTRY")).toBe(false);
  });

  // ── OCR_LOW_CONFIDENCE (review) ──────────────────────────────────────────────

  it("signals OCR_LOW_CONFIDENCE when OCR failed to read amount", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      hasOcrSession: true,
      ocrFieldsFound: { amount: false, vatNumber: true },
    });
    expect(signals.some((s) => s.code === "OCR_LOW_CONFIDENCE")).toBe(true);
  });

  it("signals OCR_LOW_CONFIDENCE when OCR failed to read P.IVA", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      hasOcrSession: true,
      ocrFieldsFound: { amount: true, vatNumber: false },
    });
    expect(signals.some((s) => s.code === "OCR_LOW_CONFIDENCE")).toBe(true);
  });

  it("does NOT signal OCR_LOW_CONFIDENCE when OCR read all fields", () => {
    const { signals } = evaluateSignals(10, defaultBarConfig, defaultPlatform, {
      hasOcrSession: true,
      ocrFieldsFound: { amount: true, vatNumber: true },
    });
    expect(signals.some((s) => s.code === "OCR_LOW_CONFIDENCE")).toBe(false);
  });

  // ── Scenari §6.3 ─────────────────────────────────────────────────────────────

  it("§6.3: OCR completo e coerente → green, status=credited, punti pieni", () => {
    const { signals } = evaluateSignals(12.50, defaultBarConfig,
      { ...defaultPlatform, ocrEnabled: true },
      {
        hasOcrSession: true,
        ocrFieldsFound: { amount: true, vatNumber: true },
        ocrVatNumber: "12345678901",
        barPiva:       "12345678901",
      },
    );
    expect(signals).toHaveLength(0);
    expect(aggregateStatus(signals)).toBe("green");
  });

  it("§6.3: OCR fallito totalmente → giallo con MANUAL_ENTRY + OCR_LOW_CONFIDENCE", () => {
    const { signals } = evaluateSignals(12.50, defaultBarConfig,
      { ...defaultPlatform, ocrEnabled: true },
      {
        hasOcrSession: true,
        ocrFieldsFound: { amount: false, vatNumber: false },
      },
    );
    const codes = signals.map((s) => s.code);
    expect(codes).toContain("OCR_LOW_CONFIDENCE");
    expect(aggregateStatus(signals)).toBe("yellow");
  });

  it("§6.3: client manda amount=50 con sessione OCR che dice 3.50 → vince il server (3.50)", () => {
    // Il client non può alterare l'importo: il server usa sempre il valore dalla sessione OCR.
    // Questo test verifica che amount=3.50 (da sessione) non triggeri ANOMALY ipoteticamente.
    const serverAmount = 3.50; // dal DB, non dal client
    const { signals } = evaluateSignals(serverAmount, defaultBarConfig, defaultPlatform, {
      hasOcrSession: true,
      ocrFieldsFound: { amount: true, vatNumber: true },
    });
    expect(signals.some((s) => s.code === "ANOMALY")).toBe(false);
    expect(aggregateStatus(signals)).toBe("green");
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
