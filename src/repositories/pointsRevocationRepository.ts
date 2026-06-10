import { ulid } from "ulid";
import type { PoolClient } from "pg";
import { databaseService } from "../services/databaseService.js";
import { loyaltyCardRepository } from "./loyaltyCardRepository.js";

export interface PointsRevocationDTO {
  id: string;
  user_id: string;
  bar_id: string;
  consumption_request_id: string | null;
  points_amount: number;
  reason: string;
  revoked_by_admin_id: string;
  created_at: Date;
}

export class PointsRevocationRepository {
  async create(input: {
    userId: string;
    barId: string;
    consumptionRequestId?: string | null;
    pointsAmount: number;
    reason: string;
    revokedByAdminId: string;
  }): Promise<PointsRevocationDTO> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      // Deduct points from loyalty card (floor at 0)
      await client.query(
        `UPDATE loyalty_cards
         SET points     = GREATEST(points - $1, 0),
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2 AND bar_id = $3`,
        [input.pointsAmount, input.userId, input.barId],
      );

      const revocation = await client.query<PointsRevocationDTO>(
        `INSERT INTO points_revocations
           (id, user_id, bar_id, consumption_request_id, points_amount, reason, revoked_by_admin_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          ulid(),
          input.userId,
          input.barId,
          input.consumptionRequestId || null,
          input.pointsAmount,
          input.reason,
          input.revokedByAdminId,
        ],
      );

      await client.query("COMMIT");
      return revocation.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listByUserAndBar(userId: string, barId: string): Promise<PointsRevocationDTO[]> {
    const result = await databaseService.getPool().query(
      `SELECT * FROM points_revocations
       WHERE user_id = $1 AND bar_id = $2
       ORDER BY created_at DESC`,
      [userId, barId],
    );
    return result.rows;
  }
}

export const pointsRevocationRepository = new PointsRevocationRepository();
