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
        merchant_name,
        merchant_address,
        merchant_tax_id,
        total_amount,
        purchase_date,
        line_items,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (doc_id) DO UPDATE SET
        merchant_name = EXCLUDED.merchant_name,
        total_amount = EXCLUDED.total_amount,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

      // Mapping dei tuoi dati verso le colonne del DB
      const receiptValues = [
        docId, // $1: doc_id
        receiptData.merchantName || "Sconosciuto", // $2: merchant_name
        receiptData.merchantAddress || null, // $3: merchant_address
        receiptData.pIva || null, // $4: merchant_tax_id (pIva)
        receiptData.billAmount || 0, // $5: total_amount
        receiptData.billDate || null, // $6: purchase_date
        JSON.stringify(receiptData.lineItems || []), // $7: line_items (come stringa JSON)
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
}

export const databaseService = new DatabaseService();
