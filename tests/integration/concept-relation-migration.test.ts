import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { expect, it } from "vitest";

import { conceptMembershipFingerprint } from "../../src/domain/concept-relation.js";
import { prepareTestDatabase } from "../support/prepare-test-database.js";

it("adds Concept Relations without rewriting V3.1 history", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0021_automatic_concept_discovery.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const client = await pool.connect();

  try {
    const seeded = await seedConceptHistory(client);
    const existingTables = await listDomainTables(client);
    const before = await snapshotTables(client, existingTables);
    const migration = await readFile(
      new URL("../../migrations/0022_concept_relations.sql", import.meta.url),
      "utf8",
    );

    await client.query(migration);

    expect(await snapshotTables(client, existingTables)).toEqual(before);
    expect(
      await client.query(
        `SELECT id FROM concept_relation_suggestions
         UNION ALL SELECT id FROM concept_relations`,
      ),
    ).toMatchObject({ rowCount: 0 });

    expect(
      await client.query<{ values: string[] }>(
        `SELECT enum_range(NULL::knowledge_relation_type)::text[] AS values`,
      ),
    ).toMatchObject({
      rows: [
        {
          values: [
            "SIMILAR",
            "CONTRASTS",
            "PREREQUISITE",
            "EXTENDS",
            "APPLIES",
            "ANALOGY",
          ],
        },
      ],
    });

    expect(
      await client.query<{ confdeltype: string; conname: string }>(
        `SELECT conname, confdeltype
           FROM pg_constraint
          WHERE conname = ANY($1::text[])
          ORDER BY conname`,
        [
          [
            "concept_activity_membership_id_fkey",
            "concept_candidate_decision_members_concept_membership_id_fkey",
            "concept_memberships_knowledge_point_id_fkey",
          ],
        ],
      ),
    ).toMatchObject({
      rows: [
        {
          confdeltype: "c",
          conname: "concept_activity_membership_id_fkey",
        },
        {
          confdeltype: "c",
          conname:
            "concept_candidate_decision_members_concept_membership_id_fkey",
        },
        {
          confdeltype: "c",
          conname: "concept_memberships_knowledge_point_id_fkey",
        },
      ],
    });

    await expect(
      client.query("DELETE FROM concept_activity WHERE id = $1", [
        seeded.activityId,
      ]),
    ).rejects.toMatchObject({ constraint: "concept_activity_immutable" });

    await expect(
      insertSuggestion(client, seeded, {
        inputFingerprint: "not-a-sha256",
        relationType: "EXTENDS",
      }),
    ).rejects.toMatchObject({
      constraint: "concept_relation_suggestions_fingerprint_check",
    });

    await expect(
      insertSuggestion(client, seeded, {
        inputFingerprint: "a".repeat(64),
        relationType: "SIMILAR",
        sourceConceptId: seeded.targetConceptId,
        sourceRevisionId: seeded.targetRevisionId,
        targetConceptId: seeded.sourceConceptId,
        targetRevisionId: seeded.sourceRevisionId,
      }),
    ).rejects.toMatchObject({
      constraint: "concept_relation_suggestions_symmetric_canonical_check",
    });

    await expect(
      insertSuggestion(client, seeded, {
        inputFingerprint: "f".repeat(64),
        relationType: "EXTENDS",
        sourceRevisionId: seeded.targetRevisionId,
      }),
    ).rejects.toMatchObject({
      constraint: "concept_relation_suggestions_source_revision_fk",
    });

    const firstSuggestionId = randomUUID();

    await insertSuggestion(client, seeded, {
      id: firstSuggestionId,
      inputFingerprint: "b".repeat(64),
      relationType: "EXTENDS",
    });
    await expect(
      client.query(
        `INSERT INTO concept_relations
           (suggestion_id, source_concept_id, target_concept_id,
            relation_type, description)
         VALUES ($1, $2, $3, 'EXTENDS', '事件源扩展到事件目标。')`,
        [
          firstSuggestionId,
          seeded.sourceConceptId,
          seeded.targetConceptId,
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_confirmed_suggestion",
    });

    await client.query(
      `UPDATE concept_relation_suggestions
          SET status = 'CONFIRMED',
              decided_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [firstSuggestionId],
    );
    await client.query(
      `INSERT INTO concept_relations
         (suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, 'EXTENDS', '事件源扩展到事件目标。')`,
      [
        firstSuggestionId,
        seeded.sourceConceptId,
        seeded.targetConceptId,
      ],
    );
    await expect(
      client.query(
        `UPDATE concept_relations
            SET relation_type = 'APPLIES',
                description = '不能改写已经确认的事实。'
          WHERE suggestion_id = $1`,
        [firstSuggestionId],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_identity_immutable",
    });
    await expect(
      client.query(
        `UPDATE concept_relation_suggestions
            SET status = 'REJECTED'
          WHERE id = $1`,
        [firstSuggestionId],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relation_suggestions_decision_immutable",
    });
    await expect(
      client.query("DELETE FROM concept_relation_suggestions WHERE id = $1", [
        firstSuggestionId,
      ]),
    ).rejects.toMatchObject({
      constraint: "concept_relation_suggestions_history_immutable",
    });
    await expect(
      client.query("DELETE FROM concept_relations WHERE suggestion_id = $1", [
        firstSuggestionId,
      ]),
    ).rejects.toMatchObject({
      constraint: "concept_relations_history_immutable",
    });
    await expect(
      client.query(
        `UPDATE concept_relations
            SET removed_at = now()
          WHERE suggestion_id = $1`,
        [firstSuggestionId],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_confirmed_suggestion",
    });

    const secondSuggestionId = randomUUID();

    await insertSuggestion(client, seeded, {
      id: secondSuggestionId,
      inputFingerprint: "c".repeat(64),
      relationType: "APPLIES",
      status: "CONFIRMED",
    });
    await client.query(
      `INSERT INTO concept_relations
         (suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, 'APPLIES', '事件源应用于事件目标。')`,
      [
        secondSuggestionId,
        seeded.sourceConceptId,
        seeded.targetConceptId,
      ],
    );
    await client.query(
      `UPDATE concept_relation_suggestions
          SET status = 'REMOVED',
              updated_at = now()
        WHERE id = $1`,
      [secondSuggestionId],
    );
    await client.query(
      `UPDATE concept_relations
          SET removed_at = now()
        WHERE suggestion_id = $1`,
      [secondSuggestionId],
    );
    await expect(
      client.query(
        `UPDATE concept_relations
            SET removed_at = removed_at + interval '1 second'
          WHERE suggestion_id = $1`,
        [secondSuggestionId],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_identity_immutable",
    });

    expect(
      await client.query(
        `SELECT relation_type
           FROM concept_relations
          WHERE source_concept_id = $1
            AND target_concept_id = $2
          ORDER BY relation_type`,
        [seeded.sourceConceptId, seeded.targetConceptId],
      ),
    ).toMatchObject({
      rows: [{ relation_type: "EXTENDS" }, { relation_type: "APPLIES" }],
    });

    const symmetricSuggestionId = randomUUID();

    await insertSuggestion(client, seeded, {
      id: symmetricSuggestionId,
      inputFingerprint: "7".repeat(64),
      relationType: "EXTENDS",
      sourceConceptId: seeded.targetConceptId,
      sourceRevisionId: seeded.targetRevisionId,
      status: "CONFIRMED",
      targetConceptId: seeded.sourceConceptId,
      targetRevisionId: seeded.sourceRevisionId,
    });
    await expect(
      client.query(
        `INSERT INTO concept_relations
           (suggestion_id, source_concept_id, target_concept_id,
            relation_type, description)
         VALUES ($1, $2, $3, 'EXTENDS', '有向关系不能调换确认方向。')`,
        [
          symmetricSuggestionId,
          seeded.sourceConceptId,
          seeded.targetConceptId,
        ],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_confirmed_suggestion",
    });
    await client.query(
      `INSERT INTO concept_relations
         (suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, 'SIMILAR', '对称关系按端点 ID 规范化。')`,
      [
        symmetricSuggestionId,
        seeded.sourceConceptId,
        seeded.targetConceptId,
      ],
    );
  } finally {
    client.release();
    await pool.end();
    database.dispose();
  }
}, 30_000);

it("backfills AI confirmation snapshots and permits immutable user-authored relations", async () => {
  const database = prepareTestDatabase({
    migrationsThrough: "0022_concept_relations.sql",
  });
  const pool = new Pool({ connectionString: database.databaseUrl });
  const client = await pool.connect();

  try {
    const seeded = await seedConceptHistory(client);
    const suggestionId = randomUUID();

    await insertSuggestion(client, seeded, {
      id: suggestionId,
      inputFingerprint: "9".repeat(64),
      relationType: "EXTENDS",
      status: "CONFIRMED",
    });
    await client.query(
      `INSERT INTO concept_relations
         (suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, 'EXTENDS', '迁移前确认的关系。')`,
      [suggestionId, seeded.sourceConceptId, seeded.targetConceptId],
    );
    const migration = await readFile(
      new URL("../../migrations/0023_user_concept_relations.sql", import.meta.url),
      "utf8",
    );

    await client.query(migration);

    expect(
      await client.query(
        `SELECT confirmation_source, source_concept_revision_id,
                target_concept_revision_id, source_membership_fingerprint,
                target_membership_fingerprint
           FROM concept_relations
          WHERE suggestion_id = $1`,
        [suggestionId],
      ),
    ).toMatchObject({
      rows: [
        {
          confirmation_source: "AI_SUGGESTION",
          source_concept_revision_id: seeded.sourceRevisionId,
          target_concept_revision_id: seeded.targetRevisionId,
          source_membership_fingerprint: seeded.sourceMembershipFingerprint,
          target_membership_fingerprint: seeded.targetMembershipFingerprint,
        },
      ],
    });

    const userRelationId = randomUUID();

    await client.query(
      `INSERT INTO concept_relations
         (id, confirmation_source, source_concept_id, target_concept_id,
          source_concept_revision_id, target_concept_revision_id,
          source_membership_fingerprint, target_membership_fingerprint,
          relation_type, description)
       VALUES ($1, 'USER', $2, $3, $4, $5, $6, $7,
               'APPLIES', '用户直接建立的关系。')`,
      [
        userRelationId,
        seeded.sourceConceptId,
        seeded.targetConceptId,
        seeded.sourceRevisionId,
        seeded.targetRevisionId,
        seeded.sourceMembershipFingerprint,
        seeded.targetMembershipFingerprint,
      ],
    );
    expect(
      await client.query(
        `SELECT suggestion_id, confirmation_source
           FROM concept_relations
          WHERE id = $1`,
        [userRelationId],
      ),
    ).toMatchObject({
      rows: [{ confirmation_source: "USER", suggestion_id: null }],
    });
    await expect(
      client.query(
        `UPDATE concept_relations
            SET source_membership_fingerprint = $2
          WHERE id = $1`,
        [userRelationId, "0".repeat(64)],
      ),
    ).rejects.toMatchObject({
      constraint: "concept_relations_identity_immutable",
    });
  } finally {
    client.release();
    await pool.end();
    database.dispose();
  }
}, 30_000);

interface SeededConceptHistory {
  activityId: string;
  sourceConceptId: string;
  sourceMembershipFingerprint: string;
  sourceRevisionId: string;
  targetConceptId: string;
  targetMembershipFingerprint: string;
  targetRevisionId: string;
}

async function seedConceptHistory(
  client: PoolClient,
): Promise<SeededConceptHistory> {
  const recordId = randomUUID();
  const fragmentRevisionId = randomUUID();
  const analysisRevisionId = randomUUID();
  const knowledgePointId = randomUUID();
  const tagId = randomUUID();
  const sourceConceptId = "00000000-0000-4000-8000-000000000001";
  const targetConceptId = "00000000-0000-4000-8000-000000000002";
  const sourceRevisionId = randomUUID();
  const targetRevisionId = randomUUID();
  const membershipId = randomUUID();
  const activityId = randomUUID();

  await client.query("BEGIN");

  try {
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, '网络迁移', '网络迁移', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [tagId],
    );
    await client.query(
      `INSERT INTO records
         (id, current_fragment_revision_id, current_analysis_revision_id)
       VALUES ($1, $2, $3)`,
      [recordId, fragmentRevisionId, analysisRevisionId],
    );
    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, '网络迁移知识', 6)`,
      [fragmentRevisionId, recordId],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'migration-model', '网络迁移知识',
               '迁移前知识摘要', 'ACTIVE')`,
      [analysisRevisionId, recordId, fragmentRevisionId],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, '网络迁移知识点', '网络迁移知识正文',
               'AUTO_PUBLISHED', 'INCLUDED')`,
      [knowledgePointId, recordId, fragmentRevisionId, analysisRevisionId],
    );
    await client.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [recordId, tagId],
    );
    await client.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, '事件源'), ($3, $4, '事件目标')`,
      [
        sourceConceptId,
        sourceRevisionId,
        targetConceptId,
        targetRevisionId,
      ],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, '事件源', '事件源', '事件产生的稳定概念。'),
              ($3, $4, 1, '事件目标', '事件目标', '事件抵达的稳定概念。')`,
      [
        sourceRevisionId,
        sourceConceptId,
        targetRevisionId,
        targetConceptId,
      ],
    );
    await client.query(
      `INSERT INTO concept_memberships
         (id, concept_id, knowledge_point_id)
       VALUES ($1, $2, $3)`,
      [membershipId, sourceConceptId, knowledgePointId],
    );
    await client.query(
      `INSERT INTO concept_activity
         (id, concept_id, sequence_number, kind, membership_id)
       VALUES ($1, $2, 1, 'MEMBER_ADDED', $3)`,
      [activityId, sourceConceptId, membershipId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    activityId,
    sourceConceptId,
    sourceMembershipFingerprint: conceptMembershipFingerprint([
      { id: membershipId, knowledgePointId },
    ]),
    sourceRevisionId,
    targetConceptId,
    targetMembershipFingerprint: conceptMembershipFingerprint([]),
    targetRevisionId,
  };
}

