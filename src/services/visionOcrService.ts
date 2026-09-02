/**
 * visionOcrService — Fase 1
 * Estrae i campi rilevanti da una foto di scontrino usando Google Cloud Vision.
 *
 * Sicurezza: ogni parser fallisce silenziosamente e in modo indipendente.
 * Un campo mancante NON è un'eccezione — è { value: null, confidence: 0 }.
 * Il fallimento totale del servizio NON è un'eccezione — è un risultato tutto-null
 * che attiva il percorso manuale nel controller.
 */

import ImageAnnotatorClient from "@google-cloud/vision";
import sharp from "sharp";

// ─── Tipi pubblici ─────────────────────────────────────────────────────────

export interface OcrField<T> {
  value: T | null;
  confidence: number;  // 0–1: 1 se letto, 0 se non trovato
  raw: string | null;  // testo grezzo da cui è stato estratto il valore
}

export interface OcrReceiptResult {
  amount:     OcrField<number>;   // in euro
  vatNumber:  OcrField<string>;   // 11 cifre
  docId:      OcrField<string>;   // formato XXXX-XXXX
  date:       OcrField<string>;   // ISO yyyy-mm-dd
  rawText:    string;
  durationMs: number;
}

// ─── Client Vision (lazy singleton) ────────────────────────────────────────

let _client: InstanceType<typeof ImageAnnotatorClient.ImageAnnotatorClient> | null = null;

function getVisionClient(): InstanceType<typeof ImageAnnotatorClient.ImageAnnotatorClient> {
  if (_client) return _client;

  const credJson = process.env.GOOGLE_CREDENTIALS;
  if (!credJson) {
    throw new Error("GOOGLE_CREDENTIALS non configurata");
  }

  let credentials: object;
  try {
    credentials = JSON.parse(credJson);
  } catch {
    try {
      credentials = JSON.parse(Buffer.from(credJson, "base64").toString("utf-8"));
    } catch {
      throw new Error("GOOGLE_CREDENTIALS: non è JSON valido né base64-encoded JSON");
    }
  }

  _client = new ImageAnnotatorClient.ImageAnnotatorClient({ credentials });
  return _client;
}

// ─── Pre-processing immagine ────────────────────────────────────────────────

async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: 1600, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ─── Parser: importo ────────────────────────────────────────────────────────
// Cerca le label principali e prende l'ULTIMO match (il totale finale è in fondo).
// Gestisce il formato italiano: 1.234,56 → 1234.56

const AMOUNT_LABELS = [
  /TOTALE\s+COMPLESSIVO/,
  /TOTALE\s+EURO/,
  /IMPORTO\s+PAGATO/,
  /TOTALE\s+DA\s+PAGARE/,
  /DA\s+PAGARE/,
  /TOTALE(?!\s+(?:PARZIALE|IVA|SCONTI|PUNTI))/,
];

// Numero in formato italiano: opzionale migliaia con punto, decimali con virgola
const ITALIAN_NUMBER_RE = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/;

function normalizeReceiptLines(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractMonetaryCandidate(line: string): { raw: string; value: number } | null {
  const matches = [...line.matchAll(ITALIAN_NUMBER_RE)];
  if (matches.length === 0) return null;

  const numericMatches = matches
    .map((match) => {
      const raw = match[1];
      const value = Number.parseFloat(raw.replace(/\./g, "").replace(",", "."));
      return Number.isFinite(value) && value > 0 ? { raw, value } : null;
    })
    .filter((match): match is { raw: string; value: number } => match !== null);

  if (numericMatches.length === 0) return null;

  if (numericMatches.length === 1) {
    return numericMatches[0];
  }

  const hasIntermediateTotals = /\b(?:IVA|SCONTO|IMPONIBILE|TASSA|TAX|FEE)\b/.test(line);
  return hasIntermediateTotals ? numericMatches[0] : numericMatches[numericMatches.length - 1];
}

function parseAmount(text: string): OcrField<number> {
  const lines = normalizeReceiptLines(text);

  let lastMatch: { raw: string; value: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const label of AMOUNT_LABELS) {
      if (!label.test(line)) continue;

      const currentLineCandidate = extractMonetaryCandidate(line);
      const nextLineCandidate = currentLineCandidate ? null : extractMonetaryCandidate(lines[index + 1] ?? "");
      const candidate = currentLineCandidate ?? nextLineCandidate;

      if (candidate) {
        lastMatch = candidate;
      }
    }
  }

  if (!lastMatch) return { value: null, confidence: 0, raw: null };
  return { value: lastMatch.value, confidence: 1, raw: lastMatch.raw };
}

// ─── Parser: P.IVA ──────────────────────────────────────────────────────────
// Cerca prima il pattern esplicito, poi sequenza di 11 cifre nell'intestazione.

const PIVA_EXPLICIT_RE = /P\.?\s*IVA\s*:?\s*(\d{11})/i;
const PIVA_FALLBACK_RE = /\b(\d{11})\b/g;

