import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConceptRelationGenerator } from "../../src/concept-relation-generator.js";
import { registerConceptRelationRoutes } from "../../src/concept-relation-routes.js";
import { encryptCredential } from "../../src/model-credentials.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface SeededConcept {
  conceptId: string;
  knowledgePointId: string;
  membershipId: string;
  revisionId: string;
}

interface ConceptRelationSuggestion {
  canDecide: boolean;
  description: string;
  id: string;
  needsReview: boolean;
  relation: null | {
    description: string;
    id: string;
    removed: boolean;
    sourceConceptId: string;
    suggestionId: string;
    targetConceptId: string;
    type: string;
  };
  source: {
    changedSinceSuggestion: boolean;
    id: string;
    name: string;
  };
  status: "confirmed" | "pending_review" | "rejected" | "removed";
  target: {
    changedSinceSuggestion: boolean;
    id: string;
    name: string;
  };
  type: string;
}

const CREDENTIAL_SECRET = "concept-relation-test-secret";

describe("V3.2 Concept relation suggestions and formal relations", () => {
  let app: FastifyInstance;
  let configurationVersion = 0;
  let database: PreparedTestDatabase;
  let pool: Pool;
  const generateConceptRelation = vi.fn<ConceptRelationGenerator>();

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = Fastify({ logger: false });
    registerConceptRelationRoutes(app, {
      credentialSecret: CREDENTIAL_SECRET,
      generateConceptRelation,
      pool,
    });
    await app.ready();
  });

  beforeEach(async () => {
    generateConceptRelation.mockReset();
    generateConceptRelation.mockResolvedValue({ related: false });
    configurationVersion = await resetDatabase(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    if (pool) {
      await pool.end();
    }

    database?.dispose();
  });

  it("recalls by Concept centroid, generates serially, and is idempotent", async () => {
    await seedConcept(pool, configurationVersion, {
      embedding: [1, 0, 0, 0],
      name: "召回甲",
    });
    await seedConcept(pool, configurationVersion, {
      embedding: [0.95, 0.05, 0, 0],
      name: "召回乙",
    });
    await seedConcept(pool, configurationVersion, {
      embedding: [0.9, 0.1, 0, 0],
      name: "召回丙",
    });
    await seedConcept(pool, configurationVersion, {
      embedding: [0, 0, 0, 1],
      name: "不相关丁",
    });
    let activeCalls = 0;
    let peakCalls = 0;

    generateConceptRelation.mockImplementation(async () => {
      activeCalls += 1;
      peakCalls = Math.max(peakCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCalls -= 1;

      return {
        related: true,
        type: "extends",
        direction: "a_to_b",
        description: "两个 Concept 形成扩展关系。",
        reason: "名称和定义支持该关系。",
        confidence: 0.88,
      };
    });

    const firstScan = await app.inject({
      method: "POST",
      url: "/api/v1/concept-relation-suggestions/scan",
    });

    expect(firstScan.statusCode).toBe(200);
    expect(firstScan.json()).toMatchObject({
      scan: {
        alreadyReviewedPairs: 0,
        embeddingStatus: "ready",
        failedPairs: 0,
        recalledPairs: 3,
        scannedConcepts: 4,
        suggestedRelations: 3,
      },
    });
    expect(generateConceptRelation).toHaveBeenCalledTimes(3);
    expect(peakCalls).toBe(1);
    expect(
      generateConceptRelation.mock.calls.every(
        ([input]) =>
          !JSON.stringify(input).includes("知识点正文") &&
          typeof input.timeoutMs === "number" &&
          input.timeoutMs <= 900_000,
      ),
    ).toBe(true);

    const secondScan = await app.inject({
      method: "POST",
      url: "/api/v1/concept-relation-suggestions/scan",
    });

    expect(secondScan.statusCode).toBe(200);
    expect(secondScan.json()).toMatchObject({
      scan: {
        alreadyReviewedPairs: 3,
        recalledPairs: 3,
        suggestedRelations: 0,
      },
    });
    expect(generateConceptRelation).toHaveBeenCalledTimes(3);
  });

  it("confirms edited output, rejects suggestions, and retains removed history", async () => {
    const first = await seedConcept(pool, configurationVersion, {
      embedding: [1, 0],
      id: "00000000-0000-4000-8000-000000000011",
      name: "确认甲",
    });
    const second = await seedConcept(pool, configurationVersion, {
      embedding: [1, 0],
      id: "00000000-0000-4000-8000-000000000099",
      name: "确认乙",
    });

    generateConceptRelation.mockResolvedValue({
      related: true,
      type: "extends",
      direction: "b_to_a",
      description: "AI 原始描述。",
      reason: "AI 原始理由。",
      confidence: 0.9,
    });
    await scan(app);
    const [pending] = await suggestions(app, "pending");

    expect(pending).toBeDefined();
    expect(pending?.relation).toBeNull();
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/concept-relation-suggestions/${pending?.id}/confirm`,
      payload: { type: "similar", description: "用户确认后的相似关系。" },
    });

    expect(confirmed.statusCode).toBe(200);
    const confirmedSuggestion = confirmed.json<{
      suggestion: ConceptRelationSuggestion;
    }>().suggestion;

    expect(confirmedSuggestion).toMatchObject({
      description: "AI 原始描述。",
      status: "confirmed",
      relation: {
        description: "用户确认后的相似关系。",
        sourceConceptId: first.conceptId,
        suggestionId: pending?.id,
        targetConceptId: second.conceptId,
        type: "similar",
      },
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/concept-relations/${confirmedSuggestion.relation?.id}`,
    });

    expect(removed.statusCode).toBe(204);
    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/concept-relations?conceptId=${first.conceptId}`,
    });
    const historical = filtered.json<{ items: ConceptRelationSuggestion[] }>();

    expect(filtered.statusCode).toBe(200);
    expect(historical.items).toHaveLength(1);
    expect(historical.items[0]).toMatchObject({
      status: "removed",
      relation: { removed: true },
    });

    await resetDatabase(pool).then((version) => {
      configurationVersion = version;
    });
    await seedConcept(pool, configurationVersion, {
      embedding: [0, 1],
      name: "拒绝甲",
    });
    await seedConcept(pool, configurationVersion, {
      embedding: [0, 1],
      name: "拒绝乙",
    });
    await scan(app);
    const [toReject] = await suggestions(app, "pending");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/concept-relation-suggestions/${toReject?.id}/reject`,
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      suggestion: { status: "rejected", canDecide: false },
    });
  });

  it("marks revision, effective Membership, and archive changes stale", async () => {
    const revisionPair = await seedPair(pool, configurationVersion, {
      embedding: [1, 0, 0],
      prefix: "修订",
    });
    const membershipPair = await seedPair(pool, configurationVersion, {
      embedding: [0, 1, 0],
      prefix: "成员",
    });
    const archivePair = await seedPair(pool, configurationVersion, {
      embedding: [0, 0, 1],
      prefix: "归档",
    });

    generateConceptRelation.mockResolvedValue({
      related: true,
      type: "prerequisite",
      direction: "a_to_b",
      description: "待复验的前置关系。",
      reason: "测试输入支持关系。",
      confidence: 0.8,
    });
    await scan(app);
    const pending = await suggestions(app, "pending");
    const revisionSuggestion = findSuggestion(pending, "修订");
    const membershipSuggestion = findSuggestion(pending, "成员");
    const archiveSuggestion = findSuggestion(pending, "归档");

    await replaceConceptRevision(pool, revisionPair[0], "修订甲新版");
    await pool.query(
      `UPDATE concept_memberships
          SET removed_at = clock_timestamp()
        WHERE id = $1`,
      [membershipPair[0].membershipId],
    );
    await pool.query(
      `UPDATE concepts
          SET archived_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [archivePair[0].conceptId],
    );

    for (const suggestion of [
      revisionSuggestion,
      membershipSuggestion,
      archiveSuggestion,
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/concept-relation-suggestions/${suggestion.id}/confirm`,
        payload: { type: suggestion.type, description: suggestion.description },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CONCEPT_RELATION_SUGGESTION_STALE" },
      });
    }

    const refreshed = await suggestions(app, "pending");

    expect(refreshed).toHaveLength(3);
    expect(
      refreshed.every(
        (suggestion) =>
          suggestion.needsReview &&
          !suggestion.canDecide &&
          (suggestion.source.changedSinceSuggestion ||
            suggestion.target.changedSinceSuggestion),
      ),
    ).toBe(true);
  });

  it("rejects confirmation when an effective Membership changes while confirmation waits", async () => {
    const pair = await seedPair(pool, configurationVersion, {
      embedding: [1, 0],
      prefix: "并发",
    });

    generateConceptRelation.mockResolvedValue({
      related: true,
      type: "extends",
      direction: "a_to_b",
      description: "并发确认建议。",
      reason: "验证确认事务的锁定快照。",
      confidence: 0.9,
    });
    await scan(app);
    const [suggestion] = await suggestions(app, "pending");
    const blocker = await pool.connect();

    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM knowledge_points WHERE id = $1 FOR UPDATE",
        [pair[0].knowledgePointId],
      );
      const confirmation = app.inject({
        method: "POST",
        url: `/api/v1/concept-relation-suggestions/${suggestion?.id}/confirm`,
        payload: {
          type: suggestion?.type,
          description: suggestion?.description,
        },
      });

      await waitForBlockedConfirmation(pool);
      await blocker.query(
        "UPDATE knowledge_points SET usage_status = 'EXCLUDED' WHERE id = $1",
        [pair[0].knowledgePointId],
      );
      await blocker.query("COMMIT");

      const response = await confirmation;

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CONCEPT_RELATION_SUGGESTION_STALE" },
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  }, 30_000);

  it("canonicalizes symmetric endpoints and preserves directed model direction", async () => {
    await seedPair(pool, configurationVersion, {
      embedding: [1, 0],
      ids: [
        "00000000-0000-4000-8000-000000000010",
        "00000000-0000-4000-8000-000000000020",
      ],
      prefix: "对称",
    });
    await seedPair(pool, configurationVersion, {
      embedding: [0, 1],
      ids: [
        "00000000-0000-4000-8000-000000000030",
        "00000000-0000-4000-8000-000000000040",
      ],
      prefix: "有向",
    });
    let expectedDirectedSource = "";
    let expectedDirectedTarget = "";

    generateConceptRelation.mockImplementation(async (input) => {
      const symmetric = input.conceptA.name.startsWith("对称");

      if (!symmetric) {
        expectedDirectedSource = input.conceptB.id;
        expectedDirectedTarget = input.conceptA.id;
      }

      return {
        related: true,
        type: symmetric ? "analogy" : "applies",
        direction: "b_to_a",
        description: symmetric ? "对称思想类比。" : "有向应用关系。",
        reason: "关系方向测试。",
        confidence: 0.85,
      };
    });
    await scan(app);
    const pending = await suggestions(app, "pending");
    const symmetric = pending.find(({ type }) => type === "analogy");
    const directed = pending.find(({ type }) => type === "applies");

    expect(symmetric).toBeDefined();
    expect(symmetric?.source.id.localeCompare(symmetric.target.id)).toBeLessThan(
      0,
    );
    expect(directed).toMatchObject({
      source: { id: expectedDirectedSource },
      target: { id: expectedDirectedTarget },
    });
  });

  it("returns bounded errors for missing configuration and invalid input", async () => {
    await pool.query("DELETE FROM model_configurations");

    const noConfiguration = await app.inject({
      method: "POST",
      url: "/api/v1/concept-relation-suggestions/scan",
    });

    expect(noConfiguration.statusCode).toBe(409);
    expect(noConfiguration.json()).toMatchObject({
      error: { code: "MODEL_CONFIG_REQUIRED" },
    });

    const invalidResponses = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/v1/concept-relation-suggestions?status=unknown",
      }),
      app.inject({
        method: "GET",
        url: "/api/v1/concept-relations?conceptId=not-a-uuid",
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/concept-relation-suggestions/${randomUUID()}/confirm`,
        payload: { type: "unknown", description: "" },
      }),
      app.inject({
        method: "POST",
        url: "/api/v1/concept-relation-suggestions/not-a-uuid/reject",
      }),
      app.inject({
        method: "DELETE",
        url: "/api/v1/concept-relations/not-a-uuid",
      }),
    ]);

    expect(invalidResponses.map(({ statusCode }) => statusCode)).toEqual([
      422, 422, 422, 404, 404,
    ]);
  });
});

async function scan(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/concept-relation-suggestions/scan",
  });

  expect(response.statusCode).toBe(200);
}

async function suggestions(
  app: FastifyInstance,
  status: "pending" | "resolved",
): Promise<ConceptRelationSuggestion[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/concept-relation-suggestions?status=${status}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json<{ items: ConceptRelationSuggestion[] }>().items;
}

function findSuggestion(
  suggestions: ConceptRelationSuggestion[],
  namePrefix: string,
): ConceptRelationSuggestion {
  const suggestion = suggestions.find(
    ({ source, target }) =>
      source.name.startsWith(namePrefix) && target.name.startsWith(namePrefix),
  );

  if (!suggestion) {
    throw new Error(`Missing ${namePrefix} Concept relation suggestion`);
  }

  return suggestion;
}

async function resetDatabase(pool: Pool): Promise<number> {
  await pool.query(
    "TRUNCATE model_configurations, records, tags, concepts RESTART IDENTITY CASCADE",
  );
  const result = await pool.query<{ version: number }>(
    `INSERT INTO model_configurations
       (state, text_base_url, text_model, text_credential_ciphertext,
        embedding_base_url, embedding_model,
        embedding_credential_ciphertext, activated_at)
     VALUES ('ACTIVE', 'https://text.test/v1/', 'concept-relation-test-model',
             $1, 'https://embedding.test/v1/', 'embedding-test-model', $1,
             clock_timestamp())
     RETURNING version`,
    [encryptCredential("test-api-key", CREDENTIAL_SECRET)],
  );

  return result.rows[0]?.version ?? 0;
}

async function seedPair(
  pool: Pool,
  configurationVersion: number,
  options: { embedding: number[]; ids?: [string, string]; prefix: string },
): Promise<[SeededConcept, SeededConcept]> {
  return [
    await seedConcept(pool, configurationVersion, {
      embedding: options.embedding,
      ...(options.ids ? { id: options.ids[0] } : {}),
      name: `${options.prefix}甲`,
    }),
    await seedConcept(pool, configurationVersion, {
      embedding: options.embedding,
      ...(options.ids ? { id: options.ids[1] } : {}),
      name: `${options.prefix}乙`,
    }),
  ];
}

async function seedConcept(
  pool: Pool,
  configurationVersion: number,
  options: { embedding: number[]; id?: string; name: string },
): Promise<SeededConcept> {
  const client = await pool.connect();
  const conceptId = options.id ?? randomUUID();
  const revisionId = randomUUID();
  const membershipId = randomUUID();
  const recordId = randomUUID();
  const fragmentRevisionId = randomUUID();
  const analysisRevisionId = randomUUID();
  const knowledgePointId = randomUUID();
  const tagId = randomUUID();
  const semanticText = `${options.name} 的语义文本`;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, $2, $2, 'USER_CREATED', 'USER_APPROVED',
               clock_timestamp())`,
      [tagId, `标签 ${options.name}`],
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
      [fragmentRevisionId, recordId, `${options.name}知识源`],
    );
    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id, record_id, fragment_revision_id, text_model, title, summary,
          status)
       VALUES ($1, $2, $3, 'seed-model', $4, $5, 'ACTIVE')`,
      [
        analysisRevisionId,
        recordId,
        fragmentRevisionId,
        `${options.name}分析`,
        `${options.name}摘要`,
      ],
    );
    await client.query(
      `INSERT INTO knowledge_points
         (id, record_id, fragment_revision_id, analysis_revision_id,
          position, ai_title, ai_body, publication_status, usage_status)
       VALUES ($1, $2, $3, $4, 1, $5, $6, 'AUTO_PUBLISHED', 'INCLUDED')`,
      [
        knowledgePointId,
        recordId,
        fragmentRevisionId,
        analysisRevisionId,
        `${options.name}知识点`,
        `${options.name}知识点正文`,
      ],
    );
    await client.query(
      "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
      [recordId, tagId],
    );
    await client.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, $3)`,
      [conceptId, revisionId, options.name],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, $3, $3, $4)`,
      [revisionId, conceptId, options.name, `${options.name}的稳定定义。`],
    );
    await client.query(
      `INSERT INTO concept_memberships
         (id, concept_id, knowledge_point_id)
       VALUES ($1, $2, $3)`,
      [membershipId, conceptId, knowledgePointId],
    );
    await client.query(
      `INSERT INTO semantic_document_states
         (configuration_version, source_type, source_id, record_id,
          text_content, status)
       VALUES ($1, 'KNOWLEDGE_POINT', $2, $3, $4, 'READY')`,
      [configurationVersion, knowledgePointId, recordId, semanticText],
    );
    await client.query(
      `INSERT INTO semantic_embeddings
         (configuration_version, embedding_model, source_type, source_id,
          record_id, text_content, embedding)
       VALUES ($1, 'embedding-test-model', 'KNOWLEDGE_POINT', $2, $3, $4,
               $5)`,
      [
        configurationVersion,
        knowledgePointId,
        recordId,
        semanticText,
        options.embedding,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { conceptId, knowledgePointId, membershipId, revisionId };
}

async function replaceConceptRevision(
  pool: Pool,
  concept: SeededConcept,
  name: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const revisionId = randomUUID();

    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 2, $3, $3, $4)`,
      [revisionId, concept.conceptId, name, `${name}的稳定定义。`],
    );
    await client.query(
      `UPDATE concepts
          SET current_revision_id = $2,
              normalized_name = $3,
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [concept.conceptId, revisionId, name],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForBlockedConfirmation(pool: Pool): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%locked_memberships AS MATERIALIZED%'
       ) AS blocked`,
    );

    if (result.rows[0]?.blocked) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Concept relation confirmation did not wait for Membership state");
}
