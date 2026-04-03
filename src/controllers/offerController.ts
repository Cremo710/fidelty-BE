import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import { offerRepository } from "../repositories/offerRepository.js";
import {
  validateCreateOfferInput,
  validateUpdateOfferInput,
} from "../validators/offerValidator.js";

export class OfferController {
  /**
   * Crea una nuova offerta per il bar dell'utente autenticato
   */
  async createOffer(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const validation = validateCreateOfferInput(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati offerta non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const offerId = await offerRepository.createOffer(bar.id, validation.data!);

      return reply.status(201).send({
        success: true,
        message: "Offerta creata con successo",
        data: { id: offerId },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "CREATE_ERROR" });
    }
  }

  /**
   * Lista tutte le offerte del bar dell'utente autenticato
   */
  async listOffers(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const offers = await offerRepository.getOffersByBarId(bar.id);

      return reply.status(200).send({
        success: true,
        data: offers.map((o) => ({
          id: o.id,
          title: o.title,
          description: o.description,
          conditions: o.conditions,
          pointsRequired: o.points_required,
          icon: o.icon,
          validFrom: o.valid_from,
          validUntil: o.valid_until,
          isActive: o.is_active,
          createdAt: o.created_at,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "LIST_ERROR" });
    }
  }

  /**
   * Lista le offerte attive di un bar dato il suo ID (endpoint pubblico)
   */
  async listOffersByBarId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { barId } = request.params as { barId: string };
      if (!barId) {
        return reply.status(400).send({ success: false, error: "barId mancante", code: "MISSING_PARAM" });
      }

      const offers = await offerRepository.getOffersByBarId(barId);

      return reply.status(200).send({
        success: true,
        data: offers
          .filter((o) => o.is_active)
          .map((o) => ({
            id: o.id,
            title: o.title,
            description: o.description,
            conditions: o.conditions,
            pointsRequired: o.points_required,
            icon: o.icon,
            validFrom: o.valid_from,
            validUntil: o.valid_until,
            isActive: o.is_active,
            createdAt: o.created_at,
          })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "LIST_ERROR" });
    }
  }

  /**
   * Aggiorna un'offerta esistente
   */
  async updateOffer(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { id } = request.params as { id: string };

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const validation = validateUpdateOfferInput(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati offerta non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const updated = await offerRepository.updateOffer(id, bar.id, validation.data!);
      if (!updated) {
        return reply.status(404).send({ success: false, error: "Offerta non trovata", code: "NOT_FOUND" });
      }

      return reply.status(200).send({ success: true, message: "Offerta aggiornata" });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "UPDATE_ERROR" });
    }
  }

  /**
   * Elimina un'offerta
   */
  async deleteOffer(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { id } = request.params as { id: string };

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const deleted = await offerRepository.deleteOffer(id, bar.id);
      if (!deleted) {
        return reply.status(404).send({ success: false, error: "Offerta non trovata", code: "NOT_FOUND" });
      }

      return reply.status(200).send({ success: true, message: "Offerta eliminata" });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "DELETE_ERROR" });
    }
  }
}

export const offerController = new OfferController();
