import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";

export async function migrate(db: Pool) {
  const folder = new URL("../db/", import.meta.url);
  const files = (await readdir(folder))
    .filter((x) => /^\d+\.sql$/.test(x))
    .sort();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(794622371)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(rows.map((x) => x.version));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, folder), "utf8"));
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [
        file,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
