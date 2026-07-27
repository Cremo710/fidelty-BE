/**
 * OCR Benchmark — Gate obbligatorio prima del deploy Fase 1
 *
 * Uso:
 *   1. Metti le foto degli scontrini in ./benchmark/receipts/
 *   2. Crea ./benchmark/expected.json (vedi formato sotto)
 *   3. Esegui: npx tsx src/scripts/ocrBenchmark.ts
 *
 * Formato expected.json:
 * {
 *   "scontrino_01.jpg": { "amount": 12.50, "vatNumber": "01234567890", "docId": "0001-0042", "date": "2026-07-20" },
 *   "scontrino_02.jpg": { "amount": 8.00,  "vatNumber": null,          "docId": null,         "date": "2026-07-21" }
 * }
 * (usa null per i campi che non compaiono sullo scontrino)
 *
 * Soglie di accettazione (§9):
 *   - importo  > 90%
 *   - P.IVA    > 90%
 *   - docId    > 90%
 * Se P.IVA è sotto soglia → aggiungi la maschera di inquadratura e rifotografa.
 * Se risultati molto sotto soglia → segnala prima di procedere con l'integrazione.
 */

import { config } from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { extractReceiptFields } from "../services/visionOcrService.js";

config();

interface ExpectedValues {
  amount?: number | null;
  vatNumber?: string | null;
  docId?: string | null;
  date?: string | null;
}

interface BenchmarkResult {
  file: string;
  expected: ExpectedValues;
  got: {
    amount: number | null;
    vatNumber: string | null;
    docId: string | null;
    date: string | null;
  };
  hits: { amount: boolean; vatNumber: boolean; docId: boolean; date: boolean };
  durationMs: number;
}

const BENCHMARK_DIR = join(process.cwd(), "benchmark", "receipts");
const EXPECTED_PATH = join(process.cwd(), "benchmark", "expected.json");

