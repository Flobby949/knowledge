import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record restoration public HTTP flow", () => {
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

  it("restores an archived record without changing its original text", async () => {
    const marker = `restore-${crypto.randomUUID()}`;
    const text = `待恢复记录 ${marker}。\n原文版本保持不变。`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text,
        myTags: [{ name: `恢复标签 ${marker}` }],
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

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      record: {
        id: recordId,
        lifecycle: "active",
        textVersion: 1,
      },
    });

    const activeList = await app.inject({
      method: "GET",
      url: "/api/v1/records",
      query: { q: marker },
    });

    expect(activeList.statusCode).toBe(200);
    expect(activeList.json()).toMatchObject({
      items: [
        {
          id: recordId,
          lifecycle: "active",
          preview: text,
          textVersion: 1,
        },
      ],
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
      lifecycle: "active",
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
