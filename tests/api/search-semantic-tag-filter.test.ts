import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

interface CreatedRecord {
  id: string;
  myTags: Array<{ id: string; name: string }>;
}

describe("semantic search tag hard filter public HTTP flow", () => {
  let app: FastifyInstance;
  const marker = crypto.randomUUID();
  const targetText = `数据库增量事件主动推送 ${marker}`;
  const distractorText = `手冲咖啡水温控制 ${marker}`;
  const semanticQuestion = `怎样持续接收变化 ${marker}`;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for API tests");
    }

    app = await buildApp({
      credentialEncryptionKey: "search-semantic-tag-filter-key",
      databaseUrl,
      embedText: async ({ purpose, text }) => {
        if (purpose === "query") {
          return [1, 0, 0];
        }

        return text.includes(targetText) ? [1, 0, 0] : [0, 1, 0];
      },
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("applies repeated Tag OR as a hard filter to semantic results", async () => {
    const target = await createRecord(
      app,
      targetText,
      `语义目标标签 ${marker}`,
    );
    const distractor = await createRecord(
      app,
      distractorText,
      `语义排除标签 ${marker}`,
    );
    const targetTag = target.myTags[0];
    const distractorTag = distractor.myTags[0];

    if (!targetTag || !distractorTag) {
      throw new Error("semantic search fixtures must return their tags");
    }

    await activateFakeConfiguration(app);
    await expectSemanticReady(app, 2);

    const allowed = await search(app, semanticQuestion, [targetTag.id]);

    expect(allowed).toEqual([
      expect.objectContaining({
        match: expect.objectContaining({ reason: "semantic" }),
        record: expect.objectContaining({ id: target.id }),
      }),
    ]);

    expect(await search(app, semanticQuestion, [distractorTag.id])).toEqual([]);

    const eitherTag = await search(app, semanticQuestion, [
      targetTag.id,
      distractorTag.id,
    ]);

    expect(eitherTag.map((item) => item.record.id)).toEqual([target.id]);
  });
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<CreatedRecord> {
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

  return (response.json() as { record: CreatedRecord }).record;
}

async function activateFakeConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/search-semantic-tag-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "search-semantic-tag-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/search-semantic-tag-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "search-semantic-tag-fake-embedding-key",
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

async function expectSemanticReady(
  app: FastifyInstance,
  minimumDocuments: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });

    expect(response.statusCode).toBe(200);

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

async function search(
  app: FastifyInstance,
  query: string,
  tagIds: string[],
) {
  const searchParams = new URLSearchParams({ q: query });

  for (const tagId of tagIds) {
    searchParams.append("tag", tagId);
  }

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?${searchParams.toString()}`,
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as {
    items: Array<{
      match: { reason: string };
      record: { id: string };
    }>;
  }).items;
}
