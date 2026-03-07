import pkg from "pg";
const { Pool } = pkg;
import { ulid } from "ulid";

import { loyaltyCardRepository } from "../repositories/loyaltyCardRepository.js";

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
        id VARCHAR(26) PRIMARY KEY,
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
        id VARCHAR(26) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_utenti_email ON utenti(email);

      ALTER TABLE utenti ADD COLUMN IF NOT EXISTS public_id VARCHAR(8) UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_utenti_public_id ON utenti(public_id);

      -- Tabella per il refresh token (per future implementazioni)
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        revoked BOOLEAN DEFAULT FALSE
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);

      -- Tabella per i bar registrati
      CREATE TABLE IF NOT EXISTS bars (
        id VARCHAR(26) PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
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

      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bar_id VARCHAR(26) REFERENCES bars(id) ON DELETE SET NULL;
      ALTER TABLE receipts ADD COLUMN IF NOT EXISTS points_earned INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_bar_id ON receipts(bar_id);

      -- Tabella carte fedeltà (persistite, non più calcolate a runtime)
      CREATE TABLE IF NOT EXISTS loyalty_cards (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        points INTEGER NOT NULL DEFAULT 0,
        receipts_count INTEGER NOT NULL DEFAULT 0,
        last_receipt_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, bar_id)
      );

      CREATE INDEX IF NOT EXISTS idx_loyalty_cards_user_id ON loyalty_cards(user_id);
      CREATE INDEX IF NOT EXISTS idx_loyalty_cards_bar_id ON loyalty_cards(bar_id);
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

  async saveUser(userData: { name: string; email: string; password: string }): Promise<string> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const id = ulid();
      const publicId = await this.generateUniquePublicId(client);
      const insertUserQuery = `
      INSERT INTO utenti (id, public_id, name, email, password, updated_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        password = EXCLUDED.password,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

      const values = [id, publicId, userData.name, userData.email, userData.password];
      const result = await client.query(insertUserQuery, values);
      const userId: string = result.rows[0].id;

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

  async saveReceipt(receiptData: any): Promise<string> {
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

      const receiptUlid = ulid();

      const insertReceiptQuery = `
      INSERT INTO receipts (
        id,
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
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
        receiptUlid, // $1: id (ULID)
        docId, // $2: doc_id
        receiptData.userId || null, // $3: user_id
        receiptData.barId || null, // $4: bar_id
        receiptData.pointsEarned || 0, // $5: points_earned
        receiptData.merchantName || "Sconosciuto", // $6: merchant_name
        receiptData.merchantAddress || null, // $7: merchant_address
        receiptData.pIva || null, // $8: merchant_tax_id (pIva)
        Number.isFinite(parsedBillAmount) ? parsedBillAmount : 0, // $9: total_amount
        receiptData.billDate || null, // $10: purchase_date
        JSON.stringify(receiptData.lineItems || []), // $11: line_items (come stringa JSON)
      ];

      const receiptResult = await client.query(
        insertReceiptQuery,
        receiptValues,
      );
      const receiptId: string = receiptResult.rows[0].id;

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

      // Upsert loyalty card nella stessa transazione (atomico, no race condition)
      if (receiptData.userId && receiptData.barId && receiptData.pointsEarned > 0) {
        const cardId = await loyaltyCardRepository.upsertCardInTransaction(
          client,
          receiptData.userId,
          receiptData.barId,
          receiptData.pointsEarned,
        );
        console.log(`🃏 Loyalty card aggiornata (id=${cardId}) per userId=${receiptData.userId}, barId=${receiptData.barId}, +${receiptData.pointsEarned} punti`);
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

  async getUserLoyaltyCards(userId: string): Promise<Array<{
    barId: string;
    barName: string;
    merchantName: string;
    piva: string;
    coverImage: string | null;
    totalPoints: number;
    receiptsCount: number;
    lastReceiptAt: Date;
  }>> {
    try {
      // Lettura diretta dalla tabella loyalty_cards (no GROUP BY su receipts)
      const cards = await loyaltyCardRepository.findByUserId(userId);
      console.log(`🃏 Trovate ${cards.length} carte fedeltà da loyalty_cards per userId=${userId}`);

      return cards.map((card) => ({
        barId: card.barId,
        barName: card.barName,
        merchantName: card.merchantName,
        piva: card.piva,
        coverImage: card.coverImage,
        totalPoints: card.totalPoints,
        receiptsCount: card.receiptsCount,
        lastReceiptAt: card.lastReceiptAt as unknown as Date,
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

  /**
   * Genera un public_id unico nel formato FU-XXXXX
   */
  private async generateUniquePublicId(client: pkg.PoolClient): Promise<string> {
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
}

export const databaseService = new DatabaseService();
