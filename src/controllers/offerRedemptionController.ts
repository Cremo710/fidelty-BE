import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { barRepository } from "../repositories/barRepository.js";
import { offerRepository } from "../repositories/offerRepository.js";
import {
  offerRedemptionRepository,
  type OfferRedemptionWithOfferDTO,
} from "../repositories/offerRedemptionRepository.js";
import { databaseService } from "../services/databaseService.js";
import { offerRedemptionTokenService } from "../services/offerRedemptionTokenService.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";

const QR_TTL_MS = 10 * 60 * 1000;

const serializeRedemption = (redemption: OfferRedemptionWithOfferDTO) => ({
  id: redemption.id,
  offerId: redemption.offer_id,
  offerTitle: redemption.offer_title,
  offerDescription: redemption.offer_description,
  userId: redemption.user_id,
  userName: redemption.user_name,
  userEmail: redemption.user_email,
  barId: redemption.bar_id,
  status: redemption.status,
  pointsAmount: Number(redemption.points_amount) || 0,
  expiresAt: redemption.expires_at,
  frozenAt: redemption.frozen_at,
  redeemedAt: redemption.redeemed_at,
});

const serializeRedemptionStatus = (redemption: OfferRedemptionWithOfferDTO) => ({
  redemptionId: redemption.id,
  status: redemption.status,
  expiresAt: redemption.expires_at,
  redeemedAt: redemption.redeemed_at,
  offer: {
    id: redemption.offer_id,
    title: redemption.offer_title,
    description: redemption.offer_description,
  },
  customer: {
    id: redemption.user_id,
    name: redemption.user_name,
  },
  pointsRedeemed: Number(redemption.points_amount) || 0,
});

export class OfferRedemptionController {
  async getContext(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;
      const { barId } = (request.params as { barId?: string }) || {};

      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!barId) {
        return reply.status(400).send({ success: false, error: "barId mancante", code: "MISSING_BAR_ID" });
      }

      await offerRedemptionRepository.expireStaleRedemptions();

      const [pointsSnapshot, activeRedemptions] = await Promise.all([
        offerRedemptionRepository.getUserBarPointsSnapshot(userId, barId),
        offerRedemptionRepository.listActiveByUserBar(userId, barId),
      ]);

