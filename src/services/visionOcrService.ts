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

export interface AmountField {
  value: number | null;
  confidence: number;   // 0–1
  raw: string | null;   // token numerico grezzo
  label: string | null; // label su cui è stato agganciato
  line: string | null;  // riga completa, utile per il debug
}

export interface ParseAmountOptions {
  /** Importo massimo plausibile per uno scontrino bar. Default 2000 €. */
  maxAmount?: number;
  /** Righe da guardare in avanti se la label non ha numeri sulla propria riga. Default 2. */
  lookaheadLines?: number;
  /**
   * Se true e nessuna label viene trovata, cerca l'ultimo importo con decimali
   * nella parte finale dello scontrino. Confidenza bassa. Default true.
   */
  enableFallback?: boolean;
}

export interface OcrReceiptResult {
  amount:     AmountField;        // in euro
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
// Righe preservate, lookup dopo label, ranking per priorità e fallback finale.

const AMOUNT_LABELS: Array<{ name: string; re: RegExp; priority: number }> = [
  { name: "TOTALE COMPLESSIVO", re: /\bTOTALE\s+COMPLESSIVO\b/, priority: 100 },
  { name: "TOTALE DA PAGARE", re: /\bTOTALE\s+DA\s+PAGARE\b/, priority: 96 },
  { name: "TOTALE DOCUMENTO", re: /\bTOTALE\s+DOCUMENTO\b/, priority: 94 },
  { name: "IMPORTO PAGATO", re: /\bIMPORTO\s+PAGATO\b/, priority: 92 },
  { name: "TOTALE EURO", re: /\bTOTALE\s+EUROS?\b|\bTOTALE\s+€/, priority: 90 },
  { name: "TOTALE", re: /\bTOTALE\b/, priority: 60 },
];

const NOISE_LINE = new RegExp(
  [
    "\\bSUBTOTALE\\b",
    "\\bTOTALE\\s+PARZIALE\\b",
    "\\bTOTALE\\s+IVA\\b",
    "\\bDI\\s+CUI\\s+IVA\\b",
    "\\bIMPONIBILE\\b",
    "\\bALIQUOTA\\b",
    "\\bTOTALE\\s+SCONT",
    "\\bSCONTO\\b",
    "\\bTOTALE\\s+PUNTI\\b",
    "\\bPUNTI\\b",
    "\\bRESTO\\b",
    "\\bNON\\s+RISCOSSO\\b",
    "\\bTOTALE\\s+ARTICOLI\\b",
    "\\bN\\.?\\s*ARTICOLI\\b",
    "\\bPEZZI\\b",
    "\\bTOTALE\\s+RESI\\b",
    "\\bANNULL",
  ].join("|"),
);

const NUMBER_TOKEN = /\d{1,3}(?:[.\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;

export function parseItalianNumber(raw: string): number | null {
  const s = raw.replace(/\s/g, "");
  if (!/\d/.test(s)) return null;

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let sepIndex = -1;

  if (lastComma > -1 && lastDot > -1) {
    sepIndex = Math.max(lastComma, lastDot);
  } else if (lastComma > -1) {
    sepIndex = lastComma;
  } else if (lastDot > -1) {
    sepIndex = s.length - lastDot - 1 === 3 ? -1 : lastDot;
  }

  if (sepIndex === -1) {
    const n = Number(s.replace(/[.,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  const intPart = s.slice(0, sepIndex).replace(/[.,]/g, "");
  const decPart = s.slice(sepIndex + 1);
  const n = Number(`${intPart || "0"}.${decPart}`);
  return Number.isFinite(n) ? n : null;
}

interface Candidate {
  value: number;
  raw: string;
  hasDecimals: boolean;
}

function findCandidates(segment: string, maxAmount: number): Candidate[] {
  const out: Candidate[] = [];
  const re = new RegExp(NUMBER_TOKEN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = re.exec(segment)) !== null) {
    const raw = match[0];
    const value = parseItalianNumber(raw);
    if (value === null || value <= 0 || value > maxAmount) continue;
    out.push({ raw, value, hasDecimals: /[.,]\d{1,2}$/.test(raw.replace(/\s/g, "")) });
  }

  return out;
}

function pickCandidate(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  const withDecimals = candidates.filter((candidate) => candidate.hasDecimals);
  const pool = withDecimals.length > 0 ? withDecimals : candidates;
  return pool[pool.length - 1];
}

function normalizeReceiptLines(text: string): string[] {
  return toLines(text);
}

function toLines(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/\u00A0/g, " ")
    .replace(/[^\S\r\n]+/g, " ")
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseAmount(text: string, options: ParseAmountOptions = {}): AmountField {
  const maxAmount = options.maxAmount ?? 2000;
  const lookahead = options.lookaheadLines ?? 2;
  const enableFallback = options.enableFallback ?? true;

  if (!text || typeof text !== "string") {
    return { value: null, confidence: 0, raw: null, label: null, line: null };
  }

  const lines = toLines(text);
  if (lines.length === 0) {
    return { value: null, confidence: 0, raw: null, label: null, line: null };
  }

  let best: (AmountField & { score: number }) | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (NOISE_LINE.test(line)) continue;

    for (const label of AMOUNT_LABELS) {
      const match = line.match(label.re);
      if (!match || match.index === undefined) continue;

      const after = line.slice(match.index + match[0].length);
      let candidate = pickCandidate(findCandidates(after, maxAmount));
      let fromNextLine = false;
      let sourceLine = line;

      if (!candidate) {
        for (let look = index + 1; look <= index + lookahead && look < lines.length; look += 1) {
          if (NOISE_LINE.test(lines[look])) continue;
          const next = pickCandidate(findCandidates(lines[look], maxAmount));
          if (next) {
            candidate = next;
            fromNextLine = true;
            sourceLine = lines[look];
            break;
          }
        }
      }

      if (!candidate) continue;

      const score =
        label.priority +
        (candidate.hasDecimals ? 10 : 0) -
        (fromNextLine ? 20 : 0) +
        index / lines.length;

      let confidence: number;
      if (label.priority >= 90) confidence = candidate.hasDecimals ? 0.95 : 0.55;
      else confidence = candidate.hasDecimals ? 0.8 : 0.45;
      if (fromNextLine) confidence -= 0.2;

      if (!best || score > best.score) {
        best = {
          value: candidate.value,
          confidence: Math.max(0, Math.round(confidence * 100) / 100),
          raw: candidate.raw,
          label: label.name,
          line: sourceLine,
          score,
        };
      }

      break;
    }
  }

  if (best) {
    const { score: _score, ...field } = best;
    return field;
  }

  if (enableFallback) {
    const tail = lines.slice(Math.floor(lines.length * 0.6));
    const pool: Array<{ c: Candidate; line: string }> = [];

    for (const line of tail) {
      if (NOISE_LINE.test(line)) continue;
      for (const candidate of findCandidates(line, maxAmount)) {
        if (candidate.hasDecimals) pool.push({ c: candidate, line });
      }
    }

    if (pool.length > 0) {
      const top = pool.reduce((current, next) => (next.c.value > current.c.value ? next : current));
      return {
        value: top.c.value,
        confidence: 0.3,
        raw: top.c.raw,
        label: null,
        line: top.line,
      };
    }
  }

  return { value: null, confidence: 0, raw: null, label: null, line: null };
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
    amount:    { value: null, confidence: 0, raw: null, label: null, line: null },
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
function tryParse<T>(parser: () => T): T {
  try {
    return parser();
  } catch {
    return { value: null, confidence: 0, raw: null } as T;
  }
}
