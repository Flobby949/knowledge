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

type GenerateAnalysisInput = {
  sourceText: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
};

type GeneratedAnalysis = {
  title: string;
  summary: string;
  knowledgePoints: Array<{
    title: string;
    body: string;
    candidateTags: string[];
    evidenceSpans: Array<{
      quote: string;
      start: number;
      end: number;
    }>;
  }>;
};

type GenerateAnalysis = (
  input: GenerateAnalysisInput,
) => Promise<GeneratedAnalysis>;

type PublicTask = {
  id: string;
  recordId: string;
  handling: "automatic" | "review";
  status: "queued" | "running" | "succeeded" | "failed";
  sourceTextVersion: number;
  modelConfigurationVersion: number;
  retryOfTaskId: string | null;
  failure?: { code: string; message: string };
};

describe("failed AI task public retry", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const firstFailureMessage = "模拟文本模型暂时不可用";
  const staleFailureMessage = "模拟旧版本文本模型暂时不可用";
  const sourceA = "事件流会主动推送库存变化。";
  const successfulAnalysis: GeneratedAnalysis = {
    title: "库存变化的主动推送",
    summary: sourceA,
    knowledgePoints: [
      {
        title: "事件流主动推送库存变化",
        body: sourceA,
        candidateTags: ["事件流"],
        evidenceSpans: [spanFor(sourceA, sourceA)],
      },
    ],
  };
  const sourceBv1 = "事务日志会严格保持增量事件顺序。";
  const sourceBv2 = "变更流会更新最新库存视图。";
  const staleAnalysis: GeneratedAnalysis = {
    title: "事务日志中的增量顺序",
    summary: sourceBv1,
    knowledgePoints: [
      {
        title: "增量事件保持严格顺序",
        body: sourceBv1,
        candidateTags: ["增量顺序"],
        evidenceSpans: [spanFor(sourceBv1, sourceBv1)],
      },
    ],
  };
  const successfulRetryStarted = deferred<GenerateAnalysisInput>();
  const releaseSuccessfulRetry = deferred<GeneratedAnalysis>();
  const staleRetryStarted = deferred<GenerateAnalysisInput>();
  const releaseStaleRetry = deferred<GeneratedAnalysis>();
  let generationCall = 0;
  const generateAnalysis = vi.fn<GenerateAnalysis>(async (input) => {
    generationCall += 1;

    if (generationCall === 1) {
      throw new Error(firstFailureMessage);
    }

    if (generationCall === 2) {
      successfulRetryStarted.resolve(input);
      return releaseSuccessfulRetry.promise;
    }

    if (generationCall === 3) {
      throw new Error(staleFailureMessage);
    }

    if (generationCall === 4) {
      staleRetryStarted.resolve(input);
      return releaseStaleRetry.promise;
    }

    throw new Error("unexpected model generation call");
  });
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );
  const embedText = vi.fn(
    async (input: { purpose: "document" | "query" }) =>
      input.purpose === "document" ? [1, 0, 0] : [0, 1, 0],
  );

  beforeAll(async () => {
    database = prepareTestDatabase();

    const buildOptions: Parameters<typeof buildApp>[0] & {
      embedText: typeof embedText;
    } = {
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      testModelEndpoint,
    };

    app = await buildApp(buildOptions);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    releaseSuccessfulRetry.resolve(successfulAnalysis);
    releaseStaleRetry.resolve(staleAnalysis);
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("retries one failed source idempotently and keeps an edited source result stale", async () => {
    const firstConfiguration = await activateConfiguration(app, "original");
    const firstRecord = await createRecord(app, sourceA, "库存事件");
    const failedTask = await startOrganization(app, firstRecord.id);
    const observedFailure = await waitForTerminalTask(app, failedTask.id);

    expect(observedFailure).toMatchObject({
      id: failedTask.id,
      recordId: firstRecord.id,
      handling: "automatic",
      status: "failed",
      sourceTextVersion: 1,
      modelConfigurationVersion: firstConfiguration.version,
      failure: {
        code: "MODEL_REQUEST_FAILED",
        message: firstFailureMessage,
      },
    });

    const failedLookup = await getTask(app, failedTask.id);

    expect(failedLookup).toEqual(observedFailure);

    const secondConfiguration = await activateConfiguration(app, "current");

    expect(secondConfiguration.version).toBeGreaterThan(
      firstConfiguration.version,
    );

    const retryResponses = await Promise.all([
      retryTask(app, failedTask.id),
      retryTask(app, failedTask.id),
    ]);
    const retryTasks = retryResponses.map((response) => response.task);
    const retriedTask = retryTasks[0];

    if (!retriedTask) {
      throw new Error("retry must return a task");
    }

    expect(retriedTask.id).not.toBe(failedTask.id);
    expect(new Set(retryTasks.map((task) => task.id))).toEqual(
      new Set([retriedTask.id]),
    );

    for (const task of retryTasks) {
      expect(task).toMatchObject({
        id: retriedTask.id,
        recordId: firstRecord.id,
        handling: "automatic",
        sourceTextVersion: 1,
        modelConfigurationVersion: firstConfiguration.version,
        retryOfTaskId: failedTask.id,
      });
    }

    const retryInput = await successfulRetryStarted.promise;

    expect(retryInput).toMatchObject({
      sourceText: sourceA,
      baseUrl: firstConfiguration.textBaseUrl,
      model: "deepseek-v4-flash",
      configurationVersion: firstConfiguration.version,
    });

    const repeatedRetry = await retryTask(app, failedTask.id);

    expect(repeatedRetry.task.id).toBe(retriedTask.id);
    expect(generateAnalysis).toHaveBeenCalledTimes(2);

    releaseSuccessfulRetry.resolve(successfulAnalysis);

    const succeededTask = await waitForTerminalTask(app, retriedTask.id);

    expect(succeededTask).toMatchObject({
      id: retriedTask.id,
      recordId: firstRecord.id,
      status: "succeeded",
      sourceTextVersion: 1,
      modelConfigurationVersion: firstConfiguration.version,
      retryOfTaskId: failedTask.id,
    });
    expect(succeededTask).not.toHaveProperty("failure");
    expect((await getTask(app, failedTask.id)).status).toBe("failed");

    const publishedDetail = await getRecordDetail(app, firstRecord.id);

    expect(publishedDetail).toMatchObject({
      editable: { text: sourceA, textVersion: 1 },
      presentation: {
        title: successfulAnalysis.title,
        summary: successfulAnalysis.summary,
        source: "ai",
      },
      organizedItems: [
        expect.objectContaining({
          title: successfulAnalysis.knowledgePoints[0]!.title,
          body: successfulAnalysis.knowledgePoints[0]!.body,
          publicationStatus: "AUTO_PUBLISHED",
        }),
      ],
    });

    const staleRecord = await createRecord(app, sourceBv1, "增量事件");
    const secondFailedTask = await startOrganization(app, staleRecord.id);
    const secondFailure = await waitForTerminalTask(app, secondFailedTask.id);

    expect(secondFailure).toMatchObject({
      status: "failed",
      sourceTextVersion: 1,
      modelConfigurationVersion: secondConfiguration.version,
      failure: {
        code: "MODEL_REQUEST_FAILED",
        message: staleFailureMessage,
      },
    });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${staleRecord.id}`,
      payload: {
        text: sourceBv2,
        myTags: [{ id: staleRecord.tagId }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      record: { id: staleRecord.id, textVersion: 2 },
      task: null,
    });

    const staleRetryResponse = await retryTask(app, secondFailedTask.id);
    const staleRetryTask = staleRetryResponse.task;

    expect(staleRetryTask).toMatchObject({
      recordId: staleRecord.id,
      handling: "automatic",
      sourceTextVersion: 1,
      modelConfigurationVersion: secondConfiguration.version,
      retryOfTaskId: secondFailedTask.id,
    });

    const staleInput = await staleRetryStarted.promise;

    expect(staleInput).toMatchObject({
      sourceText: sourceBv1,
      baseUrl: secondConfiguration.textBaseUrl,
      model: "deepseek-v4-flash",
      configurationVersion: secondConfiguration.version,
    });

    releaseStaleRetry.resolve(staleAnalysis);

    const completedStaleRetry = await waitForTerminalTask(
      app,
      staleRetryTask.id,
    );

    expect(completedStaleRetry.status).toBe("succeeded");
    expect(generateAnalysis).toHaveBeenCalledTimes(4);

    const staleDetail = await getRecordDetail(app, staleRecord.id);

    expect(staleDetail).toMatchObject({
      editable: { text: sourceBv2, textVersion: 2 },
      presentation: { source: "original" },
      organizedItems: [],
    });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/records/${staleRecord.id}/history`,
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          type: "organization",
          sourceTextVersion: 1,
          status: "STALE",
          isCurrent: false,
        }),
      ]),
    });

    const staleSearch = await app.inject({
      method: "GET",
      url: `/api/v1/search?${new URLSearchParams({
        q: staleAnalysis.knowledgePoints[0]!.title,
      }).toString()}`,
    });

    expect(staleSearch.statusCode).toBe(200);
    expect(staleSearch.json()).toMatchObject({ items: [] });
  });
});

