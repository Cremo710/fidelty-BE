import { databaseService } from "../services/databaseService.js";

// Tipo PoolClient inferito dal pool per evitare dipendenze dirette da 'pg'
type PoolClient = Awaited<ReturnType<ReturnType<typeof databaseService.getPool>["connect"]>>;

export interface LoyaltyCardDTO {
  id: number;
  user_id: number;
  bar_id: number;
  points: number;
  receipts_count: number;
  last_receipt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LoyaltyCardWithBar {
  id: number;
  barId: number;
  barName: string;
  merchantName: string;
  piva: string;
  coverImage: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  totalPoints: number;
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
  async findByUserAndBar(userId: number, barId: number): Promise<LoyaltyCardDTO | null> {
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
    userId: number,
    barId: number,
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
   * Nessun GROUP BY su receipts → molto più veloce.
   */
  async findByUserId(userId: number): Promise<LoyaltyCardWithBar[]> {
    try {
      const query = `
        SELECT
          lc.id,
          lc.bar_id,
          b.name AS bar_name,
          b.merchant_name,
          b.iva AS piva,
          b.image AS cover_image,
          b.address,
          b.latitude,
          b.longitude,
          lc.points AS total_points,
          lc.receipts_count,
          lc.last_receipt_at,
          lc.created_at
        FROM loyalty_cards lc
        INNER JOIN bars b ON b.id = lc.bar_id
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
        receiptsCount: Number(row.receipts_count) || 0,
        lastReceiptAt: row.last_receipt_at,
        createdAt: row.created_at,
      }));
    } catch (error) {
      console.error("❌ Errore nel recupero carte fedeltà per utente:", error);
      throw error;
    }
  }

  /**
   * Backfill: popola loyalty_cards dagli scontrini esistenti.
   * Idempotente grazie a ON CONFLICT DO NOTHING / DO UPDATE.
   * Da eseguire una sola volta dopo la migrazione.
   */
  async backfillFromReceipts(): Promise<number> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        INSERT INTO loyalty_cards (user_id, bar_id, points, receipts_count, last_receipt_at, created_at, updated_at)
        SELECT
          r.user_id,
          r.bar_id,
          COALESCE(SUM(r.points_earned), 0)::int,
          COUNT(r.id)::int,
          MAX(r.created_at),
          MIN(r.created_at),
          CURRENT_TIMESTAMP
        FROM receipts r
        WHERE r.user_id IS NOT NULL
          AND r.bar_id IS NOT NULL
        GROUP BY r.user_id, r.bar_id
        ON CONFLICT (user_id, bar_id) DO UPDATE SET
          points = EXCLUDED.points,
          receipts_count = EXCLUDED.receipts_count,
          last_receipt_at = EXCLUDED.last_receipt_at,
          updated_at = CURRENT_TIMESTAMP
      `);

      await client.query("COMMIT");

      const count = result.rowCount || 0;
      console.log(`✅ Backfill completato: ${count} carte fedeltà create/aggiornate`);
      return count;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante il backfill delle carte fedeltà:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// Istanza singleton del repository
export const loyaltyCardRepository = new LoyaltyCardRepository();
