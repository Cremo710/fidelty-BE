import { databaseService } from "../services/databaseService.js";
import { ulid } from "ulid";
import type { CreateOfferInput } from "../validators/offerValidator.js";

export interface OfferDTO {
  id: string;
  bar_id: string;
  title: string;
  description: string | null;
  conditions: string | null;
  points_required: number;
  icon: string | null;
  valid_from: Date | null;
  valid_until: Date | null;
  is_active: boolean;
  required_loyalty_level: number;
  created_at: Date;
  updated_at: Date;
}

export class OfferRepository {
  /**
   * Crea una nuova offerta per un bar
   */
  async createOffer(barId: string, data: CreateOfferInput): Promise<string> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const id = ulid();
      const query = `
        INSERT INTO offers (
          id, bar_id, title, description, conditions,
          points_required, icon, valid_from, valid_until, is_active,
          required_loyalty_level, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
        RETURNING id
      `;

      const values = [
        id,
        barId,
        data.title,
        data.description ?? null,
        data.conditions ?? null,
        data.pointsRequired,
        data.icon ?? null,
        data.validFrom ?? null,
        data.validUntil ?? null,
        data.isActive ?? true,
        data.requiredLoyaltyLevel ?? 0,
      ];

      const result = await client.query(query, values);
      const offerId: string = result.rows[0].id;

      await client.query("COMMIT");
      console.log(`✅ Offerta creata con ID: ${offerId}`);
      return offerId;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante la creazione dell'offerta:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Recupera tutte le offerte di un bar
   */
  async getOffersByBarId(barId: string): Promise<OfferDTO[]> {
    try {
      const query = `
        SELECT * FROM offers WHERE bar_id = $1 ORDER BY created_at ASC
      `;
      const result = await databaseService.getPool().query(query, [barId]);
      return result.rows || [];
    } catch (error) {
      console.error("❌ Errore durante il recupero delle offerte:", error);
      throw error;
    }
  }

  /**
   * Recupera una singola offerta per ID (verifica proprietà del bar)
   */
  async findByIdAndBarId(id: string, barId: string): Promise<OfferDTO | null> {
    try {
      const query = "SELECT * FROM offers WHERE id = $1 AND bar_id = $2 LIMIT 1";
      const result = await databaseService.getPool().query(query, [id, barId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero dell'offerta:", error);
      throw error;
    }
  }

  async findById(id: string): Promise<OfferDTO | null> {
    try {
      const query = "SELECT * FROM offers WHERE id = $1 LIMIT 1";
      const result = await databaseService.getPool().query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero offerta per ID:", error);
      throw error;
    }
  }

  /**
   * Aggiorna un'offerta esistente
   */
  async updateOffer(id: string, barId: string, data: Partial<CreateOfferInput>): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const fields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (data.title !== undefined) { fields.push(`title = $${paramCount++}`); values.push(data.title); }
      if (data.description !== undefined) { fields.push(`description = $${paramCount++}`); values.push(data.description); }
      if (data.conditions !== undefined) { fields.push(`conditions = $${paramCount++}`); values.push(data.conditions); }
      if (data.pointsRequired !== undefined) { fields.push(`points_required = $${paramCount++}`); values.push(data.pointsRequired); }
      if (data.icon !== undefined) { fields.push(`icon = $${paramCount++}`); values.push(data.icon); }
      if (data.validFrom !== undefined) { fields.push(`valid_from = $${paramCount++}`); values.push(data.validFrom); }
      if (data.validUntil !== undefined) { fields.push(`valid_until = $${paramCount++}`); values.push(data.validUntil); }
      if (data.isActive !== undefined) { fields.push(`is_active = $${paramCount++}`); values.push(data.isActive); }
      if (data.requiredLoyaltyLevel !== undefined) { fields.push(`required_loyalty_level = $${paramCount++}`); values.push(data.requiredLoyaltyLevel); }

      if (fields.length === 0) { await client.query("COMMIT"); return true; }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id, barId);

      const query = `UPDATE offers SET ${fields.join(", ")} WHERE id = $${paramCount++} AND bar_id = $${paramCount} RETURNING id`;
      const result = await client.query(query, values);

      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante l'aggiornamento dell'offerta:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un'offerta
   */
  async deleteOffer(id: string, barId: string): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");
      const result = await client.query(
        "DELETE FROM offers WHERE id = $1 AND bar_id = $2 RETURNING id",
        [id, barId]
      );
      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export const offerRepository = new OfferRepository();
