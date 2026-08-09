import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type EndpointTestInput = {
  kind: "text" | "embedding";
  baseUrl: string;
  model: string;
  apiKey: string;
};

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type EvidenceSpan = {
  quote: string;
  start: number;
  end: number;
  sourceTextVersion: number;
};

type UserCorrection = {
  title: string;
  body: string;
  updatedAt: string;
};

type OrganizedItem = {
  id: string;
  title: string;
  body: string;
  publicationStatus: "AUTO_PUBLISHED" | "CONFIRMED";
  usageStatus: "INCLUDED" | "EXCLUDED";
  aiOriginal: { title: string; body: string };
  correction: UserCorrection | null;
  evidenceCount: number;
};

type RecordDetail = {
  editable: { text: string; textVersion: number };
  organizedItems: OrganizedItem[];
  excludedItems: OrganizedItem[];
};

describe("published knowledge correction and reversible exclusion", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const sourceText = "缓存更新后必须主动失效旧值。";
  const aiTitle = "缓存旧值的失效";
  const aiBody = sourceText;
  const correctedTitle = "缓存失效与业务提醒";
  const correctedBody =
    "缓存更新后必须主动失效旧值；这是我的补充判断：同时通知业务观察者。";
  const correctionOnlyTerm = "业务观察者";
  const evidence = {
    quote: sourceText,
    start: 0,
    end: sourceText.length,
    sourceTextVersion: 1,
  };
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );
  const generateAnalysis = vi.fn(async () => ({
    title: "缓存更新与旧值失效",
    summary: sourceText,
    knowledgePoints: [
      {
        title: aiTitle,
        body: aiBody,
        candidateTags: ["缓存一致性"],
        evidenceSpans: [
          { quote: evidence.quote, start: evidence.start, end: evidence.end },
        ],
      },
    ],
  }));

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
      testModelEndpoint,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("overlays and removes a user correction, then excludes and restores that exact point", async () => {
    await activateLocalConfiguration(app);
    expect(testModelEndpoint).toHaveBeenCalledTimes(2);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "缓存管理" }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/records/${recordId}/organize`,
      payload: { handling: "automatic" },
    });

    expect(started.statusCode).toBe(202);

    const taskId = (started.json() as { task: PublicTask }).task.id;

    await waitForSucceededTask(app, taskId);
    expect(generateAnalysis).toHaveBeenCalledTimes(1);

    const initialDetail = await getDetail(app, recordId);

    expect(initialDetail.editable).toMatchObject({
      text: sourceText,
      textVersion: 1,
    });
    expect(initialDetail.organizedItems).toHaveLength(1);
    expect(initialDetail.excludedItems).toEqual([]);

    const item = initialDetail.organizedItems[0];

    if (!item) {
      throw new Error("automatic organization must expose one knowledge point");
    }

    expect(item).toMatchObject({
      title: aiTitle,
      body: aiBody,
      publicationStatus: "AUTO_PUBLISHED",
      usageStatus: "INCLUDED",
      aiOriginal: { title: aiTitle, body: aiBody },
      correction: null,
      evidenceCount: 1,
    });

    const originalEvidence = await getEvidence(app, recordId, item.id);

    expect(originalEvidence).toEqual([evidence]);

    const corrected = await putCorrection(app, recordId, item.id, {
      title: correctedTitle,
      body: correctedBody,
    });

    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toMatchObject({
      item: {
        id: item.id,
        title: correctedTitle,
        body: correctedBody,
        publicationStatus: "CONFIRMED",
        usageStatus: "INCLUDED",
        aiOriginal: { title: aiTitle, body: aiBody },
        correction: {
          title: correctedTitle,
          body: correctedBody,
          updatedAt: expect.any(String),
        },
      },
    });

    const correctedDetail = await getDetail(app, recordId);

    expect(correctedDetail.editable).toMatchObject({
      text: sourceText,
      textVersion: 1,
    });
    expect(correctedDetail.organizedItems[0]).toMatchObject({
      id: item.id,
      title: correctedTitle,
      body: correctedBody,
      publicationStatus: "CONFIRMED",
      usageStatus: "INCLUDED",
      aiOriginal: { title: aiTitle, body: aiBody },
      correction: {
        title: correctedTitle,
        body: correctedBody,
        updatedAt: expect.any(String),
      },
    });
    expect(await searchRecordIds(app, correctionOnlyTerm)).toEqual([recordId]);
    expect(await getEvidence(app, recordId, item.id)).toEqual(originalEvidence);

    const removed = await app.inject({
      method: "DELETE",
      url:
        `/api/v1/records/${recordId}/organized-items/` +
        `${item.id}/correction`,
    });

    expect(removed.statusCode).toBe(204);

    const restoredAiDetail = await getDetail(app, recordId);

    expect(restoredAiDetail.editable.text).toBe(sourceText);
    expect(restoredAiDetail.organizedItems[0]).toMatchObject({
      id: item.id,
      title: aiTitle,
      body: aiBody,
      publicationStatus: "CONFIRMED",
      usageStatus: "INCLUDED",
      aiOriginal: { title: aiTitle, body: aiBody },
      correction: null,
    });
    expect(await searchRecordIds(app, correctionOnlyTerm)).toEqual([]);
    expect(await searchRecordIds(app, aiTitle)).toEqual([recordId]);
    expect(await getEvidence(app, recordId, item.id)).toEqual(originalEvidence);

    const correctedAgain = await putCorrection(app, recordId, item.id, {
      title: correctedTitle,
      body: correctedBody,
    });

    expect(correctedAgain.statusCode).toBe(200);

    const savedCorrection = (
      correctedAgain.json() as { item: OrganizedItem }
    ).item.correction;

    if (!savedCorrection) {
      throw new Error("saving a correction must expose the correction layer");
    }

    expect(savedCorrection).toMatchObject({
      title: correctedTitle,
      body: correctedBody,
      updatedAt: expect.any(String),
    });

    const excluded = await putInclusion(app, recordId, item.id, "excluded");

    expect(excluded.statusCode).toBe(200);
    expect(excluded.json()).toMatchObject({
      item: {
        id: item.id,
        publicationStatus: "CONFIRMED",
        usageStatus: "EXCLUDED",
      },
    });
    expect(await searchRecordIds(app, correctionOnlyTerm)).toEqual([]);

    const excludedDetail = await getDetail(app, recordId);

    expect(excludedDetail.editable).toMatchObject({
      text: sourceText,
      textVersion: 1,
    });
    expect(excludedDetail.organizedItems).toEqual([]);
    expect(excludedDetail.excludedItems).toHaveLength(1);
    expect(excludedDetail.excludedItems[0]).toMatchObject({
      id: item.id,
      title: correctedTitle,
      body: correctedBody,
      publicationStatus: "CONFIRMED",
      usageStatus: "EXCLUDED",
      aiOriginal: { title: aiTitle, body: aiBody },
      correction: savedCorrection,
      evidenceCount: 1,
    });
    expect(await getEvidence(app, recordId, item.id)).toEqual(originalEvidence);

    const included = await putInclusion(app, recordId, item.id, "included");

    expect(included.statusCode).toBe(200);
    expect(included.json()).toMatchObject({
      item: {
        id: item.id,
        publicationStatus: "CONFIRMED",
        usageStatus: "INCLUDED",
      },
    });
    expect(await searchRecordIds(app, correctionOnlyTerm)).toEqual([recordId]);

    const includedDetail = await getDetail(app, recordId);

    expect(includedDetail.editable.text).toBe(sourceText);
    expect(includedDetail.excludedItems).toEqual([]);
    expect(includedDetail.organizedItems[0]).toMatchObject({
      id: item.id,
      title: correctedTitle,
      body: correctedBody,
      publicationStatus: "CONFIRMED",
      usageStatus: "INCLUDED",
      aiOriginal: { title: aiTitle, body: aiBody },
      correction: savedCorrection,
    });
  });
});

async function activateLocalConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://correction-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "correction-text-key",
      },
      embedding: {
        baseUrl: "https://correction-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "correction-embedding-key",
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

    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed in time`);
}

