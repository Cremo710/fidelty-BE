import type { FastifyRequest, FastifyReply } from "fastify";
import { extractTextFromImage } from "../services/visionService.js";
import { isImageFile } from "../utils/imageUpload.js";

interface ParsedReceipt {
  merchantTaxId: string | null;
  docId: string | null;
  merchantName: string | null;
  totalAmount: number | null;
  date: string | null;
  merchantAddress: string | null;
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

  // --- Data (DD/MM/YYYY o DD-MM-YYYY o DD.MM.YYYY) ---
  let date: string | null = null;
  const dateRegex = /\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/;
  const dateMatch = text.match(dateRegex);
  if (dateMatch) {
    const [, day, month, year] = dateMatch;
    date = `${year}-${month}-${day}`;
  }

  // --- Nome esercente (prime righe prima della P.IVA o indirizzo) ---
  let merchantName: string | null = null;
  const pivaLineIdx = lines.findIndex((l) => /P\.?\s*IVA|PARTITA\s*IVA/i.test(l));
  // Prendi le prime righe significative (no date, no numeri puri)
  const nameLines: string[] = [];
  const nameLimit = pivaLineIdx > 0 ? Math.min(pivaLineIdx, 3) : 3;
  for (let i = 0; i < Math.min(nameLimit, lines.length); i++) {
    const line = lines[i];
    // Salta righe che sembrano date, numeri puri, o contengono P.IVA
    if (/^\d+[\/\-.]/.test(line)) continue;
    if (/^[\d\s.,]+$/.test(line)) continue;
    if (/P\.?\s*IVA/i.test(line)) continue;
    if (line.length > 2) {
      nameLines.push(line);
    }
  }
  if (nameLines.length > 0) {
    merchantName = nameLines.join(" ");
  }

  // --- Indirizzo (cerca righe con VIA, PIAZZA, CORSO, etc.) ---
  let merchantAddress: string | null = null;
  const addressRegex = /\b(VIA|V\.LE|VIALE|PIAZZA|P\.ZA|P\.ZZA|CORSO|C\.SO|LARGO|LOC\.|LOCALITA)\b/i;
  const addressLine = lines.find((l) => addressRegex.test(l));
  if (addressLine) {
    merchantAddress = addressLine;
  }

  return {
    merchantTaxId,
    docId,
    merchantName,
    totalAmount,
    date,
    merchantAddress,
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

      if (!parsed.merchantTaxId) {
        return reply.status(400).send({
          success: false,
          error: "Partita IVA non trovata nello scontrino",
          code: "MISSING_PIVA",
          data: parsed,
        });
      }

      if (!parsed.docId) {
        return reply.status(400).send({
          success: false,
          error: "Numero documento non trovato nello scontrino",
          code: "MISSING_DOC_ID",
          data: parsed,
        });
      }

      console.log(`✅ Scontrino parsed - P.IVA: ${parsed.merchantTaxId}, DOC: ${parsed.docId}`);

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
