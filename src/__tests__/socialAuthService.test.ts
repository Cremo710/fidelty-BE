import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/databaseService.js", () => ({
  databaseService: { getPool: vi.fn() },
}));
vi.mock("../services/authService.js", () => ({
  getAuthService: vi.fn(),
}));
vi.mock("../repositories/userRepository.js", () => ({
  userRepository: { saveRefreshToken: vi.fn() },
}));

import {
  requireVerifiedEmail,
  SocialAuthError,
  verifyProviderToken,
} from "../services/socialAuthService.js";

const audience = "test-client-id";
const nonce = "n".repeat(32);
const issuer = "https://accounts.google.com";
type TestPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let privateKey: TestPrivateKey;
let otherPrivateKey: TestPrivateKey;
let keyResolver: JWTVerifyGetKey;

async function createToken(
  options: {
    aud?: string;
    exp?: number;
    nonce?: string;
    sub?: string;
    signWithOtherKey?: boolean;
  } = {},
) {
  const token = new SignJWT({
    nonce: options.nonce ?? nonce,
    email: "person@example.com",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "social-test-key" })
    .setIssuer(issuer)
    .setAudience(options.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 3600);

  if (options.sub !== undefined) token.setSubject(options.sub);
  else if (!("sub" in options)) token.setSubject("provider-subject");

  return token.sign(options.signWithOtherKey ? otherPrivateKey : privateKey);
}

beforeAll(async () => {
  const generated = await generateKeyPair("RS256");
  privateKey = generated.privateKey;
  const otherKey = await generateKeyPair("RS256");
  otherPrivateKey = otherKey.privateKey;
  const publicJwk = await exportJWK(generated.publicKey);
  publicJwk.kid = "social-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_IDS = audience;
});

describe("verifyProviderToken", () => {
  it("accepts a correctly signed token with expected claims", async () => {
    const identity = await verifyProviderToken(
      "google",
      await createToken(),
      nonce,
      keyResolver,
    );
    expect(identity).toMatchObject({
      subject: "provider-subject",
      email: "person@example.com",
      emailVerified: true,
    });
  });

  it("reports an audience mismatch with expected and received values", async () => {
    const token = await createToken({ aud: "other-client-id" });
    await expect(
      verifyProviderToken("google", token, nonce, keyResolver),
    ).rejects.toMatchObject({
      code: "INVALID_SOCIAL_TOKEN",
      statusCode: 401,
      stage: "verify_claims",
      reason: "SOCIAL_TOKEN_AUDIENCE_MISMATCH",
      diagnostics: {
        check: "aud",
        expected: [audience],
        received: ["other-client-id"],
      },
    });
  });

  it("reports an expired token without changing the public auth error", async () => {
    const token = await createToken({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      verifyProviderToken("google", token, nonce, keyResolver),
    ).rejects.toMatchObject({
      code: "INVALID_SOCIAL_TOKEN",
      statusCode: 401,
      stage: "verify_claims",
      reason: "SOCIAL_TOKEN_EXPIRED",
      diagnostics: { check: "exp" },
    });
  });

  it("reports a nonce mismatch without including either nonce in diagnostics", async () => {
    const token = await createToken();
    await expect(
      verifyProviderToken("google", token, "x".repeat(32), keyResolver),
    ).rejects.toMatchObject({
      stage: "nonce_check",
      reason: "SOCIAL_NONCE_MISMATCH",
      diagnostics: { check: "nonce" },
    });
  });

  it("reports an invalid signature", async () => {
    const token = await createToken({ signWithOtherKey: true });
    await expect(
      verifyProviderToken("google", token, nonce, keyResolver),
    ).rejects.toMatchObject({
      stage: "verify_signature",
      reason: "SOCIAL_TOKEN_SIGNATURE_INVALID",
    });
  });

  it("reports a missing subject", async () => {
    const token = await createToken({ sub: "" });
    await expect(
      verifyProviderToken("google", token, nonce, keyResolver),
    ).rejects.toMatchObject({
      stage: "verify_claims",
      reason: "SOCIAL_SUB_MISSING",
    });
  });

  it("rejects account creation when the provider omits a verified email", () => {
    expect(() =>
      requireVerifiedEmail({
        subject: "provider-subject",
        emailVerified: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VERIFIED_EMAIL_REQUIRED",
        stage: "user_lookup_or_create",
        reason: "SOCIAL_EMAIL_MISSING",
      }),
    );
  });

  it("labels remote key retrieval failures without exposing network details", async () => {
    const token = await createToken();
    const failingResolver: JWTVerifyGetKey = async () => {
      throw new SocialAuthError(
        "Unable to retrieve identity provider keys",
        "INVALID_SOCIAL_TOKEN",
        401,
        "fetch_jwks",
        "SOCIAL_JWKS_FETCH_FAILED",
      );
    };

    await expect(
      verifyProviderToken("google", token, nonce, failingResolver),
    ).rejects.toMatchObject({
      stage: "fetch_jwks",
      reason: "SOCIAL_JWKS_FETCH_FAILED",
    });
  });
});
