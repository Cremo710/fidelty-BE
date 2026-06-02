import { FastifyRequest, FastifyReply } from "fastify";
import { businessRequestRepository } from "../repositories/businessRequestRepository.js";
import { barRepository } from "../repositories/barRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { uploadDocument, uploadOptimizedImage, isDocumentFile, isFileSizeValid, isImageFile } from "../utils/imageUpload.js";
import { databaseService } from "../services/databaseService.js";
import { emailService } from "../services/emailService.js";

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{
    geometry: {
      location: {
        lat: number;
        lng: number;
      };
    };
  }>;
}

export class BusinessRequestController {
  private async geocodeAddress(address: string): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const apiKey = process.env.GOOGLE_GEOCODE_API_KEY;
      if (!apiKey || !address) {
        return null;
      }

      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
      const geoResp = await fetch(geocodeUrl);
      const geoJson = (await geoResp.json()) as GoogleGeocodeResponse;

      if (geoJson.status !== "OK" || !geoJson.results?.[0]) {
        return null;
      }

      return {
        latitude: Number(geoJson.results[0].geometry.location.lat),
        longitude: Number(geoJson.results[0].geometry.location.lng),
      };
    } catch (error) {
      console.warn("⚠️ Geocoding business request fallito:", error);
      return null;
    }
  }

  /**
   * POST /api/business-requests
   * Crea una nuova richiesta di registrazione bar
   */
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      // Controlla se ha già una richiesta pending
      const hasPending = await businessRequestRepository.hasPendingRequest(userId);
      if (hasPending) {
        return reply.status(400).send({
          success: false,
          error: "Hai già una richiesta in attesa di approvazione",
          code: "REQUEST_PENDING",
        });
      }

      // Parse multipart form data
      const data: any = {};
      let docBuffer: Buffer | null = null;
      let docMimeType: string | null = null;
      let docFileName: string | null = null;
      let coverBuffer: Buffer | null = null;
      let coverMimeType: string | null = null;
      let coverFileName: string | null = null;
      let logoBuffer: Buffer | null = null;
      let logoMimeType: string | null = null;
      let logoFileName: string | null = null;
      let cardBackgroundBuffer: Buffer | null = null;
      let cardBackgroundMimeType: string | null = null;
      let cardBackgroundFileName: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          data[part.fieldname] = (part.value as string).trim();
        } else if (part.type === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          const buffer = Buffer.concat(chunks);

          if (part.fieldname === "document") {
            docBuffer = buffer;
            docMimeType = part.mimetype;
            docFileName = part.filename;
          } else if (part.fieldname === "coverImage") {
            coverBuffer = buffer;
            coverMimeType = part.mimetype;
            coverFileName = part.filename;
          } else if (part.fieldname === "logo") {
            logoBuffer = buffer;
            logoMimeType = part.mimetype;
            logoFileName = part.filename;
          } else if (part.fieldname === "cardBackgroundImage") {
            cardBackgroundBuffer = buffer;
            cardBackgroundMimeType = part.mimetype;
            cardBackgroundFileName = part.filename;
          }
        }
      }

      // Validazione campi obbligatori
      if (!data.businessName || !data.barName || !data.address || !data.vatNumber) {
        return reply.status(400).send({
          success: false,
          error: "Ragione sociale, nome bar, indirizzo e P.IVA sono obbligatori",
        });
      }

      // Validazione P.IVA
      if (!/^\d{11}$/.test(data.vatNumber.replace(/\s/g, ""))) {
        return reply.status(400).send({
          success: false,
          error: "Partita IVA non valida (deve contenere 11 cifre)",
        });
      }

      if (data.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) {
        return reply.status(400).send({
          success: false,
          error: "Email di contatto non valida",
        });
      }

      if (data.phone && !/^[\d\s+\-()]{6,20}$/.test(data.phone)) {
        return reply.status(400).send({
          success: false,
          error: "Numero di telefono non valido",
        });
      }

      let offers: unknown[] = [];
      if (data.offers) {
        try {
          const parsed = JSON.parse(data.offers);
          if (!Array.isArray(parsed)) {
            throw new Error("offers_must_be_array");
          }
          offers = parsed;
        } catch {
          return reply.status(400).send({
            success: false,
            error: "Formato offerte non valido",
          });
        }
      }

      let openingHours: unknown[] = [];
      if (data.openingHours) {
        try {
          const parsed = JSON.parse(data.openingHours);
          if (!Array.isArray(parsed)) {
            throw new Error("opening_hours_must_be_array");
          }
          openingHours = parsed;
        } catch {
          return reply.status(400).send({
            success: false,
            error: "Formato orari non valido",
          });
        }
      }

      const validateOptionalImage = (buffer: Buffer | null, mimeType: string | null, fieldLabel: string) => {
        if (!buffer) {
          return null;
        }

        if (!mimeType || !isImageFile(mimeType)) {
          return `${fieldLabel}: formato immagine non supportato. Usa PNG, JPEG o WebP.`;
        }

        if (!isFileSizeValid(buffer.length, 5)) {
          return `${fieldLabel}: file troppo grande (max 5MB)`;
        }

        return null;
      };

      const imageValidationError =
        validateOptionalImage(coverBuffer, coverMimeType, "Cover") ||
        validateOptionalImage(logoBuffer, logoMimeType, "Logo") ||
        validateOptionalImage(cardBackgroundBuffer, cardBackgroundMimeType, "Sfondo card");

      if (imageValidationError) {
        return reply.status(400).send({
          success: false,
          error: imageValidationError,
        });
      }

      // Upload documento se presente
      let documentUrl: string | null = null;
      let documentPublicId: string | null = null;

      if (docBuffer && docMimeType && docFileName) {
        if (!isDocumentFile(docMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Formato documento non supportato. Usa PNG, JPEG, WebP o PDF.",
          });
        }
        if (!isFileSizeValid(docBuffer.length, 10)) {
          return reply.status(400).send({
            success: false,
            error: "Il documento è troppo grande (max 10MB)",
          });
        }

        const uploadResult = await uploadDocument(docBuffer, docFileName, docMimeType);
        documentUrl = uploadResult.secure_url;
        documentPublicId = uploadResult.public_id;
      }

      let coverImageUrl: string | null = null;
      let coverImagePublicId: string | null = null;
      if (coverBuffer && coverFileName) {
        const uploadResult = await uploadOptimizedImage(coverBuffer, coverFileName, "fidelty/business_requests/cover");
        coverImageUrl = uploadResult.secure_url;
        coverImagePublicId = uploadResult.public_id;
      }

      let logoUrl: string | null = null;
      let logoPublicId: string | null = null;
      if (logoBuffer && logoFileName) {
        const uploadResult = await uploadOptimizedImage(logoBuffer, logoFileName, "fidelty/business_requests/logo");
        logoUrl = uploadResult.secure_url;
        logoPublicId = uploadResult.public_id;
      }

      let cardBackgroundImageUrl: string | null = null;
      let cardBackgroundImagePublicId: string | null = null;
      if (cardBackgroundBuffer && cardBackgroundFileName) {
        const uploadResult = await uploadOptimizedImage(
          cardBackgroundBuffer,
          cardBackgroundFileName,
          "fidelty/business_requests/card_background"
        );
        cardBackgroundImageUrl = uploadResult.secure_url;
        cardBackgroundImagePublicId = uploadResult.public_id;
      }

      let latitude: number | null = null;
      let longitude: number | null = null;
      const geocoded = await this.geocodeAddress(data.address);
      if (geocoded) {
        latitude = geocoded.latitude;
        longitude = geocoded.longitude;
      } else {
        const feLat = Number(data.latitude);
        const feLng = Number(data.longitude);
        if (Number.isFinite(feLat) && Number.isFinite(feLng)) {
          latitude = feLat;
          longitude = feLng;
        }
      }

      const businessRequest = await businessRequestRepository.create({
        userId,
        businessName: data.businessName,
        barName: data.barName,
        address: data.address,
        vatNumber: data.vatNumber,
        contactEmail: data.contactEmail || null,
        phone: data.phone || null,
        documentUrl,
        documentPublicId,
        coverImageUrl,
        coverImagePublicId,
        logoUrl,
        logoPublicId,
        instagram: data.instagram || null,
        facebook: data.facebook || null,
        tiktok: data.tiktok || null,
        website: data.website || null,
        cardBackgroundImageUrl,
        cardBackgroundImagePublicId,
        cardColor: data.cardColor || null,
        cardUseCover: data.cardUseCover === "true" || data.cardUseCover === true,
        offers,
        openingHours,
        latitude,
        longitude,
      });

      return reply.status(201).send({
        success: true,
        data: businessRequest,
      });
    } catch (error: any) {
      console.error("❌ Errore creazione business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante la creazione della richiesta",
      });
    }
  }

  /**
   * GET /api/business-requests/my
   * Recupera la richiesta dell'utente corrente
   */
  async getMyRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const businessRequest = await businessRequestRepository.findByUserId(userId);

      return reply.send({
        success: true,
        data: businessRequest,
      });
    } catch (error: any) {
      console.error("❌ Errore recupero business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante il recupero della richiesta",
      });
    }
  }

  /**
   * GET /api/business-requests
   * Lista tutte le richieste (admin)
   */
  async listAll(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const { status } = request.query as { status?: string };
      const requests = await businessRequestRepository.listAll(status);

      return reply.send({
        success: true,
        data: requests,
      });
    } catch (error: any) {
      console.error("❌ Errore lista business requests:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante il recupero delle richieste",
      });
    }
  }

  /**
  * PATCH /api/business-requests/:id
  * Approva o rifiuta una richiesta (admin) e invia una mail con l'esito all'utente
   */
  async updateStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const { id } = request.params as { id: string };
      const { status, rejectionReason } = request.body as {
        status: "approved" | "rejected" | "CONFIRMED" | "REFUSED";
        rejectionReason?: string;
      };

      if (!status || !["approved", "rejected", "CONFIRMED", "REFUSED"].includes(status)) {
        return reply.status(400).send({
          success: false,
          error: "Stato non valido. Usa 'approved'/'CONFIRMED' o 'rejected'/'REFUSED'.",
        });
      }

      const normalizedStatus = status === "approved"
        ? "CONFIRMED"
        : status === "rejected"
          ? "REFUSED"
          : status;

      if (normalizedStatus === "REFUSED" && !rejectionReason) {
        return reply.status(400).send({
          success: false,
          error: "Il motivo del rifiuto è obbligatorio",
        });
      }

      const existing = await businessRequestRepository.findById(id);
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: "Richiesta non trovata",
        });
      }

      if (existing.status !== "pending") {
        return reply.status(400).send({
          success: false,
          error: "Questa richiesta è già stata elaborata",
        });
      }

      const user = await userRepository.findById(existing.user_id);
      const recipientEmail = user?.email || null;
      const recipientName = user?.name || null;

      if (normalizedStatus === "CONFIRMED") {
        const pivaExists = await barRepository.findByPiva(existing.vat_number);
        if (pivaExists) {
          return reply.status(400).send({
            success: false,
            error: "Esiste già un bar con questa Partita IVA",
          });
        }

        const client = await databaseService.getPool().connect();

        try {
          await client.query("BEGIN");

          let offers: Array<{
            title: string;
            description?: string | null;
            conditions?: string | null;
            pointsRequired: number;
            icon?: string | null;
            validFrom?: string | null;
            validUntil?: string | null;
            isActive?: boolean;
          }> = [];

          if (Array.isArray(existing.offers_json)) {
            offers = existing.offers_json as Array<{
              title: string;
              description?: string | null;
              conditions?: string | null;
              pointsRequired: number;
              icon?: string | null;
              validFrom?: string | null;
              validUntil?: string | null;
              isActive?: boolean;
            }>;
          }

          let openingHours: Array<{
            dayOfWeek: number;
            isClosed: boolean;
            timeRanges: Array<{ open: string; close: string }>;
          }> | null = null;

          if (Array.isArray(existing.opening_hours_json)) {
            openingHours = existing.opening_hours_json as Array<{
              dayOfWeek: number;
              isClosed: boolean;
              timeRanges: Array<{ open: string; close: string }>;
            }>;
          }

          await barRepository.createBarCompleteWithClient(client, {
            userId: existing.user_id,
            piva: existing.vat_number,
            merchantName: existing.business_name,
            name: existing.bar_name,
            address: existing.address,
            image: existing.cover_image_url,
            logo: existing.logo_url,
            contactEmail: existing.contact_email,
            phone: existing.phone,
            instagram: existing.instagram,
            facebook: existing.facebook,
            tiktok: existing.tiktok,
            website: existing.website,
            latitude: existing.latitude,
            longitude: existing.longitude,
            cardColor: existing.card_color,
            cardBackgroundImage: existing.card_use_cover
              ? (existing.cover_image_url || existing.card_background_image_url)
              : existing.card_background_image_url,
            cardUseCover: existing.card_use_cover,
            offers,
            openingHours,
          });

          const updated = await businessRequestRepository.updateStatus(id, "CONFIRMED", undefined, client);

          await client.query("COMMIT");

          let emailResult = null;
          if (recipientEmail) {
            try {
              emailResult = await emailService.sendBusinessRequestDecisionEmail({
                recipientEmail,
                recipientName,
                barName: existing.bar_name,
                businessName: existing.business_name,
                status: "CONFIRMED",
              });
            } catch (emailError) {
              console.error("❌ Errore invio email approvazione business request:", emailError);
              emailResult = {
                sent: false,
                skippedReason: "send_failed",
                recipient: recipientEmail,
              };
            }
          }

          return reply.send({
            success: true,
            data: updated,
            email: emailResult,
          });
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }

      const updated = await businessRequestRepository.updateStatus(id, "REFUSED", rejectionReason);

      let emailResult = null;
      if (recipientEmail) {
        try {
          emailResult = await emailService.sendBusinessRequestDecisionEmail({
            recipientEmail,
            recipientName,
            barName: existing.bar_name,
            businessName: existing.business_name,
            status: "REFUSED",
            rejectionReason,
          });
        } catch (emailError) {
          console.error("❌ Errore invio email rifiuto business request:", emailError);
          emailResult = {
            sent: false,
            skippedReason: "send_failed",
            recipient: recipientEmail,
          };
        }
      }

      return reply.send({
        success: true,
        data: updated,
        email: emailResult,
      });
    } catch (error: any) {
      console.error("❌ Errore aggiornamento status business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante l'aggiornamento della richiesta",
      });
    }
  }
}

export const businessRequestController = new BusinessRequestController();
