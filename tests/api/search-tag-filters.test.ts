import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

type PublicTag = {
  id: string;
  name: string;
};

type PublicRecord = {
  id: string;
  title: string;
  myTags: PublicTag[];
};

type SearchItem = {
  record: PublicRecord;
  match: {
    reason: string;
    snippets: Array<{ text: string }>;
  };
};

describe("search tag filters public HTTP flow", () => {
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

  it("combines repeated tags with OR, combines text and tags with AND, and returns each record once", async () => {
    const marker = crypto.randomUUID();
    const keyword = `即时关键词-${marker}`;
    const tagAName = `检索标签 A ${marker}`;
    const tagBName = `检索标签 B ${marker}`;
    const first = await createRecord(app, {
      text: `双标签且命中关键词 ${marker}\n${keyword}`,
      myTags: [{ name: tagAName }, { name: tagBName }],
    });
    const tagA = first.myTags.find((tag) => tag.name === tagAName);
    const tagB = first.myTags.find((tag) => tag.name === tagBName);

    if (!tagA || !tagB) {
      throw new Error("created record must return both selected tags");
    }

    const second = await createRecord(app, {
      text: `只命中关键词与标签 B ${marker}\n${keyword}`,
      myTags: [{ id: tagB.id }],
    });
    const third = await createRecord(app, {
      text: `只命中标签 A ${marker}\n正文不包含查询词。`,
      myTags: [{ id: tagA.id }],
    });

    const tagOrSearch = await app.inject({
      method: "GET",
      url: searchUrl({ tagIds: [tagA.id, tagB.id] }),
    });

    expect(tagOrSearch.statusCode).toBe(200);

    const tagOrBody = tagOrSearch.json() as { items: SearchItem[] };
    const tagOrIds = tagOrBody.items.map((item) => item.record.id);

    expect(tagOrIds).toHaveLength(3);
    expect([...new Set(tagOrIds)].sort()).toEqual(
      [first.id, second.id, third.id].sort(),
    );
    expect(tagOrIds.filter((id) => id === first.id)).toHaveLength(1);

    const textAndTagSearch = await app.inject({
      method: "GET",
      url: searchUrl({ query: keyword, tagIds: [tagA.id] }),
    });

    expect(textAndTagSearch.statusCode).toBe(200);

    const textAndTagBody = textAndTagSearch.json() as { items: SearchItem[] };

    expect(textAndTagBody.items.map((item) => item.record.id)).toEqual([
      first.id,
    ]);
    expect(textAndTagBody.items[0]?.match.reason).toBe("original_text");
    expect(
      textAndTagBody.items[0]?.match.snippets.some((snippet) =>
        snippet.text.includes(keyword),
      ),
    ).toBe(true);
  });
});

async function createRecord(
  app: FastifyInstance,
  input: {
    text: string;
    myTags: Array<{ id: string } | { name: string }>;
  },
): Promise<PublicRecord> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      ...input,
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);

  return (response.json() as { record: PublicRecord }).record;
}

function searchUrl(options: { query?: string; tagIds: string[] }): string {
  const search = new URLSearchParams();

  if (options.query) {
    search.set("q", options.query);
  }

  for (const tagId of options.tagIds) {
    search.append("tag", tagId);
  }

  return `/api/v1/search?${search.toString()}`;
}
