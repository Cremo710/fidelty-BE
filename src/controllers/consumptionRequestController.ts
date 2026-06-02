import { FastifyReply, FastifyRequest } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import { consumptionRequestRepository, type ConsumptionRequestDTO, type ConsumptionRequestWithBarDTO } from "../repositories/consumptionRequestRepository.js";
import { offerRedemptionRepository } from "../repositories/offerRedemptionRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { consumptionNotificationService } from "../services/consumptionNotificationService.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";

const QR_PREFIX = "FIDELTY_BAR:";
const POINTS_PER_EURO = 100;
const DEFAULT_MAX_DISTANCE_METERS = 250;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const getDistanceMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const earthRadiusMeters = 6371000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;

  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getConsumptionRequestMaxDistanceMeters = () => {
  const rawValue = Number.parseInt(process.env.CONSUMPTION_REQUEST_MAX_DISTANCE_METERS || "", 10);
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : DEFAULT_MAX_DISTANCE_METERS;
};

type RequesterActivityItem = {
  id: string;
  type: "request_submitted" | "points_earned" | "request_rejected" | "offer_redeemed" | "offer_validated";
  createdAt: Date;
  amount?: number;
  pointsPreview?: number;
  pointsRedeemed?: number;
  rejectionReason?: string | null;
  status?: "frozen" | "redeemed" | "expired" | "cancelled";
  expiresAt?: Date;
  bar: {
    id: string;
    name: string | null;
    logo?: string | null;
    businessName?: string | null;
    address?: string | null;
    piva?: string | null;
  };
  offer?: {
    id: string;
    title: string | null;
    description: string | null;
  };
};

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
  private buildRequesterActivityFeed(
    requests: ConsumptionRequestWithBarDTO[],
    offerRedemptions: Awaited<ReturnType<typeof offerRedemptionRepository.listActivityByUserId>>,
  ) {
    const requestItems = requests.flatMap((request) => {
      const bar = {
        id: request.bar_id,
        name: request.bar_name,
        businessName: request.bar_business_name,
        address: request.bar_address,
        logo: request.bar_logo,
        piva: request.bar_piva,
      };

      const items: RequesterActivityItem[] = [
        {
          id: `${request.id}-submitted`,
          type: "request_submitted",
          createdAt: request.created_at,
          amount: Number.parseFloat(request.amount),
          pointsPreview: request.points_preview,
          rejectionReason: request.rejection_reason,
          bar,
        },
      ];

      if (request.status === "approved" && request.approved_at) {
        items.push({
          id: `${request.id}-approved`,
          type: "points_earned",
          createdAt: request.approved_at,
          amount: Number.parseFloat(request.amount),
          pointsPreview: request.points_preview,
          bar,
        });
      }

      if (request.status === "rejected" && request.rejected_at) {
        items.push({
          id: `${request.id}-rejected`,
          type: "request_rejected",
          createdAt: request.rejected_at,
          amount: Number.parseFloat(request.amount),
          pointsPreview: request.points_preview,
          rejectionReason: request.rejection_reason,
          bar,
        });
      }

      return items;
    });

    const offerItems = offerRedemptions.flatMap((redemption) => {
      const bar = {
        id: redemption.bar_id,
        name: redemption.bar_name,
        logo: redemption.bar_logo,
      };

      const offer = {
        id: redemption.offer_id,
        title: redemption.offer_title,
        description: redemption.offer_description,
      };

      const items: RequesterActivityItem[] = [
        {
          id: `${redemption.id}-frozen`,
          type: "offer_redeemed",
          createdAt: redemption.frozen_at || redemption.created_at,
          pointsRedeemed: Number(redemption.points_amount) || 0,
          status: redemption.status,
          expiresAt: redemption.expires_at,
          bar,
          offer,
        },
      ];

      if (redemption.status === "redeemed" && redemption.redeemed_at) {
        items.push({
          id: `${redemption.id}-validated`,
          type: "offer_validated",
          createdAt: redemption.redeemed_at,
          pointsRedeemed: Number(redemption.points_amount) || 0,
          status: redemption.status,
          bar,
          offer,
        });
      }

      return items;
    });

    return [...requestItems, ...offerItems].sort(
      (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
    );
  }

  private mapRequestResponse(row: ConsumptionRequestDTO | ConsumptionRequestWithBarDTO) {
    const baseResponse = {
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

    if ("bar_name" in row) {
      return {
        ...baseResponse,
        bar: {
          id: row.bar_id,
          name: row.bar_name,
          businessName: row.bar_business_name,
          address: row.bar_address,
          logo: row.bar_logo,
          piva: row.bar_piva,
        },
      };
    }

    return baseResponse;
  }

  async listForRequester(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const [requests, offerRedemptions] = await Promise.all([
        consumptionRequestRepository.listByRequesterUserId(userId),
        offerRedemptionRepository.listActivityByUserId(userId),
      ]);

      return reply.status(200).send({
        success: true,
        data: this.buildRequesterActivityFeed(requests, offerRedemptions),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "CONSUMPTION_REQUEST_LIST_ERROR" });
    }
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
          latitude: bar.latitude,
          longitude: bar.longitude,
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

      const body = (request.body as {
        qrCodeValue?: string;
        amount?: number | string;
        userLatitude?: number | string;
        userLongitude?: number | string;
      } | undefined) || {};
      const vatNumber = parseBarQrValue(body.qrCodeValue || "");
      const amount = typeof body.amount === "number" ? body.amount : Number.parseFloat(String(body.amount || ""));
      const userLatitude = typeof body.userLatitude === "number"
        ? body.userLatitude
        : Number.parseFloat(String(body.userLatitude || ""));
      const userLongitude = typeof body.userLongitude === "number"
        ? body.userLongitude
        : Number.parseFloat(String(body.userLongitude || ""));

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

      const barLatitude = bar.latitude !== null ? Number(bar.latitude) : NaN;
      const barLongitude = bar.longitude !== null ? Number(bar.longitude) : NaN;
      if (!Number.isFinite(barLatitude) || !Number.isFinite(barLongitude)) {
        return reply.status(400).send({
          success: false,
          error: "Questo bar non ha una posizione valida configurata",
          code: "BAR_LOCATION_UNAVAILABLE",
        });
      }

      if (!Number.isFinite(userLatitude) || !Number.isFinite(userLongitude)) {
        return reply.status(400).send({
          success: false,
          error: "Posizione utente mancante o non valida",
          code: "USER_LOCATION_REQUIRED",
        });
      }

      const maxDistanceMeters = getConsumptionRequestMaxDistanceMeters();
      const distanceMeters = getDistanceMeters(userLatitude, userLongitude, barLatitude, barLongitude);
      if (distanceMeters > maxDistanceMeters) {
        return reply.status(403).send({
          success: false,
          error: "Devi essere vicino al bar per inviare la richiesta di consumazione",
          code: "USER_TOO_FAR_FROM_BAR",
          data: {
            distanceMeters: Math.round(distanceMeters),
            maxDistanceMeters,
          },
        });
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

      const bar = await resolveOwnedBarForRequest(request);
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

      const bar = await resolveOwnedBarForRequest(request);
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