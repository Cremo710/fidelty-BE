import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  signInWithSocialIdentity,
  SocialAuthError,
  SocialAuthInternalError,
  type SocialProvider,
} from "../services/socialAuthService.js";

export const socialAuthInputSchema = z.object({
  provider: z.enum(["google", "apple"]),
  identityToken: z.string().min(20),
  nonce: z.string().min(16).max(256),
  name: z.string().trim().min(1).max(255).nullable().optional(),
  email: z.string().email().nullable().optional(),
  fullName: z
    .object({
      givenName: z.string().nullable().optional(),
      familyName: z.string().nullable().optional(),
      middleName: z.string().nullable().optional(),
      namePrefix: z.string().nullable().optional(),
      nameSuffix: z.string().nullable().optional(),
      nickname: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

function sanitizeLogText(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.length >= 3)
      sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-token]",
    )
    .replace(/\bKey\s+\([^)]*\)\s*=\s*\([^)]*\)/gi, "Key ([redacted])")
    .slice(0, 2000);
}

function sanitizeLogValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return sanitizeLogText(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value))
    return value.map((item) => sanitizeLogValue(item, secrets));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeLogValue(item, secrets),
      ]),
    );
  }
  return undefined;
}

function getSocialProvider(body: unknown): SocialProvider | "unknown" {
  if (typeof body !== "object" || body === null || !("provider" in body))
    return "unknown";
  return body.provider === "apple" || body.provider === "google"
    ? body.provider
    : "unknown";
}

export class SocialAuthController {
  async login(request: FastifyRequest, reply: FastifyReply) {
    const parsed = socialAuthInputSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.error({
        event: "social_auth_failed",
        provider: getSocialProvider(request.body),
        reqId: request.id,
        errorName: "SocialAuthRequestValidationError",
        errorMessage: "Invalid social authentication request",
        errorCode: "INVALID_SOCIAL_AUTH_REQUEST",
        stage: "request_validation",
        reason: "SOCIAL_AUTH_REQUEST_INVALID",
        validationErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          type: issue.code,
        })),
        bodyKeys:
          typeof request.body === "object" && request.body !== null
            ? Object.keys(request.body)
            : [],
      });
      return reply.status(400).send({
        success: false,
        error: "Richiesta di accesso social non valida",
        code: "INVALID_SOCIAL_AUTH_REQUEST",
      });
    }

    try {
      const data = await signInWithSocialIdentity({
        provider: parsed.data.provider,
        identityToken: parsed.data.identityToken,
        nonce: parsed.data.nonce,
        name: parsed.data.name ?? undefined,
      });
      request.log.info({
        event: "social_auth_succeeded",
        provider: parsed.data.provider,
        reqId: request.id,
      });
      return reply.status(200).send({
        success: true,
        message: "Accesso social effettuato",
        data,
      });
    } catch (error) {
      const secrets = [
        parsed.data.identityToken,
        parsed.data.nonce,
        parsed.data.name ?? "",
      ];
      const socialError = error instanceof SocialAuthError ? error : undefined;
      const internalError =
        error instanceof SocialAuthInternalError ? error : undefined;
      const sourceError = internalError?.originalError ?? error;
      const errorMessage =
        sourceError instanceof Error
          ? sourceError.message
          : "Unknown social authentication error";
      const errorCode =
        socialError?.reason ??
        socialError?.code ??
        (typeof sourceError === "object" &&
        sourceError !== null &&
        "code" in sourceError &&
        typeof sourceError.code === "string"
          ? sourceError.code
          : undefined);
      const errorStack =
        sourceError instanceof Error ? sourceError.stack : undefined;
      const diagnostics = socialError?.diagnostics;

      request.log.error({
        event: "social_auth_failed",
        provider: parsed.data.provider,
        reqId: request.id,
        errorName:
          sourceError instanceof Error
            ? sanitizeLogText(sourceError.name, secrets)
            : "UnknownError",
        errorMessage: sanitizeLogText(errorMessage, secrets),
        errorCode: errorCode ? sanitizeLogText(errorCode, secrets) : undefined,
        stage: socialError?.stage ?? internalError?.stage ?? "unknown",
        reason: socialError?.reason ?? internalError?.reason,
        diagnostics: diagnostics
          ? sanitizeLogValue(diagnostics, secrets)
          : undefined,
        ...(process.env.NODE_ENV !== "production" && errorStack
          ? { stack: sanitizeLogText(errorStack, secrets) }
          : {}),
      });

      if (error instanceof SocialAuthError) {
        return reply.status(error.statusCode).send({
          success: false,
          error: error.message,
          code: error.code,
        });
      }

      return reply.status(500).send({
        success: false,
        error: "Errore durante l'accesso social",
        code: "SOCIAL_AUTH_ERROR",
      });
    }
  }
}

export const socialAuthController = new SocialAuthController();
