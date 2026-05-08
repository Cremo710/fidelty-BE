import { databaseService } from "../services/databaseService.js";
import { ulid } from "ulid";

export interface UserDTO {
  id: string;
  public_id: string;
  name: string;
  email: string;
  password: string;
  profile_image: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RankingEntry {
  userId: string;
  publicId: string;
  name: string;
  profileImage: string | null;
  points: number;
  position: number;
}

export interface UserBarRankingEntry {
  barId: string;
  barName: string;
  points: number;
  position: number;
  participantsCount: number;
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
  }): Promise<string> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const id = ulid();
      const publicId = await this.generateUniquePublicId(client);
      const query = `
        INSERT INTO utenti (id, public_id, name, email, password, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          password = EXCLUDED.password,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      const values = [id, publicId, user.name, user.email, user.password];
      const result = await client.query(query, values);
      const userId: string = result.rows[0].id;

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
  async findById(id: string): Promise<UserDTO | null> {
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
  async updateUser(id: string, updates: Partial<UserDTO>): Promise<boolean> {
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
      if (updates.profile_image !== undefined) {
        fields.push(`profile_image = $${paramCount++}`);
        values.push(updates.profile_image);
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
  async deleteUser(id: string): Promise<boolean> {
    try {
      const query = "DELETE FROM utenti WHERE id = $1 RETURNING id";
      const result = await databaseService.getPool().query(query, [id]);
      return result.rows.length > 0;
    } catch (error) {
      console.error("❌ Errore durante l'eliminazione dell'utente:", error);
      throw error;
    }
  }

  /**
   * Salva un refresh token nel database
   */
  async saveRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date
  ): Promise<void> {
    const query = `
      INSERT INTO refresh_tokens (user_id, token, expires_at, revoked)
      VALUES ($1, $2, $3, false)
      ON CONFLICT (token) DO UPDATE SET revoked = false
    `;

    try {
      await databaseService.getPool().query(query, [userId, token, expiresAt]);
      console.log(`✅ Refresh token salvato per utente: ${userId}`);
    } catch (error) {
      console.error("Errore nel salvataggio del refresh token:", error);
      throw error;
    }
  }

  /**
   * Recupera un refresh token dal database
   */
  async findRefreshToken(token: string): Promise<any> {
    const query = `
      SELECT id, user_id, token, expires_at, revoked, created_at
      FROM refresh_tokens
      WHERE token = $1
    `;

    try {
      const result = await databaseService.getPool().query(query, [token]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("Errore nel recupero del refresh token:", error);
      throw error;
    }
  }

  /**
   * Revoca un refresh token (logout)
   */
  async revokeRefreshToken(token: string): Promise<void> {
    const query = `
      UPDATE refresh_tokens
      SET revoked = true
      WHERE token = $1
    `;

    try {
      await databaseService.getPool().query(query, [token]);
      console.log("✅ Refresh token revocato");
    } catch (error) {
      console.error("Errore nella revoca del refresh token:", error);
      throw error;
    }
  }

  /**
   * Revoca tutti i refresh token di un utente (logout da tutti i dispositivi)
   */
  async revokeAllUserTokens(userId: string): Promise<void> {
    const query = `
      UPDATE refresh_tokens
      SET revoked = true
      WHERE user_id = $1 AND revoked = false
    `;

    try {
      await databaseService.getPool().query(query, [userId]);
      console.log(`✅ Tutti i refresh token revocati per utente: ${userId}`);
    } catch (error) {
      console.error("Errore nella revoca dei refresh token:", error);
      throw error;
    }
  }

  /**
   * Cerca un utente per public_id (es. FU-AB12C)
   * @param publicId - Il codice pubblico dell'utente
   * @returns Dati dell'utente oppure null
   */
  async findByPublicId(publicId: string): Promise<UserDTO | null> {
    try {
      const query = "SELECT * FROM utenti WHERE public_id = $1";
      const result = await databaseService.getPool().query(query, [publicId.toUpperCase()]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero dell'utente per public_id:", error);
      throw error;
    }
  }

  async getGlobalRanking(currentUserId: string, limit = 10): Promise<{
    topEntries: RankingEntry[];
    currentUserEntry: RankingEntry | null;
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
              COALESCE(SUM(lc.points), 0)::int AS points,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(SUM(lc.points), 0) DESC, u.name ASC, u.id ASC
              )::int AS position
            FROM utenti u
            JOIN loyalty_cards lc ON lc.user_id = u.id
            GROUP BY u.id, u.public_id, u.name, u.profile_image
          )
          SELECT *
          FROM ranked
          ORDER BY position ASC
          LIMIT $1
        `,
        [limit],
      ),
      databaseService.getPool().query(
        `
          WITH ranked AS (
            SELECT
              u.id AS "userId",
              u.public_id AS "publicId",
              u.name,
              u.profile_image AS "profileImage",
              COALESCE(SUM(lc.points), 0)::int AS points,
              ROW_NUMBER() OVER (
                ORDER BY COALESCE(SUM(lc.points), 0) DESC, u.name ASC, u.id ASC
              )::int AS position
            FROM utenti u
            JOIN loyalty_cards lc ON lc.user_id = u.id
            GROUP BY u.id, u.public_id, u.name, u.profile_image
          )
          SELECT *
          FROM ranked
          WHERE "userId" = $1
          LIMIT 1
        `,
        [currentUserId],
      ),
      databaseService.getPool().query(
        `
          SELECT COUNT(DISTINCT user_id)::int AS total
          FROM loyalty_cards
        `,
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

  async getUserBarRankings(userId: string): Promise<UserBarRankingEntry[]> {
      const result = await databaseService.getPool().query(
        `
          WITH ranked AS (
            SELECT
              lc.bar_id AS "barId",
              b.name AS "barName",
              lc.user_id AS "userId",
              lc.points::int AS points,
              ROW_NUMBER() OVER (
                PARTITION BY lc.bar_id
                ORDER BY lc.points DESC, b.name ASC, lc.user_id ASC
              )::int AS position,
              COUNT(*) OVER (PARTITION BY lc.bar_id)::int AS "participantsCount"
            FROM loyalty_cards lc
            JOIN bars b ON b.id = lc.bar_id
          )
          SELECT "barId", "barName", points, position, "participantsCount"
          FROM ranked
          WHERE "userId" = $1
          ORDER BY position ASC, points DESC, "barName" ASC
        `,
        [userId],
      );

      return result.rows.map((row) => ({
        ...row,
        points: Number(row.points) || 0,
        position: Number(row.position) || 0,
        participantsCount: Number(row.participantsCount) || 0,
      }));
    }

  /**
   * Genera un public_id unico nel formato FU-XXXXX (5 caratteri alfanumerici)
   * Ritenta fino a 10 volte in caso di collisione.
   */
  private async generateUniquePublicId(client: any): Promise<string> {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const MAX_ATTEMPTS = 10;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let code = "FU-";
      for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const check = await client.query(
        "SELECT 1 FROM utenti WHERE public_id = $1 LIMIT 1",
        [code],
      );
      if (check.rows.length === 0) return code;
    }

    throw new Error("Impossibile generare un public_id unico dopo 10 tentativi");
  }

  /**
   * Backfill: genera public_id per tutti gli utenti che non ne hanno uno.
   * Idempotente e sicuro da eseguire ad ogni avvio del server.
   */
  async backfillPublicIds(): Promise<number> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        "SELECT id FROM utenti WHERE public_id IS NULL ORDER BY created_at"
      );

      if (result.rows.length === 0) {
        await client.query("COMMIT");
        return 0;
      }

      let updated = 0;
      for (const row of result.rows) {
        const publicId = await this.generateUniquePublicId(client);
        await client.query(
          "UPDATE utenti SET public_id = $1 WHERE id = $2",
          [publicId, row.id]
        );
        updated++;
      }

      await client.query("COMMIT");
      console.log(`✅ Backfill public_id completato: ${updated} utenti aggiornati`);
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante il backfill dei public_id:", error);
      throw error;
    } finally {
      client.release();
    }
  }
}

// Istanza singleton del repository
export const userRepository = new UserRepository();
