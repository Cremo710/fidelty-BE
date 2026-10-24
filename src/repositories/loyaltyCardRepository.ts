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
  phone: string | null;
  coverImage: string | null;
  description: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPoints: number;
  lifetimePoints: number;
  frozenPoints: number;
  availablePoints: number;
  receiptsCount: number;
  lastReceiptAt: Date | null;
  createdAt: Date;
  barDeleted: boolean;
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
      INSERT INTO loyalty_cards (user_id, bar_id, points, lifetime_points, receipts_count, last_receipt_at, updated_at)
      VALUES ($1, $2, $3, $3, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, bar_id) DO UPDATE SET
        points = loyalty_cards.points + EXCLUDED.points,
        lifetime_points = loyalty_cards.lifetime_points + EXCLUDED.lifetime_points,
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
      // Colonne geo garantite dalle migration (nessun controllo su information_schema)
      const query = `
        SELECT
          lc.id,
          lc.bar_id,
          b.name AS bar_name,
          b.merchant_name,
          b.iva AS piva,
          b.phone,
          b.image AS cover_image,
          b.description,
          b.address,
          b.latitude,
          b.longitude,
          lc.points AS total_points,
          lc.lifetime_points,
          (b.deleted_at IS NOT NULL) AS bar_deleted,
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
        phone: row.phone,
        coverImage: row.cover_image,
        description: row.description ?? null,
        address: row.address,
        latitude: row.latitude,
        longitude: row.longitude,
        totalPoints: Number(row.total_points) || 0,
        lifetimePoints: Number(row.lifetime_points) || 0,
        barDeleted: Boolean(row.bar_deleted),
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
