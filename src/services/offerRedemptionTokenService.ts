import jwt from "jsonwebtoken";
import { requireSecret } from "../utils/env.js";

export interface OfferRedemptionTokenPayload {
  redemptionId: string;
  userId: string;
  barId: string;
  offerId: string;
  nonce: string;
  type: "offer-redemption";
  iat?: number;
  exp?: number;
}

class OfferRedemptionTokenService {
  private get secret(): string {
    return requireSecret("OFFER_REDEMPTION_SECRET");
  }

  generateToken(payload: Omit<OfferRedemptionTokenPayload, "type" | "exp">, expiresAt: Date): string {
    return jwt.sign(
      {
        ...payload,
        type: "offer-redemption",
        exp: Math.floor(expiresAt.getTime() / 1000),
      },
      this.secret,
      {
        algorithm: "HS256",
      },
    );
  }

  verifyToken(token: string): OfferRedemptionTokenPayload | null {
    try {
      return jwt.verify(token, this.secret, {
        algorithms: ["HS256"],
      }) as OfferRedemptionTokenPayload;
    } catch (error) {
      console.error("❌ Errore verifica token redemption:", error);
      return null;
    }
  }
}

export const offerRedemptionTokenService = new OfferRedemptionTokenService();