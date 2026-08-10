import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type RequestedTag = { id: string } | { name: string };

type PublicTag = {
  id: string;
  name: string;
  origin: "user_created" | "ai_created";
  approvalStatus: "candidate" | "user_approved" | "archived";
  recordCount: number;
};

type TagDetail = {
  tag: PublicTag;
  records: Array<{
    record: { id: string; title: string };
    sourceSummary: {
      fromMyTags: boolean;
      activeKnowledgePointCount: number;
    };
    knowledgePoints: Array<{
      id: string;
      title: string;
      suppressed: boolean;
    }>;
  }>;
};

type AnalysisPlan = {
  disposableTagName: string;
  sharedTagName: string;
  title: string;
};

const analysisPlans = new Map<string, AnalysisPlan>();
const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
  const plan = analysisPlans.get(sourceText);

  if (!plan) {
    throw new Error(`No deterministic analysis plan for: ${sourceText}`);
  }

  const [firstQuote, secondQuote] = sourceText.split("\n");

  if (!firstQuote || !secondQuote) {
    throw new Error("Tag-management fake analysis requires exactly two lines");
  }

  return {
    title: plan.title,
    summary: `${firstQuote}${secondQuote}`,
    knowledgePoints: [
      {
        title: `${plan.title} · 要点一`,
        body: firstQuote,
        candidateTags: [plan.sharedTagName, plan.disposableTagName],
        evidenceSpans: [spanFor(sourceText, firstQuote)],
      },
      {
        title: `${plan.title} · 要点二`,
        body: secondQuote,
        candidateTags: [plan.sharedTagName],
        evidenceSpans: [spanFor(sourceText, secondQuote)],
      },
    ],
  };
});

