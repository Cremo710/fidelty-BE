import { databaseService } from "../services/databaseService.js";

export interface BarDTO {
  id: number;
  user_id: number;
  iva: string;
  merchant_name: string;
  name: string;
  address: string;
  image: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository pattern per l'accesso ai dati dei bar
 * Astrae la logica di interazione con il database
 */
export class BarRepository {
  /**
   * Salva un nuovo bar nel database
   * @param bar - Dati del bar {userId, piva, merchantName, name, address, image}
   * @returns ID del bar creato
   */
  async createBar(bar: {
    userId: number;
    piva: string;
    merchantName: string;
    name: string;
    address: string;
    image?: string | null;
  }): Promise<number> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const query = `
        INSERT INTO bars (user_id, iva, merchant_name, name, address, image, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        RETURNING id
      `;

      const values = [
        bar.userId,
        bar.piva,
        bar.merchantName,
        bar.name,
        bar.address,
        bar.image || null,
      ];

      const result = await client.query(query, values);
      const barId = result.rows[0].id;

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
  async findById(id: number): Promise<BarDTO | null> {
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
  async findByUserId(userId: number): Promise<BarDTO | null> {
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
  async updateBar(id: number, updates: Partial<BarDTO>): Promise<boolean> {
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
   * Elimina un bar
   * @param id - ID del bar da eliminare
   * @returns true se l'eliminazione è stata effettuata
   */
  async deleteBar(id: number): Promise<boolean> {
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
}

// Singleton instance
export const barRepository = new BarRepository();
