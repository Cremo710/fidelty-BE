/**
 * Migrazione: receipts.id da SERIAL (integer) a ULID (VARCHAR(26))
 *
 * Logica:
 *   1. Controlla se la migrazione è già stata eseguita
 *   2. Aggiunge colonna temporanea new_id VARCHAR(26) su receipts
 *   3. Genera ULIDs per ogni ricevuta esistente
 *   4. Aggiorna receipt_items.receipt_id con i nuovi ULIDs
 *   5. Scambia le colonne (remove old id, rename new_id → id)
 *   6. Ricrea vincoli, PK e indici
 *
 * Proprietà:
 *   - Transaction safe
 *   - Idempotente
 *
 * Uso:
 *   npx tsx src/migrations/migrateReceiptsToUlid.ts
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
    // Check if migration was already run (receipts.id is already varchar)
    const colCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'receipts' AND column_name = 'id'
    `);

    if (colCheck.rows.length > 0 && colCheck.rows[0].data_type === "character varying") {
      console.log("ℹ️  Migrazione già eseguita (receipts.id è già VARCHAR). Nulla da fare.");
      await client.end();
      return;
    }

    if (colCheck.rows.length === 0) {
      console.log("⚠️  Tabella receipts non trovata. Nulla da fare.");
      await client.end();
      return;
    }

    await client.query("BEGIN");
    console.log("🔄 Transazione avviata\n");

    // ═══════════════════════════════════════════════════════════
    // STEP 1: Aggiungere colonna temporanea new_id su receipts
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 1: Aggiungo colonna temporanea new_id su receipts...");
    await client.query(`ALTER TABLE receipts ADD COLUMN IF NOT EXISTS new_id VARCHAR(26)`);

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Generare ULIDs per ricevute esistenti
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 2: Genero ULIDs per ricevute esistenti...");

    const receipts = await client.query(`SELECT id FROM receipts ORDER BY id`);
    const receiptIdMap = new Map<number, string>(); // old int id → new ULID

    for (const row of receipts.rows) {
      const newId = ulid();
      receiptIdMap.set(row.id, newId);
      await client.query(`UPDATE receipts SET new_id = $1 WHERE id = $2`, [newId, row.id]);
    }
    console.log(`   → ${receipts.rows.length} ricevute aggiornate`);

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Aggiornare receipt_items.receipt_id (se la tabella esiste)
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 3: Controllo/aggiorno receipt_items...");

    const tableCheck = await client.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'receipt_items'
    `);

    if (tableCheck.rows.length > 0) {
      // Check se receipt_items.receipt_id è integer
      const riColCheck = await client.query(`
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'receipt_items' AND column_name = 'receipt_id'
      `);

      if (riColCheck.rows.length > 0 && riColCheck.rows[0].data_type === "integer") {
        await client.query(`ALTER TABLE receipt_items ADD COLUMN IF NOT EXISTS new_receipt_id VARCHAR(26)`);

        const items = await client.query(`SELECT id, receipt_id FROM receipt_items`);
        for (const row of items.rows) {
          const newReceiptId = receiptIdMap.get(row.receipt_id);
          if (newReceiptId) {
            await client.query(`UPDATE receipt_items SET new_receipt_id = $1 WHERE id = $2`, [newReceiptId, row.id]);
          }
        }
        console.log(`   → receipt_items: ${items.rows.length} righe aggiornate`);

        // Drop FK constraint on receipt_items.receipt_id if exists
        const fkQuery = `
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
          JOIN information_schema.table_constraints tc2
            ON rc.unique_constraint_name = tc2.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = 'receipt_items'
            AND tc2.table_name = 'receipts'
        `;
        const fks = await client.query(fkQuery);
        for (const fk of fks.rows) {
          await client.query(`ALTER TABLE receipt_items DROP CONSTRAINT IF EXISTS ${fk.constraint_name}`);
          console.log(`   → Rimosso FK: receipt_items.${fk.constraint_name}`);
        }

        // Swap receipt_items.receipt_id
        await client.query(`ALTER TABLE receipt_items DROP COLUMN receipt_id`);
        await client.query(`ALTER TABLE receipt_items RENAME COLUMN new_receipt_id TO receipt_id`);
      } else {
        console.log("   → receipt_items.receipt_id è già VARCHAR, skip");
      }
    } else {
      console.log("   → Tabella receipt_items non trovata, skip");
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Drop FK constraints on receipts and referencing receipts(id)
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 4: Rimuovo vincoli FK...");

    // Drop FK constraints FROM receipts (user_id, bar_id pointing to utenti/bars)
    const fkOnReceiptsQuery = `
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'receipts'
    `;
    const fkOnReceipts = await client.query(fkOnReceiptsQuery);
    for (const fk of fkOnReceipts.rows) {
      await client.query(`ALTER TABLE receipts DROP CONSTRAINT IF EXISTS ${fk.constraint_name}`);
      console.log(`   → Rimosso FK: receipts.${fk.constraint_name}`);
    }

    // Drop FK constraints referencing receipts(id) from other tables
    const fkQuery = `
      SELECT tc.constraint_name, tc.table_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.table_constraints tc2
        ON rc.unique_constraint_name = tc2.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc2.table_name = 'receipts'
    `;
    const fks = await client.query(fkQuery);
    for (const fk of fks.rows) {
      await client.query(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT IF EXISTS ${fk.constraint_name}`);
      console.log(`   → Rimosso FK: ${fk.table_name}.${fk.constraint_name}`);
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Swap receipts.id column
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 5: Scambio colonne receipts.id...");

    // Drop the SERIAL sequence dependency first
    await client.query(`ALTER TABLE receipts ALTER COLUMN id DROP DEFAULT`);

    // Drop old integer id, rename new_id to id
    await client.query(`ALTER TABLE receipts DROP COLUMN id`);
    await client.query(`ALTER TABLE receipts RENAME COLUMN new_id TO id`);
    await client.query(`ALTER TABLE receipts ADD PRIMARY KEY (id)`);

    // ═══════════════════════════════════════════════════════════
    // STEP 6: Ricrea FK e indici
    // ═══════════════════════════════════════════════════════════
    console.log("📌 Step 6: Ricreo FK e indici...");

    // receipts.user_id → utenti(id) (if column exists and FK was dropped)
    const userIdCol = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'receipts' AND column_name = 'user_id'
    `);
    if (userIdCol.rows.length > 0) {
      await client.query(`
        ALTER TABLE receipts
        ADD CONSTRAINT fk_receipts_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE SET NULL
      `);
    }

    // receipts.bar_id → bars(id) (if column exists)
    const barIdCol = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'receipts' AND column_name = 'bar_id'
    `);
    if (barIdCol.rows.length > 0) {
      await client.query(`
        ALTER TABLE receipts
        ADD CONSTRAINT fk_receipts_bar FOREIGN KEY (bar_id) REFERENCES bars(id) ON DELETE SET NULL
      `);
    }

    // receipt_items.receipt_id → receipts(id)
    if (tableCheck.rows.length > 0) {
      const riReceiptIdCol = await client.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'receipt_items' AND column_name = 'receipt_id'
      `);
      if (riReceiptIdCol.rows.length > 0) {
        await client.query(`
          ALTER TABLE receipt_items
          ADD CONSTRAINT fk_receipt_items_receipt FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
        `);
      }
    }

    // Ricrea indici
    await client.query(`CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_receipts_bar_id ON receipts(bar_id)`);

    // Drop old sequence if it exists
    await client.query(`DROP SEQUENCE IF EXISTS receipts_id_seq`);

    // ═══════════════════════════════════════════════════════════
    // COMMIT
    // ═══════════════════════════════════════════════════════════
    await client.query("COMMIT");
    console.log("\n🎉 Migrazione receipts completata con successo!");
    console.log(`   Ricevute migrate: ${receipts.rows.length}`);

    // Verifica
    const checkReceipts = await client.query(`SELECT id FROM receipts LIMIT 3`);
    console.log("\n📋 Sample receipt IDs:", checkReceipts.rows.map((r: any) => r.id));

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
