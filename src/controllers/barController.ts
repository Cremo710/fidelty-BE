import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import { platformConfigRepository } from "../repositories/platformConfigRepository.js";
import {
  validateBarRegistrationInput,
  validateCardConfigInput,
  validateBarUpdateInput,
  type BarRegistrationInput,
} from "../validators/barValidator.js";
import { saveAndOptimizeImage, isImageFile, isFileSizeValid } from "../utils/imageUpload.js";
import { offerRepository } from "../repositories/offerRepository.js";
import { openingHoursRepository } from "../repositories/openingHoursRepository.js";
import { validateCreateOfferInput } from "../validators/offerValidator.js";
import { validateSetOpeningHoursInput } from "../validators/openingHoursValidator.js";
import { resolveOwnedBarForRequest, isBarSelectionMissing } from "../utils/ownedBarResolver.js";

/**
 * Interfaccia per la risposta di Google Geocoding
 */
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

/**
 * Bar Controller
 * Gestisce la logica di registrazione e operazioni correlate ai bar
 */
export class BarController {
  private async geocodeAddress(address: string): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const apiKey = process.env.GOOGLE_GEOCODE_API_KEY;
      if (!apiKey || !address) {
        return null;
      }

      const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        address
      )}&key=${apiKey}`;

      const geoResp = await fetch(geocodeUrl);
      const geoJson = (await geoResp.json()) as GoogleGeocodeResponse;

      if (geoJson.status !== "OK" || !geoJson.results || !geoJson.results[0]) {
        return null;
      }

      const location = geoJson.results[0].geometry.location;
      return {
        latitude: Number(location.lat),
        longitude: Number(location.lng),
      };
    } catch (error) {
      console.warn("⚠️ Geocoding fallito per indirizzo bar:", error);
      return null;
    }
  }

  private serializeBar(bar: any) {
    return {
      id: bar.id,
      piva: bar.iva,
      barName: bar.name,
      businessName: bar.merchant_name,
      address: bar.address,
      coverImage: bar.image,
      logo: bar.logo,
      contactEmail: bar.contact_email,
      phone: bar.phone,
      instagram: bar.instagram,
      facebook: bar.facebook,
      tiktok: bar.tiktok,
      website: bar.website,
      description: bar.description ?? null,
      cardBackgroundImage: bar.card_background_image,
      cardColor: bar.card_color,
      cardUseCover: bar.card_use_cover,
      createdAt: bar.created_at,
      updatedAt: bar.updated_at,
    };
  }

  /**
   * Handler per aggiornare la configurazione della card del bar (Step 2 onboarding)
   */
  async updateCardConfig(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const data: any = {};
      let cardBgFileBuffer: Buffer | null = null;
      let cardBgFileMimeType: string | null = null;
      let cardBgFileName: string | null = null;

      const contentType = request.headers["content-type"] || "";
      if (contentType.includes("multipart/form-data")) {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === "field") {
            data[part.fieldname] = part.value as string;
          } else if (part.type === "file" && part.fieldname === "cardBackgroundImage") {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            cardBgFileBuffer = Buffer.concat(chunks);
            cardBgFileMimeType = part.mimetype;
            cardBgFileName = part.filename;
            console.log(`📁 Card bg ricevuta: ${cardBgFileName} (${cardBgFileMimeType})`);
          }
        }
      } else {
        Object.assign(data, request.body as object);
      }

      // Normalizza cardUseCover
      if (data.cardUseCover !== undefined) {
        data.cardUseCover = data.cardUseCover === "true" || data.cardUseCover === true;
      }
      if (data.clearCardBackgroundImage !== undefined) {
        data.clearCardBackgroundImage = data.clearCardBackgroundImage === "true" || data.clearCardBackgroundImage === true;
      }
      if (data.cardColor === "") {
        data.cardColor = null;
      }

      const validation = validateCardConfigInput({
        cardColor: data.cardColor,
        cardUseCover: data.cardUseCover,
      });

      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati configurazione card non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      // Salva immagine background card (opzionale)
      let description: string | null | undefined;
      if (data.description !== undefined) {
        const trimmed = typeof data.description === "string" ? data.description.trim() : "";
        if (trimmed.length > 500) {
          return reply.status(400).send({
            success: false,
            error: "La descrizione non può superare 500 caratteri",
            code: "VALIDATION_ERROR",
          });
        }
        description = trimmed || null;
      }

      const hasCardFields = "cardColor" in data
        || data.cardUseCover !== undefined
        || data.clearCardBackgroundImage !== undefined
        || Boolean(cardBgFileBuffer);
      if (!hasCardFields && description !== undefined) {
        await barRepository.updateCardConfig(bar.id, { description });
        return reply.status(200).send({
          success: true,
          message: "Descrizione aggiornata",
          data: { description },
        });
      }

      const clearCardBackgroundImage = data.clearCardBackgroundImage === true;
      let cardBgImageUrl: string | null = clearCardBackgroundImage ? null : bar.card_background_image;

      if (cardBgFileBuffer && cardBgFileName) {
        if (!cardBgFileMimeType || !isImageFile(cardBgFileMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Solo file PNG, JPEG o WebP accettati per la card",
            code: "INVALID_FILE_TYPE",
          });
        }
        if (!isFileSizeValid(cardBgFileBuffer.length)) {
          return reply.status(400).send({
            success: false,
            error: "Immagine card troppo grande (massimo 5MB)",
            code: "FILE_TOO_LARGE",
          });
        }
        try {
          cardBgImageUrl = await saveAndOptimizeImage(cardBgFileBuffer, cardBgFileName);
          console.log(`✅ Card background salvata: ${cardBgImageUrl}`);
        } catch (err) {
          console.error("❌ Errore nel salvataggio del background card:", err);
          return reply.status(500).send({
            success: false,
            error: "Errore nel salvataggio dell'immagine card",
            code: "IMAGE_SAVE_ERROR",
          });
        }
      }

      const cardUseCover = validation.data?.cardUseCover ?? false;
      // Se cardUseCover è true e non c'è un'immagine custom uploadata, usa la cover
      const finalCardBgImage = cardUseCover && !cardBgFileBuffer ? bar.image : cardBgImageUrl;

      await barRepository.updateCardConfig(bar.id, {
        cardBackgroundImage: finalCardBgImage,
        cardColor: validation.data?.cardColor ?? null,
        cardUseCover,
        description,
      });

      return reply.status(200).send({
        success: true,
        message: "Configurazione card aggiornata",
        data: {
          cardBackgroundImage: finalCardBgImage,
          cardColor: validation.data?.cardColor ?? null,
          cardUseCover,
          ...(description !== undefined ? { description } : {}),
        },
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "UPDATE_ERROR" });
    }
  }

  /**
   * Handler per recuperare i dati del bar dell'utente
   */
  async getBarByUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, message: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      return reply.status(200).send({
        success: true,
        data: this.serializeBar(bar),
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "RETRIEVAL_ERROR" });
    }
  }

  async listOwnedBars(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bars = await barRepository.findAllByUserId(userId);

      return reply.status(200).send({
        success: true,
        data: bars.map((bar) => this.serializeBar(bar)),
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "RETRIEVAL_ERROR" });
    }
  }

  async getDashboardStats(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const dashboardStats = await barRepository.getDashboardStats(bar.id);

      return reply.status(200).send({
        success: true,
        data: dashboardStats,
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "DASHBOARD_STATS_ERROR" });
    }
  }

  /**
   * Handler per aggiornare il profilo del bar (campi modificabili)
   * Non permette la modifica di businessName (merchant_name) e piva (iva)
   */
  async updateProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      // Parse multipart or JSON
      const data: any = {};
      let coverFileBuffer: Buffer | null = null;
      let coverFileMimeType: string | null = null;
      let coverFileName: string | null = null;
      let logoFileBuffer: Buffer | null = null;
      let logoFileMimeType: string | null = null;
      let logoFileName: string | null = null;

      const contentType = request.headers["content-type"] || "";
      if (contentType.includes("multipart/form-data")) {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === "field") {
            data[part.fieldname] = (part.value as string).trim();
          } else if (part.type === "file" && part.fieldname === "coverImage") {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            coverFileBuffer = Buffer.concat(chunks);
            coverFileMimeType = part.mimetype;
            coverFileName = part.filename;
          } else if (part.type === "file" && part.fieldname === "logo") {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            logoFileBuffer = Buffer.concat(chunks);
            logoFileMimeType = part.mimetype;
            logoFileName = part.filename;
          }
        }
      } else {
        Object.assign(data, request.body as object);
      }

      const validation = validateBarUpdateInput(data);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data!;
      const updates: any = {};

      if (input.barName) updates.name = input.barName;
      if (input.address) updates.address = input.address;
      if (input.contactEmail !== undefined) updates.contact_email = input.contactEmail;
      if (input.phone !== undefined) updates.phone = input.phone;
      if (input.instagram !== undefined) updates.instagram = input.instagram;
      if (input.facebook !== undefined) updates.facebook = input.facebook;
      if (input.tiktok !== undefined) updates.tiktok = input.tiktok;
      if (input.website !== undefined) updates.website = input.website;

      // Upload new cover image if provided
      if (coverFileBuffer && coverFileName) {
        if (!coverFileMimeType || !isImageFile(coverFileMimeType)) {
          return reply.status(400).send({ success: false, error: "Solo file PNG, JPEG o WebP accettati", code: "INVALID_FILE_TYPE" });
        }
        if (!isFileSizeValid(coverFileBuffer.length)) {
          return reply.status(400).send({ success: false, error: "File troppo grande (massimo 5MB)", code: "FILE_TOO_LARGE" });
        }
        try {
          updates.image = await saveAndOptimizeImage(coverFileBuffer, coverFileName);
        } catch (err) {
          console.error("❌ Errore upload cover:", err);
          return reply.status(500).send({ success: false, error: "Errore nel caricamento della foto", code: "IMAGE_SAVE_ERROR" });
        }
      }

      // Upload new logo if provided
      if (logoFileBuffer && logoFileName) {
        if (!logoFileMimeType || !isImageFile(logoFileMimeType)) {
          return reply.status(400).send({ success: false, error: "Solo file PNG, JPEG o WebP accettati", code: "INVALID_FILE_TYPE" });
        }
        if (!isFileSizeValid(logoFileBuffer.length)) {
          return reply.status(400).send({ success: false, error: "File troppo grande (massimo 5MB)", code: "FILE_TOO_LARGE" });
        }
        try {
          updates.logo = await saveAndOptimizeImage(logoFileBuffer, logoFileName, "fidelty/logos");
        } catch (err) {
          console.error("❌ Errore upload logo:", err);
          return reply.status(500).send({ success: false, error: "Errore nel caricamento del logo", code: "IMAGE_SAVE_ERROR" });
        }
      }

      // Re-geocode if address changed
      if (input.address && input.address !== bar.address) {
        const coords = await this.geocodeAddress(input.address);
        if (coords) {
          updates.latitude = coords.latitude;
          updates.longitude = coords.longitude;
        }
      }

      await barRepository.updateBar(bar.id, updates);

      // Return updated bar data
      const updatedBar = await barRepository.findById(bar.id);
      return reply.status(200).send({
        success: true,
        message: "Profilo bar aggiornato",
        data: this.serializeBar(updatedBar),
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "UPDATE_ERROR" });
    }
  }

  /**
   * Handler per eliminare il bar dell'utente autenticato.
   * L'eliminazione rimuove l'accesso alle funzionalita' esclusive per bar owner.
   */
  async deleteProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (await isBarSelectionMissing(request)) {
        return reply.status(400).send({ success: false, error: "Specifica il bar con l'header X-Bar-Id", code: "BAR_ID_REQUIRED" });
      }

      const bar = await resolveOwnedBarForRequest(request);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const deleted = await barRepository.deleteBar(bar.id);
      if (!deleted) {
        return reply.status(500).send({ success: false, error: "Impossibile eliminare il bar", code: "DELETE_ERROR" });
      }

      return reply.status(200).send({
        success: true,
        message: "Iscrizione bar eliminata con successo",
      });
    } catch (error) {
      console.error("❌ Errore barController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "DELETE_ERROR" });
    }
  }

  /**
   * Lista tutti i bar
   */
  async listBars(request: FastifyRequest, reply: FastifyReply) {
    try {
      const bars = await barRepository.getAllBars();

      // Le coordinate vengono calcolate all'approvazione (o dal backfill all'avvio), mai a ogni richiesta
      const pointsPerEuro = (await platformConfigRepository.get()).pointsPerEuro;
      const enrichedBars = bars.map((bar) => {
        const hasCoordinates =
          bar.latitude !== null &&
          bar.longitude !== null &&
          Number.isFinite(Number(bar.latitude)) &&
          Number.isFinite(Number(bar.longitude));

        return {
          ...bar,
          pointsPerEuro,
          latitude: hasCoordinates ? Number(bar.latitude) : null,
          longitude: hasCoordinates ? Number(bar.longitude) : null,
        };
      });

      return reply.status(200).send({ success: true, data: enrichedBars });
    } catch (error) {
      console.error("❌ Errore recupero bar:", error);
      return reply.status(500).send({ success: false, error: "Errore nel recupero dei bar" });
    }
  }

  async getRanking(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      const { barId } = request.params as { barId?: string };

      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      if (!barId) {
        return reply.status(400).send({ success: false, error: "barId obbligatorio", code: "MISSING_BAR_ID" });
      }

      const bar = await barRepository.findById(barId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const ranking = await barRepository.getBarRanking(barId, userId);
      return reply.status(200).send({ success: true, data: ranking });
    } catch (error) {
      console.error("❌ Errore durante il recupero della classifica bar:", error);
      return reply.status(500).send({ success: false, error: "Errore durante il recupero della classifica bar", code: "BAR_RANKING_ERROR" });
    }
  }
}

export const barController = new BarController();
