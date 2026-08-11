import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface CandidateScan {
  candidate: null | {
    acceptedConceptId: string | null;
    canConfirm: boolean;
    description: string;
    id: string;
    memberIds: string[];
    name: string;
    reason: string;
    reviewStatus: "accepted" | "pending" | "rejected";
  };
  canRetry: boolean;
  id: string;
  inputs: Array<{
    body: string;
    evidence: Array<{ id: string; quote: string }>;
    id: string;
    recordId: string;
    title: string;
  }>;
  outcome: "candidate" | "duplicate" | "no_suggestion" | null;
  stale: boolean;
  status: "failed" | "queued" | "running" | "succeeded";
}

describe("V3.1 Concept Candidates", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let firstPointId: string;
  let secondPointId: string;
  let thirdPointId: string;
  let generationMode: "candidate" | "fail" | "no_suggestion" = "candidate";
  let generatedName = "事件协作";
  let waitForRelease = true;
  let generationStarted = deferred();
  let generationRelease = deferred();
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => ({
    title: `${sourceText} 概览`,
    summary: `${sourceText} 的测试摘要。`,
    knowledgePoints: [
      {
        title: `${sourceText} 知识点`,
        body: `${sourceText} 的自包含知识正文。`,
        candidateTags: [`候选来源 ${sourceText}`],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  }));
  const generateConceptCandidate = vi.fn(async (input: {
    points: Array<{ id: string }>;
  }) => {
    generationStarted.resolve();

    if (waitForRelease) {
      await generationRelease.promise;
    }

    if (generationMode === "fail") {
      throw new Error("candidate model unavailable");
    }

    if (generationMode === "no_suggestion") {
      return {
        candidate: null,
        reason: "这些知识点尚未形成足够稳定的共同定义。",
      };
    }

    return {
      candidate: {
        name: generatedName,
        description: "事件通过发布、订阅和消费形成解耦协作。",
        reason: "三个知识点共同描述事件从发布到消费的协作边界。",
        knowledgePointIds: input.points.map(({ id }) => id),
      },
    };
  });
  const embedText = vi.fn<EmbedText>(async () => [1, 0, 0]);
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      generateConceptCandidate,
      testModelEndpoint,
    });
    await app.ready();
    await activateConfiguration(app);
    firstPointId = await createCurrentKnowledgePoint(app, "事件发布");
    secondPointId = await createCurrentKnowledgePoint(app, "事件订阅");
    thirdPointId = await createCurrentKnowledgePoint(app, "事件消费");
  }, 30_000);

  afterAll(async () => {
    generationRelease.resolve();
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("keeps an AI suggestion outside the formal network until edited confirmation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/concept-candidate-scans",
      payload: {
        knowledgePointIds: [firstPointId, secondPointId, thirdPointId],
      },
    });

    expect(created.statusCode).toBe(202);
    const queued = (created.json() as { scan: CandidateScan }).scan;

    expect(queued).toMatchObject({ status: "queued", candidate: null });
    await generationStarted.promise;
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/concepts" })
      ).json(),
    ).toEqual({ items: [] });

    generationRelease.resolve();
    const ready = await waitForScan(app, queued.id, "succeeded");

    expect(ready).toMatchObject({
      status: "succeeded",
      outcome: "candidate",
      stale: false,
      candidate: {
        name: "事件协作",
        reviewStatus: "pending",
        memberIds: [firstPointId, secondPointId, thirdPointId],
      },
    });
    expect(ready.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstPointId,
          evidence: [expect.objectContaining({ quote: "事件发布" })],
        }),
      ]),
    );

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/concept-candidates/${ready.candidate!.id}/accept`,
      payload: {
        name: "事件协作机制",
        description: "事件生产者与消费者通过发布订阅边界形成可演进的异步协作。",
        knowledgePointIds: [firstPointId, thirdPointId],
      },
    });

    expect(accepted.statusCode).toBe(201);
    const acceptedBody = accepted.json() as {
      detail: {
        candidate: CandidateScan["candidate"];
        concept: {
          concept: { id: string; name: string };
          memberships: Array<{ point: { id: string } }>;
        };
      };
    };

    expect(acceptedBody.detail.candidate).toMatchObject({
      reviewStatus: "accepted",
      acceptedConceptId: acceptedBody.detail.concept.concept.id,
    });
    expect(acceptedBody.detail.concept.concept.name).toBe("事件协作机制");
    expect(
      acceptedBody.detail.concept.memberships.map(({ point }) => point.id),
    ).toEqual([firstPointId, thirdPointId]);
  });

  it("keeps rejection final, suppresses an equivalent repeat, and permits no suggestion", async () => {
    resetGeneration({ name: "事件边界" });
    const rejectedScan = await createScan(app, [
      firstPointId,
      secondPointId,
      thirdPointId,
    ]);
    const rejectedReady = await waitForScan(app, rejectedScan.id, "succeeded");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/concept-candidates/${rejectedReady.candidate!.id}/reject`,
    });

    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as { scan: CandidateScan }).scan.candidate).toMatchObject({
      reviewStatus: "rejected",
      acceptedConceptId: null,
    });

    resetGeneration({ name: "事件边界" });
    const duplicateScan = await createScan(app, [
      firstPointId,
      secondPointId,
      thirdPointId,
    ]);
    const duplicate = await waitForScan(app, duplicateScan.id, "succeeded");

    expect(duplicate).toMatchObject({
      outcome: "duplicate",
      candidate: null,
      stale: false,
    });

    resetGeneration({ mode: "no_suggestion" });
    const emptyScan = await createScan(app, [firstPointId, secondPointId]);
    const empty = await waitForScan(app, emptyScan.id, "succeeded");

    expect(empty).toMatchObject({
      outcome: "no_suggestion",
      candidate: null,
      stale: false,
    });
  });

  it("marks a late result stale and blocks confirmation after an input changes", async () => {
    resetGeneration({ name: "迟到的事件候选", wait: true });
    const queued = await createScan(app, [
      firstPointId,
      secondPointId,
      thirdPointId,
    ]);

    await generationStarted.promise;
    const firstInput = queued.inputs.find(({ id }) => id === firstPointId);

    if (!firstInput) {
      throw new Error("Expected the first Candidate input");
    }

    const excluded = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${firstInput.recordId}/organized-items/` +
        `${firstPointId}/inclusion`,
      payload: { status: "excluded" },
    });

    expect(excluded.statusCode).toBe(200);
    generationRelease.resolve();
    const stale = await waitForScan(app, queued.id, "succeeded");

    expect(stale).toMatchObject({
      stale: true,
      outcome: "candidate",
      candidate: { reviewStatus: "pending", canConfirm: false },
    });

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/concept-candidates/${stale.candidate!.id}/accept`,
      payload: {
        name: "不应创建的 Concept",
        description: "这个迟到结果不能晋级。",
        knowledgePointIds: [firstPointId, secondPointId],
      },
    });

    expect(accepted.statusCode).toBe(409);
    expect(accepted.json()).toMatchObject({
      error: { code: "CONCEPT_CANDIDATE_STALE" },
    });

    const restored = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${firstInput.recordId}/organized-items/` +
        `${firstPointId}/inclusion`,
      payload: { status: "included" },
    });

    expect(restored.statusCode).toBe(200);
  });

  it("keeps a failed scan observable and retries once from the same snapshot", async () => {
    resetGeneration({ mode: "fail" });
    const queued = await createScan(app, [firstPointId, secondPointId]);
    const failed = await waitForScan(app, queued.id, "failed");

    expect(failed).toMatchObject({
      status: "failed",
      attemptCount: 1,
      canRetry: true,
      candidate: null,
      failure: { code: "CONCEPT_CANDIDATE_GENERATION_FAILED" },
    });

    resetGeneration({ name: "重试后的事件协作" });
    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/concept-candidate-scans/${queued.id}/retry`,
    });

    expect(retried.statusCode).toBe(202);
    expect((retried.json() as { scan: CandidateScan }).scan).toMatchObject({
      status: "queued",
      attemptCount: 2,
      canRetry: false,
    });
    const ready = await waitForScan(app, queued.id, "succeeded");

    expect(ready).toMatchObject({
      status: "succeeded",
      attemptCount: 2,
      canRetry: false,
      candidate: { name: "重试后的事件协作", reviewStatus: "pending" },
    });
  });

  it("rejects scan scopes outside the explicit 2–12 unique point boundary", async () => {
    const generationCalls = generateConceptCandidate.mock.calls.length;
    const invalidScopes = [
      [firstPointId],
      [firstPointId, firstPointId],
      Array.from({ length: 13 }, () => crypto.randomUUID()),
    ];

    for (const knowledgePointIds of invalidScopes) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/concept-candidate-scans",
        payload: { knowledgePointIds },
      });

      expect(response.statusCode).toBe(422);
    }

    expect(generateConceptCandidate).toHaveBeenCalledTimes(generationCalls);
  });

  it("lists only actionable generation and review work in the attention scope", async () => {
    const attention = await app.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=attention",
    });

    expect(attention.statusCode).toBe(200);
    const attentionItems = (attention.json() as { items: CandidateScan[] }).items;

    expect(attentionItems.length).toBeGreaterThanOrEqual(2);
    expect(
      attentionItems.every(
        (scan) =>
          scan.status === "queued" ||
          scan.status === "running" ||
          scan.status === "failed" ||
          scan.candidate?.reviewStatus === "pending",
      ),
    ).toBe(true);
    expect(
      attentionItems.some((scan) => scan.candidate?.reviewStatus === "accepted"),
    ).toBe(false);
    expect(
      attentionItems.some((scan) => scan.candidate?.reviewStatus === "rejected"),
    ).toBe(false);

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=all",
    });

    expect(all.statusCode).toBe(200);
    expect((all.json() as { items: CandidateScan[] }).items.length).toBeGreaterThan(
      attentionItems.length,
    );
  });

  function resetGeneration(options: {
    mode?: typeof generationMode;
    name?: string;
    wait?: boolean;
  }) {
    generationMode = options.mode ?? "candidate";
    generatedName = options.name ?? "事件协作";
    waitForRelease = options.wait ?? false;
    generationStarted = deferred();
    generationRelease = deferred();
  }
});

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

