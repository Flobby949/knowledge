import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

type TagChip = {
  id: string;
  name: string;
};

type RecordCard = {
  id: string;
  title: string;
  preview: string;
  myTags: TagChip[];
  lifecycle: "active";
  organization: {
    view: "original";
    activity: "idle";
  };
  textVersion: number;
  updatedAt: string;
};

describe("save-only record public HTTP flow", () => {
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

  it("saves original text, lists and opens the record, then finds it immediately by keyword", async () => {
    const marker = `http-tracer-${crypto.randomUUID()}`;
    const title = `CDC 使用日志增量同步 ${marker}。`;
    const text = `${title}\n<b>原样文本</b>  `;
    const tagName = `数据工程 ${marker}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers["content-type"]).toContain("application/json");

    const createdBody = created.json() as {
      record: RecordCard;
      task: null;
    };

    expect(createdBody).toEqual({
      record: {
        id: expect.any(String),
        title,
        preview: text,
        myTags: [
          {
            id: expect.any(String),
            name: tagName,
          },
        ],
        lifecycle: "active",
        organization: {
          view: "original",
          activity: "idle",
        },
        textVersion: 1,
        updatedAt: expect.any(String),
      },
      task: null,
    });

    const { record } = createdBody;
    const [tag] = record.myTags;

    expect(record.id).not.toBe("");
    expect(tag?.id).not.toBe("");
    expect(Number.isNaN(Date.parse(record.updatedAt))).toBe(false);
    expect(created.headers.location).toBe(`/api/v1/records/${record.id}`);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/records",
      query: { q: marker },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [record],
      page: {
        nextCursor: null,
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/records/${record.id}`,
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      id: record.id,
      lifecycle: "active",
      presentation: {
        title,
        summary: null,
        source: "original",
      },
      editable: {
        text,
        textVersion: 1,
        myTags: [tag],
      },
      organization: {
        view: "original",
        activity: "idle",
        task: null,
      },
      organizedItems: [],
      excludedItems: [],
      updatedAt: record.updatedAt,
    });

    const searched = await app.inject({
      method: "GET",
      url: "/api/v1/search",
      query: { q: marker },
    });

    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toEqual({
      items: [
        {
          record,
          match: {
            reason: "original_text",
            snippets: [
              {
                text: title,
                highlights: [
                  {
                    start: title.indexOf(marker),
                    end: title.indexOf(marker) + marker.length,
                  },
                ],
              },
            ],
          },
        },
      ],
      page: {
        nextCursor: null,
      },
    });
  });
});
