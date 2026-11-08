import { randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ulid } from "ulid";
import { databaseService } from "./databaseService.js";
import { getAuthService } from "./authService.js";
import { userRepository } from "../repositories/userRepository.js";

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
  ) {
    super(message);
    this.name = "SocialAuthError";
  }
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const appleKeys = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

function getAllowedAudiences(provider: SocialProvider): string[] {
  const raw = provider === "google"
    ? process.env.GOOGLE_OAUTH_CLIENT_IDS
    : process.env.APPLE_CLIENT_IDS;
  const audiences = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];

  if (audiences.length === 0) {
    throw new SocialAuthError(
      `${provider} sign-in is not configured`,
      "SOCIAL_AUTH_NOT_CONFIGURED",
      503,
    );
  }

  return audiences;
}

function stringClaim(payload: JWTPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function verifyProviderToken(
  provider: SocialProvider,
  identityToken: string,
  nonce: string,
): Promise<SocialIdentity> {
  try {
    const audiences = getAllowedAudiences(provider);
    const { payload } = await jwtVerify(
      identityToken,
      provider === "google" ? googleKeys : appleKeys,
      {
        issuer: provider === "google"
          ? ["https://accounts.google.com", "accounts.google.com"]
          : "https://appleid.apple.com",
        audience: audiences,
        requiredClaims: ["sub", "iat", "exp", "nonce"],
        maxTokenAge: "10m",
      },
    );

    const subject = stringClaim(payload, "sub");
    if (!subject || stringClaim(payload, "nonce") !== nonce) {
      throw new SocialAuthError("Invalid social identity token", "INVALID_SOCIAL_TOKEN", 401);
    }

    const email = stringClaim(payload, "email")?.toLowerCase();
    const emailVerified = payload.email_verified === true || payload.email_verified === "true";

    return {
      subject,
      email,
      emailVerified,
      name: stringClaim(payload, "name"),
    };
  } catch (error) {
    if (error instanceof SocialAuthError) throw error;
    throw new SocialAuthError("Invalid social identity token", "INVALID_SOCIAL_TOKEN", 401);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}

export async function signInWithSocialIdentity(input: {
  provider: SocialProvider;
  identityToken: string;
  nonce: string;
  name?: string;
}) {
  const identity = await verifyProviderToken(input.provider, input.identityToken, input.nonce);
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
      if (!identity.email || !identity.emailVerified) {
        throw new SocialAuthError(
          "The provider did not return a verified email address",
          "VERIFIED_EMAIL_REQUIRED",
          400,
        );
      }

      const existing = await client.query<{ id: string }>(
        "SELECT id FROM utenti WHERE LOWER(email) = LOWER($1) FOR UPDATE",
        [identity.email],
      );
      if (existing.rows[0]) {
        throw new SocialAuthError(
          "An account already exists with this email. Sign in using its existing sign-in method.",
          "SOCIAL_ACCOUNT_LINK_REQUIRED",
          409,
        );
      }

      const id = ulid();
      const publicId = ulid();
      const passwordHash = await getAuthService().hashPassword(randomBytes(32).toString("base64url"));
      const displayName = input.name?.trim() || identity.name || identity.email.split("@")[0];
      const created = await client.query<SocialUser>(
        `INSERT INTO utenti
           (id, public_id, name, email, password, is_email_verified, email_verified_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, public_id, email, name`,
        [id, publicId, displayName, identity.email, passwordHash],
      );
      user = created.rows[0];

      await client.query(
        `INSERT INTO social_identities (user_id, provider, provider_subject, email_snapshot)
         VALUES ($1, $2, $3, $4)`,
        [user.id, input.provider, identity.subject, identity.email],
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
