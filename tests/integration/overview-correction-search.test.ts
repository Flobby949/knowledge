import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("record overview correction effective view", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const sourceV1 = "数据库变更会持续写入日志并送往下游。";
  const sourceV2 = "数据库变更会持续写入日志，校验顺序后再送往下游。";
  const aiTitleV1 = "初始日志传递结论";
  const aiSummaryV1 = "初始分析认为日志承载数据库变更。";
  const aiTitleV2 = "新版顺序校验结论";
  const correctedTitle = "用户修正后的记录级标题";
  const correctedSummary = "用户补充的记录级整体判断。";
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
    if (sourceText === sourceV1) {
      return generated(
        sourceText,
        aiTitleV1,
        aiSummaryV1,
        "初始日志知识点",
      );
    }

    if (sourceText === sourceV2) {
      return generated(
        sourceText,
        aiTitleV2,
        "新版分析加入了顺序校验。",
        "新版顺序知识点",
      );
    }

    throw new Error(`unexpected source: ${sourceText}`);
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      credentialEncryptionKey: "overview-correction-test-secret",
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("searches the effective overview and protects a corrected active analysis from an automatic edit switch", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceV1,
        myTags: [{ name: "概览修正测试" }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const record = (
      created.json() as {
        record: { id: string; myTags: Array<{ id: string }> };
      }
    ).record;
    const tagId = record.myTags[0]?.id;

    if (!tagId) {
      throw new Error("record must expose its required user tag");
    }

    await organizeAndWait(app, record.id);
    await expectSearch(app, aiTitleV1, [record.id]);
    await expectSearch(app, aiSummaryV1, [record.id]);

    const corrected = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${record.id}/overview-correction`,
      payload: { title: correctedTitle, summary: correctedSummary },
    });

    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      presentation: {
        title: correctedTitle,
        summary: correctedSummary,
        source: "user_correction",
        aiOriginal: { title: aiTitleV1, summary: aiSummaryV1 },
        correction: {
          title: correctedTitle,
          summary: correctedSummary,
          updatedAt: expect.any(String),
        },
      },
    });

    const correctedDetail = await getDetail(app, record.id);

    expect(correctedDetail.presentation).toMatchObject({
      title: correctedTitle,
      summary: correctedSummary,
      source: "user_correction",
      aiOriginal: { title: aiTitleV1, summary: aiSummaryV1 },
      correction: {
        title: correctedTitle,
        summary: correctedSummary,
        updatedAt: expect.any(String),
      },
    });
    expect(correctedDetail.editable.textVersion).toBe(1);
    await expectSearch(app, correctedTitle, [record.id]);
    await expectSearch(app, correctedSummary, [record.id]);
    await expectSearch(app, aiTitleV1, []);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/records/${record.id}/overview-correction`,
    });

    expect(removed.statusCode).toBe(204);

    const restoredAiDetail = await getDetail(app, record.id);

    expect(restoredAiDetail.presentation).toEqual({
      title: aiTitleV1,
      summary: aiSummaryV1,
      source: "ai",
    });
    await expectSearch(app, aiTitleV1, [record.id]);
    await expectSearch(app, correctedTitle, []);

    const correctedAgain = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${record.id}/overview-correction`,
      payload: { title: correctedTitle, summary: correctedSummary },
    });

    expect(correctedAgain.statusCode).toBe(200);

    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${record.id}`,
      payload: {
        text: sourceV2,
        myTags: [{ id: tagId }],
        processing: "save_only",
      },
    });

    expect(edited.statusCode).toBe(200);
    await organizeAndWait(app, record.id);

    const protectedDetail = await getDetail(app, record.id);

    expect(protectedDetail.editable).toMatchObject({
      text: sourceV2,
      textVersion: 2,
    });
    expect(protectedDetail.presentation).toMatchObject({
      title: correctedTitle,
      summary: correctedSummary,
      source: "user_correction",
    });
    expect(protectedDetail.organization.candidate).toMatchObject({
      id: expect.any(String),
      reason: "source_updated",
      sourceTextVersion: 2,
      presentation: { title: aiTitleV2 },
    });
    await expectSearch(app, correctedTitle, [record.id]);
    await expectSearch(app, aiTitleV2, []);

    const candidateId = protectedDetail.organization.candidate?.id;

    if (!candidateId) {
      throw new Error("overview correction must force a whole-version candidate");
    }

    const adopted = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${record.id}/organization-candidates/` +
        `${candidateId}/adopt`,
    });

    expect(adopted.statusCode).toBe(200);

    const adoptedDetail = await getDetail(app, record.id);

    expect(adoptedDetail.presentation).toEqual({
      title: aiTitleV2,
      summary: "新版分析加入了顺序校验。",
      source: "ai",
    });
    expect(adoptedDetail.organization.candidate).toBeUndefined();
    await expectSearch(app, correctedTitle, []);
    await expectSearch(app, aiTitleV2, [record.id]);
    expect(generateAnalysis).toHaveBeenCalledTimes(2);
  });
});

function generated(
  sourceText: string,
  title: string,
  summary: string,
  pointTitle: string,
) {
  return {
    title,
    summary,
    knowledgePoints: [
      {
        title: pointTitle,
        body: `${pointTitle}由完整原文支持。`,
        candidateTags: ["数据库日志"],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  };
}

async function getDetail(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    editable: { text: string; textVersion: number };
    presentation: {
      title: string;
      summary: string;
      source: "ai" | "original" | "user_correction";
      aiOriginal?: { title: string; summary: string };
      correction?: {
        title: string;
        summary: string;
        updatedAt: string;
      };
    };
    organization: {
      candidate?: {
        id: string;
        reason: "reanalysis" | "source_updated";
        sourceTextVersion: number;
        presentation: { title: string; summary: string };
      };
    };
  };
}

async function organizeAndWait(
  app: FastifyInstance,
  recordId: string,
): Promise<void> {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(started.statusCode).toBe(202);

  const taskId = (started.json() as { task: { id: string } }).task.id;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const status = (
      response.json() as {
        task: { status: "queued" | "running" | "succeeded" | "failed" };
      }
    ).task.status;

    if (status === "succeeded") {
      return;
    }

    if (status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not finish`);
}

async function expectSearch(
  app: FastifyInstance,
  query: string,
  expectedRecordIds: string[],
): Promise<void> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?q=${encodeURIComponent(query)}`,
  });

  expect(response.statusCode).toBe(200);
  expect(
    (response.json() as { items: Array<{ record: { id: string } }> }).items.map(
      (item) => item.record.id,
    ),
  ).toEqual(expectedRecordIds);
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://overview-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "fake-overview-text-key",
      },
      embedding: {
        baseUrl: "https://overview-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "fake-overview-embedding-key",
      },
    },
  });

  expect(saved.statusCode).toBe(200);

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
