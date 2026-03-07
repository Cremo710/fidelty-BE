/**
 * Migrazione: genera un public_id (FU-XXXXX) per tutti gli utenti
 * che ancora non ne hanno uno.
 *
 * Proprietà:
 *   - Idempotente: salta gli utenti che hanno già un public_id
 *   - Transaction safe: tutto in una singola transazione
 *
 * Uso:
 *   npx tsx src/migrations/backfillPublicIds.ts
 */

import { config } from "dotenv";
config();

import pkg from "pg";
const { Client } = pkg;

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateCode(): string {
  let code = "FU-";
  for (let i = 0; i < 5; i++) {
    code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return code;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✅ Connesso al database\n");

  try {
    // Assicura che la colonna esista
    await client.query(`
      ALTER TABLE utenti ADD COLUMN IF NOT EXISTS public_id VARCHAR(8) UNIQUE
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_utenti_public_id ON utenti(public_id)
    `);

    await client.query("BEGIN");

    // Trova utenti senza public_id
    const result = await client.query(
      "SELECT id FROM utenti WHERE public_id IS NULL ORDER BY created_at"
    );

    if (result.rows.length === 0) {
      console.log("ℹ️  Tutti gli utenti hanno già un public_id. Nulla da fare.");
      await client.query("COMMIT");
      await client.end();
      return;
    }

    console.log(`📊 Utenti senza public_id: ${result.rows.length}\n`);

    // Raccogli tutti i public_id esistenti per evitare collisioni
    const existingResult = await client.query(
      "SELECT public_id FROM utenti WHERE public_id IS NOT NULL"
    );
    const existingCodes = new Set(existingResult.rows.map((r: any) => r.public_id));

    let updated = 0;
    for (const row of result.rows) {
      let code: string;
      let attempts = 0;
      do {
        code = generateCode();
        attempts++;
        if (attempts > 100) {
          throw new Error(`Impossibile generare codice unico dopo 100 tentativi per utente ${row.id}`);
        }
      } while (existingCodes.has(code));

      existingCodes.add(code);
      await client.query("UPDATE utenti SET public_id = $1 WHERE id = $2", [code, row.id]);
      updated++;
      console.log(`   ${row.id} → ${code}`);
    }

    await client.query("COMMIT");
    console.log(`\n🎉 Backfill completato: ${updated} utenti aggiornati`);

    // Verifica
    const check = await client.query(
      "SELECT id, public_id FROM utenti ORDER BY created_at LIMIT 5"
    );
    console.log("\n📋 Campione utenti:");
    for (const r of check.rows) {
      console.log(`   ${r.id} → ${r.public_id}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("\n❌ Errore durante il backfill (ROLLBACK eseguito):", error);
    process.exit(1);
  } finally {
    await client.end();
    console.log("\n✅ Connessione chiusa.");
  }
}

main();
