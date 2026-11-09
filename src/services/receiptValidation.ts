import { parseItalianNumber, type OcrReceiptResult } from "./visionOcrService.js";

function configuredNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const RECEIPT_VALIDATION_CONFIG = {
  minAmountConfidence: configuredNumber("RECEIPT_OCR_MIN_AMOUNT_CONFIDENCE", 0.65),
  minVatConfidence: configuredNumber("RECEIPT_OCR_MIN_VAT_CONFIDENCE", 0.7),
  minDateConfidence: configuredNumber("RECEIPT_OCR_MIN_DATE_CONFIDENCE", 0.7),
  minDocIdConfidence: configuredNumber("RECEIPT_OCR_MIN_DOC_ID_CONFIDENCE", 0.6),
  maxReceiptAgeDays: configuredNumber("RECEIPT_MAX_AGE_DAYS", 7),
  maxAmount: configuredNumber("RECEIPT_MAX_AMOUNT_EUR", 2000),
} as const;

export type ReceiptValidationErrorCode =
  | "RECEIPT_AMOUNT_NOT_FOUND"
  | "RECEIPT_AMOUNT_INVALID"
  | "RECEIPT_AMOUNT_LOW_CONFIDENCE"
  | "RECEIPT_AMOUNT_MISMATCH"
  | "RECEIPT_VAT_NOT_FOUND"
  | "RECEIPT_VAT_INVALID"
  | "RECEIPT_VAT_LOW_CONFIDENCE"
  | "RECEIPT_VAT_MISMATCH"
  | "RECEIPT_DATE_NOT_FOUND"
  | "RECEIPT_DATE_INVALID"
  | "RECEIPT_DATE_LOW_CONFIDENCE"
  | "RECEIPT_DATE_MISMATCH"
  | "RECEIPT_DATE_FUTURE"
  | "RECEIPT_DATE_EXPIRED"
  | "RECEIPT_DOC_ID_NOT_FOUND"
  | "RECEIPT_DOC_ID_LOW_CONFIDENCE";

export interface ValidatedReceipt {
  amount: number;
  vatNumber: string;
  docId: string;
  receiptDate: string;
  fieldsFound: { amount: true; vatNumber: true; docId: true; date: true };
}

export type ReceiptValidationResult =
  | { valid: true; data: ValidatedReceipt }
  | { valid: false; code: ReceiptValidationErrorCode };

export function isValidItalianVatNumber(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const digit = Number(value[index]);
    if (index % 2 === 1) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return (10 - (sum % 10)) % 10 === Number(value[10]);
}

function normalizeIsoDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function rawReceiptDates(text: string): string[] {
  const matches = text.matchAll(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})\b/g);
  return Array.from(matches, (match) => {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return normalizeIsoDate(`${year}-${match[2]}-${match[1]}`);
  }).filter((date): date is string => date !== null);
}

function rawVatNumbers(text: string): string[] {
  return Array.from(text.matchAll(/\b\d{11}\b/g), (match) => match[0]);
}

const AMOUNT_LABEL_RE = /\b(?:IMPORTO\s+PAGATO|TOTALE\s+(?:COMPLESSIVO|DA\s+PAGARE|DOCUMENTO|EURO)|TOTALE)\b/i;
const STOP_AMOUNT_SCAN_RE = /\b(?:IMPORTO\s+PAGATO|TOTALE(?:\s+(?:COMPLESSIVO|DA\s+PAGARE|DOCUMENTO|EURO))?|DOCUMENTO\s+COMMERCIALE|DOC\.?|RT\b|P\.?\s*IVA)\b/i;
const SKIP_AMOUNT_LINE_RE = /\b(?:DI\s+CUI\s+IVA|SUBTOTALE|IVA\b|PAGAMENTO|PREZZO|DESCRIZIONE|RESTO|SCONTO|PUNTI)\b|^\s*\(?\d+\)?\s*$/i;
const RAW_MONEY_RE = /(?:€\s*)?(\d{1,3}(?:[.\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*€)?/g;

function labeledRawAmounts(text: string): number[] {
  const lines = text.toUpperCase().replace(/\u00a0/g, " ").split(/\r\n|\r|\n/).map((line) => line.trim());
  const amounts = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const labelMatch = AMOUNT_LABEL_RE.exec(lines[index]);
    AMOUNT_LABEL_RE.lastIndex = 0;
    if (!labelMatch) continue;

    for (let offset = 0; offset <= 4 && index + offset < lines.length; offset += 1) {
      const line = lines[index + offset];
      if (offset > 0 && STOP_AMOUNT_SCAN_RE.test(line)) break;
      if (SKIP_AMOUNT_LINE_RE.test(line) || /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2}:\d{2}\b/.test(line)) continue;
      const segment = offset === 0 ? line.slice((labelMatch.index ?? 0) + labelMatch[0].length) : line;
      const moneyRegex = new RegExp(RAW_MONEY_RE.source, "g");
      let match: RegExpExecArray | null;
      while ((match = moneyRegex.exec(segment)) !== null) {
        const value = parseItalianNumber(match[1]);
        if (value !== null && value > 0) amounts.add(value);
      }
    }
  }
  return [...amounts];
}

function todayIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function validateReceiptOcr(
  result: OcrReceiptResult,
  options: { now?: Date; config?: typeof RECEIPT_VALIDATION_CONFIG } = {},
): ReceiptValidationResult {
  const config = options.config ?? RECEIPT_VALIDATION_CONFIG;
  const now = options.now ?? new Date();
  const amount = result.amount.value;
  if (amount === null) return { valid: false, code: "RECEIPT_AMOUNT_NOT_FOUND" };
  if (!Number.isFinite(amount) || amount <= 0 || amount > config.maxAmount) {
    return { valid: false, code: "RECEIPT_AMOUNT_INVALID" };
  }
  if (result.amount.confidence < config.minAmountConfidence) {
    return { valid: false, code: "RECEIPT_AMOUNT_LOW_CONFIDENCE" };
  }
  const rawAmounts = labeledRawAmounts(result.rawText);
  if (rawAmounts.some((rawAmount) => Math.abs(rawAmount - amount) > 0.01)) {
    return { valid: false, code: "RECEIPT_AMOUNT_MISMATCH" };
  }

  const vatNumber = result.vatNumber.value?.replace(/\D/g, "") ?? "";
  if (!vatNumber) return { valid: false, code: "RECEIPT_VAT_NOT_FOUND" };
  if (!isValidItalianVatNumber(vatNumber)) return { valid: false, code: "RECEIPT_VAT_INVALID" };
  if (result.vatNumber.confidence < config.minVatConfidence) {
    return { valid: false, code: "RECEIPT_VAT_LOW_CONFIDENCE" };
  }
  const rawVat = rawVatNumbers(result.rawText);
  if (rawVat.length === 0 || !rawVat.includes(vatNumber)) {
    return { valid: false, code: "RECEIPT_VAT_MISMATCH" };
  }

  const receiptDate = result.date.value ? normalizeIsoDate(result.date.value) : null;
  if (!result.date.value) return { valid: false, code: "RECEIPT_DATE_NOT_FOUND" };
  if (!receiptDate) return { valid: false, code: "RECEIPT_DATE_INVALID" };
  if (result.date.confidence < config.minDateConfidence) {
    return { valid: false, code: "RECEIPT_DATE_LOW_CONFIDENCE" };
  }
  if (!rawReceiptDates(result.rawText).includes(receiptDate)) {
    return { valid: false, code: "RECEIPT_DATE_MISMATCH" };
  }
  const today = todayIso(now);
  if (receiptDate > today) return { valid: false, code: "RECEIPT_DATE_FUTURE" };
  const ageDays = (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${receiptDate}T00:00:00.000Z`)) / 86_400_000;
  if (ageDays > config.maxReceiptAgeDays) return { valid: false, code: "RECEIPT_DATE_EXPIRED" };

  const docId = result.docId.value?.trim() ?? "";
  if (!/^(\d{4}-\d{4}|\d{4})$/.test(docId)) {
    return { valid: false, code: "RECEIPT_DOC_ID_NOT_FOUND" };
  }
  if (result.docId.confidence < config.minDocIdConfidence) {
    return { valid: false, code: "RECEIPT_DOC_ID_LOW_CONFIDENCE" };
  }

  return {
    valid: true,
    data: {
      amount: Math.round(amount * 100) / 100,
      vatNumber,
      docId,
      receiptDate,
      fieldsFound: { amount: true, vatNumber: true, docId: true, date: true },
    },
  };
}
