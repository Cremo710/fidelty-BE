/**
 * Script di backfill: popola la tabella loyalty_cards dagli scontrini esistenti.
 *
 * Logica:
 *   - Raggruppa receipts per (user_id, bar_id)
 *   - Calcola SUM(points_earned), COUNT(*), MAX(created_at)
 *   - Inserisce/aggiorna loyalty_cards con ON CONFLICT
 *
 * Proprietà:
 *   - Idempotente: può essere eseguito più volte senza duplicare dati
 *   - Transaction safe: tutto in una singola transazione
 *
 * Uso:
 *   npx tsx src/migrations/backfillLoyaltyCards.ts
 */

import { config } from "dotenv";
config();

import { databaseService } from "../services/databaseService.js";
import { loyaltyCardRepository } from "../repositories/loyaltyCardRepository.js";

async function main() {
  try {
    console.log("🚀 Avvio backfill loyalty_cards...\n");

    // Assicura che la tabella loyalty_cards esista
    await databaseService.initializeTables();
    console.log("✅ Schema DB verificato\n");

    // Verifica quante ricevute con bar_id esistono
    const receiptStats = await databaseService.getPool().query(`
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT (user_id, bar_id)) AS combos
      FROM receipts
      WHERE user_id IS NOT NULL AND bar_id IS NOT NULL
    `);
    const { total, combos } = receiptStats.rows[0];
    console.log(`📊 Ricevute con user_id + bar_id: ${total}`);
    console.log(`📊 Combinazioni uniche (user, bar): ${combos}\n`);

    if (Number(combos) === 0) {
      console.log("ℹ️  Nessuna ricevuta con bar_id associato. Nulla da backfillare.");
      await databaseService.closePool();
      return;
    }

    // Esegui il backfill
    const cardsCreated = await loyaltyCardRepository.backfillFromReceipts();
    console.log(`\n🎉 Backfill completato: ${cardsCreated} carte fedeltà create/aggiornate`);

    // Verifica risultato
    const verifyResult = await databaseService.getPool().query(
      "SELECT COUNT(*) AS count FROM loyalty_cards"
    );
    console.log(`📋 Totale carte fedeltà in tabella: ${verifyResult.rows[0].count}`);

    await databaseService.closePool();
    console.log("\n✅ Backfill terminato con successo.");
  } catch (error) {
    console.error("\n❌ Errore durante il backfill:", error);
    process.exit(1);
  }
}

main();
