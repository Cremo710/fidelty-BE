import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  poolQuery: vi.fn(),
  publicIdCollisions: 0,
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  customFetch: Symbol("customFetch"),
  decodeProtectedHeader: vi.fn(() => ({ alg: "RS256" })),
  decodeJwt: vi.fn(() => ({
    sub: "apple-subject",
    exp: Math.floor(Date.now() / 1000) + 60,
  })),
  jwtVerify: vi.fn(async () => ({
    payload: {
      sub: "apple-subject",
      iss: "https://appleid.apple.com",
      aud: "apple-test-client",
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
      nonce: "apple-nonce-hash",
      email: "private@example.com",
      email_verified: true,
    },
  })),
}));

vi.mock("../services/databaseService.js", () => ({
  databaseService: {
    getPool: () => ({
      connect: async () => ({
        query: state.clientQuery,
        release: vi.fn(),
      }),
      query: state.poolQuery,
    }),
  },
}));

vi.mock("../services/authService.js", () => ({
  getAuthService: () => ({
    hashPassword: async () => "password-hash",
    generateToken: () => "access-token",
    generateRefreshToken: () => "refresh-token",
  }),
}));

import { signInWithSocialIdentity } from "../services/socialAuthService.js";

describe("Apple social user creation", () => {
  beforeEach(() => {
    process.env.APPLE_CLIENT_IDS = "apple-test-client";
    state.publicIdCollisions = 1;
    state.clientQuery.mockReset();
    state.poolQuery.mockReset();

    state.clientQuery.mockImplementation(
      async (sql: string, values: unknown[] = []) => {
        if (sql.includes("SELECT 1 FROM utenti WHERE public_id")) {
          return { rows: [] };
        }
        if (sql.includes("FROM social_identities s")) return { rows: [] };
        if (sql.includes("SELECT id FROM utenti WHERE LOWER(email)")) {
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO utenti")) {
          if (state.publicIdCollisions > 0) {
            state.publicIdCollisions--;
            throw Object.assign(new Error("unique violation"), {
              code: "23505",
              constraint: "utenti_public_id_key",
            });
          }
          return {
            rows: [
              {
                id: values[0],
                public_id: values[1],
                name: values[2],
                email: values[3],
              },
            ],
          };
        }
        return { rows: [] };
      },
    );
    state.poolQuery.mockResolvedValue({ rows: [] });
  });

  it("creates an Apple account with a short public id when request name/email are null", async () => {
    const appleRequest = {
      provider: "apple" as const,
      identityToken: "fake-apple-identity-token",
      nonce: "apple-nonce-hash",
      name: null,
      email: null,
    };
    const result = await signInWithSocialIdentity({
      provider: appleRequest.provider,
      identityToken: appleRequest.identityToken,
      nonce: appleRequest.nonce,
      name: appleRequest.name ?? undefined,
    });

    const inserts = state.clientQuery.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO utenti"),
    );
    expect(inserts).toHaveLength(2);
    const successfulInsertValues = inserts[1][1] as unknown[];
    const publicId = successfulInsertValues[1] as string;
    expect(publicId).toHaveLength(8);
    expect(publicId).toMatch(/^FU-[A-Z0-9]{5}$/);
    expect(successfulInsertValues[2]).toBe("private");
    expect(successfulInsertValues[3]).toBe("private@example.com");
    expect(result.publicId).toBe(publicId);
  });
});
