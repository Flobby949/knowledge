import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("permanent record deletion public HTTP flow", () => {
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

  it("permanently deletes an active record", async () => {
    const marker = `delete-${crypto.randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: `待永久删除记录 ${marker}。`,
        myTags: [{ name: `删除标签 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: { id: string };
    };
    const recordId = createdBody.record.id;
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/records/${recordId}`,
    });

    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(404);

    for (const archive of ["active", "all"] as const) {
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/records",
        query: {
          archive,
          q: marker,
        },
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        items: [],
        page: {
          nextCursor: null,
        },
      });
    }
  });
});
