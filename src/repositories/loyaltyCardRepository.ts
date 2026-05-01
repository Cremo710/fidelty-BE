import { databaseService } from "../services/databaseService.js";
import type { PoolClient } from "pg";

export interface LoyaltyCardDTO {
  id: number;
  user_id: string;
  bar_id: string;
  points: number;
  receipts_count: number;
  last_receipt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LoyaltyCardWithBar {
  id: number;
  barId: string;
  barName: string;
  merchantName: string;
  piva: string;
  coverImage: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPoints: number;
  frozenPoints: number;
  availablePoints: number;
  receiptsCount: number;
  lastReceiptAt: Date | null;
  createdAt: Date;
}

/**
 * Repository pattern per l'accesso ai dati delle carte fedeltà.
 * Gestisce la persistenza delle loyalty cards nella tabella dedicata.
 */
export class LoyaltyCardRepository {
  /**
   * Trova una carta fedeltà per utente e bar.
   */
  async findByUserAndBar(userId: string, barId: string): Promise<LoyaltyCardDTO | null> {
    try {
      const query = "SELECT * FROM loyalty_cards WHERE user_id = $1 AND bar_id = $2";
      const result = await databaseService.getPool().query(query, [userId, barId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore nel recupero loyalty card per user/bar:", error);
      throw error;
    }
  }

  /**
   * Upsert di una carta fedeltà all'interno di una transazione esistente.
   *
   * Usa INSERT ... ON CONFLICT per garantire:
   * - idempotenza (non crea duplicati grazie a UNIQUE(user_id, bar_id))
   * - atomicità (eseguito nella stessa transazione del salvataggio ricevuta)
   * - nessuna race condition (ON CONFLICT gestisce accessi concorrenti)
   *
   * @param client - Il client PostgreSQL della transazione corrente
   * @param userId - ID dell'utente
   * @param barId - ID del bar
   * @param pointsToAdd - Punti da aggiungere
   * @returns ID della carta creata/aggiornata
   */
  async upsertCardInTransaction(
    client: PoolClient,
    userId: string,
    barId: string,
    pointsToAdd: number,
  ): Promise<number> {
    const query = `
      INSERT INTO loyalty_cards (user_id, bar_id, points, receipts_count, last_receipt_at, updated_at)
      VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, bar_id) DO UPDATE SET
        points = loyalty_cards.points + EXCLUDED.points,
        receipts_count = loyalty_cards.receipts_count + 1,
        last_receipt_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

    const result = await client.query(query, [userId, barId, pointsToAdd]);
    return result.rows[0].id;
  }

  /**
   * Recupera tutte le carte fedeltà di un utente con i dati del bar.
   * Query diretta sulla tabella loyalty_cards + JOIN bars.
    * Nessun ricalcolo aggregato a runtime → molto più veloce.
   */
  async findByUserId(userId: string): Promise<LoyaltyCardWithBar[]> {
    try {
      // Verifica se le colonne geo esistono (come fa barRepository)
      let geoSelect = "NULL::double precision AS latitude, NULL::double precision AS longitude";
      try {
        const colCheck = await databaseService.getPool().query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'bars' AND column_name IN ('latitude', 'longitude')
        `);
        const cols = new Set(colCheck.rows.map((r: any) => r.column_name));
        if (cols.has("latitude") && cols.has("longitude")) {
          geoSelect = "b.latitude, b.longitude";
        }
      } catch { /* fallback: NULL */ }

      const query = `
        SELECT
          lc.id,
          lc.bar_id,
          b.name AS bar_name,
          b.merchant_name,
          b.iva AS piva,
          b.image AS cover_image,
          b.address,
          ${geoSelect},
          lc.points AS total_points,
          COALESCE(frozen.frozen_points, 0)::int AS frozen_points,
          GREATEST(lc.points - COALESCE(frozen.frozen_points, 0)::int, 0) AS available_points,
          lc.receipts_count,
          lc.last_receipt_at,
          lc.created_at
        FROM loyalty_cards lc
        INNER JOIN bars b ON b.id = lc.bar_id
        LEFT JOIN (
          SELECT user_id, bar_id, SUM(points_amount)::int AS frozen_points
          FROM offer_redemptions
          WHERE status = 'frozen' AND expires_at > CURRENT_TIMESTAMP
          GROUP BY user_id, bar_id
        ) frozen ON frozen.user_id = lc.user_id AND frozen.bar_id = lc.bar_id
        WHERE lc.user_id = $1
        ORDER BY lc.updated_at DESC
      `;

      const result = await databaseService.getPool().query(query, [userId]);

      return result.rows.map((row: any) => ({
        id: row.id,
        barId: row.bar_id,
        barName: row.bar_name,
        merchantName: row.merchant_name,
        piva: row.piva,
        coverImage: row.cover_image,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        totalPoints: Number(row.total_points) || 0,
        frozenPoints: Number(row.frozen_points) || 0,
        availablePoints: Number(row.available_points) || 0,
        receiptsCount: Number(row.receipts_count) || 0,
        lastReceiptAt: row.last_receipt_at,
        createdAt: row.created_at,
      }));
    } catch (error) {
      console.error("❌ Errore nel recupero carte fedeltà per utente:", error);
      throw error;
    }
  }
}

// Istanza singleton del repository
export const loyaltyCardRepository = new LoyaltyCardRepository();
