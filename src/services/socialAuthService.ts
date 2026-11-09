import { randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { ulid } from "ulid";
import { databaseService } from "./databaseService.js";
import { getAuthService } from "./authService.js";
import { userRepository } from "../repositories/userRepository.js";
import { summarizeBody } from "../utils/socialAuthDiagnostics.js";

export type SocialProvider = "google" | "apple";

type SocialIdentity = {
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
};

type SocialUser = {
  id: string;
  public_id: string;
  email: string;
  name: string;
};

export class SocialAuthError extends Error {
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
}

export class SocialAuthInternalError extends Error {
  readonly stage = "user_lookup_or_create";
  readonly reason = "SOCIAL_USER_OPERATION_FAILED";

  constructor(readonly originalError: unknown) {
    super("Social authentication operation failed");
    this.name = "SocialAuthInternalError";
  }
}

const publicIssuers: Record<SocialProvider, string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};

function createProviderKeys(url: string) {
  return createRemoteJWKSet(new URL(url), {
    [customFetch]: async (resource, options) => {
      let response: Response;
      try {
        response = await fetch(resource, options);
      } catch {
        throw new SocialAuthError(
          "Unable to retrieve identity provider keys",
          "INVALID_SOCIAL_TOKEN",
          401,
          "fetch_jwks",
          "SOCIAL_JWKS_FETCH_FAILED",
        );
      }

      if (!response.ok) {
        throw new SocialAuthError(
          "Unable to retrieve identity provider keys",
          "INVALID_SOCIAL_TOKEN",
          401,
          "fetch_jwks",
          "SOCIAL_JWKS_FETCH_FAILED",
          { httpStatus: response.status },
        );
      }

      return response;
    },
  });
}

const googleKeys = createProviderKeys(
  "https://www.googleapis.com/oauth2/v3/certs",
);
const appleKeys = createProviderKeys("https://appleid.apple.com/auth/keys");

export function getSocialAuthPublicConfig() {
  return {
    audiences: {
      google: getConfiguredAudiences("google"),
      apple: getConfiguredAudiences("apple"),
    },
    issuers: publicIssuers,
  };
}

