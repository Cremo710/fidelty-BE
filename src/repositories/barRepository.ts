import { databaseService } from "../services/databaseService.js";
import { ulid } from "ulid";

export interface BarDTO {
  id: string;
  user_id: string;
  iva: string;
  merchant_name: string;
  name: string;
  address: string;
  image: string | null;
  logo: string | null;
  contact_email: string | null;
  phone: string | null;
  instagram: string | null;
  facebook: string | null;
  tiktok: string | null;
  website: string | null;
  card_background_image: string | null;
  card_color: string | null;
  card_use_cover: boolean;
  latitude: number | null;
  longitude: number | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository pattern per l'accesso ai dati dei bar
 * Astrae la logica di interazione con il database
 */
export class BarRepository {
  private async hasGeoColumns(): Promise<boolean> {
    try {
      const query = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'bars'
          AND column_name IN ('latitude', 'longitude')
      `;
      const result = await databaseService.getPool().query(query);
      const columns = new Set(result.rows.map((row: any) => row.column_name));
      return columns.has("latitude") && columns.has("longitude");
    } catch (error) {
      console.warn("⚠️ Impossibile verificare colonne geografiche bars:", error);
      return false;
    }
  }

  /**
   * Salva un nuovo bar nel database
   * @param bar - Dati del bar {userId, piva, merchantName, name, address, image}
   * @returns ID del bar creato
   */
  async createBar(bar: {
    userId: string;
    piva: string;
    merchantName: string;
    name: string;
    address: string;
    image?: string | null;
    logo?: string | null;
    contactEmail?: string | null;
    phone?: string | null;
    instagram?: string | null;
    facebook?: string | null;
    tiktok?: string | null;
    website?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<string> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const id = ulid();
      const query = `
        INSERT INTO bars (
          id, user_id, iva, merchant_name, name, address,
          latitude, longitude, image, logo,
          contact_email, phone, instagram, facebook, tiktok, website,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
        RETURNING id
      `;

      const values = [
        id,
        bar.userId,
        bar.piva,
        bar.merchantName,
        bar.name,
        bar.address,
        bar.latitude ?? null,
        bar.longitude ?? null,
        bar.image || null,
        bar.logo || null,
        bar.contactEmail || null,
        bar.phone || null,
        bar.instagram || null,
        bar.facebook || null,
        bar.tiktok || null,
        bar.website || null,
      ];

      const result = await client.query(query, values);
      const barId: string = result.rows[0].id;

      await client.query("COMMIT");
      console.log(`✅ Bar creato con ID: ${barId}`);
      return barId;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante la creazione del bar:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Recupera un bar per ID
   * @param id - ID del bar
   * @returns Dati del bar oppure null
   */
  async findById(id: string): Promise<BarDTO | null> {
    try {
      const query = "SELECT * FROM bars WHERE id = $1";
      const result = await databaseService.getPool().query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero del bar per ID:", error);
      throw error;
    }
  }

  /**
   * Recupera un bar per user_id
   * @param userId - ID dell'utente proprietario
   * @returns Dati del bar oppure null
   */
  async findByUserId(userId: string): Promise<BarDTO | null> {
    try {
      const query = "SELECT * FROM bars WHERE user_id = $1";
      const result = await databaseService.getPool().query(query, [userId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero del bar per user_id:", error);
      throw error;
    }
  }

  /**
   * Recupera un bar per partita IVA
   */
  async findByPiva(piva: string): Promise<BarDTO | null> {
    try {
      const query = "SELECT * FROM bars WHERE iva = $1 LIMIT 1";
      const result = await databaseService.getPool().query(query, [piva]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero del bar per P.IVA:", error);
      throw error;
    }
  }

  /**
   * Recupera tutti i bar con lat/lng per mappa
   */
  async getAllBars(): Promise<Array<{
    id: string;
    user_id: string;
    iva: string;
    name: string;
    merchant_name: string;
    address: string;
    image: string | null;
    logo: string | null;
    latitude: number | null;
    longitude: number | null;
    created_at: Date;
    updated_at: Date;
  }>> {
    try {
      const includeGeoColumns = await this.hasGeoColumns();

      const query = `
        SELECT
          id,
          user_id,
          iva,
          merchant_name,
          name,
          address,
          image,
          logo,
          ${includeGeoColumns ? "latitude" : "NULL::double precision AS latitude"},
          ${includeGeoColumns ? "longitude" : "NULL::double precision AS longitude"},
          created_at,
          updated_at
        FROM bars
        ORDER BY id ASC
      `;
      const result = await databaseService.getPool().query(query);
      return result.rows || [];
    } catch (error) {
      console.error('❌ Errore durante il recupero dei bar:', error);
      throw error;
    }
  }

  /**
   * Verifica se una P.IVA è già registrata
   * @param piva - P.IVA da verificare
   * @returns true se la P.IVA esiste, false altrimenti
   */
  async pivaExists(piva: string): Promise<boolean> {
    try {
      const query = "SELECT 1 FROM bars WHERE iva = $1 LIMIT 1";
      const result = await databaseService.getPool().query(query, [piva]);
      return result.rows.length > 0;
    } catch (error) {
      console.error("❌ Errore durante la verifica della P.IVA:", error);
      throw error;
    }
  }

  /**
   * Verifica se un'IVA è già registrata (deprecato, usa pivaExists)
   * @param iva - IVA da verificare
   * @returns true se l'IVA esiste, false altrimenti
   */
  async ivaExists(iva: string): Promise<boolean> {
    return this.pivaExists(iva);
  }

  /**
   * Aggiorna i dati di un bar
   * @param id - ID del bar
   * @param updates - Campi da aggiornare
   * @returns true se l'aggiornamento è stato effettuato
   */
  async updateBar(id: string, updates: Partial<BarDTO>): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const fields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.iva) {
        fields.push(`iva = $${paramCount++}`);
        values.push(updates.iva);
      }
      if (updates.merchant_name) {
        fields.push(`merchant_name = $${paramCount++}`);
        values.push(updates.merchant_name);
      }
      if (updates.name) {
        fields.push(`name = $${paramCount++}`);
        values.push(updates.name);
      }
      if (updates.address) {
        fields.push(`address = $${paramCount++}`);
        values.push(updates.address);
      }
      if (updates.image) {
        fields.push(`image = $${paramCount++}`);
        values.push(updates.image);
      }

      if (fields.length === 0) {
        await client.query("COMMIT");
        return true;
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE bars SET ${fields.join(", ")} WHERE id = $${paramCount} RETURNING id`;
      const result = await client.query(query, values);

      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante l'aggiornamento del bar:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Aggiorna la configurazione della card del bar
   */
  async updateCardConfig(barId: string, config: {
    cardBackgroundImage?: string | null;
    cardColor?: string | null;
    cardUseCover?: boolean;
  }): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const fields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (config.cardBackgroundImage !== undefined) {
        fields.push(`card_background_image = $${paramCount++}`);
        values.push(config.cardBackgroundImage);
      }
      if (config.cardColor !== undefined) {
        fields.push(`card_color = $${paramCount++}`);
        values.push(config.cardColor);
      }
      if (config.cardUseCover !== undefined) {
        fields.push(`card_use_cover = $${paramCount++}`);
        values.push(config.cardUseCover);
      }

      if (fields.length === 0) {
        await client.query("COMMIT");
        return true;
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(barId);

      const query = `UPDATE bars SET ${fields.join(", ")} WHERE id = $${paramCount} RETURNING id`;
      const result = await client.query(query, values);

      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante l'aggiornamento della config card:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un bar
   * @param id - ID del bar da eliminare
   * @returns true se l'eliminazione è stata effettuata
   */
  async deleteBar(id: string): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const query = "DELETE FROM bars WHERE id = $1 RETURNING id";
      const result = await client.query(query, [id]);

      await client.query("COMMIT");
      console.log(`✅ Bar eliminato con ID: ${id}`);
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante l'eliminazione del bar:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Crea un bar con tutti i dati correlati (card config, offerte, orari)
   * in un'unica transazione atomica. Se qualcosa fallisce, nessun dato viene salvato.
   */
  async createBarComplete(data: {
    userId: string;
    piva: string;
    merchantName: string;
    name: string;
    address: string;
    image?: string | null;
    logo?: string | null;
    contactEmail?: string | null;
    phone?: string | null;
    instagram?: string | null;
    facebook?: string | null;
    tiktok?: string | null;
    website?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    cardColor?: string | null;
    cardBackgroundImage?: string | null;
    cardUseCover?: boolean;
    offers?: Array<{
      title: string;
      description?: string | null;
      conditions?: string | null;
      pointsRequired: number;
      isActive?: boolean;
    }>;
    openingHours?: Array<{
      dayOfWeek: number;
      isClosed: boolean;
      timeRanges: Array<{ open: string; close: string }>;
    }> | null;
  }): Promise<string> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      // 1. Crea il bar
      const barId = ulid();
      const barQuery = `
        INSERT INTO bars (
          id, user_id, iva, merchant_name, name, address,
          latitude, longitude, image, logo,
          contact_email, phone, instagram, facebook, tiktok, website,
          card_background_image, card_color, card_use_cover,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, CURRENT_TIMESTAMP)
        RETURNING id
      `;
      const barValues = [
        barId,
        data.userId,
        data.piva,
        data.merchantName,
        data.name,
        data.address,
        data.latitude ?? null,
        data.longitude ?? null,
        data.image || null,
        data.logo || null,
        data.contactEmail || null,
        data.phone || null,
        data.instagram || null,
        data.facebook || null,
        data.tiktok || null,
        data.website || null,
        data.cardBackgroundImage || null,
        data.cardColor || null,
        data.cardUseCover ?? false,
      ];
      await client.query(barQuery, barValues);

      // 2. Crea le offerte (se presenti)
      if (data.offers && data.offers.length > 0) {
        for (const offer of data.offers) {
          const offerId = ulid();
          await client.query(
            `INSERT INTO offers (id, bar_id, title, description, conditions, points_required, is_active, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
            [
              offerId,
              barId,
              offer.title,
              offer.description ?? null,
              offer.conditions ?? null,
              offer.pointsRequired,
              offer.isActive ?? true,
            ]
          );
        }
      }

      // 3. Salva gli orari (se presenti)
      if (data.openingHours && data.openingHours.length > 0) {
        for (const day of data.openingHours) {
          await client.query(
            `INSERT INTO opening_hours (bar_id, day_of_week, is_closed, time_ranges, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (bar_id, day_of_week) DO UPDATE SET
               is_closed = EXCLUDED.is_closed,
               time_ranges = EXCLUDED.time_ranges,
               updated_at = CURRENT_TIMESTAMP`,
            [barId, day.dayOfWeek, day.isClosed, JSON.stringify(day.timeRanges)]
          );
        }
      }

      await client.query("COMMIT");
      console.log(`✅ Bar creato completamente con ID: ${barId}`);
      return barId;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante la creazione completa del bar:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// Singleton instance
export const barRepository = new BarRepository();
