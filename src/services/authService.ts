import { hash, verify } from "argon2";
import jwt, { SignOptions } from "jsonwebtoken";

interface JWTPayload {
  userId: number;
  email: string;
  iat?: number;
  exp?: number;
}

interface AuthServiceDependencies {
  JWT_SECRET: string;
  JWT_EXPIRY?: string;
}

export class AuthService {
  private jwtSecret: string;
  private jwtExpiry: string;

  constructor(deps: AuthServiceDependencies) {
    if (!deps.JWT_SECRET) {
      throw new Error("JWT_SECRET non è definito nelle variabili d'ambiente");
    }
    this.jwtSecret = deps.JWT_SECRET;
    this.jwtExpiry = deps.JWT_EXPIRY || "7d"; // Default 7 giorni
  }

  /**
   * Genera l'hash della password usando argon2
   * @param password - password in chiaro
   * @returns hash della password
   */
  async hashPassword(password: string): Promise<string> {
    try {
      return await hash(password, {
        type: 2, // Argon2id
        memoryCost: 65536, // 64 MB
        timeCost: 3,
        parallelism: 4,
      });
    } catch (error) {
      console.error("❌ Errore durante l'hashing della password:", error);
      throw new Error("Errore durante l'hashing della password");
    }
  }

  /**
   * Verifica la password contro il suo hash
   * @param password - password in chiaro
   * @param hash - hash memorizzato nel database
   * @returns true se la password è corretta
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      return await verify(hash, password);
    } catch (error) {
      console.error("❌ Errore durante la verifica della password:", error);
      return false;
    }
  }

  /**
   * Genera un JWT token
   * @param userId - ID dell'utente
   * @param email - Email dell'utente
   * @returns JWT token firmato
   */
  generateToken(userId: number, email: string): string {
    try {
      const payload: JWTPayload = {
        userId,
        email,
      };

      const signOptions = {
        expiresIn: this.jwtExpiry,
        algorithm: "HS256" as const,
      };

      // Cast necessario per compatibilità jsonwebtoken
      return jwt.sign(payload, this.jwtSecret, signOptions as any);
    } catch (error) {
      console.error("❌ Errore durante la generazione del token:", error);
      throw new Error("Errore durante la generazione del token");
    }
  }

  /**
   * Verifica e decodifica un JWT token
   * @param token - JWT token da verificare
   * @returns payload decodificato
   */
  verifyToken(token: string): JWTPayload | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret, {
        algorithms: ["HS256"],
      }) as JWTPayload;
      return decoded;
    } catch (error) {
      console.error("❌ Errore durante la verifica del token:", error);
      return null;
    }
  }

  /**
   * Estrae il token dall'header Authorization
   * @param authHeader - valore dell'header Authorization
   * @returns token oppure null
   */
  extractTokenFromHeader(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }
    return authHeader.substring(7); // Rimuove "Bearer "
  }
}

// Istanza singleton dell'AuthService
let authServiceInstance: AuthService | null = null;

/**
 * Factory per ottenere l'istanza singleton
 */
export function getAuthService(): AuthService {
  if (!authServiceInstance) {
    authServiceInstance = new AuthService({
      JWT_SECRET: process.env.JWT_SECRET || "your-secret-key",
      JWT_EXPIRY: process.env.JWT_EXPIRY || "7d",
    });
  }
  return authServiceInstance;
}

export { JWTPayload };
