import type { FastifyRequest, FastifyReply } from "fastify";
import { databaseService } from "../services/databaseService.js";
import { barRepository } from "../repositories/barRepository.js";

function normalizeVatNumber(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return cleaned.length > 0 ? cleaned : null;
}

function computeEarnedPoints(amount: unknown, hasMatchedBar: boolean): number {
  if (!hasMatchedBar) {
    return 0;
  }

  const numericAmount =
    typeof amount === "number" ? amount : Number.parseFloat(String(amount || "0"));

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(numericAmount));
}

/**
 * Receipts Controller
 * Gestisce le operazioni relative alle ricevute (OCR processing e salvataggio)
 */
class ReceiptsController {
  /**
   * Elabora una ricevuta da file (OCR via Taggun)
   *
   * @param request - Fastify request con file multipart
   * @param reply - Fastify reply
   * @returns Risultati OCR della ricevuta
   */
  async processReceipt(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("📸 Ricevuta richiesta di elaborazione ricevuta");

      const data = await request.file();

      if (!data) {
        return reply.status(400).send({
          error: "Nessun file caricato",
          code: "MISSING_FILE",
        });
      }

      const filename = data.filename || "receipt.jpg";
      const extension = filename.toLowerCase().split(".").pop();
      const isCompressible = ["jpg", "jpeg", "png"].includes(extension || "");
      const MAX_INITIAL_SIZE = 20 * 1024 * 1024; // 20MB

      // Leggi il file in chunks per controllare la dimensione
      console.log("📖 Lettura file in progress...");
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of data.file) {
        chunks.push(chunk);
        totalSize += chunk.length;

        // Se supera 20MB e non è compressibile, ferma subito
        if (totalSize > MAX_INITIAL_SIZE && !isCompressible) {
          throw new Error(
            "File troppo grande (>20MB) e non è un'immagine compressibile (JPG/PNG)",
          );
        }
      }

      let buffer = Buffer.concat(chunks) as Buffer<ArrayBuffer>;
      console.log(
        `📦 Dimensione file originale: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
      );

      // Se il file supera 20MB e è un'immagine, comprimilo
      if (buffer.length > MAX_INITIAL_SIZE && isCompressible) {
        console.log("⚠️  File supera 20MB, compressione in corso...");
        const { taggunService: tgService } = await import(
          "../services/taggunService.js"
        );
        buffer = (await tgService["compressImage"](
          buffer,
          extension || "jpeg",
        )) as Buffer<ArrayBuffer>;
        console.log(
          `✅ Immagine compressa: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
        );
      }

      console.log(`📁 File elaborato: ${filename} (${buffer.length} bytes)`);

      // Importa il servizio Taggun
      const { taggunService } = await import("../services/taggunService.js");

      // Valida il file
      await taggunService.validateImageFile(buffer, filename);

      // Processa la ricevuta
      const result = await taggunService.processReceipt(buffer, filename);

      // TODO: aggiungere controllo sulla validità della ricevuta (es. partitaIVA che deve corrispondere a quelle del BAR, prezzo, data/orario, numeroDocumento, indirizzo etc.)
      // TODO: aggiungere controllo su eventuali duplicati (check su DB)
      // TODO: salvataggio della ricevuta sul DB

      console.log("Result:", result);
      console.log(
        `✅ Ricevuta elaborata con successo: ${result.merchantName || "Merchant sconosciuto"}`,
      );

      return reply.status(200).send({
        success: true,
        data: result,
        message: "Ricevuta elaborata con successo",
      });
    } catch (error) {
      console.error("❌ Errore durante l'elaborazione della ricevuta:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "PROCESSING_ERROR",
      });
    }
  }

  /**
   * Conferma e salva una ricevuta nel database
   *
   * @param request - Fastify request con dati ricevuta
   * @param reply - Fastify reply
   * @returns Receipt ID e messaggio di successo
   */
  async confirmReceipt(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;
      if (!userId) {
        return reply.status(401).send({
          status: "ERROR",
          error: "Utente non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      const data = (request.body || {}) as Record<string, unknown>;

      console.log("📋 Ricevuta richiesta di conferma ricevuta");
      console.log("Dati ricevuti:", data);

      const normalizedPiva = normalizeVatNumber(data.pIva);
      const matchedBar = normalizedPiva
        ? await barRepository.findByPiva(normalizedPiva)
        : null;
      const pointsEarned = computeEarnedPoints(data.billAmount, Boolean(matchedBar));

      const payload = {
        ...data,
        pIva: normalizedPiva,
        userId,
        barId: matchedBar?.id || null,
        pointsEarned,
      };

      // Salva i dati della ricevuta nel database
      const receiptId = await databaseService.saveReceipt(payload);

      return reply.status(200).send({
        status: "OK",
        receiptId: receiptId,
        message: "Ricevuta salvata con successo",
        data: {
          matchedBar: Boolean(matchedBar),
          barId: matchedBar?.id || null,
          barName: matchedBar?.name || null,
          pointsEarned,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la conferma della ricevuta:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        status: "ERROR",
        error: errorMessage,
      });
    }
  }

  async getMyLoyaltyCards(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;
      console.log(`🃏 getMyLoyaltyCards chiamato — userId dal token: ${userId ?? "NESSUNO"}`);
      if (!userId) {
        console.warn("⚠️ getMyLoyaltyCards: userId mancante, token non valido o middleware non eseguito");
        return reply.status(401).send({
          success: false,
          error: "Utente non autenticato",
          code: "UNAUTHORIZED",
        });
      }
      
      const cards = await databaseService.getUserLoyaltyCards(userId);
      console.log(`🃏 Trovate ${cards.length} carte fedeltà per userId=${userId}`);

      const mappedCards = cards.map((card) => ({
        id: card.barId,
        barId: card.barId,
        title: card.barName,
        merchantName: card.merchantName,
        piva: card.piva,
        image: card.coverImage,
        points: card.totalPoints,
        receiptsCount: card.receiptsCount,
        status: card.totalPoints >= 500 ? "VIP" : "MEMBER",
        lastReceiptAt: card.lastReceiptAt,
      }));

      return reply.status(200).send({
        success: true,
        data: mappedCards,
      });
    } catch (error) {
      console.error("❌ Errore durante il recupero delle tessere:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "CARDS_FETCH_ERROR",
      });
    }
  }
}

// Istanza singleton del controller
export const receiptsController = new ReceiptsController();
