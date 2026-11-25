import { createHash, randomBytes } from "crypto";
import { FastifyRequest, FastifyReply } from "fastify";
import { getAuthService } from "../services/authService.js";
import { userRepository, EmailExistsError } from "../repositories/userRepository.js";
import { emailService } from "../services/emailService.js";
import { databaseService } from "../services/databaseService.js";
import { saveAndOptimizeImage, isImageFile, isFileSizeValid } from "../utils/imageUpload.js";
import {
  validateEmailRequestInput,
  validateVerifyEmailInput,
  validateResetPasswordConfirmInput,
  validateRegisterInput,
  validateLoginInput,
  validateRefreshInput,
  type EmailRequestInput,
  type VerifyEmailInput,
  type ResetPasswordConfirmInput,
  type RegisterInput,
  type LoginInput,
  type RefreshInput,
} from "../validators/authValidator.js";
import { decideRefresh } from "../utils/refreshTokenPolicy.js";

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // allineato al default "7d" di generateRefreshToken

const DEFAULT_EMAIL_VERIFICATION_TTL_HOURS = 24;
const DEFAULT_PASSWORD_RESET_TTL_MINUTES = 30;

function getEmailVerificationTtlHours() {
  const parsed = Number.parseInt(process.env.EMAIL_VERIFICATION_TTL_HOURS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EMAIL_VERIFICATION_TTL_HOURS;
}

function getPasswordResetTtlMinutes() {
  const parsed = Number.parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PASSWORD_RESET_TTL_MINUTES;
}

function createEmailVerificationToken() {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function createRawToken() {
  return randomBytes(24).toString("hex");
}

function hashRawToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Hash argon2 di una password casuale, calcolato una volta sola e usato per le verifiche fittizie
let dummyPasswordHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = getAuthService().hashPassword(randomBytes(32).toString("hex"));
    dummyPasswordHashPromise.catch(() => { dummyPasswordHashPromise = null; });
  }
  return dummyPasswordHashPromise;
}

/**
 * Emette un'email di verifica per l'utente specificato.
 * Funzione pubblica riutilizzabile da altri controller.
 */
export async function issueEmailVerification(user: { id: string; email: string; name: string | null }) {
  const rawToken = createEmailVerificationToken();
  const ttlHours = getEmailVerificationTtlHours();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await userRepository.storeEmailVerificationToken(user.id, hashRawToken(rawToken), expiresAt);
  return emailService.sendEmailVerificationEmail({
    recipientEmail: user.email,
    recipientName: user.name,
    verificationToken: rawToken,
    expiresInHours: ttlHours,
  });
}

/**
 * Auth Controller
 * Gestisce la logica di registrazione, login e operazioni correlate
 */
export class AuthController {
  private async issueEmailVerification(user: { id: string; email: string; name: string | null }) {
    return issueEmailVerification(user);
  }

  private async issuePasswordReset(user: { id: string; email: string; name: string | null }) {
    const rawToken = createRawToken();
    const ttlMinutes = getPasswordResetTtlMinutes();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await userRepository.storePasswordResetToken(user.id, hashRawToken(rawToken), expiresAt);
    return emailService.sendPasswordResetEmail({
      recipientEmail: user.email,
      recipientName: user.name,
      resetToken: rawToken,
      expiresInMinutes: ttlMinutes,
    });
  }

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

      // Hash sempre calcolato, anche per un'email esistente: tempi di risposta uniformi
      const authService = getAuthService();
      const hashedPassword = await authService.hashPassword(input.password);

      // La risposta è identica per email nuova, esistente non verificata ed esistente verificata,
      // così la registrazione non rivela chi ha già un account.
      const genericCreated = (verificationEmailSent: boolean) => reply.status(201).send({
        success: true,
        message: "Utente registrato. Verifica la tua email per completare l'accesso",
        data: {
          email: input.email,
          name: input.name,
          requiresEmailVerification: true,
          verificationEmailSent,
        },
      });

      const existingUser = await userRepository.findByEmail(input.email);

