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
  status: "queued" | "running" | "succeeded" | "failed";
};

type PendingItem = {
  id: string;
  title: string;
  publicationStatus: "PENDING_REVIEW";
};

describe("first review decisions public HTTP flow", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let modelTester: Server;
  let testerBaseUrl: string;
  const endpointPaths: string[] = [];
  const sourceText =
    "数据库事务中的操作必须一起提交或一起撤销；系统发生错误后要恢复到操作前状态。";
  const firstQuote = "数据库事务中的操作必须一起提交或一起撤销";
  const secondQuote = "系统发生错误后要恢复到操作前状态。";
  const confirmedSearchTerm = "事务原子性原则";
  const correctedSearchTerm = "事务原子性需要统一提交边界";
  const rejectedSearchTerm = "故障回滚机制";
  const generatedAnalysis: GeneratedAnalysis = {
    title: "数据库操作的提交与恢复",
    summary: "事务操作整体提交或撤销，错误后恢复到操作前状态。",
    knowledgePoints: [
      {
        title: confirmedSearchTerm,
        body: "数据库事务中的操作必须一起提交或一起撤销。",
        candidateTags: ["数据库事务", "原子性"],
        evidenceSpans: [spanFor(sourceText, firstQuote)],
      },
      {
        title: rejectedSearchTerm,
        body: secondQuote,
        candidateTags: ["数据库事务", "错误恢复"],
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
      credentialEncryptionKey: "mode-b-decisions-local-key",
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

  it("publishes a corrected-and-confirmed point immediately, keeps a rejected point out, and drains the record queue", async () => {
    await activateLocalConfiguration(app, testerBaseUrl);

    expect(endpointPaths).toEqual([
      "/text/v1/chat/completions",
      "/embedding/v1/embeddings",
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "事务审查" }],
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

    const taskId = (organized.json() as { task: PublicTask }).task.id;

    await waitForSucceededTask(app, taskId);
    expect(generateAnalysis).toHaveBeenCalledTimes(1);
    expect(endpointPaths).toHaveLength(2);

    const pendingDetail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(pendingDetail.statusCode).toBe(200);

    const pendingItems = (
      pendingDetail.json() as { organizedItems: PendingItem[] }
    ).organizedItems;

    expect(pendingItems).toHaveLength(2);
    expect(
      pendingItems.every(
        (item) => item.publicationStatus === "PENDING_REVIEW",
      ),
    ).toBe(true);

    const confirmedItem = pendingItems.find(
      (item) => item.title === confirmedSearchTerm,
    );
    const rejectedItem = pendingItems.find(
      (item) => item.title === rejectedSearchTerm,
    );

    if (!confirmedItem || !rejectedItem) {
      throw new Error("review detail must expose both generated points");
    }

    await expectQueue(app, recordId, 2);

    const rejected = await decideReviewItem(app, {
      decision: "reject",
      itemId: rejectedItem.id,
      recordId,
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      item: {
        id: rejectedItem.id,
        publicationStatus: "REJECTED",
      },
    });
    await expectQueue(app, recordId, 1);

    const rejectedSearch = await search(app, rejectedSearchTerm);

    expect(rejectedSearch.items).toEqual([]);

    const confirmed = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${recordId}/organized-items/` +
        `${confirmedItem.id}/correction`,
      payload: {
        title: correctedSearchTerm,
        body: "用户确认：事务内的操作共享同一提交边界。",
      },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      item: {
        id: confirmedItem.id,
        publicationStatus: "CONFIRMED",
        title: correctedSearchTerm,
        correction: {
          title: correctedSearchTerm,
          body: "用户确认：事务内的操作共享同一提交边界。",
        },
      },
    });

    const confirmedSearch = await search(app, correctedSearchTerm);

    expect(confirmedSearch.items.map((item) => item.record.id)).toEqual([
      recordId,
    ]);

    const emptyQueue = await app.inject({
      method: "GET",
      url: "/api/v1/review-queue",
    });

    expect(emptyQueue.statusCode).toBe(200);
    expect(emptyQueue.json()).toEqual({
      items: [],
      page: { nextCursor: null },
    });

    const finalDetail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(finalDetail.statusCode).toBe(200);
    expect(finalDetail.json()).toMatchObject({
      id: recordId,
      editable: {
        text: sourceText,
        textVersion: 1,
      },
    });
  });
});

async function decideReviewItem(
  app: FastifyInstance,
  input: {
    decision: "confirm" | "reject";
    itemId: string;
    recordId: string;
  },
) {
  return app.inject({
    method: "POST",
    url:
      `/api/v1/records/${input.recordId}/organized-items/` +
      `${input.itemId}/review-decision`,
    payload: { decision: input.decision },
  });
}

async function expectQueue(
  app: FastifyInstance,
  recordId: string,
  pendingCount: number,
): Promise<void> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/review-queue",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    items: [
      {
        record: { id: recordId },
        pendingCount,
      },
    ],
    page: { nextCursor: null },
  });
}

async function search(app: FastifyInstance, query: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?${new URLSearchParams({ q: query }).toString()}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    items: Array<{ record: { id: string } }>;
    page: { nextCursor: string | null };
  };
}

async function activateLocalConfiguration(
  app: FastifyInstance,
  testerBaseUrl: string,
): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: `${testerBaseUrl}/text/v1`,
        model: "deepseek-v4-flash",
        apiKey: "mode-b-decisions-text-key",
      },
      embedding: {
        baseUrl: `${testerBaseUrl}/embedding/v1`,
        model: "BAAI/bge-m3",
        apiKey: "mode-b-decisions-embedding-key",
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

    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === "succeeded") {
      return;
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