function getConfiguredAudiences(provider: SocialProvider): string[] {
  const raw =
    provider === "google"
      ? process.env.GOOGLE_OAUTH_CLIENT_IDS
      : process.env.APPLE_CLIENT_IDS;
  return (
    raw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function getAllowedAudiences(provider: SocialProvider): string[] {
  const audiences = getConfiguredAudiences(provider);

  if (audiences.length === 0) {
    throw new SocialAuthError(
      `${provider} sign-in is not configured`,
      "SOCIAL_AUTH_NOT_CONFIGURED",
      503,
      "configuration",
      "SOCIAL_AUTH_NOT_CONFIGURED",
    );
  }

  return audiences;
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeClaimStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === "string");
}

function joseErrorInfo(error: unknown): {
  code?: string;
  claim?: string;
  message: string;
} {
  if (typeof error !== "object" || error === null) {
    return { message: "Invalid identity token" };
  }
  const candidate = error as {
    code?: unknown;
    claim?: unknown;
    message?: unknown;
  };
  return {
    code: typeof candidate.code === "string" ? candidate.code : undefined,
    claim: typeof candidate.claim === "string" ? candidate.claim : undefined,
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Invalid identity token",
  };
}

export async function verifyProviderToken(
  provider: SocialProvider,
  identityToken: string,
  nonce: string,
  keyResolver: JWTVerifyGetKey = provider === "google" ? googleKeys : appleKeys,
): Promise<SocialIdentity> {
  const audiences = getAllowedAudiences(provider);
  let decodedPayload: JWTPayload | undefined;
  try {
    decodeProtectedHeader(identityToken);
    decodedPayload = decodeJwt(identityToken);
  } catch {
    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      "decode_token",
      "SOCIAL_TOKEN_DECODE_FAILED",
      { check: "token_format" },
    );
  }

  let payload: JWTPayload;
  try {
    const { payload: verifiedPayload } = await jwtVerify(
      identityToken,
      keyResolver,
      {
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        maxTokenAge: "10m",
      },
    );
    payload = verifiedPayload;
    decodedPayload = verifiedPayload;
  } catch (error) {
    if (error instanceof SocialAuthError) throw error;
    const info = joseErrorInfo(error);
    let diagnosticCode = "SOCIAL_TOKEN_INVALID";
    let stage = "verify_signature";
    let check = info.claim;
    let diagnostics: Record<string, unknown> = {};

    if (
      info.code === "ERR_JWT_EXPIRED" ||
      info.claim === "exp" ||
      info.claim === "iat"
    ) {
      diagnosticCode = "SOCIAL_TOKEN_EXPIRED";
      stage = "verify_claims";
      check = info.claim === "iat" ? "iat" : "exp";
      diagnostics = {
        expected:
          check === "exp" ? "not expired" : "issued within the last 10 minutes",
        received:
          typeof decodedPayload?.[check] === "number"
            ? decodedPayload[check]
            : "missing",
      };
    } else if (info.claim === "nonce") {
      diagnosticCode = "SOCIAL_NONCE_MISMATCH";
      stage = "verify_claims";
      check = "nonce";
    } else if (info.claim === "sub") {
      diagnosticCode = "SOCIAL_SUB_MISSING";
      stage = "verify_claims";
      check = "sub";
    } else if (info.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      diagnosticCode = "SOCIAL_TOKEN_SIGNATURE_INVALID";
      check = "signature";
    }

    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      stage,
      diagnosticCode,
      {
        check,
        ...diagnostics,
        joseCode: info.code,
        joseMessage: info.message,
      },
    );
  }

  const expectedIssuers = publicIssuers[provider];
  const receivedIssuers = stringClaim(payload, "iss");
  if (!receivedIssuers || !expectedIssuers.includes(receivedIssuers)) {
    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      "verify_claims",
      "SOCIAL_TOKEN_ISSUER_MISMATCH",
      {
        check: "iss",
        expected: expectedIssuers,
        received: receivedIssuers ?? "missing",
      },
    );
  }

  const receivedAudiences = safeClaimStrings(payload.aud);
  if (!receivedAudiences.some((audience) => audiences.includes(audience))) {
    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      "verify_claims",
      "SOCIAL_TOKEN_AUDIENCE_MISMATCH",
      { check: "aud", expected: audiences, received: receivedAudiences },
    );
  }

  const subject = stringClaim(payload, "sub");
  if (!subject) {
    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      "verify_claims",
      "SOCIAL_SUB_MISSING",
      { check: "sub" },
    );
  }

  if (stringClaim(payload, "nonce") !== nonce) {
    throw new SocialAuthError(
      "Invalid social identity token",
      "INVALID_SOCIAL_TOKEN",
      401,
      "nonce_check",
      "SOCIAL_NONCE_MISMATCH",
      { check: "nonce" },
    );
  }

  const email = stringClaim(payload, "email")?.toLowerCase();
  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";

  return {
    subject,
    email,
    emailVerified,
    name: stringClaim(payload, "name"),
  };
}

