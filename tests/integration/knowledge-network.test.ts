import { createHash, randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conceptMembershipFingerprint } from "../../src/domain/concept-relation.js";
import { registerNetworkRoutes } from "../../src/network-routes.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("V3.2 knowledge network", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = Fastify();
    registerNetworkRoutes(app, { pool });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("finds a reverse path while preserving every edge's canonical endpoints", async () => {
    const firstPoint = await seedCurrentKnowledgePoint(pool, "发布事件");
    const secondPoint = await seedCurrentKnowledgePoint(pool, "消费事件");
    const firstConcept = await seedConcept(pool, "事件发布", firstPoint.id);
    const secondConcept = await seedConcept(pool, "事件消费", secondPoint.id);
    const relation = await seedKnowledgeRelation(
      pool,
      firstPoint,
      secondPoint,
      "PREREQUISITE",
    );

    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/network/path?from=concept:${secondConcept.id}` +
        `&to=concept:${firstConcept.id}&maxDepth=3`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: {
        nodes: [
          { key: `concept:${secondConcept.id}` },
          { key: `knowledge_point:${secondPoint.id}` },
          { key: `knowledge_point:${firstPoint.id}` },
          { key: `concept:${firstConcept.id}` },
        ],
        steps: [
          {
            kind: "concept_membership",
            traversalDirection: "undirected",
          },
          {
            edgeKey: `knowledge_relation:${relation.id}`,
            source: `knowledge_point:${firstPoint.id}`,
            target: `knowledge_point:${secondPoint.id}`,
            directed: true,
            traversalDirection: "reverse",
            confirmation: {
              id: relation.suggestionId,
              relationId: relation.id,
            },
          },
          {
            kind: "concept_membership",
            traversalDirection: "undirected",
          },
        ],
      },
    });

    const symmetricRelation = await seedKnowledgeRelation(
      pool,
      firstPoint,
      secondPoint,
      "SIMILAR",
    );
    const neighborsWithMultipleRelations = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/knowledge_point:${firstPoint.id}/neighbors`,
    });
    const multipleEdges = (
      neighborsWithMultipleRelations.json() as {
        edges: Array<{ directed: boolean; edgeKey: string }>;
      }
    ).edges.filter(({ edgeKey }) => edgeKey.startsWith("knowledge_relation:"));

    expect(multipleEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeKey: `knowledge_relation:${relation.id}`,
          directed: true,
        }),
        expect.objectContaining({
          edgeKey: `knowledge_relation:${symmetricRelation.id}`,
          directed: false,
        }),
      ]),
    );

    await removeKnowledgeRelation(pool, symmetricRelation);
    const afterRemoval = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/knowledge_point:${firstPoint.id}/neighbors`,
    });

    expect(
      (afterRemoval.json() as { edges: Array<{ edgeKey: string }> }).edges,
    ).not.toContainEqual(
      expect.objectContaining({
        edgeKey: `knowledge_relation:${symmetricRelation.id}`,
      }),
    );

    await pool.query(
      `INSERT INTO knowledge_point_corrections
         (knowledge_point_id, title, body)
       VALUES ($1, $2, $3)`,
      [firstPoint.id, `${firstPoint.title}（已更新）`, firstPoint.body],
    );
    const afterContentChange = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/knowledge_point:${firstPoint.id}/neighbors`,
    });

    expect(
      (afterContentChange.json() as { edges: Array<{ edgeKey: string }> }).edges,
    ).not.toContainEqual(
      expect.objectContaining({ edgeKey: `knowledge_relation:${relation.id}` }),
    );

    const noPath = await app.inject({
      method: "GET",
      url:
        `/api/v1/network/path?from=concept:${firstConcept.id}` +
        `&to=concept:${secondConcept.id}&maxDepth=3`,
    });

    expect(noPath.statusCode).toBe(200);
    expect(noPath.json()).toMatchObject({ path: null });

    await pool.query("UPDATE concepts SET archived_at = now() WHERE id = $1", [
      firstConcept.id,
    ]);
    const archivedRoot = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/concept:${firstConcept.id}/neighbors`,
    });

    expect(archivedRoot.statusCode).toBe(404);
    expect(
      await app.inject({
        method: "GET",
        url: "/api/v1/network/subgraph?nodeLimit=301",
      }),
    ).toMatchObject({ statusCode: 422 });
    expect(
      await app.inject({
        method: "GET",
        url:
          `/api/v1/network/path?from=concept:${secondConcept.id}` +
          `&to=knowledge_point:${secondPoint.id}&maxDepth=7`,
      }),
    ).toMatchObject({ statusCode: 422 });
  }, 30_000);

  it("maps a canonicalized symmetric formal edge back to suggestion snapshots by Concept id", async () => {
    const highPoint = await seedCurrentKnowledgePoint(pool, "高位概念");
    const lowPoint = await seedCurrentKnowledgePoint(pool, "低位概念");
    const highConcept = await seedConcept(pool, "高位关系概念", highPoint.id, {
      id: "00000000-0000-4000-8000-000000000200",
    });
    const lowConcept = await seedConcept(pool, "低位关系概念", lowPoint.id, {
      id: "00000000-0000-4000-8000-000000000100",
    });
    const relation = await seedConceptRelation(pool, {
      formalSource: lowConcept,
      formalTarget: highConcept,
      formalType: "SIMILAR",
      suggestionSource: highConcept,
      suggestionTarget: lowConcept,
      suggestionType: "EXTENDS",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/concept:${lowConcept.id}/neighbors`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({
          edgeKey: `concept_relation:${relation.id}`,
          kind: "concept_relation",
          relationType: "similar",
          source: `concept:${lowConcept.id}`,
          target: `concept:${highConcept.id}`,
          directed: false,
          confirmation: expect.objectContaining({
            id: relation.suggestionId,
            relationId: relation.id,
          }),
          sourceRecord: expect.objectContaining({
            kind: "concept_relation_confirmation",
            id: relation.suggestionId,
            relationId: relation.id,
          }),
        }),
      ]),
    });

    const addedPoint = await seedCurrentKnowledgePoint(pool, "新增概念成员");

    await pool.query(
      `INSERT INTO concept_memberships
         (concept_id, knowledge_point_id)
       VALUES ($1, $2)`,
      [highConcept.id, addedPoint.id],
    );
    const afterMembershipChange = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/concept:${lowConcept.id}/neighbors`,
    });

    expect(
      (
        afterMembershipChange.json() as {
          edges: Array<{ edgeKey: string }>;
        }
      ).edges,
    ).not.toContainEqual(
      expect.objectContaining({ edgeKey: `concept_relation:${relation.id}` }),
    );
  }, 30_000);

  it("includes a user-created Concept relation and excludes it after its snapshot changes", async () => {
    const sourcePoint = await seedCurrentKnowledgePoint(pool, "用户建边起点");
    const targetPoint = await seedCurrentKnowledgePoint(pool, "用户建边终点");
    const source = await seedConcept(pool, "用户建边 Concept 甲", sourcePoint.id);
    const target = await seedConcept(pool, "用户建边 Concept 乙", targetPoint.id);
    const relation = await seedUserConceptRelation(pool, source, target);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/concept:${source.id}/neighbors`,
    });

    expect(response.statusCode).toBe(200);
    const edge = (
      response.json() as { edges: Array<{ edgeKey: string }> }
    ).edges.find(({ edgeKey }) => edgeKey === `concept_relation:${relation.id}`);

    expect(edge).toMatchObject({
      edgeKey: `concept_relation:${relation.id}`,
      source: `concept:${source.id}`,
      target: `concept:${target.id}`,
      directed: true,
      confirmation: {
        id: relation.id,
        relationId: relation.id,
      },
      sourceRecord: expect.objectContaining({
        id: relation.id,
        kind: "concept_relation_confirmation",
        origin: "user",
        relationId: relation.id,
      }),
    });

    const addedPoint = await seedCurrentKnowledgePoint(pool, "用户建边新增成员");

    await pool.query(
      `INSERT INTO concept_memberships
         (concept_id, knowledge_point_id)
       VALUES ($1, $2)`,
      [source.id, addedPoint.id],
    );
    const changed = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/concept:${source.id}/neighbors`,
    });

    expect(
      (changed.json() as { edges: Array<{ edgeKey: string }> }).edges,
    ).not.toContainEqual(
      expect.objectContaining({ edgeKey: `concept_relation:${relation.id}` }),
    );
  }, 30_000);

  it("searches both current node types and excludes nodes outside the effective network", async () => {
    const marker = `network-search-${randomUUID().slice(0, 8)}`;
    const conceptPoint = await seedCurrentKnowledgePoint(
      pool,
      `concept-source-${randomUUID().slice(0, 8)}`,
    );
    const concept = await seedConcept(pool, `${marker}-concept`, conceptPoint.id);
    const point = await seedCurrentKnowledgePoint(pool, `${marker}-point`);
    const descriptionPoint = await seedCurrentKnowledgePoint(
      pool,
      `description-source-${randomUUID().slice(0, 8)}`,
    );
    const descriptionConcept = await seedConcept(
      pool,
      `description-concept-${randomUUID().slice(0, 8)}`,
      descriptionPoint.id,
      { description: `${marker} only in concept description` },
    );
    const bodyPoint = await seedCurrentKnowledgePoint(
      pool,
      `body-point-${randomUUID().slice(0, 8)}`,
      { body: `${marker} only in knowledge point body` },
    );
    const archivedConceptPoint = await seedCurrentKnowledgePoint(
      pool,
      `archived-source-${randomUUID().slice(0, 8)}`,
    );
    const archivedConcept = await seedConcept(
      pool,
      `${marker}-archived-concept`,
      archivedConceptPoint.id,
    );
    const oldPoint = await seedCurrentKnowledgePoint(pool, `${marker}-old`);
    const excludedPoint = await seedCurrentKnowledgePoint(
      pool,
      `${marker}-excluded`,
    );
    const archivedRecordPoint = await seedCurrentKnowledgePoint(
      pool,
      `${marker}-archived-record`,
    );

    await pool.query("UPDATE concepts SET archived_at = now() WHERE id = $1", [
      archivedConcept.id,
    ]);
    await pool.query(
      `UPDATE ai_analysis_revisions
          SET status = 'SUPERSEDED'
        WHERE id = (
          SELECT analysis_revision_id FROM knowledge_points WHERE id = $1
        )`,
      [oldPoint.id],
    );
    await pool.query(
      "UPDATE knowledge_points SET usage_status = 'EXCLUDED' WHERE id = $1",
      [excludedPoint.id],
    );
    await pool.query(
      `UPDATE records
          SET archived_at = now()
        WHERE id = (SELECT record_id FROM knowledge_points WHERE id = $1)`,
      [archivedRecordPoint.id],
    );

    const allResponse = await app.inject({
      method: "GET",
      url: `/api/v1/network/nodes/search?q=${encodeURIComponent(marker)}`,
    });

    expect(allResponse.statusCode).toBe(200);
    expect(allResponse.json()).toMatchObject({
      limit: 20,
      truncated: false,
      items: expect.arrayContaining([
        {
          key: `concept:${concept.id}`,
          type: "concept",
          id: concept.id,
          label: `${marker}-concept`,
          description: `${marker}-concept的稳定定义。`,
          source: {
            kind: "concept_revision",
            revisionId: concept.revisionId,
            revisionNumber: 1,
          },
        },
        expect.objectContaining({
          key: `concept:${descriptionConcept.id}`,
          type: "concept",
          source: expect.objectContaining({ kind: "concept_revision" }),
        }),
        {
          key: `knowledge_point:${point.id}`,
          type: "knowledge_point",
          id: point.id,
          label: point.title,
          description: point.body,
          source: {
            kind: "knowledge_point",
            recordId: expect.any(String),
            recordTitle: `${marker}-point`,
            fragmentRevisionId: expect.any(String),
            analysisRevisionId: expect.any(String),
          },
        },
        expect.objectContaining({
          key: `knowledge_point:${bodyPoint.id}`,
          type: "knowledge_point",
          description: `${marker} only in knowledge point body`,
        }),
      ]),
    });
    const allKeys = (
      allResponse.json() as { items: Array<{ key: string }> }
    ).items.map(({ key }) => key);

    expect(allKeys).not.toContain(`concept:${archivedConcept.id}`);
    expect(allKeys).not.toContain(`knowledge_point:${oldPoint.id}`);
    expect(allKeys).not.toContain(`knowledge_point:${excludedPoint.id}`);
    expect(allKeys).not.toContain(`knowledge_point:${archivedRecordPoint.id}`);

    const conceptsOnly = await app.inject({
      method: "GET",
      url:
        `/api/v1/network/nodes/search?q=${encodeURIComponent(marker)}` +
        "&type=concept",
    });
    const pointsOnly = await app.inject({
      method: "GET",
      url:
        `/api/v1/network/nodes/search?q=${encodeURIComponent(marker)}` +
        "&type=knowledge_point",
    });

    expect(
      (conceptsOnly.json() as { items: Array<{ type: string }> }).items.every(
        ({ type }) => type === "concept",
      ),
    ).toBe(true);
    expect(
      (pointsOnly.json() as { items: Array<{ type: string }> }).items.every(
        ({ type }) => type === "knowledge_point",
      ),
    ).toBe(true);
  }, 30_000);

  it("ranks title prefixes before description matches and uses stable keys to truncate ties", async () => {
    const query = `rank-${randomUUID().slice(0, 8)}`;
    const conceptSource = await seedCurrentKnowledgePoint(
      pool,
      `rank-concept-source-${randomUUID().slice(0, 8)}`,
    );
    const tiedConcept = await seedConcept(pool, query, conceptSource.id, {
      description: "same body",
    });
    const tiedPoint = await seedCurrentKnowledgePoint(
      pool,
      `rank-point-source-${randomUUID().slice(0, 8)}`,
      { body: "same body", title: query },
    );
    const descriptionSource = await seedCurrentKnowledgePoint(
      pool,
      `rank-description-source-${randomUUID().slice(0, 8)}`,
    );
    const descriptionOnly = await seedConcept(
      pool,
      `not-a-prefix-${randomUUID().slice(0, 8)}`,
      descriptionSource.id,
      { description: query },
    );

    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/network/nodes/search?q=${encodeURIComponent(query)}` +
        "&type=all&limit=2",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({ key: `concept:${tiedConcept.id}` }),
        expect.objectContaining({ key: `knowledge_point:${tiedPoint.id}` }),
      ],
      limit: 2,
      truncated: true,
    });
  }, 30_000);

  it("rejects invalid network node search parameters with an explicit 422", async () => {
    const invalidUrls = [
      "/api/v1/network/nodes/search",
      "/api/v1/network/nodes/search?q=%20%20",
      `/api/v1/network/nodes/search?q=${"x".repeat(201)}`,
      "/api/v1/network/nodes/search?q=node&type=tag",
      "/api/v1/network/nodes/search?q=node&limit=0",
      "/api/v1/network/nodes/search?q=node&limit=51",
      "/api/v1/network/nodes/search?q=node&limit=1.5",
    ];

    for (const url of invalidUrls) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: {
          code: "NETWORK_QUERY_INVALID",
          message: expect.any(String),
        },
      });
    }
  });

  it("returns explicit 422 budget errors for bounded network reads", async () => {
    const point = await seedCurrentKnowledgePoint(pool, "预算读取");
    const concept = await seedConcept(pool, "预算概念", point.id);
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE concepts IN ACCESS EXCLUSIVE MODE");

      const [subgraph, neighbors, search] = await Promise.all([
        app.inject({ method: "GET", url: "/api/v1/network/subgraph" }),
        app.inject({
          method: "GET",
          url: `/api/v1/network/nodes/concept:${concept.id}/neighbors`,
        }),
        app.inject({
          method: "GET",
          url: "/api/v1/network/nodes/search?q=%E9%A2%84%E7%AE%97",
        }),
      ]);

      for (const response of [subgraph, neighbors, search]) {
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          error: { code: "NETWORK_GRAPH_BUDGET_EXCEEDED" },
        });
      }
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);
});

