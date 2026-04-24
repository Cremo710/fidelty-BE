import { ulid } from "ulid";
import { databaseService } from "../services/databaseService.js";

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
}

export const consumptionRequestRepository = new ConsumptionRequestRepository();