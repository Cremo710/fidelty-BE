import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ulid } from "ulid";

// Test di integrazione: richiedono un database dedicato (es. branch Neon "test").
// Esempio: TEST_DATABASE_URL="postgres://.../fidelty_test?sslmode=require" npm test
const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("integrazione (database di test)", () => {
  let databaseService: typeof import("../services/databaseService.js").databaseService;
  let userRepository: typeof import("../repositories/userRepository.js").userRepository;
  let semaphoreService: typeof import("../services/semaphoreService.js").semaphoreService;
  const createdUserIds: string[] = [];

  const barConfig = {
    barId: "test-bar",
    gpsRadiusMeters: 50,
    autoCreditEnabled: true,
    capEnabled: true,
    capAmount: 30,
    anomalyEnabled: true,
    youngAccountEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeAll(async () => {
    if (!/test/i.test(testUrl as string)) {
      throw new Error("TEST_DATABASE_URL deve puntare a un database il cui nome/URL contiene 'test'");
    }
    process.env.DATABASE_URL = testUrl;
    ({ databaseService } = await import("../services/databaseService.js"));
    ({ userRepository } = await import("../repositories/userRepository.js"));
    ({ semaphoreService } = await import("../services/semaphoreService.js"));
    await databaseService.initializeTables();
  });

  afterAll(async () => {
    if (!databaseService) return;
    for (const id of createdUserIds) {
      await databaseService.getPool().query("DELETE FROM utenti WHERE id = $1", [id]);
    }
    await databaseService.getPool().end();
  });

  async function newUser() {
    const email = `it-${ulid().toLowerCase()}@example.test`;
    const id = await userRepository.createUser({ name: "Test User", email, password: "hash" });
    createdUserIds.push(id);
    return { id, email };
  }

  describe("autenticazione e verifica email", () => {
    it("rifiuta una seconda registrazione con la stessa email", async () => {
      const { email } = await newUser();
      await expect(
        userRepository.createUser({ name: "Altro", email, password: "hash" }),
      ).rejects.toMatchObject({ code: "EMAIL_EXISTS" });
    });

    it("lo stesso codice a 6 cifre può esistere per utenti diversi", async () => {
      const [a, b] = [await newUser(), await newUser()];
      const hash = createHash("sha256").update("123456").digest("hex");
      const expires = new Date(Date.now() + 60_000);
      await userRepository.storeEmailVerificationToken(a.id, hash, expires);
      await userRepository.storeEmailVerificationToken(b.id, hash, expires);
      expect(await userRepository.consumeEmailVerificationToken(a.id, hash)).toBe(a.id);
      expect(await userRepository.consumeEmailVerificationToken(b.id, hash)).toBe(b.id);
    });

    it("un codice è consumabile una sola volta", async () => {
      const u = await newUser();
      const hash = createHash("sha256").update("654321").digest("hex");
      await userRepository.storeEmailVerificationToken(u.id, hash, new Date(Date.now() + 60_000));
      expect(await userRepository.consumeEmailVerificationToken(u.id, hash)).toBe(u.id);
      expect(await userRepository.consumeEmailVerificationToken(u.id, hash)).toBeNull();
    });

    it("dopo 5 tentativi falliti anche il codice giusto viene rifiutato", async () => {
      const u = await newUser();
      const hash = createHash("sha256").update("111111").digest("hex");
      await userRepository.storeEmailVerificationToken(u.id, hash, new Date(Date.now() + 60_000));
      for (let i = 0; i < 5; i += 1) {
        await userRepository.recordFailedEmailVerificationAttempt(u.id);
      }
      expect(await userRepository.consumeEmailVerificationToken(u.id, hash)).toBeNull();
    });

    it("un codice scaduto non è valido", async () => {
      const u = await newUser();
      const hash = createHash("sha256").update("222222").digest("hex");
      await userRepository.storeEmailVerificationToken(u.id, hash, new Date(Date.now() - 1000));
      expect(await userRepository.consumeEmailVerificationToken(u.id, hash)).toBeNull();
    });
  });

  describe("semaforo (query reali)", () => {
    const base = () => ({
      barId: ulid(),
      amount: 10,
      receiptCodeBlock1: null,
      receiptCodeBlock2: null,
      barConfig,
    });

    it("verde per una richiesta pulita", async () => {
      const u = await newUser();
      const result = await semaphoreService.evaluate({
        ...base(),
        userId: u.id,
        hasOcrSession: true,
        ocrFieldsFound: { amount: true, vatNumber: true, docId: true },
      });
      expect(result.status).toBe("green");
    });

    it("rosso se la P.IVA dello scontrino non è quella del bar", async () => {
      const u = await newUser();
      const result = await semaphoreService.evaluate({
        ...base(),
        userId: u.id,
        barPiva: "12345678901",
        ocrVatNumber: "10987654321",
      });
      expect(result.status).toBe("red");
      expect(result.signals.map((s) => s.code)).toContain("PIVA_MISMATCH");
    });

    it("giallo se l'importo supera il cap del bar", async () => {
      const u = await newUser();
      const result = await semaphoreService.evaluate({ ...base(), userId: u.id, amount: 31 });
      expect(result.signals.map((s) => s.code)).toContain("CAP_EXCEEDED");
      expect(result.status).toBe("yellow");
    });
  });
});

// TODO integrazione: approvazione richieste bar, richiesta di consumo end-to-end,
// trasferimento punti e riscatto offerte (richiedono fixture di bar, tessere e offerte).
