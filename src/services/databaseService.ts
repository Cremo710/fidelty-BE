import pkg from "pg";
const { Pool } = pkg;

export class DatabaseService {
  private pool: pkg.Pool;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL non configurata nelle variabili d'ambiente",
      );
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
      },
    });

    console.log("🗄️  Pool di connessioni PostgreSQL inizializzato");
  }

  async initializeTables(): Promise<void> {
    try {
      await this.pool.query(`
      -- Tabella principale delle ricevute
      CREATE TABLE IF NOT EXISTS receipts (
        id SERIAL PRIMARY KEY,
        doc_id VARCHAR(50) UNIQUE NOT NULL, -- Corrisponde a billDocId
        merchant_name VARCHAR(255),
        merchant_address TEXT,
        merchant_tax_id VARCHAR(50),        -- Corrisponde a pIva
        total_amount DECIMAL(12, 2),        -- Corrisponde a billAmount
        purchase_date TIMESTAMP,            -- Corrisponde a billDate (ISO string)
        line_items JSONB,                   -- Per salvare eventuali dettagli extra
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indici per velocizzare le ricerche
      CREATE INDEX IF NOT EXISTS idx_receipts_doc_id ON receipts(doc_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_merchant_tax_id ON receipts(merchant_tax_id);
      
      -- Tabella utenti
      CREATE TABLE IF NOT EXISTS utenti (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_utenti_email ON utenti(email);

      -- Tabella per il refresh token (per future implementazioni)
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        revoked BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);

      -- Tabella per i bar registrati
      CREATE TABLE IF NOT EXISTS bars (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        iva VARCHAR(20) UNIQUE NOT NULL,
        merchant_name VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        address VARCHAR(500) NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_bars_user_id ON bars(user_id);
      CREATE INDEX IF NOT EXISTS idx_bars_iva ON bars(iva);

      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES utenti(id) ON DELETE SET NULL;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bar_id INTEGER REFERENCES bars(id) ON DELETE SET NULL;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS points_earned INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_bar_id ON receipts(bar_id);
    `);
      console.log("✅ Tabelle database create con i campi specifici");
    } catch (error) {
      console.error(
        "❌ Errore durante l'inizializzazione delle tabelle:",
        error,
      );
      throw error;
    }
  }

  async saveUser(userData: { name: string; email: string; password: string }): Promise<number> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const insertUserQuery = `
      INSERT INTO utenti (name, email, password, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        password = EXCLUDED.password,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

      const values = [userData.name, userData.email, userData.password];
      const result = await client.query(insertUserQuery, values);
      const userId = result.rows[0].id;

      await client.query("COMMIT");
      console.log(`✅ Utente salvato/aggiornato con ID: ${userId}`);
      return userId;
    } catch (error: any) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante il salvataggio dell'utente:", error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  async getUserByEmail(email: string): Promise<any> {
    try {
      const query = "SELECT * FROM utenti WHERE email = $1";
      const result = await this.pool.query(query, [email]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero dell'utente:", error);
      throw error;
    }
  }

  async saveReceipt(receiptData: any): Promise<number> {
    const client = await this.pool.connect();

    try {
      console.log(
        `💾 Tentativo di salvataggio ricevuta docId: ${receiptData.billDocId}`,
      );
      await client.query("BEGIN");

      const docId = receiptData.billDocId;
      if (!docId) {
        throw new Error("Impossibile salvare: billDocId (Doc ID) mancante.");
      }

      const insertReceiptQuery = `
      INSERT INTO receipts (
        doc_id,
        user_id,
        bar_id,
        points_earned,
        merchant_name,
        merchant_address,
        merchant_tax_id,
        total_amount,
        purchase_date,
        line_items,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      ON CONFLICT (doc_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        bar_id = EXCLUDED.bar_id,
        points_earned = EXCLUDED.points_earned,
        merchant_name = EXCLUDED.merchant_name,
        total_amount = EXCLUDED.total_amount,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

      const parsedBillAmount =
        typeof receiptData.billAmount === "number"
          ? receiptData.billAmount
          : Number.parseFloat(receiptData.billAmount || "0");

      // Mapping dei tuoi dati verso le colonne del DB
      const receiptValues = [
        docId, // $1: doc_id
        receiptData.userId || null, // $2: user_id
        receiptData.barId || null, // $3: bar_id
        receiptData.pointsEarned || 0, // $4: points_earned
        receiptData.merchantName || "Sconosciuto", // $5: merchant_name
        receiptData.merchantAddress || null, // $6: merchant_address
        receiptData.pIva || null, // $7: merchant_tax_id (pIva)
        Number.isFinite(parsedBillAmount) ? parsedBillAmount : 0, // $8: total_amount
        receiptData.billDate || null, // $9: purchase_date
        JSON.stringify(receiptData.lineItems || []), // $10: line_items (come stringa JSON)
      ];

      const receiptResult = await client.query(
        insertReceiptQuery,
        receiptValues,
      );
      const receiptId = receiptResult.rows[0].id;

      // Gestione Line Items (se presenti nel tuo oggetto)
      if (receiptData.lineItems && Array.isArray(receiptData.lineItems)) {
        for (const item of receiptData.lineItems) {
          const insertItemQuery = `
          INSERT INTO receipt_items (
            receipt_id, description, quantity, total_amount
          ) VALUES ($1, $2, $3, $4)
        `;
          await client.query(insertItemQuery, [
            receiptId,
            item.description || "Articolo",
            item.quantity || 1,
            item.totalAmount || 0,
          ]);
        }
      }

      await client.query("COMMIT");
      console.log(
        `✅ Ricevuta ${docId} salvata correttamente con ID interno: ${receiptId}`,
      );
      return receiptId;
    } catch (error: any) {
      await client.query("ROLLBACK");
      console.error(
        "❌ Errore durante il salvataggio della ricevuta:",
        error.message,
      );
      throw error;
    } finally {
      // IMPORTANTE: Rilascia sempre il client al pool
      client.release();
    }
  }

  async getUserLoyaltyCards(userId: number): Promise<Array<{
    barId: number;
    barName: string;
    merchantName: string;
    piva: string;
    coverImage: string | null;
    totalPoints: number;
    receiptsCount: number;
    lastReceiptAt: Date;
  }>> {
    try {
      // Debug: verifica cosa esiste a DB per questo utente
      const debugResult = await this.pool.query(
        `SELECT id, user_id, bar_id, points_earned, merchant_name FROM receipts WHERE user_id = $1`,
        [userId]
      );
      console.log(`🔍 Ricevute trovate per userId=${userId}:`, debugResult.rows);

      const query = `
        SELECT
          b.id AS bar_id,
          b.name AS bar_name,
          b.merchant_name,
          b.iva AS piva,
          b.image AS cover_image,
          COALESCE(SUM(r.points_earned), 0)::int AS total_points,
          COUNT(r.id)::int AS receipts_count,
          MAX(r.created_at) AS last_receipt_at
        FROM receipts r
        INNER JOIN bars b ON b.id = r.bar_id
        WHERE r.user_id = $1
        GROUP BY b.id, b.name, b.merchant_name, b.iva, b.image
        ORDER BY MAX(r.created_at) DESC
      `;

      const result = await this.pool.query(query, [userId]);

      return result.rows.map((row: any) => ({
        barId: row.bar_id,
        barName: row.bar_name,
        merchantName: row.merchant_name,
        piva: row.piva,
        coverImage: row.cover_image,
        totalPoints: Number(row.total_points) || 0,
        receiptsCount: Number(row.receipts_count) || 0,
        lastReceiptAt: row.last_receipt_at,
      }));
    } catch (error) {
      console.error("❌ Errore durante il recupero delle tessere utente:", error);
      throw error;
    }
  }

  async getReceipt(docId: string): Promise<any> {
    try {
      const query = "SELECT * FROM receipts WHERE doc_id = $1";
      const result = await this.pool.query(query, [docId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero della ricevuta:", error);
      throw error;
    }
  }

  async closePool(): Promise<void> {
    await this.pool.end();
    console.log("🗄️  Pool di connessioni PostgreSQL chiuso");
  }

  /**
   * Espone il pool per accesso esterno (utilizzato dal repository)
   */
  getPool(): pkg.Pool {
    return this.pool;
  }
}

export const databaseService = new DatabaseService();
