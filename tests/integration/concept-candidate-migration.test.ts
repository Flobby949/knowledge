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

it("adds durable automatic discovery triggers without backfilling historical knowledge", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0020_concept_candidates.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const recordId = randomUUID();
  const revisionId = randomUUID();
  const analysisId = randomUUID();
  const pointId = randomUUID();
  const scanId = randomUUID();
  const tagId = randomUUID();

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, '迁移测试', '迁移测试', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [tagId],
    );
    await pool.query(
      `INSERT INTO records
         (id, current_fragment_revision_id, current_analysis_revision_id)
       VALUES ($1, $2, $3)`,
      [recordId, revisionId, analysisId],
    );
    await pool.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, '历史知识', 4)`,
      [revisionId, recordId],
    );
    await pool.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'migration-model', '历史知识', '历史摘要', 'ACTIVE')`,
      [analysisId, recordId, revisionId],
    );
    await pool.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, '历史知识', '历史知识正文',
               'AUTO_PUBLISHED', 'INCLUDED')`,
      [pointId, recordId, revisionId, analysisId],
    );
    await pool.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [recordId, tagId],
    );
    await pool.query("COMMIT");

    const migration = await readFile(
      new URL(
        "../../migrations/0021_automatic_concept_discovery.sql",
        import.meta.url,
      ),
      "utf8",
    );

    await pool.query(migration);

    expect(
      await pool.query("SELECT * FROM concept_candidate_discovery_queue"),
    ).toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(
        `INSERT INTO concept_candidate_scans
           (id, input_fingerprint, input_count, model_configuration_version,
            text_model, status, outcome, outcome_reason, started_at,
            completed_at)
         VALUES ($1, $2, 1, 1, 'migration-model', 'SUCCEEDED',
                 'NO_SUGGESTION', '没有召回结果', now(), now())`,
        [randomUUID(), "e".repeat(64)],
      ),
    ).rejects.toMatchObject({ constraint: "concept_candidate_scans_automatic_single_input_check" });
    expect(
      await pool.query(
        `INSERT INTO concept_candidate_scans
           (id, input_fingerprint, input_count, model_configuration_version,
            text_model, trigger_analysis_revision_id, status, outcome,
            outcome_reason, started_at, completed_at)
         VALUES ($1, $2, 1, 1, 'migration-model', $3, 'SUCCEEDED',
                 'NO_SUGGESTION', '没有召回结果', now(), now())
         RETURNING trigger_analysis_revision_id`,
        [scanId, "f".repeat(64), analysisId],
      ),
    ).toMatchObject({ rows: [{ trigger_analysis_revision_id: analysisId }] });
  } finally {
    await pool.end();
    database.dispose();
  }
}, 30_000);
