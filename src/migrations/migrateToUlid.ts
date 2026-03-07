/**
 * Migrazione da ID SERIAL (interi) a ULID (VARCHAR(26)) per le tabelle:
 *   - utenti (id)
 *   - bars (id)
 *
 * Aggiorna tutte le foreign keys collegate:
 *   - refresh_tokens.user_id
 *   - bars.user_id
 *   - receipts.user_id, receipts.bar_id
 *   - loyalty_cards.user_id, loyalty_cards.bar_id
 *
 * Logica:
 *   1. Disabilita i vincoli FK temporaneamente
 *   2. Aggiunge colonne temporanee _ulid per utenti e bars
 *   3. Genera ULIDs per ogni record esistente
 *   4. Aggiorna tutte le FK nelle tabelle collegate
 *   5. Scambia le colonne (rimuove vecchio id intero, rinomina _ulid → id)
 *   6. Ricrea vincoli FK e indici
 *
 * Proprietà:
 *   - Transaction safe: tutto in una singola transazione
 *   - Mantiene l'integrità referenziale
 *   - Idempotente: controlla se la migrazione è già stata eseguita
 *
 * Uso:
 *   npx tsx src/migrations/migrateToUlid.ts
 */

import { config } from "dotenv";
config();

import pkg from "pg";
const { Client } = pkg;
import { ulid } from "ulid";

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✅ Connesso al database\n");

  try {
    // Check if migration was already run (utenti.id is already varchar)
    const colCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'utenti' AND column_name = 'id'
    `);

    if (colCheck.rows.length > 0 && colCheck.rows[0].data_type === 'character varying') {
      console.log("ℹ️  Migrazione già eseguita (utenti.id è già VARCHAR). Nulla da fare.");
      await client.end();
      return;
    }

    await client.query("BEGIN");
    console.log("🔄 Transazione avviata\n");

    // ═══════════════════════════════════════════════════════════
    // STEP 1: Aggiungere colonne temporanee _ulid
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 1: Aggiungo colonne temporanee _ulid...");

    await client.query(`ALTER TABLE utenti ADD COLUMN IF NOT EXISTS new_id VARCHAR(26)`);
    await client.query(`ALTER TABLE bars ADD COLUMN IF NOT EXISTS new_id VARCHAR(26)`);

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Generare ULIDs per utenti esistenti
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 2: Genero ULIDs per utenti esistenti...");

    const utenti = await client.query(`SELECT id FROM utenti ORDER BY id`);
    const userIdMap = new Map<number, string>(); // old int id → new ULID

    for (const row of utenti.rows) {
      const newId = ulid();
      userIdMap.set(row.id, newId);
      await client.query(`UPDATE utenti SET new_id = $1 WHERE id = $2`, [newId, row.id]);
    }
    console.log(`   → ${utenti.rows.length} utenti aggiornati`);

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Generare ULIDs per bars esistenti
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 3: Genero ULIDs per bars esistenti...");

    const bars = await client.query(`SELECT id FROM bars ORDER BY id`);
    const barIdMap = new Map<number, string>(); // old int id → new ULID

    for (const row of bars.rows) {
      const newId = ulid();
      barIdMap.set(row.id, newId);
      await client.query(`UPDATE bars SET new_id = $1 WHERE id = $2`, [newId, row.id]);
    }
    console.log(`   → ${bars.rows.length} bars aggiornati`);

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Aggiungere colonne FK temporanee nelle tabelle collegate
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 4: Aggiorno foreign keys nelle tabelle collegate...");

    // -- refresh_tokens: user_id
    await client.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS new_user_id VARCHAR(26)`);
    const rtRows = await client.query(`SELECT id, user_id FROM refresh_tokens`);
    for (const row of rtRows.rows) {
      const newUserId = userIdMap.get(row.user_id);
      if (newUserId) {
        await client.query(`UPDATE refresh_tokens SET new_user_id = $1 WHERE id = $2`, [newUserId, row.id]);
      }
    }
    console.log(`   → refresh_tokens: ${rtRows.rows.length} righe aggiornate`);

    // -- bars: user_id
    await client.query(`ALTER TABLE bars ADD COLUMN IF NOT EXISTS new_user_id VARCHAR(26)`);
    const barsWithUser = await client.query(`SELECT id, user_id FROM bars`);
    for (const row of barsWithUser.rows) {
      const newUserId = userIdMap.get(row.user_id);
      if (newUserId) {
        await client.query(`UPDATE bars SET new_user_id = $1 WHERE id = $2`, [newUserId, row.id]);
      }
    }
    console.log(`   → bars.user_id: ${barsWithUser.rows.length} righe aggiornate`);

    // -- receipts: user_id, bar_id
    await client.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS new_user_id VARCHAR(26)`);
    await client.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS new_bar_id VARCHAR(26)`);
    const receiptRows = await client.query(`SELECT id, user_id, bar_id FROM receipts`);
    for (const row of receiptRows.rows) {
      const newUserId = row.user_id ? userIdMap.get(row.user_id) : null;
      const newBarId = row.bar_id ? barIdMap.get(row.bar_id) : null;
      await client.query(
        `UPDATE receipts SET new_user_id = $1, new_bar_id = $2 WHERE id = $3`,
        [newUserId || null, newBarId || null, row.id]
      );
    }
    console.log(`   → receipts: ${receiptRows.rows.length} righe aggiornate`);

    // -- loyalty_cards: user_id, bar_id
    await client.query(`ALTER TABLE loyalty_cards ADD COLUMN IF NOT EXISTS new_user_id VARCHAR(26)`);
    await client.query(`ALTER TABLE loyalty_cards ADD COLUMN IF NOT EXISTS new_bar_id VARCHAR(26)`);
    const lcRows = await client.query(`SELECT id, user_id, bar_id FROM loyalty_cards`);
    for (const row of lcRows.rows) {
      const newUserId = userIdMap.get(row.user_id);
      const newBarId = barIdMap.get(row.bar_id);
      await client.query(
        `UPDATE loyalty_cards SET new_user_id = $1, new_bar_id = $2 WHERE id = $3`,
        [newUserId || null, newBarId || null, row.id]
      );
    }
    console.log(`   → loyalty_cards: ${lcRows.rows.length} righe aggiornate`);

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Rimuovere vincoli FK, scambiare colonne
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 5: Rimuovo vincoli FK e scambio colonne...");

    // Drop all foreign key constraints referencing utenti(id) and bars(id)
    // We need to find and drop them dynamically
    const fkQuery = `
      SELECT tc.constraint_name, tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.table_constraints tc2
        ON rc.unique_constraint_name = tc2.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc2.table_name IN ('utenti', 'bars')
    `;
    const fks = await client.query(fkQuery);
    for (const fk of fks.rows) {
      await client.query(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT IF EXISTS ${fk.constraint_name}`);
      console.log(`   → Rimosso FK: ${fk.table_name}.${fk.constraint_name}`);
    }

    // Drop unique constraint on loyalty_cards (user_id, bar_id) if exists
    await client.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name = 'loyalty_cards' AND constraint_type = 'UNIQUE'
        LOOP
          EXECUTE 'ALTER TABLE loyalty_cards DROP CONSTRAINT IF EXISTS ' || r.constraint_name;
        END LOOP;
      END $$;
    `);

    // ── UTENTI: swap id column ──
    await client.query(`ALTER TABLE utenti DROP COLUMN id`);
    await client.query(`ALTER TABLE utenti RENAME COLUMN new_id TO id`);
    await client.query(`ALTER TABLE utenti ADD PRIMARY KEY (id)`);

    // ── BARS: swap id and user_id columns ──
    await client.query(`ALTER TABLE bars DROP COLUMN id`);
    await client.query(`ALTER TABLE bars RENAME COLUMN new_id TO id`);
    await client.query(`ALTER TABLE bars DROP COLUMN user_id`);
    await client.query(`ALTER TABLE bars RENAME COLUMN new_user_id TO user_id`);
    await client.query(`ALTER TABLE bars ADD PRIMARY KEY (id)`);

    // ── REFRESH_TOKENS: swap user_id ──
    await client.query(`ALTER TABLE refresh_tokens DROP COLUMN user_id`);
    await client.query(`ALTER TABLE refresh_tokens RENAME COLUMN new_user_id TO user_id`);

    // ── RECEIPTS: swap user_id, bar_id ──
    await client.query(`ALTER TABLE receipts DROP COLUMN user_id`);
    await client.query(`ALTER TABLE receipts RENAME COLUMN new_user_id TO user_id`);
    await client.query(`ALTER TABLE receipts DROP COLUMN bar_id`);
    await client.query(`ALTER TABLE receipts RENAME COLUMN new_bar_id TO bar_id`);

    // ── LOYALTY_CARDS: swap user_id, bar_id ──
    await client.query(`ALTER TABLE loyalty_cards DROP COLUMN user_id`);
    await client.query(`ALTER TABLE loyalty_cards RENAME COLUMN new_user_id TO user_id`);
    await client.query(`ALTER TABLE loyalty_cards DROP COLUMN bar_id`);
    await client.query(`ALTER TABLE loyalty_cards RENAME COLUMN new_bar_id TO bar_id`);

    // ═══════════════════════════════════════════════════════════
    // STEP 6: Ricrea Foreign Keys e vincoli
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 6: Ricreo foreign keys e vincoli...");

    // refresh_tokens.user_id → utenti(id)
    await client.query(`
      ALTER TABLE refresh_tokens
      ALTER COLUMN user_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE refresh_tokens
      ADD CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE CASCADE
    `);

    // bars.user_id → utenti(id)
    await client.query(`
      ALTER TABLE bars
      ALTER COLUMN user_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE bars
      ADD CONSTRAINT fk_bars_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE CASCADE
    `);

    // receipts.user_id → utenti(id)
    await client.query(`
      ALTER TABLE receipts
      ADD CONSTRAINT fk_receipts_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE SET NULL
    `);

    // receipts.bar_id → bars(id)
    await client.query(`
      ALTER TABLE receipts
      ADD CONSTRAINT fk_receipts_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE SET NULL
    `);

    // loyalty_cards.user_id → utenti(id)
    await client.query(`
      ALTER TABLE loyalty_cards
      ALTER COLUMN user_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE loyalty_cards
      ADD CONSTRAINT fk_loyalty_cards_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE CASCADE
    `);

    // loyalty_cards.bar_id → bars(id)
    await client.query(`
      ALTER TABLE loyalty_cards
      ALTER COLUMN bar_id SET NOT NULL
    `);
    await client.query(`
      ALTER TABLE loyalty_cards
      ADD CONSTRAINT fk_loyalty_cards_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE CASCADE
    `);

    // Ricrea UNIQUE constraint su loyalty_cards (user_id, bar_id)
    await client.query(`
      ALTER TABLE loyalty_cards ADD CONSTRAINT uq_loyalty_cards_user_bar UNIQUE (user_id, bar_id)
    `);

    // ═══════════════════════════════════════════════════════════
    // STEP 7: Ricrea indici
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 7: Ricreo indici...");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bars_user_id ON bars(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_receipts_bar_id ON receipts(bar_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_cards_user_id ON loyalty_cards(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_loyalty_cards_bar_id ON loyalty_cards(bar_id)`);

    // ═══════════════════════════════════════════════════════════
    // STEP 8: Revoca tutti i refresh token (i JWT contengono vecchi ID numerici)
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 8: Revoco tutti i refresh token (i JWT contengono vecchi ID numerici)...");
    await client.query(`UPDATE refresh_tokens SET revoked = true`);

    // ═══════════════════════════════════════════════════════════
    // COMMIT
    // ═══════════════════════════════════════════════════════════
    await client.query("COMMIT");
    console.log("\n🎉 Migrazione completata con successo!");
    console.log(`   Utenti migrati: ${utenti.rows.length}`);
    console.log(`   Bar migrati: ${bars.rows.length}`);
    console.log("   ⚠️  Tutti i refresh token sono stati revocati — gli utenti dovranno ri-effettuare il login.");

    // Verifica
    const checkUtenti = await client.query(`SELECT id FROM utenti LIMIT 3`);
    const checkBars = await client.query(`SELECT id FROM bars LIMIT 3`);
    console.log("\n📋 Sample utenti IDs:", checkUtenti.rows.map((r: any) => r.id));
    console.log("📋 Sample bars IDs:", checkBars.rows.map((r: any) => r.id));

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("\n❌ Errore durante la migrazione (ROLLBACK eseguito):", error);
    process.exit(1);
  } finally {
    await client.end();
    console.log("\n✅ Connessione chiusa.");
  }
}

main();
