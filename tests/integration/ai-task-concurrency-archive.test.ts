import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AnalysisGenerator,
  GeneratedAnalysis,
} from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

describe("AI task archive and concurrency boundaries", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const archivedSource = "归档记录的失败整理不能再次启动。";
  const archivedAnalysis = analysisFor(archivedSource);
  const concurrentSource = "并发整理请求必须复用同一个未结束任务。";
  const concurrentAnalysis = analysisFor(concurrentSource);
  const concurrentGenerationStarted = deferred<void>();
  const releaseConcurrentAnalysis = deferred<GeneratedAnalysis>();
  const runningSource = "AI 整理运行期间不能归档记录。";
  const runningAnalysis = analysisFor(runningSource);
  const runningGenerationStarted = deferred<void>();
  const releaseRunningAnalysis = deferred<GeneratedAnalysis>();
  let concurrentTaskId: string | undefined;
  let runningTaskId: string | undefined;
  let archivedSourceCalls = 0;
  const generateAnalysis = vi.fn<AnalysisGenerator>(async (input) => {
    if (input.sourceText === runningSource) {
      runningGenerationStarted.resolve();
      return releaseRunningAnalysis.promise;
    }

    if (input.sourceText === concurrentSource) {
      concurrentGenerationStarted.resolve();
      return releaseConcurrentAnalysis.promise;
    }

    if (input.sourceText === archivedSource) {
      archivedSourceCalls += 1;

      if (archivedSourceCalls === 1) {
        throw new Error("模拟首次整理失败");
      }

      return archivedAnalysis;
    }

    throw new Error(`unexpected source text: ${input.sourceText}`);
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
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
    releaseConcurrentAnalysis.resolve(concurrentAnalysis);
    releaseRunningAnalysis.resolve(runningAnalysis);

    if (concurrentTaskId) {
      await waitForTerminalTask(app, concurrentTaskId);
    }

    if (runningTaskId) {
      await waitForTerminalTask(app, runningTaskId);
    }

    await app?.close();
    database?.dispose();
  }, 30_000);

  it("rejects retry after the failed task's record is archived", async () => {
    const recordId = await createRecord(app, archivedSource, "归档重试边界");
    const failedTask = await startOrganization(app, recordId);

    expect(await waitForTerminalTask(app, failedTask.id)).toMatchObject({
      id: failedTask.id,
      status: "failed",
    });

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      record: { id: recordId, lifecycle: "archived" },
    });

    const callsBeforeRetry = archivedSourceCalls;
    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/ai-tasks/${failedTask.id}/retry`,
    });

    if (retried.statusCode === 202) {
      const wronglyStartedTask = (retried.json() as { task: PublicTask }).task;

      await waitForTerminalTask(app, wronglyStartedTask.id);
    }

    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toEqual({
      error: {
        code: "AI_TASK_RECORD_ARCHIVED",
        message: "归档记录不能重试 AI 整理，请先恢复记录。",
      },
    });
    expect(archivedSourceCalls).toBe(callsBeforeRetry);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      lifecycle: "archived",
      presentation: { source: "original" },
      organizedItems: [],
    });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history`,
    });

    expect(history.statusCode).toBe(200);
    expect(
      (history.json() as { items: Array<{ type: string }> }).items,
    ).toEqual([expect.objectContaining({ type: "original" })]);
  });

  it("reuses one unfinished task for concurrent organization requests", async () => {
    const recordId = await createRecord(app, concurrentSource, "并发整理边界");
    const responses = await Promise.all([
      requestOrganization(app, recordId),
      requestOrganization(app, recordId),
    ]);
    const startedResponse = responses.find(
      (response) => response.statusCode === 202,
    );

    if (startedResponse) {
      concurrentTaskId = (
        startedResponse.json() as { task: PublicTask }
      ).task.id;
    }

    expect(responses.map((response) => response.statusCode)).toEqual([
      202, 202,
    ]);

    const tasks = responses.map(
      (response) => (response.json() as { task: PublicTask }).task,
    );

    expect(new Set(tasks.map((task) => task.id))).toEqual(
      new Set([concurrentTaskId]),
    );

    await concurrentGenerationStarted.promise;
    expect(countGenerationCalls(generateAnalysis, concurrentSource)).toBe(1);

    releaseConcurrentAnalysis.resolve(concurrentAnalysis);
    expect(await waitForTerminalTask(app, concurrentTaskId!)).toMatchObject({
      id: concurrentTaskId,
      status: "succeeded",
    });
    expect(countGenerationCalls(generateAnalysis, concurrentSource)).toBe(1);
  });

  it("keeps a record active until its running organization task finishes", async () => {
    const recordId = await createRecord(app, runningSource, "运行中归档边界");
    const task = await startOrganization(app, recordId);

    runningTaskId = task.id;
    await runningGenerationStarted.promise;
    expect(await getTask(app, task.id)).toMatchObject({
      id: task.id,
      status: "running",
    });

    const blockedArchive = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(blockedArchive.statusCode).toBe(409);
    expect(blockedArchive.json()).toEqual({
      error: {
        code: "AI_TASK_IN_PROGRESS",
        message: "AI 整理进行中，完成后才能归档记录。",
      },
    });

    const activeDetail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(activeDetail.statusCode).toBe(200);
    expect(activeDetail.json()).toMatchObject({
      id: recordId,
      lifecycle: "active",
      organization: {
        activity: "running",
        task: { id: task.id, status: "running" },
      },
    });

    releaseRunningAnalysis.resolve(runningAnalysis);
    expect(await waitForTerminalTask(app, task.id)).toMatchObject({
      id: task.id,
      status: "succeeded",
    });

    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      record: { id: recordId, lifecycle: "archived" },
    });
  });
});

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://text-archive-concurrency.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-archive-concurrency.invalid/v1",
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

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `${tagName} ${crypto.randomUUID()}` }],
      processing: "save_only",
    },
  });

  expect(created.statusCode).toBe(201);

  return (created.json() as { record: { id: string } }).record.id;
}

async function startOrganization(
  app: FastifyInstance,
  recordId: string,
): Promise<PublicTask> {
  const started = await requestOrganization(app, recordId);

  expect(started.statusCode).toBe(202);

  return (started.json() as { task: PublicTask }).task;
}

async function requestOrganization(app: FastifyInstance, recordId: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });
}

async function waitForTerminalTask(
  app: FastifyInstance,
  taskId: string,
): Promise<PublicTask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === "failed" || task.status === "succeeded") {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not reach a terminal state`);
}

async function getTask(
  app: FastifyInstance,
  taskId: string,
): Promise<PublicTask> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/ai-tasks/${taskId}`,
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as { task: PublicTask }).task;
}

function analysisFor(sourceText: string): GeneratedAnalysis {
  return {
    title: "归档重试边界",
    summary: sourceText,
    knowledgePoints: [
      {
        title: "归档后不再整理",
        body: sourceText,
        candidateTags: ["归档"],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  };
}

function countGenerationCalls(
  generateAnalysis: ReturnType<typeof vi.fn<AnalysisGenerator>>,
  sourceText: string,
): number {
  return generateAnalysis.mock.calls.filter(
    ([input]) => input.sourceText === sourceText,
  ).length;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}
