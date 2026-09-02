import { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "crypto";
import { barRepository } from "../repositories/barRepository.js";
import { consumptionRequestRepository, type ConsumptionRequestDTO, type ConsumptionRequestWithBarDTO } from "../repositories/consumptionRequestRepository.js";
import { offerRedemptionRepository } from "../repositories/offerRedemptionRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { consumptionNotificationService } from "../services/consumptionNotificationService.js";
import { resolveOwnedBarForRequest } from "../utils/ownedBarResolver.js";
import { barConfigRepository } from "../repositories/barConfigRepository.js";
import { platformConfigRepository } from "../repositories/platformConfigRepository.js";
import { semaphoreService } from "../services/semaphoreService.js";
import { databaseService } from "../services/databaseService.js";
import { extractReceiptFields } from "../services/visionOcrService.js";
import { uploadOptimizedImage } from "../utils/imageUpload.js";

const QR_PREFIX = "FIDELTY_BAR:";

const RECEIPT_CODE_RE = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;

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
  return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 100; // default changed to 100 m
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
      receiptCode: row.receipt_code_block1 && row.receipt_code_block2
        ? `${row.receipt_code_block1}-${row.receipt_code_block2}`
        : null,
      semaphoreStatus: row.semaphore_status ?? null,
      signalFlags: Array.isArray(row.signal_flags) ? row.signal_flags : [],
      retroactiveFlagged: row.retroactive_flagged ?? false,
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

  // ── Passo 1 OCR: ricevi foto, estrai campi, persisti sessione ─────────────
  async uploadReceiptForOcr(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      // const platformConfig = await platformConfigRepository.get();
      // if (!platformConfig.ocrEnabled) {
      //   return reply.status(503).send({
      //     success: false,
      //     error: "OCR temporaneamente disabilitato. Usa il percorso manuale.",
      //     code: "OCR_DISABLED",
      //   });
      // }

      // ── Leggi multipart ────────────────────────────────────────────────────
      let imageBuffer: Buffer | null = null;
      let imageMimeType: string | null = null;
      const fields: Record<string, string> = {};

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          fields[part.fieldname] = String(part.value).trim();
        } else if (part.type === "file" && part.fieldname === "receipt") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
          imageBuffer = Buffer.concat(chunks);
          imageMimeType = part.mimetype;
        } else if (part.type === "file") {
          // Drena altri file per non bloccare il parser
          for await (const _chunk of part.file) { /* drain */ }
        }
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        return reply.status(400).send({ success: false, error: "Immagine scontrino mancante", code: "MISSING_RECEIPT_IMAGE" });
      }

      // ── Valida bar ─────────────────────────────────────────────────────────
      const barId = fields.barId || "";
      if (!barId) {
        return reply.status(400).send({ success: false, error: "barId mancante", code: "MISSING_BAR_ID" });
      }
      const bar = await barRepository.findById(barId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      // ── Valida GPS ─────────────────────────────────────────────────────────
      const userLatitude  = Number.parseFloat(fields.userLatitude  || "");
      const userLongitude = Number.parseFloat(fields.userLongitude || "");
      const isMockedLocation = fields.isMockedLocation === "true";

      const barCfg = await barConfigRepository.getByBarId(bar.id);

      if (!Number.isFinite(userLatitude) || !Number.isFinite(userLongitude)) {
        return reply.status(400).send({ success: false, error: "Posizione utente mancante o non valida", code: "USER_LOCATION_REQUIRED" });
      }
      const barLat = Number(bar.latitude);
      const barLon = Number(bar.longitude);
      if (!Number.isFinite(barLat) || !Number.isFinite(barLon)) {
        return reply.status(400).send({ success: false, error: "Questo bar non ha una posizione valida", code: "BAR_LOCATION_UNAVAILABLE" });
      }
      const distMeters = getDistanceMeters(userLatitude, userLongitude, barLat, barLon);
      const maxDist = barCfg.gpsRadiusMeters > 0 ? barCfg.gpsRadiusMeters : getConsumptionRequestMaxDistanceMeters();
      // RIMUOVERE COMMENTO prima di rilasciare!!!
      // if (distMeters > maxDist) {
      //   return reply.status(403).send({
      //     success: false,
      //     error: "Devi essere vicino al bar per inviare la richiesta",
      //     code: "USER_TOO_FAR_FROM_BAR",
      //     data: { distanceMeters: Math.round(distMeters), maxDistanceMeters: maxDist },
      //   });
      // }

      // ── sha256 dell'immagine originale ─────────────────────────────────────
      const imageSha256 = createHash("sha256").update(imageBuffer).digest("hex");

      // ── Controlla duplicato immagine (stessa foto già consumata) ──────────
      const pool = databaseService.getPool();
      const dupImage = await pool.query<{ id: string; consumed_at: string | null }>(
        "SELECT id, consumed_at FROM receipt_ocr_sessions WHERE image_sha256 = $1 LIMIT 1",
        [imageSha256],
      );
      if (dupImage.rows.length > 0 && dupImage.rows[0].consumed_at !== null) {
        return reply.status(409).send({
          success: false,
          error: "Questa foto scontrino è già stata utilizzata.",
          code: "DUPLICATE_IMAGE",
        });
      }

      // ── OCR ────────────────────────────────────────────────────────────────
      const ocrResult = await extractReceiptFields(imageBuffer);

      // ── Upload Cloudinary ──────────────────────────────────────────────────
      let imageUrl: string | null = null;
      try {
        const uploadResult = await uploadOptimizedImage(imageBuffer, `receipt-${imageSha256.slice(0, 12)}.jpg`, "fidelty/receipts");
        imageUrl = uploadResult.secure_url;
      } catch (uploadErr) {
        console.warn("⚠️ Upload Cloudinary scontrino fallito (non bloccante):", (uploadErr as Error).message);
      }

      // ── Persisti sessione OCR ──────────────────────────────────────────────
      const { ulid } = await import("ulid");
      const sessionId = ulid();
      const fieldsFound = {
        amount:    ocrResult.amount.value !== null,
        vatNumber: ocrResult.vatNumber.value !== null,
        docId:     ocrResult.docId.value !== null,
        date:      ocrResult.date.value !== null,
      };

      await pool.query(
        `INSERT INTO receipt_ocr_sessions (
          id, user_id, bar_id, amount, vat_number, doc_id, receipt_date,
          image_sha256, image_url, raw_text, fields_found, expires_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW() + INTERVAL '10 minutes',CURRENT_TIMESTAMP)`,
        [
          sessionId,
          userId,
          bar.id,
          ocrResult.amount.value ?? null,
          ocrResult.vatNumber.value ?? null,
          ocrResult.docId.value ?? null,
          ocrResult.date.value ?? null,
          imageSha256,
          imageUrl,
          ocrResult.rawText.slice(0, 4000), // limita dimensione raw
          JSON.stringify(fieldsFound),
        ],
      );

      return reply.status(200).send({
        success: true,
        data: {
          ocrSessionId: sessionId,
          // Campi estratti (solo per visualizzazione — il server li userà dal DB al Passo 2)
          amount:    ocrResult.amount.value,
          docId:     ocrResult.docId.value,
          date:      ocrResult.date.value,
          vatNumber: ocrResult.vatNumber.value,
          fieldsFound,
          durationMs: ocrResult.durationMs,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "OCR_UPLOAD_ERROR" });
    }
  }

  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const body = (request.body as {
        barId?: string;
        qrCodeValue?: string;
        receiptCode?: string;
        amount?: number | string;
        userLatitude?: number | string;
        userLongitude?: number | string;
        ocrSessionId?: string;
        isMockedLocation?: boolean | string;
      } | undefined) || {};

      const isMockedLocation = body.isMockedLocation === true || body.isMockedLocation === "true";

      // ── Passo 2 OCR: se presente ocrSessionId, usa i dati dal DB ────────────
      let ocrSession: {
        id: string; user_id: string; bar_id: string;
        amount: string | null; doc_id: string | null;
        image_url: string | null;
      } | null = null;

      if (body.ocrSessionId) {
        const pool = databaseService.getPool();
        const sessionResult = await pool.query(
          `SELECT id, user_id, bar_id, amount, doc_id, image_url,
                  vat_number, receipt_date, fields_found, image_sha256, consumed_at
           FROM receipt_ocr_sessions
           WHERE id = $1`,
          [body.ocrSessionId],
        );

        if (sessionResult.rows.length === 0) {
          return reply.status(400).send({ success: false, error: "Sessione OCR non trovata", code: "OCR_SESSION_NOT_FOUND" });
        }

        const session = sessionResult.rows[0];

        if (session.user_id !== userId) {
          return reply.status(403).send({ success: false, error: "Sessione OCR non valida", code: "OCR_SESSION_INVALID" });
        }
        if (session.consumed_at !== null) {
          return reply.status(409).send({ success: false, error: "Sessione OCR già utilizzata", code: "OCR_SESSION_ALREADY_CONSUMED" });
        }
        const expiresResult = await pool.query<{ expired: boolean }>(
          "SELECT expires_at < NOW() AS expired FROM receipt_ocr_sessions WHERE id = $1",
          [body.ocrSessionId],
        );
        if (expiresResult.rows[0]?.expired) {
          return reply.status(410).send({ success: false, error: "Sessione OCR scaduta. Rifai la foto.", code: "OCR_SESSION_EXPIRED" });
        }

        ocrSession = session;
      }

      // ── Resolve bar (by barId o dal barId della sessione OCR) ───────────────
      let bar = null;
      if (ocrSession) {
        bar = await barRepository.findById(ocrSession.bar_id);
      } else {
        bar = body.barId ? await barRepository.findById(body.barId) : null;
        if (!bar) {
          const vatNumber = parseBarQrValue(body.qrCodeValue || "");
          if (!vatNumber) {
            return reply.status(400).send({ success: false, error: "Codice QR o barId non valido", code: "INVALID_BAR_REFERENCE" });
          }
          bar = await barRepository.findByPiva(vatNumber);
        }
      }

      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      // ── Amount: dal DB se sessione OCR, altrimenti dal body ─────────────────
      const amount = ocrSession
        ? Number.parseFloat(String(ocrSession.amount || ""))
        : (typeof body.amount === "number" ? body.amount : Number.parseFloat(String(body.amount || "")));
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.status(400).send({ success: false, error: "Importo non valido", code: "INVALID_AMOUNT" });
      }

      // ── Receipt code: dal doc_id OCR oppure dal body ─────────────────────────
      let receiptCodeBlock1: string | null = null;
      let receiptCodeBlock2: string | null = null;

      if (ocrSession) {
        // Il doc_id dalla sessione potrebbe essere null — il partial index lo gestisce
        if (ocrSession.doc_id && RECEIPT_CODE_RE.test(ocrSession.doc_id)) {
          [receiptCodeBlock1, receiptCodeBlock2] = ocrSession.doc_id.split("-");
        }
      } else {
        const receiptCode = String(body.receiptCode || "").trim().toUpperCase();
        if (!RECEIPT_CODE_RE.test(receiptCode)) {
          return reply.status(400).send({
            success: false,
            error: "Codice scontrino non valido. Formato atteso: XXXX-XXXX",
            code: "INVALID_RECEIPT_CODE",
          });
        }
        [receiptCodeBlock1, receiptCodeBlock2] = receiptCode.split("-");
      }

      // ── GPS check ────────────────────────────────────────────────────────────
      const userLatitude = typeof body.userLatitude === "number"
        ? body.userLatitude
        : Number.parseFloat(String(body.userLatitude || ""));
      const userLongitude = typeof body.userLongitude === "number"
        ? body.userLongitude
        : Number.parseFloat(String(body.userLongitude || ""));

      const barLatitude = bar.latitude !== null ? Number(bar.latitude) : NaN;
      const barLongitude = bar.longitude !== null ? Number(bar.longitude) : NaN;
      if (!Number.isFinite(barLatitude) || !Number.isFinite(barLongitude)) {
        return reply.status(400).send({ success: false, error: "Questo bar non ha una posizione valida", code: "BAR_LOCATION_UNAVAILABLE" });
      }
      if (!Number.isFinite(userLatitude) || !Number.isFinite(userLongitude)) {
        return reply.status(400).send({ success: false, error: "Posizione utente mancante o non valida", code: "USER_LOCATION_REQUIRED" });
      }

      // Bar-specific GPS radius (from bar_config) or env/default fallback
      const [barCfg, platformConfig] = await Promise.all([
        barConfigRepository.getByBarId(bar.id),
        platformConfigRepository.get(),
      ]);
      const maxDistanceMeters = barCfg.gpsRadiusMeters > 0
        ? barCfg.gpsRadiusMeters
        : getConsumptionRequestMaxDistanceMeters();

      const distanceMeters = getDistanceMeters(userLatitude, userLongitude, barLatitude, barLongitude);
      if (distanceMeters > maxDistanceMeters) {
        return reply.status(403).send({
          success: false,
          error: "Devi essere vicino al bar per inviare la richiesta",
          code: "USER_TOO_FAR_FROM_BAR",
          data: { distanceMeters: Math.round(distanceMeters), maxDistanceMeters },
        });
      }

      if (bar.user_id === userId) {
        return reply.status(400).send({ success: false, error: "Non puoi inviare una richiesta al tuo stesso bar", code: "SELF_REQUEST_NOT_ALLOWED" });
      }

      // ── Semaphore evaluation (also checks rate limit) ────────────────────────
      let evaluation: Awaited<ReturnType<typeof semaphoreService.evaluate>>;
      try {
        evaluation = await semaphoreService.evaluate({
          userId,
          barId: bar.id,
          amount,
          receiptCodeBlock1,
          receiptCodeBlock2,
          barConfig: barCfg,
          // Fase 2 — nuovi campi
          barPiva: bar.iva ?? null,
          ocrVatNumber: ocrSession ? (ocrSession as any).vat_number ?? null : undefined,
          ocrReceiptDate: ocrSession ? (ocrSession as any).receipt_date
            ? new Date((ocrSession as any).receipt_date).toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" })
            : null
            : undefined,
          hasOcrSession: !!ocrSession,
          isMockedLocation,
          imageSha256: ocrSession ? (ocrSession as any).image_sha256 ?? null : null,
          ocrFieldsFound: ocrSession && (ocrSession as any).fields_found
            ? {
                amount:    Boolean((ocrSession as any).fields_found?.amount),
                vatNumber: Boolean((ocrSession as any).fields_found?.vatNumber),
                docId:     Boolean((ocrSession as any).fields_found?.docId),
                date:      Boolean((ocrSession as any).fields_found?.date),
              }
            : null,
        });
      } catch (semErr: any) {
        if (semErr?.code === "RATE_LIMIT_EXCEEDED") {
          return reply.status(429).send({ success: false, error: semErr.message, code: "RATE_LIMIT_EXCEEDED" });
        }
        throw semErr;
      }

      const isRed       = evaluation.status === "red";
      const isAutoCredit = barCfg.autoCreditEnabled && evaluation.status === "green";
      const initialStatus = isRed ? "rejected" : isAutoCredit ? "credited" : "pending";
      const rejectionReason = isRed
        ? (evaluation.signals.find((s) => s.severity === "reject")?.reason ?? "Rifiutato automaticamente.")
        : null;
      const pointsPreview = Math.round(amount * platformConfig.pointsPerEuro);

      const requester = await userRepository.findById(userId);

      // ── Persist request (+ optional auto-credit) in a transaction ─────────────
      const client = await databaseService.getPool().connect();
      let created: ConsumptionRequestDTO;
      try {
        await client.query("BEGIN");

        const insertResult = await databaseService.getPool().query(
          `INSERT INTO consumption_requests (
              id, requester_user_id, bar_id, amount, points_preview, status,
              qr_code_value, requester_name_snapshot, requester_email_snapshot,
              receipt_code_block1, receipt_code_block2, receipt_submitted_at,
              semaphore_status, signal_flags, rejection_reason, updated_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP,$12,$13,$14,CURRENT_TIMESTAMP)
           RETURNING *`,
          [
            (await import("ulid")).ulid(),
            userId,
            bar.id,
            amount.toFixed(2),
            pointsPreview,
            initialStatus,
            `${QR_PREFIX}${bar.iva}`,
            requester?.name || null,
            requester?.email || null,
            receiptCodeBlock1,
            receiptCodeBlock2,
            evaluation.status,
            JSON.stringify(evaluation.signals),
            rejectionReason,
          ],
        );
        created = insertResult.rows[0];

        if (isAutoCredit) {
          // Credit points immediately via loyaltyCard upsert
          await (await import("../repositories/loyaltyCardRepository.js"))
            .loyaltyCardRepository.upsertCardInTransaction(client, userId, bar.id, pointsPreview);

          // Retroactive duplicate flagging (feature flag v1.1)
          if (
            process.env.FEATURE_RETROACTIVE_DUPLICATES === "true" &&
            evaluation.signals.some((s) => s.code === "DUPLICATE")
          ) {
            const dupSignal = evaluation.signals.find((s) => s.code === "DUPLICATE")!;
            if (dupSignal.duplicateRequestId) {
              await consumptionRequestRepository.markAsRetroactivelyFlagged(client, dupSignal.duplicateRequestId, dupSignal);
            }
          }
        }

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        // Unique constraint violation on receipt code
        if ((txErr as any)?.code === "23505" && String((txErr as any)?.constraint).includes("receipt")) {
          return reply.status(409).send({ success: false, error: "Codice scontrino già registrato per oggi in questo bar.", code: "DUPLICATE_RECEIPT_CODE" });
        }
        throw txErr;
      } finally {
        client.release();
      }

      // ── Marca sessione OCR come consumata ────────────────────────────────────
      if (ocrSession) {
        databaseService.getPool().query(
          "UPDATE receipt_ocr_sessions SET consumed_at = NOW() WHERE id = $1",
          [ocrSession.id],
        ).catch(() => { /* non-critical */ });
      }

      // ── Notify bar (only for yellow/pending — not for red or green) ──────────
      let notifChannel: string = "none";
      if (!isAutoCredit && !isRed) {
        const notifResult = await consumptionNotificationService.notifyBarOfNewRequest({
          barId: bar.id,
          barName: bar.name,
          barOwnerUserId: bar.user_id,
          requesterName: requester?.name || "Cliente",
          amount,
          pointsPreview,
          requestId: created.id,
        }).catch(() => ({ delivered: false, channel: "none" as const }));
        notifChannel = notifResult.channel;
      }

      // Shadow mode: receipt_events (append-only, fire-and-forget)
      (async () => {
        try {
          const { ulid: generateUlid } = await import("ulid");
          await databaseService.getPool().query(
            `INSERT INTO receipt_events (
              id, user_id, bar_id, consumption_request_id,
              distance_meters, amount, semaphore_status, signal_codes,
              ocr_used, notification_channel, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,CURRENT_TIMESTAMP)`,
            [
              generateUlid(),
              userId,
              bar.id,
              created.id,
              Math.round(distanceMeters),
              amount.toFixed(2),
              evaluation.status,
              evaluation.signals.map((s) => s.code),
              notifChannel,
            ],
          );
        } catch { /* non-critical */ }
      })();

      return reply.status(201).send({
        success: true,
        data: {
          id: created.id,
          status: created.status,
          semaphoreStatus: created.semaphore_status,
          signalFlags: Array.isArray(created.signal_flags) ? created.signal_flags : [],
          amount,
          pointsPreview,
          receiptCode: receiptCodeBlock1 && receiptCodeBlock2 ? `${receiptCodeBlock1}-${receiptCodeBlock2}` : null,
          ocrSessionId: ocrSession?.id ?? null,
          imageUrl: ocrSession ? (ocrSession.image_url ?? null) : null,
          requester: { id: userId, name: requester?.name || null, email: requester?.email || null },
          bar: { id: bar.id, name: bar.name, businessName: bar.merchant_name, piva: bar.iva, address: bar.address, logo: bar.logo },
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

  async listCreditedForBar(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const limitDays = Number((request.query as any)?.limitDays) || 7;
      const requests = await consumptionRequestRepository.listCreditedByBarId(bar.id, limitDays);

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
      const body = (request.body as {
        status?: string;
        rejectionReason?: string;
        correctedAmount?: number | string;
      } | undefined) || {};
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

      // Parse optional corrected amount (barista override)
      const correctedAmount = body.correctedAmount != null
        ? (typeof body.correctedAmount === "number" ? body.correctedAmount : Number.parseFloat(String(body.correctedAmount)))
        : null;

      if (correctedAmount !== null && (!Number.isFinite(correctedAmount) || correctedAmount <= 0)) {
        return reply.status(400).send({ success: false, error: "Importo corretto non valido", code: "INVALID_CORRECTED_AMOUNT" });
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
            correctedAmount: correctedAmount ?? null,
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
  async manualCredit(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const body = (request.body as {
        userPublicId?: string;
        amount?: number | string;
        note?: string;
      } | undefined) || {};

      const { userPublicId, note } = body;
      const amount = typeof body.amount === "number" ? body.amount : Number.parseFloat(String(body.amount || ""));

      if (!userPublicId || typeof userPublicId !== "string") {
        return reply.status(400).send({ success: false, error: "userPublicId obbligatorio", code: "MISSING_USER_PUBLIC_ID" });
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.status(400).send({ success: false, error: "Importo non valido", code: "INVALID_AMOUNT" });
      }

      const targetUser = await userRepository.findByPublicId(userPublicId.trim().toUpperCase());
      if (!targetUser) {
        return reply.status(404).send({ success: false, error: "Utente non trovato", code: "USER_NOT_FOUND" });
      }

      const platformConfig = await platformConfigRepository.get();
      const pointsPreview = Math.round(amount * platformConfig.pointsPerEuro);
      const signalReason = note ? `Credito manuale del barista: ${note}` : "Credito manuale del barista";

      const client = await databaseService.getPool().connect();
      let created: ConsumptionRequestDTO;
      try {
        await client.query("BEGIN");

        const insertResult = await client.query(
          `INSERT INTO consumption_requests (
              id, requester_user_id, bar_id, amount, points_preview, status,
              qr_code_value, requester_name_snapshot, requester_email_snapshot,
              semaphore_status, signal_flags, updated_at
           )
           VALUES ($1,$2,$3,$4,$5,'credited',$6,$7,$8,'green',$9,CURRENT_TIMESTAMP)
           RETURNING *`,
          [
            (await import("ulid")).ulid(),
            targetUser.id,
            bar.id,
            amount.toFixed(2),
            pointsPreview,
            `${QR_PREFIX}${bar.iva}`,
            targetUser.name || null,
            targetUser.email || null,
            JSON.stringify([{ code: "MANUAL_BAR_CREDIT", reason: signalReason }]),
          ],
        );
        created = insertResult.rows[0];

        await (await import("../repositories/loyaltyCardRepository.js"))
          .loyaltyCardRepository.upsertCardInTransaction(client, targetUser.id, bar.id, pointsPreview);

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      // Shadow mode: receipt_events fire-and-forget
      (async () => {
        try {
          const { ulid: generateUlid } = await import("ulid");
          await databaseService.getPool().query(
            `INSERT INTO receipt_events (
              id, user_id, bar_id, consumption_request_id,
              amount, semaphore_status, signal_codes, ocr_used, notification_channel, created_at
            ) VALUES ($1,$2,$3,$4,$5,'green','{"MANUAL_BAR_CREDIT"}',false,'none',CURRENT_TIMESTAMP)`,
            [generateUlid(), targetUser.id, bar.id, created.id, amount.toFixed(2)],
          );
        } catch { /* non-critical */ }
      })();

      return reply.status(201).send({
        success: true,
        data: {
          id: created.id,
          status: "credited",
          amount,
          pointsPreview,
          targetUser: { id: targetUser.id, name: targetUser.name, publicId: targetUser.public_id },
          bar: { id: bar.id, name: bar.name },
          createdAt: created.created_at,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "MANUAL_CREDIT_ERROR" });
    }
  }
}

export const consumptionRequestController = new ConsumptionRequestController();