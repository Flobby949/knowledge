import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

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

type GenerateAnalysis = (input: {
  sourceText: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
}) => Promise<GeneratedAnalysis>;

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("late analysis result protection", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const sourceV1 = "CDC 读取事务日志。\n增量结果严格保持顺序。";
  const sourceV2 = "CDC 使用变更流更新下游。";
  const activeAnalysis: GeneratedAnalysis = {
    title: "CDC 事务日志捕获",
    summary: "CDC 读取事务日志。",
    knowledgePoints: [
      {
        title: "CDC 读取事务日志",
        body: "CDC 读取事务日志。",
        candidateTags: ["CDC", "事务日志"],
        evidenceSpans: [spanFor(sourceV1, "CDC 读取事务日志。")],
      },
    ],
  };
  const lateAnalysis: GeneratedAnalysis = {
    title: "增量顺序整理",
    summary: "增量结果严格保持顺序。",
    knowledgePoints: [
      {
        title: "增量结果保持顺序",
        body: "增量结果严格保持顺序。",
        candidateTags: ["增量处理"],
        evidenceSpans: [spanFor(sourceV1, "增量结果严格保持顺序。")],
      },
      {
        title: "顺序来自事务日志",
        body: "事务日志是本次整理引用的来源。",
        candidateTags: ["事务日志"],
        evidenceSpans: [spanFor(sourceV1, "事务日志")],
      },
    ],
  };
  const secondCallStarted = deferred<Parameters<GenerateAnalysis>[0]>();
  const releaseLateResult = deferred<GeneratedAnalysis>();
  const generateAnalysis = vi
    .fn<GenerateAnalysis>()
    .mockResolvedValueOnce(activeAnalysis)
    .mockImplementationOnce(async (input) => {
      secondCallStarted.resolve(input);
      return releaseLateResult.promise;
    });
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));

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
  });

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  });

  it("keeps the current text and active knowledge when an older task finishes late", async () => {
    await activateLocalModelConfiguration(app);

    const marker = `stale-analysis-${crypto.randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceV1,
        myTags: [{ name: `迟到结果 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: { id: string; myTags: Array<{ id: string }> };
    };
    const recordId = createdBody.record.id;
    const tagId = createdBody.record.myTags[0]!.id;
    const firstTask = await startOrganization(app, recordId, "automatic");

    await waitForSucceededTask(app, firstTask.id);

    const secondTask = await startOrganization(app, recordId, "review");
    const secondInput = await secondCallStarted.promise;

    expect(secondInput.sourceText).toBe(sourceV1);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text: sourceV2,
        myTags: [{ id: tagId }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      record: {
        id: recordId,
        title: sourceV2,
        preview: sourceV2,
        textVersion: 2,
      },
      task: null,
    });

    releaseLateResult.resolve(lateAnalysis);

    const completedLateTask = await waitForSucceededTask(app, secondTask.id);

    expect(completedLateTask).toMatchObject({
      id: secondTask.id,
      status: "succeeded",
    });
    expect(generateAnalysis).toHaveBeenCalledTimes(2);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: recordId,
      editable: {
        text: sourceV2,
        textVersion: 2,
      },
      presentation: {
        title: activeAnalysis.title,
        summary: activeAnalysis.summary,
        source: "ai",
      },
      organization: {
        view: "organized",
        activity: "idle",
        task: null,
      },
      organizedItems: [
        expect.objectContaining({
          title: activeAnalysis.knowledgePoints[0]!.title,
          body: activeAnalysis.knowledgePoints[0]!.body,
        }),
      ],
    });
    expect(detail.json()).not.toEqual(
      expect.objectContaining({
        presentation: expect.objectContaining({ title: lateAnalysis.title }),
      }),
    );

    const activeSearch = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=%E8%AF%BB%E5%8F%96%E4%BA%8B%E5%8A%A1%E6%97%A5%E5%BF%97",
    });
    const staleSearch = await app.inject({
      method: "GET",
      url: "/api/v1/search?q=%E4%B8%A5%E6%A0%BC%E4%BF%9D%E6%8C%81%E9%A1%BA%E5%BA%8F",
    });

    expect(activeSearch.statusCode).toBe(200);
    expect(activeSearch.json()).toMatchObject({
      items: [
        expect.objectContaining({
          record: expect.objectContaining({ id: recordId }),
        }),
      ],
    });
    expect(staleSearch.statusCode).toBe(200);
    expect(staleSearch.json()).toMatchObject({ items: [] });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history`,
    });

    expect(history.statusCode).toBe(200);

    const historyBody = history.json() as {
      items: Array<
        | { type: "original" }
        | {
            id: string;
            type: "organization";
            sourceTextVersion: number;
            status: "STALE";
            createdAt: string;
            isCurrent: boolean;
          }
      >;
    };
    const staleEntry = historyBody.items.find(
      (entry) => entry.type === "organization" && entry.status === "STALE",
    );

    expect(staleEntry).toMatchObject({
      id: expect.stringMatching(uuidPattern),
      type: "organization",
      sourceTextVersion: 1,
      status: "STALE",
      createdAt: expect.any(String),
      isCurrent: false,
    });

    if (!staleEntry || staleEntry.type !== "organization") {
      throw new Error("late analysis must appear in public record history");
    }

    const staleSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history/${staleEntry.id}`,
    });

    expect(staleSnapshot.statusCode).toBe(200);
    expect(staleSnapshot.json()).toMatchObject({
      id: staleEntry.id,
      type: "organization",
      sourceTextVersion: 1,
      status: "STALE",
      createdAt: staleEntry.createdAt,
      snapshot: {
        title: lateAnalysis.title,
        summary: lateAnalysis.summary,
        organizedItems: lateAnalysis.knowledgePoints.map(({ title, body }) => ({
          title,
          body,
        })),
      },
      currentTextVersion: 2,
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
        apiKey: "local-stale-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "local-stale-embedding-key",
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

async function startOrganization(
  app: FastifyInstance,
  recordId: string,
  handling: "automatic" | "review",
): Promise<PublicTask> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling },
  });

  expect(response.statusCode).toBe(202);

  return (response.json() as { task: PublicTask }).task;
}

async function waitForSucceededTask(
  app: FastifyInstance,
  taskId: string,
): Promise<PublicTask> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

    const { task } = response.json() as { task: PublicTask };

    if (task.status === "succeeded") {
      return task;
    }

    if (task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed in time`);
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