function parseVatNumber(text: string): OcrField<string> {
  const normalized = text.toUpperCase();

  // 1. Match esplicito
  const explicit = normalized.match(PIVA_EXPLICIT_RE);
  if (explicit) return { value: explicit[1], confidence: 1, raw: explicit[0] };

  // 2. Fallback: prima sequenza di 11 cifre nel primo terzo del testo
  const firstThird = normalized.slice(0, Math.floor(normalized.length / 3));
  let match: RegExpExecArray | null;
  while ((match = PIVA_FALLBACK_RE.exec(firstThird)) !== null) {
    const candidate = match[1];
    // Scarta numeri che sembrano date o codici diversi (lunghezza esatta 11)
    if (candidate.length === 11) {
      return { value: candidate, confidence: 0.7, raw: candidate };
    }
  }

  return { value: null, confidence: 0, raw: null };
}

// ─── Parser: docId (numero documento scontrino) ────────────────────────────

const DOC_ID_LABEL_RE = /(?:DOCUMENTO|DOC|N\.?\s*DOC\.?)/i;
const DOC_ID_RE = /(?:DOCUMENTO|DOC|N\.?\s*DOC\.?)\s*(?:N\.?|NO\.?|NUM\.?|N°)?\s*([0-9A-Z]{4})\s*[-\/\s]?\s*([0-9A-Z]{4})/i;
const DOC_ID_SPLIT_RE = /\b([0-9A-Z]{4})\s*[-\/\s]\s*([0-9A-Z]{4})\b/;

function extractDocIdFromLine(line: string): OcrField<string> {
  const directMatch = line.match(DOC_ID_RE);
  if (directMatch) {
    return {
      value: `${directMatch[1]}-${directMatch[2]}`,
      confidence: 1,
      raw: directMatch[0],
    };
  }

  const splitMatch = line.match(DOC_ID_SPLIT_RE);
  if (splitMatch && DOC_ID_LABEL_RE.test(line)) {
    return {
      value: `${splitMatch[1]}-${splitMatch[2]}`,
      confidence: 0.9,
      raw: splitMatch[0],
    };
  }

  return { value: null, confidence: 0, raw: null };
}

function parseDocId(text: string): OcrField<string> {
  const lines = normalizeReceiptLines(text);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!DOC_ID_LABEL_RE.test(line)) {
      continue;
    }

    const lineCandidate = extractDocIdFromLine(line);
    if (lineCandidate.value) {
      return lineCandidate;
    }

    const nextLineCandidate = extractDocIdFromLine(lines[index + 1] ?? "");
    if (nextLineCandidate.value) {
      return nextLineCandidate;
    }
  }

  return { value: null, confidence: 0, raw: null };
}

// ─── Parser: data ───────────────────────────────────────────────────────────
// Formati: dd-mm-yyyy, dd/mm/yyyy, dd.mm.yy

const DATE_RE = /\b(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{2,4})\b/;

function parseDate(text: string): OcrField<string> {
  const match = text.match(DATE_RE);
  if (!match) return { value: null, confidence: 0, raw: null };
  const day = match[1];
  const month = match[2];
  const rawYear = match[3];
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const iso = `${year}-${month}-${day}`;
  // Sanity check
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { value: null, confidence: 0, raw: match[0] };
  return { value: iso, confidence: 1, raw: match[0] };
}

// ─── Entry point principale ─────────────────────────────────────────────────

export async function extractReceiptFields(image: Buffer): Promise<OcrReceiptResult> {
  const startMs = Date.now();

  // Risultato di fallback (tutto null): permette al flusso di degradare a manuale
  const nullResult: OcrReceiptResult = {
    amount:    { value: null, confidence: 0, raw: null },
    vatNumber: { value: null, confidence: 0, raw: null },
    docId:     { value: null, confidence: 0, raw: null },
    date:      { value: null, confidence: 0, raw: null },
    rawText:   "",
    durationMs: 0,
  };

  try {
    const client = getVisionClient();

    // Pre-processing
    const processed = await preprocessImage(image);

    // Chiamata Vision con timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    let rawText = "";
    try {
      const [result] = await client.documentTextDetection({
        image: { content: processed.toString("base64") },
      });
      console.log("Raw OCR result:", result);
      rawText = result.fullTextAnnotation?.text ?? "";
    } finally {
      clearTimeout(timeoutId);
    }

    if (!rawText) return { ...nullResult, durationMs: Date.now() - startMs };

    // Parsing indipendente per ogni campo
    const amount    = tryParse(() => parseAmount(rawText));
    const vatNumber = tryParse(() => parseVatNumber(rawText));
    const docId     = tryParse(() => parseDocId(rawText));
    const date      = tryParse(() => parseDate(rawText));

    return {
      amount,
      vatNumber,
      docId,
      date,
      rawText,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    console.warn("⚠️ OCR extractReceiptFields fallito:", (err as Error).message);
    return { ...nullResult, durationMs: Date.now() - startMs };
  }
}

/** Esegue il parser in modo silenzioso: se fallisce, ritorna campo null. */
function tryParse<T>(parser: () => OcrField<T>): OcrField<T> {
  try {
    return parser();
  } catch {
    return { value: null, confidence: 0, raw: null };
  }
}
