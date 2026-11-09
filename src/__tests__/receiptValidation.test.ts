import { describe, expect, it } from "vitest";
import {
  isValidItalianVatNumber,
  RECEIPT_VALIDATION_CONFIG,
  validateReceiptOcr,
} from "../services/receiptValidation.js";
import { extractDocId, type OcrReceiptResult } from "../services/visionOcrService.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const RAW_TEXT = `BAR IL CORTILETTO
P.Iva 03739970139
TOTALE COMPLESSIVO
5.00
DI CUI IVA
PAGAMENTO ELETTRONICO
IMPORTO PAGATO
PREZZO(€) IVA
5.00 B
06/11/26 23:51
DOC.2449-0085
RT 1BMPX050938`;

function validResult(): OcrReceiptResult {
  return {
    amount: { value: 5, confidence: 0.75, raw: "5.00", label: "TOTALE COMPLESSIVO", line: "5.00 B" },
    vatNumber: { value: "03739970139", confidence: 1, raw: "P.IVA 03739970139" },
    docId: { value: "2449-0085", confidence: 1, raw: "2449-0085" },
    date: { value: "2026-11-06", confidence: 1, raw: "06/11/26" },
    rawText: RAW_TEXT,
    durationMs: 9000,
  };
}

describe("receipt OCR validation", () => {
  it("accepts and normalizes a consistent receipt with amount confidence 0.75", () => {
    expect(validateReceiptOcr(validResult(), { now: NOW })).toMatchObject({
      valid: true,
      data: {
        amount: 5,
        vatNumber: "03739970139",
        docId: "2449-0085",
        receiptDate: "2026-11-06",
      },
    });
  });

  it("validates the Italian VAT checksum", () => {
    expect(isValidItalianVatNumber("03739970139")).toBe(true);
    expect(isValidItalianVatNumber("03739970130")).toBe(false);
    expect(isValidItalianVatNumber("0373997013")).toBe(false);
  });

  it("accepts a confidently extracted progressive-only document number", () => {
    const candidate = extractDocId("NR. 0085");
    if (!candidate) throw new Error("Expected document number candidate");
    const result = validResult();
    result.docId = {
      value: candidate.value,
      confidence: Math.min(1, candidate.score / 85),
      raw: candidate.raw,
    };
    expect(validateReceiptOcr(result, { now: NOW })).toMatchObject({
      valid: true,
      data: { docId: "0085" },
    });
  });

  const cases: Array<[string, (result: OcrReceiptResult) => void, string]> = [
    ["RECEIPT_AMOUNT_NOT_FOUND", (r) => { r.amount.value = null; }, "RECEIPT_AMOUNT_NOT_FOUND"],
    ["RECEIPT_AMOUNT_INVALID", (r) => { r.amount.value = 0; }, "RECEIPT_AMOUNT_INVALID"],
    ["RECEIPT_AMOUNT_LOW_CONFIDENCE", (r) => { r.amount.confidence = 0.1; }, "RECEIPT_AMOUNT_LOW_CONFIDENCE"],
    ["RECEIPT_AMOUNT_MISMATCH", (r) => { r.rawText = r.rawText.replace("5.00 B", "6.00 B"); }, "RECEIPT_AMOUNT_MISMATCH"],
    ["RECEIPT_VAT_NOT_FOUND", (r) => { r.vatNumber.value = null; }, "RECEIPT_VAT_NOT_FOUND"],
    ["RECEIPT_VAT_INVALID", (r) => { r.vatNumber.value = "03739970130"; }, "RECEIPT_VAT_INVALID"],
    ["RECEIPT_VAT_LOW_CONFIDENCE", (r) => { r.vatNumber.confidence = 0.1; }, "RECEIPT_VAT_LOW_CONFIDENCE"],
    ["RECEIPT_VAT_MISMATCH", (r) => { r.rawText = r.rawText.replace("03739970139", "12345678903"); }, "RECEIPT_VAT_MISMATCH"],
    ["RECEIPT_DATE_NOT_FOUND", (r) => { r.date.value = null; }, "RECEIPT_DATE_NOT_FOUND"],
    ["RECEIPT_DATE_INVALID", (r) => { r.date.value = "2026-02-31"; }, "RECEIPT_DATE_INVALID"],
    ["RECEIPT_DATE_LOW_CONFIDENCE", (r) => { r.date.confidence = 0.1; }, "RECEIPT_DATE_LOW_CONFIDENCE"],
    ["RECEIPT_DATE_MISMATCH", (r) => { r.rawText = r.rawText.replace("06/11/26", "05/11/26"); }, "RECEIPT_DATE_MISMATCH"],
    ["RECEIPT_DATE_FUTURE", (r) => { r.date.value = "2026-11-10"; r.rawText = r.rawText.replace("06/11/26", "10/11/26"); }, "RECEIPT_DATE_FUTURE"],
    ["RECEIPT_DATE_EXPIRED", (r) => { r.date.value = "2026-10-01"; r.rawText = r.rawText.replace("06/11/26", "01/10/26"); }, "RECEIPT_DATE_EXPIRED"],
    ["RECEIPT_DOC_ID_NOT_FOUND", (r) => { r.docId.value = null; }, "RECEIPT_DOC_ID_NOT_FOUND"],
    ["RECEIPT_DOC_ID_LOW_CONFIDENCE", (r) => { r.docId.confidence = 0.1; }, "RECEIPT_DOC_ID_LOW_CONFIDENCE"],
  ];

  it.each(cases)("rejects %s with its dedicated error code", (_name, mutate, code) => {
    const result = validResult();
    mutate(result);
    expect(validateReceiptOcr(result, { now: NOW })).toEqual({ valid: false, code });
  });

  it("allows confidence and validity thresholds to be configured", () => {
    const result = validResult();
    const config = { ...RECEIPT_VALIDATION_CONFIG, minAmountConfidence: 0.8 };
    expect(validateReceiptOcr(result, { now: NOW, config })).toEqual({
      valid: false,
      code: "RECEIPT_AMOUNT_LOW_CONFIDENCE",
    });
  });
});