async function runBenchmark(): Promise<void> {
  let expected: Record<string, ExpectedValues>;
  try {
    expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf-8"));
  } catch {
    console.error(`❌ expected.json non trovato o non valido: ${EXPECTED_PATH}`);
    console.error("   Crea il file con i valori attesi. Vedi il commento in testa a questo script.");
    process.exit(1);
  }

  const files = readdirSync(BENCHMARK_DIR).filter((f) =>
    /\.(jpg|jpeg|png|webp)$/i.test(f),
  );

  if (files.length === 0) {
    console.error(`❌ Nessuna immagine trovata in ${BENCHMARK_DIR}`);
    process.exit(1);
  }

  console.log(`\n📸 OCR Benchmark — ${files.length} scontrini\n`);

  const results: BenchmarkResult[] = [];

  for (const file of files) {
    const filePath = join(BENCHMARK_DIR, file);
    const exp = expected[file] ?? expected[basename(file)] ?? {};
    let imageBuffer: Buffer;
    try {
      imageBuffer = readFileSync(filePath);
    } catch {
      console.warn(`⚠️ Impossibile leggere ${file}, saltato`);
      continue;
    }

    process.stdout.write(`  ${file.padEnd(40)} ... `);
    const ocrResult = await extractReceiptFields(imageBuffer);

    const hits = {
      // Un campo è un "hit" se:
      //   - il valore atteso è null E il campo non viene letto (entrambi null) → conteggiato come corretto
      //   - il valore atteso è definito E il valore letto coincide
      amount:    exp.amount == null
        ? ocrResult.amount.value == null
        : ocrResult.amount.value !== null && Math.abs(ocrResult.amount.value - (exp.amount ?? 0)) < 0.01,
      vatNumber: exp.vatNumber == null
        ? ocrResult.vatNumber.value == null
        : ocrResult.vatNumber.value === exp.vatNumber,
      docId:     exp.docId == null
        ? ocrResult.docId.value == null
        : ocrResult.docId.value === exp.docId,
      date:      exp.date == null
        ? ocrResult.date.value == null
        : ocrResult.date.value === exp.date,
    };

    // Solo i campi attesi != null contano per le percentuali di lettura
    const summary = [
      `amt:${hits.amount ? "✓" : "✗"}`,
      `iva:${hits.vatNumber ? "✓" : "✗"}`,
      `doc:${hits.docId ? "✓" : "✗"}`,
    ].join(" ");
    console.log(`${summary}  (${ocrResult.durationMs}ms)`);

    results.push({
      file,
      expected: exp,
      got: {
        amount:    ocrResult.amount.value,
        vatNumber: ocrResult.vatNumber.value,
        docId:     ocrResult.docId.value,
        date:      ocrResult.date.value,
      },
      hits,
      durationMs: ocrResult.durationMs,
    });
  }

  // ── Calcola le percentuali (solo sui campi dove il valore atteso è non-null) ──

  function pct(field: keyof typeof results[0]["hits"]): { correct: number; total: number; pct: number } {
    const relevant = results.filter((r) => {
      const ev = r.expected[field];
      return ev !== null && ev !== undefined;
    });
    if (relevant.length === 0) return { correct: 0, total: 0, pct: 100 };
    const correct = relevant.filter((r) => r.hits[field]).length;
    return { correct, total: relevant.length, pct: Math.round((correct / relevant.length) * 100) };
  }

  const amountStats    = pct("amount");
  const vatStats       = pct("vatNumber");
  const docIdStats     = pct("docId");

  console.log("\n─────────────────────────────────────────────────────");
  console.log("📊 RISULTATI BENCHMARK");
  console.log("─────────────────────────────────────────────────────");
  console.log(`  Importo:  ${amountStats.correct}/${amountStats.total} → ${amountStats.pct}%  ${amountStats.pct >= 90 ? "✅" : "❌"}`);
  console.log(`  P.IVA:    ${vatStats.correct}/${vatStats.total} → ${vatStats.pct}%  ${vatStats.pct >= 90 ? "✅" : "❌"}`);
  console.log(`  Doc ID:   ${docIdStats.correct}/${docIdStats.total} → ${docIdStats.pct}%  ${docIdStats.pct >= 90 ? "✅" : "❌"}`);
  console.log("─────────────────────────────────────────────────────");

  const allPass = amountStats.pct >= 90 && vatStats.pct >= 90 && docIdStats.pct >= 90;

  if (allPass) {
    console.log("\n✅ Tutte le soglie superate. La proposta regge — procedi con l'integrazione.\n");
  } else {
    if (vatStats.pct < 90) {
      console.log("\n⚠️  P.IVA sotto soglia.");
      console.log("   → Aggiungi la maschera di inquadratura (intestazione in alto) e rifotografa.");
      console.log("   → Assicurati che la foto includa le prime righe dello scontrino.");
    }
    if (amountStats.pct < 60 || docIdStats.pct < 60) {
      console.log("\n❌ Risultati molto sotto soglia.");
      console.log("   → Segnala prima di procedere con l'integrazione completa.");
    }
    console.log();
  }

  // Dettaglio fallimenti
  const failures = results.filter((r) => !r.hits.amount || !r.hits.vatNumber || !r.hits.docId);
  if (failures.length > 0) {
    console.log("📋 Dettaglio fallimenti:");
    for (const f of failures) {
      console.log(`  ${f.file}:`);
      if (!f.hits.amount)    console.log(`    importo  → atteso: ${f.expected.amount}  letto: ${f.got.amount}`);
      if (!f.hits.vatNumber) console.log(`    P.IVA    → atteso: ${f.expected.vatNumber}  letto: ${f.got.vatNumber}`);
      if (!f.hits.docId)     console.log(`    docId    → atteso: ${f.expected.docId}  letto: ${f.got.docId}`);
    }
    console.log();
  }
}

runBenchmark().catch((err) => {
  console.error("❌ Benchmark fallito:", err.message);
  process.exit(1);
});
