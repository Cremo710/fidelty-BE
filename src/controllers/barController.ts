import { FastifyRequest, FastifyReply } from "fastify";
import { barRepository } from "../repositories/barRepository.js";
import {
  validateBarRegistrationInput,
  type BarRegistrationInput,
} from "../validators/barValidator.js";
import { saveAndOptimizeImage, isPngFile, isFileSizeValid } from "../utils/imageUpload.js";

/**
 * Bar Controller
 * Gestisce la logica di registrazione e operazioni correlate ai bar
 */
export class BarController {
  /**
   * Handler per la registrazione di un nuovo bar
   */
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di registrazione bar");

      // Estrai userId dal middleware di autenticazione
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
      let fileBuffer: Buffer | null = null;
      let fileMimeType: string | null = null;
      let fileName: string | null = null;

      // Itera sui campi multipart
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          // Campo testo - leggi il valore
          data[part.fieldname] = part.value as string;
        } else if (part.type === "file") {
          // File
          if (part.fieldname === "coverImage") {
            // Leggi il file dallo stream
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            fileBuffer = Buffer.concat(chunks);
            fileMimeType = part.mimetype;
            fileName = part.filename;

            console.log(`📁 File ricevuto: ${fileName} (${fileMimeType}, ${fileBuffer.length} bytes)`);
          }
        }
      }

      // Validazione file
      if (!fileBuffer || !fileName) {
        return reply.status(400).send({
          success: false,
          error: "Foto di copertina obbligatoria",
          code: "MISSING_FILE",
        });
      }

      if (!fileMimeType || !isPngFile(fileMimeType)) {
        return reply.status(400).send({
          success: false,
          error: "Solo file PNG sono accettati",
          code: "INVALID_FILE_TYPE",
        });
      }

      if (!isFileSizeValid(fileBuffer.length)) {
        return reply.status(400).send({
          success: false,
          error: "File troppo grande (massimo 5MB)",
          code: "FILE_TOO_LARGE",
        });
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

      // Salva e ottimizza l'immagine
      let imageUrl: string | null = null;
      try {
        imageUrl = await saveAndOptimizeImage(fileBuffer, fileName);
        console.log(`✅ Immagine salvata: ${imageUrl}`);
      } catch (error) {
        console.error("❌ Errore nel salvataggio dell'immagine:", error);
        return reply.status(500).send({
          success: false,
          error: "Errore nel salvataggio della foto",
          code: "IMAGE_SAVE_ERROR",
        });
      }

      // Prova a geocodificare l'indirizzo se è disponibile una API key
      let latitude: number | null = null;
      let longitude: number | null = null;
      try {
        const apiKey = process.env.GOOGLE_GEOCODE_API_KEY;
        if (apiKey) {
          const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
            input.address
          )}&key=${apiKey}`;
          const geoResp = await fetch(geocodeUrl);
          const geoJson = await geoResp.json();
          if (geoJson.status === 'OK' && geoJson.results && geoJson.results[0]) {
            const loc = geoJson.results[0].geometry.location;
            latitude = Number(loc.lat);
            longitude = Number(loc.lng);
            console.log(`📍 Geocoding OK: ${latitude}, ${longitude}`);
          } else {
            console.log('⚠️ Geocoding non disponibile o fallito:', geoJson.status);
          }
        }
      } catch (err) {
        console.warn('⚠️ Errore durante la geocodifica:', err);
      }

      // Salva il bar nel database (includendo lat/lng se presenti)
      const barId = await barRepository.createBar({
        userId,
        piva: input.piva,
        merchantName: input.businessName,
        name: input.barName,
        address: input.address,
        image: imageUrl,
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
   * Handler per recuperare i dati del bar dell'utente
   */
  async getBarByUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🏪 Ricevuta richiesta di recupero bar per utente");

      // Estrai userId dal middleware di autenticazione
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      // Recupera il bar dell'utente
      const bar = await barRepository.findByUserId(userId);
      if (!bar) {
        return reply.status(404).send({
          success: false,
          message: "Bar non trovato",
          code: "BAR_NOT_FOUND",
        });
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
          createdAt: bar.created_at,
          updatedAt: bar.updated_at,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il recupero del bar:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "RETRIEVAL_ERROR",
      });
    }
  }

  /**
   * Lista tutti i bar con coordinate per la mappa
   */
  async listBars(request: FastifyRequest, reply: FastifyReply) {
    try {
      const bars = await barRepository.getAllBars();
      return reply.status(200).send({ success: true, data: bars });
    } catch (error) {
      console.error('❌ Errore durante il recupero lista bar:', error);
      return reply.status(500).send({ success: false, error: 'Errore nel recupero dei bar' });
    }
  }
}

// Singleton instance
export const barController = new BarController();