interface SeededPoint {
  body: string;
  id: string;
  title: string;
}

async function seedCurrentKnowledgePoint(
  pool: Pool,
  label: string,
  options?: { body?: string; title?: string },
): Promise<SeededPoint> {
  const client = await pool.connect();
  const recordId = randomUUID();
  const fragmentRevisionId = randomUUID();
  const analysisRevisionId = randomUUID();
  const tagId = randomUUID();
  const point: SeededPoint = {
    id: randomUUID(),
    title: options?.title ?? `${label}知识点`,
    body: options?.body ?? `${label}的自包含正文。`,
  };

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, $2, $2, 'USER_CREATED', 'USER_APPROVED',
               clock_timestamp())`,
      [tagId, `${label}标签`],
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
       VALUES ($1, $2, 1, $3, 8)`,
      [fragmentRevisionId, recordId, `${label}原文内容`],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'network-test-model', $4, $5, 'ACTIVE')`,
      [analysisRevisionId, recordId, fragmentRevisionId, label, `${label}摘要`],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, $5, $6,
               'AUTO_PUBLISHED', 'INCLUDED')`,
      [
        point.id,
        recordId,
        fragmentRevisionId,
        analysisRevisionId,
        point.title,
        point.body,
      ],
    );
    await client.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [recordId, tagId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return point;
}

