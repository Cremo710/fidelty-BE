import type { FastifyReply, FastifyRequest } from "fastify";
import { databaseService } from "../services/databaseService.js";
import { barRepository } from "../repositories/barRepository.js";
import { loyaltyCardRepository } from "../repositories/loyaltyCardRepository.js";
import { LOYALTY_TIERS, getTierIndexFromPoints, getTierProgress } from "../utils/loyaltyTiers.js";

class LoyaltyCardController {
  async unlockForUser(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.userId;
    const { barId } = request.params as { barId?: string };
    if (!userId) {
      return reply.status(401).send({
        success: false,
        error: "Utente non autenticato",
        code: "UNAUTHORIZED",
      });
    }
    if (!barId) {
      return reply.status(400).send({
        success: false,
        error: "Attività non valida",
        code: "BAR_ID_REQUIRED",
      });
    }

    try {
      const bar = await barRepository.findById(barId);
      if (!bar) {
        return reply.status(404).send({
          success: false,
          error: "Bar non trovato o non attivo",
          code: "BAR_NOT_FOUND",
        });
      }

      const card = await loyaltyCardRepository.ensureCardExists(userId, barId);
      return reply.status(200).send({
        success: true,
        data: {
          barId,
          cardId: card.id,
          created: card.created,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante lo sblocco della tessera:", error);
      return reply.status(500).send({
        success: false,
        error: "Impossibile aggiungere la carta fedeltà. Riprova.",
        code: "CARD_UNLOCK_ERROR",
      });
    }
  }

  async listMine(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Utente non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      const cards = await databaseService.getUserLoyaltyCards(userId);

      return reply.status(200).send({
        success: true,
        data: cards.map((card) => ({
          id: card.barId,
          barId: card.barId,
          title: card.barName,
          merchantName: card.merchantName,
          piva: card.piva,
          phone: card.phone,
          address: card.address,
          latitude: card.latitude,
          longitude: card.longitude,
          image: card.coverImage,
          description: card.description,
          points: card.availablePoints,
          totalPoints: card.totalPoints,
          lifetimePoints: card.lifetimePoints,
          loyalty: getTierProgress(card.lifetimePoints),
          barDeleted: card.barDeleted,
          frozenPoints: card.frozenPoints,
          availablePoints: card.availablePoints,
          receiptsCount: card.receiptsCount,
          status: LOYALTY_TIERS[getTierIndexFromPoints(card.lifetimePoints)].id,
          lastReceiptAt: card.lastReceiptAt,
        })),
      });
    } catch (error) {
      console.error("❌ Errore durante il recupero delle tessere:", error);
      console.error("❌ Errore loyaltyCardController:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore interno del server",
        code: "CARDS_FETCH_ERROR",
      });
    }
  }
}

export const loyaltyCardController = new LoyaltyCardController();