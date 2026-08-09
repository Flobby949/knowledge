import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AnalysisGenerator,
  GeneratedAnalysis,
} from "../../src/analysis-generator.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type PublicTag = {
  id: string;
  name: string;
};

type TagFieldItem = PublicTag & {
  approval: "approved" | "candidate";
  recordCount: number;
};

describe("permanent record deletion", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;

  const targetSource = "永久删除目标原文，用于并发删除与证据验证。";
  const sharedSource = "共享候选标签仍被另一条记录的知识点使用。";
  const targetUserTag = "永久删除后保留的用户标签";
  const sharedUserTag = "共享记录入口标签";
  const orphanCandidateName = "删除后无关联的候选标签";
  const sharedCandidateName = "删除后仍有关联的候选标签";
  const correctionOnlyTerm = "删除级联修正标记";
  const semanticOnlyQuery = "语义向量删除验证查询";
  const lateAnalysis = analysisFor(targetSource, ["迟到结果候选标签"]);
  const releaseLateAnalysis = deferred<GeneratedAnalysis>();
  const lateGenerationStarted = deferred<void>();
  const lateGeneratorReturned = deferred<void>();
  let targetGenerationCount = 0;

  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => {
    if (sourceText === sharedSource) {
      return analysisFor(sharedSource, [sharedCandidateName]);
    }

    if (sourceText !== targetSource) {
      throw new Error(`Unexpected test source: ${sourceText}`);
    }

    targetGenerationCount += 1;

    if (targetGenerationCount === 1) {
      return analysisFor(targetSource, [
        orphanCandidateName,
        sharedCandidateName,
      ]);
    }

    lateGenerationStarted.resolve();
    const result = await releaseLateAnalysis.promise;
    lateGeneratorReturned.resolve();
    return result;
  });
  const embedText = vi.fn<EmbedText>(async (input) => {
    if (input.purpose === "query" && input.text === semanticOnlyQuery) {
      return [1, 0, 0];
    }

    if (
      input.purpose === "document" &&
      (input.text.includes(targetSource) ||
        input.text.includes(correctionOnlyTerm))
    ) {
      return [1, 0, 0];
    }

    return [0, 1, 0];
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      testModelEndpoint,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    releaseLateAnalysis.resolve(lateAnalysis);
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("deletes a running record destructively while retaining only reusable tags", async () => {
    const configurationVersion = await activateLocalConfiguration(app);

    const target = await createRecord(app, targetSource, targetUserTag);
    const shared = await createRecord(app, sharedSource, sharedUserTag);

    await organizeAndWait(app, target.id);
    await organizeAndWait(app, shared.id);

    const targetDetail = await getJson<{
      organizedItems: Array<{
        id: string;
        tags: PublicTag[];
        evidenceCount: number;
      }>;
    }>(app, `/api/v1/records/${target.id}`);
    const targetPoint = targetDetail.organizedItems[0];

    if (!targetPoint) {
      throw new Error("target record must expose its generated knowledge point");
    }

    expect(targetPoint.evidenceCount).toBe(1);

    const orphanCandidate = targetPoint.tags.find(
      (tag) => tag.name === orphanCandidateName,
    );
    const sharedCandidate = targetPoint.tags.find(
      (tag) => tag.name === sharedCandidateName,
    );

    if (!orphanCandidate || !sharedCandidate) {
      throw new Error("target record must expose both candidate tag identities");
    }

    const corrected = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${target.id}/organized-items/` +
        `${targetPoint.id}/correction`,
      payload: {
        title: correctionOnlyTerm,
        body: `${targetSource} ${correctionOnlyTerm}只在删除前可检索。`,
      },
    });

    expect(corrected.statusCode).toBe(200);

    const evidenceBeforeDelete = await app.inject({
      method: "GET",
      url:
        `/api/v1/records/${target.id}/organized-items/` +
        `${targetPoint.id}/evidence`,
    });

    expect(evidenceBeforeDelete.statusCode).toBe(200);
    expect(evidenceBeforeDelete.json()).toEqual({
      items: [
        {
          quote: targetSource,
          start: 0,
          end: targetSource.length,
          sourceTextVersion: 1,
        },
      ],
    });
    expect(await searchRecordIds(app, correctionOnlyTerm)).toContain(target.id);

    const tagFieldBeforeDelete = await getTagField(app);

    expect(tagFieldBeforeDelete).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: orphanCandidate.id,
          approval: "candidate",
          recordCount: 1,
        }),
        expect.objectContaining({
          id: sharedCandidate.id,
          approval: "candidate",
          recordCount: 2,
        }),
      ]),
    );
    expect(
      await searchRecordIdsByTag(app, sharedCandidate.id),
    ).toEqual(expect.arrayContaining([target.id, shared.id]));

    await triggerSemanticRebuild(app);
    await waitForSemanticHealth(app, {
      configurationVersion,
      readyDocuments: 6,
      totalDocuments: 6,
    });
    expect(await searchRecordIds(app, semanticOnlyQuery)).toEqual([target.id]);

    const runningTask = await startOrganization(app, target.id);

    await lateGenerationStarted.promise;
    await waitForTaskStatus(app, runningTask.id, "running");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/records/${target.id}`,
    });

    expect(deleted.statusCode).toBe(204);

    const taskImmediatelyAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${runningTask.id}`,
    });
    const detailImmediatelyAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/records/${target.id}`,
    });
    const evidenceAfterDelete = await app.inject({
      method: "GET",
      url:
        `/api/v1/records/${target.id}/organized-items/` +
        `${targetPoint.id}/evidence`,
    });

    releaseLateAnalysis.resolve(lateAnalysis);
    await lateGeneratorReturned.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const detailAfterLateResult = await app.inject({
      method: "GET",
      url: `/api/v1/records/${target.id}`,
    });
    const historyAfterLateResult = await app.inject({
      method: "GET",
      url: `/api/v1/records/${target.id}/history`,
    });
    const taskAfterLateResult = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${runningTask.id}`,
    });
    const recordList = await getJson<{ items: Array<{ id: string }> }>(
      app,
      "/api/v1/records",
    );

    expect(taskImmediatelyAfterDelete.statusCode).toBe(404);
    expect(detailImmediatelyAfterDelete.statusCode).toBe(404);
    expect(evidenceAfterDelete.statusCode).toBe(404);
    expect(detailAfterLateResult.statusCode).toBe(404);
    expect(historyAfterLateResult.statusCode).toBe(404);
    expect(taskAfterLateResult.statusCode).toBe(404);
    expect(recordList.items.map(({ id }) => id)).not.toContain(target.id);
    expect(await searchRecordIds(app, targetSource)).not.toContain(target.id);
    expect(await searchRecordIds(app, correctionOnlyTerm)).not.toContain(
      target.id,
    );
    expect(await searchRecordIds(app, semanticOnlyQuery)).not.toContain(
      target.id,
    );
    expect(await searchRecordIdsByTag(app, orphanCandidate.id)).toEqual([]);

    await waitForSemanticHealth(app, {
      configurationVersion,
      readyDocuments: 3,
      totalDocuments: 3,
    });

    const tagFieldAfterDelete = await getTagField(app);

    expect(
      tagFieldAfterDelete.some(({ id }) => id === orphanCandidate.id),
    ).toBe(false);
    expect(tagFieldAfterDelete).toContainEqual({
      id: sharedCandidate.id,
      name: sharedCandidateName,
      approval: "candidate",
      recordCount: 1,
    });
    expect(await searchRecordIdsByTag(app, sharedCandidate.id)).toEqual([
      shared.id,
    ]);

    const retainedUserTags = await getJson<{
      items: Array<{ id: string; name: string; recordCount: number }>;
    }>(
      app,
      `/api/v1/tags?${new URLSearchParams({ q: targetUserTag }).toString()}`,
    );

    expect(retainedUserTags.items).toContainEqual(
      expect.objectContaining({
        id: target.myTags[0]?.id,
        name: targetUserTag,
        recordCount: 0,
      }),
    );
    expect(generateAnalysis).toHaveBeenCalledTimes(3);
  }, 30_000);
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<{ id: string; myTags: PublicTag[] }> {
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

  return (response.json() as { record: { id: string; myTags: PublicTag[] } })
    .record;
}

async function organizeAndWait(
  app: FastifyInstance,
  recordId: string,
): Promise<void> {
  const task = await startOrganization(app, recordId);
  await waitForTaskStatus(app, task.id, "succeeded");
}

async function startOrganization(
  app: FastifyInstance,
  recordId: string,
): Promise<PublicTask> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(response.statusCode).toBe(202);
  return (response.json() as { task: PublicTask }).task;
}

async function waitForTaskStatus(
  app: FastifyInstance,
  taskId: string,
  expected: "running" | "succeeded",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });

    expect(response.statusCode).toBe(200);

    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === expected) {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not become ${expected}`);
}

