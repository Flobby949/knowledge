import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record archiving public HTTP flow", () => {
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

  it("hides an archived record from the active list while keeping it readable", async () => {
    const marker = `archive-${crypto.randomUUID()}`;
    const text = `待归档记录 ${marker}。\n归档后仍可核验原文。`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text,
        myTags: [{ name: `归档标签 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const createdBody = created.json() as {
      record: { id: string };
    };
    const recordId = createdBody.record.id;
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      record: {
        id: recordId,
        lifecycle: "archived",
      },
    });

    const activeList = await app.inject({
      method: "GET",
      url: "/api/v1/records",
      query: {
        archive: "active",
        q: marker,
      },
    });

    expect(activeList.statusCode).toBe(200);
    expect(activeList.json()).toEqual({
      items: [],
      page: {
        nextCursor: null,
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: recordId,
      lifecycle: "archived",
      editable: {
        text,
        textVersion: 1,
      },
      organization: {
        view: "original",
        activity: "idle",
        task: null,
      },
    });
  });
});
