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

type EmbedTextInput = {
  text: string;
  purpose: "document" | "query";
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
};

type EmbedText = (input: EmbedTextInput) => Promise<number[]>;

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type SearchHealth = {
  keyword: { status: "ready" };
  semantic: {
    status: "building" | "paused" | "ready";
    model: string;
    configurationVersion: number;
    readyDocuments: number;
    totalDocuments: number;
  };
};

type SearchItem = {
  record: { id: string };
  match: {
    reason: "original_text" | "knowledge_point" | "semantic";
    snippets: Array<{ text: string }>;
  };
};

describe("embedding readiness and mixed record search", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const firstEmbeddingModel = "deterministic-embedding-v1";
  const secondEmbeddingModel = "deterministic-embedding-v2";
  const keyword = "即时关键词-embedding-readiness";
  const semanticQuery = "如何在不轮询表的情况下持续收到增量事件";
  const overviewSemanticQuery = "为什么要从整体说明变更推送";
  const correctedOverviewSemanticQuery = "怎样概括可靠的幂等下游通知";
  const targetSource =
    `事务日志会连续记录数据库的变化，系统读取这些记录并主动发送给下游。${keyword}`;
  const distractorMarker = "手冲咖啡的水温与研磨度";
  const distractorSource = `${distractorMarker}会共同影响萃取结果。`;
  const firstPointTitle = "事务日志持续记录数据库变化";
  const firstPointBody = "事务日志会连续记录数据库的变化。";
  const secondPointTitle = "变化被主动发送给下游";
  const secondPointBody = "系统读取这些记录并主动发送给下游。";
  const overviewTitle = "事务日志与下游变更推送";
  const overviewSummary = "事务日志记录数据库变化，系统读取后主动发送给下游。";
  const overviewText = `${overviewTitle}\n${overviewSummary}`;
  const correctedOverviewTitle = "可靠的幂等下游通知";
  const correctedOverviewSummary = "只推送已提交变化，并由下游幂等消费。";
  const correctedOverviewText =
    `${correctedOverviewTitle}\n${correctedOverviewSummary}`;
  const firstModelDocuments = deferred<void>();
  const secondModelDocuments = deferred<void>();
  const correctedOverviewDocument = deferred<void>();
  const embeddingCalls: Array<Omit<EmbedTextInput, "apiKey">> = [];
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );
  const generateAnalysis = vi.fn(async () => ({
    title: overviewTitle,
    summary: overviewSummary,
    knowledgePoints: [
      {
        title: firstPointTitle,
        body: firstPointBody,
        candidateTags: ["事务日志"],
        evidenceSpans: [spanFor(targetSource, firstPointBody.slice(0, -1))],
      },
      {
        title: secondPointTitle,
        body: secondPointBody,
        candidateTags: ["变更推送"],
        evidenceSpans: [spanFor(targetSource, secondPointBody.slice(0, -1))],
      },
    ],
  }));
  const embedText = vi.fn<EmbedText>(async (input) => {
    embeddingCalls.push({
      text: input.text,
      purpose: input.purpose,
      baseUrl: input.baseUrl,
      model: input.model,
      configurationVersion: input.configurationVersion,
    });

    if (input.purpose === "document") {
      if (input.model === firstEmbeddingModel) {
        await firstModelDocuments.promise;
      }

      if (input.model === secondEmbeddingModel) {
        await secondModelDocuments.promise;
      }

      if (input.text === correctedOverviewText) {
        await correctedOverviewDocument.promise;
      }
    }

    return embeddingFor(input);
  });

  beforeAll(async () => {
    database = prepareTestDatabase();

    const buildOptions: Parameters<typeof buildApp>[0] & {
      embedText: EmbedText;
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
    firstModelDocuments.resolve();
    secondModelDocuments.resolve();
    correctedOverviewDocument.resolve();
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("keeps keyword search live while semantic indexes build and atomically changes vector spaces", async () => {
    const targetRecordId = await createRecord(app, targetSource, "数据变化");

    await createRecord(app, distractorSource, "咖啡冲泡");

    expect(await searchRecordIds(app, keyword)).toEqual([targetRecordId]);
    expect(await search(app, semanticQuery)).toEqual([]);

    const firstConfigurationVersion = await activateConfiguration(
      app,
      firstEmbeddingModel,
    );

    expect(firstConfigurationVersion).toBe(1);
    await expectSemanticHealth(app, {
      status: "building",
      model: firstEmbeddingModel,
      configurationVersion: firstConfigurationVersion,
      readyDocuments: 0,
      totalDocuments: 2,
    });
    expect(await searchRecordIds(app, keyword)).toEqual([targetRecordId]);

    const firstRebuild = await triggerRebuild(app);

    expect(firstRebuild).toEqual({
      rebuild: {
        status: "queued",
        model: firstEmbeddingModel,
        configurationVersion: firstConfigurationVersion,
      },
    });

    firstModelDocuments.resolve();
    await expectSemanticHealth(app, {
      status: "ready",
      model: firstEmbeddingModel,
      configurationVersion: firstConfigurationVersion,
      readyDocuments: 2,
      totalDocuments: 2,
    });

    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${targetRecordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(organized.statusCode).toBe(202);

    const taskId = (organized.json() as { task: PublicTask }).task.id;

    await waitForSucceededTask(app, taskId);
    expect(generateAnalysis).toHaveBeenCalledTimes(1);
    await expectSemanticHealth(app, {
      status: "ready",
      model: firstEmbeddingModel,
      configurationVersion: firstConfigurationVersion,
      readyDocuments: 5,
      totalDocuments: 5,
    });

    expect(targetSource).not.toContain(semanticQuery);
    expect(firstPointBody).not.toContain(semanticQuery);
    expect(secondPointBody).not.toContain(semanticQuery);

    const firstSemanticResults = await search(app, semanticQuery);

    expect(firstSemanticResults.map((item) => item.record.id)).toEqual([
      targetRecordId,
    ]);
    expect(new Set(firstSemanticResults.map((item) => item.record.id)).size).toBe(
      firstSemanticResults.length,
    );
    expect(firstSemanticResults[0]?.match.reason).toBe("semantic");
    expect(
      firstSemanticResults[0]?.match.snippets.some((snippet) =>
        [
          firstPointTitle,
          firstPointBody,
          secondPointTitle,
          secondPointBody,
        ].some((knowledgeText) => snippet.text.includes(knowledgeText)),
      ),
    ).toBe(true);

    const overviewResults = await search(app, overviewSemanticQuery);

    expect(overviewResults.map((item) => item.record.id)).toEqual([
      targetRecordId,
    ]);
    expect(
      overviewResults[0]?.match.snippets.some(
        (snippet) => snippet.text === overviewText,
      ),
    ).toBe(true);

    const correctedOverview = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${targetRecordId}/overview-correction`,
      payload: {
        title: correctedOverviewTitle,
        summary: correctedOverviewSummary,
      },
    });

    expect(correctedOverview.statusCode).toBe(200);
    await waitForDocumentEmbedding(correctedOverviewText);
    await expectSemanticHealth(app, {
      status: "building",
      model: firstEmbeddingModel,
      configurationVersion: firstConfigurationVersion,
      readyDocuments: 4,
      totalDocuments: 5,
    });
    expect(await search(app, overviewSemanticQuery)).toEqual([]);

    correctedOverviewDocument.resolve();
    await expectSemanticHealth(app, {
      status: "ready",
      model: firstEmbeddingModel,
      configurationVersion: firstConfigurationVersion,
      readyDocuments: 5,
      totalDocuments: 5,
    });
    const correctedOverviewResults = await search(
      app,
      correctedOverviewSemanticQuery,
    );

    expect(correctedOverviewResults.map((item) => item.record.id)).toEqual([
      targetRecordId,
    ]);
    expect(
      correctedOverviewResults[0]?.match.snippets.some(
        (snippet) => snippet.text === correctedOverviewText,
      ),
    ).toBe(true);

    const secondConfigurationVersion = await activateConfiguration(
      app,
      secondEmbeddingModel,
    );

    expect(secondConfigurationVersion).toBe(2);
    await expectSemanticHealth(app, {
      status: "paused",
      model: secondEmbeddingModel,
      configurationVersion: secondConfigurationVersion,
      readyDocuments: 0,
      totalDocuments: 5,
    });
    expect(await searchRecordIds(app, keyword)).toEqual([targetRecordId]);
    expect(await search(app, semanticQuery)).toEqual([]);

    const secondRebuild = await triggerRebuild(app);

    expect(secondRebuild).toEqual({
      rebuild: {
        status: "queued",
        model: secondEmbeddingModel,
        configurationVersion: secondConfigurationVersion,
      },
    });

    secondModelDocuments.resolve();
    await expectSemanticHealth(app, {
      status: "ready",
      model: secondEmbeddingModel,
      configurationVersion: secondConfigurationVersion,
      readyDocuments: 5,
      totalDocuments: 5,
    });

    const rebuiltSemanticResults = await search(app, semanticQuery);

    expect(rebuiltSemanticResults.map((item) => item.record.id)).toEqual([
      targetRecordId,
    ]);
    expect(
      embeddingCalls.some(
        (call) =>
          call.purpose === "document" &&
          call.model === secondEmbeddingModel &&
          call.configurationVersion === secondConfigurationVersion &&
          (call.text.includes(firstPointTitle) ||
            call.text.includes(secondPointTitle)),
      ),
    ).toBe(true);
    expect(
      embeddingCalls.some(
        (call) =>
          call.purpose === "query" &&
          call.text === semanticQuery &&
          call.model === secondEmbeddingModel &&
          call.configurationVersion === secondConfigurationVersion,
      ),
    ).toBe(true);
  });

  function embeddingFor(input: EmbedTextInput): number[] {
    const targetVector =
      input.model === firstEmbeddingModel ? [1, 0, 0, 0] : [0, 1, 0, 0];
    const distractorVector =
      input.model === firstEmbeddingModel ? [0, 1, 0, 0] : [1, 0, 0, 0];
    const overviewVector =
      input.model === firstEmbeddingModel ? [0, 0, 1, 0] : [0, 0, 0, 1];
    const correctedOverviewVector =
      input.model === firstEmbeddingModel ? [0, 0, 0, 1] : [0, 0, 1, 0];

    if (input.purpose === "query" && input.text === semanticQuery) {
      return targetVector;
    }

    if (input.purpose === "query" && input.text === overviewSemanticQuery) {
      return overviewVector;
    }

    if (
      input.purpose === "query" &&
      input.text === correctedOverviewSemanticQuery
    ) {
      return correctedOverviewVector;
    }

    if (input.text === overviewText) {
      return overviewVector;
    }

    if (input.text === correctedOverviewText) {
      return correctedOverviewVector;
    }

    if (
      input.text.includes(firstPointTitle) ||
      input.text.includes(secondPointTitle)
    ) {
      return targetVector;
    }

    if (input.text.includes(distractorMarker)) {
      return distractorVector;
    }

    return [0.5, 0.5, 0.5, 0.5];
  }

  async function waitForDocumentEmbedding(text: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        embeddingCalls.some(
          (call) => call.purpose === "document" && call.text === text,
        )
      ) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`document embedding did not start for: ${text}`);
  }
});

describe("semantic query degradation", () => {
  it("keeps keyword results available when the embedding query endpoint fails", async () => {
    const database = prepareTestDatabase();
    let rejectQueries = false;
    const embedText = vi.fn<EmbedText>(async (input) => {
      if (input.purpose === "query" && rejectQueries) {
        throw new Error("deterministic query endpoint outage");
      }

      return [1, 0, 0];
    });
    const app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });

    try {
      await app.ready();
      const marker = "关键词在向量查询故障时仍然可用";
      const recordId = await createRecord(app, marker, "故障降级");
      const configurationVersion = await activateConfiguration(
        app,
        "deterministic-outage-model",
      );

      await expectSemanticHealth(app, {
        status: "ready",
        model: "deterministic-outage-model",
        configurationVersion,
        readyDocuments: 1,
        totalDocuments: 1,
      });
      rejectQueries = true;

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/search?${new URLSearchParams({ q: marker }).toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect((response.json() as { items: SearchItem[] }).items).toEqual([
        expect.objectContaining({
          record: expect.objectContaining({ id: recordId }),
          match: expect.objectContaining({ reason: "original_text" }),
        }),
      ]);
    } finally {
      await app.close();
      database.dispose();
    }
  });
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<string> {
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

  return (response.json() as { record: { id: string } }).record.id;
}

async function activateConfiguration(
  app: FastifyInstance,
  embeddingModel: string,
): Promise<number> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: embeddingModel,
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

  return (activated.json() as { active: { version: number } }).active.version;
}

async function triggerRebuild(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/search-index/rebuild",
  });

  expect(response.statusCode).toBe(202);

  return response.json() as {
    rebuild: {
      status: "queued";
      model: string;
      configurationVersion: number;
    };
  };
}

async function expectSemanticHealth(
  app: FastifyInstance,
  expected: SearchHealth["semantic"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });

    expect(response.statusCode).toBe(200);

    const health = response.json() as SearchHealth;

    expect(health.keyword).toEqual({ status: "ready" });

    if (
      health.semantic.status === expected.status &&
      health.semantic.model === expected.model &&
      health.semantic.configurationVersion === expected.configurationVersion &&
      health.semantic.readyDocuments === expected.readyDocuments &&
      health.semantic.totalDocuments === expected.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`semantic search health did not become ${expected.status}`);
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

async function search(
  app: FastifyInstance,
  query: string,
): Promise<SearchItem[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?${new URLSearchParams({ q: query }).toString()}`,
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as { items: SearchItem[] }).items;
}

async function searchRecordIds(
  app: FastifyInstance,
  query: string,
): Promise<string[]> {
  return (await search(app, query)).map((item) => item.record.id);
}

function spanFor(sourceText: string, quote: string) {
  const start = sourceText.indexOf(quote);

  if (start < 0) {
    throw new Error(`quote is missing from source text: ${quote}`);
  }

  return { quote, start, end: start + quote.length };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}