      return reply.status(200).send({
        success: true,
        data: {
          totalPoints: pointsSnapshot?.totalPoints || 0,
          frozenPoints: pointsSnapshot?.frozenPoints || 0,
          availablePoints: pointsSnapshot?.availablePoints || 0,
          hasLoyaltyCard: Boolean(pointsSnapshot),
          activeRedemptions: activeRedemptions.map(serializeRedemption),
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "REDEMPTION_CONTEXT_ERROR" });
    }
  }

  async create(request: FastifyRequest, reply: FastifyReply) {
    const client = await databaseService.getPool().connect();

    try {
      const userId = request.userId;
      const { offerId } = (request.params as { offerId?: string }) || {};

      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!offerId) {
        return reply.status(400).send({ success: false, error: "offerId mancante", code: "MISSING_OFFER_ID" });
      }

      await client.query("BEGIN");
      await offerRedemptionRepository.expireStaleRedemptions(client);

      const offer = await offerRepository.findById(offerId);
      if (!offer || !offer.is_active) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ success: false, error: "Offerta non disponibile", code: "OFFER_NOT_FOUND" });
      }

      if (offer.valid_from && new Date(offer.valid_from).getTime() > Date.now()) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ success: false, error: "Offerta non ancora attiva", code: "OFFER_NOT_ACTIVE_YET" });
      }

      if (offer.valid_until && new Date(offer.valid_until).getTime() < Date.now()) {
        await client.query("ROLLBACK");
        return reply.status(409).send({ success: false, error: "Offerta scaduta", code: "OFFER_EXPIRED" });
      }

      const existingRedemption = await offerRedemptionRepository.findActiveByUserBarOffer(
        client,
        userId,
        offer.bar_id,
        offerId,
      );

      if (existingRedemption) {
        await client.query("COMMIT");

        return reply.status(200).send({
          success: true,
          data: {
            ...serializeRedemption(existingRedemption),
            qrToken: offerRedemptionTokenService.generateToken(
              {
                redemptionId: existingRedemption.id,
                userId: existingRedemption.user_id,
                barId: existingRedemption.bar_id,
                offerId: existingRedemption.offer_id,
                nonce: existingRedemption.qr_nonce,
              },
              new Date(existingRedemption.expires_at),
            ),
            totalPoints: null,
            frozenPoints: null,
            availablePoints: null,
            alreadyFrozen: true,
          },
        });
      }

      const pointsSnapshot = await offerRedemptionRepository.getUserBarPointsSnapshot(userId, offer.bar_id);
      if (!pointsSnapshot) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ success: false, error: "Nessuna loyalty card disponibile per questo bar", code: "LOYALTY_CARD_NOT_FOUND" });
      }

      if (pointsSnapshot.availablePoints < offer.points_required) {
        await client.query("ROLLBACK");
        return reply.status(409).send({
          success: false,
          error: "Punti insufficienti per riscattare l'offerta",
          code: "INSUFFICIENT_POINTS",
          data: {
            availablePoints: pointsSnapshot.availablePoints,
            requiredPoints: offer.points_required,
          },
        });
      }

      const expiresAt = new Date(Date.now() + QR_TTL_MS);
      const nonce = ulid();
      const redemption = await offerRedemptionRepository.createFrozenRedemption(client, {
        userId,
        barId: offer.bar_id,
        offerId: offer.id,
        pointsAmount: offer.points_required,
        expiresAt,
        nonce,
      });

      await offerRedemptionRepository.logEvent(client, redemption.id, "frozen", userId, {
        offerId: offer.id,
        pointsAmount: offer.points_required,
        expiresAt: expiresAt.toISOString(),
      });

      await client.query("COMMIT");

      return reply.status(201).send({
        success: true,
        data: {
          id: redemption.id,
          offerId: offer.id,
          offerTitle: offer.title,
          offerDescription: offer.description,
          userId,
          barId: offer.bar_id,
          status: redemption.status,
          pointsAmount: offer.points_required,
          expiresAt,
          qrToken: offerRedemptionTokenService.generateToken(
            {
              redemptionId: redemption.id,
              userId,
              barId: offer.bar_id,
              offerId: offer.id,
              nonce,
            },
            expiresAt,
          ),
          totalPoints: pointsSnapshot.totalPoints,
          frozenPoints: pointsSnapshot.frozenPoints + offer.points_required,
          availablePoints: pointsSnapshot.availablePoints - offer.points_required,
          alreadyFrozen: false,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "CREATE_REDEMPTION_ERROR" });
    } finally {
      client.release();
    }
  }

  async getStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = request.userId;
      const { redemptionId } = (request.params as { redemptionId?: string }) || {};

      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!redemptionId) {
        return reply.status(400).send({ success: false, error: "redemptionId mancante", code: "MISSING_REDEMPTION_ID" });
      }

      await offerRedemptionRepository.expireStaleRedemptions();
      const redemption = await offerRedemptionRepository.findById(databaseService.getPool(), redemptionId);

      if (!redemption) {
        return reply.status(404).send({ success: false, error: "Riscatto non trovato", code: "REDEMPTION_NOT_FOUND" });
      }

      if (redemption.user_id !== userId) {
        return reply.status(403).send({ success: false, error: "Accesso non consentito", code: "REDEMPTION_FORBIDDEN" });
      }

      return reply.status(200).send({
        success: true,
        data: serializeRedemptionStatus(redemption),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "REDEMPTION_STATUS_ERROR" });
    }
  }

  async validateQr(request: FastifyRequest, reply: FastifyReply) {
    const client = await databaseService.getPool().connect();

    try {
      const validatorUserId = request.userId;
      const { qrToken } = (request.body as { qrToken?: string }) || {};

      if (!validatorUserId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!qrToken) {
        return reply.status(400).send({ success: false, error: "QR token mancante", code: "MISSING_QR_TOKEN" });
      }

      const payload = offerRedemptionTokenService.verifyToken(qrToken);
      if (!payload || payload.type !== "offer-redemption") {
        return reply.status(400).send({ success: false, error: "QR non valido o manomesso", code: "INVALID_QR_TOKEN" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      if (payload.barId !== bar.id) {
        return reply.status(403).send({ success: false, error: "QR destinato a un altro bar", code: "WRONG_BAR" });
      }

      await client.query("BEGIN");
      await offerRedemptionRepository.expireStaleRedemptions(client);

      const redemption = await offerRedemptionRepository.findByIdForUpdate(client, payload.redemptionId);
      if (!redemption) {
        await client.query("ROLLBACK");
        return reply.status(404).send({ success: false, error: "Riscatto non trovato", code: "REDEMPTION_NOT_FOUND" });
      }

      const payloadMismatch = (
        redemption.bar_id !== payload.barId
        || redemption.offer_id !== payload.offerId
        || redemption.user_id !== payload.userId
        || redemption.qr_nonce !== payload.nonce
      );

      if (payloadMismatch) {
        await offerRedemptionRepository.logEvent(client, redemption.id, "validation_rejected", validatorUserId, {
          reason: "payload_mismatch",
        });
        await client.query("ROLLBACK");
        return reply.status(400).send({ success: false, error: "QR non valido o manomesso", code: "INVALID_QR_TOKEN" });
      }

      if (redemption.status === "redeemed") {
        await offerRedemptionRepository.logEvent(client, redemption.id, "validation_rejected", validatorUserId, {
          reason: "already_redeemed",
        });
        await client.query("ROLLBACK");
        return reply.status(409).send({ success: false, error: "QR già utilizzato", code: "QR_ALREADY_USED" });
      }

      if (redemption.status === "expired" || new Date(redemption.expires_at).getTime() <= Date.now()) {
        if (redemption.status === "frozen") {
          await offerRedemptionRepository.markExpired(client, redemption.id);
        }
        await offerRedemptionRepository.logEvent(client, redemption.id, "validation_rejected", validatorUserId, {
          reason: "expired",
        });
        await client.query("ROLLBACK");
        return reply.status(410).send({ success: false, error: "QR scaduto", code: "QR_EXPIRED" });
      }

      if (redemption.status !== "frozen") {
        await offerRedemptionRepository.logEvent(client, redemption.id, "validation_rejected", validatorUserId, {
          reason: "invalid_status",
          status: redemption.status,
        });
        await client.query("ROLLBACK");
        return reply.status(409).send({ success: false, error: "Riscatto non validabile", code: "REDEMPTION_NOT_VALIDATABLE" });
      }

      const lockedCard = await offerRedemptionRepository.getLockedLoyaltyCard(client, redemption.user_id, redemption.bar_id);
      if (!lockedCard || lockedCard.points < redemption.points_amount) {
        await offerRedemptionRepository.logEvent(client, redemption.id, "validation_rejected", validatorUserId, {
          reason: "insufficient_underlying_points",
        });
        await client.query("ROLLBACK");
        return reply.status(409).send({ success: false, error: "Saldo punti incoerente, impossibile validare", code: "LOYALTY_POINTS_INCONSISTENT" });
      }

      const remainingPoints = await offerRedemptionRepository.deductLoyaltyCardPoints(
        client,
        redemption.user_id,
        redemption.bar_id,
        redemption.points_amount,
      );

      await offerRedemptionRepository.markRedeemed(client, redemption.id, validatorUserId);
      await offerRedemptionRepository.logEvent(client, redemption.id, "validated", validatorUserId, {
        pointsRedeemed: redemption.points_amount,
        remainingPoints,
      });

      await client.query("COMMIT");

      return reply.status(200).send({
        success: true,
        data: {
          ...serializeRedemptionStatus({
            ...redemption,
            redeemed_at: new Date(),
          }),
          customer: {
            id: redemption.user_id,
            name: redemption.user_name,
            email: redemption.user_email,
          },
          redeemedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "VALIDATE_REDEMPTION_ERROR" });
    } finally {
      client.release();
    }
  }
}

export const offerRedemptionController = new OfferRedemptionController();