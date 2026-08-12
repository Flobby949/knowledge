import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { ConceptCandidateGenerator } from "../../src/concept-candidate-generator.js";
import type { ConceptRelationGenerator } from "../../src/concept-relation-generator.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface CandidateScan {
  candidate: null | {
    memberIds: string[];
    reviewStatus: "accepted" | "pending" | "rejected";
  };
  id: string;
  inputs: Array<{ id: string; recordId: string; seed: boolean }>;
  origin: "automatic" | "manual";
  outcome: "candidate" | "duplicate" | "no_suggestion" | null;
  status: "failed" | "queued" | "running" | "succeeded";
}

describe("automatic Concept discovery", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let embeddingUnavailable = false;
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => ({
    title: `${sourceText} 概览`,
    summary: `${sourceText} 摘要`,
    knowledgePoints: [
      {
        title: sourceText,
        body: `${sourceText} 的自足知识正文。`,
        candidateTags: ["自动召回"],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  }));
  const generateConceptCandidate = vi.fn<ConceptCandidateGenerator>(
    async ({ points }) => ({
      candidate: {
        name: "自动发现的协作机制",
        description: "系统通过全局知识召回发现多个知识点共享同一协作机制。",
        reason: "新增知识与既有知识在全局语义空间中形成稳定组合。",
        knowledgePointIds: points.map(({ id }) => id),
      },
    }),
  );
  const generateConceptRelation = vi.fn<ConceptRelationGenerator>(async () => ({
    related: false,
  }));
  const embedText = vi.fn<EmbedText>(async () => {
    if (embeddingUnavailable) {
      throw new Error("Embedding temporarily unavailable");
    }

    return [1, 0, 0];
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      generateConceptCandidate,
      generateConceptRelation,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("keeps save-only records out of Concept discovery and recalls globally after automatic adoption", async () => {
    const first = await createSaveOnlyRecord(app, "事件发布支持异步协作");
    const searched = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent("事件发布支持异步协作")}`,
    });

    expect(searched.statusCode).toBe(200);
    expect(
      (searched.json() as { items: Array<{ record: { id: string } }> }).items.map(
        ({ record }) => record.id,
      ),
    ).toContain(first.id);
    expect(generateConceptCandidate).not.toHaveBeenCalled();

    const firstTaskId = await organizeRecord(app, first.id, "automatic");
    await waitForAiTask(app, firstTaskId);
    const firstRecall = await waitForAutomaticScan(app, first.id);

    expect(firstRecall).toMatchObject({
      origin: "automatic",
      status: "succeeded",
      outcome: "no_suggestion",
      candidate: null,
    });
    expect(firstRecall.inputs).toEqual([
      expect.objectContaining({ recordId: first.id, seed: true }),
    ]);
    expect(generateConceptCandidate).not.toHaveBeenCalled();

    const second = await createSaveOnlyRecord(app, "事件订阅形成解耦协作");

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateConceptCandidate).not.toHaveBeenCalled();

    const secondTaskId = await organizeRecord(app, second.id, "automatic");
    await waitForAiTask(app, secondTaskId);
    const discovered = await waitForAutomaticScan(app, second.id, "candidate");

    expect(discovered).toMatchObject({
      origin: "automatic",
      status: "succeeded",
      outcome: "candidate",
      candidate: { reviewStatus: "pending" },
    });
    expect(discovered.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: second.id, seed: true }),
        expect.objectContaining({ recordId: first.id, seed: false }),
      ]),
    );
    expect(generateConceptCandidate).toHaveBeenCalledTimes(1);
  });

  it("waits for manual review to make knowledge effective before discovery", async () => {
    const reviewed = await createSaveOnlyRecord(app, "事件消费完成异步协作闭环");
    const taskId = await organizeRecord(app, reviewed.id, "review");

    await waitForAiTask(app, taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateConceptCandidate).toHaveBeenCalledTimes(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${reviewed.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const pointId = (detail.json() as {
      organizedItems: Array<{
        id: string;
        publicationStatus: string;
      }>;
    }).organizedItems.find(
      ({ publicationStatus }) => publicationStatus === "PENDING_REVIEW",
    )?.id;

    if (!pointId) {
      throw new Error("Expected one pending knowledge point");
    }

    const confirmed = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${reviewed.id}/organized-items/` +
        `${pointId}/review-decision`,
      payload: { decision: "confirm" },
    });

    expect(confirmed.statusCode).toBe(200);
    const discovered = await waitForAutomaticScan(app, reviewed.id, "candidate");

    expect(discovered).toMatchObject({
      origin: "automatic",
      status: "succeeded",
      outcome: "candidate",
      candidate: { reviewStatus: "pending" },
    });
    expect(discovered.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pointId, seed: true }),
        expect.objectContaining({ seed: false }),
      ]),
    );
    expect(generateConceptCandidate).toHaveBeenCalledTimes(2);

    const rejected = await createSaveOnlyRecord(
      app,
      "未被采用的审查知识不会参与概念发现",
    );
    const rejectedTaskId = await organizeRecord(app, rejected.id, "review");

    await waitForAiTask(app, rejectedTaskId);
    const rejectedDetail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${rejected.id}`,
    });
    const rejectedPointId = (rejectedDetail.json() as {
      organizedItems: Array<{ id: string; publicationStatus: string }>;
    }).organizedItems.find(
      ({ publicationStatus }) => publicationStatus === "PENDING_REVIEW",
    )?.id;

    if (!rejectedPointId) {
      throw new Error("Expected one knowledge point to reject");
    }

    expect(
      (
        await app.inject({
          method: "POST",
          url:
            `/api/v1/records/${rejected.id}/organized-items/` +
            `${rejectedPointId}/review-decision`,
          payload: { decision: "reject" },
        })
      ).statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateConceptCandidate).toHaveBeenCalledTimes(2);
    expect(await automaticScansForRecord(app, rejected.id)).toEqual([]);
  });

  it("discovers again only after a replacement organization is adopted", async () => {
    const record = await createSaveOnlyRecord(
      app,
      "事件重放让协作状态可以重新构建",
    );
    const initialTaskId = await organizeRecord(app, record.id, "automatic");

    await waitForAiTask(app, initialTaskId);
    const initialScan = await waitForAutomaticScan(app, record.id, "candidate");
    const generationCallsBeforeReanalysis =
      generateConceptCandidate.mock.calls.length;

    const taskId = await organizeRecord(app, record.id, "automatic");
    await waitForAiTask(app, taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateConceptCandidate).toHaveBeenCalledTimes(
      generationCallsBeforeReanalysis,
    );

    const pending = await app.inject({
      method: "GET",
      url: `/api/v1/records/${record.id}`,
    });
    const candidateId = (pending.json() as {
      organization: { candidate?: { id: string } };
    }).organization.candidate?.id;

    if (!candidateId) {
      throw new Error("Expected a replacement organization candidate");
    }

    const adopted = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${record.id}/organization-candidates/` +
        `${candidateId}/adopt`,
    });

    expect(adopted.statusCode).toBe(200);
    const discovered = await waitForAutomaticScan(
      app,
      record.id,
      "candidate",
      initialScan.id,
    );

    expect(discovered.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: record.id, seed: true }),
        expect.objectContaining({ seed: false }),
      ]),
    );
    expect(generateConceptCandidate).toHaveBeenCalledTimes(
      generationCallsBeforeReanalysis + 1,
    );
  });

  it("resumes durable discovery after failed embeddings are rebuilt", async () => {
    embeddingUnavailable = true;

    try {
      const record = await createSaveOnlyRecord(
        app,
        "临时向量故障恢复后仍应完成自动关联",
      );
      const taskId = await organizeRecord(app, record.id, "automatic");

      await waitForAiTask(app, taskId);
      await waitForFailedEmbedding(app);
      expect(await automaticScansForRecord(app, record.id)).toEqual([]);

      embeddingUnavailable = false;
      const rebuilt = await app.inject({
        method: "POST",
        url: "/api/v1/search-index/rebuild",
      });

      expect(rebuilt.statusCode).toBe(202);
      expect(
        await waitForAutomaticScan(app, record.id, "candidate"),
      ).toMatchObject({ origin: "automatic", status: "succeeded" });
    } finally {
      embeddingUnavailable = false;
    }
  });

  it("uses a newly effective knowledge recall to create a formal Concept relation automatically", async () => {
    const sourcesResponse = await app.inject({
      method: "GET",
      url: "/api/v1/concept-sources",
    });
    const pointIds = sourcesResponse
      .json<{ items: Array<{ id: string }> }>()
      .items.slice(0, 4)
      .map(({ id }) => id);

    expect(pointIds).toHaveLength(4);
    generateConceptRelation.mockRejectedValueOnce(
      new Error("relation service temporarily unavailable"),
    );

    for (const [index, ids] of [pointIds.slice(0, 2), pointIds.slice(2, 4)].entries()) {
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/concepts",
        payload: {
          name: `自动关系触发 Concept ${index + 1}`,
          description: `用于验证新增知识自动召回后建立正式关系的 Concept ${index + 1}。`,
          knowledgePointIds: ids,
        },
      });

      expect(created.statusCode).toBe(201);
    }

    await waitForRelationGenerationCalls(generateConceptRelation, 1);
    const callsAfterConceptCreation = generateConceptRelation.mock.calls.length;
    const saved = await createSaveOnlyRecord(
      app,
      "新增知识先仅保存时不应触发 Concept 自动关系",
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateConceptRelation).toHaveBeenCalledTimes(
      callsAfterConceptCreation,
    );

    generateConceptRelation.mockResolvedValue({
      related: true,
      type: "extends",
      direction: "a_to_b",
      description: "新增知识的全局召回确认两个 Concept 存在扩展关系。",
      reason: "召回范围中的 Concept 定义形成稳定延伸。",
      confidence: 0.89,
    });
    const taskId = await organizeRecord(app, saved.id, "automatic");

    await waitForAiTask(app, taskId);
    const relation = await waitForAutomaticConceptRelation(app);

    expect(relation).toMatchObject({
      confirmationSource: { type: "ai_automatic" },
      description: "新增知识的全局召回确认两个 Concept 存在扩展关系。",
      needsReview: false,
      removed: false,
      type: "extends",
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/concept-relation-suggestions?status=pending",
        })
      ).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });
});

