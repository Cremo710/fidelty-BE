import jwt from "jsonwebtoken";

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
  private readonly secret: string;

  constructor() {
    this.secret = process.env.OFFER_REDEMPTION_SECRET || process.env.JWT_SECRET || "your-secret-key";
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