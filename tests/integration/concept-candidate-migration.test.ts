import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { expect, it } from "vitest";

import { prepareTestDatabase } from "../support/prepare-test-database.js";

it("adds the V3.1 Candidate model without rewriting V3.0 Concepts", async () => {
  const database = prepareTestDatabase({ migrationsThrough: "0019_concepts.sql" });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const conceptId = randomUUID();
  const revisionId = randomUUID();

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, '事件系统')`,
      [conceptId, revisionId],
    );
    await pool.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, '事件系统', '事件系统', '事件在系统间异步流动。')`,
      [revisionId, conceptId],
    );
    await pool.query("COMMIT");

    const before = await pool.query(
      `SELECT concept.*, revision.*
         FROM concepts AS concept
         INNER JOIN concept_revisions AS revision
           ON revision.concept_id = concept.id
        WHERE concept.id = $1`,
      [conceptId],
    );
    const migration = await readFile(
      new URL("../../migrations/0020_concept_candidates.sql", import.meta.url),
      "utf8",
    );

    await pool.query(migration);

    expect(
      await pool.query(
        `SELECT concept.*, revision.*
           FROM concepts AS concept
           INNER JOIN concept_revisions AS revision
             ON revision.concept_id = concept.id
          WHERE concept.id = $1`,
        [conceptId],
      ),
    ).toMatchObject({ rows: before.rows });
    expect(
      await pool.query(
        `SELECT id FROM concept_candidate_scans
         UNION ALL SELECT id FROM concept_candidate_inputs
         UNION ALL SELECT id FROM concept_candidates
         UNION ALL SELECT candidate_id FROM concept_candidate_members
         UNION ALL SELECT candidate_id FROM concept_candidate_decision_members`,
      ),
    ).toMatchObject({ rowCount: 0 });
  } finally {
    await pool.end();
    database.dispose();
  }
}, 30_000);
