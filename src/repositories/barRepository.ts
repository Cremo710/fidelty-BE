import { databaseService } from "../services/databaseService.js";
import { ulid } from "ulid";
import type { PoolClient } from "pg";

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

export interface BarCompleteCreationData {
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
    icon?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    isActive?: boolean;
  }>;
  openingHours?: Array<{
    dayOfWeek: number;
    isClosed: boolean;
    timeRanges: Array<{ open: string; close: string }>;
  }> | null;
}

export interface BarActivityItem {
  id: string;
  type: "consumption_request";
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  totalAmount: number | null;
  pointsEarned: number;
  status: string | null;
  createdAt: Date;
}

export interface BarDashboardStats {
  totals: {
    customersWithReceipts: number;
    totalReceipts: number;
    totalPointsIssued: number;
    avgReceiptsPerCustomer: number;
  };
  activities: BarActivityItem[];
}

export interface BarRankingEntry {
  userId: string;
  publicId: string;
  name: string;
  profileImage: string | null;
  points: number;
  position: number;
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

  async getBarRanking(barId: string, currentUserId: string, limit = 10): Promise<{
    topEntries: BarRankingEntry[];
    currentUserEntry: BarRankingEntry | null;
    participantsCount: number;
  }> {
    const [topEntriesResult, currentUserResult, participantsResult] = await Promise.all([
      databaseService.getPool().query(
        `
          WITH ranked AS (
            SELECT
              u.id AS "userId",
              u.public_id AS "publicId",
              u.name,
              u.profile_image AS "profileImage",
              lc.points::int AS points,
              ROW_NUMBER() OVER (
                ORDER BY lc.points DESC, u.name ASC, u.id ASC
              )::int AS position
            FROM loyalty_cards lc
            JOIN utenti u ON u.id = lc.user_id
            WHERE lc.bar_id = $1
          )
          SELECT *
          FROM ranked
          ORDER BY position ASC
          LIMIT $2
        `,
        [barId, limit],
      ),
      databaseService.getPool().query(
        `
          WITH ranked AS (
            SELECT
              u.id AS "userId",
              u.public_id AS "publicId",
              u.name,
              u.profile_image AS "profileImage",
              lc.points::int AS points,
              ROW_NUMBER() OVER (
                ORDER BY lc.points DESC, u.name ASC, u.id ASC
              )::int AS position
            FROM loyalty_cards lc
            JOIN utenti u ON u.id = lc.user_id
            WHERE lc.bar_id = $1
          )
          SELECT *
          FROM ranked
          WHERE "userId" = $2
          LIMIT 1
        `,
        [barId, currentUserId],
      ),
      databaseService.getPool().query(
        `
          SELECT COUNT(*)::int AS total
          FROM loyalty_cards
          WHERE bar_id = $1
        `,
        [barId],
      ),
    ]);

    return {
      topEntries: topEntriesResult.rows.map((row) => ({
        ...row,
        points: Number(row.points) || 0,
        position: Number(row.position) || 0,
      })),
      currentUserEntry: currentUserResult.rows[0]
        ? {
            ...currentUserResult.rows[0],
            points: Number(currentUserResult.rows[0].points) || 0,
            position: Number(currentUserResult.rows[0].position) || 0,
          }
        : null,
      participantsCount: Number(participantsResult.rows[0]?.total) || 0,
    };
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
      if (updates.logo) {
        fields.push(`logo = $${paramCount++}`);
        values.push(updates.logo);
      }
      if (updates.contact_email !== undefined) {
        fields.push(`contact_email = $${paramCount++}`);
        values.push(updates.contact_email);
      }
      if (updates.phone !== undefined) {
        fields.push(`phone = $${paramCount++}`);
        values.push(updates.phone);
      }
      if (updates.instagram !== undefined) {
        fields.push(`instagram = $${paramCount++}`);
        values.push(updates.instagram);
      }
      if (updates.facebook !== undefined) {
        fields.push(`facebook = $${paramCount++}`);
        values.push(updates.facebook);
      }
      if (updates.tiktok !== undefined) {
        fields.push(`tiktok = $${paramCount++}`);
        values.push(updates.tiktok);
      }
      if (updates.website !== undefined) {
        fields.push(`website = $${paramCount++}`);
        values.push(updates.website);
      }
      if (updates.latitude !== undefined) {
        fields.push(`latitude = $${paramCount++}`);
        values.push(updates.latitude);
      }
      if (updates.longitude !== undefined) {
        fields.push(`longitude = $${paramCount++}`);
        values.push(updates.longitude);
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

  async getDashboardStats(barId: string): Promise<BarDashboardStats> {
    try {
      const [summaryResult, activitiesResult] = await Promise.all([
        databaseService.getPool().query(
          `
            SELECT
              COUNT(DISTINCT cr.requester_user_id) FILTER (WHERE cr.status = 'approved') AS customers_with_receipts,
              COUNT(cr.id) FILTER (WHERE cr.status = 'approved') AS total_receipts,
              COALESCE(SUM(cr.points_preview) FILTER (WHERE cr.status = 'approved'), 0) AS total_points_issued,
              COALESCE(
                ROUND(
                  COUNT(cr.id) FILTER (WHERE cr.status = 'approved')::numeric
                    / NULLIF(COUNT(DISTINCT cr.requester_user_id) FILTER (WHERE cr.status = 'approved'), 0),
                  1
                ),
                0
              ) AS avg_receipts_per_customer
            FROM consumption_requests cr
            WHERE cr.bar_id = $1
          `,
          [barId]
        ),
        databaseService.getPool().query(
          `
            SELECT
              cr.id,
              cr.requester_user_id AS user_id,
              u.name AS user_name,
              u.email AS user_email,
              cr.amount AS total_amount,
              cr.points_preview AS points_earned,
              cr.status,
              COALESCE(cr.approved_at, cr.rejected_at, cr.created_at) AS created_at
            FROM consumption_requests cr
            LEFT JOIN utenti u ON u.id = cr.requester_user_id
            WHERE cr.bar_id = $1
              AND cr.requester_user_id IS NOT NULL
              AND cr.status <> 'pending'
            ORDER BY COALESCE(cr.approved_at, cr.rejected_at, cr.created_at) DESC
            LIMIT 50
          `,
          [barId]
        ),
      ]);

      const summary = summaryResult.rows[0] || {};

      return {
        totals: {
          customersWithReceipts: Number(summary.customers_with_receipts) || 0,
          totalReceipts: Number(summary.total_receipts) || 0,
          totalPointsIssued: Number(summary.total_points_issued) || 0,
          avgReceiptsPerCustomer: Number(summary.avg_receipts_per_customer) || 0,
        },
        activities: activitiesResult.rows.map((row: any) => ({
          id: row.id,
          type: "consumption_request",
          userId: row.user_id,
          userName: row.user_name,
          userEmail: row.user_email,
          totalAmount: row.total_amount !== null ? Number(row.total_amount) : null,
          pointsEarned: Number(row.points_earned) || 0,
          status: row.status || null,
          createdAt: row.created_at,
        })),
      };
    } catch (error) {
      console.error("❌ Errore nel recupero statistiche dashboard bar:", error);
      throw error;
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
  async createBarComplete(data: BarCompleteCreationData): Promise<string> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");
      const barId = await this.createBarCompleteWithClient(client, data);
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

  async createBarCompleteWithClient(client: PoolClient, data: BarCompleteCreationData): Promise<string> {
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

    if (data.offers && data.offers.length > 0) {
      for (const offer of data.offers) {
        const offerId = ulid();
        await client.query(
          `INSERT INTO offers (
             id, bar_id, title, description, conditions,
             points_required, icon, valid_from, valid_until, is_active, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
          [
            offerId,
            barId,
            offer.title,
            offer.description ?? null,
            offer.conditions ?? null,
            offer.pointsRequired,
            offer.icon ?? null,
            offer.validFrom ?? null,
            offer.validUntil ?? null,
            offer.isActive ?? true,
          ]
        );
      }
    }

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

    return barId;
  }
}

// Singleton instance
export const barRepository = new BarRepository();
