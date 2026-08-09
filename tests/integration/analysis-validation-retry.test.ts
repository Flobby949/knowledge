import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type EndpointTestInput = {
  kind: "text" | "embedding";
  baseUrl: string;
  model: string;
  apiKey: string;
};

describe("analysis validation retry integration", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );
  const generateAnalysis = vi.fn();

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      testModelEndpoint,
      generateAnalysis,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  });

  it("fails the whole analysis after exactly one retry and publishes no valid subset", async () => {
    const sourceText = "Redis 使用事件通知。";
    const quote = "Redis 使用事件通知";
    const validPoint = {
      title: "Redis 的事件通知",
      body: sourceText,
      candidateTags: ["Redis", "事件通知"],
      evidenceSpans: [{ start: 0, end: 12, quote }],
    };

    generateAnalysis
      .mockResolvedValueOnce({
        title: "Redis 事件通知",
        summary: sourceText,
        knowledgePoints: [
          validPoint,
          {
            ...validPoint,
            evidenceSpans: [{ start: 1, end: 12, quote }],
          },
        ],
      })
      .mockResolvedValueOnce({
        title: "Redis 事件通知",
        summary: sourceText,
        knowledgePoints: [
          validPoint,
          {
            ...validPoint,
            evidenceSpans: [{ start: 0, end: 11, quote }],
          },
        ],
      });

    await activateLocalModelConfiguration(app);

    const marker = `analysis-retry-${crypto.randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: `分析标签 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: { id: string };
    };
    const recordId = createdBody.record.id;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(started.statusCode).toBe(202);

    const startedBody = started.json() as {
      task: { id: string };
    };
    const task = await waitForTerminalTask(app, startedBody.task.id);

    expect(generateAnalysis).toHaveBeenCalledTimes(2);
    expect(task).toMatchObject({
      id: startedBody.task.id,
      status: "failed",
      failure: {
        code: "ANALYSIS_VALIDATION_FAILED",
        message: expect.any(String),
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: recordId,
      presentation: {
        source: "original",
      },
      editable: {
        text: sourceText,
        textVersion: 1,
      },
      organizedItems: [],
    });
  });
});

async function activateLocalModelConfiguration(
  app: FastifyInstance,
): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-analysis-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "local-analysis-embedding-key",
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

async function waitForTerminalTask(app: FastifyInstance, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      task: {
        id: string;
        status: "queued" | "running" | "succeeded" | "failed";
        failure?: {
          code: string;
          message: string;
        };
      };
    };

    if (body.task.status === "failed" || body.task.status === "succeeded") {
      return body.task;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`AI task ${taskId} did not reach a terminal state`);
}
