import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { expect, it } from "vitest";

import { prepareTestDatabase } from "../support/prepare-test-database.js";

it("adds every V2 domain table without rewriting V1 records, history, tags, or knowledge", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0013_analysis_prompt_preference.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const client = await pool.connect();
  const recordId = randomUUID();
  const revisionId = randomUUID();
  const firstTagId = randomUUID();
  const secondTagId = randomUUID();
  const firstAssignmentId = randomUUID();
  const secondAssignmentId = randomUUID();
  const analysisId = randomUUID();
  const pointId = randomUUID();
  const evidenceId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO records (id, current_fragment_revision_id) VALUES ($1, $2)",
      [recordId, revisionId],
    );
    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, 'V1 数据', 5)`,
      [revisionId, recordId],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'v1-model', 'V1 标题', 'V1 摘要', 'ACTIVE')`,
      [analysisId, recordId, revisionId],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, 'V1 知识点', 'V1 数据', 'CONFIRMED',
               'INCLUDED')`,
      [pointId, recordId, revisionId, analysisId],
    );
    await client.query(
      `INSERT INTO evidence_spans
         (id, knowledge_point_id, fragment_revision_id, position,
          start_offset, end_offset, quote)
       VALUES ($1, $2, $3, 1, 0, 5, 'V1 数据')`,
      [evidenceId, pointId, revisionId],
    );
    await client.query(
      "UPDATE records SET current_analysis_revision_id = $2 WHERE id = $1",
      [recordId, analysisId],
    );
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, 'CDC', 'cdc', 'USER_CREATED', 'USER_APPROVED', now()),
              ($2, '变更数据捕获', '变更数据捕获', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [firstTagId, secondTagId],
    );
    await client.query(
      `INSERT INTO tag_assignments (id, record_id, tag_id)
       VALUES ($1, $2, $3), ($4, $2, $5)`,
      [firstAssignmentId, recordId, firstTagId, secondAssignmentId, secondTagId],
    );
    await client.query("COMMIT");

    const v1Tables = [
      "records",
      "fragment_revisions",
      "tags",
      "tag_assignments",
      "ai_analysis_revisions",
      "knowledge_points",
      "evidence_spans",
    ];
    const before = await snapshotTables(client, v1Tables);

    for (const filename of [
      "0014_tag_governance.sql",
      "0015_duplicate_suggestions.sql",
      "0016_knowledge_relations.sql",
      "0017_coverage_analysis.sql",
      "0018_coverage_analysis_tasks.sql",
    ]) {
      const migration = await readFile(
        new URL(`../../migrations/${filename}`, import.meta.url),
        "utf8",
      );

      await client.query(migration);
    }

    const after = await snapshotTables(client, v1Tables);
    const tags = await client.query(
      "SELECT id, display_name, normalized_name FROM tags ORDER BY id",
    );
    const resolved = await client.query<{ id: string }>(
      "SELECT resolve_tag_id($1::uuid) AS id",
      [firstTagId],
    );

    expect(after).toEqual(before);
    expect(tags.rows).toEqual(
      [
        { id: firstTagId, display_name: "CDC", normalized_name: "cdc" },
        {
          id: secondTagId,
          display_name: "变更数据捕获",
          normalized_name: "变更数据捕获",
        },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(resolved.rows).toEqual([{ id: firstTagId }]);
    expect(
      await client.query(
        `SELECT id FROM tag_aliases
         UNION ALL SELECT id FROM tag_merges
         UNION ALL SELECT id FROM duplicate_suggestions
         UNION ALL SELECT id FROM duplicate_consolidations
         UNION ALL SELECT id FROM relation_suggestions
         UNION ALL SELECT id FROM knowledge_relations
         UNION ALL SELECT id FROM coverage_analyses
         UNION ALL SELECT id FROM coverage_analysis_items
         UNION ALL SELECT analysis_id FROM coverage_analysis_records
         UNION ALL SELECT item_id FROM coverage_item_records`,
      ),
    ).toMatchObject({ rowCount: 0 });
  } finally {
    client.release();
    await pool.end();
    database.dispose();
  }
}, 30_000);

async function snapshotTables(
  client: import("pg").PoolClient,
  tables: string[],
) {
  const snapshot: Record<string, unknown[]> = {};

  for (const table of tables) {
    const result = await client.query(`SELECT * FROM ${table} ORDER BY 1`);

    snapshot[table] = JSON.parse(JSON.stringify(result.rows)) as unknown[];
  }

  return snapshot;
}