async function seedConcept(
  pool: Pool,
  name: string,
  pointId: string,
  options?: { description?: string; id?: string },
) {
  const client = await pool.connect();
  const conceptId = options?.id ?? randomUUID();
  const revisionId = randomUUID();
  const membershipId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, $3)`,
      [conceptId, revisionId, name],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, $3, $3, $4)`,
      [
        revisionId,
        conceptId,
        name,
        options?.description ?? `${name}的稳定定义。`,
      ],
    );
    await client.query(
      `INSERT INTO concept_memberships
         (id, concept_id, knowledge_point_id)
       VALUES ($1, $2, $3)`,
      [membershipId, conceptId, pointId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { id: conceptId, membershipId, pointId, revisionId };
}

async function seedConceptRelation(
  pool: Pool,
  input: {
    formalSource: SeededConcept;
    formalTarget: SeededConcept;
    formalType: "SIMILAR";
    suggestionSource: SeededConcept;
    suggestionTarget: SeededConcept;
    suggestionType: "EXTENDS";
  },
) {
  const client = await pool.connect();
  const suggestionId = randomUUID();
  const relationId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO concept_relation_suggestions
         (id, pair_key, input_fingerprint, source_concept_id,
          target_concept_id, source_concept_revision_id,
          target_concept_revision_id, source_membership_fingerprint,
          target_membership_fingerprint, relation_type, description, reason,
          confidence, model_configuration_version, text_model, status,
          decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10::knowledge_relation_type, '原始有向关系建议。',
               '确认时由用户改成对称关系。', 0.86, 1,
               'network-test-model', 'CONFIRMED', now())`,
      [
        suggestionId,
        [input.suggestionSource.id, input.suggestionTarget.id].sort().join(":"),
        "e".repeat(64),
        input.suggestionSource.id,
        input.suggestionTarget.id,
        input.suggestionSource.revisionId,
        input.suggestionTarget.revisionId,
        conceptMembershipFingerprint([
          {
            id: input.suggestionSource.membershipId,
            knowledgePointId: input.suggestionSource.pointId,
          },
        ]),
        conceptMembershipFingerprint([
          {
            id: input.suggestionTarget.membershipId,
            knowledgePointId: input.suggestionTarget.pointId,
          },
        ]),
        input.suggestionType,
      ],
    );
    await client.query(
      `INSERT INTO concept_relations
         (id, suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, $4, $5::knowledge_relation_type,
               '用户确认的对称关系。')`,
      [
        relationId,
        suggestionId,
        input.formalSource.id,
        input.formalTarget.id,
        input.formalType,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { id: relationId, suggestionId };
}

async function seedUserConceptRelation(
  pool: Pool,
  source: SeededConcept,
  target: SeededConcept,
) {
  const relationId = randomUUID();

  await pool.query(
    `INSERT INTO concept_relations
       (id, confirmation_source, source_concept_id, target_concept_id,
        source_concept_revision_id, target_concept_revision_id,
        source_membership_fingerprint, target_membership_fingerprint,
        relation_type, description)
     VALUES ($1, 'USER', $2, $3, $4, $5, $6, $7,
             'EXTENDS', '用户直接建立的扩展关系。')`,
    [
      relationId,
      source.id,
      target.id,
      source.revisionId,
      target.revisionId,
      conceptMembershipFingerprint([
        { id: source.membershipId, knowledgePointId: source.pointId },
      ]),
      conceptMembershipFingerprint([
        { id: target.membershipId, knowledgePointId: target.pointId },
      ]),
    ],
  );

  return { id: relationId };
}

interface SeededConcept {
  id: string;
  membershipId: string;
  pointId: string;
  revisionId: string;
}

async function seedKnowledgeRelation(
  pool: Pool,
  source: SeededPoint,
  target: SeededPoint,
  type: "APPLIES" | "EXTENDS" | "PREREQUISITE" | "SIMILAR",
) {
  const client = await pool.connect();
  const suggestionId = randomUUID();
  const relationId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO relation_suggestions
         (id, pair_key, input_fingerprint, source_knowledge_point_id,
          target_knowledge_point_id, source_content_fingerprint,
          target_content_fingerprint, relation_type, description, reason,
          confidence, model_configuration_version, text_model, status,
          decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8::knowledge_relation_type, '测试确认关系。',
               '两端知识由测试确认。', 0.9, 1, 'network-test-model',
               'CONFIRMED', now())`,
      [
        suggestionId,
        [source.id, target.id].sort().join(":"),
        createHash("sha256").update(randomUUID()).digest("hex"),
        source.id,
        target.id,
        pointFingerprint(source),
        pointFingerprint(target),
        type,
      ],
    );
    await client.query(
      `INSERT INTO knowledge_relations
         (id, suggestion_id, source_knowledge_point_id,
          target_knowledge_point_id, relation_type, description)
       VALUES ($1, $2, $3, $4, $5::knowledge_relation_type,
               '测试确认关系。')`,
      [relationId, suggestionId, source.id, target.id, type],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { id: relationId, suggestionId };
}

async function removeKnowledgeRelation(
  pool: Pool,
  relation: { id: string; suggestionId: string },
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE relation_suggestions
          SET status = 'REMOVED', updated_at = now()
        WHERE id = $1`,
      [relation.suggestionId],
    );
    await client.query(
      "UPDATE knowledge_relations SET removed_at = now() WHERE id = $1",
      [relation.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function pointFingerprint(point: Pick<SeededPoint, "body" | "title">): string {
  return createHash("sha256")
    .update(`${point.title.trim()}\n${point.body.trim()}`.normalize("NFKC"))
    .digest("hex");
}
