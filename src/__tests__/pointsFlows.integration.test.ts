import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

// Flussi che muovono punti, provati contro un vero Postgres:
// invio scontrino (anche diviso tra amici), accredito manuale, riscatto offerte con QR.
// Richiedono TEST_DATABASE_URL (vedi .github/workflows/ci.yml).
const testUrl = process.env.TEST_DATABASE_URL;

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
type Result = { statusCode: number; body: any };

/** Chiama un controller con una richiesta finta e restituisce stato e corpo della risposta. */
async function call(handler: Handler, request: Record<string, unknown>): Promise<Result> {
  const result: Result = { statusCode: 200, body: undefined };
  const reply = {
    status(code: number) { result.statusCode = code; return reply; },
    header() { return reply; },
    send(payload: unknown) { result.body = payload; return reply; },
  };
  const noop = () => undefined;
  await handler(
    { headers: {}, params: {}, body: {}, log: { info: noop, warn: noop, error: noop }, ...request } as unknown as FastifyRequest,
    reply as unknown as FastifyReply,
  );
  return result;
}

/** P.IVA italiana valida (cifra di controllo corretta) partendo da 10 cifre casuali. */
function randomVatNumber(): string {
  const base = Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join("");
  let odd = 0;
  let even = 0;
  for (let i = 0; i < 10; i++) {
    const digit = Number(base[i]);
    if (i % 2 === 0) {
      odd += digit;
    } else {
      const doubled = digit * 2;
      even += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return base + String((10 - ((odd + even) % 10)) % 10);
}

const randomDocId = () => `${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
const todayRome = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
const BAR_LAT = 45.4642;
const BAR_LON = 9.19;

describe.skipIf(!testUrl)("integrazione flussi punti (database di test)", () => {
  let databaseService: typeof import("../services/databaseService.js").databaseService;
  let consumptionRequestController: typeof import("../controllers/consumptionRequestController.js").consumptionRequestController;
  let offerRedemptionController: typeof import("../controllers/offerRedemptionController.js").offerRedemptionController;
  let requireBarPermission: typeof import("../utils/barPermissionGuard.js").requireBarPermission;
  let isValidItalianVatNumber: typeof import("../services/receiptValidation.js").isValidItalianVatNumber;
  const userIds: string[] = [];
  const barIds: string[] = [];

  let barId: string;
  let barVat: string;
  let managerId: string;
  let waiter: { id: string; publicId: string };

  const db = () => databaseService.getPool();

  async function createUser() {
    const id = ulid();
    const publicId = `FU-${randomBytes(4).toString("hex").slice(0, 5).toUpperCase()}`;
    await db().query(
      `INSERT INTO utenti (id, name, email, password, is_email_verified, public_id, created_at)
       VALUES ($1, 'Utente test', $2, 'test-hash', TRUE, $3, NOW() - INTERVAL '60 days')`,
      [id, `flow-${id.toLowerCase()}@example.test`, publicId],
    );
    userIds.push(id);
    return { id, publicId };
  }

  async function makeFriends(a: string, b: string) {
    await db().query("INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1)", [a, b]);
  }

  async function points(userId: string) {
    const row = await db().query<{ points: number }>(
      "SELECT points FROM loyalty_cards WHERE user_id = $1 AND bar_id = $2",
      [userId, barId],
    );
    return row.rows[0]?.points ?? 0;
  }

  /** Sessione OCR già "letta": quello che /consumption-requests/ocr salverebbe. */
  async function createOcrSession(userId: string, opts: { amount?: number; vat?: string; docId?: string } = {}) {
    const id = ulid();
    await db().query(
      `INSERT INTO receipt_ocr_sessions (
         id, user_id, bar_id, amount, vat_number, doc_id, receipt_date,
         image_sha256, raw_text, fields_found, expires_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test', $9, NOW() + INTERVAL '10 minutes', NOW())`,
      [
        id, userId, barId, opts.amount ?? 10, opts.vat ?? barVat, opts.docId ?? randomDocId(), todayRome(),
        randomBytes(32).toString("hex"),
        JSON.stringify({ amount: true, vatNumber: true, docId: true, date: true }),
      ],
    );
    return id;
  }

  const submitReceipt = (userId: string, ocrSessionId: string, participantPublicIds: string[] = []) => call(
    (req, rep) => consumptionRequestController.create(req, rep),
    {
      userId,
      body: { ocrSessionId, userLatitude: BAR_LAT, userLongitude: BAR_LON, isMockedLocation: false, participantPublicIds },
    },
  );

  beforeAll(async () => {
    if (!/test/i.test(testUrl as string)) {
      throw new Error("TEST_DATABASE_URL deve puntare a un database il cui nome/URL contiene 'test'");
    }
    process.env.DATABASE_URL = testUrl;
    ({ databaseService } = await import("../services/databaseService.js"));
    ({ consumptionRequestController } = await import("../controllers/consumptionRequestController.js"));
    ({ offerRedemptionController } = await import("../controllers/offerRedemptionController.js"));
    ({ requireBarPermission } = await import("../utils/barPermissionGuard.js"));
    ({ isValidItalianVatNumber } = await import("../services/receiptValidation.js"));
    await databaseService.initializeTables();

    const manager = await createUser();
    managerId = manager.id;
    waiter = await createUser();
    barId = ulid();
    barVat = randomVatNumber();
    await db().query(
      `INSERT INTO bars (id, user_id, iva, merchant_name, name, address, latitude, longitude)
       VALUES ($1, $2, $3, 'Test', 'Bar dei test', 'Via Test 1', $4, $5)`,
      [barId, managerId, barVat, BAR_LAT, BAR_LON],
    );
    barIds.push(barId);
    await db().query(
      `INSERT INTO bar_team_members (id, bar_id, user_id, email, role, status, accepted_at)
       VALUES ($1, $2, $3, 'manager@example.test', 'manager', 'active', CURRENT_TIMESTAMP),
              ($4, $2, $5, 'waiter@example.test', 'waiter', 'active', CURRENT_TIMESTAMP)`,
      [ulid(), barId, managerId, ulid(), waiter.id],
    );
  });

  afterAll(async () => {
    if (!databaseService) return;
    for (const id of barIds) await db().query("DELETE FROM bars WHERE id = $1", [id]);
    for (const id of userIds) await db().query("DELETE FROM utenti WHERE id = $1", [id]);
    await databaseService.closePool();
  });

  it("le P.IVA generate dal test sono valide", () => {
    expect(isValidItalianVatNumber(barVat)).toBe(true);
  });

  describe("invio scontrino", () => {
    it("divide i punti tra il cliente e due amici: somma esatta, resto al primo", async () => {
      const owner = await createUser();
      const friendA = await createUser();
      const friendB = await createUser();
      await makeFriends(owner.id, friendA.id);
      await makeFriends(owner.id, friendB.id);
      const sessionId = await createOcrSession(owner.id, { amount: 10 });

      const res = await submitReceipt(owner.id, sessionId, [friendA.publicId, friendB.publicId]);

      expect(res.statusCode).toBe(201);
      // 10 € × 100 punti/€ = 1000 punti su 3 partecipanti
      expect([await points(owner.id), await points(friendA.id), await points(friendB.id)]).toEqual([334, 333, 333]);
      const participants = await db().query<{ points_allocated: number }>(
        `SELECT p.points_allocated FROM consumption_request_participants p
         JOIN consumption_requests r ON r.id = p.request_id
         WHERE r.requester_user_id = $1 ORDER BY p.participant_order`,
        [owner.id],
      );
      expect(participants.rows.map((row) => row.points_allocated)).toEqual([334, 333, 333]);
      const session = await db().query("SELECT consumed_at FROM receipt_ocr_sessions WHERE id = $1", [sessionId]);
      expect(session.rows[0].consumed_at).not.toBeNull();
    });

    it("rifiuta un partecipante che non è amico, senza accreditare né consumare la sessione", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const sessionId = await createOcrSession(owner.id);

      const res = await submitReceipt(owner.id, sessionId, [stranger.publicId]);

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("RECEIPT_PARTICIPANTS_MUST_BE_FRIENDS");
      expect(await points(owner.id)).toBe(0);
      expect(await points(stranger.id)).toBe(0);
      const session = await db().query("SELECT consumed_at FROM receipt_ocr_sessions WHERE id = $1", [sessionId]);
      expect(session.rows[0].consumed_at).toBeNull();
    });

    it("rifiuta lo staff del bar tra i partecipanti", async () => {
      const owner = await createUser();
      await makeFriends(owner.id, waiter.id);
      const sessionId = await createOcrSession(owner.id);

      const res = await submitReceipt(owner.id, sessionId, [waiter.publicId]);

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("RECEIPT_PARTICIPANT_IS_BAR_STAFF");
      expect(await points(waiter.id)).toBe(0);
    });

    it("lo staff non può inviare scontrini al proprio bar", async () => {
      const sessionId = await createOcrSession(waiter.id);
      const res = await submitReceipt(waiter.id, sessionId);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("SELF_REQUEST_NOT_ALLOWED");
    });

    it("la stessa sessione inviata due volte insieme accredita una volta sola", async () => {
      const owner = await createUser();
      const sessionId = await createOcrSession(owner.id, { amount: 10 });

      const results = await Promise.all([submitReceipt(owner.id, sessionId), submitReceipt(owner.id, sessionId)]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await points(owner.id)).toBe(1000);
    });

    it("semaforo rosso (P.IVA di un altro bar): nessun accredito, scontrino non bruciato", async () => {
      const owner = await createUser();
      const friend = await createUser();
      await makeFriends(owner.id, friend.id);
      const sessionId = await createOcrSession(owner.id, { vat: randomVatNumber() });

      const res = await submitReceipt(owner.id, sessionId, [friend.publicId]);

      expect(res.statusCode).toBe(201);
      expect(res.body.data.status).toBe("rejected");
      expect(await points(owner.id)).toBe(0);
      expect(await points(friend.id)).toBe(0);
      const identity = await db().query("SELECT 1 FROM receipt_ocr_identities WHERE session_id = $1", [sessionId]);
      expect(identity.rowCount).toBe(0);
      const allocated = await db().query<{ points_allocated: number }>(
        `SELECT p.points_allocated FROM consumption_request_participants p
         JOIN consumption_requests r ON r.id = p.request_id WHERE r.requester_user_id = $1`,
        [owner.id],
      );
      expect(allocated.rows.every((row) => row.points_allocated === 0)).toBe(true);
    });

    it("stesso numero di scontrino lo stesso giorno: rosso DUPLICATE", async () => {
      const owner = await createUser();
      const docId = randomDocId();
      await submitReceipt(owner.id, await createOcrSession(owner.id, { amount: 10, docId }));

      const again = await submitReceipt(owner.id, await createOcrSession(owner.id, { amount: 12, docId }));

      expect(again.body.data.status).toBe("rejected");
      expect(again.body.data.signalFlags.map((s: { code: string }) => s.code)).toContain("DUPLICATE");
      expect(await points(owner.id)).toBe(1000);
    });

    it("stesso numero di scontrino con un altro importo in un altro giorno: giallo, nessun accredito automatico", async () => {
      const owner = await createUser();
      const docId = randomDocId();
      const first = await submitReceipt(owner.id, await createOcrSession(owner.id, { amount: 10, docId }));
      expect(first.statusCode).toBe(201);
      expect(await points(owner.id)).toBe(1000);
      // Il controllo DUPLICATE guarda solo il giorno di invio: si simula il reinvio il giorno dopo
      await db().query(
        "UPDATE consumption_requests SET created_at = created_at - INTERVAL '1 day' WHERE requester_user_id = $1",
        [owner.id],
      );

      const second = await submitReceipt(owner.id, await createOcrSession(owner.id, { amount: 12, docId }));

      expect(second.statusCode).toBe(201);
      expect(second.body.data.status).toBe("pending");
      expect(second.body.data.signalFlags.map((s: { code: string }) => s.code)).toContain("SAME_RECEIPT_NUMBER");
      expect(await points(owner.id)).toBe(1000);
    });
  });

  describe("accredito manuale", () => {
    const manualCredit = (userId: string, body: Record<string, unknown>) => call(
      (req, rep) => consumptionRequestController.manualCredit(req, rep),
      { userId, headers: { "x-bar-id": barId }, body },
    );

    it("il titolare accredita un cliente e resta traccia di chi l'ha fatto", async () => {
      const customer = await createUser();
      const res = await manualCredit(managerId, { userPublicId: customer.publicId, amount: 5 });

      expect(res.statusCode).toBe(201);
      expect(await points(customer.id)).toBe(500);
      const row = await db().query<{ processed_by_user_id: string }>(
        "SELECT processed_by_user_id FROM consumption_requests WHERE id = $1",
        [res.body.data.id],
      );
      expect(row.rows[0].processed_by_user_id).toBe(managerId);
    });

    it("non si accreditano punti allo staff del bar", async () => {
      const res = await manualCredit(managerId, { userPublicId: waiter.publicId, amount: 5 });
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe("SELF_CREDIT_NOT_ALLOWED");
      expect(await points(waiter.id)).toBe(0);
    });

    it("il cameriere non ha il permesso di accreditare punti a mano", async () => {
      const guard = await call(
        (req, rep) => requireBarPermission("points.credit_manual")(req, rep) as Promise<unknown>,
        { userId: waiter.id, headers: { "x-bar-id": barId } },
      );
      expect(guard.statusCode).toBe(403);
      expect(guard.body.code).toBe("BAR_PERMISSION_DENIED");
    });
  });

  describe("riscatto offerte con QR", () => {
    let offerId: string;

    async function giveCard(userId: string, cardPoints: number) {
      await db().query(
        `INSERT INTO loyalty_cards (user_id, bar_id, points, lifetime_points, receipts_count)
         VALUES ($1, $2, $3, $3, 1)
         ON CONFLICT (user_id, bar_id) DO UPDATE SET points = EXCLUDED.points, lifetime_points = EXCLUDED.lifetime_points`,
        [userId, barId, cardPoints],
      );
    }

    const redeem = (userId: string) => call(
      (req, rep) => offerRedemptionController.create(req, rep),
      { userId, params: { offerId } },
    );
    const validate = (validatorId: string, qrToken: string) => call(
      (req, rep) => offerRedemptionController.validateQr(req, rep),
      { userId: validatorId, headers: { "x-bar-id": barId }, body: { qrToken } },
    );

    beforeAll(async () => {
      offerId = ulid();
      await db().query(
        "INSERT INTO offers (id, bar_id, title, points_required, is_active) VALUES ($1, $2, 'Caffè omaggio', 300, TRUE)",
        [offerId, barId],
      );
    });

    it("il cameriere valida il QR, i punti scalano una volta sola e il secondo tentativo resta nell'audit", async () => {
      const customer = await createUser();
      await giveCard(customer.id, 1000);
      const created = await redeem(customer.id);
      expect(created.statusCode).toBe(201);

      const first = await validate(waiter.id, created.body.data.qrToken);
      expect(first.statusCode).toBe(200);
      expect(await points(customer.id)).toBe(700);

      const second = await validate(waiter.id, created.body.data.qrToken);
      expect(second.statusCode).toBe(409);
      expect(second.body.code).toBe("QR_ALREADY_USED");
      expect(await points(customer.id)).toBe(700);

      // Prima della patch 10 questo evento veniva annullato dal ROLLBACK
      const audit = await db().query<{ metadata: { reason: string } }>(
        "SELECT metadata FROM offer_redemption_events WHERE redemption_id = $1 AND event_type = 'validation_rejected'",
        [created.body.data.id],
      );
      expect(audit.rows.map((row) => row.metadata.reason)).toContain("already_redeemed");
    });

    it("due validazioni contemporanee dello stesso QR: una sola riesce", async () => {
      const customer = await createUser();
      await giveCard(customer.id, 1000);
      const created = await redeem(customer.id);

      const results = await Promise.all([
        validate(waiter.id, created.body.data.qrToken),
        validate(managerId, created.body.data.qrToken),
      ]);

      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await points(customer.id)).toBe(700);
    });

    it("punti insufficienti: nessun QR", async () => {
      const customer = await createUser();
      await giveCard(customer.id, 100);
      const created = await redeem(customer.id);
      expect(created.statusCode).toBe(409);
      expect(await points(customer.id)).toBe(100);
    });

    it("nessuno valida il proprio riscatto", async () => {
      await giveCard(waiter.id, 1000);
      const created = await redeem(waiter.id);
      expect(created.statusCode).toBe(201);

      const res = await validate(waiter.id, created.body.data.qrToken);

      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe("SELF_VALIDATION_NOT_ALLOWED");
      expect(await points(waiter.id)).toBe(1000);
    });
  });
});
