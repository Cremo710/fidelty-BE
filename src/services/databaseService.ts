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
      ALTER TABLE utenti ADD COLUMN IF NOT EXISTS profile_image TEXT;
      ALTER TABLE utenti ADD COLUMN IF NOT EXISTS is_email_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE utenti ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
      CREATE INDEX IF NOT EXISTS idx_utenti_public_id ON utenti(public_id);

      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);

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

      -- Estensione tabella bars: nuovi campi per il flusso di onboarding
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS logo TEXT;
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS instagram VARCHAR(255);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS facebook VARCHAR(255);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS tiktok VARCHAR(255);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS website VARCHAR(500);
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS card_background_image TEXT;
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS card_color VARCHAR(50) DEFAULT '#bc7ed1';
      ALTER TABLE bars ADD COLUMN IF NOT EXISTS card_use_cover BOOLEAN DEFAULT FALSE;

      -- Tabella offerte/promozioni
      CREATE TABLE IF NOT EXISTS offers (
        id VARCHAR(26) PRIMARY KEY,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        conditions TEXT,
        points_required INTEGER NOT NULL DEFAULT 0,
        valid_from TIMESTAMP,
        valid_until TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_offers_bar_id ON offers(bar_id);
      ALTER TABLE offers ADD COLUMN IF NOT EXISTS icon VARCHAR(50);

      -- Tabella orari di apertura
      CREATE TABLE IF NOT EXISTS opening_hours (
        id SERIAL PRIMARY KEY,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
        is_closed BOOLEAN DEFAULT FALSE,
        time_ranges JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bar_id, day_of_week)
      );

      CREATE INDEX IF NOT EXISTS idx_opening_hours_bar_id ON opening_hours(bar_id);

      -- ═══ Friends ═══
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        friend_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, friend_id)
      );

      CREATE INDEX IF NOT EXISTS idx_friendships_user_id ON friendships(user_id);
      CREATE INDEX IF NOT EXISTS idx_friendships_friend_id ON friendships(friend_id);

      CREATE TABLE IF NOT EXISTS friendship_requests (
        id VARCHAR(26) PRIMARY KEY,
        requester_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        recipient_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        pair_low_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        pair_high_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        responded_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (requester_id <> recipient_id),
        CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'))
      );

      CREATE INDEX IF NOT EXISTS idx_friendship_requests_requester_id ON friendship_requests(requester_id);
      CREATE INDEX IF NOT EXISTS idx_friendship_requests_recipient_id ON friendship_requests(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_friendship_requests_pair ON friendship_requests(pair_low_user_id, pair_high_user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_friendship_requests_pending_pair_unique
        ON friendship_requests(pair_low_user_id, pair_high_user_id)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS point_transfers (
        id VARCHAR(26) PRIMARY KEY,
        sender_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        recipient_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        sender_loyalty_card_id INTEGER NOT NULL REFERENCES loyalty_cards(id) ON DELETE CASCADE,
        recipient_loyalty_card_id INTEGER NOT NULL REFERENCES loyalty_cards(id) ON DELETE CASCADE,
        points_amount INTEGER NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        failure_reason TEXT,
        idempotency_key VARCHAR(64),
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (sender_user_id <> recipient_user_id),
        CHECK (points_amount > 0),
        CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'))
      );

      CREATE INDEX IF NOT EXISTS idx_point_transfers_sender_user_id ON point_transfers(sender_user_id);
      CREATE INDEX IF NOT EXISTS idx_point_transfers_recipient_user_id ON point_transfers(recipient_user_id);
      CREATE INDEX IF NOT EXISTS idx_point_transfers_bar_id ON point_transfers(bar_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_point_transfers_sender_idempotency_key
        ON point_transfers(sender_user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS point_transfer_events (
        id SERIAL PRIMARY KEY,
        transfer_id VARCHAR(26) NOT NULL REFERENCES point_transfers(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        actor_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_point_transfer_events_transfer_id ON point_transfer_events(transfer_id);

      -- ═══ Business Requests (richieste registrazione bar con approvazione) ═══
      CREATE TABLE IF NOT EXISTS business_requests (
        id VARCHAR(26) PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        business_name VARCHAR(255) NOT NULL,
        bar_name VARCHAR(255) NOT NULL,
        address VARCHAR(500) NOT NULL,
        vat_number VARCHAR(20) NOT NULL,
        contact_email VARCHAR(255),
        phone VARCHAR(50),
        document_url TEXT,
        document_public_id VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        rejection_reason TEXT,
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS cover_image_public_id VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS logo_public_id VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS instagram VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS facebook VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS tiktok VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS website VARCHAR(500);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS card_background_image_url TEXT;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS card_background_image_public_id VARCHAR(255);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS card_color VARCHAR(50);
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS card_use_cover BOOLEAN DEFAULT FALSE;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS offers_json JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS opening_hours_json JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE business_requests ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

      CREATE INDEX IF NOT EXISTS idx_business_requests_user_id ON business_requests(user_id);
      CREATE INDEX IF NOT EXISTS idx_business_requests_status ON business_requests(status);

      -- ═══ Consumption Requests (richieste consumazione via QR) ═══
      CREATE TABLE IF NOT EXISTS consumption_requests (
        id VARCHAR(26) PRIMARY KEY,
        requester_user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        amount DECIMAL(12, 2) NOT NULL,
        points_preview INTEGER NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        qr_code_value VARCHAR(255) NOT NULL,
        requester_name_snapshot VARCHAR(255),
        requester_email_snapshot VARCHAR(255),
        approved_at TIMESTAMP,
        rejected_at TIMESTAMP,
        processed_by_user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL,
        rejection_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_consumption_requests_requester ON consumption_requests(requester_user_id);
      CREATE INDEX IF NOT EXISTS idx_consumption_requests_bar_id ON consumption_requests(bar_id);
      CREATE INDEX IF NOT EXISTS idx_consumption_requests_status ON consumption_requests(status);

      -- ═══ Offer Redemptions (freeze + validate via QR) ═══
      CREATE TABLE IF NOT EXISTS offer_redemptions (
        id VARCHAR(26) PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
        bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
        offer_id VARCHAR(26) NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'frozen',
        points_amount INTEGER NOT NULL,
        qr_nonce VARCHAR(64) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        frozen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        redeemed_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        validated_by_user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (status IN ('frozen', 'redeemed', 'expired', 'cancelled'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_offer_redemptions_qr_nonce ON offer_redemptions(qr_nonce);
      CREATE INDEX IF NOT EXISTS idx_offer_redemptions_user_bar ON offer_redemptions(user_id, bar_id);
      CREATE INDEX IF NOT EXISTS idx_offer_redemptions_offer_id ON offer_redemptions(offer_id);
      CREATE INDEX IF NOT EXISTS idx_offer_redemptions_status ON offer_redemptions(status);
      CREATE INDEX IF NOT EXISTS idx_offer_redemptions_expires_at ON offer_redemptions(expires_at);

      CREATE TABLE IF NOT EXISTS offer_redemption_events (
        id SERIAL PRIMARY KEY,
        redemption_id VARCHAR(26) NOT NULL REFERENCES offer_redemptions(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        actor_user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_offer_redemption_events_redemption_id ON offer_redemption_events(redemption_id);
      CREATE INDEX IF NOT EXISTS idx_offer_redemption_events_type ON offer_redemption_events(event_type);
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

  async getUserLoyaltyCards(userId: string): Promise<Array<{
    barId: string;
    barName: string;
    merchantName: string;
    piva: string;
    phone: string | null;
    coverImage: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    totalPoints: number;
    frozenPoints: number;
    availablePoints: number;
    receiptsCount: number;
    lastReceiptAt: Date;
  }>> {
    try {
      // Lettura diretta dalla tabella loyalty_cards senza ricalcolo aggregato runtime.
      const cards = await loyaltyCardRepository.findByUserId(userId);
      console.log(`🃏 Trovate ${cards.length} carte fedeltà da loyalty_cards per userId=${userId}`);

      return cards.map((card) => ({
        barId: card.barId,
        barName: card.barName,
        merchantName: card.merchantName,
        piva: card.piva,
        phone: card.phone,
        coverImage: card.coverImage,
        address: card.address,
        latitude: card.latitude,
        longitude: card.longitude,
        totalPoints: card.totalPoints,
        frozenPoints: card.frozenPoints,
        availablePoints: card.availablePoints,
        receiptsCount: card.receiptsCount,
        lastReceiptAt: card.lastReceiptAt as unknown as Date,
      }));
    } catch (error) {
      console.error("❌ Errore durante il recupero delle tessere utente:", error);
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
