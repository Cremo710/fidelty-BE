import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { bodyEmail, buildRateLimitedError, createAuthLimitGuard, isAuthFailure } from "../utils/authRateLimit.js";

// Simula /api/auth/login: 200 con la password "giusta", 401 altrimenti
async function buildApp(): Promise<FastifyInstance> {
  // Stessa configurazione di src/index.ts con TRUST_PROXY_HOPS=1
  const app = Fastify({ trustProxy: (_address: string, hop: number) => hop < 1 });
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, ctx) => buildRateLimitedError(ctx.ttl, ctx.statusCode),
  });
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (error.statusCode === 429 && error.code === "RATE_LIMITED") {
      return reply.status(429).send({ success: false, error: error.message, code: "RATE_LIMITED" });
    }
    throw error;
  });

  const emailIpKey = (request: Parameters<typeof bodyEmail>[0]) => {
    const email = bodyEmail(request);
    return email ? `${email}|${request.ip}` : null;
  };
  const guard = createAuthLimitGuard(app, [
    { name: "ip", max: 6, timeWindow: "15 minutes", key: (r) => r.ip, countWhen: isAuthFailure },
    { name: "email-ip", max: 3, timeWindow: "15 minutes", key: emailIpKey, countWhen: isAuthFailure },
    { name: "email", max: 5, timeWindow: "1 hour", key: bodyEmail, countWhen: isAuthFailure },
  ]);
  app.post("/login", guard, async (request, reply) => {
    const { password } = request.body as { password: string };
    return password === "ok" ? reply.send({ success: true }) : reply.status(401).send({ success: false });
  });
  return app;
}

function login(app: FastifyInstance, email: string, password: string, ip: string, xff?: string) {
  return app.inject({
    method: "POST",
    url: "/login",
    remoteAddress: ip,
    headers: xff ? { "x-forwarded-for": xff } : {},
    payload: { email, password },
  });
}

describe("createAuthLimitGuard", () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });
  afterEach(async () => { await app.close(); });

  it("conta solo i fallimenti: i login riusciti non consumano il limite", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await login(app, "a@x.it", "ok", "10.0.0.1")).statusCode).toBe(200);
    }
  });

  it("blocca il brute force su un account dallo stesso IP (email+IP)", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "a@x.it", "bad", "10.0.0.1")).statusCode).toBe(401);
    }
    const blocked = await login(app, "a@x.it", "ok", "10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("RATE_LIMITED");
  });

  it("un attaccante da un altro IP non blocca il login della vittima", async () => {
    for (let i = 0; i < 3; i++) await login(app, "vittima@x.it", "bad", "10.0.0.66");
    expect((await login(app, "vittima@x.it", "bad", "10.0.0.66")).statusCode).toBe(429);
    expect((await login(app, "vittima@x.it", "ok", "10.0.0.1")).statusCode).toBe(200);
  });

  it("ferma il password spraying su molte email dallo stesso IP", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await login(app, `u${i}@x.it`, "bad", "10.0.0.66")).statusCode).toBe(401);
    }
    expect((await login(app, "altro@x.it", "bad", "10.0.0.66")).statusCode).toBe(429);
  });

  it("ferma il brute force distribuito su più IP (limite per email)", async () => {
    for (let i = 0; i < 5; i++) await login(app, "a@x.it", "bad", `10.0.1.${i}`);
    expect((await login(app, "a@x.it", "ok", "10.0.2.1")).statusCode).toBe(429);
  });

  it("con trustProxy: 1 un X-Forwarded-For inventato dal client non cambia l'IP", async () => {
    // Il client (5.5.5.5) scrive un IP falso; il proxy (10.0.0.1) aggiunge in coda l'IP reale
    for (let i = 0; i < 6; i++) {
      await login(app, `u${i}@x.it`, "bad", "10.0.0.1", `1.2.3.${i}, 5.5.5.5`);
    }
    expect((await login(app, "altro@x.it", "bad", "10.0.0.1", "9.9.9.9, 5.5.5.5")).statusCode).toBe(429);
    // Un altro client dietro lo stesso proxy non è bloccato
    expect((await login(app, "altro@x.it", "bad", "10.0.0.1", "6.6.6.6")).statusCode).toBe(401);
  });
});
