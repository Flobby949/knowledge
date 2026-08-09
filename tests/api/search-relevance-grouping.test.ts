import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("search relevance and source grouping public HTTP flow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for API tests");
    }

    app = await buildApp({
      credentialEncryptionKey: "search-relevance-grouping-test-key",
      databaseUrl,
      embedText: async ({ purpose, text }) => {
        if (purpose === "query") {
          return text.startsWith("混合语义 ") ? [1, 0, 0] : [0, 1, 0];
        }

        return text.startsWith("SEARCH_SEMANTIC ")
          ? [1, 0, 0]
          : [0, 0, 1];
      },
      generateAnalysis: async ({ sourceText }) => {
        const semanticMarker = /SEARCH_SEMANTIC ([0-9a-f]{8})/u.exec(
          sourceText,
        )?.[1];

        if (semanticMarker) {
          const query = `混合语义 ${semanticMarker}`;
          const quote = `原始语义来源 ${semanticMarker}`;
          const start = sourceText.indexOf(quote);

          return {
            title: `混合检索记录 ${semanticMarker}`,
            summary: "关键词来源与语义来源应保留在同一个记录组。",
            knowledgePoints: [
              {
                title: query,
                body: quote,
                candidateTags: ["混合检索"],
                evidenceSpans: [
                  { quote, start, end: start + quote.length },
                ],
              },
            ],
          };
        }

        const groupingMarker = /SEARCH_GROUPING ([0-9a-f]{8})/u.exec(
          sourceText,
        )?.[1];

        if (groupingMarker) {
          const query = `聚合命中 ${groupingMarker}`;
          const quote = `原文也包含 ${query}`;
          const start = sourceText.indexOf(quote);

          return {
            title: `分组记录 ${groupingMarker}`,
            summary: `总览同样包含 ${query}`,
            knowledgePoints: [
              {
                title: `知识点一 ${query}`,
                body: quote,
                candidateTags: ["搜索分组"],
                evidenceSpans: [
                  { quote, start, end: start + quote.length },
                ],
              },
              {
                title: `知识点二 ${query}`,
                body: quote,
                candidateTags: ["搜索分组"],
                evidenceSpans: [
                  { quote, start, end: start + quote.length },
                ],
              },
            ],
          };
        }

        const marker = /SEARCH_RELEVANCE ([0-9a-f]{8})/u.exec(sourceText)?.[1];

        if (!marker) {
          throw new Error("search relevance fixture marker is missing");
        }

        const quote = `相关性标题 ${marker}`;
        const start = sourceText.indexOf(quote);

        if (start < 0) {
          throw new Error("search relevance evidence is missing");
        }

        return {
          title: quote,
          summary: "这条较早记录通过有效标题提供精确命中。",
          knowledgePoints: [
            {
              title: "相关性排序说明",
              body: quote,
              candidateTags: ["搜索相关性"],
              evidenceSpans: [
                { quote, start, end: start + quote.length },
              ],
            },
          ],
        };
      },
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
    await activateFakeConfiguration(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("ranks an older exact record title ahead of a newer body-only match", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const query = `相关性标题 ${marker}`;
    const older = await createRecord(
      app,
      `SEARCH_RELEVANCE ${marker}\n${query}`,
      `旧记录 ${marker}`,
    );
    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${older}/organize`,
      payload: { handling: "automatic" },
    });

    expect(organized.statusCode).toBe(202);
    await expectTaskSucceeded(
      app,
      (organized.json() as { task: { id: string } }).task.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const newer = await createRecord(
      app,
      `较新的正文仅在这一行包含 ${query}，但标题不是查询。`,
      `新记录 ${marker}`,
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent(query)}`,
    });

    expect(response.statusCode).toBe(200);

    const ids = (response.json() as SearchResponse).items.map(
      (item) => item.record.id,
    );

    expect(ids.slice(0, 2)).toEqual([older, newer]);
  });

  it("returns one record group with its fragment, overview, and every matching knowledge point", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const query = `聚合命中 ${marker}`;
    const recordId = await createRecord(
      app,
      `SEARCH_GROUPING ${marker}\n原文也包含 ${query}`,
      `来源分组 ${marker}`,
    );
    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(organized.statusCode).toBe(202);
    await expectTaskSucceeded(
      app,
      (organized.json() as { task: { id: string } }).task.id,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent(query)}`,
    });

    expect(response.statusCode).toBe(200);

    const matchingRecords = (response.json() as SearchResponse).items.filter(
      (item) => item.record.id === recordId,
    );

    expect(matchingRecords).toHaveLength(1);

    const item = matchingRecords[0];

    if (!item) {
      throw new Error("grouped search result is missing");
    }

    const matches = [item.match, ...(item.otherMatches ?? [])];

    expect(matches.map((match) => match.source.type)).toEqual([
      "overview",
      "knowledge_point",
      "knowledge_point",
      "fragment",
    ]);
    expect(new Set(matches.map((match) => match.source.id)).size).toBe(4);
    expect(
      matches.filter((match) => match.source.type === "knowledge_point"),
    ).toHaveLength(2);
    expect(matches.flatMap((match) => match.snippets).map((snippet) => snippet.text))
      .toEqual(
        expect.arrayContaining([
          `总览同样包含 ${query}`,
          `知识点一 ${query}`,
          `知识点二 ${query}`,
          `原文也包含 ${query}`,
        ]),
      );
  });

  it("merges a semantic source into the same record group as its keyword hit", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const query = `混合语义 ${marker}`;
    const recordId = await createRecord(
      app,
      `SEARCH_SEMANTIC ${marker}\n原始语义来源 ${marker}`,
      `混合检索 ${marker}`,
    );
    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(organized.statusCode).toBe(202);
    await expectTaskSucceeded(
      app,
      (organized.json() as { task: { id: string } }).task.id,
    );
    await expectSemanticReady(app, 3);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/search?q=${encodeURIComponent(query)}`,
    });

    expect(response.statusCode).toBe(200);

    const matchingRecords = (response.json() as SearchResponse).items.filter(
      (item) => item.record.id === recordId,
    );

    expect(matchingRecords).toHaveLength(1);

    const item = matchingRecords[0];

    if (!item) {
      throw new Error("mixed search result is missing");
    }

    expect([item.match, ...(item.otherMatches ?? [])]).toEqual([
      expect.objectContaining({
        reason: "knowledge_point",
        source: expect.objectContaining({ type: "knowledge_point" }),
      }),
      expect.objectContaining({
        reason: "semantic",
        source: expect.objectContaining({ type: "fragment" }),
      }),
    ]);
  });
});

interface SearchResponse {
  items: Array<{
    match: SearchMatch;
    otherMatches?: SearchMatch[];
    record: { id: string };
  }>;
}

interface SearchMatch {
  reason: "knowledge_point" | "original_text" | "semantic";
  source: {
    id: string;
    type: "fragment" | "knowledge_point" | "overview";
  };
  snippets: Array<{
    highlights: Array<{ end: number; start: number }>;
    text: string;
  }>;
  visibility: "current" | "pending_review";
}

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

async function activateFakeConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/search-relevance-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "search-relevance-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/search-relevance-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "search-relevance-fake-embedding-key",
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

async function expectTaskSucceeded(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const task = (response.json() as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    }).task;

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

async function expectSemanticReady(
  app: FastifyInstance,
  minimumDocuments: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });
    const semantic = (response.json() as {
      semantic: {
        readyDocuments: number;
        status: "building" | "paused" | "ready";
        totalDocuments: number;
      };
    }).semantic;

    if (
      semantic.status === "ready" &&
      semantic.readyDocuments >= minimumDocuments &&
      semantic.readyDocuments === semantic.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("semantic search documents did not become ready");
}
