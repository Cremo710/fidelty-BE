import type { FastifyReply, FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInWithSocialIdentity: vi.fn(),
}));

vi.mock("../services/socialAuthService.js", () => ({
  signInWithSocialIdentity: mocks.signInWithSocialIdentity,
  SocialAuthInternalError: class SocialAuthInternalError extends Error {
    constructor(readonly originalError: unknown) {
      super("Social authentication operation failed");
    }
  },
  SocialAuthError: class SocialAuthError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly statusCode: number,
      readonly stage?: string,
      readonly reason?: string,
      readonly diagnostics?: Record<string, unknown>,
    ) {
      super(message);
      this.name = "SocialAuthError";
    }
  },
}));

import { SocialAuthError } from "../services/socialAuthService.js";
import {
  SocialAuthController,
  socialAuthInputSchema,
} from "../controllers/socialAuthController.js";

describe("SocialAuthController", () => {
  beforeEach(() => {
    mocks.signInWithSocialIdentity.mockReset();
  });

  it("accepts Apple login fields on the first login", () => {
    const result = socialAuthInputSchema.safeParse({
      provider: "apple",
      identityToken: `eyJ${"token".repeat(12)}`,
      nonce: "private-nonce-value-123456",
      email: "person@example.com",
      fullName: { givenName: "Ada", familyName: "Lovelace" },
      name: "Ada Lovelace",
    });

    expect(result.success).toBe(true);
  });

  it.each([
    {
      name: null,
      email: null,
      fullName: null,
    },
    {},
  ])(
    "accepts missing Apple profile fields on subsequent login (%j)",
    (optionalFields) => {
      const result = socialAuthInputSchema.safeParse({
        provider: "apple",
        identityToken: `eyJ${"token".repeat(12)}`,
        nonce: "private-nonce-value-123456",
        ...optionalFields,
      });

      expect(result.success).toBe(true);
    },
  );

  it("logs only validation paths, issue types, and body keys for invalid requests", async () => {
    const requestBody = {
      provider: "apple",
      identityToken: "secret-token-value",
      nonce: "short",
      email: "not-an-email",
      fullName: { givenName: "Secret Name" },
    };
    const requestLog = { error: vi.fn(), info: vi.fn() };
    const request = {
      body: requestBody,
      id: "invalid-request",
      log: requestLog,
    } as unknown as FastifyRequest;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as FastifyReply;

    await new SocialAuthController().login(request, reply);

    const logFields = requestLog.error.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(logFields);
    expect(logFields).toMatchObject({
      stage: "request_validation",
      bodyKeys: ["provider", "identityToken", "nonce", "email", "fullName"],
      validationErrors: expect.arrayContaining([
        { path: "identityToken", type: "too_small" },
        { path: "nonce", type: "too_small" },
        { path: "email", type: "invalid_string" },
      ]),
    });
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("Secret Name");
    expect(serialized).not.toContain("not-an-email");
    expect(serialized).not.toContain("short");
  });

  it("logs useful failure details while redacting sensitive values", async () => {
    const identityToken = `eyJ${"token".repeat(12)}`;
    const nonce = "private-nonce-value-123456";
    const email = "person@example.com";
    const name = "Sensitive User Name";
    mocks.signInWithSocialIdentity.mockRejectedValue(
      new SocialAuthError(
        `Audience mismatch for ${identityToken}, ${nonce}, ${email}, ${name}`,
        "INVALID_SOCIAL_TOKEN",
        401,
        "verify_claims",
        "SOCIAL_TOKEN_AUDIENCE_MISMATCH",
        { check: "aud", expected: ["google-client-id"], received: [email] },
      ),
    );

    const requestLog = { error: vi.fn(), info: vi.fn() };
    const request = {
      body: { provider: "google", identityToken, nonce, name },
      id: "request-123",
      log: requestLog,
    } as unknown as FastifyRequest;
    let responseStatus = 0;
    let responseBody: unknown;
    const reply = {
      status(status: number) {
        responseStatus = status;
        return this;
      },
      send(body: unknown) {
        responseBody = body;
        return this;
      },
    } as unknown as FastifyReply;

    await new SocialAuthController().login(request, reply);

    expect(responseStatus).toBe(401);
    expect(responseBody).toMatchObject({ code: "INVALID_SOCIAL_TOKEN" });
    expect(requestLog.error).toHaveBeenCalledOnce();
    const logFields = requestLog.error.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(logFields);
    expect(logFields).toMatchObject({
      event: "social_auth_failed",
      provider: "google",
      reqId: "request-123",
      errorName: "SocialAuthError",
      errorCode: "SOCIAL_TOKEN_AUDIENCE_MISMATCH",
      stage: "verify_claims",
      reason: "SOCIAL_TOKEN_AUDIENCE_MISMATCH",
    });
    expect(serialized).not.toContain(identityToken);
    expect(serialized).not.toContain(nonce);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(name);
    expect(serialized).toContain("[redacted-email]");
  });

  it("logs successful authentication with provider and request id", async () => {
    mocks.signInWithSocialIdentity.mockResolvedValue({
      id: "internal-id",
      publicId: "public-id",
      email: "person@example.com",
      name: "Test User",
      accessToken: "access",
      refreshToken: "refresh",
      expiresIn: 900,
    });
    const requestLog = { error: vi.fn(), info: vi.fn() };
    const request = {
      body: {
        provider: "apple",
        identityToken: `eyJ${"token".repeat(12)}`,
        nonce: "private-nonce-value-123456",
      },
      id: "request-success",
      log: requestLog,
    } as unknown as FastifyRequest;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as FastifyReply;

    await new SocialAuthController().login(request, reply);

    expect(requestLog.info).toHaveBeenCalledWith({
      event: "social_auth_succeeded",
      provider: "apple",
      reqId: "request-success",
    });
  });
});
