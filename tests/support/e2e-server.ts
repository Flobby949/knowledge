import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the E2E server");
}

await import("../../scripts/migrate.js");

const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(
    "TRUNCATE data_restores, restore_inspections, data_exports, model_configurations, records, tags CASCADE",
  );
  await pool.query(
    `UPDATE instance_preferences
        SET default_ai_handling = 'AUTOMATIC',
            updated_at = clock_timestamp()
      WHERE singleton = true`,
  );
} finally {
  await pool.end();
}

process.env.E2E_FAKE_AI = "1";
await import("../../src/server.js");
