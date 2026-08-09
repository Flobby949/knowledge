import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { expect, it } from "vitest";

import { prepareTestDatabase } from "../support/prepare-test-database.js";

it("upgrades existing AI tag assignments without leaving pending trigger events", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0011_instance_preferences.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const client = await pool.connect();
  const recordId = randomUUID();
  const fragmentId = randomUUID();
  const taskId = randomUUID();
  const analysisId = randomUUID();
  const pointId = randomUUID();
  const userTagId = randomUUID();
  const aiTagId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO model_configurations
         (state,
          text_base_url,
          text_model,
          text_credential_ciphertext,
          embedding_base_url,
          embedding_model,
          embedding_credential_ciphertext,
          activated_at)
       VALUES ('ACTIVE', 'https://text.invalid', 'legacy-text', 'ciphertext',
               'https://embedding.invalid', 'legacy-embedding', 'ciphertext',
               now())`,
    );
    await client.query(
      `INSERT INTO records (id, current_fragment_revision_id)
       VALUES ($1, $2)`,
      [recordId, fragmentId],
    );
    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, '旧数据', 3)`,
      [fragmentId, recordId],
    );
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, '旧用户标签', '旧用户标签', 'USER_CREATED',
               'USER_APPROVED', now()),
              ($2, 'CDC', 'cdc', 'AI_CREATED', 'CANDIDATE', NULL)`,
      [userTagId, aiTagId],
    );
    await client.query(
      `INSERT INTO tag_assignments
         (record_id, tag_id, assigned_by, status)
       VALUES ($1, $2, 'USER', 'ACTIVE')`,
      [recordId, userTagId],
    );
    await client.query(
      `INSERT INTO ai_tasks
         (id, record_id, fragment_revision_id, model_config_version,
          handling, status, generation_attempts, finished_at)
       VALUES ($1, $2, $3, 1, 'AUTOMATIC', 'SUCCEEDED', 1, now())`,
      [taskId, recordId, fragmentId],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, task_id,
          model_config_version, text_model, title, summary, status)
       VALUES ($1, $2, $3, $4, 1, 'legacy-text', '旧标题', '旧摘要',
               'ACTIVE')`,
      [analysisId, recordId, fragmentId, taskId],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status)
       VALUES ($1, $2, $3, $4, 1, '旧知识点', '旧正文', 'AUTO_PUBLISHED')`,
      [pointId, recordId, fragmentId, analysisId],
    );
    await client.query(
      `INSERT INTO tag_assignments
         (knowledge_point_id, tag_id, assigned_by, status)
       VALUES ($1, $2, 'AI', 'ACTIVE')`,
      [pointId, aiTagId],
    );
    await client.query(
      "UPDATE records SET current_analysis_revision_id = $2 WHERE id = $1",
      [recordId, analysisId],
    );
    await client.query("COMMIT");

    const migration = await readFile(
      new URL("../../migrations/0012_tag_assignment_provenance.sql", import.meta.url),
      "utf8",
    );

    await client.query(migration);

    const assignments = await client.query<{
      assigned_by: "USER" | "AI";
      analysis_revision_id: string | null;
      raw_label: string | null;
    }>(
      `SELECT assigned_by, analysis_revision_id, raw_label
         FROM tag_assignments
        ORDER BY assigned_by`,
    );

    expect(assignments.rows).toEqual([
      {
        assigned_by: "USER",
        analysis_revision_id: null,
        raw_label: null,
      },
      {
        assigned_by: "AI",
        analysis_revision_id: analysisId,
        raw_label: "CDC",
      },
    ]);
  } finally {
    client.release();
    await pool.end();
    database.dispose();
  }
}, 30_000);
