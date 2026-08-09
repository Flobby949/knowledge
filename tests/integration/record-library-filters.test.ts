import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type RecordCard = {
  id: string;
  organization: {
    view: "original" | "organized";
    activity: "idle" | "queued" | "running" | "failed";
  };
};

type RecordPage = {
  items: RecordCard[];
  page: { nextCursor: string | null };
};

type LibraryQuery = {
  cursor?: string;
  limit?: string;
  processing?: "saved" | "processing" | "processed" | "failed";
  q?: string;
  sort?: "updated_desc" | "updated_asc";
  tags?: string[];
};

describe("record library filters", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let releaseRunningAnalysis: (() => void) | undefined;

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis: vi.fn(async ({ sourceText }: { sourceText: string }) => {
        if (sourceText.includes("FILTER_RUNNING")) {
          await new Promise<void>((resolve) => {
            releaseRunningAnalysis = resolve;
          });
        }

        if (sourceText.includes("FILTER_FAILED")) {
          throw new Error("deterministic record-library failure");
        }

        return {
          title: `已整理 ${sourceText}`,
          summary: `已整理摘要 ${sourceText}`,
          knowledgePoints: [
            {
              title: "记录库筛选知识点",
              body: sourceText,
              candidateTags: ["记录库筛选"],
              evidenceSpans: [
                { quote: sourceText, start: 0, end: sourceText.length },
              ],
            },
          ],
        };
      }),
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    releaseRunningAnalysis?.();
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("combines explicit text with repeated Tag OR and keeps cursor sort stable", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const sharedQuery = `FILTER_QUERY_${marker}`;
    const first = await createRecord(
      app,
      `${sharedQuery} 第一条可检索内容`,
      { name: `筛选甲 ${marker}` },
    );
    const second = await createRecord(
      app,
      `${sharedQuery} 第二条可检索内容`,
      { name: `筛选乙 ${marker}` },
    );
    const textOnly = await createRecord(
      app,
      `${sharedQuery} 没有选中标签`,
      { name: `筛选丙 ${marker}` },
    );
    await createRecord(app, `不匹配查询 ${marker}`, { id: first.tagId });

    const filtered = await listRecords(app, {
      q: sharedQuery,
      tags: [first.tagId, second.tagId],
    });

    expect(filtered.items.map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(filtered.items).not.toContainEqual(
      expect.objectContaining({ id: textOnly.id }),
    );

    const descending = await listRecords(app, {
      q: sharedQuery,
      sort: "updated_desc",
    });
    const ascending = await listRecords(app, {
      q: sharedQuery,
      sort: "updated_asc",
    });

    expect(ascending.items.map((item) => item.id)).toEqual(
      descending.items.map((item) => item.id).reverse(),
    );

    const firstAscendingPage = await listRecords(app, {
      limit: "1",
      q: sharedQuery,
      sort: "updated_asc",
    });
    const secondAscendingPage = await listRecords(app, {
      cursor: firstAscendingPage.page.nextCursor!,
      limit: "1",
      q: sharedQuery,
      sort: "updated_asc",
    });

    expect(firstAscendingPage.items).toHaveLength(1);
    expect(firstAscendingPage.page.nextCursor).toEqual(expect.any(String));
    expect(secondAscendingPage.items).toHaveLength(1);
    expect(secondAscendingPage.items[0]?.id).not.toBe(
      firstAscendingPage.items[0]?.id,
    );
  });

  it("maps processing filters from the same observable view and activity as detail", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const sharedQuery = `FILTER_STATE_${marker}`;
    const saved = await createRecord(
      app,
      `${sharedQuery} SAVED`,
      { name: `状态筛选 ${marker}` },
    );
    const processed = await createRecord(
      app,
      `${sharedQuery} PROCESSED`,
      { id: saved.tagId },
    );
    const running = await createRecord(
      app,
      `${sharedQuery} FILTER_RUNNING`,
      { id: saved.tagId },
    );
    const failed = await createRecord(
      app,
      `${sharedQuery} FILTER_FAILED`,
      { id: saved.tagId },
    );

    const processedTask = await organizeRecord(app, processed.id);
    await waitForTask(app, processedTask, "succeeded");
    const runningTask = await organizeRecord(app, running.id);
    await waitForTask(app, runningTask, "running");
    const failedTask = await organizeRecord(app, failed.id);
    await waitForTask(app, failedTask, "failed");

    try {
      await expectOnlyRecord(app, sharedQuery, "saved", saved.id);
      await expectOnlyRecord(app, sharedQuery, "processing", running.id);
      await expectOnlyRecord(app, sharedQuery, "processed", processed.id);
      await expectOnlyRecord(app, sharedQuery, "failed", failed.id);

      for (const query of [
        "processing=internal_task_status",
        "sort=random",
        "tag=not-a-uuid",
      ]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/records?${query}`,
        });

        expect(response.statusCode).toBe(422);
      }
    } finally {
      releaseRunningAnalysis?.();
      await waitForTask(app, runningTask, "succeeded");
    }
  });
});

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/api/v1/model-config/draft",
        payload: {
          text: {
            baseUrl: "https://record-filter-text.invalid/v1",
            model: "deepseek-v4-flash",
            apiKey: "local-text-key",
          },
          embedding: {
            baseUrl: "https://record-filter-embedding.invalid/v1",
            model: "BAAI/bge-m3",
            apiKey: "local-embedding-key",
          },
        },
      })
    ).statusCode,
  ).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/model-config/draft/tests/${kind}`,
        })
      ).statusCode,
    ).toBe(200);
  }

  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/model-config/draft/activate",
      })
    ).statusCode,
  ).toBe(200);
}

async function createRecord(
  app: FastifyInstance,
  text: string,
  tag: { id: string } | { name: string },
): Promise<{ id: string; tagId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [tag],
      processing: "save_only",
    },
  });
  expect(response.statusCode).toBe(201);

  const record = (response.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;

  return { id: record.id, tagId: record.myTags[0]!.id };
}

async function organizeRecord(
  app: FastifyInstance,
  recordId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });
  expect(response.statusCode).toBe(202);

  return (response.json() as { task: { id: string } }).task.id;
}

async function waitForTask(
  app: FastifyInstance,
  taskId: string,
  expected: "running" | "succeeded" | "failed",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    expect(response.statusCode).toBe(200);

    const status = (response.json() as { task: { status: string } }).task.status;

    if (status === expected) {
      return;
    }

    if (status === "failed" || status === "succeeded") {
      throw new Error(`AI task ${taskId} reached ${status}, expected ${expected}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not reach ${expected}`);
}

async function expectOnlyRecord(
  app: FastifyInstance,
  q: string,
  processing: NonNullable<LibraryQuery["processing"]>,
  recordId: string,
): Promise<void> {
  const page = await listRecords(app, { processing, q });

  expect(page.items).toEqual([expect.objectContaining({ id: recordId })]);
}

async function listRecords(
  app: FastifyInstance,
  query: LibraryQuery,
): Promise<RecordPage> {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append("tag", item);
      }
    } else if (value !== undefined) {
      search.set(key, value);
    }
  }

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records?${search.toString()}`,
  });
  expect(response.statusCode).toBe(200);

  return response.json() as RecordPage;
}
