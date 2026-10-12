import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
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

interface PublicTask {
  id: string;
  recordId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  retryOfTaskId: string | null;
  failure?: { code: string; message: string | null };
}

describe("AI task recovery after a service restart", () => {
  let originalApp: FastifyInstance;
  let restartedApp: FastifyInstance | undefined;
  let database: PreparedTestDatabase;
  let pool: Pool;
  const sourceText = "服务重启后，未完成的 AI 整理应允许重试或归档。";
  const queuedSourceText = "服务在任务排队后终止时，也必须释放归档入口。";
  const interruptedAnalysis = analysisFor(
    sourceText,
    "不应发布的迟到整理",
  );
  const retriedAnalysis = analysisFor(sourceText, "恢复后重试成功");
  const originalGenerationStarted = deferred<void>();
  const releaseOriginalGeneration = deferred<GeneratedAnalysis>();
  const settledOriginalTaskIds = new Set<string>();
  const originalGenerator = vi.fn<AnalysisGenerator>(async (input) => {
    if (input.sourceText === sourceText) {
      originalGenerationStarted.resolve();
      return releaseOriginalGeneration.promise;
    }

    throw new Error(`unexpected source text: ${input.sourceText}`);
  });
  const restartedGenerator = vi.fn<AnalysisGenerator>(async () => retriedAnalysis);

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    originalApp = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async () => [1, 0, 0],
      generateAnalysis: originalGenerator,
      onAiTaskSettled: (taskId) => {
        settledOriginalTaskIds.add(taskId);
      },
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await originalApp.ready();
    await activateConfiguration(originalApp);
  }, 30_000);

  afterAll(async () => {
    releaseOriginalGeneration.resolve(interruptedAnalysis);
    await restartedApp?.close();
    await originalApp?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("turns an interrupted task into a retryable failure and rejects its late result", async () => {
    const recordId = await createRecord(originalApp, sourceText);
    const interruptedTask = await startOrganization(originalApp, recordId);

    await originalGenerationStarted.promise;
    expect(await getTask(originalApp, interruptedTask.id)).toMatchObject({
      id: interruptedTask.id,
      status: "running",
    });

    const blockedArchive = await originalApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(blockedArchive.statusCode).toBe(409);
    expect(blockedArchive.json()).toMatchObject({
      error: { code: "AI_TASK_IN_PROGRESS" },
    });

    restartedApp = await buildApp({
      databaseUrl: database.databaseUrl,
      bootstrapModelDraft: bootstrapConfiguration(),
      embedText: async () => [1, 0, 0],
      generateAnalysis: restartedGenerator,
      testModelEndpoint: async () => ({ status: "passed" }),
    });

    const queuedRecordId = await createRecord(originalApp, queuedSourceText);
    // Persist the state left by a process that exited before dispatching its
    // worker. The HTTP start route also dispatches a live worker, which can
    // finish before the restarted service reaches its recovery hook.
    const queued = await pool.query<{ id: string }>(
      `INSERT INTO ai_tasks
         (record_id, fragment_revision_id, model_config_version, handling,
          analysis_prompt)
       SELECT record.id, record.current_fragment_revision_id,
              configuration.version, 'AUTOMATIC', preference.analysis_prompt
         FROM records AS record
         CROSS JOIN model_configurations AS configuration
         CROSS JOIN instance_preferences AS preference
        WHERE record.id = $1
          AND configuration.state = 'ACTIVE'
          AND preference.singleton = true
       RETURNING id`,
      [queuedRecordId],
    );
    const queuedTask = await getTask(originalApp, queued.rows[0]!.id);

    expect(queuedTask.status).toBe("queued");
    await restartedApp.ready();

    expect(await getTask(restartedApp, interruptedTask.id)).toMatchObject({
      id: interruptedTask.id,
      recordId,
      status: "failed",
      retryOfTaskId: null,
      failure: {
        code: "SYSTEM_INTERRUPTED",
        message: "服务进程终止，AI 整理未完成，请重试。",
      },
    });
    expect(await getTask(restartedApp, queuedTask.id)).toMatchObject({
      id: queuedTask.id,
      recordId: queuedRecordId,
      status: "failed",
      failure: { code: "SYSTEM_INTERRUPTED" },
    });
    expect(originalGenerator).toHaveBeenCalledTimes(1);

    const queuedHistory = await restartedApp.inject({
      method: "GET",
      url: `/api/v1/records/${queuedRecordId}/history`,
    });

    expect(queuedHistory.statusCode).toBe(200);
    expect((queuedHistory.json() as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ type: "original", version: 1 }),
    ]);

    const attention = await restartedApp.inject({
      method: "GET",
      url: "/api/v1/ai-tasks?scope=attention",
    });

    expect(attention.statusCode).toBe(200);
    const attentionItems = (
      attention.json() as {
        items: Array<{
          id: string;
          status: string;
          canRetry: boolean;
          failure: { code: string; message: string | null };
        }>;
      }
    ).items;

    expect(attentionItems).toHaveLength(2);

    for (const taskId of [interruptedTask.id, queuedTask.id]) {
      expect(attentionItems.find((item) => item.id === taskId)).toMatchObject({
        status: "failed",
        canRetry: true,
        failure: {
          code: "SYSTEM_INTERRUPTED",
          message: "服务进程终止，AI 整理未完成，请重试。",
        },
      });
    }

    const queuedArchived = await restartedApp.inject({
      method: "POST",
      url: `/api/v1/records/${queuedRecordId}/archive`,
    });

    expect(queuedArchived.statusCode).toBe(200);

    const archived = await restartedApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      record: { id: recordId, lifecycle: "archived" },
    });

    releaseOriginalGeneration.resolve(interruptedAnalysis);
    await waitForTaskSettlement(settledOriginalTaskIds, interruptedTask.id);

    expect(await getTask(restartedApp, interruptedTask.id)).toMatchObject({
      status: "failed",
      failure: { code: "SYSTEM_INTERRUPTED" },
    });

    const historyAfterLateResult = await restartedApp.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history`,
    });

    expect(historyAfterLateResult.statusCode).toBe(200);
    expect(historyAfterLateResult.json()).toMatchObject({
      items: [expect.objectContaining({ type: "original", version: 1 })],
    });
    expect(
      (historyAfterLateResult.json() as { items: unknown[] }).items,
    ).toHaveLength(1);

    const restored = await restartedApp.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/restore`,
    });

    expect(restored.statusCode).toBe(200);

    const retryResponse = await restartedApp.inject({
      method: "POST",
      url: `/api/v1/ai-tasks/${interruptedTask.id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(202);

    const retryTask = (retryResponse.json() as { task: PublicTask }).task;

    expect(retryTask).toMatchObject({
      recordId,
      retryOfTaskId: interruptedTask.id,
    });
    expect(await waitForTerminalTask(restartedApp, retryTask.id)).toMatchObject({
      status: "succeeded",
      retryOfTaskId: interruptedTask.id,
    });
    expect(restartedGenerator).toHaveBeenCalledTimes(1);

    const detail = await restartedApp.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      lifecycle: "active",
      presentation: {
        title: retriedAnalysis.title,
        source: "ai",
      },
      organization: { activity: "idle" },
    });
  });
});

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://restart-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "fake-restart-text-key",
      },
      embedding: {
        baseUrl: "https://restart-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "fake-restart-embedding-key",
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

function bootstrapConfiguration() {
  return {
    text: {
      baseUrl: "https://restart-text.invalid/v1",
      model: "deepseek-v4-flash",
      apiKey: "fake-restart-text-key",
    },
    embedding: {
      baseUrl: "https://restart-embedding.invalid/v1",
      model: "BAAI/bge-m3",
      apiKey: "fake-restart-embedding-key",
    },
  };
}

async function createRecord(
  app: FastifyInstance,
  text: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `服务恢复 ${crypto.randomUUID()}` }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);

  return (response.json() as { record: { id: string } }).record.id;
}

async function startOrganization(
  app: FastifyInstance,
  recordId: string,
): Promise<PublicTask> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(response.statusCode).toBe(202);

  return (response.json() as { task: PublicTask }).task;
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

async function waitForTerminalTask(
  app: FastifyInstance,
  taskId: string,
): Promise<PublicTask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await getTask(app, taskId);

    if (task.status === "failed" || task.status === "succeeded") {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not reach a terminal state`);
}

async function waitForTaskSettlement(
  settledTaskIds: Set<string>,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (settledTaskIds.has(taskId)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not settle`);
}

function analysisFor(
  sourceText: string,
  title: string,
): GeneratedAnalysis {
  return {
    title,
    summary: sourceText,
    knowledgePoints: [
      {
        title,
        body: sourceText,
        candidateTags: ["服务恢复"],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}