export function requireVerifiedEmail(identity: SocialIdentity): string {
  if (!identity.email || !identity.emailVerified) {
    throw new SocialAuthError(
      "The provider did not return a verified email address",
      "VERIFIED_EMAIL_REQUIRED",
      400,
      "user_lookup_or_create",
      identity.email ? "SOCIAL_EMAIL_UNVERIFIED" : "SOCIAL_EMAIL_MISSING",
      { check: identity.email ? "email_verified" : "email" },
    );
  }
  return identity.email;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

/*
 * User lookup and account creation happen only after the provider identity has
 * been verified. Apple may omit email on subsequent logins for linked users.
 */
async function signInWithSocialIdentityInternal(input: {
  provider: SocialProvider;
  identityToken: string;
  nonce: string;
  name?: string;
  logInfo?: (fields: Record<string, unknown>) => void;
}) {
  const identity = await verifyProviderToken(
    input.provider,
    input.identityToken,
    input.nonce,
  );
  const pool = databaseService.getPool();
  const client = await pool.connect();
  let user: SocialUser | undefined;

  try {
    await client.query("BEGIN");

    const linked = await client.query<SocialUser>(
      `SELECT u.id, u.public_id, u.email, u.name
       FROM social_identities s
       JOIN utenti u ON u.id = s.user_id
       WHERE s.provider = $1 AND s.provider_subject = $2
       FOR UPDATE OF u`,
      [input.provider, identity.subject],
    );

    if (linked.rows[0]) {
      user = linked.rows[0];
      await client.query(
        `UPDATE social_identities
         SET last_login_at = CURRENT_TIMESTAMP
         WHERE provider = $1 AND provider_subject = $2`,
        [input.provider, identity.subject],
      );
    } else {
      const email = requireVerifiedEmail(identity);
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM utenti WHERE LOWER(email) = LOWER($1) FOR UPDATE",
        [email],
      );
      if (existing.rows[0]) {
        throw new SocialAuthError(
          "An account already exists with this email. Sign in using its existing sign-in method.",
          "SOCIAL_ACCOUNT_LINK_REQUIRED",
          409,
          "user_lookup_or_create",
          "SOCIAL_ACCOUNT_LINK_REQUIRED",
        );
      }

      const id = ulid();
      const publicId = ulid();
      const passwordHash = await getAuthService().hashPassword(
        randomBytes(32).toString("base64url"),
      );
      const displayName =
        input.name?.trim() || identity.name || email.split("@")[0];
      input.logInfo?.({
        event: "social_auth_user_create_values",
        provider: input.provider,
        table: "utenti",
        fields: summarizeBody({
          id,
          public_id: publicId,
          name: displayName,
          email,
          password: passwordHash,
          is_email_verified: true,
        }),
      });
      const created = await client.query<SocialUser>(
        `INSERT INTO utenti
           (id, public_id, name, email, password, is_email_verified, email_verified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, public_id, email, name`,
        [id, publicId, displayName, email, passwordHash],
      );
      user = created.rows[0];

      await client.query(
        `INSERT INTO social_identities (user_id, provider, provider_subject, email_snapshot)
         VALUES ($1, $2, $3, $4)`,
        [user.id, input.provider, identity.subject, email],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (!isUniqueConstraintError(error)) throw error;

    const linked = await pool.query<SocialUser>(
      `SELECT u.id, u.public_id, u.email, u.name
       FROM social_identities s
       JOIN utenti u ON u.id = s.user_id
       WHERE s.provider = $1 AND s.provider_subject = $2`,
      [input.provider, identity.subject],
    );
    if (linked.rows[0]) {
      user = linked.rows[0];
    } else {
      throw new SocialAuthError(
        "An account already exists with this email. Sign in using its existing sign-in method.",
        "SOCIAL_ACCOUNT_LINK_REQUIRED",
        409,
        "user_lookup_or_create",
        "SOCIAL_ACCOUNT_LINK_REQUIRED",
      );
    }
  } finally {
    client.release();
  }

  if (!user) {
    throw new Error("Social sign-in completed without a user");
  }

  const authService = getAuthService();
  const accessToken = authService.generateToken(user.id, user.email, "15m");
  const refreshToken = authService.generateRefreshToken(user.id, user.email);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await userRepository.saveRefreshToken(user.id, refreshToken, expiresAt);

  return {
    id: user.id,
    publicId: user.public_id,
    email: user.email,
    name: user.name,
    accessToken,
    refreshToken,
    expiresIn: 900,
  };
}

export async function signInWithSocialIdentity(input: {
  provider: SocialProvider;
  identityToken: string;
  nonce: string;
  name?: string;
  logInfo?: (fields: Record<string, unknown>) => void;
}) {
  try {
    return await signInWithSocialIdentityInternal(input);
  } catch (error) {
    if (
      error instanceof SocialAuthError ||
      error instanceof SocialAuthInternalError
    )
      throw error;
    throw new SocialAuthInternalError(error);
  }
}