describe("V1 tag management public HTTP contract", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;

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
    await activateLocalConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("creates an approved vocabulary tag without inventing a record association", async () => {
    const marker = randomUUID().slice(0, 8);
    const name = `独立标签 ${marker}`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name },
    });

    expect(created.statusCode).toBe(201);

    const body = created.json() as { tag: PublicTag };

    expect(created.headers.location).toBe(`/api/v1/tags/${body.tag.id}`);
    expect(body).toEqual({
      tag: {
        id: expect.any(String),
        name,
        origin: "user_created",
        approvalStatus: "user_approved",
        recordCount: 0,
      },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: `  ${name.toUpperCase()}  ` },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: {
        code: "TAG_NAME_CONFLICT",
        details: { existingTag: { id: body.tag.id, name } },
      },
    });
  });

  it("segments approved and candidate tags with search and stable sorting", async () => {
    const marker = randomUUID().slice(0, 8);
    const popularName = `tag-z-popular-${marker}`;
    const quieterName = `tag-a-quieter-${marker}`;
    const firstRecord = await createRecord(app, `标签排序一 ${marker}`, [
      { name: popularName },
      { name: quieterName },
    ]);
    const popularTag = requiredTag(firstRecord, popularName);

    await createRecord(app, `标签排序二 ${marker}`, [{ id: popularTag.id }]);

    const approved = await getJson<{ items: PublicTag[] }>(
      app,
      `/api/v1/tags?${new URLSearchParams({
        approval: "user_approved",
        q: marker,
        sort: "record_count_desc",
      }).toString()}`,
    );

    expect(approved.items.map(({ name, recordCount }) => [name, recordCount])).toEqual([
      [popularName, 2],
      [quieterName, 1],
    ]);

    const sourceText = `候选排序第一行 ${marker}\n候选排序第二行 ${marker}`;
    const plan = registerAnalysis(sourceText, marker, "candidate-list");

    await createOrganizedRecord(app, sourceText, `整理入口 ${marker}`);

    const candidates = await getJson<{ items: PublicTag[] }>(
      app,
      `/api/v1/tags?${new URLSearchParams({
        approval: "candidate",
        q: marker,
        sort: "name_desc",
      }).toString()}`,
    );

    expect(candidates.items).toEqual([
      expect.objectContaining({
        name: plan.sharedTagName,
        approvalStatus: "candidate",
        origin: "ai_created",
        recordCount: 1,
      }),
      expect.objectContaining({
        name: plan.disposableTagName,
        approvalStatus: "candidate",
        origin: "ai_created",
        recordCount: 1,
      }),
    ]);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/tags?approval=archived&sort=hot",
    });

    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: { code: "TAG_LIBRARY_QUERY_INVALID" },
    });
  });

  it("groups detail by record and exposes user-facing sources without assignment internals", async () => {
    const marker = randomUUID().slice(0, 8);
    const sourceText = `详情聚合第一行 ${marker}\n详情聚合第二行 ${marker}`;
    const plan = registerAnalysis(sourceText, marker, "detail");
    const record = await createOrganizedRecord(
      app,
      sourceText,
      `详情入口 ${marker}`,
    );
    const sharedTag = requiredOrganizedTag(record, plan.sharedTagName);
    const detail = await getJson<TagDetail>(app, `/api/v1/tags/${sharedTag.id}`);

    expect(detail).toEqual({
      tag: {
        id: sharedTag.id,
        name: plan.sharedTagName,
        origin: "ai_created",
        approvalStatus: "candidate",
        recordCount: 1,
      },
      records: [
        {
          record: { id: record.id, title: plan.title },
          sourceSummary: {
            fromMyTags: false,
            activeKnowledgePointCount: 2,
          },
          knowledgePoints: record.organizedItems.map((item) => ({
            id: item.id,
            title: item.title,
            suppressed: false,
          })),
        },
      ],
    });

    const serialized = JSON.stringify(detail);

    expect(serialized).not.toMatch(
      /assignmentId|assignment_id|assignedBy|assigned_by|"ACTIVE"|"SUPPRESSED"/u,
    );
  });

  it("renames approved tags and archives them only when every record keeps another approved user tag", async () => {
    const marker = randomUUID().slice(0, 8);
    const originalName = `待改名 ${marker}`;
    const conflictName = `冲突标签 ${marker}`;
    const solo = await createRecord(app, `归档保护记录 ${marker}`, [
      { name: originalName },
    ]);
    const originalTag = requiredTag(solo, originalName);
    const fallbackRecord = await createRecord(app, `备用标签记录 ${marker}`, [
      { name: conflictName },
    ]);
    const fallbackTag = requiredTag(fallbackRecord, conflictName);

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${originalTag.id}`,
      payload: { name: `  ${conflictName.toUpperCase()}  ` },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: {
        code: "TAG_NAME_CONFLICT",
        details: { existingTag: { id: fallbackTag.id, name: conflictName } },
      },
    });

    const mixedUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${originalTag.id}`,
      payload: { name: `不应采用 ${marker}`, approvalStatus: "archived" },
    });

    expect(mixedUpdate.statusCode).toBe(422);
    expect(mixedUpdate.json()).toMatchObject({
      error: { code: "TAG_UPDATE_INVALID" },
    });

    const renamedName = `明确含义 ${marker}`;
    const renamed = await patchTag(app, originalTag.id, { name: renamedName });

    expect(renamed.tag).toMatchObject({
      id: originalTag.id,
      name: renamedName,
      approvalStatus: "user_approved",
    });

    const blockedArchive = await app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${originalTag.id}`,
      payload: { approvalStatus: "archived" },
    });

    expect(blockedArchive.statusCode).toBe(409);
    expect(blockedArchive.json()).toMatchObject({
      error: { code: "TAG_ARCHIVE_RECORD_TAG_REQUIRED" },
    });

    await updateRecord(app, solo.id, solo.text, [
      { id: originalTag.id },
      { id: fallbackTag.id },
    ]);

    const archived = await patchTag(app, originalTag.id, {
      approvalStatus: "archived",
    });

    expect(archived.tag).toMatchObject({
      id: originalTag.id,
      name: renamedName,
      approvalStatus: "archived",
      recordCount: 0,
    });

    const archivedDetail = await getJson<TagDetail>(
      app,
      `/api/v1/tags/${originalTag.id}`,
    );

    expect(archivedDetail.records).toContainEqual(
      expect.objectContaining({
        record: expect.objectContaining({ id: solo.id }),
        sourceSummary: expect.objectContaining({ fromMyTags: true }),
      }),
    );

    const restored = await patchTag(app, originalTag.id, {
      approvalStatus: "user_approved",
    });

    expect(restored.tag).toMatchObject({
      id: originalTag.id,
      name: renamedName,
      approvalStatus: "user_approved",
      recordCount: 1,
    });
  });

  it("approves a candidate in place and reserves deletion for candidates", async () => {
    const marker = randomUUID().slice(0, 8);
    const sourceText = `候选生命周期第一行 ${marker}\n候选生命周期第二行 ${marker}`;
    const plan = registerAnalysis(sourceText, marker, "lifecycle");
    const record = await createOrganizedRecord(
      app,
      sourceText,
      `候选生命周期入口 ${marker}`,
    );
    const sharedTag = requiredOrganizedTag(record, plan.sharedTagName);
    const disposableTag = requiredOrganizedTag(record, plan.disposableTagName);
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/tags/${sharedTag.id}/approve`,
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      tag: {
        id: sharedTag.id,
        name: plan.sharedTagName,
        origin: "ai_created",
        approvalStatus: "user_approved",
      },
    });

    const approvedDetail = await getJson<TagDetail>(
      app,
      `/api/v1/tags/${sharedTag.id}`,
    );

    expect(approvedDetail.records[0]?.knowledgePoints).toHaveLength(2);

    const approvedDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/tags/${sharedTag.id}`,
    });

    expect(approvedDelete.statusCode).toBe(409);
    expect(approvedDelete.json()).toMatchObject({
      error: { code: "TAG_DELETE_NOT_ALLOWED" },
    });

    const candidateDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/tags/${disposableTag.id}`,
    });

    expect(candidateDelete.statusCode).toBe(204);

    const candidateList = await listTags(app, "candidate", marker);

    expect(candidateList.items.map(({ id }) => id)).not.toContain(
      disposableTag.id,
    );

    const recordAfterDelete = await getRecord(app, record.id);

    expect(
      recordAfterDelete.organizedItems.flatMap((item) => item.tags),
    ).not.toContainEqual(expect.objectContaining({ id: disposableTag.id }));
  });

  it("batch deletes candidate tags atomically", async () => {
    const marker = randomUUID().slice(0, 8);
    const sourceText = `批量清理第一行 ${marker}\n批量清理第二行 ${marker}`;
    const plan = registerAnalysis(sourceText, marker, "batch-delete");
    const entryTagName = `批量清理入口 ${marker}`;
    const record = await createOrganizedRecord(
      app,
      sourceText,
      entryTagName,
    );
    const sharedTag = requiredOrganizedTag(record, plan.sharedTagName);
    const disposableTag = requiredOrganizedTag(record, plan.disposableTagName);
    const approvedTag = (await listTags(app, "user_approved", entryTagName))
      .items[0];

    if (!approvedTag) {
      throw new Error("The organized record must keep its approved entry tag");
    }

    const mixedDelete = await app.inject({
      method: "DELETE",
      url: "/api/v1/tags",
      payload: { ids: [approvedTag.id, sharedTag.id] },
    });

    expect(mixedDelete.statusCode).toBe(409);
    expect(mixedDelete.json()).toMatchObject({
      error: { code: "TAG_DELETE_NOT_ALLOWED" },
    });
    expect((await listTags(app, "candidate", marker)).items).toHaveLength(2);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/tags",
      payload: { ids: [sharedTag.id, disposableTag.id] },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deletedCount: 2 });
    expect((await listTags(app, "candidate", marker)).items).toEqual([]);

    const recordAfterDelete = await getRecord(app, record.id);
    const remainingTagIds = recordAfterDelete.organizedItems.flatMap((item) =>
      item.tags.map(({ id }) => id),
    );

    expect(remainingTagIds).not.toContain(sharedTag.id);
    expect(remainingTagIds).not.toContain(disposableTag.id);

    const emptyDelete = await app.inject({
      method: "DELETE",
      url: "/api/v1/tags",
      payload: { ids: [] },
    });

    expect(emptyDelete.statusCode).toBe(422);
    expect(emptyDelete.json()).toMatchObject({
      error: { code: "TAG_BATCH_DELETE_INVALID" },
    });
  });

  it("suppresses and restores one AI knowledge-point relation while effective search changes immediately", async () => {
    const marker = randomUUID().slice(0, 8);
    const sourceText = `逐条屏蔽第一行 ${marker}\n逐条屏蔽第二行 ${marker}`;
    const plan = registerAnalysis(sourceText, marker, "visibility");
    const record = await createOrganizedRecord(
      app,
      sourceText,
      `逐条屏蔽入口 ${marker}`,
    );
    const unrelatedRecord = await createRecord(
      app,
      `跨记录保护 ${marker}`,
      [{ name: `跨记录保护标签 ${marker}` }],
    );
    const sharedTag = requiredOrganizedTag(record, plan.sharedTagName);
    const [firstPoint, secondPoint] = record.organizedItems;

    if (!firstPoint || !secondPoint) {
      throw new Error("The deterministic analysis must expose two points");
    }

    await expectEffectiveRecords(app, sharedTag.id, [record.id]);
    expect((await listTags(app, "candidate", plan.sharedTagName)).items[0])
      .toMatchObject({ id: sharedTag.id, recordCount: 1 });

    const wrongRecord = await app.inject({
      method: "PUT",
      url:
        `/api/v1/tags/${sharedTag.id}/records/${unrelatedRecord.id}` +
        `/items/${firstPoint.id}/visibility`,
      payload: { status: "suppressed" },
    });

    expect(wrongRecord.statusCode).toBe(404);
    expect(wrongRecord.json()).toMatchObject({
      error: { code: "TAG_ASSOCIATION_NOT_FOUND" },
    });

    await setVisibility(app, sharedTag.id, record.id, firstPoint.id, "suppressed");
    await expectEffectiveRecords(app, sharedTag.id, [record.id]);

    let detail = await getJson<TagDetail>(app, `/api/v1/tags/${sharedTag.id}`);

    expect(detail.records[0]).toMatchObject({
      sourceSummary: { fromMyTags: false, activeKnowledgePointCount: 1 },
      knowledgePoints: [
        { id: firstPoint.id, suppressed: true },
        { id: secondPoint.id, suppressed: false },
      ],
    });

    await setVisibility(app, sharedTag.id, record.id, secondPoint.id, "suppressed");
    await expectEffectiveRecords(app, sharedTag.id, []);
    expect((await listTags(app, "candidate", plan.sharedTagName)).items[0])
      .toMatchObject({ id: sharedTag.id, recordCount: 0 });

    detail = await getJson<TagDetail>(app, `/api/v1/tags/${sharedTag.id}`);
    expect(detail.records[0]).toMatchObject({
      sourceSummary: { fromMyTags: false, activeKnowledgePointCount: 0 },
      knowledgePoints: [
        { id: firstPoint.id, suppressed: true },
        { id: secondPoint.id, suppressed: true },
      ],
    });

    await setVisibility(app, sharedTag.id, record.id, firstPoint.id, "active");
    await expectEffectiveRecords(app, sharedTag.id, [record.id]);

    const restoredDetail = await getJson<TagDetail>(
      app,
      `/api/v1/tags/${sharedTag.id}`,
    );

    expect(restoredDetail.records[0]).toMatchObject({
      sourceSummary: { fromMyTags: false, activeKnowledgePointCount: 1 },
      knowledgePoints: [
        { id: firstPoint.id, suppressed: false },
        { id: secondPoint.id, suppressed: true },
      ],
    });
  });
});

