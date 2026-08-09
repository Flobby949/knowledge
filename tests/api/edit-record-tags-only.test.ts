import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record tag-only editing public HTTP flow", () => {
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

  it("replaces the final tag set without creating a text version", async () => {
    const text = "只修改标签时保持同一版原文。";
    const tagAName = `标签 A ${crypto.randomUUID()}`;
    const tagBName = `标签 B ${crypto.randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text,
        myTags: [{ name: tagAName }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: {
        id: string;
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const recordId = createdBody.record.id;
    const tagA = createdBody.record.myTags[0]!;
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text,
        myTags: [{ id: tagA.id }, { name: tagBName }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);

    const updatedBody = updated.json() as {
      record: {
        textVersion: number;
        myTags: Array<{ id: string; name: string }>;
      };
      task: unknown;
    };

    expect(updatedBody.record.textVersion).toBe(1);
    expect(updatedBody.record.myTags).toEqual([
      tagA,
      {
        id: expect.any(String),
        name: tagBName,
      },
    ]);
    expect(updatedBody.task).toBeNull();

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}/history`,
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({
      items: [
        {
          id: expect.any(String),
          type: "original",
          version: 1,
          createdAt: expect.any(String),
          isCurrent: true,
        },
      ],
      page: {
        nextCursor: null,
      },
    });
  });
});
