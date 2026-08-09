import { createServer, type Server } from "node:http";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

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
  handling: "review";
  status: "queued" | "running" | "succeeded" | "failed";
};

type PendingItem = {
  id: string;
  title: string;
  body: string;
  publicationStatus: "PENDING_REVIEW";
  usageStatus: "INCLUDED";
};

describe("review-first AI organization public flow", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let modelTester: Server;
  let testerBaseUrl: string;
  const endpointPaths: string[] = [];
  const sourceText =
    "一组数据库操作要么全部提交，要么全部撤销；发生错误时必须恢复到操作前状态。";
  const firstQuote = "一组数据库操作要么全部提交，要么全部撤销";
  const secondQuote = "发生错误时必须恢复到操作前状态。";
  const generatedAnalysis: GeneratedAnalysis = {
    title: "数据库操作的提交与撤销",
    summary: "一组数据库操作必须整体提交或撤销，错误后恢复到操作前状态。",
    knowledgePoints: [
      {
        title: "事务原子性",
        body: "一组数据库操作要么全部提交，要么全部撤销。",
        candidateTags: ["数据库事务", "原子性"],
        evidenceSpans: [spanFor(sourceText, firstQuote)],
      },
      {
        title: "错误后的状态恢复",
        body: secondQuote,
        candidateTags: ["数据库事务", "状态恢复"],
        evidenceSpans: [spanFor(sourceText, secondQuote)],
      },
    ],
  };
  const generateAnalysis = vi.fn<GenerateAnalysis>(async () =>
    generatedAnalysis,
  );

  beforeAll(async () => {
    modelTester = createLocalModelTester(endpointPaths);
    testerBaseUrl = await listenOnLoopback(modelTester);
    database = prepareTestDatabase();
    app = await buildApp({
      credentialEncryptionKey: "mode-b-local-credential-key",
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await closeServer(modelTester);
    database?.dispose();
  }, 30_000);

  it("shows generated context for review without publishing pending knowledge to search", async () => {
    const configurationVersion = await activateLocalConfiguration(
      app,
      testerBaseUrl,
    );

    expect(endpointPaths).toEqual([
      "/text/v1/chat/completions",
      "/embedding/v1/embeddings",
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "数据库事务" }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "review" },
    });

    expect(started.statusCode).toBe(202);

    const startedTask = (started.json() as { task: PublicTask }).task;

    expect(startedTask).toMatchObject({
      id: expect.any(String),
      recordId,
      handling: "review",
    });

    const completedTask = await waitForTask(app, startedTask.id);

    expect(completedTask).toMatchObject({
      id: startedTask.id,
      recordId,
      handling: "review",
      status: "succeeded",
    });
    expect(generateAnalysis).toHaveBeenCalledTimes(1);
    expect(generateAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText,
        model: "deepseek-v4-flash",
        configurationVersion,
      }),
    );
    expect(endpointPaths).toHaveLength(2);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);

    const detailBody = detail.json() as {
      editable: { text: string; textVersion: number };
      presentation: { title: string; summary: string; source: string };
      organizedItems: PendingItem[];
    };

    expect(detailBody.editable).toMatchObject({
      text: sourceText,
      textVersion: 1,
    });
    expect(detailBody.presentation).toEqual({
      title: generatedAnalysis.title,
      summary: generatedAnalysis.summary,
      source: "ai",
    });
    expect(detailBody.organizedItems).toHaveLength(2);
    expect(
      detailBody.organizedItems.map(({ title, body }) => ({ title, body })),
    ).toEqual(
      generatedAnalysis.knowledgePoints.map(({ title, body }) => ({
        title,
        body,
      })),
    );

    for (const item of detailBody.organizedItems) {
      expect(item.publicationStatus).toBe("PENDING_REVIEW");
      expect(item.usageStatus).toBe("INCLUDED");
    }

    const privateKnowledgeTerm = "事务原子性";

    expect(sourceText).not.toContain(privateKnowledgeTerm);

    const defaultSearch = await app.inject({
      method: "GET",
      url: `/api/v1/search?${new URLSearchParams({
        q: privateKnowledgeTerm,
      }).toString()}`,
    });

    expect(defaultSearch.statusCode).toBe(200);
    expect(defaultSearch.json()).toEqual({
      items: [],
      page: { nextCursor: null },
    });

    const reviewQueue = await app.inject({
      method: "GET",
      url: "/api/v1/review-queue",
    });

    expect(reviewQueue.statusCode).toBe(200);

    const reviewQueueBody = reviewQueue.json() as {
      items: Array<{
        record: { id: string; title: string };
        pendingCount: number;
      }>;
      page: { nextCursor: string | null };
    };

    expect(reviewQueueBody.items).toHaveLength(1);
    expect(reviewQueueBody.items[0]).toMatchObject({
      record: {
        id: recordId,
        title: generatedAnalysis.title,
      },
      pendingCount: 2,
    });
    expect(reviewQueueBody.page).toEqual({ nextCursor: null });
  });
});

async function activateLocalConfiguration(
  app: FastifyInstance,
  testerBaseUrl: string,
): Promise<number> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: `${testerBaseUrl}/text/v1`,
        model: "deepseek-v4-flash",
        apiKey: "mode-b-local-text-key",
      },
      embedding: {
        baseUrl: `${testerBaseUrl}/embedding/v1`,
        model: "BAAI/bge-m3",
        apiKey: "mode-b-local-embedding-key",
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

async function waitForTask(
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

function createLocalModelTester(paths: string[]): Server {
  return createServer((request, response) => {
    const path = request.url ?? "";

    request.resume();
    paths.push(path);

    if (
      path !== "/text/v1/chat/completions" &&
      path !== "/embedding/v1/embeddings"
    ) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      path.endsWith("/embeddings")
        ? JSON.stringify({ data: [{ embedding: [0, 1, 0] }] })
        : JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
    );
  });
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("local model tester did not expose a TCP port");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
