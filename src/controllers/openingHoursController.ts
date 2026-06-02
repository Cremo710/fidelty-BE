import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import { openingHoursRepository } from "../repositories/openingHoursRepository.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";
import { validateSetOpeningHoursInput } from "../validators/openingHoursValidator.js";

export class OpeningHoursController {
  /**
   * Salva (upsert) gli orari di apertura del bar dell'utente autenticato
   */
  async setOpeningHours(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const validation = validateSetOpeningHoursInput(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati orari non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      await openingHoursRepository.setOpeningHours(bar.id, validation.data!.hours);

      return reply.status(200).send({
        success: true,
        message: "Orari di apertura aggiornati",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "SET_HOURS_ERROR" });
    }
  }

  /**
   * Recupera gli orari di apertura del bar dell'utente autenticato
   */
  async getOpeningHours(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const hours = await openingHoursRepository.getOpeningHours(bar.id);

      return reply.status(200).send({
        success: true,
        data: hours.map((h) => ({
          dayOfWeek: h.day_of_week,
          isClosed: h.is_closed,
          timeRanges: h.time_ranges,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "GET_HOURS_ERROR" });
    }
  }

  /**
   * Recupera gli orari di apertura di un bar dato il suo ID (endpoint pubblico)
   */
  async getOpeningHoursByBarId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { barId } = request.params as { barId: string };
      if (!barId) {
        return reply.status(400).send({ success: false, error: "barId mancante", code: "MISSING_PARAM" });
      }

      const hours = await openingHoursRepository.getOpeningHours(barId);

      return reply.status(200).send({
        success: true,
        data: hours.map((h) => ({
          dayOfWeek: h.day_of_week,
          isClosed: h.is_closed,
          timeRanges: h.time_ranges,
        })),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "GET_HOURS_ERROR" });
    }
  }
}

export const openingHoursController = new OpeningHoursController();
