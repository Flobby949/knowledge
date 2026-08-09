import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge";
const migrationsDirectory = fileURLToPath(
  new URL("../migrations", import.meta.url),
);
const client = new Client({ connectionString: databaseUrl });

await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const alreadyApplied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [filename],
    );

    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await readFile(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1)",
      [filename],
    );
    process.stdout.write(`Applied ${filename}\n`);
  }
} finally {
  await client.end();
}
