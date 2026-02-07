import { databaseService } from "../services/databaseService.js";

export interface UserDTO {
  id: number;
  name: string;
  email: string;
  password: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository pattern per l'accesso ai dati degli utenti
 * Astrae la logica di interazione con il database
 */
export class UserRepository {
  /**
   * Salva un nuovo utente nel database
   * @param user - Dati dell'utente {name, email, password}
   * @returns ID dell'utente creato
   */
  async createUser(user: {
    name: string;
    email: string;
    password: string;
  }): Promise<number> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const query = `
        INSERT INTO utenti (name, email, password, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          password = EXCLUDED.password,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      const values = [user.name, user.email, user.password];
      const result = await client.query(query, values);
      const userId = result.rows[0].id;

      await client.query("COMMIT");
      console.log(`✅ Utente creato/aggiornato con ID: ${userId}`);
      return userId;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante la creazione dell'utente:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Recupera un utente per email
   * @param email - Email dell'utente
   * @returns Dati dell'utente oppure null
   */
  async findByEmail(email: string): Promise<UserDTO | null> {
    try {
      const query = "SELECT * FROM utenti WHERE LOWER(email) = LOWER($1)";
      const result = await databaseService.getPool().query(query, [email]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero dell'utente per email:", error);
      throw error;
    }
  }

  /**
   * Recupera un utente per ID
   * @param id - ID dell'utente
   * @returns Dati dell'utente oppure null
   */
  async findById(id: number): Promise<UserDTO | null> {
    try {
      const query = "SELECT * FROM utenti WHERE id = $1";
      const result = await databaseService.getPool().query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero dell'utente per ID:", error);
      throw error;
    }
  }

  /**
   * Verifica se un'email è già registrata
   * @param email - Email da verificare
   * @returns true se l'email esiste, false altrimenti
   */
  async emailExists(email: string): Promise<boolean> {
    try {
      const query = "SELECT 1 FROM utenti WHERE LOWER(email) = LOWER($1) LIMIT 1";
      const result = await databaseService.getPool().query(query, [email]);
      return result.rows.length > 0;
    } catch (error) {
      console.error("❌ Errore durante la verifica dell'email:", error);
      throw error;
    }
  }

  /**
   * Aggiorna i dati di un utente
   * @param id - ID dell'utente
   * @param updates - Campi da aggiornare
   * @returns true se l'aggiornamento è stato effettuato
   */
  async updateUser(id: number, updates: Partial<UserDTO>): Promise<boolean> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const fields: string[] = [];
      const values: any[] = [];
      let paramCount = 1;

      if (updates.name) {
        fields.push(`name = $${paramCount++}`);
        values.push(updates.name);
      }
      if (updates.email) {
        fields.push(`email = $${paramCount++}`);
        values.push(updates.email);
      }
      if (updates.password) {
        fields.push(`password = $${paramCount++}`);
        values.push(updates.password);
      }

      if (fields.length === 0) {
        await client.query("COMMIT");
        return true;
      }

      fields.push(`updated_at = CURRENT_TIMESTAMP`);
      values.push(id);

      const query = `UPDATE utenti SET ${fields.join(", ")} WHERE id = $${paramCount} RETURNING id`;
      const result = await client.query(query, values);

      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante l'aggiornamento dell'utente:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Elimina un utente
   * @param id - ID dell'utente
   * @returns true se l'eliminazione è stata effettuata
   */
  async deleteUser(id: number): Promise<boolean> {
    try {
      const query = "DELETE FROM utenti WHERE id = $1 RETURNING id";
      const result = await databaseService.getPool().query(query, [id]);
      return result.rows.length > 0;
    } catch (error) {
      console.error("❌ Errore durante l'eliminazione dell'utente:", error);
      throw error;
    }
  }
}

// Istanza singleton del repository
export const userRepository = new UserRepository();
