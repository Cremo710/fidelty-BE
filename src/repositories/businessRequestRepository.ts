import { databaseService } from "../services/databaseService.js";
import { ulid } from "ulid";

export interface BusinessRequestDTO {
  id: string;
  user_id: string;
  business_name: string;
  bar_name: string;
  address: string;
  vat_number: string;
  contact_email: string | null;
  phone: string | null;
  document_url: string | null;
  document_public_id: string | null;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class BusinessRequestRepository {
  async create(data: {
    userId: string;
    businessName: string;
    barName: string;
    address: string;
    vatNumber: string;
    contactEmail?: string | null;
    phone?: string | null;
    documentUrl?: string | null;
    documentPublicId?: string | null;
  }): Promise<BusinessRequestDTO> {
    const id = ulid();
    const query = `
      INSERT INTO business_requests (
        id, user_id, business_name, bar_name, address, vat_number,
        contact_email, phone, document_url, document_public_id,
        status, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', CURRENT_TIMESTAMP)
      RETURNING *
    `;
    const values = [
      id,
      data.userId,
      data.businessName,
      data.barName,
      data.address,
      data.vatNumber,
      data.contactEmail || null,
      data.phone || null,
      data.documentUrl || null,
      data.documentPublicId || null,
    ];
    const result = await databaseService.getPool().query(query, values);
    return result.rows[0];
  }

  async findByUserId(userId: string): Promise<BusinessRequestDTO | null> {
    const query = `
      SELECT * FROM business_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await databaseService.getPool().query(query, [userId]);
    return result.rows[0] || null;
  }

  async findById(id: string): Promise<BusinessRequestDTO | null> {
    const query = `SELECT * FROM business_requests WHERE id = $1`;
    const result = await databaseService.getPool().query(query, [id]);
    return result.rows[0] || null;
  }

  async listAll(status?: string): Promise<BusinessRequestDTO[]> {
    let query = `SELECT br.*, u.name as user_name, u.email as user_email
                 FROM business_requests br
                 JOIN utenti u ON u.id = br.user_id`;
    const values: string[] = [];

    if (status) {
      query += ` WHERE br.status = $1`;
      values.push(status);
    }

    query += ` ORDER BY br.created_at DESC`;

    const result = await databaseService.getPool().query(query, values);
    return result.rows;
  }

  async updateStatus(
    id: string,
    status: "approved" | "rejected",
    rejectionReason?: string
  ): Promise<BusinessRequestDTO | null> {
    const query = `
      UPDATE business_requests
      SET status = $1,
          rejection_reason = $2,
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `;
    const values = [status, rejectionReason || null, id];
    const result = await databaseService.getPool().query(query, values);
    return result.rows[0] || null;
  }

  async hasPendingRequest(userId: string): Promise<boolean> {
    const query = `
      SELECT 1 FROM business_requests
      WHERE user_id = $1 AND status = 'pending'
      LIMIT 1
    `;
    const result = await databaseService.getPool().query(query, [userId]);
    return result.rows.length > 0;
  }
}

export const businessRequestRepository = new BusinessRequestRepository();
