import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { CoverageGenerator } from "../../src/coverage-generator.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type CoverageSource = {
  id: string;
  recordId: string;
  title: string;
};

type CoverageAnalysis = {
  advisory: boolean;
  caveat: string;
  covered: Array<{
    assessment: string;
    kind: "covered";
    sources: CoverageSource[];
    title: string;
  }>;
  frameworkSummary: string;
  id: string;
  inputChanged: boolean;
  possibleGaps: Array<{
    assessment: string;
    kind: "possible_gap";
    recommendation: string;
    title: string;
  }>;
  sources: Array<
    CoverageSource & { current: boolean; changedSinceAnalysis: boolean }
  >;
  topic: string;
};

describe("V2 experimental knowledge coverage analysis", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
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
    if (input.topic === "无效覆盖") {
      return {
        frameworkSummary: "无效结果",
        covered: [
          {
            title: "错误引用",
            assessment: "引用不存在的知识点。",
            knowledgePointIds: ["00000000-0000-4000-8000-000000000000"],
          },
        ],
        possibleGaps: [],
        caveat: "这仍然是建议。",
      };
    }

    return {
      frameworkSummary: "按变更捕获、交付可靠性和消费治理三个方面观察。",
      covered: [
        {
          title: "变更捕获基础",
          assessment: "所选知识已经覆盖日志捕获与增量交付。",
          knowledgePointIds: input.knowledgePoints.map(({ id }) => id),
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
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("stores an advisory snapshot with selected sources and never rewrites those sources", async () => {
    const firstRecord = await createOrganizedRecord(app, "COVER_A 事务日志捕获变化");
    const secondRecord = await createOrganizedRecord(app, "COVER_B 增量事件可靠交付");
    const sources = await listCoverageSources(app, "数据库同步");
    const selected = sources.filter(({ recordId }) =>
      [firstRecord.id, secondRecord.id].includes(recordId),
    );

    expect(selected).toHaveLength(2);

    const before = await sourceSnapshot(pool, [firstRecord.id, secondRecord.id]);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: {
        topic: "数据库增量同步",
        knowledgePointIds: selected.map(({ id }) => id),
      },
    });

    expect(created.statusCode).toBe(201);
    const analysis = (created.json() as { analysis: CoverageAnalysis }).analysis;

    expect(analysis).toMatchObject({
      advisory: true,
      topic: "数据库增量同步",
      inputChanged: false,
      frameworkSummary: "按变更捕获、交付可靠性和消费治理三个方面观察。",
      covered: [
        {
          kind: "covered",
          title: "变更捕获基础",
          sources: expect.arrayContaining(
            selected.map(({ id }) => expect.objectContaining({ id })),
          ),
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

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/coverage-analyses",
    });

    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: CoverageAnalysis[] }).items).toContainEqual(
      expect.objectContaining({ id: analysis.id, advisory: true }),
    );

    await replaceActiveKnowledge(
      app,
      firstRecord,
      "COVER_A_UPDATED 更新后的捕获知识",
    );

    const historical = await app.inject({
      method: "GET",
      url: `/api/v1/coverage-analyses/${analysis.id}`,
    });

    expect(historical.statusCode).toBe(200);
    expect(historical.json()).toMatchObject({
      analysis: {
        id: analysis.id,
        inputChanged: true,
        frameworkSummary: analysis.frameworkSummary,
        caveat: analysis.caveat,
      },
    });
  });

  it("rejects unsupported source references without persisting a partial analysis", async () => {
    const record = await createOrganizedRecord(app, "COVER_INVALID 校验输入");
    const source = (await listCoverageSources(app, "COVER_INVALID")).find(
      ({ recordId }) => recordId === record.id,
    );

    if (!source) {
      throw new Error("Expected coverage source");
    }

    const before = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM coverage_analyses",
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/coverage-analyses",
      payload: {
        topic: "无效覆盖",
        knowledgePointIds: [source.id],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(generateCoverage).toHaveBeenCalledTimes(3);

    const after = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM coverage_analyses",
    );

    expect(after.rows).toEqual(before.rows);
  });
});

async function createOrganizedRecord(app: FastifyInstance, text: string) {
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

async function sourceSnapshot(pool: Pool, recordIds: string[]) {
  const [records, revisions, analyses, points, evidence] = await Promise.all([
    pool.query(
      `SELECT * FROM records WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [recordIds],
    ),
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
