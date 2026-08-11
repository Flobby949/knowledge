import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the visual E2E server");
}

await import("../../scripts/migrate.js");

const pool = new Pool({ connectionString: databaseUrl });

try {
  await pool.query(
    `TRUNCATE data_restores, restore_inspections, data_exports,
       model_configurations, concept_candidate_decision_members,
       concept_candidate_members, concept_candidates,
       concept_candidate_inputs, concept_candidate_scans, concept_activity,
       concept_memberships, concept_revisions, concepts, records, tags
       RESTART IDENTITY CASCADE`,
  );
  await pool.query(
    `UPDATE instance_preferences
        SET default_ai_handling = 'AUTOMATIC',
            analysis_prompt = DEFAULT,
            updated_at = clock_timestamp()
      WHERE singleton = true`,
  );
} finally {
  await pool.end();
}

process.env.E2E_FAKE_AI = "1";
await import("../../src/server.js");