async function getDetail(
  app: FastifyInstance,
  recordId: string,
): Promise<RecordDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as RecordDetail;
}

async function getEvidence(
  app: FastifyInstance,
  recordId: string,
  itemId: string,
): Promise<EvidenceSpan[]> {
  const response = await app.inject({
    method: "GET",
    url:
      `/api/v1/records/${recordId}/organized-items/` + `${itemId}/evidence`,
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as { items: EvidenceSpan[] }).items;
}

async function putCorrection(
  app: FastifyInstance,
  recordId: string,
  itemId: string,
  correction: { title: string; body: string },
) {
  return app.inject({
    method: "PUT",
    url:
      `/api/v1/records/${recordId}/organized-items/` + `${itemId}/correction`,
    payload: correction,
  });
}

async function putInclusion(
  app: FastifyInstance,
  recordId: string,
  itemId: string,
  status: "included" | "excluded",
) {
  return app.inject({
    method: "PUT",
    url:
      `/api/v1/records/${recordId}/organized-items/` + `${itemId}/inclusion`,
    payload: { status },
  });
}

async function searchRecordIds(
  app: FastifyInstance,
  query: string,
): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?${new URLSearchParams({ q: query }).toString()}`,
  });

  expect(response.statusCode).toBe(200);

  const body = response.json() as {
    items: Array<{ record: { id: string } }>;
  };

  return body.items.map((item) => item.record.id);
}
