import { FastifyReply, FastifyRequest } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import { consumptionRequestRepository } from "../repositories/consumptionRequestRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { consumptionNotificationService } from "../services/consumptionNotificationService.js";

const QR_PREFIX = "FIDELTY_BAR:";
const POINTS_PER_EURO = 100;

const parseBarQrValue = (rawValue: string): string | null => {
  if (!rawValue || typeof rawValue !== "string") {
    return null;
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith(QR_PREFIX)) {
    return normalized.slice(QR_PREFIX.length).trim() || null;
  }

  return normalized;
};

export class ConsumptionRequestController {
  private mapRequestResponse(row: Awaited<ReturnType<typeof consumptionRequestRepository.createRequest>>) {
    return {
      id: row.id,
      status: row.status,
      amount: Number.parseFloat(row.amount),
      pointsPreview: row.points_preview,
      qrCodeValue: row.qr_code_value,
      requester: {
        id: row.requester_user_id,
        name: row.requester_name_snapshot,
        email: row.requester_email_snapshot,
      },
      rejectionReason: row.rejection_reason,
      approvedAt: row.approved_at,
      rejectedAt: row.rejected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async resolveBarFromQr(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { code } = (request.query as { code?: string }) || {};
      const vatNumber = parseBarQrValue(code || "");

      if (!vatNumber) {
        return reply.status(400).send({
          success: false,
          error: "Codice QR non valido",
          code: "INVALID_QR_CODE",
        });
      }

      const bar = await barRepository.findByPiva(vatNumber);
      if (!bar) {
        return reply.status(404).send({
          success: false,
          error: "Bar non trovato o non attivo",
          code: "BAR_NOT_FOUND",
        });
      }

      return reply.status(200).send({
        success: true,
        data: {
          id: bar.id,
          qrValue: `${QR_PREFIX}${bar.iva}`,
          piva: bar.iva,
          name: bar.name,
          businessName: bar.merchant_name,
          address: bar.address,
          image: bar.image,
          logo: bar.logo,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "BAR_LOOKUP_ERROR",
      });
    }
  }

  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const body = (request.body as { qrCodeValue?: string; amount?: number | string } | undefined) || {};
      const vatNumber = parseBarQrValue(body.qrCodeValue || "");
      const amount = typeof body.amount === "number" ? body.amount : Number.parseFloat(String(body.amount || ""));

      if (!vatNumber) {
        return reply.status(400).send({ success: false, error: "Codice QR non valido", code: "INVALID_QR_CODE" });
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.status(400).send({ success: false, error: "Importo non valido", code: "INVALID_AMOUNT" });
      }

      const bar = await barRepository.findByPiva(vatNumber);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      if (bar.user_id === userId) {
        return reply.status(400).send({
          success: false,
          error: "Non puoi inviare una richiesta al tuo stesso bar",
          code: "SELF_REQUEST_NOT_ALLOWED",
        });
      }

      const requester = await userRepository.findById(userId);
      const pointsPreview = Math.round(amount * POINTS_PER_EURO);

      const created = await consumptionRequestRepository.createRequest({
        requesterUserId: userId,
        barId: bar.id,
        amount,
        pointsPreview,
        qrCodeValue: `${QR_PREFIX}${bar.iva}`,
        requesterNameSnapshot: requester?.name || null,
        requesterEmailSnapshot: requester?.email || null,
      });

      const notification = await consumptionNotificationService.notifyBarOfNewRequest({
        barId: bar.id,
        barName: bar.name,
        requesterName: requester?.name || "Cliente",
        amount,
        pointsPreview,
        requestId: created.id,
      });

      return reply.status(201).send({
        success: true,
        data: {
          id: created.id,
          status: created.status,
          amount,
          pointsPreview,
          qrCodeValue: created.qr_code_value,
          requester: {
            id: userId,
            name: requester?.name || null,
            email: requester?.email || null,
          },
          bar: {
            id: bar.id,
            name: bar.name,
            businessName: bar.merchant_name,
            piva: bar.iva,
            address: bar.address,
            logo: bar.logo,
          },
          notification,
          createdAt: created.created_at,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "CONSUMPTION_REQUEST_ERROR" });
    }
  }

  async listPendingForBar(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const requests = await consumptionRequestRepository.listPendingByBarId(bar.id);

      return reply.status(200).send({
        success: true,
        data: requests.map((row) => this.mapRequestResponse(row)),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "CONSUMPTION_REQUEST_LIST_ERROR" });
    }
  }

  async updateStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { id } = (request.params as { id: string }) || {};
      const body = (request.body as { status?: string; rejectionReason?: string } | undefined) || {};
      const normalizedStatus = String(body.status || "").toLowerCase();

      if (!id) {
        return reply.status(400).send({ success: false, error: "ID richiesta mancante", code: "MISSING_REQUEST_ID" });
      }

      if (!["approved", "rejected"].includes(normalizedStatus)) {
        return reply.status(400).send({
          success: false,
          error: "Stato non valido. Usa 'approved' o 'rejected'.",
          code: "INVALID_STATUS",
        });
      }

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const updated = normalizedStatus === "approved"
        ? await consumptionRequestRepository.approvePendingRequest({
            requestId: id,
            barId: bar.id,
            processedByUserId: userId,
            barName: bar.name,
            barAddress: bar.address,
            barPiva: bar.iva,
          })
        : await consumptionRequestRepository.rejectPendingRequest({
            requestId: id,
            barId: bar.id,
            processedByUserId: userId,
            rejectionReason: body.rejectionReason,
          });

      return reply.status(200).send({
        success: true,
        data: this.mapRequestResponse(updated),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      if (errorMessage === "CONSUMPTION_REQUEST_NOT_FOUND") {
        return reply.status(404).send({ success: false, error: "Richiesta non trovata", code: errorMessage });
      }

      if (errorMessage === "CONSUMPTION_REQUEST_ALREADY_PROCESSED") {
        return reply.status(409).send({ success: false, error: "Richiesta già elaborata", code: errorMessage });
      }

      return reply.status(500).send({ success: false, error: errorMessage, code: "CONSUMPTION_REQUEST_UPDATE_ERROR" });
    }
  }
}

export const consumptionRequestController = new ConsumptionRequestController();