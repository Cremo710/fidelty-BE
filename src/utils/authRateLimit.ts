import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler, onResponseAsyncHookHandler } from "fastify";

/**
 * Limiti di frequenza per le rotte di autenticazione.
 *
 * Il `config.rateLimit` di @fastify/rate-limit applica un solo limite per rotta (quello di rotta
 * sostituisce il globale e i limiter `app.rateLimit()` successivi al primo vengono saltati).
 * Qui invece ogni rotta può avere più limiti indipendenti (per IP, per email+IP, per email),
 * costruiti con `app.createRateLimit()`, che non ha questa restrizione.
 *
 * Un limite può contare:
 * - ogni richiesta (`countWhen` assente): utile per le rotte che inviano email;
 * - solo gli esiti falliti (`countWhen(statusCode)`): un utente che entra al primo colpo non
 *   consuma il limite, e chi condivide l'IP (wifi del locale, CGNAT) non viene bloccato dai login
 *   riusciti degli altri.
 */

export type AuthLimitSpec = {
  /** Nome del limite: separa i contatori di limiti diversi che usano la stessa chiave. */
  name: string;
  max: number;
  timeWindow: string;
  /** Chiave del contatore; `null` salta il limite per questa richiesta. */
  key: (request: FastifyRequest) => string | null;
  /** Se presente, il contatore aumenta solo quando la risposta ha uno status per cui restituisce true. */
  countWhen?: (statusCode: number) => boolean;
};

export type RateLimitedError = Error & { statusCode: number; code: "RATE_LIMITED" };

export function buildRateLimitedError(ttlMs: number, statusCode = 429): RateLimitedError {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
  const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} minuti` : `${seconds} secondi`;
  return Object.assign(new Error(`Troppe richieste. Riprova tra ${wait}.`), {
    statusCode,
    code: "RATE_LIMITED" as const,
  });
}

/** Email del body JSON, normalizzata; null se assente. */
export function bodyEmail(request: FastifyRequest): string | null {
  const email = (request.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
}

/** Fallimenti di credenziali o codici: 400 (codice errato), 401 (password errata). */
export const isAuthFailure = (statusCode: number) => statusCode === 400 || statusCode === 401;

export function createAuthLimitGuard(app: FastifyInstance, specs: AuthLimitSpec[]) {
  const limiters = specs.map((spec) => ({
    spec,
    check: app.createRateLimit({
      max: spec.max,
      timeWindow: spec.timeWindow,
      keyGenerator: (request: FastifyRequest) => `${spec.name}:${spec.key(request) ?? ""}`,
    }),
  }));

  const preHandler: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
    for (const { spec, check } of limiters) {
      if (spec.key(request) === null) continue;
      // Per i limiti sui fallimenti si legge il contatore senza incrementarlo
      const result = await check(request, spec.countWhen ? { increment: false } : undefined);
      if (!result.isAllowed && result.isExceeded) {
        throw buildRateLimitedError(result.ttl);
      }
    }
  };

  const onResponse: onResponseAsyncHookHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    for (const { spec, check } of limiters) {
      if (!spec.countWhen || !spec.countWhen(reply.statusCode)) continue;
      if (spec.key(request) === null) continue;
      try {
        await check(request);
      } catch (error) {
        request.log.warn({ event: "auth_rate_limit_count_failed", limit: spec.name, err: error });
      }
    }
  };

  return { preHandler, onResponse };
}
