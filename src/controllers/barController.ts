import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
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

  /**
   * Handler per la registrazione di un nuovo bar (Step 1 onboarding)
   */
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di registrazione bar");

      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      // Recupera i dati dal multipart form
      const data: any = {};
      let coverFileBuffer: Buffer | null = null;
      let coverFileMimeType: string | null = null;
      let coverFileName: string | null = null;
      let logoFileBuffer: Buffer | null = null;
      let logoFileMimeType: string | null = null;
      let logoFileName: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          // Trim every string value at ingestion to prevent leading/trailing
          // whitespace from breaking validators like .email() or .regex()
          data[part.fieldname] = (part.value as string).trim();
        } else if (part.type === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          const buf = Buffer.concat(chunks);

          if (part.fieldname === "coverImage") {
            coverFileBuffer = buf;
            coverFileMimeType = part.mimetype;
            coverFileName = part.filename;
            console.log(`📁 Cover ricevuta: ${coverFileName} (${coverFileMimeType}, ${buf.length} bytes)`);
          } else if (part.fieldname === "logo") {
            logoFileBuffer = buf;
            logoFileMimeType = part.mimetype;
            logoFileName = part.filename;
            console.log(`📁 Logo ricevuto: ${logoFileName} (${logoFileMimeType}, ${buf.length} bytes)`);
          }
        }
      }

      // Validazione cover obbligatoria
      if (!coverFileBuffer || !coverFileName) {
        return reply.status(400).send({
          success: false,
          error: "Foto di copertina obbligatoria",
          code: "MISSING_FILE",
        });
      }

      if (!coverFileMimeType || !isImageFile(coverFileMimeType)) {
        return reply.status(400).send({
          success: false,
          error: "Solo file PNG, JPEG o WebP sono accettati",
          code: "INVALID_FILE_TYPE",
        });
      }

      if (!isFileSizeValid(coverFileBuffer.length)) {
        return reply.status(400).send({
          success: false,
          error: "File troppo grande (massimo 5MB)",
          code: "FILE_TOO_LARGE",
        });
      }

      // Validazione logo (opzionale)
      if (logoFileBuffer && logoFileName) {
        if (!logoFileMimeType || !isImageFile(logoFileMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Logo: solo file PNG, JPEG o WebP sono accettati",
            code: "INVALID_LOGO_FILE_TYPE",
          });
        }
        if (!isFileSizeValid(logoFileBuffer.length)) {
          return reply.status(400).send({
            success: false,
            error: "Logo troppo grande (massimo 5MB)",
            code: "LOGO_TOO_LARGE",
          });
        }
      }

      // Validazione input con Zod
      const validation = validateBarRegistrationInput(data);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as BarRegistrationInput;

      // Verifica se la P.IVA è già registrata
      const existingBar = await barRepository.findByPiva(input.piva);
      if (existingBar) {
        return reply.status(409).send({
          success: false,
          error: "Partita IVA già registrata",
          code: "PIVA_EXISTS",
        });
      }

      // Verifica se l'utente ha già un bar registrato
      const userBar = await barRepository.findByUserId(userId);
      if (userBar) {
        return reply.status(409).send({
          success: false,
          error: "Utente ha già un bar registrato",
          code: "BAR_ALREADY_EXISTS",
        });
      }

      // Salva immagine di copertina
      let imageUrl: string | null = null;
      try {
        imageUrl = await saveAndOptimizeImage(coverFileBuffer, coverFileName);
        console.log(`✅ Cover salvata: ${imageUrl}`);
      } catch (error) {
        console.error("❌ Errore nel salvataggio della cover:", error);
        return reply.status(500).send({
          success: false,
          error: "Errore nel salvataggio della foto",
          code: "IMAGE_SAVE_ERROR",
        });
      }

      // Salva logo (opzionale)
      let logoUrl: string | null = null;
      if (logoFileBuffer && logoFileName) {
        try {
          logoUrl = await saveAndOptimizeImage(logoFileBuffer, logoFileName);
          console.log(`✅ Logo salvato: ${logoUrl}`);
        } catch (error) {
          console.warn("⚠️ Errore nel salvataggio del logo (non bloccante):", error);
        }
      }

      // Geocoding
      let latitude: number | null = null;
      let longitude: number | null = null;
      try {
        const apiKey = process.env.GOOGLE_GEOCODE_API_KEY;
        if (apiKey) {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            input.address
          )}&key=${apiKey}`;
          const geoResp = await fetch(geocodeUrl);
          const geoJson = (await geoResp.json()) as GoogleGeocodeResponse;
          if (geoJson.status === "OK" && geoJson.results && geoJson.results[0]) {
            const loc = geoJson.results[0].geometry.location;
            latitude = Number(loc.lat);
            longitude = Number(loc.lng);
            console.log(`📍 Geocoding OK: ${latitude}, ${longitude}`);
          } else {
            console.log("⚠️ Geocoding non disponibile o fallito:", geoJson.status);
          }
        }
      } catch (err) {
        console.warn("⚠️ Errore durante la geocodifica:", err);
      }

      // Fallback coordinate da FE
      if (latitude === null || longitude === null) {
        const feLat = Number(data.latitude);
        const feLng = Number(data.longitude);
        if (Number.isFinite(feLat) && Number.isFinite(feLng)) {
          latitude = feLat;
          longitude = feLng;
          console.log(`📍 Coordinate ricevute dal FE: ${latitude}, ${longitude}`);
        }
      }

      // Salva il bar nel database
      const barId = await barRepository.createBar({
        userId,
        piva: input.piva,
        merchantName: input.businessName,
        name: input.barName,
        address: input.address,
        image: imageUrl,
        logo: logoUrl,
        contactEmail: input.contactEmail ?? null,
        phone: input.phone ?? null,
        instagram: input.instagram ?? null,
        facebook: input.facebook ?? null,
        tiktok: input.tiktok ?? null,
        website: input.website ?? null,
        latitude,
        longitude,
      });

      console.log(`✅ Bar registrato con successo: ${input.barName} (ID: ${barId})`);

      return reply.status(200).send({
        success: true,
        message: "Bar registrato con successo",
        data: {
          id: barId,
          userId,
          piva: input.piva,
          barName: input.barName,
          businessName: input.businessName,
          address: input.address,
          coverImage: imageUrl,
          logo: logoUrl,
          contactEmail: input.contactEmail ?? null,
          phone: input.phone ?? null,
          instagram: input.instagram ?? null,
          facebook: input.facebook ?? null,
          tiktok: input.tiktok ?? null,
          website: input.website ?? null,
          latitude,
          longitude,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la registrazione del bar:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "REGISTRATION_ERROR",
      });
    }
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

      const bar = await barRepository.findByUserId(userId);
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
      let cardBgImageUrl: string | null = bar.card_background_image;

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
      });

      return reply.status(200).send({
        success: true,
        message: "Configurazione card aggiornata",
        data: {
          cardBackgroundImage: finalCardBgImage,
          cardColor: validation.data?.cardColor ?? null,
          cardUseCover,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "UPDATE_ERROR" });
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

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, message: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      return reply.status(200).send({
        success: true,
        data: {
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
          cardBackgroundImage: bar.card_background_image,
          cardColor: bar.card_color,
          cardUseCover: bar.card_use_cover,
          createdAt: bar.created_at,
          updatedAt: bar.updated_at,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "RETRIEVAL_ERROR" });
    }
  }

  async getDashboardStats(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({ success: false, error: "Bar non trovato", code: "BAR_NOT_FOUND" });
      }

      const dashboardStats = await barRepository.getDashboardStats(bar.id);

      return reply.status(200).send({
        success: true,
        data: dashboardStats,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "DASHBOARD_STATS_ERROR" });
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

      const bar = await barRepository.findByUserId(userId);
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
      const updatedBar = await barRepository.findByUserId(userId);
      return reply.status(200).send({
        success: true,
        message: "Profilo bar aggiornato",
        data: {
          id: updatedBar!.id,
          piva: updatedBar!.iva,
          barName: updatedBar!.name,
          businessName: updatedBar!.merchant_name,
          address: updatedBar!.address,
          coverImage: updatedBar!.image,
          logo: updatedBar!.logo,
          contactEmail: updatedBar!.contact_email,
          phone: updatedBar!.phone,
          instagram: updatedBar!.instagram,
          facebook: updatedBar!.facebook,
          tiktok: updatedBar!.tiktok,
          website: updatedBar!.website,
          cardBackgroundImage: updatedBar!.card_background_image,
          cardColor: updatedBar!.card_color,
          cardUseCover: updatedBar!.card_use_cover,
          createdAt: updatedBar!.created_at,
          updatedAt: updatedBar!.updated_at,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "UPDATE_ERROR" });
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

      const bar = await barRepository.findByUserId(userId);
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
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "DELETE_ERROR" });
    }
  }

  /**
   * Lista tutti i bar
   */
  async listBars(request: FastifyRequest, reply: FastifyReply) {
    try {
      const bars = await barRepository.getAllBars();

      const enrichedBars = await Promise.all(
        bars.map(async (bar) => {
          const hasCoordinates =
            bar.latitude !== null &&
            bar.longitude !== null &&
            Number.isFinite(Number(bar.latitude)) &&
            Number.isFinite(Number(bar.longitude));

          if (hasCoordinates) {
            return {
              ...bar,
              latitude: Number(bar.latitude),
              longitude: Number(bar.longitude),
            };
          }

          const geocoded = await this.geocodeAddress(bar.address);
          return {
            ...bar,
            latitude: geocoded?.latitude ?? null,
            longitude: geocoded?.longitude ?? null,
          };
        })
      );

      return reply.status(200).send({ success: true, data: enrichedBars });
    } catch (error) {
      return reply.status(500).send({ success: false, error: "Errore nel recupero dei bar" });
    }
  }

  /**
   * Handler per la registrazione completa e atomica del bar.
   * Raccoglie dati di tutti gli step (bar info, card config, offerte, orari)
   * e li salva in un'unica transazione. Nessun dato parziale viene salvato.
   */
  async completeRegistration(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di registrazione completa bar");

      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      // Parse multipart form
      const data: any = {};
      const files: Record<string, { buffer: Buffer; mimetype: string; filename: string }> = {};

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          data[part.fieldname] = (part.value as string).trim();
        } else if (part.type === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          files[part.fieldname] = {
            buffer: Buffer.concat(chunks),
            mimetype: part.mimetype,
            filename: part.filename,
          };
        }
      }

      // --- Validazione cover ---
      const coverFile = files["coverImage"];
      if (!coverFile) {
        return reply.status(400).send({ success: false, error: "Foto di copertina obbligatoria", code: "MISSING_FILE" });
      }
      if (!isImageFile(coverFile.mimetype)) {
        return reply.status(400).send({ success: false, error: "Solo file PNG, JPEG o WebP sono accettati", code: "INVALID_FILE_TYPE" });
      }
      if (!isFileSizeValid(coverFile.buffer.length)) {
        return reply.status(400).send({ success: false, error: "File troppo grande (massimo 5MB)", code: "FILE_TOO_LARGE" });
      }

      // --- Validazione logo (opzionale) ---
      const logoFile = files["logo"];
      if (logoFile) {
        if (!isImageFile(logoFile.mimetype)) {
          return reply.status(400).send({ success: false, error: "Logo: solo file PNG, JPEG o WebP sono accettati", code: "INVALID_LOGO_FILE_TYPE" });
        }
        if (!isFileSizeValid(logoFile.buffer.length)) {
          return reply.status(400).send({ success: false, error: "Logo troppo grande (massimo 5MB)", code: "LOGO_TOO_LARGE" });
        }
      }

      // --- Validazione card bg (opzionale) ---
      const cardBgFile = files["cardBackgroundImage"];
      if (cardBgFile) {
        if (!isImageFile(cardBgFile.mimetype)) {
          return reply.status(400).send({ success: false, error: "Immagine card: solo PNG, JPEG o WebP", code: "INVALID_FILE_TYPE" });
        }
        if (!isFileSizeValid(cardBgFile.buffer.length)) {
          return reply.status(400).send({ success: false, error: "Immagine card troppo grande (massimo 5MB)", code: "FILE_TOO_LARGE" });
        }
      }

      // --- Validazione input bar ---
      const barValidation = validateBarRegistrationInput(data);
      if (!barValidation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: barValidation.errors,
        });
      }
      const barInput = barValidation.data as BarRegistrationInput;

      // --- Validazione offerte (opzionale, JSON string) ---
      let parsedOffers: Array<{
        title: string;
        description?: string | null;
        conditions?: string | null;
        pointsRequired: number;
        isActive?: boolean;
      }> = [];
      if (data.offers) {
        try {
          const raw = JSON.parse(data.offers);
          if (Array.isArray(raw)) {
            for (const offer of raw) {
              const ov = validateCreateOfferInput(offer);
              if (!ov.success) {
                return reply.status(400).send({
                  success: false,
                  error: "Dati offerta non validi",
                  code: "VALIDATION_ERROR",
                  details: ov.errors,
                });
              }
              parsedOffers.push(ov.data!);
            }
          }
        } catch {
          return reply.status(400).send({ success: false, error: "Formato offerte non valido (JSON atteso)", code: "VALIDATION_ERROR" });
        }
      }

      // --- Validazione orari (opzionale, JSON string) ---
      let parsedHours: any = null;
      if (data.openingHours) {
        try {
          const raw = JSON.parse(data.openingHours);
          const hv = validateSetOpeningHoursInput({ hours: raw });
          if (!hv.success) {
            return reply.status(400).send({
              success: false,
              error: "Dati orari non validi",
              code: "VALIDATION_ERROR",
              details: hv.errors,
            });
          }
          parsedHours = hv.data!.hours;
        } catch {
          return reply.status(400).send({ success: false, error: "Formato orari non valido (JSON atteso)", code: "VALIDATION_ERROR" });
        }
      }

      // --- Validazione card config ---
      const cardColor = data.cardColor || null;
      const cardUseCover = data.cardUseCover === "true" || data.cardUseCover === true;
      if (cardColor) {
        const cv = validateCardConfigInput({ cardColor, cardUseCover });
        if (!cv.success) {
          return reply.status(400).send({
            success: false,
            error: "Dati configurazione card non validi",
            code: "VALIDATION_ERROR",
            details: cv.errors,
          });
        }
      }

      // --- Verifica unicità PIVA e utente ---
      const existingBar = await barRepository.findByPiva(barInput.piva);
      if (existingBar) {
        return reply.status(409).send({ success: false, error: "Partita IVA già registrata", code: "PIVA_EXISTS" });
      }
      const userBar = await barRepository.findByUserId(userId);
      if (userBar) {
        return reply.status(409).send({ success: false, error: "Utente ha già un bar registrato", code: "BAR_ALREADY_EXISTS" });
      }

      // --- Upload immagini su Cloudinary ---
      let coverUrl: string;
      try {
        coverUrl = await saveAndOptimizeImage(coverFile.buffer, coverFile.filename);
      } catch (error) {
        console.error("❌ Errore upload cover:", error);
        return reply.status(500).send({ success: false, error: "Errore nel caricamento della foto di copertina", code: "IMAGE_UPLOAD_ERROR" });
      }

      let logoUrl: string | null = null;
      if (logoFile) {
        try {
          logoUrl = await saveAndOptimizeImage(logoFile.buffer, logoFile.filename, "fidelty/logos");
        } catch (error) {
          console.warn("⚠️ Errore upload logo:", error);
        }
      }

      let cardBgUrl: string | null = null;
      if (cardBgFile) {
        try {
          cardBgUrl = await saveAndOptimizeImage(cardBgFile.buffer, cardBgFile.filename, "fidelty/cards");
        } catch (error) {
          console.warn("⚠️ Errore upload card bg:", error);
        }
      }

      // --- Geocoding ---
      let latitude: number | null = null;
      let longitude: number | null = null;
      try {
        const coords = await this.geocodeAddress(barInput.address);
        if (coords) {
          latitude = coords.latitude;
          longitude = coords.longitude;
        }
      } catch { }

      // Fallback coordinate da FE
      if (latitude === null || longitude === null) {
        const feLat = Number(data.latitude);
        const feLng = Number(data.longitude);
        if (Number.isFinite(feLat) && Number.isFinite(feLng)) {
          latitude = feLat;
          longitude = feLng;
        }
      }

      // --- Salva TUTTO in una sola transazione ---
      const finalCardBgImage = cardUseCover && !cardBgFile ? coverUrl : cardBgUrl;

      const barId = await barRepository.createBarComplete({
        userId,
        piva: barInput.piva,
        merchantName: barInput.businessName,
        name: barInput.barName,
        address: barInput.address,
        image: coverUrl,
        logo: logoUrl,
        contactEmail: barInput.contactEmail ?? null,
        phone: barInput.phone ?? null,
        instagram: barInput.instagram ?? null,
        facebook: barInput.facebook ?? null,
        tiktok: barInput.tiktok ?? null,
        website: barInput.website ?? null,
        latitude,
        longitude,
        cardColor: cardColor,
        cardBackgroundImage: finalCardBgImage,
        cardUseCover,
        offers: parsedOffers,
        openingHours: parsedHours,
      });

      console.log(`✅ Bar registrato completamente: ${barInput.barName} (ID: ${barId})`);

      return reply.status(200).send({
        success: true,
        message: "Bar registrato con successo",
        data: {
          id: barId,
          userId,
          piva: barInput.piva,
          barName: barInput.barName,
          businessName: barInput.businessName,
          address: barInput.address,
          coverImage: coverUrl,
          logo: logoUrl,
          contactEmail: barInput.contactEmail ?? null,
          phone: barInput.phone ?? null,
          latitude,
          longitude,
          cardColor,
          cardBackgroundImage: finalCardBgImage,
          cardUseCover,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la registrazione completa del bar:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "REGISTRATION_ERROR" });
    }
  }
}

export const barController = new BarController();
