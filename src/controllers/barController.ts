import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import {
  validateBarRegistrationInput,
  type BarRegistrationInput,
} from "../validators/barValidator.js";

/**
 * Bar Controller
 * Gestisce la logica di registrazione e operazioni correlate ai bar
 */
export class BarController {
  /**
   * Handler per la registrazione di un nuovo bar
   */
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di registrazione bar");

      // Estrai userId dal middleware di autenticazione
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      const body = request.body as unknown;

      // Validazione input con Zod
      const validation = validateBarRegistrationInput(body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as BarRegistrationInput;

      // Verifica se l'IVA è già registrata
      const existingBar = await barRepository.ivaExists(input.iva);
      if (existingBar) {
        return reply.status(409).send({
          success: false,
          error: "IVA già registrata",
          code: "IVA_EXISTS",
        });
      }

      // Verifica se l'utente ha già un bar registrato
      const userBar = await barRepository.findByUserId(userId);
      if (userBar) {
        return reply.status(409).send({
          success: false,
          error: "Utente ha già un bar registrato",
          code: "BAR_ALREADY_EXISTS",
        });
      }

      // Salva il bar nel database
      const barId = await barRepository.createBar({
        userId,
        iva: input.iva,
        merchantName: input.merchantName,
        name: input.name,
        address: input.address,
        image: input.image || null,
      });

      console.log(`✅ Bar registrato con successo: ${input.name} (ID: ${barId})`);

      return reply.status(201).send({
        success: true,
        message: "Bar registrato con successo",
        data: {
          id: barId,
          userId,
          iva: input.iva,
          merchantName: input.merchantName,
          name: input.name,
          address: input.address,
          image: input.image || null,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la registrazione del bar:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "REGISTRATION_ERROR",
      });
    }
  }

  /**
   * Handler per recuperare i dati del bar dell'utente
   */
  async getBarByUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di recupero bar per utente");

      // Estrai userId dal middleware di autenticazione
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      // Recupera il bar dell'utente
      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({
          success: false,
          error: "Bar non trovato",
          code: "BAR_NOT_FOUND",
        });
      }

      return reply.status(200).send({
        success: true,
        data: bar,
      });
    } catch (error) {
      console.error("❌ Errore durante il recupero del bar:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "RETRIEVAL_ERROR",
      });
    }
  }
}

// Singleton instance
export const barController = new BarController();
