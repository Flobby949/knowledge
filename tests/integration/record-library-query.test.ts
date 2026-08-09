import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type RecordCard = {
  id: string;
  title: string;
  preview: string;
  lifecycle: "active" | "archived";
  organization: {
    view: "original" | "organized";
    activity: "idle" | "queued" | "running" | "failed";
  };
};

type RecordPage = {
  items: RecordCard[];
  page: { nextCursor: string | null };
};

describe("record library query", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const aiTitle = "AI 生效后的记录标题";
  const aiSummary = "这是当前生效整理的摘要，记录库不再用原文片段冒充摘要。";

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis: vi.fn(async ({ sourceText }: { sourceText: string }) => ({
        title: aiTitle,
        summary: aiSummary,
        knowledgePoints: [
          {
            title: "记录库卡片的有效内容",
            body: sourceText,
            candidateTags: ["记录库"],
            evidenceSpans: [
              { quote: sourceText, start: 0, end: sourceText.length },
            ],
          },
        ],
      })),
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("uses effective cards, honors archive scope, and pages with an opaque cursor", async () => {
    await activateConfiguration(app);

    const archivedId = await createRecord(
      app,
      "归档记录原文标题\n这条记录只应出现在归档范围。",
      "归档范围",
    );
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/records/${archivedId}/archive`,
    });
    expect(archived.statusCode).toBe(200);

    const savedId = await createRecord(
      app,
      "仅保存记录原文标题\n这条记录没有 AI 整理。",
      "仅保存",
    );
    const organizedId = await createRecord(
      app,
      "不得出现在生效卡片上的旧原文标题。",
      "已整理",
    );
    const organized = await app.inject({
      method: "POST",
      url: `/api/v1/records/${organizedId}/organize`,
      payload: { handling: "automatic" },
    });
    expect(organized.statusCode).toBe(202);
    await waitForSucceededTask(
      app,
      (organized.json() as { task: { id: string } }).task.id,
    );

    const active = await listRecords(app);

    expect(active.items.map((item) => item.id).sort()).toEqual(
      [organizedId, savedId].sort(),
    );
    expect(active.items).not.toContainEqual(
      expect.objectContaining({ id: archivedId }),
    );
    expect(active.items.find((item) => item.id === organizedId)).toMatchObject({
      id: organizedId,
      title: aiTitle,
      preview: aiSummary,
      lifecycle: "active",
      organization: { view: "organized", activity: "idle" },
    });
    expect(active.items.find((item) => item.id === savedId)).toMatchObject({
      id: savedId,
      title: "仅保存记录原文标题",
      lifecycle: "active",
      organization: { view: "original", activity: "idle" },
    });

    const archivedOnly = await listRecords(app, { archive: "archived" });

    expect(archivedOnly.items).toEqual([
      expect.objectContaining({ id: archivedId, lifecycle: "archived" }),
    ]);

    const all = await listRecords(app, { archive: "all" });

    expect(all.items.map((item) => item.id).sort()).toEqual(
      [archivedId, organizedId, savedId].sort(),
    );

    const firstPage = await listRecords(app, { limit: "1" });

    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));

    const secondPage = await listRecords(app, {
      limit: "1",
      cursor: firstPage.page.nextCursor!,
    });

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.page.nextCursor).toBeNull();
  });
});

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://record-library-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-text-key",
      },
      embedding: {
        baseUrl: "https://record-library-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "local-embedding-key",
      },
    },
  });
  expect(saved.statusCode).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    const tested = await app.inject({
      method: "POST",
      url: `/api/v1/model-config/draft/tests/${kind}`,
    });
    expect(tested.statusCode).toBe(200);
  }

  const activated = await app.inject({
    method: "POST",
    url: "/api/v1/model-config/draft/activate",
  });
  expect(activated.statusCode).toBe(200);
}

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });
  expect(response.statusCode).toBe(201);

  return (response.json() as { record: { id: string } }).record.id;
}

async function waitForSucceededTask(
  app: FastifyInstance,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    expect(response.statusCode).toBe(200);

    if (
      (response.json() as { task: { status: string } }).task.status ===
      "succeeded"
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed`);
}

async function listRecords(
  app: FastifyInstance,
  query: Record<string, string> = {},
): Promise<RecordPage> {
  const search = new URLSearchParams(query);
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records${search.size ? `?${search.toString()}` : ""}`,
  });
  expect(response.statusCode).toBe(200);

  return response.json() as RecordPage;
}
