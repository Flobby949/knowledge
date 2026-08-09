import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("existing tag reuse public HTTP flow", () => {
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

  it("reuses an existing user-approved tag by id", async () => {
    const tagName = `复用标签 ${crypto.randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "第一条有效记录。",
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(first.statusCode).toBe(201);

    const firstBody = first.json() as {
      record: {
        id: string;
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const firstTag = firstBody.record.myTags[0]!;

    expect(firstTag).toEqual({
      id: expect.any(String),
      name: tagName,
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "第二条有效记录。",
        myTags: [{ id: firstTag.id }],
        processing: "save_only",
      },
    });

    expect(second.statusCode).toBe(201);

    const secondBody = second.json() as {
      record: {
        id: string;
        myTags: Array<{ id: string; name: string }>;
      };
      task: unknown;
    };

    expect(secondBody.record.id).not.toBe(firstBody.record.id);
    expect(secondBody.record.myTags).toEqual([firstTag]);
    expect(secondBody.task).toBeNull();
  });
});
