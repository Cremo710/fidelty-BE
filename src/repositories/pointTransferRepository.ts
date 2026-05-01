import type { PoolClient } from "pg";
import { ulid } from "ulid";
import { databaseService } from "../services/databaseService.js";

type Queryable = Pick<PoolClient, "query">;

export interface SharedBarTransferContext {
  barId: string;
  barName: string;
  senderCardId: number;
  recipientCardId: number;
  senderTotalPoints: number;
  senderFrozenPoints: number;
  senderAvailablePoints: number;
  recipientPoints: number;
}

export class PointTransferRepository {
  async listSharedBarContexts(senderUserId: string, recipientUserId: string): Promise<SharedBarTransferContext[]> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          sender.bar_id AS "barId",
          bars.name AS "barName",
          sender.id AS "senderCardId",
          recipient.id AS "recipientCardId",
          sender.points AS "senderTotalPoints",
          COALESCE(frozen.frozen_points, 0)::int AS "senderFrozenPoints",
          GREATEST(sender.points - COALESCE(frozen.frozen_points, 0)::int, 0) AS "senderAvailablePoints",
          recipient.points AS "recipientPoints"
        FROM loyalty_cards sender
        JOIN loyalty_cards recipient
          ON recipient.bar_id = sender.bar_id
         AND recipient.user_id = $2
        JOIN bars ON bars.id = sender.bar_id
        LEFT JOIN (
          SELECT user_id, bar_id, SUM(points_amount)::int AS frozen_points
          FROM offer_redemptions
          WHERE status = 'frozen' AND expires_at > CURRENT_TIMESTAMP
          GROUP BY user_id, bar_id
        ) frozen ON frozen.user_id = sender.user_id AND frozen.bar_id = sender.bar_id
        WHERE sender.user_id = $1
        ORDER BY bars.name ASC
      `,
      [senderUserId, recipientUserId],
    );

    return result.rows.map((row) => ({
      ...row,
      senderCardId: Number(row.senderCardId),
      recipientCardId: Number(row.recipientCardId),
      senderTotalPoints: Number(row.senderTotalPoints) || 0,
      senderFrozenPoints: Number(row.senderFrozenPoints) || 0,
      senderAvailablePoints: Number(row.senderAvailablePoints) || 0,
      recipientPoints: Number(row.recipientPoints) || 0,
    }));
  }

  async listRecentTransfersBetween(userA: string, userB: string, limit = 10): Promise<any[]> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          pt.id,
          pt.sender_user_id AS "senderUserId",
          pt.recipient_user_id AS "recipientUserId",
          pt.points_amount AS "pointsAmount",
          pt.status,
          pt.completed_at AS "completedAt",
          bars.name AS "barName",
          sender.public_id AS "senderPublicId",
          recipient.public_id AS "recipientPublicId"
        FROM point_transfers pt
        JOIN bars ON bars.id = pt.bar_id
        JOIN utenti sender ON sender.id = pt.sender_user_id
        JOIN utenti recipient ON recipient.id = pt.recipient_user_id
        WHERE (pt.sender_user_id = $1 AND pt.recipient_user_id = $2)
           OR (pt.sender_user_id = $2 AND pt.recipient_user_id = $1)
        ORDER BY pt.created_at DESC
        LIMIT $3
      `,
      [userA, userB, limit],
    );

    return result.rows.map((row) => ({
      ...row,
      pointsAmount: Number(row.pointsAmount) || 0,
    }));
  }

  async getDailySentPoints(senderUserId: string): Promise<number> {
    const result = await databaseService.getPool().query(
      `
        SELECT COALESCE(SUM(points_amount), 0)::int AS total
        FROM point_transfers
        WHERE sender_user_id = $1
          AND status = 'completed'
          AND created_at >= CURRENT_DATE
          AND created_at < CURRENT_DATE + INTERVAL '1 day'
      `,
      [senderUserId],
    );

    return Number(result.rows[0]?.total) || 0;
  }

  async findByIdempotencyKey(senderUserId: string, idempotencyKey: string): Promise<any | null> {
    const result = await databaseService.getPool().query(
      `
        SELECT *
        FROM point_transfers
        WHERE sender_user_id = $1 AND idempotency_key = $2
        LIMIT 1
      `,
      [senderUserId, idempotencyKey],
    );

    return result.rows[0] || null;
  }

  async lockTransferCards(client: Queryable, senderUserId: string, recipientUserId: string, barId: string): Promise<any> {
    const senderResult = await client.query(
      `
        SELECT id, points
        FROM loyalty_cards
        WHERE user_id = $1 AND bar_id = $2
        FOR UPDATE
      `,
      [senderUserId, barId],
    );
    const recipientResult = await client.query(
      `
        SELECT id, points
        FROM loyalty_cards
        WHERE user_id = $1 AND bar_id = $2
        FOR UPDATE
      `,
      [recipientUserId, barId],
    );

    return {
      senderCard: senderResult.rows[0] || null,
      recipientCard: recipientResult.rows[0] || null,
    };
  }

  async getSenderFrozenPoints(client: Queryable, senderUserId: string, barId: string): Promise<number> {
    const result = await client.query(
      `
        SELECT COALESCE(SUM(points_amount), 0)::int AS frozen_points
        FROM offer_redemptions
        WHERE user_id = $1
          AND bar_id = $2
          AND status = 'frozen'
          AND expires_at > CURRENT_TIMESTAMP
      `,
      [senderUserId, barId],
    );

    return Number(result.rows[0]?.frozen_points) || 0;
  }

  async createPendingTransfer(
    client: Queryable,
    input: {
      senderUserId: string;
      recipientUserId: string;
      barId: string;
      senderCardId: number;
      recipientCardId: number;
      pointsAmount: number;
      idempotencyKey: string;
    },
  ): Promise<any> {
    const result = await client.query(
      `
        INSERT INTO point_transfers (
          id,
          sender_user_id,
          recipient_user_id,
          bar_id,
          sender_loyalty_card_id,
          recipient_loyalty_card_id,
          points_amount,
          status,
          idempotency_key,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, CURRENT_TIMESTAMP)
        RETURNING *
      `,
      [
        ulid(),
        input.senderUserId,
        input.recipientUserId,
        input.barId,
        input.senderCardId,
        input.recipientCardId,
        input.pointsAmount,
        input.idempotencyKey,
      ],
    );

    return result.rows[0];
  }

  async markCompleted(client: Queryable, transferId: string): Promise<void> {
    await client.query(
      `
        UPDATE point_transfers
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `,
      [transferId],
    );
  }

  async updateCards(client: Queryable, senderCardId: number, recipientCardId: number, pointsAmount: number): Promise<void> {
    await client.query(
      `UPDATE loyalty_cards SET points = points - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [senderCardId, pointsAmount],
    );
    await client.query(
      `UPDATE loyalty_cards SET points = points + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [recipientCardId, pointsAmount],
    );
  }

  async logEvent(client: Queryable, transferId: string, eventType: string, actorUserId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await client.query(
      `
        INSERT INTO point_transfer_events (transfer_id, event_type, actor_user_id, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [transferId, eventType, actorUserId, JSON.stringify(metadata)],
    );
  }
}

export const pointTransferRepository = new PointTransferRepository();