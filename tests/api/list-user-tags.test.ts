import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("user-approved tag listing public HTTP flow", () => {
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

  it("lists a matching user-approved tag with its record count", async () => {
    const marker = `tag-list-${crypto.randomUUID()}`;
    const tagName = `数据工程 ${marker}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "用于验证标签列表的有效记录。",
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: {
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const createdTag = createdBody.record.myTags[0]!;

    expect(createdTag).toEqual({
      id: expect.any(String),
      name: tagName,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/tags",
      query: {
        approval: "user_approved",
        q: marker,
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          id: createdTag.id,
          name: tagName,
          origin: "user_created",
          approvalStatus: "user_approved",
          recordCount: 1,
        },
      ],
      page: {
        nextCursor: null,
      },
    });
  });
});
