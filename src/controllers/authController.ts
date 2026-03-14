import { FastifyRequest, FastifyReply } from "fastify";
import { getAuthService } from "../services/authService.js";
import { userRepository } from "../repositories/userRepository.js";
import { saveAndOptimizeImage, isImageFile, isFileSizeValid } from "../utils/imageUpload.js";
import {
  validateRegisterInput,
  validateLoginInput,
  validateRefreshInput,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
} from "../validators/authValidator.js";

/**
 * Auth Controller
 * Gestisce la logica di registrazione, login e operazioni correlate
 */
export class AuthController {
  /**
   * Handler per la registrazione utente
   */
  async register(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("👤 Ricevuta richiesta di registrazione utente");

      const body = request.body as unknown;

      // Validazione input con Zod
      const validation = validateRegisterInput(body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as RegisterInput;

      // Verifica se l'email è già registrata
      const existingUser = await userRepository.findByEmail(input.email);
      if (existingUser) {
        return reply.status(409).send({
          success: false,
          error: "Email già registrata",
          code: "EMAIL_EXISTS",
        });
      }

      // Hash della password usando argon2
      const authService = getAuthService();
      const hashedPassword = await authService.hashPassword(input.password);

      // Salva l'utente nel database
      const userId = await userRepository.createUser({
        name: input.name,
        email: input.email,
        password: hashedPassword,
      });

      console.log(`✅ Utente registrato con successo: ${input.email}`);

      return reply.status(201).send({
        success: true,
        message: "Utente registrato con successo",
        data: {
          id: userId,
          email: input.email,
          name: input.name,
          publicId: (await userRepository.findById(userId))?.public_id ?? null,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la registrazione:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "REGISTRATION_ERROR",
      });
    }
  }

  /**
   * Handler per il login utente
   */
  async login(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🔑 Ricevuta richiesta di login");

      const body = request.body as unknown;

      // Validazione input con Zod
      const validation = validateLoginInput(body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as LoginInput;

      // Recupera l'utente dal database
      const user = await userRepository.findByEmail(input.email);
      if (!user) {
        console.log(`⚠️  Tentativo di login con email inesistente: ${input.email}`);
        return reply.status(401).send({
          success: false,
          error: "Credenziali non valide",
          code: "INVALID_CREDENTIALS",
        });
      }

      // Verifica la password con argon2
      const authService = getAuthService();
      const isPasswordValid = await authService.verifyPassword(
        input.password,
        user.password,
      );

      if (!isPasswordValid) {
        console.log(`⚠️  Tentativo di login con password errata: ${input.email}`);
        return reply.status(401).send({
          success: false,
          error: "Credenziali non valide",
          code: "INVALID_CREDENTIALS",
        });
      }

      // Genera il JWT access token (breve durata)
      const accessToken = authService.generateToken(user.id, user.email, "15m");

      // Genera il refresh token (lunga durata)
      const refreshToken = authService.generateRefreshToken(user.id, user.email);

      // Salva il refresh token nel database
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 giorni
      await userRepository.saveRefreshToken(user.id, refreshToken, expiresAt);

      console.log(`✅ Login riuscito per: ${input.email}`);

      return reply.status(200).send({
        success: true,
        message: "Login avvenuto con successo",
        data: {
          id: user.id,
          email: user.email,
          name: user.name,
          publicId: user.public_id,
          accessToken,
          refreshToken,
          expiresIn: 900, // 15 minuti in secondi
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il login:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "LOGIN_ERROR",
      });
    }
  }

  /**
   * Handler per il refresh token - ottiene nuovo access token
   */
  async refreshToken(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🔄 Ricevuta richiesta di refresh token");

      const body = request.body as unknown;

      // Validazione input con Zod
      const validation = validateRefreshInput(body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Refresh token mancante o non valido",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as RefreshInput;
      const authService = getAuthService();

      // Verifica il refresh token (firma e scadenza)
      const decoded = authService.verifyRefreshToken(input.refreshToken);
      if (!decoded) {
        console.log("⚠️  Refresh token non valido o scaduto");
        return reply.status(401).send({
          success: false,
          error: "Refresh token non valido o scaduto",
          code: "INVALID_REFRESH_TOKEN",
        });
      }

      // Verifica che il refresh token sia nel database e non revocato
      const storedToken = await userRepository.findRefreshToken(input.refreshToken);
      if (!storedToken || storedToken.revoked) {
        console.log(`⚠️  Refresh token revocato o non trovato per utente: ${decoded.userId}`);
        return reply.status(401).send({
          success: false,
          error: "Refresh token revocato o non trovato",
          code: "REVOKED_REFRESH_TOKEN",
        });
      }

      // Recupera l'utente dal database
      const user = await userRepository.findById(decoded.userId);
      if (!user) {
        console.log(`⚠️  Utente non trovato per refresh token`);
        return reply.status(404).send({
          success: false,
          error: "Utente non trovato",
          code: "USER_NOT_FOUND",
        });
      }

      // Genera nuovo access token
      const newAccessToken = authService.generateToken(user.id, user.email, "15m");

      console.log(`✅ Refresh token accettato per: ${user.email}`);

      return reply.status(200).send({
        success: true,
        message: "Token rinnovato con successo",
        data: {
          accessToken: newAccessToken,
          expiresIn: 900, // 15 minuti in secondi
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il refresh token:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "REFRESH_TOKEN_ERROR",
      });
    }
  }

  /**
   * Handler per il logout (revoca refresh token)
   */
  async logout(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🚪 Ricevuta richiesta di logout");

      const body = request.body as unknown;
      const userId = (request as any).userId;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Utente non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      // Verifica se è stato passato un refresh token da revocare
      const refreshTokenData = body as any;
      if (refreshTokenData?.refreshToken) {
        // Revoca il refresh token dal database
        await userRepository.revokeRefreshToken(refreshTokenData.refreshToken);
        console.log(`✅ Refresh token revocato per utente: ${userId}`);
      }

      return reply.status(200).send({
        success: true,
        message: "Logout avvenuto con successo",
      });
    } catch (error) {
      console.error("❌ Errore durante il logout:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore durante il logout",
        code: "LOGOUT_ERROR",
      });
    }
  }

  /**
   * Handler per ottenere il profilo dell'utente autenticato
   */
  async getProfile(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          error: "Utente non autenticato",
          code: "UNAUTHORIZED",
        });
      }

      const user = await userRepository.findById(userId);

      if (!user) {
        return reply.status(404).send({
          success: false,
          error: "Utente non trovato",
          code: "USER_NOT_FOUND",
        });
      }

      return reply.status(200).send({
        success: true,
        data: {
          id: user.id,
          publicId: user.public_id,
          email: user.email,
          name: user.name,
          profileImage: user.profile_image ?? null,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il recupero del profilo:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore durante il recupero del profilo",
        code: "PROFILE_ERROR",
      });
    }
  }

  /**
   * Handler per la ricerca utente tramite public_id
   * GET /api/users/search?public_id=FU-XXXXX
   */
  async searchByPublicId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const query = request.query as Record<string, string>;
      const publicId = query.public_id;

      if (!publicId || typeof publicId !== "string") {
        return reply.status(400).send({
          success: false,
          error: "Parametro public_id obbligatorio",
          code: "MISSING_PUBLIC_ID",
        });
      }

      const user = await userRepository.findByPublicId(publicId);

      if (!user) {
        return reply.status(404).send({
          success: false,
          error: "Utente non trovato",
          code: "USER_NOT_FOUND",
        });
      }

      return reply.status(200).send({
        success: true,
        data: {
          id: user.id,
          publicId: user.public_id,
          name: user.name,
          email: user.email,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante la ricerca per public_id:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore durante la ricerca",
        code: "SEARCH_ERROR",
      });
    }
  }
  /**
   * Handler per caricare/aggiornare la foto profilo dell'utente
   */
  async uploadProfilePhoto(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      let fileBuffer: Buffer | null = null;
      let fileMimeType: string | null = null;
      let fileName: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "profileImage") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          fileBuffer = Buffer.concat(chunks);
          fileMimeType = part.mimetype;
          fileName = part.filename;
        }
      }

      if (!fileBuffer || !fileName) {
        return reply.status(400).send({ success: false, error: "Immagine profilo obbligatoria", code: "MISSING_FILE" });
      }

      if (!fileMimeType || !isImageFile(fileMimeType)) {
        return reply.status(400).send({ success: false, error: "Solo file PNG, JPEG o WebP sono accettati", code: "INVALID_FILE_TYPE" });
      }

      if (!isFileSizeValid(fileBuffer.length)) {
        return reply.status(400).send({ success: false, error: "File troppo grande (massimo 5MB)", code: "FILE_TOO_LARGE" });
      }

      const imageUrl = await saveAndOptimizeImage(fileBuffer, fileName, "fidelty/profiles");

      await userRepository.updateUser(userId, { profile_image: imageUrl } as any);

      return reply.status(200).send({
        success: true,
        message: "Foto profilo aggiornata",
        data: { profileImage: imageUrl },
      });
    } catch (error) {
      console.error("❌ Errore upload foto profilo:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({ success: false, error: errorMessage, code: "UPLOAD_ERROR" });
    }
  }
}

// Istanza singleton del controller
export const authController = new AuthController();
