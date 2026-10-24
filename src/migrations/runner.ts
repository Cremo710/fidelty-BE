import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;

// Gli .sql non vengono copiati da tsc in dist/: si leggono sempre da src/migrations
const MIGRATIONS_DIR = fs.existsSync(path.resolve(process.cwd(), "src/migrations"))
  ? path.resolve(process.cwd(), "src/migrations")
  : path.dirname(fileURLToPath(import.meta.url));


function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort();
}

/**
 * Applica in ordine i file SQL di src/migrations non ancora registrati in schema_migrations.
 * Ogni file viene eseguito in una transazione insieme alla sua registrazione.
 */
export async function runMigrations(pool: InstanceType<typeof Pool>): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    // Lock globale: più istanze che partono insieme non applicano due volte le migration
    await client.query("SELECT pg_advisory_lock(hashtext('fidelty_migrations'))");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        VARCHAR(255) PRIMARY KEY,
        applied_at  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const files = listMigrationFiles();
    const done = new Set<string>(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );

    // Tutte le migration sono idempotenti: su un database già in uso la prima esecuzione
    // le riapplica senza effetti e le registra.
    for (const file of files) {
      if (done.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`🚚 Applico migration ${file}...`);

      try {
        // I file che contengono già BEGIN/COMMIT gestiscono da soli la transazione
        const selfManaged = /^\s*BEGIN\s*;/im.test(sql);
        if (!selfManaged) await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        if (!selfManaged) await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error(`❌ Migration ${file} fallita:`, error);
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('fidelty_migrations'))").catch(() => undefined);
    client.release();
  }

  return applied;
}