      if (existingUser?.is_email_verified) {
        // Account già attivo: nessuna modifica. Il titolare riceve un avviso al posto del codice.
        try {
          await emailService.sendPlainTextEmail({
            recipientEmail: existingUser.email,
            subject: "Hai già un account Fidelty",
            text: [
              `Ciao ${existingUser.name || ""},`,
              "",
              "qualcuno (forse tu) ha provato a registrarsi su Fidelty con questa email, ma un account esiste già.",
              "Puoi accedere con la tua password oppure, se non la ricordi, usare \"Password dimenticata\" nell'app.",
              "",
              "Se non sei stato tu, puoi ignorare questa email: il tuo account non è stato modificato.",
            ].join("\n"),
          });
        } catch (noticeError) {
          console.error("❌ Invio avviso 'account già esistente' fallito:", noticeError);
        }
        return genericCreated(true);
      }

      if (existingUser) {
        // Account mai verificato (pre-hijacking): chi conferma il codice ricevuto via email
        // deve attivare la password scelta da lui, non quella di chi ha registrato l'email per primo.
        // Si sostituiscono nome e password e si invia un nuovo codice (i precedenti vengono invalidati).
        await userRepository.updateUser(existingUser.id, { name: input.name, password: hashedPassword });
        await userRepository.revokeAllUserTokens(existingUser.id);
        let dispatch;
        try {
          dispatch = await this.issueEmailVerification({ id: existingUser.id, email: existingUser.email, name: input.name });
        } catch (emailError) {
          console.error("❌ Invio email di verifica fallito (account non verificato):", emailError);
          return reply.status(502).send({
            success: false,
            error: "Impossibile inviare l'email di verifica. Riprova la registrazione.",
            code: "EMAIL_VERIFICATION_SEND_FAILED",
          });
        }
        return genericCreated(dispatch.sent);
      }

      // Salva l'utente nel database
      const userId = await userRepository.createUser({
        name: input.name,
        email: input.email,
        password: hashedPassword,
      });

      let verificationDispatch;
      try {
        verificationDispatch = await this.issueEmailVerification({
          id: userId,
          email: input.email,
          name: input.name,
        });
      } catch (emailError) {
        // Evita utenti orfani non verificabili: se l'invio dell'email fallisce, annulla la registrazione
        console.error("❌ Invio email di verifica fallito, rollback registrazione:", emailError);
        await userRepository.deleteUser(userId).catch((deleteError) => {
          console.error("❌ Errore durante il rollback dell'utente non verificato:", deleteError);
        });

        return reply.status(502).send({
          success: false,
          error: "Impossibile inviare l'email di verifica. Riprova la registrazione.",
          code: "EMAIL_VERIFICATION_SEND_FAILED",
        });
      }

      console.log(`✅ Utente registrato con successo: ${userId}`);

