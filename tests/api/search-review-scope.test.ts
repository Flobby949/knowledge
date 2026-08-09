import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("search review scope public HTTP flow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for API tests");
    }

    app = await buildApp({
      credentialEncryptionKey: "search-review-scope-test-key",
      databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis: async ({ sourceText }) => {
        const code = /检索代号 ([0-9a-f]{8})/u.exec(sourceText)?.[1];

        if (!code) {
          throw new Error("search review fixture marker is missing");
        }

        return {
          title: `检索代号 ${code} 的整理`,
          summary: "数据库操作具有原子性，应整体提交或整体撤销。",
          knowledgePoints: [
            {
              title: `检索代号 ${code} 原子提交`,
              body: sourceText,
              candidateTags: ["数据库事务"],
              evidenceSpans: [
                { quote: sourceText, start: 0, end: sourceText.length },
              ],
            },
          ],
        };
      },
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
    await activateFakeConfiguration(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("keeps pending knowledge hidden by default and returns it once in the explicit review scope", async () => {
    const code = crypto.randomUUID().slice(0, 8);
    const sourceText =
      `检索代号 ${code} 描述数据库操作的原子性，` +
      "全部操作一起提交或一起撤销。";
    const query = `检索代号 ${code} 原子提交`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: `审查范围 ${code}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;
    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "review" },
    });

    expect(organized.statusCode).toBe(202);

    const taskId = (organized.json() as { task: { id: string } }).task.id;

    await expectTaskSucceeded(app, taskId);

    const currentResponse = await app.inject({
      method: "GET",
      url: searchUrl(query),
    });

    expect(currentResponse.statusCode).toBe(200);
    expect(searchItems(currentResponse.json())).not.toContainEqual(
      expect.objectContaining({ record: expect.objectContaining({ id: recordId }) }),
    );

    const reviewResponse = await app.inject({
      method: "GET",
      url: searchUrl(query, "include_review"),
    });

    expect(reviewResponse.statusCode).toBe(200);

    const matching = searchItems(reviewResponse.json()).filter(
      (item) => item.record.id === recordId,
    );

    expect(matching).toEqual([
      expect.objectContaining({
        match: expect.objectContaining({
          reason: "knowledge_point",
          visibility: "pending_review",
        }),
        record: expect.objectContaining({ id: recordId }),
      }),
    ]);
  });
});

async function activateFakeConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/search-review-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "search-review-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/search-review-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "search-review-fake-embedding-key",
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

async function expectTaskSucceeded(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (body.task.status === "succeeded") {
      return;
    }

    if (body.task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

function searchItems(value: unknown) {
  return (value as {
    items: Array<{
      match: { reason: string; visibility?: string };
      record: { id: string };
    }>;
  }).items;
}

function searchUrl(query: string, scope?: "include_review"): string {
  const search = new URLSearchParams({ q: query });

  if (scope) {
    search.set("scope", scope);
  }

  return `/api/v1/search?${search.toString()}`;
}
