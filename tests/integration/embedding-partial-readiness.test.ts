import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type EmbedTextInput = {
  text: string;
  purpose: "document" | "query";
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
};

type SearchItem = {
  record: { id: string };
  match: { reason: "original_text" | "knowledge_point" | "semantic" };
};

type SemanticHealth = {
  status: "building" | "paused" | "ready";
  model: string;
  configurationVersion: number;
  readyDocuments: number;
  failedDocuments: number;
  totalDocuments: number;
};

describe("per-document embedding readiness", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const model = "deterministic-partial-readiness-v1";
  const semanticQuery = "怎样让数据库变化持续推送给下游";
  const finalSemanticQuery = "怎样保证消费者可重复处理消息";
  const firstSource = "事务日志会持续记录数据库变化，并将增量事件发送给下游。";
  const secondKeyword = "手冲咖啡唯一关键词-partial-readiness";
  const secondSource = `${secondKeyword}，水温和研磨度会影响萃取。`;
  const interimSource = "等待中的中间版本：消费者按收到顺序处理事件。";
  const finalSource = "最终版本：消费者用幂等键保证消息可重复处理。";
  const interimEmbedding = deferred<void>();
  const documentCalls: string[] = [];
  let failSecondDocument = true;

  const embedText = vi.fn(async (input: EmbedTextInput): Promise<number[]> => {
    if (input.purpose === "query") {
      return input.text === finalSemanticQuery ? [0, 0, 1] : [1, 0, 0];
    }

    documentCalls.push(input.text);

    if (input.text === secondSource) {
      if (failSecondDocument) {
        throw new Error("deterministic embedding failure");
      }

      return [0, 1, 0];
    }

    if (input.text === interimSource) {
      await interimEmbedding.promise;
      return [1, 0, 0];
    }

    if (input.text === finalSource) {
      return [0, 0, 1];
    }

    return [1, 0, 0];
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    interimEmbedding.resolve();
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("keeps ready documents searchable when siblings fail and rejects stale late vectors", async () => {
    const first = await createRecord(app, firstSource, "事务日志");
    const second = await createRecord(app, secondSource, "咖啡冲泡");
    const configurationVersion = await activateConfiguration(app, model);

    await expectHealth(app, {
      status: "building",
      model,
      configurationVersion,
      readyDocuments: 1,
      failedDocuments: 1,
      totalDocuments: 2,
    });

    expect(await searchRecordIds(app, semanticQuery)).toEqual([first.id]);
    expect(await search(app, secondKeyword)).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({ id: second.id }),
        match: expect.objectContaining({ reason: "original_text" }),
      }),
    );
    expect(documentCalls.filter((text) => text === secondSource)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(documentCalls.filter((text) => text === secondSource)).toHaveLength(1);

    failSecondDocument = false;
    await triggerRebuild(app);
    await expectHealth(app, {
      status: "ready",
      model,
      configurationVersion,
      readyDocuments: 2,
      failedDocuments: 0,
      totalDocuments: 2,
    });
    expect(documentCalls.filter((text) => text === firstSource)).toHaveLength(1);
    expect(documentCalls.filter((text) => text === secondSource)).toHaveLength(2);

    await updateRecord(app, first.id, interimSource, first.tagId);

    await expectHealth(app, {
      status: "building",
      model,
      configurationVersion,
      readyDocuments: 1,
      failedDocuments: 0,
      totalDocuments: 2,
    });
    expect(await searchRecordIds(app, semanticQuery)).toEqual([]);
    expect(await searchRecordIds(app, "等待中的中间版本")).toEqual([first.id]);

    await waitForDocumentCall(interimSource);
    await updateRecord(app, first.id, finalSource, first.tagId);
    interimEmbedding.resolve();

    await expectHealth(app, {
      status: "building",
      model,
      configurationVersion,
      readyDocuments: 1,
      failedDocuments: 0,
      totalDocuments: 2,
    });
    expect(await searchRecordIds(app, semanticQuery)).toEqual([]);
    expect(await searchRecordIds(app, "最终版本")).toEqual([first.id]);

    await expectHealth(app, {
      status: "ready",
      model,
      configurationVersion,
      readyDocuments: 2,
      failedDocuments: 0,
      totalDocuments: 2,
    });
    expect(await searchRecordIds(app, finalSemanticQuery)).toEqual([first.id]);
  });

  async function waitForDocumentCall(text: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (documentCalls.includes(text)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`embedding call did not start for: ${text}`);
  }
});

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
  const record = (response.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;

  return { id: record.id, tagId: record.myTags[0]!.id };
}

async function updateRecord(
  app: FastifyInstance,
  recordId: string,
  text: string,
  tagId: string,
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${recordId}`,
    payload: {
      text,
      myTags: [{ id: tagId }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(200);
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

async function triggerRebuild(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/search-index/rebuild",
  });

  expect(response.statusCode).toBe(202);
}

async function expectHealth(
  app: FastifyInstance,
  expected: SemanticHealth,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/v1/search-health" });
    expect(response.statusCode).toBe(200);
    const semantic = (response.json() as { semantic: SemanticHealth }).semantic;

    if (
      semantic.status === expected.status &&
      semantic.model === expected.model &&
      semantic.configurationVersion === expected.configurationVersion &&
      semantic.readyDocuments === expected.readyDocuments &&
      semantic.failedDocuments === expected.failedDocuments &&
      semantic.totalDocuments === expected.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`semantic health did not reach ${JSON.stringify(expected)}`);
}

async function searchRecordIds(
  app: FastifyInstance,
  query: string,
): Promise<string[]> {
  return (await search(app, query)).map((item) => item.record.id);
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}
