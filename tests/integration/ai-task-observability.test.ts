import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("global AI task observability", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const failureMessage = "模拟任务服务暂时不可用";

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: vi.fn(async () => [1, 0, 0]),
      generateAnalysis: vi.fn(async () => {
        throw new Error(failureMessage);
      }),
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("lists a failed task with its record and explicit retry eligibility", async () => {
    await activateConfiguration(app);
    const record = await createRecord(
      app,
      "AI 任务可观察入口\n失败后仍保留原文并允许明确重试。",
    );
    const task = await startOrganization(app, record.id);

    await waitForFailedTask(app, task.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/ai-tasks?scope=attention",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          id: task.id,
          recordId: record.id,
          record: {
            id: record.id,
            title: "AI 任务可观察入口",
          },
          handling: "automatic",
          status: "failed",
          sourceTextVersion: 1,
          modelConfigurationVersion: 1,
          retryOfTaskId: null,
          retryTaskId: null,
          canRetry: true,
          failure: {
            code: "MODEL_REQUEST_FAILED",
            message: failureMessage,
          },
        }),
      ],
    });
    expect(response.json().items[0]).toEqual(
      expect.objectContaining({
        createdAt: expect.any(String),
        finishedAt: expect.any(String),
      }),
    );
  });
});

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://task-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "fake-task-text-key",
      },
      embedding: {
        baseUrl: "https://task-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "fake-task-embedding-key",
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

async function createRecord(
  app: FastifyInstance,
  text: string,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: "后台任务" }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);

  return (response.json() as { record: { id: string } }).record;
}

async function startOrganization(
  app: FastifyInstance,
  recordId: string,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(response.statusCode).toBe(202);

  return (response.json() as { task: { id: string } }).task;
}

async function waitForFailedTask(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const task = (response.json() as { task: { status: string } }).task;

    if (task.status === "failed") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not fail in time`);
}
