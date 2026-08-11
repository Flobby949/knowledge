import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AnalysisGenerator } from "../../src/analysis-generator.js";
import { buildApp } from "../../src/app.js";
import type { EmbedText } from "../../src/embedding-provider.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface ConceptDetail {
  activity: Array<{ kind: string; occurredAt: string }>;
  concept: {
    archivedAt: string | null;
    createdAt: string;
    description: string;
    id: string;
    lifecycle: "active" | "archived";
    name: string;
    revisionNumber: number;
    updatedAt: string;
  };
  memberships: Array<{
    createdAt: string;
    id: string;
    needsReview: boolean;
    origin: "user";
    point: {
      body: string;
      current: boolean;
      id: string;
      recordId: string;
      recordTitle: string;
      title: string;
    };
    removedAt: string | null;
    status: "active" | "removed";
  }>;
  revisions: Array<{
    createdAt: string;
    description: string;
    id: string;
    name: string;
    revisionNumber: number;
  }>;
}

interface KnowledgeSource {
  pointId: string;
  recordId: string;
}

describe("V3.0 Concepts", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let firstPointId: string;
  let firstRecordId: string;
  let secondPointId: string;
  let secondRecordId: string;
  let thirdPointId: string;
  let thirdRecordId: string;

  const generateAnalysis = vi.fn<AnalysisGenerator>(async ({ sourceText }) => ({
    title: `${sourceText} 概览`,
    summary: `${sourceText} 的测试摘要。`,
    knowledgePoints: [
      {
        title: `${sourceText} 知识点`,
        body: `${sourceText} 的自包含知识正文。`,
        candidateTags: [`概念来源 ${sourceText}`],
        evidenceSpans: [
          { quote: sourceText, start: 0, end: sourceText.length },
        ],
      },
    ],
  }));
  const embedText = vi.fn<EmbedText>(async () => [1, 0, 0]);
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      generateAnalysis,
      testModelEndpoint,
    });
    await app.ready();
    await activateConfiguration(app);
    const first = await createCurrentKnowledgeSource(app, "事件发布");
    const second = await createCurrentKnowledgeSource(app, "事件订阅");
    const third = await createCurrentKnowledgeSource(app, "事件消费");

    firstPointId = first.pointId;
    firstRecordId = first.recordId;
    secondPointId = second.pointId;
    secondRecordId = second.recordId;
    thirdPointId = third.pointId;
    thirdRecordId = third.recordId;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("creates one revisioned Concept from two current knowledge points", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/concepts",
      payload: {
        name: "事件驱动架构",
        description: "通过事件发布与订阅解耦生产者和消费者。",
        knowledgePointIds: [firstPointId, secondPointId],
      },
    });

    expect(created.statusCode).toBe(201);
    const detail = (created.json() as { detail: ConceptDetail }).detail;

    expect(created.headers.location).toBe(`/api/v1/concepts/${detail.concept.id}`);
    expect(detail.concept).toMatchObject({
      name: "事件驱动架构",
      description: "通过事件发布与订阅解耦生产者和消费者。",
      lifecycle: "active",
      archivedAt: null,
      revisionNumber: 1,
    });
    expect(detail.memberships).toHaveLength(2);
    expect(detail.memberships.map(({ point }) => point.id)).toEqual([
      firstPointId,
      secondPointId,
    ]);
    expect(detail.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          origin: "user",
          status: "active",
          removedAt: null,
          needsReview: false,
          point: expect.objectContaining({ id: firstPointId, current: true }),
        }),
        expect.objectContaining({
          origin: "user",
          status: "active",
          removedAt: null,
          needsReview: false,
          point: expect.objectContaining({ id: secondPointId, current: true }),
        }),
      ]),
    );
    expect(detail.revisions).toEqual([
      expect.objectContaining({
        name: "事件驱动架构",
        description: "通过事件发布与订阅解耦生产者和消费者。",
        revisionNumber: 1,
      }),
    ]);
    expect(detail.activity.map(({ kind }) => kind)).toEqual([
      "created",
      "member_added",
      "member_added",
    ]);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/concepts",
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [
        {
          id: detail.concept.id,
          name: "事件驱动架构",
          description: "通过事件发布与订阅解耦生产者和消费者。",
          lifecycle: "active",
          activeMembershipCount: 2,
          reviewMembershipCount: 0,
        },
      ],
    });

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/concepts/${detail.concept.id}`,
    });

    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { detail: ConceptDetail }).detail).toEqual(detail);
  });

  it("updates the current Concept expression without replacing its identity", async () => {
    const created = await createConcept(app, {
      name: "消息传递",
      description: "描述生产者向消费者传递消息的共同机制。",
      knowledgePointIds: [firstPointId, secondPointId],
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/concepts/${created.concept.id}`,
      payload: {
        name: "异步消息传递",
        description: "通过异步消息连接生产者与消费者，同时保留来源知识。",
      },
    });

    expect(updated.statusCode).toBe(200);
    const detail = (updated.json() as { detail: ConceptDetail }).detail;

    expect(detail.concept).toMatchObject({
      id: created.concept.id,
      name: "异步消息传递",
      description: "通过异步消息连接生产者与消费者，同时保留来源知识。",
      revisionNumber: 2,
    });
    expect(detail.revisions).toEqual([
      expect.objectContaining({
        revisionNumber: 1,
        name: "消息传递",
        description: "描述生产者向消费者传递消息的共同机制。",
      }),
      expect.objectContaining({
        revisionNumber: 2,
        name: "异步消息传递",
        description: "通过异步消息连接生产者与消费者，同时保留来源知识。",
      }),
    ]);
    expect(detail.activity.map(({ kind }) => kind)).toEqual([
      "created",
      "member_added",
      "member_added",
      "updated",
    ]);
  });

  it("adds, removes, and restores stable Memberships without deleting a sparse Concept", async () => {
    const created = await createConcept(app, {
      name: "事件协作链路",
      description: "把事件发布、订阅和消费聚合为一个长期认知节点。",
      knowledgePointIds: [firstPointId, secondPointId],
    });
    const secondMembership = created.memberships.find(
      ({ point }) => point.id === secondPointId,
    );

    if (!secondMembership) {
      throw new Error("Expected the second initial Membership");
    }

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/concepts/${created.concept.id}/memberships`,
      payload: { knowledgePointId: thirdPointId },
    });

    expect(added.statusCode).toBe(201);
    const afterAdd = (added.json() as { detail: ConceptDetail }).detail;
    const thirdMembership = afterAdd.memberships.find(
      ({ point }) => point.id === thirdPointId,
    );

    expect(thirdMembership).toMatchObject({
      origin: "user",
      status: "active",
      removedAt: null,
    });

    if (!thirdMembership) {
      throw new Error("Expected the added Membership");
    }

    for (const membershipId of [secondMembership.id, thirdMembership.id]) {
      const removed = await app.inject({
        method: "DELETE",
        url:
          `/api/v1/concepts/${created.concept.id}/memberships/` +
          membershipId,
      });

      expect(removed.statusCode).toBe(200);
    }

    const sparse = await getConcept(app, created.concept.id);

    expect(sparse.concept.lifecycle).toBe("active");
    expect(sparse.memberships.filter(({ status }) => status === "active")).toHaveLength(
      1,
    );
    expect(sparse.memberships.filter(({ status }) => status === "removed")).toHaveLength(
      2,
    );

    const restored = await app.inject({
      method: "POST",
      url:
        `/api/v1/concepts/${created.concept.id}/memberships/` +
        `${secondMembership.id}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    const detail = (restored.json() as { detail: ConceptDetail }).detail;

    expect(detail.memberships).toContainEqual(
      expect.objectContaining({
        id: secondMembership.id,
        status: "active",
        removedAt: null,
        point: expect.objectContaining({ id: secondPointId }),
      }),
    );
    expect(detail.activity.map(({ kind }) => kind)).toEqual([
      "created",
      "member_added",
      "member_added",
      "member_added",
      "member_removed",
      "member_removed",
      "member_restored",
    ]);
  });

  it("archives and restores a Concept without deleting its revisions or Memberships", async () => {
    const created = await createConcept(app, {
      name: "可恢复认知节点",
      description: "归档只改变默认可见性，不删除来源和历史。",
      knowledgePointIds: [firstPointId, secondPointId],
    });
    const membershipIds = created.memberships.map(({ id }) => id).sort();
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/concepts/${created.concept.id}/archive`,
    });

    expect(archived.statusCode).toBe(200);
    const archivedDetail = (archived.json() as { detail: ConceptDetail }).detail;

    expect(archivedDetail.concept).toMatchObject({
      id: created.concept.id,
      lifecycle: "archived",
      archivedAt: expect.any(String),
    });
    expect(archivedDetail.revisions).toEqual(created.revisions);
    expect(archivedDetail.memberships.map(({ id }) => id).sort()).toEqual(
      membershipIds,
    );

    const activeList = await app.inject({
      method: "GET",
      url: "/api/v1/concepts",
    });
    const archivedList = await app.inject({
      method: "GET",
      url: "/api/v1/concepts?archive=archived",
    });

    expect(
      (activeList.json() as { items: Array<{ id: string }> }).items,
    ).not.toContainEqual(expect.objectContaining({ id: created.concept.id }));
    expect(
      (archivedList.json() as { items: Array<{ id: string }> }).items,
    ).toContainEqual(expect.objectContaining({ id: created.concept.id }));

    const restored = await app.inject({
      method: "POST",
      url: `/api/v1/concepts/${created.concept.id}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    const restoredDetail = (restored.json() as { detail: ConceptDetail }).detail;

    expect(restoredDetail.concept).toMatchObject({
      id: created.concept.id,
      lifecycle: "active",
      archivedAt: null,
    });
    expect(restoredDetail.revisions).toEqual(created.revisions);
    expect(restoredDetail.memberships.map(({ id }) => id).sort()).toEqual(
      membershipIds,
    );
    expect(restoredDetail.activity.map(({ kind }) => kind)).toEqual([
      "created",
      "member_added",
      "member_added",
      "archived",
      "restored",
    ]);

    const permanentDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/concepts/${created.concept.id}`,
    });

    expect(permanentDelete.statusCode).toBe(404);
  });

  it("enforces the Concept creation boundary and keeps its namespace separate from Tag", async () => {
    const insufficient = await app.inject({
      method: "POST",
      url: "/api/v1/concepts",
      payload: {
        name: "成员不足",
        description: "只有一个知识点不能形成 Concept。",
        knowledgePointIds: [firstPointId],
      },
    });

    expect(insufficient.statusCode).toBe(422);

    const tag = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: "共享名称边界" },
    });

    expect(tag.statusCode).toBe(201);

    const concept = await createConcept(app, {
      name: "共享名称边界",
      description: "Concept 与同名 Tag 是不同领域对象。",
      knowledgePointIds: [firstPointId, secondPointId],
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/concepts",
      payload: {
        name: "\u3000共享名称边界\u00a0",
        description: "规范化后同名的 Concept 不允许重复。",
        knowledgePointIds: [firstPointId, secondPointId],
      },
    });

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: {
        code: "CONCEPT_NAME_CONFLICT",
        details: {
          existingConcept: {
            id: concept.concept.id,
            name: "共享名称边界",
          },
        },
      },
    });

    const inactiveSource = await app.inject({
      method: "POST",
      url: "/api/v1/concepts",
      payload: {
        name: "无效来源",
        description: "不存在的知识点不能成为 Concept 来源。",
        knowledgePointIds: [firstPointId, crypto.randomUUID()],
      },
    });

    expect(inactiveSource.statusCode).toBe(409);
    expect(inactiveSource.json()).toMatchObject({
      error: { code: "CONCEPT_POINTS_NOT_CURRENT" },
    });

    const malformedSource = await app.inject({
      method: "POST",
      url: "/api/v1/concepts",
      payload: {
        name: "错误来源格式",
        description: "非 UUID 不能进入数据库查询。",
        knowledgePointIds: [firstPointId, "not-a-uuid"],
      },
    });

    expect(malformedSource.statusCode).toBe(422);

    const malformedConcept = await app.inject({
      method: "GET",
      url: "/api/v1/concepts/not-a-uuid",
    });

    expect(malformedConcept.statusCode).toBe(404);
  });

  it("lists only current knowledge points as Concept membership sources", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/concept-sources?q=事件",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: expect.arrayContaining([
        {
          id: firstPointId,
          title: "事件发布 知识点",
          body: "事件发布 的自包含知识正文。",
          recordId: firstRecordId,
          recordTitle: "事件发布 概览",
        },
        {
          id: secondPointId,
          title: "事件订阅 知识点",
          body: "事件订阅 的自包含知识正文。",
          recordId: secondRecordId,
          recordTitle: "事件订阅 概览",
        },
        {
          id: thirdPointId,
          title: "事件消费 知识点",
          body: "事件消费 的自包含知识正文。",
          recordId: thirdRecordId,
          recordTitle: "事件消费 概览",
        },
      ]),
    });
  });

  it("keeps Membership identity and history when knowledge endpoints stop being current", async () => {
    const created = await createConcept(app, {
      name: "端点变化保留",
      description: "知识来源变化时保留原始归属，只提示用户复核。",
      knowledgePointIds: [firstPointId, secondPointId, thirdPointId],
    });
    const membershipIds = created.memberships.map(({ id }) => id).sort();
    const activity = created.activity;
    const excluded = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${firstRecordId}/organized-items/` +
        `${firstPointId}/inclusion`,
      payload: { status: "excluded" },
    });
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/records/${secondRecordId}/archive`,
    });

    expect(excluded.statusCode).toBe(200);
    expect(archived.statusCode).toBe(200);
    await replaceActiveKnowledge(app, thirdRecordId);

    const detail = await getConcept(app, created.concept.id);

    expect(detail.concept.lifecycle).toBe("active");
    expect(detail.memberships.map(({ id }) => id).sort()).toEqual(membershipIds);
    expect(detail.memberships).toHaveLength(3);
    expect(detail.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "active",
          needsReview: true,
          point: expect.objectContaining({ id: firstPointId, current: false }),
        }),
        expect.objectContaining({
          status: "active",
          needsReview: true,
          point: expect.objectContaining({ id: secondPointId, current: false }),
        }),
        expect.objectContaining({
          status: "active",
          needsReview: true,
          point: expect.objectContaining({ id: thirdPointId, current: false }),
        }),
      ]),
    );
    expect(detail.activity).toEqual(activity);
  });
});

async function createConcept(
  app: FastifyInstance,
  input: { description: string; knowledgePointIds: string[]; name: string },
): Promise<ConceptDetail> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/concepts",
    payload: input,
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { detail: ConceptDetail }).detail;
}

async function getConcept(
  app: FastifyInstance,
  conceptId: string,
): Promise<ConceptDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/concepts/${conceptId}`,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { detail: ConceptDetail }).detail;
}