async function activateConfiguration(
  app: FastifyInstance,
  marker: string,
): Promise<{ version: number; textBaseUrl: string }> {
  const textBaseUrl = `https://text-${marker}.invalid/v1`;
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: textBaseUrl,
        model: "deepseek-v4-flash",
        apiKey: `local-text-${marker}-key`,
      },
      embedding: {
        baseUrl: `https://embedding-${marker}.invalid/v1`,
        model: "BAAI/bge-m3",
        apiKey: `local-embedding-${marker}-key`,
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

  return {
    version: (activated.json() as { active: { version: number } }).active
      .version,
    textBaseUrl,
  };
}

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

  const record = (
    response.json() as {
      record: { id: string; myTags: Array<{ id: string }> };
    }
  ).record;

  return { id: record.id, tagId: record.myTags[0]!.id };
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

async function retryTask(
  app: FastifyInstance,
  failedTaskId: string,
): Promise<{ task: PublicTask }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/ai-tasks/${failedTaskId}/retry`,
  });

  expect(response.statusCode).toBe(202);

  return response.json() as { task: PublicTask };
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

async function getRecordDetail(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json();
}

function spanFor(sourceText: string, quote: string) {
  const start = sourceText.indexOf(quote);

  if (start < 0) {
    throw new Error(`quote is missing from source text: ${quote}`);
  }

  return { quote, start, end: start + quote.length };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}