function registerAnalysis(
  sourceText: string,
  marker: string,
  purpose: string,
): AnalysisPlan {
  const plan = {
    disposableTagName: `candidate-a-${purpose}-${marker}`,
    sharedTagName: `candidate-z-${purpose}-${marker}`,
    title: `标签管理 ${purpose} ${marker}`,
  };

  analysisPlans.set(sourceText, plan);

  return plan;
}

async function createRecord(
  app: FastifyInstance,
  text: string,
  myTags: RequestedTag[],
): Promise<{
  id: string;
  myTags: Array<{ id: string; name: string }>;
  text: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: { text, myTags, processing: "save_only" },
  });

  expect(response.statusCode).toBe(201);

  const body = response.json() as {
    record: { id: string; myTags: Array<{ id: string; name: string }> };
  };

  return { ...body.record, text };
}

async function createOrganizedRecord(
  app: FastifyInstance,
  sourceText: string,
  requiredTagName: string,
) {
  const record = await createRecord(app, sourceText, [
    { name: requiredTagName },
  ]);
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/records/${record.id}/organize`,
    payload: { handling: "automatic" },
  });

  expect(started.statusCode).toBe(202);
  await waitForSucceededTask(
    app,
    (started.json() as { task: { id: string } }).task.id,
  );

  return getRecord(app, record.id);
}

async function getRecord(app: FastifyInstance, recordId: string) {
  return getJson<{
    id: string;
    organizedItems: Array<{
      id: string;
      title: string;
      tags: Array<{ id: string; name: string }>;
    }>;
  }>(app, `/api/v1/records/${recordId}`);
}

async function updateRecord(
  app: FastifyInstance,
  recordId: string,
  text: string,
  myTags: RequestedTag[],
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${recordId}`,
    payload: { text, myTags, processing: "save_only" },
  });

  expect(response.statusCode).toBe(200);
}

