import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { barConfigRepository } from "../repositories/barConfigRepository.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";

const barConfigUpdateSchema = z
  .object({
    gpsRadiusMeters: z.number({ invalid_type_error: "gpsRadiusMeters deve essere un numero" }).min(10, "gpsRadiusMeters deve essere tra 10 e 5000 m").max(5000, "gpsRadiusMeters deve essere tra 10 e 5000 m"),
    autoCreditEnabled: z.boolean({ invalid_type_error: "autoCreditEnabled deve essere booleano" }),
    capEnabled: z.boolean({ invalid_type_error: "capEnabled deve essere booleano" }),
    capAmount: z.number({ invalid_type_error: "capAmount deve essere un numero" }).positive("capAmount deve essere maggiore di 0").max(10000, "capAmount troppo alto"),
    anomalyEnabled: z.boolean({ invalid_type_error: "anomalyEnabled deve essere booleano" }),
    youngAccountEnabled: z.boolean({ invalid_type_error: "youngAccountEnabled deve essere booleano" }),
  })
  .partial();

export class BarConfigController {
  async getConfig(request: FastifyRequest, reply: FastifyReply) {
    try {
      if (!(request as any).userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const cfg = await barConfigRepository.getByBarId(bar.id);

      return reply.status(200).send({ success: true, data: cfg });
    } catch (error) {
      console.error("❌ Errore lettura configurazione bar:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "BAR_CONFIG_GET_ERROR" });
    }
  }

  async updateConfig(request: FastifyRequest, reply: FastifyReply) {
    try {
      if (!(request as any).userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const parsed = barConfigUpdateSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.errors[0]?.message ?? "Configurazione non valida",
          code: "INVALID_BAR_CONFIG",
          details: parsed.error.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
        });
      }

      const updated = await barConfigRepository.upsert(bar.id, parsed.data);

      return reply.status(200).send({ success: true, data: updated });
    } catch (error) {
      console.error("❌ Errore aggiornamento configurazione bar:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "BAR_CONFIG_UPDATE_ERROR" });
    }
  }
}

export const barConfigController = new BarConfigController();
