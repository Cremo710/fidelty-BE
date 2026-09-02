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
  /TOTALE(?!\s+(?:PARZIALE|IVA|SCONTI|PUNTI))/,
];

// Numero in formato italiano: opzionale migliaia con punto, decimali con virgola
const ITALIAN_NUMBER_RE = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/;

function parseAmount(text: string): OcrField<number> {
  // Normalizza: uppercase, collassa spazi multipli
  const normalized = text.toUpperCase().replace(/\s+/g, " ");
  const lines = normalized.split(/\n|\r\n?/);

  let lastMatch: { raw: string; value: number } | null = null;

  for (const line of lines) {
    for (const label of AMOUNT_LABELS) {
      if (!label.test(line)) continue;
      const numberMatch = line.match(ITALIAN_NUMBER_RE);
      if (!numberMatch) continue;
      const raw = numberMatch[1];
      const value = Number.parseFloat(raw.replace(/\./g, "").replace(",", "."));
      if (Number.isFinite(value) && value > 0) {
        lastMatch = { raw, value };
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

const DOC_ID_RE = /(?:DOCUMENTO\s*N\.?|DOC\.?\s*N\.?|N\.?\s*DOC\.?)\s*(\d{4})\s*[-\/]?\s*(\d{4})/i;

function parseDocId(text: string): OcrField<string> {
  const match = text.match(DOC_ID_RE);
  if (!match) return { value: null, confidence: 0, raw: null };
  const value = `${match[1]}-${match[2]}`;
  return { value, confidence: 1, raw: match[0] };
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