async function insertSuggestion(
  client: PoolClient,
  seeded: SeededConceptHistory,
  options: {
    id?: string;
    inputFingerprint: string;
    relationType: string;
    sourceConceptId?: string;
    sourceRevisionId?: string;
    status?: "CONFIRMED" | "PENDING_REVIEW";
    targetConceptId?: string;
    targetRevisionId?: string;
  },
): Promise<void> {
  const status = options.status ?? "PENDING_REVIEW";
  const sourceConceptId =
    options.sourceConceptId ?? seeded.sourceConceptId;
  const targetConceptId =
    options.targetConceptId ?? seeded.targetConceptId;
  const sourceMembershipFingerprint =
    sourceConceptId === seeded.sourceConceptId
      ? seeded.sourceMembershipFingerprint
      : seeded.targetMembershipFingerprint;
  const targetMembershipFingerprint =
    targetConceptId === seeded.sourceConceptId
      ? seeded.sourceMembershipFingerprint
      : seeded.targetMembershipFingerprint;

  await client.query(
    `INSERT INTO concept_relation_suggestions
       (id, pair_key, input_fingerprint, source_concept_id,
        target_concept_id, source_concept_revision_id,
        target_concept_revision_id, source_membership_fingerprint,
        target_membership_fingerprint, relation_type, description, reason,
        confidence, model_configuration_version, text_model, status,
        decided_at)
     VALUES ($1, 'concept-a:concept-b', $2, $3, $4, $5, $6, $7, $8,
             $9::knowledge_relation_type, '事件概念之间存在关系。',
             '两端的确认知识共同支持该关系。', 0.85, 1,
             'migration-model', $10::relation_suggestion_status,
             CASE WHEN $10 = 'PENDING_REVIEW' THEN NULL ELSE now() END)`,
    [
      options.id ?? randomUUID(),
      options.inputFingerprint,
      sourceConceptId,
      targetConceptId,
      options.sourceRevisionId ?? seeded.sourceRevisionId,
      options.targetRevisionId ?? seeded.targetRevisionId,
      sourceMembershipFingerprint,
      targetMembershipFingerprint,
      options.relationType,
      status,
    ],
  );
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
