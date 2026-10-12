import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("effective tag record aggregation", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;

  const sharedTagName = "有效标签聚合";
  const automaticSource =
    "自动记录的第一条知识。自动记录的第二条知识。";
  const reviewSource = "待审记录尚未成为有效知识。";
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
    if (sourceText === automaticSource) {
      const firstQuote = "自动记录的第一条知识。";
      const secondQuote = "自动记录的第二条知识。";

      return {
        title: "自动记录",
        summary: automaticSource,
        knowledgePoints: [
          {
            title: "第一条知识",
            body: firstQuote,
            candidateTags: [sharedTagName],
            evidenceSpans: [spanFor(sourceText, firstQuote)],
          },
          {
            title: "第二条知识",
            body: secondQuote,
            candidateTags: [sharedTagName],
            evidenceSpans: [spanFor(sourceText, secondQuote)],
          },
        ],
      };
    }

    return {
      title: "待审记录",
      summary: reviewSource,
      knowledgePoints: [
        {
          title: "尚未成为有效知识",
          body: reviewSource,
          candidateTags: [sharedTagName],
          evidenceSpans: [spanFor(sourceText, reviewSource)],
        },
      ],
    };
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
      testModelEndpoint,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("counts and lists each unarchived record with an effective tag exactly once", async () => {
    await activateLocalConfiguration(app);

    const recordA = await createRecord(app, "用户标签关联记录", sharedTagName);
    const sharedTagId = recordA.myTags[0]?.id;

    if (!sharedTagId) {
      throw new Error("record-level tag must expose its stable id");
    }

    const recordB = await createRecord(app, automaticSource, "自动记录入口");
    const recordC = await createRecord(app, reviewSource, "待审记录入口");

    await organizeAndWait(app, recordB.id, "automatic");
    await organizeAndWait(app, recordC.id, "review");

    const approvedTags = await requestJson<{
      items: Array<{ id: string; recordCount: number }>;
    }>(app, `/api/v1/tags?q=${encodeURIComponent(sharedTagName)}`);
    const tagField = await requestJson<{
      items: Array<{ id: string; recordCount: number }>;
    }>(app, "/api/v1/tag-field");
    const relatedRecords = await requestJson<{
      items: Array<{ id: string }>;
    }>(app, `/api/v1/tags/${sharedTagId}/records`);

    expect(approvedTags.items).toContainEqual({
      id: sharedTagId,
      name: sharedTagName,
      origin: "user_created",
      approvalStatus: "user_approved",
      recordCount: 2,
      directRecordCount: 2,
      parentId: null,
      ancestors: [],
      childCount: 0,
    });
    expect(tagField.items).toContainEqual({
      id: sharedTagId,
      name: sharedTagName,
      approval: "approved",
      recordCount: 2,
      directRecordCount: 2,
      parentId: null,
      ancestors: [],
    });
    expect(relatedRecords.items.map(({ id }) => id).sort()).toEqual(
      [recordA.id, recordB.id].sort(),
    );
    expect(relatedRecords.items).toHaveLength(2);
    expect(
      relatedRecords.items.some(({ id }) => id === recordC.id),
    ).toBe(false);
  });
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<{ id: string; myTags: Array<{ id: string; name: string }> }> {
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

  return (
    response.json() as {
      record: { id: string; myTags: Array<{ id: string; name: string }> };
    }
  ).record;
}

async function organizeAndWait(
  app: FastifyInstance,
  recordId: string,
  handling: "automatic" | "review",
): Promise<void> {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling },
  });

  expect(started.statusCode).toBe(202);

  const taskId = (started.json() as { task: { id: string } }).task.id;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

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

  throw new Error(`AI task ${taskId} did not finish in time`);
}

async function requestJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const response = await app.inject({ method: "GET", url });

  expect(response.statusCode).toBe(200);

  return response.json() as T;
}

async function activateLocalConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://effective-tags-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-text-key",
      },
      embedding: {
        baseUrl: "https://effective-tags-embedding.invalid/v1",
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
}

function spanFor(source: string, quote: string) {
  const start = source.indexOf(quote);

  if (start < 0) {
    throw new Error(`Quote not found in source: ${quote}`);
  }

  return { quote, start, end: start + quote.length };
}
