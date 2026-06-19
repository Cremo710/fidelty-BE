import { FastifyRequest, FastifyReply } from "fastify";
import { businessRequestRepository } from "../repositories/businessRequestRepository.js";
import { barRepository } from "../repositories/barRepository.js";
import { userRepository } from "../repositories/userRepository.js";
import { uploadDocument, uploadOptimizedImage, isDocumentFile, isFileSizeValid, isImageFile } from "../utils/imageUpload.js";
import { databaseService } from "../services/databaseService.js";
import { emailService } from "../services/emailService.js";
import { getAuthService } from "../services/authService.js";
import { issueEmailVerification } from "./authController.js";
import { registerSchema } from "../validators/authValidator.js";

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

  // ---------------------------------------------------------------------------
  // Helpers privati
  // ---------------------------------------------------------------------------

  /** Parsifica il body multipart e restituisce campi testuali + buffer file. */
  private async parseMultipart(request: FastifyRequest): Promise<{
    data: Record<string, string>;
    docBuffer: Buffer | null; docMimeType: string | null; docFileName: string | null;
    coverBuffer: Buffer | null; coverMimeType: string | null; coverFileName: string | null;
    logoBuffer: Buffer | null; logoMimeType: string | null; logoFileName: string | null;
    cardBackgroundBuffer: Buffer | null; cardBackgroundMimeType: string | null; cardBackgroundFileName: string | null;
  }> {
    const data: Record<string, string> = {};
    let docBuffer: Buffer | null = null, docMimeType: string | null = null, docFileName: string | null = null;
    let coverBuffer: Buffer | null = null, coverMimeType: string | null = null, coverFileName: string | null = null;
    let logoBuffer: Buffer | null = null, logoMimeType: string | null = null, logoFileName: string | null = null;
    let cardBackgroundBuffer: Buffer | null = null, cardBackgroundMimeType: string | null = null, cardBackgroundFileName: string | null = null;

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
          docBuffer = buffer; docMimeType = part.mimetype; docFileName = part.filename;
        } else if (part.fieldname === "coverImage") {
          coverBuffer = buffer; coverMimeType = part.mimetype; coverFileName = part.filename;
        } else if (part.fieldname === "logo") {
          logoBuffer = buffer; logoMimeType = part.mimetype; logoFileName = part.filename;
        } else if (part.fieldname === "cardBackgroundImage") {
          cardBackgroundBuffer = buffer; cardBackgroundMimeType = part.mimetype; cardBackgroundFileName = part.filename;
        }
      }
    }
    return { data, docBuffer, docMimeType, docFileName, coverBuffer, coverMimeType, coverFileName, logoBuffer, logoMimeType, logoFileName, cardBackgroundBuffer, cardBackgroundMimeType, cardBackgroundFileName };
  }

  /**
   * Valida i campi business, carica i file e persiste la business request.
   * Restituisce la riga creata oppure null se ha già inviato una risposta di errore.
   */
  private async persistBusinessRequest(
    reply: FastifyReply,
    data: Record<string, string>,
    files: {
      docBuffer: Buffer | null; docMimeType: string | null; docFileName: string | null;
      coverBuffer: Buffer | null; coverMimeType: string | null; coverFileName: string | null;
      logoBuffer: Buffer | null; logoMimeType: string | null; logoFileName: string | null;
      cardBackgroundBuffer: Buffer | null; cardBackgroundMimeType: string | null; cardBackgroundFileName: string | null;
    },
    userId: string,
  ): Promise<any | null> {
    const { docBuffer, docMimeType, docFileName, coverBuffer, coverMimeType, coverFileName,
      logoBuffer, logoMimeType, logoFileName, cardBackgroundBuffer, cardBackgroundMimeType, cardBackgroundFileName } = files;

    // Validazione campi obbligatori
    if (!data.businessName || !data.barName || !data.address || !data.vatNumber) {
      await reply.status(400).send({ success: false, error: "Ragione sociale, nome bar, indirizzo e P.IVA sono obbligatori" });
      return null;
    }

    if (!/^\d{11}$/.test(data.vatNumber.replace(/\s/g, ""))) {
      await reply.status(400).send({ success: false, error: "Partita IVA non valida (deve contenere 11 cifre)" });
      return null;
    }

    if (data.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) {
      await reply.status(400).send({ success: false, error: "Email di contatto non valida" });
      return null;
    }

    if (data.phone && !/^[\d\s+\-()]{6,20}$/.test(data.phone)) {
      await reply.status(400).send({ success: false, error: "Numero di telefono non valido" });
      return null;
    }

    let offers: unknown[] = [];
    if (data.offers) {
      try {
        const parsed = JSON.parse(data.offers);
        if (!Array.isArray(parsed)) throw new Error("offers_must_be_array");
        offers = parsed;
      } catch {
        await reply.status(400).send({ success: false, error: "Formato offerte non valido" });
        return null;
      }
    }

    let openingHours: unknown[] = [];
    if (data.openingHours) {
      try {
        const parsed = JSON.parse(data.openingHours);
        if (!Array.isArray(parsed)) throw new Error("opening_hours_must_be_array");
        openingHours = parsed;
      } catch {
        await reply.status(400).send({ success: false, error: "Formato orari non valido" });
        return null;
      }
    }

    const validateOptionalImage = (buffer: Buffer | null, mimeType: string | null, fieldLabel: string): string | null => {
      if (!buffer) return null;
      if (!mimeType || !isImageFile(mimeType)) return `${fieldLabel}: formato immagine non supportato. Usa PNG, JPEG o WebP.`;
      if (!isFileSizeValid(buffer.length, 5)) return `${fieldLabel}: file troppo grande (max 5MB)`;
      return null;
    };

    const imageValidationError =
      validateOptionalImage(coverBuffer, coverMimeType, "Cover") ||
      validateOptionalImage(logoBuffer, logoMimeType, "Logo") ||
      validateOptionalImage(cardBackgroundBuffer, cardBackgroundMimeType, "Sfondo card");

    if (imageValidationError) {
      await reply.status(400).send({ success: false, error: imageValidationError });
      return null;
    }

    // Upload documento
    let documentUrl: string | null = null, documentPublicId: string | null = null;
    if (docBuffer && docMimeType && docFileName) {
      if (!isDocumentFile(docMimeType)) {
        await reply.status(400).send({ success: false, error: "Formato documento non supportato. Usa PNG, JPEG, WebP o PDF." });
        return null;
      }
      if (!isFileSizeValid(docBuffer.length, 10)) {
        await reply.status(400).send({ success: false, error: "Il documento è troppo grande (max 10MB)" });
        return null;
      }
      const uploadResult = await uploadDocument(docBuffer, docFileName, docMimeType);
      documentUrl = uploadResult.secure_url;
      documentPublicId = uploadResult.public_id;
    }

    let coverImageUrl: string | null = null, coverImagePublicId: string | null = null;
    if (coverBuffer && coverFileName) {
      const uploadResult = await uploadOptimizedImage(coverBuffer, coverFileName, "fidelty/business_requests/cover");
      coverImageUrl = uploadResult.secure_url;
      coverImagePublicId = uploadResult.public_id;
    }

    let logoUrl: string | null = null, logoPublicId: string | null = null;
    if (logoBuffer && logoFileName) {
      const uploadResult = await uploadOptimizedImage(logoBuffer, logoFileName, "fidelty/business_requests/logo");
      logoUrl = uploadResult.secure_url;
      logoPublicId = uploadResult.public_id;
    }

    let cardBackgroundImageUrl: string | null = null, cardBackgroundImagePublicId: string | null = null;
    if (cardBackgroundBuffer && cardBackgroundFileName) {
      const uploadResult = await uploadOptimizedImage(cardBackgroundBuffer, cardBackgroundFileName, "fidelty/business_requests/card_background");
      cardBackgroundImageUrl = uploadResult.secure_url;
      cardBackgroundImagePublicId = uploadResult.public_id;
    }

    let latitude: number | null = null, longitude: number | null = null;
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

    return businessRequestRepository.create({
      userId,
      businessName: data.businessName,
      barName: data.barName,
      address: data.address,
      vatNumber: data.vatNumber,
      contactEmail: data.contactEmail || null,
      phone: data.phone || null,
      documentUrl, documentPublicId,
      coverImageUrl, coverImagePublicId,
      logoUrl, logoPublicId,
      instagram: data.instagram || null,
      facebook: data.facebook || null,
      tiktok: data.tiktok || null,
      website: data.website || null,
      cardBackgroundImageUrl, cardBackgroundImagePublicId,
      cardColor: data.cardColor || null,
      cardUseCover: data.cardUseCover === "true" || (data.cardUseCover as any) === true,
      offers,
      openingHours,
      latitude,
      longitude,
    });
  }

  // ---------------------------------------------------------------------------
  // Endpoint autenticato (app / dashboard)
  // ---------------------------------------------------------------------------

  /**
   * POST /api/business-requests
   * Crea una nuova richiesta di registrazione bar (utente già autenticato)
   */
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const hasPending = await businessRequestRepository.hasPendingRequest(userId);
      if (hasPending) {
        return reply.status(400).send({ success: false, error: "Hai già una richiesta in attesa di approvazione", code: "REQUEST_PENDING" });
      }

      const { data, ...files } = await this.parseMultipart(request);
      const businessRequest = await this.persistBusinessRequest(reply, data, files, userId);
      if (!businessRequest) return;

      return reply.status(201).send({ success: true, data: businessRequest });
    } catch (error: any) {
      console.error("❌ Errore creazione business request:", error);
      return reply.status(500).send({ success: false, error: "Errore durante la creazione della richiesta" });
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoint pubblico (sito web)
  // ---------------------------------------------------------------------------

  /**
   * POST /api/business-requests/public
   * Crea un account proprietario (se nuovo) e una richiesta bar, senza autenticazione.
   */
  async createFromSite(request: FastifyRequest, reply: FastifyReply) {
    try {
      // 1. Parsifica l'intero body multipart (un'unica passata sul stream)
      const { data, ...files } = await this.parseMultipart(request);

      // 2. Valida i campi account
      const accountName = (data.accountName || "").trim();
      const accountEmail = (data.accountEmail || "").trim().toLowerCase();
      const accountPassword = data.accountPassword || "";

      if (!accountName) {
        return reply.status(400).send({ success: false, error: "Il nome del titolare è obbligatorio", code: "VALIDATION_ERROR" });
      }

      // Riusa lo stesso schema password di authValidator
      const passwordValidation = registerSchema.shape.password.safeParse(accountPassword);
      if (!passwordValidation.success) {
        return reply.status(400).send({
          success: false,
          error: passwordValidation.error.errors[0]?.message ?? "Password non valida",
          code: "VALIDATION_ERROR",
        });
      }

      const emailValidation = registerSchema.shape.email.safeParse(accountEmail);
      if (!emailValidation.success) {
        return reply.status(400).send({ success: false, error: "Email non valida", code: "VALIDATION_ERROR" });
      }

      // 3. Risolvi l'utente
      let userId: string;
      let accountCreated = false;
      let accountAlreadyExists = false;
      let verificationEmailSent = false;

      const exists = await userRepository.emailExists(accountEmail);
      if (!exists) {
        const authService = getAuthService();
        const hashed = await authService.hashPassword(accountPassword);
        userId = await userRepository.createUser({ name: accountName, email: accountEmail, password: hashed });
        try {
          const dispatch = await issueEmailVerification({ id: userId, email: accountEmail, name: accountName });
          verificationEmailSent = dispatch.sent ?? true;
        } catch (emailErr) {
          console.warn("⚠️ Email di verifica non inviata:", emailErr);
        }
        accountCreated = true;
      } else {
        // Account esistente: recupera l'id senza sovrascrivere la password (anti-takeover)
        const existing = await userRepository.findByEmail(accountEmail);
        if (!existing) {
          return reply.status(500).send({ success: false, error: "Errore interno durante il recupero dell'account" });
        }
        userId = existing.id;
        accountAlreadyExists = true;
      }

      // 4. Guard duplicati
      const hasPending = await businessRequestRepository.hasPendingRequest(userId);
      if (hasPending) {
        return reply.status(400).send({ success: false, error: "Esiste già una richiesta in attesa per questo account", code: "REQUEST_PENDING" });
      }

      // 5. Pre-check P.IVA (l'approvazione lo ricontrolla comunque)
      if (data.vatNumber) {
        const pivaExists = await barRepository.findByPiva(data.vatNumber.replace(/\s/g, ""));
        if (pivaExists) {
          return reply.status(400).send({ success: false, error: "Esiste già un bar con questa Partita IVA" });
        }
      }

      // 6. Crea la business request
      const businessRequest = await this.persistBusinessRequest(reply, data, files, userId);
      if (!businessRequest) return;

      // 7. Risposta
      return reply.status(201).send({
        success: true,
        data: businessRequest,
        accountCreated,
        accountAlreadyExists,
        verificationEmailSent,
      });
    } catch (error: any) {
      console.error("❌ Errore createFromSite:", error);
      return reply.status(500).send({ success: false, error: "Errore durante la creazione della richiesta" });
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoint admin / lettura
  // ---------------------------------------------------------------------------

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