async function triggerSemanticRebuild(app: FastifyInstance): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/search-index/rebuild",
  });

  expect(response.statusCode).toBe(202);
}

async function waitForSemanticHealth(
  app: FastifyInstance,
  expected: {
    configurationVersion: number;
    readyDocuments: number;
    totalDocuments: number;
  },
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await getJson<{
      semantic: {
        status: string;
        configurationVersion: number;
        readyDocuments: number;
        totalDocuments: number;
      };
    }>(app, "/api/v1/search-health");

    if (
      health.semantic.configurationVersion === expected.configurationVersion &&
      health.semantic.readyDocuments === expected.readyDocuments &&
      health.semantic.totalDocuments === expected.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `semantic health did not become ${expected.readyDocuments}/${expected.totalDocuments}`,
  );
}

async function getTagField(app: FastifyInstance): Promise<TagFieldItem[]> {
  return (
    await getJson<{ items: TagFieldItem[] }>(app, "/api/v1/tag-field")
  ).items;
}

async function searchRecordIds(
  app: FastifyInstance,
  query: string,
): Promise<string[]> {
  const result = await getJson<{ items: Array<{ record: { id: string } }> }>(
    app,
    `/api/v1/search?${new URLSearchParams({ q: query }).toString()}`,
  );

  return result.items.map(({ record }) => record.id);
}

async function searchRecordIdsByTag(
  app: FastifyInstance,
  tagId: string,
): Promise<string[]> {
  const result = await getJson<{ items: Array<{ record: { id: string } }> }>(
    app,
    `/api/v1/search?${new URLSearchParams({ tag: tagId }).toString()}`,
  );

  return result.items.map(({ record }) => record.id).sort();
}

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const response = await app.inject({ method: "GET", url });

  expect(response.statusCode).toBe(200);
  return response.json() as T;
}

async function activateLocalConfiguration(app: FastifyInstance): Promise<number> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://permanent-delete-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "local-delete-text-key",
      },
      embedding: {
        baseUrl: "https://permanent-delete-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "local-delete-embedding-key",
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
  return (activated.json() as { active: { version: number } }).active.version;
}

function analysisFor(sourceText: string, candidateTags: string[]): GeneratedAnalysis {
  return {
    title: "永久删除并发边界",
    summary: sourceText,
    knowledgePoints: [
      {
        title: "永久删除应阻止迟到回写",
        body: sourceText,
        candidateTags,
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}
