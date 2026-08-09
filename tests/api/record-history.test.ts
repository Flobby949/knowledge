import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("record history public HTTP flow", () => {
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

  it("lists original text versions newest first and opens an exact snapshot", async () => {
    const v1 = "第一版原文。\n尾部空格  ";
    const v2 = "第二版原文。\n<b>仍为纯文本</b>";
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: v1,
        myTags: [{ name: `历史标签 ${crypto.randomUUID()}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: {
        id: string;
        myTags: Array<{ id: string }>;
      };
    };
    const recordId = createdBody.record.id;
    const tagId = createdBody.record.myTags[0]!.id;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text: v2,
        myTags: [{ id: tagId }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history`,
    });

    expect(history.statusCode).toBe(200);

    const historyBody = history.json() as {
      items: Array<{
        id: string;
        type: string;
        version: number;
        createdAt: string;
        isCurrent: boolean;
      }>;
      page: { nextCursor: null };
    };

    expect(historyBody).toEqual({
      items: [
        {
          id: expect.stringMatching(uuidPattern),
          type: "original",
          version: 2,
          createdAt: expect.any(String),
          isCurrent: true,
        },
        {
          id: expect.stringMatching(uuidPattern),
          type: "original",
          version: 1,
          createdAt: expect.any(String),
          isCurrent: false,
        },
      ],
      page: {
        nextCursor: null,
      },
    });

    const v1Entry = historyBody.items[1]!;
    const snapshot = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history/${v1Entry.id}`,
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toEqual({
      id: v1Entry.id,
      type: "original",
      version: 1,
      createdAt: v1Entry.createdAt,
      snapshot: {
        text: v1,
      },
      currentVersion: 2,
    });
  });
});
