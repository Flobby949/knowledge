import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";

import { prepareTestDatabase } from "../support/prepare-test-database.js";

it("adds the V3.0 Concept model without rewriting existing V2 domain rows", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0018_coverage_analysis_tasks.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const client = await pool.connect();

  try {
    await seedExistingKnowledge(client);
    const existingTables = await listDomainTables(client);
    const before = await snapshotTables(client, existingTables);
    const migration = await readFile(
      new URL("../../migrations/0019_concepts.sql", import.meta.url),
      "utf8",
    );

    await client.query(migration);

    expect(await snapshotTables(client, existingTables)).toEqual(before);
    expect(
      await client.query(
        `SELECT id FROM concepts
         UNION ALL SELECT id FROM concept_revisions
         UNION ALL SELECT id FROM concept_memberships
         UNION ALL SELECT id FROM concept_activity`,
      ),
    ).toMatchObject({ rowCount: 0 });
  } finally {
    client.release();
    await pool.end();
    database.dispose();
  }
}, 30_000);

async function seedExistingKnowledge(client: PoolClient): Promise<void> {
  const recordId = randomUUID();
  const revisionId = randomUUID();
  const analysisId = randomUUID();
  const pointId = randomUUID();
  const tagId = randomUUID();

  await client.query("BEGIN");

  try {
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, 'V2 基线', 'v2 基线', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [tagId],
    );
    await client.query(
      `INSERT INTO records
         (id, current_fragment_revision_id, current_analysis_revision_id)
       VALUES ($1, $2, $3)`,
      [recordId, revisionId, analysisId],
    );
    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, 'V2 数据', 5)`,
      [revisionId, recordId],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'v2-model', 'V2 标题', 'V2 摘要', 'ACTIVE')`,
      [analysisId, recordId, revisionId],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, 'V2 知识点', 'V2 数据', 'CONFIRMED',
               'INCLUDED')`,
      [pointId, recordId, revisionId, analysisId],
    );
    await client.query(
      `INSERT INTO evidence_spans
         (knowledge_point_id, fragment_revision_id, position,
          start_offset, end_offset, quote)
       VALUES ($1, $2, 1, 0, 5, 'V2 数据')`,
      [pointId, revisionId],
    );
    await client.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [recordId, tagId],
    );
    await client.query(
      `INSERT INTO tag_aliases
         (tag_id, display_name, normalized_name)
       VALUES ($1, 'V2 Alias', 'v2 alias')`,
      [tagId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function listDomainTables(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> 'schema_migrations'
      ORDER BY tablename`,
  );

  return result.rows.map(({ tablename }) => tablename);
}

async function snapshotTables(client: PoolClient, tables: string[]) {
  const snapshot: Record<string, unknown[]> = {};

  for (const table of tables) {
    const result = await client.query(`SELECT * FROM ${table} ORDER BY 1`);

    snapshot[table] = JSON.parse(JSON.stringify(result.rows)) as unknown[];
  }

  return snapshot;
}
