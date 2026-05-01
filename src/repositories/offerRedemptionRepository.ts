import { ulid } from "ulid";
import type { PoolClient } from "pg";
import { databaseService } from "../services/databaseService.js";

type Queryable = Pick<PoolClient, "query"> | ReturnType<typeof databaseService.getPool>;

export interface OfferRedemptionDTO {
  id: string;
  user_id: string;
  bar_id: string;
  offer_id: string;
  status: "frozen" | "redeemed" | "expired" | "cancelled";
  points_amount: number;
  qr_nonce: string;
  expires_at: Date;
  frozen_at: Date;
  redeemed_at: Date | null;
  cancelled_at: Date | null;
  validated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OfferRedemptionWithOfferDTO extends OfferRedemptionDTO {
  offer_title: string | null;
  offer_description: string | null;
  user_name: string | null;
  user_email: string | null;
}

export interface LoyaltyPointsSnapshot {
  loyaltyCardId: number;
  totalPoints: number;
  frozenPoints: number;
  availablePoints: number;
}

export class OfferRedemptionRepository {
  async expireStaleRedemptions(executor: Queryable = databaseService.getPool()): Promise<number> {
    const result = await executor.query(`
      WITH expired AS (
        UPDATE offer_redemptions
        SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'frozen' AND expires_at <= CURRENT_TIMESTAMP
        RETURNING id
      )
      INSERT INTO offer_redemption_events (redemption_id, event_type, metadata)
      SELECT id, 'expired', jsonb_build_object('reason', 'ttl_elapsed')
      FROM expired
      RETURNING redemption_id
    `);

    return result.rowCount || 0;
  }

  async getUserBarPointsSnapshot(userId: string, barId: string): Promise<LoyaltyPointsSnapshot | null> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          lc.id AS loyalty_card_id,
          lc.points AS total_points,
          COALESCE(frozen.frozen_points, 0)::int AS frozen_points,
          GREATEST(lc.points - COALESCE(frozen.frozen_points, 0)::int, 0) AS available_points
        FROM loyalty_cards lc
        LEFT JOIN (
          SELECT user_id, bar_id, SUM(points_amount)::int AS frozen_points
          FROM offer_redemptions
          WHERE status = 'frozen'
            AND expires_at > CURRENT_TIMESTAMP
            AND user_id = $1
            AND bar_id = $2
          GROUP BY user_id, bar_id
        ) frozen ON frozen.user_id = lc.user_id AND frozen.bar_id = lc.bar_id
        WHERE lc.user_id = $1 AND lc.bar_id = $2
        LIMIT 1
      `,
      [userId, barId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      loyaltyCardId: Number(row.loyalty_card_id),
      totalPoints: Number(row.total_points) || 0,
      frozenPoints: Number(row.frozen_points) || 0,
      availablePoints: Number(row.available_points) || 0,
    };
  }

  async listActiveByUserBar(userId: string, barId: string): Promise<OfferRedemptionWithOfferDTO[]> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          r.*,
          o.title AS offer_title,
          o.description AS offer_description,
          u.name AS user_name,
          u.email AS user_email
        FROM offer_redemptions r
        LEFT JOIN offers o ON o.id = r.offer_id
        LEFT JOIN utenti u ON u.id = r.user_id
        WHERE r.user_id = $1
          AND r.bar_id = $2
          AND r.status = 'frozen'
          AND r.expires_at > CURRENT_TIMESTAMP
        ORDER BY r.created_at DESC
      `,
      [userId, barId],
    );

    return result.rows;
  }

  async findActiveByUserBarOffer(
    executor: Queryable,
    userId: string,
    barId: string,
    offerId: string,
  ): Promise<OfferRedemptionWithOfferDTO | null> {
    const result = await executor.query(
      `
        SELECT
          r.*,
          o.title AS offer_title,
          o.description AS offer_description,
          u.name AS user_name,
          u.email AS user_email
        FROM offer_redemptions r
        LEFT JOIN offers o ON o.id = r.offer_id
        LEFT JOIN utenti u ON u.id = r.user_id
        WHERE r.user_id = $1
          AND r.bar_id = $2
          AND r.offer_id = $3
          AND r.status = 'frozen'
          AND r.expires_at > CURRENT_TIMESTAMP
        ORDER BY r.created_at DESC
        LIMIT 1
      `,
      [userId, barId, offerId],
    );

    return result.rows[0] || null;
  }

  async createFrozenRedemption(
    executor: Queryable,
    input: {
      userId: string;
      barId: string;
      offerId: string;
      pointsAmount: number;
      expiresAt: Date;
      nonce: string;
    },
  ): Promise<OfferRedemptionDTO> {
    const result = await executor.query(
      `
        INSERT INTO offer_redemptions (
          id,
          user_id,
          bar_id,
          offer_id,
          status,
          points_amount,
          qr_nonce,
          expires_at,
          frozen_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'frozen', $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
      `,
      [
        ulid(),
        input.userId,
        input.barId,
        input.offerId,
        input.pointsAmount,
        input.nonce,
        input.expiresAt,
      ],
    );

    return result.rows[0];
  }

  async findByIdForUpdate(executor: Queryable, redemptionId: string): Promise<OfferRedemptionWithOfferDTO | null> {
    const result = await executor.query(
      `
        SELECT
          r.*,
          o.title AS offer_title,
          o.description AS offer_description,
          u.name AS user_name,
          u.email AS user_email
        FROM offer_redemptions r
        LEFT JOIN offers o ON o.id = r.offer_id
        LEFT JOIN utenti u ON u.id = r.user_id
        WHERE r.id = $1
        FOR UPDATE OF r
      `,
      [redemptionId],
    );

    return result.rows[0] || null;
  }

  async getLockedLoyaltyCard(executor: Queryable, userId: string, barId: string): Promise<{ id: number; points: number } | null> {
    const result = await executor.query(
      `
        SELECT id, points
        FROM loyalty_cards
        WHERE user_id = $1 AND bar_id = $2
        FOR UPDATE
      `,
      [userId, barId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      points: Number(row.points) || 0,
    };
  }

  async deductLoyaltyCardPoints(
    executor: Queryable,
    userId: string,
    barId: string,
    pointsAmount: number,
  ): Promise<number> {
    const result = await executor.query(
      `
        UPDATE loyalty_cards
        SET points = points - $3, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND bar_id = $2
        RETURNING points
      `,
      [userId, barId, pointsAmount],
    );

    return Number(result.rows[0]?.points) || 0;
  }

  async markRedeemed(executor: Queryable, redemptionId: string, validatedByUserId: string): Promise<void> {
    await executor.query(
      `
        UPDATE offer_redemptions
        SET
          status = 'redeemed',
          redeemed_at = CURRENT_TIMESTAMP,
          validated_by_user_id = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [redemptionId, validatedByUserId],
    );
  }

  async markExpired(executor: Queryable, redemptionId: string): Promise<void> {
    await executor.query(
      `
        UPDATE offer_redemptions
        SET status = 'expired', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [redemptionId],
    );
  }

  async logEvent(
    executor: Queryable,
    redemptionId: string,
    eventType: string,
    actorUserId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO offer_redemption_events (
          redemption_id,
          event_type,
          actor_user_id,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [redemptionId, eventType, actorUserId, JSON.stringify(metadata)],
    );
  }
}

export const offerRedemptionRepository = new OfferRedemptionRepository();