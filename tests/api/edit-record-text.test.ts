import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record text editing public HTTP flow", () => {
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

  it("creates a second text version while reusing the record tag", async () => {
    const tagName = `编辑标签 ${crypto.randomUUID()}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "第一版正文。",
        myTags: [{ name: tagName }],
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
    const tag = createdBody.record.myTags[0]!;
    const v2Title = "第二版正文保留原样。";
    const v2 = `${v2Title}\n<b>仍是纯文本</b>  `;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text: v2,
        myTags: [{ id: tag.id }],
        processing: "save_only",
      },
    });

    expect(updated.statusCode).toBe(200);

    const updatedBody = updated.json() as {
      record: {
        id: string;
        title: string;
        preview: string;
        myTags: Array<{ id: string; name: string }>;
        textVersion: number;
        organization: {
          view: string;
          activity: string;
        };
      };
      task: unknown;
    };

    expect(updatedBody.record).toMatchObject({
      id: recordId,
      title: v2Title,
      preview: v2,
      textVersion: 2,
      organization: {
        view: "original",
        activity: "idle",
      },
    });
    expect(updatedBody.record.myTags).toEqual([tag]);
    expect(updatedBody.task).toBeNull();

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${recordId}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: recordId,
      presentation: {
        title: v2Title,
        summary: null,
        source: "original",
      },
      editable: {
        text: v2,
        textVersion: 2,
        myTags: [tag],
      },
      organization: {
        view: "original",
        activity: "idle",
        task: null,
      },
    });
  });
});
