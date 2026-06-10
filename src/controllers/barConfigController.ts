import type { FastifyReply, FastifyRequest } from "fastify";
import { barConfigRepository } from "../repositories/barConfigRepository.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";

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
      return reply.status(500).send({ success: false, error: (error as Error).message, code: "BAR_CONFIG_GET_ERROR" });
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

      const body = (request.body as {
        gpsRadiusMeters?: number;
        autoCreditEnabled?: boolean;
        capEnabled?: boolean;
        capAmount?: number;
        anomalyEnabled?: boolean;
        youngAccountEnabled?: boolean;
      } | undefined) || {};

      // Basic validation
      if (body.gpsRadiusMeters !== undefined && (body.gpsRadiusMeters < 10 || body.gpsRadiusMeters > 5000)) {
        return reply.status(400).send({ success: false, error: "gpsRadiusMeters deve essere tra 10 e 5000 m", code: "INVALID_GPS_RADIUS" });
      }
      if (body.capAmount !== undefined && body.capAmount <= 0) {
        return reply.status(400).send({ success: false, error: "capAmount deve essere maggiore di 0", code: "INVALID_CAP_AMOUNT" });
      }

      const updated = await barConfigRepository.upsert(bar.id, body);

      return reply.status(200).send({ success: true, data: updated });
    } catch (error) {
      return reply.status(500).send({ success: false, error: (error as Error).message, code: "BAR_CONFIG_UPDATE_ERROR" });
    }
  }
}

export const barConfigController = new BarConfigController();