async function createCurrentKnowledgeSource(
  app: FastifyInstance,
  sourceText: string,
): Promise<KnowledgeSource> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text: sourceText,
      myTags: [{ name: `概念入口 ${sourceText}` }],
      processing: "save_only",
    },
  });

  expect(created.statusCode).toBe(201);
  const recordId = (created.json() as { record: { id: string } }).record.id;
  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  const taskId = (organized.json() as { task: { id: string } }).task.id;

  await waitForTask(app, taskId);

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(detail.statusCode).toBe(200);
  const pointId = (detail.json() as {
    organizedItems: Array<{ id: string }>;
  }).organizedItems[0]?.id;

  if (!pointId) {
    throw new Error("Expected one current knowledge point");
  }

  return { pointId, recordId };
}

async function replaceActiveKnowledge(
  app: FastifyInstance,
  recordId: string,
): Promise<void> {
  const organized = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling: "automatic" },
  });

  expect(organized.statusCode).toBe(202);
  await waitForTask(
    app,
    (organized.json() as { task: { id: string } }).task.id,
  );

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });
  const candidateId = (detail.json() as {
    organization: { candidate?: { id: string } };
  }).organization.candidate?.id;

  if (!candidateId) {
    throw new Error("Expected a reanalysis candidate");
  }

  const adopted = await app.inject({
    method: "POST",
    url:
      `/api/v1/records/${recordId}/organization-candidates/` +
      `${candidateId}/adopt`,
  });

  expect(adopted.statusCode).toBe(200);
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const draft = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/concept-text/v1",
        model: "concept-text",
        apiKey: "concept-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/concept-embedding/v1",
        model: "concept-embedding",
        apiKey: "concept-embedding-key",
      },
    },
  });

  expect(draft.statusCode).toBe(200);

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

async function waitForTask(app: FastifyInstance, taskId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const status = (response.json() as { task: { status: string } }).task.status;

    if (status === "succeeded") {
      return;
    }

    if (status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`AI task ${taskId} did not finish`);
}
