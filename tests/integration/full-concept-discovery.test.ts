import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { ConceptCandidateGenerator } from "../../src/concept-candidate-generator.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

it("requires an active model configuration before full discovery", async () => {
  const database = prepareTestDatabase();
  const app = await buildApp({ databaseUrl: database.databaseUrl });

  try {
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/concept-candidate-discovery/full",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "MODEL_CONFIG_REQUIRED" },
    });
  } finally {
    await app.close();
    database.dispose();
  }
}, 30_000);

describe("full Concept discovery", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
  let measureCandidateConcurrency = false;
  let failCandidateGeneration = false;
  let activeCandidateCalls = 0;
  let peakCandidateCalls = 0;
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => ({
    title: `${sourceText} 概览`,
    summary: `${sourceText} 摘要`,
    knowledgePoints: [
      {
        title: sourceText,
        body: `${sourceText} 的自足知识正文。`,
        candidateTags: ["全量发现"],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  }));
  const generateConceptCandidate = vi.fn<ConceptCandidateGenerator>(
    async ({ points }) => {
      if (failCandidateGeneration) {
        throw new Error("historical candidate configuration unavailable");
      }

      if (measureCandidateConcurrency) {
        activeCandidateCalls += 1;
        peakCandidateCalls = Math.max(peakCandidateCalls, activeCandidateCalls);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeCandidateCalls -= 1;
      }

      return {
        candidate: {
          name: `历史知识共同机制 ${points[0]?.id}`,
          description: "系统从全部当前生效知识中补做 Concept 候选发现。",
          reason: "这些历史知识在全局语义空间中形成稳定组合。",
          knowledgePointIds: points.map(({ id }) => id),
        },
      };
    },
  );
  const embedText = vi.fn<EmbedText>(async () => [1, 0, 0]);

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      generateConceptCandidate,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
    await activateConfiguration(app, "initial");
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("registers every uncovered active analysis once and reports covered analyses", async () => {
    await createSaveOnlyRecord(app, "仅保存原文不属于全量 Concept 发现");
    let excludedRecordId = "";

    for (const text of [
      "历史事件发布支持异步协作",
      "历史事件订阅形成解耦协作",
      "历史事件消费完成协作闭环",
    ]) {
      const recordId = (await createSaveOnlyRecord(app, text)).id;
      const taskId = await organizeRecord(app, recordId);

      await waitForAiTask(app, taskId);
      excludedRecordId ||= recordId;
    }

    await waitForAutomaticScanCount(app, 3);
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${excludedRecordId}`,
    });
    const pointId = (detail.json() as {
      organizedItems: Array<{ id: string }>;
    }).organizedItems[0]?.id;

    if (!pointId) {
      throw new Error("Expected one active knowledge point to exclude");
    }

    expect(
      (
        await app.inject({
          method: "PUT",
          url:
            `/api/v1/records/${excludedRecordId}/organized-items/` +
            `${pointId}/inclusion`,
          payload: { status: "excluded" },
        })
      ).statusCode,
    ).toBe(200);
    await pool.query(
      `TRUNCATE concept_candidate_discovery_queue,
                concept_candidate_scans CASCADE`,
    );
    measureCandidateConcurrency = true;
    peakCandidateCalls = 0;

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/concept-candidate-discovery/full",
    });

    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({
      coveredCount: 0,
      enqueuedCount: 3,
    });

    const repeated = await app.inject({
      method: "POST",
      url: "/api/v1/concept-candidate-discovery/full",
    });

    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).toEqual({
      coveredCount: 3,
      enqueuedCount: 0,
    });
    await waitForAutomaticScanCount(app, 2);
    measureCandidateConcurrency = false;
    expect(peakCandidateCalls).toBe(1);
  });

  it("requeues a failed automatic scan with the current active configuration", async () => {
    failCandidateGeneration = true;
    const record = await createSaveOnlyRecord(
      app,
      "历史失败任务应由当前模型配置恢复",
    );
    const taskId = await organizeRecord(app, record.id);

    await waitForAiTask(app, taskId);
    const failed = await waitForLatestAutomaticScan(app, "failed");
    const latestConfiguration = await activateConfiguration(app, "recovery");

    failCandidateGeneration = false;
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/concept-candidate-discovery/full",
    });

    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({
      coveredCount: 3,
      enqueuedCount: 1,
    });

    const recovered = await waitForAutomaticScan(app, failed.id, "succeeded");

    expect(recovered.model).toEqual({
      configurationVersion: latestConfiguration.version,
      name: latestConfiguration.textModel,
    });
    expect(generateConceptCandidate.mock.calls.at(-1)?.[0]).toMatchObject({
      baseUrl: latestConfiguration.textBaseUrl,
      configurationVersion: latestConfiguration.version,
      model: latestConfiguration.textModel,
    });
  });
});

async function createSaveOnlyRecord(app: FastifyInstance, text: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `全量 ${text}` }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { record: { id: string } }).record;
}

async function organizeRecord(
  app: FastifyInstance,
  recordId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(response.statusCode).toBe(202);
  return (response.json() as { task: { id: string } }).task.id;
}

async function waitForAiTask(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
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

async function waitForAutomaticScanCount(
  app: FastifyInstance,
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=all",
    });
    const scans = (response.json() as {
      items: Array<{ origin: string; status: string }>;
    }).items.filter(({ origin }) => origin === "automatic");

    if (
      scans.length === expectedCount &&
      scans.every(({ status }) => status === "succeeded")
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Expected ${expectedCount} completed automatic scans`);
}

type AutomaticScan = {
  id: string;
  model: { configurationVersion: number; name: string };
  origin: string;
  status: string;
};

async function waitForLatestAutomaticScan(
  app: FastifyInstance,
  expectedStatus: string,
): Promise<AutomaticScan> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=all",
    });
    const scan = (response.json() as { items: AutomaticScan[] }).items.find(
      ({ origin, status }) =>
        origin === "automatic" && status === expectedStatus,
    );

    if (scan) {
      return scan;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Expected a ${expectedStatus} automatic scan`);
}

async function waitForAutomaticScan(
  app: FastifyInstance,
  scanId: string,
  expectedStatus: string,
): Promise<AutomaticScan> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/concept-candidate-scans/${scanId}`,
    });
    const scan = (response.json() as { scan: AutomaticScan }).scan;

    if (scan.status === expectedStatus) {
      return scan;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Expected automatic scan ${scanId} to become ${expectedStatus}`);
}

async function activateConfiguration(app: FastifyInstance, marker: string) {
  const textBaseUrl = `http://127.0.0.1:9/full-concept-${marker}-text/v1`;
  const textModel = `full-concept-${marker}-text`;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/model-config/draft",
        payload: {
          text: {
            baseUrl: textBaseUrl,
            model: textModel,
            apiKey: `full-concept-${marker}-text-key`,
          },
          embedding: {
            baseUrl: `http://127.0.0.1:9/full-concept-${marker}-embedding/v1`,
            model: `full-concept-${marker}-embedding`,
            apiKey: `full-concept-${marker}-embedding-key`,
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

  const activated = await app.inject({
    method: "POST",
    url: "/api/v1/model-config/draft/activate",
  });

  expect(activated.statusCode).toBe(200);
  return {
    version: (activated.json() as { active: { version: number } }).active.version,
    textBaseUrl,
    textModel,
  };
}
