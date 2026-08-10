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
  analysisPrompt?: string;
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
  handling: "automatic";
  status: "queued" | "running" | "succeeded" | "failed";
};

type OrganizedItem = {
  id: string;
  title: string;
  body: string;
  publicationStatus: "AUTO_PUBLISHED";
  usageStatus: "INCLUDED";
};

describe("automatic AI organization public flow", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let modelTester: Server;
  let testerBaseUrl: string;
  const endpointChecks: Array<{
    authorization: string | undefined;
    path: string;
  }> = [];
  const sourceText =
    "CDC 读取数据库事务日志。\n事务日志记录增量变更并保留顺序。";
  const analysisPrompt = "只整理原文直接支持的关键知识，每个知识点仅保留核心标签。";
  const firstQuote = "CDC 读取数据库事务日志。";
  const secondQuote = "事务日志记录增量变更并保留顺序。";
  const generatedAnalysis: GeneratedAnalysis = {
    title: "CDC 与数据库事务日志",
    summary: "CDC 读取数据库事务日志，事务日志记录增量变更并保留顺序。",
    knowledgePoints: [
      {
        title: "CDC 如何获取数据库变更",
        body: firstQuote,
        candidateTags: ["CDC", "事务日志"],
        evidenceSpans: [spanFor(sourceText, firstQuote)],
      },
      {
        title: "事务日志保留的信息",
        body: secondQuote,
        candidateTags: ["事务日志", "增量变更"],
        evidenceSpans: [spanFor(sourceText, secondQuote)],
      },
    ],
  };
  const generateAnalysis = vi.fn<GenerateAnalysis>(async () =>
    generatedAnalysis,
  );

  beforeAll(async () => {
    modelTester = createLocalModelTester(endpointChecks);
    testerBaseUrl = await listenOnLoopback(modelTester);
    database = prepareTestDatabase();
    app = await buildApp({
      credentialEncryptionKey: "mode-a-local-credential-key",
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

  it("publishes grounded knowledge automatically while preserving the exact original text", async () => {
    const textEndpoint = {
      baseUrl: `${testerBaseUrl}/text/v1`,
      model: "deepseek-v4-flash",
      apiKey: "local-text-key",
    };
    const embeddingEndpoint = {
      baseUrl: `${testerBaseUrl}/embedding/v1`,
      model: "BAAI/bge-m3",
      apiKey: "local-embedding-key",
    };
    const savedDraft = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: {
        text: textEndpoint,
        embedding: embeddingEndpoint,
      },
    });

    expect(savedDraft.statusCode).toBe(200);

    for (const kind of ["text", "embedding"] as const) {
      const tested = await app.inject({
        method: "POST",
        url: `/api/v1/model-config/draft/tests/${kind}`,
      });

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ kind, status: "passed" });
    }

    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(activated.statusCode).toBe(200);

    const configurationVersion = (
      activated.json() as { active: { version: number } }
    ).active.version;

    expect(configurationVersion).toBe(1);
    expect(endpointChecks).toEqual([
      {
        authorization: `Bearer ${textEndpoint.apiKey}`,
        path: "/text/v1/chat/completions",
      },
      {
        authorization: `Bearer ${embeddingEndpoint.apiKey}`,
        path: "/embedding/v1/embeddings",
      },
    ]);

    const promptUpdated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { analysisPrompt },
    });

    expect(promptUpdated.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "数据工程" }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(started.statusCode).toBe(202);

    const startedBody = started.json() as { task: PublicTask };

    expect(startedBody.task).toMatchObject({
      id: expect.any(String),
      recordId,
      handling: "automatic",
      status: "queued",
    });

    const completedTask = await waitForTask(app, startedBody.task.id);

    expect(completedTask).toMatchObject({
      id: startedBody.task.id,
      recordId,
      handling: "automatic",
      status: "succeeded",
    });
    expect(generateAnalysis).toHaveBeenCalledTimes(1);
    expect(generateAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText,
        model: "deepseek-v4-flash",
        configurationVersion,
        analysisPrompt,
      }),
    );
    expect(endpointChecks).toHaveLength(2);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);

    const detailBody = detail.json() as {
      editable: { text: string; textVersion: number };
      presentation: { title: string; summary: string; source: string };
      organization: { view: string; activity: string; task: null };
      organizedItems: OrganizedItem[];
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
    expect(detailBody.organization).toEqual({
      view: "organized",
      activity: "idle",
      task: null,
    });
    expect(detailBody.organizedItems.length).toBeGreaterThanOrEqual(1);
    expect(detailBody.organizedItems.length).toBeLessThanOrEqual(5);
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
      expect(item.publicationStatus).toBe("AUTO_PUBLISHED");
      expect(item.usageStatus).toBe("INCLUDED");

      const expectedPoint = generatedAnalysis.knowledgePoints.find(
        (point) => point.title === item.title,
      );

      if (!expectedPoint) {
        throw new Error(`unexpected organized item: ${item.title}`);
      }

      const evidence = await app.inject({
        method: "GET",
        url:
          `/api/v1/records/${recordId}/organized-items/` +
          `${item.id}/evidence`,
      });

      expect(evidence.statusCode).toBe(200);

      const evidenceBody = evidence.json() as {
        items: Array<{
          quote: string;
          start: number;
          end: number;
          sourceTextVersion: number;
        }>;
      };

      expect(evidenceBody.items).toHaveLength(1);
      expect(evidenceBody.items[0]).toMatchObject({
        ...expectedPoint.evidenceSpans[0],
        sourceTextVersion: 1,
      });
    }
  });
});

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

function createLocalModelTester(
  checks: Array<{ authorization: string | undefined; path: string }>,
): Server {
  return createServer((request, response) => {
    const path = request.url ?? "";

    request.resume();
    checks.push({
      authorization: request.headers.authorization,
      path,
    });

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
