import type { FastifyRequest, FastifyReply } from "fastify";
import { databaseService } from "../services/databaseService.js";
import { barRepository } from "../repositories/barRepository.js";
import { applyTrustScore } from "../services/trustScoreService.js";
import {
  saveFraudFlags,
  upsertUserFraudStats,
  isUserBanned,
  checkRateLimit,
  type FraudFlag,
} from "../services/fraudDetectionService.js";

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

      // ── Anti-Abuse: ban check ──
      if (await isUserBanned(userId)) {
        return reply.status(403).send({
          status: "ERROR",
          error: "Il tuo account è stato sospeso. Contatta l'assistenza.",
          code: "USER_BANNED",
        });
      }

      // ── Anti-Abuse: rate limit ──
      if (!checkRateLimit(userId)) {
        return reply.status(429).send({
          status: "ERROR",
          error: "Troppe richieste. Riprova tra un minuto.",
          code: "RATE_LIMITED",
        });
      }

      const data = (request.body || {}) as Record<string, unknown>;

      console.log("📋 Ricevuta richiesta di conferma ricevuta");

      const normalizedPiva = normalizeVatNumber(data.pIva);
      const matchedBar = normalizedPiva
        ? await barRepository.findByPiva(normalizedPiva)
        : null;

      // Compute raw points based on amount
      const rawPoints = computeEarnedPoints(data.billAmount, Boolean(matchedBar));

      // ── Trust Score: adjust points based on trust score from vision step ──
      const trustScore = typeof data.trustScore === "number" ? data.trustScore : 100;
      const { status: receiptStatus, effectivePoints } = applyTrustScore(trustScore, rawPoints);

      console.log(
        `🔒 Trust score: ${trustScore} → status: ${receiptStatus}, points: ${rawPoints} → ${effectivePoints}`,
      );

      const payload = {
        ...data,
        pIva: normalizedPiva,
        userId,
        barId: matchedBar?.id || null,
        pointsEarned: effectivePoints,
        imageHash: typeof data.imageHash === "string" ? data.imageHash : null,
        trustScore,
        status: receiptStatus,
      };

      // Salva i dati della ricevuta nel database
      const receiptId = await databaseService.saveReceipt(payload);

      // ── Persist fraud flags if present ──
      const fraudFlags = Array.isArray(data.fraudFlags) ? data.fraudFlags as string[] : [];
      if (fraudFlags.length > 0) {
        const flags: FraudFlag[] = fraudFlags.map((reason) => ({
          reason: String(reason),
          severity: "medium" as const,
        }));
        await saveFraudFlags(receiptId, flags);
      }

      // ── Update user fraud stats ──
      await upsertUserFraudStats(userId, trustScore);

      return reply.status(200).send({
        status: "OK",
        receiptId: receiptId,
        message: receiptStatus === "rejected"
          ? "Ricevuta salvata ma non approvata. Nessun punto assegnato."
          : receiptStatus === "partial"
            ? "Ricevuta salvata con punteggio parziale."
            : "Ricevuta salvata con successo",
        data: {
          matchedBar: Boolean(matchedBar),
          barId: matchedBar?.id || null,
          barName: matchedBar?.name || null,
          pointsEarned: effectivePoints,
          rawPoints,
          trustScore,
          receiptStatus,
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

  /**
   * Cancella una ricevuta e riallinea la loyalty card.
   */
  async deleteReceipt(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Utente non autenticato", code: "UNAUTHORIZED" });
      }

      const { id } = request.params as { id: string };
      if (!id) {
        return reply.status(400).send({ success: false, error: "ID ricevuta mancante", code: "MISSING_ID" });
      }

      // Verifica che la ricevuta appartenga all'utente
      const pool = databaseService.getPool();
      const { rows } = await pool.query("SELECT user_id FROM receipts WHERE id = $1", [id]);
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: "Ricevuta non trovata", code: "NOT_FOUND" });
      }
      if (rows[0].user_id !== userId) {
        return reply.status(403).send({ success: false, error: "Non autorizzato", code: "FORBIDDEN" });
      }

      await databaseService.deleteReceipt(id);

      return reply.status(200).send({
        success: true,
        message: "Ricevuta cancellata e loyalty card riallineata",
      });
    } catch (error) {
      console.error("❌ Errore durante la cancellazione della ricevuta:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage });
    }
  }

  /**
   * Ricalcola tutte le loyalty cards dalle ricevute effettive.
   * Utile per riparare disallineamenti.
   */
  async recalculateCards(_request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await databaseService.recalculateAllCards();

      return reply.status(200).send({
        success: true,
        message: `Ricalcolo completato: ${result.updated} card aggiornate, ${result.removed} card orfane rimosse`,
        data: result,
      });
    } catch (error) {
      console.error("❌ Errore durante il ricalcolo:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage });
    }
  }
}

// Istanza singleton del controller
export const receiptsController = new ReceiptsController();