async function createScan(
  app: FastifyInstance,
  knowledgePointIds: string[],
): Promise<CandidateScan> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/concept-candidate-scans",
    payload: { knowledgePointIds },
  });

  expect(response.statusCode).toBe(202);
  return (response.json() as { scan: CandidateScan }).scan;
}

async function createCurrentKnowledgePoint(
  app: FastifyInstance,
  sourceText: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text: sourceText,
      myTags: [{ name: `候选入口 ${sourceText}` }],
      processing: "save_only",
    },
  });

  expect(created.statusCode).toBe(201);
  const recordId = (created.json() as { record: { id: string } }).record.id;
  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  await waitForAiTask(
    app,
    (organized.json() as { task: { id: string } }).task.id,
  );
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });
  const pointId = (detail.json() as {
    organizedItems: Array<{ id: string }>;
  }).organizedItems[0]?.id;

  if (!pointId) {
    throw new Error("Expected one current knowledge point");
  }

  return pointId;
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/model-config/draft",
        payload: {
          text: {
            baseUrl: "http://127.0.0.1:9/candidate-text/v1",
            model: "candidate-text",
            apiKey: "candidate-text-key",
          },
          embedding: {
            baseUrl: "http://127.0.0.1:9/candidate-embedding/v1",
            model: "candidate-embedding",
            apiKey: "candidate-embedding-key",
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

async function waitForScan(
  app: FastifyInstance,
  scanId: string,
  expected: CandidateScan["status"],
): Promise<CandidateScan> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/concept-candidate-scans/${scanId}`,
    });
    const scan = (response.json() as { scan: CandidateScan }).scan;

    if (scan?.status === expected) {
      return scan;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Concept Candidate Scan ${scanId} did not become ${expected}`);
}
