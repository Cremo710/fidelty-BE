import { createHash } from "crypto";
import { fraudConfig } from "./fraudConfig.js";

// ────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  /** Human-readable reasons when valid === false */
  errors: string[];
  /** Non-blocking warnings (suspicious but not rejected) */
  warnings: string[];
}

export interface ParsedReceiptData {
  docId: string | null;
  merchantTaxId: string | null;
  merchantName: string | null;
  totalAmount: number | null;
  date: string | null;      // YYYY-MM-DD
  time: string | null;      // HH:MM
  merchantAddress: string | null;
  rawText: string;
}

// ────────────────────────────────────────────────────────────
//  Image hash (SHA-256) for duplicate image detection
// ────────────────────────────────────────────────────────────

export function computeImageHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

// ────────────────────────────────────────────────────────────
//  Receipt field validation (Layer 1)
// ────────────────────────────────────────────────────────────

export function validateReceiptFields(parsed: ParsedReceiptData): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Total amount
  if (parsed.totalAmount === null || parsed.totalAmount === undefined) {
    errors.push("Importo totale mancante o non valido");
  } else if (parsed.totalAmount <= 0) {
    errors.push("Importo totale deve essere maggiore di zero");
  }

  // 2. Date checks
  if (parsed.date) {
    const receiptDate = new Date(parsed.date);
    const now = new Date();

    // Future date
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    if (receiptDate >= tomorrow) {
      errors.push("La data dello scontrino è nel futuro");
    }

    // Too old
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - fraudConfig.maxReceiptAgeDays);
    cutoff.setHours(0, 0, 0, 0);
    if (receiptDate < cutoff) {
      errors.push(
        `Lo scontrino è più vecchio di ${fraudConfig.maxReceiptAgeDays} giorni`,
      );
    }
  } else {
    warnings.push("Data scontrino non rilevata");
  }

  // 3. Document ID
  if (!parsed.docId) {
    errors.push("Numero documento mancante");
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ────────────────────────────────────────────────────────────
//  EXIF metadata extraction (Layer 3 – best-effort)
// ────────────────────────────────────────────────────────────

export interface ExifInfo {
  hasExif: boolean;
  timestamp: string | null;
  cameraModel: string | null;
  software: string | null;
  isScreenshot: boolean;
  isEdited: boolean;
}

/**
 * Lightweight EXIF probe – reads the first bytes of a JPEG buffer
 * to look for EXIF markers without pulling in a heavy dependency.
 * Returns best-effort metadata.
 */
export function extractExifInfo(buffer: Buffer): ExifInfo {
  const info: ExifInfo = {
    hasExif: false,
    timestamp: null,
    cameraModel: null,
    software: null,
    isScreenshot: false,
    isEdited: false,
  };

  // Quick ASCII scan of the first 64 KB for common EXIF strings
  const head = buffer.subarray(0, Math.min(buffer.length, 65536)).toString("binary");

  // Check for EXIF header marker
  info.hasExif = head.includes("Exif");

  // Try to extract date (pattern: YYYY:MM:DD HH:MM:SS)
  const dateMatch = head.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (dateMatch) {
    const [, y, m, d, hh, mm, ss] = dateMatch;
    info.timestamp = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  }

  // Camera model
  const modelPatterns = ["Apple", "Samsung", "Google", "Xiaomi", "HUAWEI", "OnePlus", "OPPO", "Pixel"];
  for (const brand of modelPatterns) {
    if (head.includes(brand)) {
      info.cameraModel = brand;
      break;
    }
  }

  // Screenshot indicators
  const screenshotHints = ["Screenshot", "screenshot", "Snipping", "Screen Capture"];
  info.isScreenshot = screenshotHints.some((h) => head.includes(h));

  // Edit indicators (common editors write software tags)
  const editHints = ["Photoshop", "GIMP", "Paint", "Canva", "PicsArt"];
  info.software = null;
  for (const hint of editHints) {
    if (head.includes(hint)) {
      info.software = hint;
      info.isEdited = true;
      break;
    }
  }

  return info;
}
