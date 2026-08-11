import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface SeededConceptMembership {
  analysisRevisionId: string;
  conceptId: string;
  conceptRevisionId: string;
  fragmentRevisionId: string;
  knowledgePointId: string;
  membershipActivityId: string;
  membershipId: string;
  recordId: string;
  tagId: string;
}

describe("permanent record deletion with Concept history", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
  let seeded: SeededConceptMembership;

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    seeded = await seedConceptMembership(pool);
    app = await buildApp({ databaseUrl: database.databaseUrl });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("deletes a record whose knowledge point has a Concept Membership", async () => {
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/records/${seeded.recordId}`,
    });

    expect(deleted.statusCode).toBe(204);
    expect(
      await pool.query("SELECT id FROM records WHERE id = $1", [
        seeded.recordId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query("SELECT id FROM concept_memberships WHERE id = $1", [
        seeded.membershipId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query("SELECT id FROM concept_activity WHERE id = $1", [
        seeded.membershipActivityId,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query(
        `SELECT kind
           FROM concept_activity
          WHERE concept_id = $1
          ORDER BY sequence_number`,
        [seeded.conceptId],
      ),
    ).toMatchObject({ rows: [{ kind: "CREATED" }] });
    expect(
      await pool.query("SELECT id FROM concepts WHERE id = $1", [
        seeded.conceptId,
      ]),
    ).toMatchObject({ rowCount: 1 });
  });
});

async function seedConceptMembership(
  pool: Pool,
): Promise<SeededConceptMembership> {
  const client = await pool.connect();
  const ids = {
    analysisRevisionId: randomUUID(),
    conceptId: randomUUID(),
    conceptRevisionId: randomUUID(),
    fragmentRevisionId: randomUUID(),
    knowledgePointId: randomUUID(),
    membershipActivityId: randomUUID(),
    membershipId: randomUUID(),
    recordId: randomUUID(),
    tagId: randomUUID(),
  };

  try {
    await insertConceptMembership(client, ids);
    return ids;
  } finally {
    client.release();
  }
}

async function insertConceptMembership(
  client: PoolClient,
  ids: SeededConceptMembership,
): Promise<void> {
  await client.query("BEGIN");

  try {
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, '永久删除概念来源', '永久删除概念来源', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [ids.tagId],
    );
    await client.query(
      `INSERT INTO records
         (id, current_fragment_revision_id, current_analysis_revision_id)
       VALUES ($1, $2, $3)`,
      [ids.recordId, ids.fragmentRevisionId, ids.analysisRevisionId],
    );
    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, '待永久删除的概念来源', 10)`,
      [ids.fragmentRevisionId, ids.recordId],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'delete-model', '待永久删除来源',
               '用于验证 Membership 级联。', 'ACTIVE')`,
      [ids.analysisRevisionId, ids.recordId, ids.fragmentRevisionId],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, '待删除知识点', '待删除知识点正文。',
               'AUTO_PUBLISHED', 'INCLUDED')`,
      [
        ids.knowledgePointId,
        ids.recordId,
        ids.fragmentRevisionId,
        ids.analysisRevisionId,
      ],
    );
    await client.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [ids.recordId, ids.tagId],
    );
    await client.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, '永久删除边界')`,
      [ids.conceptId, ids.conceptRevisionId],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, '永久删除边界', '永久删除边界',
               '记录删除不应被 Concept Membership 阻断。')`,
      [ids.conceptRevisionId, ids.conceptId],
    );
    await client.query(
      `INSERT INTO concept_memberships
         (id, concept_id, knowledge_point_id)
       VALUES ($1, $2, $3)`,
      [ids.membershipId, ids.conceptId, ids.knowledgePointId],
    );
    await client.query(
      `INSERT INTO concept_activity
         (concept_id, sequence_number, kind, revision_id)
       VALUES ($1, 1, 'CREATED', $2)`,
      [ids.conceptId, ids.conceptRevisionId],
    );
    await client.query(
      `INSERT INTO concept_activity
         (id, concept_id, sequence_number, kind, membership_id)
       VALUES ($1, $2, 2, 'MEMBER_ADDED', $3)`,
      [ids.membershipActivityId, ids.conceptId, ids.membershipId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
