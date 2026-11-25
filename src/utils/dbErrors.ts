import type { FastifyReply } from "fastify";

/**
 * True se l'errore indica che non è stato possibile ottenere una connessione dal pool in tempo:
 * pool esaurito (tutte le connessioni occupate) o database che non risponde entro
 * connectionTimeoutMillis. È una condizione temporanea: il client deve riprovare, non è un bug.
 * Messaggi presi da pg-pool (index.js).
 */
export function isDbPoolTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "timeout exceeded when trying to connect"
    || message === "Connection terminated due to connection timeout";
}

/** Secondi suggeriti al client prima di riprovare (header Retry-After). */
export const DB_BUSY_RETRY_AFTER_SECONDS = 5;

/**
 * Risposta 503 per il pool esaurito. Il codice SERVICE_UNAVAILABLE è già tradotto nell'app
 * ("Servizio temporaneamente non disponibile. Riprova tra poco.").
 */
export function sendDbBusy(reply: FastifyReply) {
  return reply
    .status(503)
    .header("Retry-After", String(DB_BUSY_RETRY_AFTER_SECONDS))
    .send({
      success: false,
      error: "Servizio momentaneamente occupato. Riprova tra poco.",
      code: "SERVICE_UNAVAILABLE",
    });
}