async function createSaveOnlyRecord(app: FastifyInstance, text: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `召回 ${text}` }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { record: { id: string } }).record;
}

async function organizeRecord(
  app: FastifyInstance,
  recordId: string,
  handling: "automatic" | "review",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling },
  });

  expect(response.statusCode).toBe(202);
  return (response.json() as { task: { id: string } }).task.id;
}

async function waitForAiTask(app: FastifyInstance, taskId: string) {
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

async function waitForAutomaticScan(
  app: FastifyInstance,
  recordId: string,
  outcome: CandidateScan["outcome"] = "no_suggestion",
  excludedScanId = "",
): Promise<CandidateScan> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=all",
    });
    const scans = (response.json() as { items: CandidateScan[] }).items;
    const matching = scans.filter(
      (item) =>
        item.origin === "automatic" &&
        item.id !== excludedScanId &&
        item.outcome === outcome &&
        item.inputs.some((input) => input.recordId === recordId && input.seed),
    );
    const scan = matching[0];

    if (scan) {
      return scan;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Automatic Concept discovery did not settle for ${recordId}`);
}

async function automaticScansForRecord(
  app: FastifyInstance,
  recordId: string,
): Promise<CandidateScan[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/concept-candidate-scans?scope=all",
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { items: CandidateScan[] }).items.filter(
    (item) =>
      item.origin === "automatic" &&
      item.inputs.some((input) => input.recordId === recordId && input.seed),
  );
}

async function waitForFailedEmbedding(app: FastifyInstance): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });
    const health = response.json() as {
      semantic: { failedDocuments: number };
    };

    if (health.semantic.failedDocuments > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Expected at least one failed semantic document");
}

async function waitForRelationGenerationCalls(
  generator: ReturnType<typeof vi.fn<ConceptRelationGenerator>>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (generator.mock.calls.length >= count) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Concept relation generation did not reach ${count} calls`);
}

async function waitForAutomaticConceptRelation(app: FastifyInstance) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/concept-relations",
    });
    const relation = response.json<{
      items: Array<{
        confirmationSource: { type: string };
        description: string;
        needsReview: boolean;
        removed: boolean;
        type: string;
      }>;
    }>().items.find(
      ({ confirmationSource }) => confirmationSource.type === "ai_automatic",
    );

    if (relation) {
      return relation;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Automatic Concept relation was not created");
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/model-config/draft",
        payload: {
          text: {
            baseUrl: "http://127.0.0.1:9/automatic-concept-text/v1",
            model: "automatic-concept-text",
            apiKey: "automatic-concept-text-key",
          },
          embedding: {
            baseUrl: "http://127.0.0.1:9/automatic-concept-embedding/v1",
            model: "automatic-concept-embedding",
            apiKey: "automatic-concept-embedding-key",
          },
        },
      })
    ).statusCode,
  ).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/model-config/draft/tests/${kind}`,
        })
      ).statusCode,
    ).toBe(200);
  }

  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/model-config/draft/activate",
      })
    ).statusCode,
  ).toBe(200);
}
