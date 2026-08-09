import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

interface SearchPage {
  items: Array<{ record: { id: string } }>;
  page: {
    nextCursor: string | null;
  };
}

describe("search result snapshot pagination public HTTP flow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for API tests");
    }

    app = await buildApp({ databaseUrl });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("continues the submitted ranking snapshot without inserting or duplicating later records", async () => {
    const marker = crypto.randomUUID();
    const originalIds = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createRecord(app, `快照检索 ${marker}\n原始记录 ${index + 1}`),
      ),
    );

    const firstResponse = await app.inject({
      method: "GET",
      url: searchUrl({ limit: 2, query: marker }),
    });

    expect(firstResponse.statusCode).toBe(200);

    const first = firstResponse.json() as SearchPage;

    expect(first.items).toHaveLength(2);
    expect(first.page).toEqual({
      nextCursor: expect.any(String),
    });

    if (!first.page.nextCursor) {
      throw new Error("the first search page must expose a continuation cursor");
    }

    const laterId = await createRecord(
      app,
      `快照检索 ${marker}\n提交查询后才出现的记录`,
    );
    const secondResponse = await app.inject({
      method: "GET",
      url: searchUrl({
        cursor: first.page.nextCursor,
        limit: 2,
        query: marker,
      }),
    });

    expect(secondResponse.statusCode).toBe(200);

    const second = secondResponse.json() as SearchPage;
    const combinedIds = [...first.items, ...second.items].map(
      (item) => item.record.id,
    );

    expect(second.page).toEqual({
      nextCursor: null,
    });
    expect(combinedIds).toHaveLength(4);
    expect(new Set(combinedIds).size).toBe(4);
    expect(combinedIds).not.toContain(laterId);
    expect([...combinedIds].sort()).toEqual([...originalIds].sort());

    const replay = await app.inject({
      method: "GET",
      url: searchUrl({
        cursor: first.page.nextCursor,
        limit: 2,
        query: marker,
      }),
    });

    expect(replay.statusCode).toBe(200);
    expect((replay.json() as SearchPage).items).toEqual(second.items);
  });
});

async function createRecord(app: FastifyInstance, text: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: `快照标签 ${crypto.randomUUID()}` }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);

  return (response.json() as { record: { id: string } }).record.id;
}

function searchUrl(options: {
  cursor?: string;
  limit: number;
  query: string;
}): string {
  const search = new URLSearchParams({
    limit: String(options.limit),
    q: options.query,
  });

  if (options.cursor) {
    search.set("cursor", options.cursor);
  }

  return `/api/v1/search?${search.toString()}`;
}
