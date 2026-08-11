import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import type { RelationGenerator } from "../../src/relation-generator.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type RelationSuggestion = {
  canDecide: boolean;
  confidence: number;
  description: string;
  id: string;
  needsReview: boolean;
  reason: string;
  relation: null | { id: string; type: string; description: string };
  source: { id: string; recordId: string; evidence: Array<{ id: string }> };
  status: "confirmed" | "pending_review" | "rejected" | "removed";
  target: { id: string; recordId: string; evidence: Array<{ id: string }> };
  type: string;
};

describe("V2 relation suggestions and confirmed knowledge relations", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
    const marker = relationMarker(sourceText);
    const title = marker.startsWith("AB_")
      ? marker.startsWith("AB_A")
        ? `关系点甲 ${marker}`
        : `关系点乙 ${marker}`
      : marker.startsWith("DE_D")
        ? `拒绝关系丁 ${marker}`
        : `拒绝关系戊 ${marker}`;

    return {
      title: `${title} 概览`,
      summary: `由 ${title} 形成的测试摘要。`,
      knowledgePoints: [
        {
          title,
          body: `${title} 的自包含知识正文。`,
          candidateTags: [`关系测试 ${marker}`],
          evidenceSpans: [
            { quote: sourceText, start: 0, end: sourceText.length },
          ],
        },
      ],
    };
  });
  const embedText = vi.fn<EmbedText>(async ({ text }) => {
    if (text.includes("关系点甲") || text.includes("关系点乙")) {
      return [1, 0, 0];
    }

    if (text.includes("拒绝关系丁") || text.includes("拒绝关系戊")) {
      return [0, 1, 0];
    }

    return [0, 0, 1];
  });
  const generateRelation = vi.fn<RelationGenerator>(async (input) => {
    const titles = new Set([input.pointA.title, input.pointB.title]);
    const isFirstPair =
      [...titles].some((title) => title.includes("关系点甲")) &&
      [...titles].some((title) => title.includes("关系点乙"));
    const isRejectedPair =
      [...titles].some((title) => title.includes("拒绝关系丁")) &&
      [...titles].some((title) => title.includes("拒绝关系戊"));

    if (!isFirstPair && !isRejectedPair) {
      return { related: false };
    }

    return {
      related: true,
      type: isFirstPair ? "extends" : "similar",
      direction: "a_to_b",
      description: isFirstPair ? "甲知识延伸到乙知识。" : "两项知识表达相近。",
      reason: "两侧陈述可以在同一工作流中相互解释。",
      confidence: isFirstPair ? 0.88 : 0.79,
      evidenceAIds: [input.pointA.evidence[0]!.id],
      evidenceBIds: [input.pointB.evidence[0]!.id],
    };
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      generateRelation,
      testModelEndpoint,
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("requires review, preserves both endpoints, retains rejection decisions, and marks confirmed relations stale instead of deleting them", async () => {
    const firstRecord = await createOrganizedRecord(app, "AB_A 第一条关系来源");
    const secondRecord = await createOrganizedRecord(app, "AB_B 第二条关系来源");

    await waitForSemanticReady(app);

    const before = await sourceSnapshot(pool, [firstRecord.id, secondRecord.id]);
    const scan = await scanRelations(app);

    expect(scan).toMatchObject({
      embeddingStatus: "ready",
      recalledPairs: 1,
      suggestedRelations: 1,
      pendingSuggestions: 1,
    });

    const pending = await listRelationSuggestions(app, "pending");
    const suggestion = pending.find((item) =>
      sameRecordPair(item, firstRecord.id, secondRecord.id),
    );

    expect(suggestion).toMatchObject({
      type: "extends",
      description: "甲知识延伸到乙知识。",
      reason: "两侧陈述可以在同一工作流中相互解释。",
      confidence: 0.88,
      status: "pending_review",
      canDecide: true,
      needsReview: false,
      relation: null,
    });
    expect(suggestion?.source.evidence).toHaveLength(1);
    expect(suggestion?.target.evidence).toHaveLength(1);
    expect(await listKnowledgeRelations(app)).toEqual([]);

    if (!suggestion) {
      throw new Error("Expected pending relation suggestion");
    }

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/relation-suggestions/${suggestion.id}/confirm`,
      payload: {
        type: "applies",
        description: "甲知识可用于乙知识的落地场景。",
      },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      suggestion: {
        id: suggestion.id,
        status: "confirmed",
        type: "extends",
        relation: {
          id: expect.any(String),
          type: "applies",
          description: "甲知识可用于乙知识的落地场景。",
        },
      },
    });
    expect(await sourceSnapshot(pool, [firstRecord.id, secondRecord.id])).toEqual(
      before,
    );

    const formal = await listKnowledgeRelations(app);

    expect(formal).toHaveLength(1);
    expect(formal[0]).toMatchObject({
      id: suggestion.id,
      status: "confirmed",
      needsReview: false,
      relation: { type: "applies" },
    });

    const callsAfterConfirmation = generateRelation.mock.calls.length;

    await scanRelations(app);
    expect(generateRelation).toHaveBeenCalledTimes(callsAfterConfirmation);

    const rejectedFirst = await createOrganizedRecord(
      app,
      "DE_D 第三条待拒绝关系来源",
    );
    const rejectedSecond = await createOrganizedRecord(
      app,
      "DE_E 第四条待拒绝关系来源",
    );

    await waitForSemanticReady(app);
    await scanRelations(app);

    const rejectedSuggestion = (
      await listRelationSuggestions(app, "pending")
    ).find((item) =>
      sameRecordPair(item, rejectedFirst.id, rejectedSecond.id),
    );

    if (!rejectedSuggestion) {
      throw new Error("Expected relation suggestion to reject");
    }

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/relation-suggestions/${rejectedSuggestion.id}/reject`,
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      suggestion: { status: "rejected" },
    });
    const callsAfterRejection = generateRelation.mock.calls.length;

    await scanRelations(app);
    expect(generateRelation).toHaveBeenCalledTimes(callsAfterRejection);

    await replaceActiveKnowledge(app, firstRecord, "AB_A_UPDATED 更新后的关系来源");

    const staleFormal = await listKnowledgeRelations(app);

    expect(staleFormal).toHaveLength(1);
    expect(staleFormal[0]).toMatchObject({
      id: suggestion.id,
      status: "confirmed",
      needsReview: true,
    });

    const relationId = staleFormal[0]?.relation?.id;

    if (!relationId) {
      throw new Error("Expected active formal relation");
    }

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/knowledge-relations/${relationId}`,
    });

    expect(removed.statusCode).toBe(204);
    expect(await listKnowledgeRelations(app)).toEqual([]);
    expect(await listRelationSuggestions(app, "resolved")).toContainEqual(
      expect.objectContaining({ id: suggestion.id, status: "removed" }),
    );
  });
});

async function createOrganizedRecord(app: FastifyInstance, text: string) {
  const marker = relationMarker(text);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `关系入口 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.statusCode).toBe(201);
  const record = (created.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;
  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${record.id}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  await waitForTask(app, (organized.json() as { task: { id: string } }).task.id);

  return { id: record.id, tagId: record.myTags[0]!.id };
}

async function replaceActiveKnowledge(
  app: FastifyInstance,
  record: { id: string; tagId: string },
  text: string,
) {
  const updated = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${record.id}`,
    payload: {
      text,
      myTags: [{ id: record.tagId }],
      processing: "save_only",
    },
  });

  expect(updated.statusCode).toBe(200);

  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${record.id}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  await waitForTask(app, (organized.json() as { task: { id: string } }).task.id);

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/records/${record.id}`,
  });
  const candidateId = (detail.json() as {
    organization: { candidate?: { id: string } };
  }).organization.candidate?.id;

  if (candidateId) {
    const adopted = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${record.id}/organization-candidates/` +
        `${candidateId}/adopt`,
    });

    expect(adopted.statusCode).toBe(200);
  }
}

async function scanRelations(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/relation-suggestions/scan",
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { scan: Record<string, unknown> }).scan;
}

async function listRelationSuggestions(
  app: FastifyInstance,
  status: "pending" | "resolved",
): Promise<RelationSuggestion[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/relation-suggestions?status=${status}`,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { items: RelationSuggestion[] }).items;
}

