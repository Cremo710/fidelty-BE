import type { FastifyReply, FastifyRequest } from "fastify";
import { databaseService } from "../services/databaseService.js";

class LoyaltyCardController {
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
          image: card.coverImage,
          points: card.availablePoints,
          totalPoints: card.totalPoints,
          frozenPoints: card.frozenPoints,
          availablePoints: card.availablePoints,
          receiptsCount: card.receiptsCount,
          status: card.totalPoints >= 500 ? "VIP" : "MEMBER",
          lastReceiptAt: card.lastReceiptAt,
        })),
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

export const loyaltyCardController = new LoyaltyCardController();