      return genericCreated(verificationDispatch.sent);
    } catch (error) {
      if (error instanceof EmailExistsError) {
        // Registrazione concorrente sulla stessa email: stessa risposta degli altri casi
        return reply.status(201).send({
          success: true,
          message: "Utente registrato. Verifica la tua email per completare l'accesso",
          data: { requiresEmailVerification: true, verificationEmailSent: true },
        });
      }

      console.error("❌ Errore durante la registrazione:", error);

      console.error("❌ Errore authController:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore interno del server",
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
        // Verifica argon2 fittizia: senza, un'email inesistente risponde molto prima di una
        // esistente e i tempi rivelerebbero chi è registrato
        await getAuthService().verifyPassword(input.password, await getDummyPasswordHash());
        console.log("⚠️  Tentativo di login con email inesistente");
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

      if (!user.is_email_verified) {
        return reply.status(403).send({
          success: false,
          error: "Verifica la tua email prima di accedere",
          code: "EMAIL_NOT_VERIFIED",
          data: {
            email: user.email,
          },
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

      console.error("❌ Errore authController:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore interno del server",
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

      // Recupera l'utente prima della transazione (nessuna query sul pool con un client aperto)
      const user = await userRepository.findById(decoded.userId);
      if (!user) {
        console.log(`⚠️  Utente non trovato per refresh token`);
        return reply.status(404).send({
          success: false,
          error: "Utente non trovato",
          code: "USER_NOT_FOUND",
        });
      }

      // Verifica il token nel database (per hash) e, se il client lo chiede, lo ruota.
      // La rotazione è opzionale finché esistono build dell'app che non salvano il nuovo token.
      const client = await databaseService.getPool().connect();
      let newRefreshToken: string | undefined;
      try {
        await client.query("BEGIN");
        const storedToken = await userRepository.findRefreshTokenForUpdate(client, input.refreshToken);
        if (!storedToken || storedToken.user_id !== user.id) {
          await client.query("ROLLBACK");
          console.log(`⚠️  Refresh token non trovato per utente: ${decoded.userId}`);
          return reply.status(401).send({
            success: false,
            error: "Refresh token revocato o non trovato",
            code: "REVOKED_REFRESH_TOKEN",
          });
        }

        const activeInFamily = await client.query(
          "SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked = false LIMIT 1",
          [storedToken.family_id],
        );
        const decision = decideRefresh(storedToken, {
          now: Date.now(),
          familyHasActiveToken: (activeInFamily.rowCount ?? 0) > 0,
        });

        if (decision.action === "reject_and_revoke_family") {
          // Un token già sostituito è stato riusato: chi lo presenta potrebbe averlo rubato
          await client.query("UPDATE refresh_tokens SET revoked = true WHERE family_id = $1", [storedToken.family_id]);
          await client.query("COMMIT");
          console.warn(`🚨 Riuso di refresh token ruotato per utente ${user.id}: sessione revocata`);
          return reply.status(401).send({
            success: false,
            error: "Sessione non più valida. Esegui di nuovo il login.",
            code: decision.code,
          });
        }
        if (decision.action === "reject" || (storedToken.revoked && !input.rotate)) {
          await client.query("ROLLBACK");
          return reply.status(401).send({
            success: false,
            error: "Refresh token revocato o non trovato",
            code: "REVOKED_REFRESH_TOKEN",
          });
        }

        if (input.rotate) {
          if (!storedToken.revoked) {
            await client.query(
              "UPDATE refresh_tokens SET revoked = true, rotated_at = NOW() WHERE id = $1",
              [storedToken.id],
            );
          }
          newRefreshToken = authService.generateRefreshToken(user.id, user.email);
          await userRepository.saveRefreshToken(
            user.id,
            newRefreshToken,
            new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
            { familyId: storedToken.family_id, client },
          );
        }
        await client.query("COMMIT");
      } catch (txError) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw txError;
      } finally {
        client.release();
      }

      // Genera nuovo access token
      const newAccessToken = authService.generateToken(user.id, user.email, "15m");

      console.log(`✅ Refresh token accettato per utente: ${user.id}${newRefreshToken ? " (ruotato)" : ""}`);

      return reply.status(200).send({
        success: true,
        message: "Token rinnovato con successo",
        data: {
          accessToken: newAccessToken,
          expiresIn: 900, // 15 minuti in secondi
          ...(newRefreshToken ? { refreshToken: newRefreshToken } : {}),
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il refresh token:", error);

      console.error("❌ Errore authController:", error);

      return reply.status(500).send({
        success: false,
        error: "Errore interno del server",
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

      // Il logout non richiede un access token valido (può essere già scaduto):
      // basta presentare il refresh token, che viene revocato insieme alla sua famiglia.
      const refreshToken = (request.body as { refreshToken?: unknown } | undefined)?.refreshToken;
      if (typeof refreshToken === "string" && refreshToken) {
        const decoded = getAuthService().verifyRefreshToken(refreshToken);
        if (decoded) {
          await userRepository.revokeRefreshTokenFamily(refreshToken);
          console.log(`✅ Refresh token revocato per utente: ${decoded.userId}`);
        }
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

  async resendEmailVerification(request: FastifyRequest, reply: FastifyReply) {
    try {
      const validation = validateEmailRequestInput(request.body as unknown);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as EmailRequestInput;
      const user = await userRepository.findByEmail(input.email);
      if (user && !user.is_email_verified) {
        await this.issueEmailVerification({ id: user.id, email: user.email, name: user.name });
      }

      return reply.status(200).send({
        success: true,
        message: "Se l'account esiste e non è verificato, abbiamo inviato una nuova email di verifica",
      });
    } catch (error) {
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "EMAIL_VERIFICATION_RESEND_ERROR" });
    }
  }

  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const validation = validateVerifyEmailInput(request.body as unknown);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as VerifyEmailInput;
      const invalidCode = () => reply.status(400).send({
        success: false,
        error: "Codice di verifica non valido o scaduto",
        code: "INVALID_EMAIL_VERIFICATION_TOKEN",
      });

      const user = await userRepository.findByEmail(input.email);
      if (!user) {
        return invalidCode();
      }

      const userId = await userRepository.consumeEmailVerificationToken(user.id, hashRawToken(input.token));
      if (!userId) {
        await userRepository.recordFailedEmailVerificationAttempt(user.id);
        return invalidCode();
      }

      await userRepository.updateUser(userId, {
        is_email_verified: true,
        email_verified_at: new Date(),
      });
      await userRepository.invalidateEmailVerificationTokens(userId);

      return reply.status(200).send({
        success: true,
        message: "Email verificata con successo",
      });
    } catch (error) {
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "EMAIL_VERIFICATION_ERROR" });
    }
  }

  async requestPasswordReset(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🔐 Ricevuta richiesta reset password");
      const validation = validateEmailRequestInput(request.body as unknown);
      if (!validation.success) {
        console.warn("⚠️ Validazione reset password fallita", validation.errors);
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as EmailRequestInput;
      const user = await userRepository.findByEmail(input.email);
      // La risposta è sempre la stessa, che l'account esista o no e anche se l'invio fallisce:
      // un 503 o un flag diverso solo per gli account esistenti rivelerebbe chi è registrato.
      // I problemi d'invio restano visibili nei log. L'invio non viene atteso, così anche i tempi
      // di risposta sono uguali nei due casi.
      if (user) {
        void this.issuePasswordReset({ id: user.id, email: user.email, name: user.name })
          .then((dispatchResult) => {
            if (!dispatchResult.sent) {
              console.warn(`⚠️ Invio email reset non disponibile per utente ${user.id}: ${dispatchResult.skippedReason || "unknown"}`);
            } else {
              console.log(`📧 Invio reset password completato per utente ${user.id}`);
            }
          })
          .catch((dispatchError) => {
            console.error(`❌ Invio email reset fallito per utente ${user.id}:`, dispatchError);
          });
      }

      return reply.status(200).send({
        success: true,
        message: "Se l'account esiste, abbiamo inviato un codice per reimpostare la password",
      });
    } catch (error) {
      console.error("❌ requestPasswordReset failed:", error);
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "PASSWORD_RESET_REQUEST_ERROR" });
    }
  }

  async confirmPasswordReset(request: FastifyRequest, reply: FastifyReply) {
    try {
      const validation = validateResetPasswordConfirmInput(request.body as unknown);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: "Dati di input non validi",
          code: "VALIDATION_ERROR",
          details: validation.errors,
        });
      }

      const input = validation.data as ResetPasswordConfirmInput;
      const userId = await userRepository.consumePasswordResetToken(hashRawToken(input.token));
      if (!userId) {
        return reply.status(400).send({
          success: false,
          error: "Codice reset non valido o scaduto",
          code: "INVALID_PASSWORD_RESET_TOKEN",
        });
      }

      const authService = getAuthService();
      const hashedPassword = await authService.hashPassword(input.password);
      await userRepository.updateUser(userId, { password: hashedPassword });
      await userRepository.invalidatePasswordResetTokens(userId);
      await userRepository.revokeAllUserTokens(userId);

      return reply.status(200).send({
        success: true,
        message: "Password aggiornata con successo",
      });
    } catch (error) {
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "PASSWORD_RESET_CONFIRM_ERROR" });
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
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "UPLOAD_ERROR" });
    }
  }

  async registerPushToken(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const body = (request.body as { token?: string; platform?: string } | undefined) || {};
      const { token, platform } = body;

      if (!token || typeof token !== "string" || token.trim().length === 0) {
        return reply.status(400).send({ success: false, error: "token obbligatorio", code: "MISSING_TOKEN" });
      }

      const cleanToken = token.trim();
      const cleanPlatform = platform && ["ios", "android"].includes(platform) ? platform : null;

      const { ulid } = await import("ulid");
      await databaseService.getPool().query(
        `INSERT INTO device_push_tokens (id, user_id, token, platform, created_at, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (token) DO UPDATE SET
           user_id    = EXCLUDED.user_id,
           platform   = COALESCE(EXCLUDED.platform, device_push_tokens.platform),
           updated_at = CURRENT_TIMESTAMP`,
        [ulid(), userId, cleanToken, cleanPlatform],
      );

      return reply.status(200).send({ success: true });
    } catch (error) {
      console.error("❌ Errore authController.ts:", error);
      return reply.status(500).send({ success: false, error: "Errore interno del server", code: "PUSH_TOKEN_ERROR" });
    }
  }
}

// Istanza singleton del controller
export const authController = new AuthController();
