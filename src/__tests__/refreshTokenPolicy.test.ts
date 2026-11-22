import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import { decideRefresh, hashRefreshToken, REFRESH_ROTATION_GRACE_MS } from "../utils/refreshTokenPolicy.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");

describe("hashRefreshToken", () => {
  it("restituisce lo SHA-256 esadecimale, uguale a quello calcolato da Postgres nella migrazione 018", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.payload.firma";
    expect(hashRefreshToken(token)).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("decideRefresh", () => {
  it("accetta un token attivo", () => {
    expect(decideRefresh({ revoked: false, rotated_at: null }, { now: NOW, familyHasActiveToken: true }))
      .toEqual({ action: "accept" });
  });

  it("rifiuta un token revocato da logout senza toccare la famiglia", () => {
    expect(decideRefresh({ revoked: true, rotated_at: null }, { now: NOW, familyHasActiveToken: false }))
      .toEqual({ action: "reject", code: "REVOKED_REFRESH_TOKEN" });
  });

  it("accetta un token appena ruotato (risposta persa) se la famiglia è ancora attiva", () => {
    const rotatedAt = new Date(NOW - 10_000);
    expect(decideRefresh({ revoked: true, rotated_at: rotatedAt }, { now: NOW, familyHasActiveToken: true }))
      .toEqual({ action: "accept" });
  });

  it("tratta come riuso un token ruotato oltre la finestra di tolleranza", () => {
    const rotatedAt = new Date(NOW - REFRESH_ROTATION_GRACE_MS - 1);
    expect(decideRefresh({ revoked: true, rotated_at: rotatedAt }, { now: NOW, familyHasActiveToken: true }))
      .toEqual({ action: "reject_and_revoke_family", code: "REFRESH_TOKEN_REUSED" });
  });

  it("tratta come riuso un token ruotato se la famiglia è già stata revocata (es. logout)", () => {
    const rotatedAt = new Date(NOW - 5_000);
    expect(decideRefresh({ revoked: true, rotated_at: rotatedAt }, { now: NOW, familyHasActiveToken: false }))
      .toEqual({ action: "reject_and_revoke_family", code: "REFRESH_TOKEN_REUSED" });
  });

  it("accetta rotated_at come stringa (valore letto da pg)", () => {
    const rotatedAt = new Date(NOW - 1_000).toISOString();
    expect(decideRefresh({ revoked: true, rotated_at: rotatedAt }, { now: NOW, familyHasActiveToken: true }))
      .toEqual({ action: "accept" });
  });
});
