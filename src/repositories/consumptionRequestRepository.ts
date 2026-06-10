import { ulid } from "ulid";
import { databaseService } from "../services/databaseService.js";
import { loyaltyCardRepository } from "./loyaltyCardRepository.js";
import type { SignalFlag } from "../services/semaphoreService.js";

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
  // Soluzione B fields
  receipt_code_block1: string | null;
  receipt_code_block2: string | null;
  receipt_submitted_at: Date | null;
  semaphore_status: "green" | "yellow" | null;
  signal_flags: SignalFlag[];
  retroactive_flagged: boolean;
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
    receiptCodeBlock1?: string | null;
    receiptCodeBlock2?: string | null;
    semaphoreStatus?: "green" | "yellow" | null;
    signalFlags?: SignalFlag[];
    initialStatus?: "pending" | "credited";
  }): Promise<ConsumptionRequestDTO> {
    const status = input.initialStatus ?? "pending";
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
        receipt_code_block1,
        receipt_code_block2,
        receipt_submitted_at,
        semaphore_status,
        signal_flags,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              CASE WHEN $10 IS NOT NULL THEN CURRENT_TIMESTAMP ELSE NULL END,
              $12, $13, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const values = [
      ulid(),
      input.requesterUserId,
      input.barId,
      input.amount.toFixed(2),
      input.pointsPreview,
      status,
      input.qrCodeValue,
      input.requesterNameSnapshot || null,
      input.requesterEmailSnapshot || null,
      input.receiptCodeBlock1 || null,
      input.receiptCodeBlock2 || null,
      input.semaphoreStatus || null,
      JSON.stringify(input.signalFlags ?? []),
    ];

    const result = await databaseService.getPool().query(query, values);
    return result.rows[0];
  }

  /**
   * Credits a green request immediately within an existing transaction:
   * sets status='credited', adds points to loyalty card.
   */
  async creditInTransaction(
    client: import("pg").PoolClient,
    requestId: string,
    userId: string,
    barId: string,
    pointsToCredit: number,
  ): Promise<ConsumptionRequestDTO> {
    const updatedResult = await client.query<ConsumptionRequestDTO>(
      `UPDATE consumption_requests
       SET status = 'credited',
           approved_at = CURRENT_TIMESTAMP,
           updated_at  = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [requestId],
    );

    await loyaltyCardRepository.upsertCardInTransaction(client, userId, barId, pointsToCredit);

    return updatedResult.rows[0];
  }

  /**
   * Marks a previously-credited request as yellow (retroactive duplicate flag).
   * Feature-flagged behind FEATURE_RETROACTIVE_DUPLICATES env var.
   */
  async markAsRetroactivelyFlagged(
    client: import("pg").PoolClient,
    requestId: string,
    duplicateSignal: SignalFlag,
  ): Promise<void> {
    await client.query(
      `UPDATE consumption_requests
       SET status               = 'pending',
           semaphore_status     = 'yellow',
           retroactive_flagged  = TRUE,
           signal_flags         = signal_flags || $2::jsonb,
           approved_at          = NULL,
           updated_at           = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'credited'`,
      [requestId, JSON.stringify([duplicateSignal])],
    );
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

  /** Returns auto-credited (green) requests for the bar's daily log. */
  async listCreditedByBarId(barId: string, limitDays = 7): Promise<ConsumptionRequestDTO[]> {
    const query = `
      SELECT *
      FROM consumption_requests
      WHERE bar_id = $1
        AND status = 'credited'
        AND created_at >= CURRENT_TIMESTAMP - ($2 || ' days')::interval
      ORDER BY created_at DESC
    `;

    const result = await databaseService.getPool().query(query, [barId, limitDays]);
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
    correctedAmount?: number | null;
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

      if (!["pending"].includes(existing.status)) {
        throw new Error("CONSUMPTION_REQUEST_ALREADY_PROCESSED");
      }

      // If barista corrected the amount, recalculate points (100 pts per €)
      const finalAmount = (input.correctedAmount != null && input.correctedAmount > 0)
        ? input.correctedAmount
        : Number(existing.amount);
      const pointsEarned = Math.round(finalAmount * 100);

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
            amount = $3,
            points_preview = $4,
            approved_at = CURRENT_TIMESTAMP,
            rejected_at = NULL,
            processed_by_user_id = $2,
            rejection_reason = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *
        `,
        [input.requestId, input.processedByUserId, finalAmount.toFixed(2), pointsEarned],
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