async function listKnowledgeRelations(
  app: FastifyInstance,
): Promise<RelationSuggestion[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/knowledge-relations",
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { items: RelationSuggestion[] }).items;
}

async function sourceSnapshot(pool: Pool, recordIds: string[]) {
  const [revisions, analyses, points, evidence] = await Promise.all([
    pool.query(
      `SELECT * FROM fragment_revisions
        WHERE record_id = ANY($1::uuid[])
        ORDER BY record_id, revision_number`,
      [recordIds],
    ),
    pool.query(
      `SELECT id, record_id, fragment_revision_id, text_model, title, summary,
              status, generated_at
         FROM ai_analysis_revisions
        WHERE record_id = ANY($1::uuid[])
        ORDER BY record_id, generated_at, id`,
      [recordIds],
    ),
    pool.query(
      `SELECT * FROM knowledge_points
        WHERE record_id = ANY($1::uuid[])
        ORDER BY record_id, position, id`,
      [recordIds],
    ),
    pool.query(
      `SELECT evidence.*
         FROM evidence_spans AS evidence
         INNER JOIN knowledge_points AS point
           ON point.id = evidence.knowledge_point_id
        WHERE point.record_id = ANY($1::uuid[])
        ORDER BY point.record_id, evidence.position, evidence.id`,
      [recordIds],
    ),
  ]);

  return {
    revisions: revisions.rows,
    analyses: analyses.rows,
    points: points.rows,
    evidence: evidence.rows,
  };
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const draft = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/relation-text/v1",
        model: "relation-text",
        apiKey: "relation-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/relation-embedding/v1",
        model: "relation-embedding",
        apiKey: "relation-embedding-key",
      },
    },
  });

  expect(draft.statusCode).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    const tested = await app.inject({
      method: "POST",
      url: `/api/v1/model-config/draft/tests/${kind}`,
    });

    expect(tested.statusCode).toBe(200);
  }

  const activated = await app.inject({
    method: "POST",
    url: "/api/v1/model-config/draft/activate",
  });

  expect(activated.statusCode).toBe(200);
}

async function waitForTask(app: FastifyInstance, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const status = (response.json() as { task: { status: string } }).task.status;

    if (status === "succeeded") {
      return;
    }

    if (status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`AI task ${taskId} did not finish`);
}

async function waitForSemanticReady(app: FastifyInstance) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });
    const status = (response.json() as { semantic: { status: string } }).semantic
      .status;

    if (status === "ready") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Semantic documents did not become ready");
}

function sameRecordPair(
  suggestion: RelationSuggestion,
  firstRecordId: string,
  secondRecordId: string,
): boolean {
  const recordIds = new Set([
    suggestion.source.recordId,
    suggestion.target.recordId,
  ]);

  return recordIds.has(firstRecordId) && recordIds.has(secondRecordId);
}

function relationMarker(text: string): string {
  return text.split(/\s/u, 1)[0] ?? text;
}
