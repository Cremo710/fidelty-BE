import type { FastifyReply, FastifyRequest } from "fastify";
import { pointsRevocationRepository } from "../repositories/pointsRevocationRepository.js";

/** Simple admin guard: userId must be in the ADMIN_USER_IDS env var (comma-separated). */
function isAdmin(userId: string): boolean {
  const adminIds = (process.env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return adminIds.includes(userId);
}

export class AdminController {
  async revokePoints(request: FastifyRequest, reply: FastifyReply) {
    try {
      const adminId = (request as any).userId;
      if (!adminId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!isAdmin(adminId)) {
        return reply.status(403).send({ success: false, error: "Accesso negato: richiesto ruolo admin", code: "FORBIDDEN" });
      }

      const body = (request.body as {
        userId?: string;
        barId?: string;
        consumptionRequestId?: string;
        pointsAmount?: number | string;
        reason?: string;
      } | undefined) || {};

      const { userId, barId, reason } = body;
      const pointsAmount = Number(body.pointsAmount);

      if (!userId || !barId) {
        return reply.status(400).send({ success: false, error: "userId e barId sono obbligatori", code: "MISSING_PARAMS" });
      }
      if (!reason || String(reason).trim().length < 5) {
        return reply.status(400).send({ success: false, error: "reason è obbligatoria (minimo 5 caratteri)", code: "REASON_REQUIRED" });
      }
      if (!Number.isFinite(pointsAmount) || pointsAmount <= 0) {
        return reply.status(400).send({ success: false, error: "pointsAmount deve essere un intero positivo", code: "INVALID_POINTS_AMOUNT" });
      }

      const revocation = await pointsRevocationRepository.create({
        userId,
        barId,
        consumptionRequestId: body.consumptionRequestId || null,
        pointsAmount: Math.round(pointsAmount),
        reason: String(reason).trim(),
        revokedByAdminId: adminId,
      });

      return reply.status(201).send({ success: true, data: revocation });
    } catch (error) {
      return reply.status(500).send({ success: false, error: (error as Error).message, code: "REVOKE_POINTS_ERROR" });
    }
  }
}

export const adminController = new AdminController();
