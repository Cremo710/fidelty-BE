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
  cover_image_url: string | null;
  cover_image_public_id: string | null;
  logo_url: string | null;
  logo_public_id: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  website: string | null;
  card_background_image_url: string | null;
  card_background_image_public_id: string | null;
  card_color: string | null;
  card_use_cover: boolean;
  offers_json: unknown[];
  opening_hours_json: unknown[];
  latitude: number | null;
  longitude: number | null;
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
    coverImageUrl?: string | null;
    coverImagePublicId?: string | null;
    logoUrl?: string | null;
    logoPublicId?: string | null;
    instagram?: string | null;
    facebook?: string | null;
    tiktok?: string | null;
    website?: string | null;
    cardBackgroundImageUrl?: string | null;
    cardBackgroundImagePublicId?: string | null;
    cardColor?: string | null;
    cardUseCover?: boolean;
    offers?: unknown[];
    openingHours?: unknown[];
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<BusinessRequestDTO> {
    const id = ulid();
    const query = `
      INSERT INTO business_requests (
        id, user_id, business_name, bar_name, address, vat_number,
        contact_email, phone, document_url, document_public_id,
        cover_image_url, cover_image_public_id, logo_url, logo_public_id,
        instagram, facebook, tiktok, website,
        card_background_image_url, card_background_image_public_id,
        card_color, card_use_cover, offers_json, opening_hours_json,
        latitude, longitude,
        status, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18,
        $19, $20,
        $21, $22, $23::jsonb, $24::jsonb,
        $25, $26,
        'pending', CURRENT_TIMESTAMP
      )
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
      data.coverImageUrl || null,
      data.coverImagePublicId || null,
      data.logoUrl || null,
      data.logoPublicId || null,
      data.instagram || null,
      data.facebook || null,
      data.tiktok || null,
      data.website || null,
      data.cardBackgroundImageUrl || null,
      data.cardBackgroundImagePublicId || null,
      data.cardColor || null,
      data.cardUseCover || false,
      JSON.stringify(data.offers || []),
      JSON.stringify(data.openingHours || []),
      data.latitude ?? null,
      data.longitude ?? null,
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
