import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  signInWithSocialIdentity,
  SocialAuthError,
} from "../services/socialAuthService.js";

const socialAuthInputSchema = z.object({
  provider: z.enum(["google", "apple"]),
  identityToken: z.string().min(20),
  nonce: z.string().min(16).max(256),
  name: z.string().trim().min(1).max(255).optional(),
});

export class SocialAuthController {
  async login(request: FastifyRequest, reply: FastifyReply) {
    const parsed = socialAuthInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        error: "Richiesta di accesso social non valida",
        code: "INVALID_SOCIAL_AUTH_REQUEST",
      });
    }

    try {
      const data = await signInWithSocialIdentity({
        ...parsed.data,
      });
      return reply.status(200).send({
        success: true,
        message: "Accesso social effettuato",
        data,
      });
    } catch (error) {
      if (error instanceof SocialAuthError) {
        return reply.status(error.statusCode).send({
          success: false,
          error: error.message,
          code: error.code,
        });
      }

      request.log.error({
        event: "social_auth_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return reply.status(500).send({
        success: false,
        error: "Errore durante l'accesso social",
        code: "SOCIAL_AUTH_ERROR",
      });
    }
  }
}

export const socialAuthController = new SocialAuthController();
