import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import {
  validateBarRegistrationInput,
  validateCardConfigInput,
  type BarRegistrationInput,
} from "../validators/barValidator.js";
import { saveAndOptimizeImage, isPngFile, isFileSizeValid } from "../utils/imageUpload.js";

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
          data[part.fieldname] = part.value as string;
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

      if (!coverFileMimeType || !isPngFile(coverFileMimeType)) {
        return reply.status(400).send({
          success: false,
          error: "Solo file PNG sono accettati",
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
        if (!logoFileMimeType || !isPngFile(logoFileMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Logo: solo file PNG sono accettati",
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
      const existingBar = await barRepository.pivaExists(input.piva);
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
        if (!cardBgFileMimeType || !isPngFile(cardBgFileMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Solo file PNG accettati per la card",
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
}

export const barController = new BarController();
