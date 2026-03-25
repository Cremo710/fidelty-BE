import type { FastifyRequest, FastifyReply } from "fastify";
import { extractTextFromImage } from "../services/visionService.js";
import { isImageFile } from "../utils/imageUpload.js";

interface ParsedReceiptField {
  data: string | number | null;
  text: string | null;
  confidenceLevel?: number;
}

interface ParsedReceipt {
  merchantTaxId: ParsedReceiptField;
  merchantName: ParsedReceiptField;
  totalAmount: ParsedReceiptField;
  date: ParsedReceiptField;
  time: ParsedReceiptField;
  merchantAddress: ParsedReceiptField;
  entities: {
    receiptNumber: { data: string | null };
  };
  rawText: string;
}

function parseReceiptText(text: string): ParsedReceipt {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // --- Partita IVA (11 cifre, opzionalmente preceduta da "IT") ---
  let merchantTaxId: string | null = null;
  const pivaRegex = /(?:P\.?\s*IVA|PARTITA\s*IVA)[:\s]*(?:IT)?(\d{11})/i;
  const pivaMatch = text.match(pivaRegex);
  if (pivaMatch) {
    merchantTaxId = pivaMatch[1];
  } else {
    // Fallback: cerca un pattern IT + 11 cifre isolato
    const itMatch = text.match(/\bIT(\d{11})\b/);
    if (itMatch) {
      merchantTaxId = itMatch[1];
    }
  }

  // --- Document ID (es. DOCUMENTO N. 0001-0001, DOC. 0001-0001) ---
  let docId: string | null = null;
  const docRegex = /(?:DOCUMENTO\s*N\.?|DOC\.?\s*N?\.?)\s*(\d{4}-\d{4})/i;
  const docMatch = text.match(docRegex);
  if (docMatch) {
    docId = docMatch[1];
  } else {
    // Fallback: cerca pattern XXXX-XXXX isolato (tipico degli scontrini italiani)
    const fallbackDoc = text.match(/\b(\d{4}-\d{4})\b/);
    if (fallbackDoc) {
      docId = fallbackDoc[1];
    }
  }

  // --- Totale ---
  let totalAmount: number | null = null;
  const totalRegex = /(?:TOTALE|TOT\.?|TOTALE\s*EURO|TOTALE\s*€|IMPORTO\s*DOVUTO)[:\s€]*([0-9]+[.,][0-9]{2})/i;
  const totalMatch = text.match(totalRegex);
  if (totalMatch) {
    totalAmount = parseFloat(totalMatch[1].replace(",", "."));
  }

  // --- Data e Ora (DD/MM/YYYY HH:MM o DD/MM/YY HH:MM) ---
  let date: string | null = null;
  let time: string | null = null;
  const dateTimeRegex4 = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\s+(\d{2}:\d{2})/;
  const dateTimeRegex2 = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{2})\s+(\d{2}:\d{2})/;
  const dtMatch4 = text.match(dateTimeRegex4);
  if (dtMatch4) {
    const [, day, month, year, t] = dtMatch4;
    date = `${year}-${month}-${day}`;
    time = t;
  } else {
    const dtMatch2 = text.match(dateTimeRegex2);
    if (dtMatch2) {
      const [, day, month, shortYear, t] = dtMatch2;
      const fullYear = parseInt(shortYear, 10) > 50 ? `19${shortYear}` : `20${shortYear}`;
      date = `${fullYear}-${month}-${day}`;
      time = t;
    } else {
      // Fallback: solo data senza ora
      const dateOnly4 = text.match(/\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/);
      if (dateOnly4) {
        const [, day, month, year] = dateOnly4;
        date = `${year}-${month}-${day}`;
      } else {
        const dateOnly2 = text.match(/\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{2})\b/);
        if (dateOnly2) {
          const [, day, month, shortYear] = dateOnly2;
          const fullYear = parseInt(shortYear, 10) > 50 ? `19${shortYear}` : `20${shortYear}`;
          date = `${fullYear}-${month}-${day}`;
        }
      }
      // Fallback: cerca ora isolata (HH:MM)
      if (!time) {
        const timeOnly = text.match(/\b(\d{2}:\d{2})\b/);
        if (timeOnly) {
          time = timeOnly[1];
        }
      }
    }
  }

  // --- Indirizzo (cerca righe con VIA, PIAZZA, CORSO, etc.) ---
  const addressRegex = /\b(VIA|V\.LE|VIALE|PIAZZA|P\.ZA|P\.ZZA|CORSO|C\.SO|LARGO|LOC\.|LOCALITA)\b/i;
  let merchantAddress: string | null = null;
  const addressLineIdx = lines.findIndex((l) => addressRegex.test(l));
  if (addressLineIdx >= 0) {
    merchantAddress = lines[addressLineIdx];
    // Se la riga dopo contiene CAP + città (es. "22100 Como"), accodala
    const nextLine = lines[addressLineIdx + 1];
    if (nextLine && /^\d{5}\s+\S/.test(nextLine)) {
      merchantAddress += ", " + nextLine;
    }
  }

  // --- Nome esercente (righe prima dell'indirizzo o della P.IVA, escludendo indirizzo/CAP) ---
  let merchantName: string | null = null;
  const pivaLineIdx = lines.findIndex((l) => /P\.?\s*IVA|PARTITA\s*IVA/i.test(l));
  const stopIdx = addressLineIdx >= 0
    ? addressLineIdx
    : pivaLineIdx >= 0
      ? pivaLineIdx
      : Math.min(3, lines.length);

  const nameLines: string[] = [];
  for (let i = 0; i < stopIdx; i++) {
    const line = lines[i];
    if (/^\d+[\/\-.]/.test(line)) continue;
    if (/^[\d\s.,]+$/.test(line)) continue;
    if (/P\.?\s*IVA/i.test(line)) continue;
    if (addressRegex.test(line)) continue;
    if (/^\d{5}\s/.test(line)) continue;
    if (line.length > 2) {
      nameLines.push(line);
    }
  }
  if (nameLines.length > 0) {
    merchantName = nameLines.join(" ");
  }

  return {
    merchantTaxId: { data: merchantTaxId, text: merchantTaxId },
    merchantName: { data: merchantName, text: merchantName },
    totalAmount: { data: totalAmount, text: totalAmount != null ? String(totalAmount) : null },
    date: { data: date, text: date },
    time: { data: time, text: time },
    merchantAddress: { data: merchantAddress, text: merchantAddress },
    entities: {
      receiptNumber: { data: docId },
    },
    rawText: text,
  };
}

