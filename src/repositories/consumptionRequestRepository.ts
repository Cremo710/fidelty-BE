import { ulid } from "ulid";
import { databaseService } from "../services/databaseService.js";
import { loyaltyCardRepository } from "./loyaltyCardRepository.js";

export interface ConsumptionRequestDTO {
  id: string;
  requester_user_id: string;
  bar_id: string;
  amount: string;
  points_preview: number;
  status: string;
  qr_code_value: string;
  requester_name_snapshot: string | null;
  requester_email_snapshot: string | null;
  approved_at: Date | null;
  rejected_at: Date | null;
  processed_by_user_id: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConsumptionRequestWithBarDTO extends ConsumptionRequestDTO {
  bar_name: string | null;
  bar_business_name: string | null;
  bar_address: string | null;
  bar_logo: string | null;
  bar_piva: string | null;
}

export class ConsumptionRequestRepository {
  async createRequest(input: {
    requesterUserId: string;
    barId: string;
    amount: number;
    pointsPreview: number;
    qrCodeValue: string;
    requesterNameSnapshot?: string | null;
    requesterEmailSnapshot?: string | null;
  }): Promise<ConsumptionRequestDTO> {
    const query = `
      INSERT INTO consumption_requests (
        id,
        requester_user_id,
        bar_id,
        amount,
        points_preview,
        status,
        qr_code_value,
        requester_name_snapshot,
        requester_email_snapshot,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const values = [
      ulid(),
      input.requesterUserId,
      input.barId,
      input.amount.toFixed(2),
      input.pointsPreview,
      input.qrCodeValue,
      input.requesterNameSnapshot || null,
      input.requesterEmailSnapshot || null,
    ];

    const result = await databaseService.getPool().query(query, values);
    return result.rows[0];
  }

  async listPendingByBarId(barId: string): Promise<ConsumptionRequestDTO[]> {
    const query = `
      SELECT *
      FROM consumption_requests
      WHERE bar_id = $1 AND status = 'pending'
      ORDER BY created_at DESC
    `;

    const result = await databaseService.getPool().query(query, [barId]);
    return result.rows;
  }

  async listByRequesterUserId(userId: string): Promise<ConsumptionRequestWithBarDTO[]> {
    const query = `
      SELECT
        cr.*,
        b.name AS bar_name,
        b.merchant_name AS bar_business_name,
        b.address AS bar_address,
        b.logo AS bar_logo,
        b.iva AS bar_piva
      FROM consumption_requests cr
      LEFT JOIN bars b ON b.id = cr.bar_id
      WHERE cr.requester_user_id = $1
      ORDER BY cr.created_at DESC
    `;

    const result = await databaseService.getPool().query(query, [userId]);
    return result.rows;
  }

  async approvePendingRequest(input: {
    requestId: string;
    barId: string;
    processedByUserId: string;
    barName: string;
    barAddress: string | null;
    barPiva: string;
  }): Promise<ConsumptionRequestDTO> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const existingResult = await client.query<ConsumptionRequestDTO>(
        `
          SELECT *
          FROM consumption_requests
          WHERE id = $1 AND bar_id = $2
          FOR UPDATE
        `,
        [input.requestId, input.barId],
      );

      const existing = existingResult.rows[0];
      if (!existing) {
        throw new Error("CONSUMPTION_REQUEST_NOT_FOUND");
      }

      if (existing.status !== "pending") {
        throw new Error("CONSUMPTION_REQUEST_ALREADY_PROCESSED");
      }

      const pointsEarned = Number(existing.points_preview) || Math.round(Number(existing.amount) * 100);

      await loyaltyCardRepository.upsertCardInTransaction(
        client,
        existing.requester_user_id,
        existing.bar_id,
        pointsEarned,
      );

      const updatedResult = await client.query<ConsumptionRequestDTO>(
        `
          UPDATE consumption_requests
          SET
            status = 'approved',
            approved_at = CURRENT_TIMESTAMP,
            rejected_at = NULL,
            processed_by_user_id = $2,
            rejection_reason = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `,
        [input.requestId, input.processedByUserId],
      );

      await client.query("COMMIT");
      return updatedResult.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectPendingRequest(input: {
    requestId: string;
    barId: string;
    processedByUserId: string;
    rejectionReason?: string | null;
  }): Promise<ConsumptionRequestDTO> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const existingResult = await client.query<ConsumptionRequestDTO>(
        `
          SELECT *
          FROM consumption_requests
          WHERE id = $1 AND bar_id = $2
          FOR UPDATE
        `,
        [input.requestId, input.barId],
      );

      const existing = existingResult.rows[0];
      if (!existing) {
        throw new Error("CONSUMPTION_REQUEST_NOT_FOUND");
      }

      if (existing.status !== "pending") {
        throw new Error("CONSUMPTION_REQUEST_ALREADY_PROCESSED");
      }

      const updatedResult = await client.query<ConsumptionRequestDTO>(
        `
          UPDATE consumption_requests
          SET
            status = 'rejected',
            approved_at = NULL,
            rejected_at = CURRENT_TIMESTAMP,
            processed_by_user_id = $2,
            rejection_reason = $3,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `,
        [input.requestId, input.processedByUserId, input.rejectionReason || null],
      );

      await client.query("COMMIT");
      return updatedResult.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const consumptionRequestRepository = new ConsumptionRequestRepository();