import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type EmbedTextInput = {
  text: string;
  purpose: "document" | "query";
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
};

type SemanticHealth = {
  status: "building" | "paused" | "ready";
  model: string;
  configurationVersion: number;
  readyDocuments: number;
  failedDocuments: number;
  totalDocuments: number;
};

describe("automatic embedding enqueue", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const firstSource = "数据库事务日志会持续记录每一次增量变化。";
  const editedSource = "编辑后的原文：事务日志会把增量变化持续发送给下游。";
  const secondSource = "第二条记录用于证明新增内容会独立进入向量队列。";
  const aiOverviewTitle = "事务日志与增量传递";
  const aiOverviewSummary = editedSource;
  const aiTitle = "事务日志如何传递变化";
  const aiBody = "事务日志把已提交的增量变化持续发送给下游。";
  const correctedTitle = "事务日志与可靠下游通知";
  const correctedBody = "用户修正：只发送已提交的变化，并由下游幂等处理。";
  const correctedOverviewTitle = "用户修正的事务日志总览";
  const correctedOverviewSummary = "用户修正摘要：下游只接收已提交的增量变化。";
  const documentCalls: string[] = [];
  const embedText = vi.fn(async (input: EmbedTextInput) => {
    if (input.purpose === "document") {
      documentCalls.push(input.text);
    }

    return [1, 0, 0];
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis: vi.fn(async () => ({
        title: aiOverviewTitle,
        summary: aiOverviewSummary,
        knowledgePoints: [
          {
            title: aiTitle,
            body: aiBody,
            candidateTags: ["事务日志"],
            evidenceSpans: [
              {
                quote: "事务日志会把增量变化持续发送给下游",
                start: editedSource.indexOf("事务日志会把"),
                end:
                  editedSource.indexOf("事务日志会把") +
                  "事务日志会把增量变化持续发送给下游".length,
              },
            ],
          },
        ],
      })),
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("queues every newly effective search document without a manual rebuild", async () => {
    const first = await createRecord(app, firstSource, "数据同步");

    expect(documentCalls).toEqual([]);

    const configurationVersion = await activateConfiguration(app);

    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 1,
      failedDocuments: 0,
      totalDocuments: 1,
    });
    expect(documentCalls).toEqual([firstSource]);

    await createRecord(app, secondSource, "后台任务");
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 2,
      failedDocuments: 0,
      totalDocuments: 2,
    });
    expect(documentCalls).toContain(secondSource);

    await updateRecord(app, first.id, editedSource, first.tagId);
    await expectDocumentCall(editedSource);
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 2,
      failedDocuments: 0,
      totalDocuments: 2,
    });

    const taskId = await organizeAutomatically(app, first.id);
    await waitForSucceededTask(app, taskId);
    await expectDocumentCall(`${aiOverviewTitle}\n${aiOverviewSummary}`);
    await expectDocumentCall(`${aiTitle}\n${aiBody}`);
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 4,
      failedDocuments: 0,
      totalDocuments: 4,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${first.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const itemId = (detail.json() as {
      organizedItems: Array<{ id: string }>;
    }).organizedItems[0]?.id;

    if (!itemId) {
      throw new Error("automatic organization must publish one knowledge point");
    }

    const corrected = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${first.id}/organized-items/${itemId}/correction`,
      payload: { title: correctedTitle, body: correctedBody },
    });
    expect(corrected.statusCode).toBe(200);

    await expectDocumentCall(`${correctedTitle}\n${correctedBody}`);
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 4,
      failedDocuments: 0,
      totalDocuments: 4,
    });

    const overviewCorrected = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${first.id}/overview-correction`,
      payload: {
        title: correctedOverviewTitle,
        summary: correctedOverviewSummary,
      },
    });
    expect(overviewCorrected.statusCode).toBe(200);
    await expectDocumentCall(
      `${correctedOverviewTitle}\n${correctedOverviewSummary}`,
    );
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 4,
      failedDocuments: 0,
      totalDocuments: 4,
    });

    const overviewRestored = await app.inject({
      method: "DELETE",
      url: `/api/v1/records/${first.id}/overview-correction`,
    });
    expect(overviewRestored.statusCode).toBe(204);
    await expectCallCount(`${aiOverviewTitle}\n${aiOverviewSummary}`, 2);
    await expectHealth(app, {
      status: "ready",
      model: "BAAI/bge-m3",
      configurationVersion,
      readyDocuments: 4,
      failedDocuments: 0,
      totalDocuments: 4,
    });

    expect(documentCalls.filter((text) => text === firstSource)).toHaveLength(1);
    expect(documentCalls.filter((text) => text === editedSource)).toHaveLength(1);
  });

  async function expectDocumentCall(text: string): Promise<void> {
    await expectCallCount(text, 1);
  }

  async function expectCallCount(text: string, count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (documentCalls.filter((candidate) => candidate === text).length >= count) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`embedding was not queued ${count} time(s) for: ${text}`);
  }
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<{ id: string; tagId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });
  expect(response.statusCode).toBe(201);

  const record = (response.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;

  return { id: record.id, tagId: record.myTags[0]!.id };
}

async function updateRecord(
  app: FastifyInstance,
  recordId: string,
  text: string,
  tagId: string,
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${recordId}`,
    payload: {
      text,
      myTags: [{ id: tagId }],
      processing: "save_only",
    },
  });
  expect(response.statusCode).toBe(200);
}

async function activateConfiguration(app: FastifyInstance): Promise<number> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "local-embedding-key",
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

  return (activated.json() as { active: { version: number } }).active.version;
}

async function organizeAutomatically(
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

async function waitForSucceededTask(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    expect(response.statusCode).toBe(200);

    if (
      (response.json() as { task: { status: string } }).task.status ===
      "succeeded"
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed`);
}

async function expectHealth(
  app: FastifyInstance,
  expected: SemanticHealth,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });
    expect(response.statusCode).toBe(200);
    const semantic = (response.json() as { semantic: SemanticHealth }).semantic;

    if (
      semantic.status === expected.status &&
      semantic.model === expected.model &&
      semantic.configurationVersion === expected.configurationVersion &&
      semantic.readyDocuments === expected.readyDocuments &&
      semantic.failedDocuments === expected.failedDocuments &&
      semantic.totalDocuments === expected.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`semantic health did not reach ${JSON.stringify(expected)}`);
}