class VisionController {
  async extractText(request: FastifyRequest, reply: FastifyReply) {
    try {
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({
          success: false,
          error: "Nessun file caricato",
          code: "MISSING_FILE",
        });
      }

      if (!isImageFile(data.mimetype)) {
        return reply.status(400).send({
          success: false,
          error: "Formato file non supportato. Usa PNG, JPEG o WebP.",
          code: "INVALID_FILE_TYPE",
        });
      }

      const buffer = await data.toBuffer();

      const text = await extractTextFromImage(buffer);

      if (!text || text.trim().length === 0) {
        return reply.status(400).send({
          success: false,
          error: "Nessun testo rilevato nell'immagine",
          code: "NO_TEXT_DETECTED",
        });
      }

      const parsed = parseReceiptText(text);

      if (!parsed.merchantTaxId.data) {
        return reply.status(400).send({
          success: false,
          error: "Partita IVA non trovata nello scontrino",
          code: "MISSING_PIVA",
          data: parsed,
        });
      }

      if (!parsed.entities.receiptNumber.data) {
        return reply.status(400).send({
          success: false,
          error: "Numero documento non trovato nello scontrino",
          code: "MISSING_DOC_ID",
          data: parsed,
        });
      }

      console.log(`✅ Scontrino parsed - P.IVA: ${parsed.merchantTaxId.data}, DOC: ${parsed.entities.receiptNumber.data}`);

      return reply.status(200).send({
        success: true,
        data: parsed,
      });
    } catch (error) {
      console.error("❌ Errore nell'estrazione del testo:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore nell'elaborazione dell'immagine",
        code: "VISION_ERROR",
      });
    }
  }
}

export const visionController = new VisionController();
