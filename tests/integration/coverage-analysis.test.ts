import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type {
  CoverageGenerator,
  GeneratedCoverageAnalysis,
} from "../../src/coverage-generator.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type CoverageSource = {
  excerpt: string;
  id: string;
  organization: "organized" | "original";
  tags: string[];
  title: string;
};

type CoverageAnalysis = {
  advisory: boolean;
  attemptCount: number;
  canRetry: boolean;
  caveat: string | null;
  covered: Array<{
    assessment: string;
    kind: "covered";
    sources: CoverageAnalysisSource[];
    title: string;
  }>;
  failure: null | { code: string; message: string };
  frameworkSummary: string | null;
  id: string;
  inputChanged: boolean;
  inputKind: "knowledge_points" | "records";
  possibleGaps: Array<{
    assessment: string;
    kind: "possible_gap";
    recommendation: string;
    title: string;
  }>;
  sources: CoverageAnalysisSource[];
  status: "failed" | "queued" | "running" | "succeeded";
  topic: string;
};

type CoverageAnalysisSource = {
  changedSinceAnalysis: boolean;
  current: boolean;
  id: string;
  recordId: string;
  title: string;
};

describe("V2 experimental record coverage analysis", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
  let releaseSlowAnalysis: (() => void) | null = null;
  let retryShouldSucceed = false;
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
  const embedText = vi.fn<EmbedText>(async () => [1, 0, 0]);
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
    const marker = sourceText.split(/\s/u, 1)[0] ?? sourceText;
    const title = `覆盖知识点 ${marker}`;

    return {
      title: `${title} 概览`,
      summary: `${title} 的整体说明。`,
      knowledgePoints: [
        {
          title,
          body: `${title} 的自包含正文。`,
          candidateTags: ["数据库同步"],
          evidenceSpans: [
            { quote: sourceText, start: 0, end: sourceText.length },
          ],
        },
      ],
    };
  });
  const generateCoverage = vi.fn<CoverageGenerator>(async (input) => {
    if (input.topic === "慢速覆盖") {
      await new Promise<void>((resolve) => {
        releaseSlowAnalysis = resolve;
      });
    }

    if (input.topic === "需要重试" && !retryShouldSucceed) {
      return invalidCoverage();
    }

    if (input.topic === "网络失败") {
      throw new Error("upstream unavailable");
    }

    return validCoverage(input.records.map(({ id }) => id));
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      generateCoverage,
      testModelEndpoint,
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    releaseSlowAnalysis?.();
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("lists original records in one source model and exposes a queued task immediately", async () => {
    const original = await createRecord(app, "COVER_RAW 尚未整理的原始记录");
    const organized = await createOrganizedRecord(
      app,
      "COVER_ORGANIZED 已整理的输入记录",
    );
    const sources = await listCoverageSources(app, "COVER_");

    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.id, organization: "original" }),
        expect.objectContaining({ id: organized.id, organization: "organized" }),
      ]),
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: {
        topic: "慢速覆盖",
        recordIds: [original.id, organized.id],
      },
    });

    expect(created.statusCode).toBe(202);
    const task = (created.json() as { analysis: CoverageAnalysis }).analysis;

    expect(task).toMatchObject({
      status: "queued",
      inputKind: "records",
      sources: expect.arrayContaining([
        expect.objectContaining({ id: original.id }),
        expect.objectContaining({ id: organized.id }),
      ]),
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/coverage-analyses",
    });
    const listedTask = (
      listed.json() as { items: CoverageAnalysis[] }
    ).items.find(({ id }) => id === task.id);

    expect(listedTask?.status).toMatch(/queued|running/u);

    releaseSlowAnalysis?.();
    const completed = await waitForCoverage(app, task.id, "succeeded");

    expect(completed.covered[0]?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.id }),
        expect.objectContaining({ id: organized.id }),
      ]),
    );
  });

  it("stores a record-version snapshot without rewriting sources and detects later changes", async () => {
    const firstRecord = await createOrganizedRecord(
      app,
      "COVER_A 事务日志捕获变化",
    );
    const secondRecord = await createRecord(app, "COVER_B 增量事件可靠交付");
    const before = await sourceSnapshot(pool, [firstRecord.id, secondRecord.id]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: {
        topic: "数据库增量同步",
        recordIds: [firstRecord.id, secondRecord.id],
      },
    });

    expect(created.statusCode).toBe(202);
    const task = (created.json() as { analysis: CoverageAnalysis }).analysis;
    const analysis = await waitForCoverage(app, task.id, "succeeded");

    expect(analysis).toMatchObject({
      advisory: true,
      topic: "数据库增量同步",
      inputChanged: false,
      frameworkSummary: "按变更捕获、交付可靠性和消费治理三个方面观察。",
      covered: [
        {
          kind: "covered",
          title: "变更捕获基础",
          sources: expect.arrayContaining([
            expect.objectContaining({ id: firstRecord.id }),
            expect.objectContaining({ id: secondRecord.id }),
          ]),
        },
      ],
      possibleGaps: [
        {
          kind: "possible_gap",
          title: "消费端治理",
          recommendation: "后续可补充一条带真实案例的幂等消费记录。",
        },
      ],
    });
    expect(analysis.caveat).toContain("实验性建议");
    expect(analysis.caveat).toContain("不代表客观完备度");
    expect(await sourceSnapshot(pool, [firstRecord.id, secondRecord.id])).toEqual(
      before,
    );

    await updateRecord(app, firstRecord, "COVER_A_UPDATED 更新后的捕获记录");
    const historical = await getCoverage(app, analysis.id);

    expect(historical).toMatchObject({
      id: analysis.id,
      inputChanged: true,
      frameworkSummary: analysis.frameworkSummary,
      caveat: analysis.caveat,
    });
  });

  it("keeps a failed task and retries from the same frozen inputs", async () => {
    const record = await createRecord(app, "COVER_RETRY 校验输入");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: { topic: "需要重试", recordIds: [record.id] },
    });
    const task = (created.json() as { analysis: CoverageAnalysis }).analysis;
    const failed = await waitForCoverage(app, task.id, "failed");

    expect(failed).toMatchObject({
      id: task.id,
      status: "failed",
      canRetry: true,
      attemptCount: 1,
      failure: {
        code: "COVERAGE_GENERATION_FAILED",
      },
      sources: [expect.objectContaining({ id: record.id })],
    });

    await updateRecord(app, record, "COVER_RETRY_CHANGED 已经修改的当前记录");
    retryShouldSucceed = true;
    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/coverage-analyses/${task.id}/retry`,
    });

    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toMatchObject({
      analysis: {
        id: task.id,
        status: "queued",
        attemptCount: 2,
        sources: [expect.objectContaining({ id: record.id })],
      },
    });

    const completed = await waitForCoverage(app, task.id, "succeeded");

    expect(completed).toMatchObject({
      id: task.id,
      attemptCount: 2,
      inputChanged: true,
      status: "succeeded",
    });
    expect(generateCoverage.mock.calls.at(-1)?.[0].records[0]?.body).toContain(
      "COVER_RETRY 校验输入",
    );
  });

  it("does not retry a rejected model request inside one task attempt", async () => {
    const record = await createRecord(app, "COVER_NETWORK 网络失败输入");
    const beforeCalls = generateCoverage.mock.calls.length;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: { topic: "网络失败", recordIds: [record.id] },
    });
    const task = (created.json() as { analysis: CoverageAnalysis }).analysis;

    await waitForCoverage(app, task.id, "failed");
    expect(generateCoverage.mock.calls.length - beforeCalls).toBe(1);
  });
});

function validCoverage(recordIds: string[]): GeneratedCoverageAnalysis {
  return {
    frameworkSummary: "按变更捕获、交付可靠性和消费治理三个方面观察。",
    covered: [
      {
        title: "变更捕获基础",
        assessment: "所选记录已经覆盖日志捕获与增量交付。",
        recordIds,
      },
    ],
    possibleGaps: [
      {
        title: "消费端治理",
        assessment: "参考框架中还可以继续核验消费幂等和失败恢复。",
        recommendation: "后续可补充一条带真实案例的幂等消费记录。",
      },
    ],
    caveat: "框架由模型临时提出，应结合实际目标判断。",
  };
}

function invalidCoverage(): GeneratedCoverageAnalysis {
  return {
    frameworkSummary: "无效结果",
    covered: [
      {
        title: "错误引用",
        assessment: "引用不存在的记录。",
        recordIds: ["00000000-0000-4000-8000-000000000000"],
      },
    ],
    possibleGaps: [],
    caveat: "这仍然是建议。",
  };
}

async function createRecord(app: FastifyInstance, text: string) {
  const marker = text.split(/\s/u, 1)[0] ?? text;
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `覆盖入口 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.statusCode).toBe(201);
  return (created.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;
}

