import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7312602)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    // This relative path works both from src/db and dist/db.
    const directory = new URL("../../migrations/", import.meta.url);
    for (const name of (await readdir(directory)).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
      if ((await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name])).rowCount) continue;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try { await migrate(pool); console.log("Database migrations applied"); }
  finally { await pool.end(); }
}