async function patchTag(
  app: FastifyInstance,
  tagId: string,
  payload: { name: string } | { approvalStatus: "archived" | "user_approved" },
): Promise<{ tag: PublicTag }> {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/tags/${tagId}`,
    payload,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as { tag: PublicTag };
}

async function setVisibility(
  app: FastifyInstance,
  tagId: string,
  recordId: string,
  itemId: string,
  status: "active" | "suppressed",
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url:
      `/api/v1/tags/${tagId}/records/${recordId}` +
      `/items/${itemId}/visibility`,
    payload: { status },
  });

  expect(response.statusCode).toBe(204);
}

async function expectEffectiveRecords(
  app: FastifyInstance,
  tagId: string,
  expectedRecordIds: string[],
): Promise<void> {
  const [related, search] = await Promise.all([
    getJson<{ items: Array<{ id: string }> }>(
      app,
      `/api/v1/tags/${tagId}/records`,
    ),
    getJson<{ items: Array<{ record: { id: string } }> }>(
      app,
      `/api/v1/search?tag=${tagId}`,
    ),
  ]);

  expect(related.items.map(({ id }) => id).sort()).toEqual(
    [...expectedRecordIds].sort(),
  );
  expect(search.items.map(({ record }) => record.id).sort()).toEqual(
    [...expectedRecordIds].sort(),
  );
}

async function listTags(
  app: FastifyInstance,
  approval: "candidate" | "user_approved",
  query: string,
): Promise<{ items: PublicTag[] }> {
  return getJson<{ items: PublicTag[] }>(
    app,
    `/api/v1/tags?${new URLSearchParams({
      approval,
      q: query,
      sort: "name_asc",
    }).toString()}`,
  );
}

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const response = await app.inject({ method: "GET", url });

  expect(response.statusCode).toBe(200);

  return response.json() as T;
}

function requiredTag(
  record: { myTags: Array<{ id: string; name: string }> },
  name: string,
): { id: string; name: string } {
  const tag = record.myTags.find((item) => item.name === name);

  if (!tag) {
    throw new Error(`Expected record tag: ${name}`);
  }

  return tag;
}

function requiredOrganizedTag(
  record: {
    organizedItems: Array<{
      tags: Array<{ id: string; name: string }>;
    }>;
  },
  name: string,
): { id: string; name: string } {
  const tag = record.organizedItems
    .flatMap((item) => item.tags)
    .find((item) => item.name === name);

  if (!tag) {
    throw new Error(`Expected organized-item tag: ${name}`);
  }

  return tag;
}

async function activateLocalConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/tag-management-text/v1",
        model: "tag-management-text-model",
        apiKey: "tag-management-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/tag-management-embedding/v1",
        model: "tag-management-embedding-model",
        apiKey: "tag-management-fake-embedding-key",
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

    const status = (
      response.json() as {
        task: { status: "queued" | "running" | "succeeded" | "failed" };
      }
    ).task.status;

    if (status === "succeeded") {
      return;
    }

    if (status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not finish in time`);
}

function spanFor(sourceText: string, quote: string) {
  const start = sourceText.indexOf(quote);

  if (start < 0) {
    throw new Error(`Quote not found in source text: ${quote}`);
  }

  return { quote, start, end: start + quote.length };
}