async function createOrganizedRecord(app: FastifyInstance, text: string) {
  const record = await createRecord(app, text);
  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${record.id}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  await waitForOrganization(
    app,
    (organized.json() as { task: { id: string } }).task.id,
  );
  return record;
}

async function updateRecord(
  app: FastifyInstance,
  record: { id: string; myTags: Array<{ id: string }> },
  text: string,
) {
  const updated = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${record.id}`,
    payload: {
      text,
      myTags: record.myTags.map(({ id }) => ({ id })),
      processing: "save_only",
    },
  });

  expect(updated.statusCode).toBe(200);
}

async function listCoverageSources(
  app: FastifyInstance,
  query: string,
): Promise<CoverageSource[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/coverage-sources?q=${encodeURIComponent(query)}`,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { items: CoverageSource[] }).items;
}

async function getCoverage(
  app: FastifyInstance,
  analysisId: string,
): Promise<CoverageAnalysis> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/coverage-analyses/${analysisId}`,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { analysis: CoverageAnalysis }).analysis;
}

async function waitForCoverage(
  app: FastifyInstance,
  analysisId: string,
  expected: "failed" | "succeeded",
): Promise<CoverageAnalysis> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const analysis = await getCoverage(app, analysisId);

    if (analysis.status === expected) {
      return analysis;
    }

    if (analysis.status === "failed" || analysis.status === "succeeded") {
      throw new Error(`Coverage task settled as ${analysis.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Coverage task ${analysisId} did not finish`);
}

async function sourceSnapshot(pool: Pool, recordIds: string[]) {
  const [records, revisions, analyses, points, evidence] = await Promise.all([
    pool.query("SELECT * FROM records WHERE id = ANY($1::uuid[]) ORDER BY id", [
      recordIds,
    ]),
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
    records: records.rows,
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
        baseUrl: "http://127.0.0.1:9/coverage-text/v1",
        model: "coverage-text",
        apiKey: "coverage-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/coverage-embedding/v1",
        model: "coverage-embedding",
        apiKey: "coverage-embedding-key",
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

async function waitForOrganization(app: FastifyInstance, taskId: string) {
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
