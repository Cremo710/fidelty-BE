import pkg from "pg";
const { Pool } = pkg;
import { ulid } from "ulid";

import { runMigrations } from "../migrations/runner.js";
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

  /** Applica le migration SQL non ancora registrate (src/migrations, tabella schema_migrations). */
  async initializeTables(): Promise<void> {
    const applied = await runMigrations(this.pool);
    console.log(applied.length > 0 ? `✅ Migration applicate: ${applied.join(", ")}` : "✅ Database aggiornato, nessuna migration da applicare");
  }

  async getUserLoyaltyCards(userId: string): Promise<Array<{
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
    barDeleted: boolean;
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
        description: card.description,
        address: card.address,
        latitude: card.latitude,
        longitude: card.longitude,
        totalPoints: card.totalPoints,
        lifetimePoints: card.lifetimePoints,
        barDeleted: card.barDeleted,
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
