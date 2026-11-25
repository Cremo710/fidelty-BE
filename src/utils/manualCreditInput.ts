/**
 * Validazione dell'input dell'accredito manuale.
 * `Number.parseFloat` accettava "12abc" (→ 12) e "1e2" (→ 100): qui l'importo deve essere
 * un numero in euro con al massimo due decimali, separatore "." o ",".
 */

const AMOUNT_RE = /^\d{1,6}([.,]\d{1,2})?$/;
export const MANUAL_CREDIT_NOTE_MAX_LENGTH = 200;

/** Importo in euro, oppure null se non valido (formato, decimali, zero o negativo). */
export function parseManualCreditAmount(raw: unknown): number | null {
  let amount: number;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    // Al massimo due decimali (tolleranza per la rappresentazione binaria, es. 0.1 + 0.2)
    if (Math.abs(Math.round(raw * 100) - raw * 100) > 1e-6) return null;
    amount = Math.round(raw * 100) / 100;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!AMOUNT_RE.test(trimmed)) return null;
    amount = Number(trimmed.replace(",", "."));
  } else {
    return null;
  }
  return amount > 0 ? amount : null;
}

export type NoteParseResult = { ok: true; note: string | null } | { ok: false };

/** Nota facoltativa: stringa di al massimo 200 caratteri; vuota → null. */
export function parseManualCreditNote(raw: unknown): NoteParseResult {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length > MANUAL_CREDIT_NOTE_MAX_LENGTH) return { ok: false };
  return { ok: true, note: trimmed || null };
}
