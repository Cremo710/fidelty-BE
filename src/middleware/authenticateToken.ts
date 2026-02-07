import { FastifyRequest, FastifyReply } from "fastify";
import { getAuthService } from "../services/authService.js";

// Estendi il tipo FastifyRequest per aggiungere userId e userEmail
declare global {
  namespace FastifyRequest {
    interface FastifyRequest {
      userId?: number;
      userEmail?: string;
    }
  }
}

// Alternative: estendi FastifyRequest come type module augmentation
declare module "fastify" {
  interface FastifyRequest {
    userId?: number;
    userEmail?: string;
  }
}

/**
 * Middleware di autenticazione JWT
 * Verifica la presenza e validità del token nell'header Authorization
 * Aggiunge userId e userEmail al request per utilizzo nelle rotte protette
 */
export async function authenticateToken(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    const authService = getAuthService();
    const authHeader = request.headers.authorization;

    // Estrai il token dall'header
    const token = authService.extractTokenFromHeader(authHeader);

    if (!token) {
      return reply.status(401).send({
        success: false,
        error: "Token mancante o formato non valido",
        code: "MISSING_TOKEN",
      });
    }

    // Verifica il token
    const payload = authService.verifyToken(token);

    if (!payload) {
      return reply.status(401).send({
        success: false,
        error: "Token non valido o scaduto",
        code: "INVALID_TOKEN",
      });
    }

    // Aggiungi le informazioni dell'utente al request
    request.userId = payload.userId;
    request.userEmail = payload.email;

    console.log(`🔐 Utente autenticato: ${payload.email} (ID: ${payload.userId})`);
  } catch (error) {
    console.error("❌ Errore durante l'autenticazione:", error);
    return reply.status(500).send({
      success: false,
      error: "Errore durante l'autenticazione",
      code: "AUTH_ERROR",
    });
  }
}

/**
 * Hook decorator per proteggere una rotta
 * Uso: app.get("/protected", { onRequest: [authenticateToken] }, handler)
 */
export function withAuth(request: FastifyRequest, reply: FastifyReply) {
  return authenticateToken(request, reply);
}
