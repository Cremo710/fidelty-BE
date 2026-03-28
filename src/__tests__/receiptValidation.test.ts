import { describe, it, expect } from "vitest";
import {
  computeImageHash,
  validateReceiptFields,
  extractExifInfo,
  type ParsedReceiptData,
} from "../services/receiptValidationService.js";

// ────────────────────────────────────────────────────────────
//  computeImageHash
// ────────────────────────────────────────────────────────────

describe("computeImageHash", () => {
  it("returns a 64-char hex SHA-256 hash", () => {
    const buf = Buffer.from("test-image-content");
    const hash = computeImageHash(buf);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hashes for different buffers", () => {
    const h1 = computeImageHash(Buffer.from("image-a"));
    const h2 = computeImageHash(Buffer.from("image-b"));
    expect(h1).not.toBe(h2);
  });

  it("returns identical hashes for identical buffers", () => {
    const buf = Buffer.from("same-content");
    expect(computeImageHash(buf)).toBe(computeImageHash(buf));
  });
});

// ────────────────────────────────────────────────────────────
//  validateReceiptFields
// ────────────────────────────────────────────────────────────

function makeParsed(overrides: Partial<ParsedReceiptData> = {}): ParsedReceiptData {
  return {
    docId: "0001-0001",
    merchantTaxId: "12345678901",
    merchantName: "Bar Test",
    totalAmount: 5.5,
    date: new Date().toISOString().slice(0, 10), // today
    time: "14:30",
    merchantAddress: "Via Roma 1",
    rawText: "sample receipt",
    ...overrides,
  };
}

describe("validateReceiptFields", () => {
  it("passes for a complete valid receipt", () => {
    const result = validateReceiptFields(makeParsed());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects when totalAmount is null", () => {
    const result = validateReceiptFields(makeParsed({ totalAmount: null }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Importo"))).toBe(true);
  });

  it("rejects when totalAmount is 0", () => {
    const result = validateReceiptFields(makeParsed({ totalAmount: 0 }));
    expect(result.valid).toBe(false);
  });

  it("rejects a future date", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    const result = validateReceiptFields(
      makeParsed({ date: futureDate.toISOString().slice(0, 10) }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("futuro"))).toBe(true);
  });

  it("rejects a receipt older than max age", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const result = validateReceiptFields(
      makeParsed({ date: oldDate.toISOString().slice(0, 10) }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("vecchio"))).toBe(true);
  });

  it("warns when date is missing (does not reject)", () => {
    const result = validateReceiptFields(makeParsed({ date: null }));
    expect(result.valid).toBe(true); // date is a warning, not error
    expect(result.warnings.some((w) => w.includes("Data"))).toBe(true);
  });

  it("rejects when docId is missing", () => {
    const result = validateReceiptFields(makeParsed({ docId: null }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("documento"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
//  extractExifInfo
// ────────────────────────────────────────────────────────────

describe("extractExifInfo", () => {
  it("detects Exif header when present", () => {
    const buf = Buffer.from("...Exif...2024:01:15 10:30:00...Apple...");
    const info = extractExifInfo(buf);
    expect(info.hasExif).toBe(true);
    expect(info.timestamp).toBe("2024-01-15T10:30:00");
    expect(info.cameraModel).toBe("Apple");
  });

  it("detects edited images", () => {
    const buf = Buffer.from("...Photoshop...");
    const info = extractExifInfo(buf);
    expect(info.isEdited).toBe(true);
    expect(info.software).toBe("Photoshop");
  });

  it("detects screenshots", () => {
    const buf = Buffer.from("...Screenshot...");
    const info = extractExifInfo(buf);
    expect(info.isScreenshot).toBe(true);
  });

  it("handles empty buffer", () => {
    const buf = Buffer.alloc(0);
    const info = extractExifInfo(buf);
    expect(info.hasExif).toBe(false);
    expect(info.isScreenshot).toBe(false);
    expect(info.isEdited).toBe(false);
  });
});
