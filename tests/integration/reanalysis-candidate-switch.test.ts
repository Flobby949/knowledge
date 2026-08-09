import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type PublicTask = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type GeneratedAnalysis = {
  title: string;
  summary: string;
  knowledgePoints: Array<{
    title: string;
    body: string;
    candidateTags: string[];
    evidenceSpans: Array<{
      quote: string;
      start: number;
      end: number;
    }>;
  }>;
};

const sourceTextForAnalysis = "数据库变更会被依次记录，并可靠地送往下游。";

describe("same-source reanalysis candidate lifecycle", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const sourceText = "数据库变更会被依次记录，并可靠地送往下游。";
  const analyses = [
    analysis("初始整理标题", "初始生效知识", "最初的整理结果。"),
    analysis("候选分析标题", "候选版本知识", "重新分析得到的新结果。"),
    analysis("丢弃分析标题", "应被丢弃知识", "不应生效的整理结果。"),
  ];
  const generateAnalysis = vi.fn(async (): Promise<GeneratedAnalysis> => {
    const generated = analyses[generateAnalysis.mock.calls.length - 1];

    if (!generated) {
      throw new Error("unexpected analysis generation call");
    }

    return generated;
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      credentialEncryptionKey: "reanalysis-test-secret",
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("keeps current knowledge active until a same-source candidate is adopted, and preserves it when the next candidate is discarded", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "重新整理测试" }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;

    await organizeAndWait(app, recordId);

    const initialDetail = await getDetail(app, recordId);

    expect(initialDetail.presentation.title).toBe("初始整理标题");
    expect(initialDetail.organizedItems).toEqual([
      expect.objectContaining({
        title: "初始生效知识",
        publicationStatus: "AUTO_PUBLISHED",
      }),
    ]);

    await organizeAndWait(app, recordId);

    const pendingDetail = await getDetail(app, recordId);

    expect(pendingDetail.presentation.title).toBe("初始整理标题");
    expect(pendingDetail.organizedItems[0]?.title).toBe("初始生效知识");
    expect(pendingDetail.organization.candidate).toMatchObject({
      id: expect.any(String),
      reason: "reanalysis",
      sourceTextVersion: 1,
      presentation: {
        title: "候选分析标题",
        summary: "重新分析得到的新结果。",
      },
      organizedItems: [
        expect.objectContaining({
          title: "候选版本知识",
          publicationStatus: "AI_CREATED",
          usageStatus: "INCLUDED",
        }),
      ],
    });

    const firstCandidateId = pendingDetail.organization.candidate?.id;

    if (!firstCandidateId) {
      throw new Error("reanalysis must expose an organization candidate");
    }

    await expectSearch(app, "初始生效知识", [recordId]);
    await expectSearch(app, "候选版本知识", []);

    const historyBeforeAdopt = await getHistory(app, recordId);

    expect(historyBeforeAdopt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "organization", status: "ACTIVE" }),
        expect.objectContaining({
          id: firstCandidateId,
          type: "organization",
          status: "GENERATED",
        }),
      ]),
    );

    const adopted = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${recordId}/organization-candidates/` +
        `${firstCandidateId}/adopt`,
    });

    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toEqual({
      candidate: { id: firstCandidateId, status: "adopted" },
    });

    const adoptedDetail = await getDetail(app, recordId);

    expect(adoptedDetail.presentation.title).toBe("候选分析标题");
    expect(adoptedDetail.organization.candidate).toBeUndefined();
    expect(adoptedDetail.organizedItems).toEqual([
      expect.objectContaining({
        title: "候选版本知识",
        publicationStatus: "CONFIRMED",
      }),
    ]);
    await expectSearch(app, "初始生效知识", []);
    await expectSearch(app, "候选版本知识", [recordId]);

    await organizeAndWait(app, recordId);

    const discardDetail = await getDetail(app, recordId);
    const discardCandidateId = discardDetail.organization.candidate?.id;

    expect(discardDetail.presentation.title).toBe("候选分析标题");
    expect(discardDetail.organization.candidate).toMatchObject({
      id: expect.any(String),
      reason: "reanalysis",
      presentation: { title: "丢弃分析标题" },
    });

    if (!discardCandidateId) {
      throw new Error("the next reanalysis must expose a candidate");
    }

    const discarded = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${recordId}/organization-candidates/` +
        `${discardCandidateId}/discard`,
    });

    expect(discarded.statusCode).toBe(200);
    expect(discarded.json()).toEqual({
      candidate: { id: discardCandidateId, status: "discarded" },
    });

    const finalDetail = await getDetail(app, recordId);

    expect(finalDetail.presentation.title).toBe("候选分析标题");
    expect(finalDetail.organization.candidate).toBeUndefined();
    expect(finalDetail.organizedItems[0]?.title).toBe("候选版本知识");
    await expectSearch(app, "候选版本知识", [recordId]);
    await expectSearch(app, "应被丢弃知识", []);

    const finalHistory = await getHistory(app, recordId);

    expect(finalHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstCandidateId,
          type: "organization",
          status: "ACTIVE",
          isCurrent: true,
        }),
        expect.objectContaining({
          id: discardCandidateId,
          type: "organization",
          status: "DISCARDED",
          isCurrent: false,
        }),
      ]),
    );
    expect(generateAnalysis).toHaveBeenCalledTimes(3);
  });
});

describe("source-updated analysis switch rules", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const scenarios = {
    automaticOld: "甲记录的旧原文。",
    automaticNew: "甲记录的新原文。",
    reviewOld: "乙记录的旧原文。",
    reviewNew: "乙记录的新原文。",
    correctedOld: "丙记录的旧原文。",
    correctedNew: "丙记录的新原文。",
  } as const;
  const generatedBySource = new Map<string, GeneratedAnalysis>([
    [
      scenarios.automaticOld,
      sourceAnalysis(scenarios.automaticOld, "甲旧知识唯一词"),
    ],
    [
      scenarios.automaticNew,
      sourceAnalysis(scenarios.automaticNew, "甲新知识唯一词"),
    ],
    [scenarios.reviewOld, sourceAnalysis(scenarios.reviewOld, "乙旧知识唯一词")],
    [scenarios.reviewNew, sourceAnalysis(scenarios.reviewNew, "乙新知识唯一词")],
    [
      scenarios.correctedOld,
      sourceAnalysis(scenarios.correctedOld, "丙旧 AI 知识唯一词"),
    ],
    [
      scenarios.correctedNew,
      sourceAnalysis(scenarios.correctedNew, "丙新知识唯一词"),
    ],
  ]);
  const generateAnalysis = vi.fn(
    async (input: { sourceText: string }): Promise<GeneratedAnalysis> => {
      const generated = generatedBySource.get(input.sourceText);

      if (!generated) {
        throw new Error(`unexpected source text: ${input.sourceText}`);
      }

      return generated;
    },
  );

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      credentialEncryptionKey: "source-updated-test-secret",
      databaseUrl: database.databaseUrl,
      embedText: async ({ purpose }) =>
        purpose === "document" ? [1, 0, 0] : [0, 1, 0],
      generateAnalysis,
      testModelEndpoint: async () => ({ status: "passed" }),
    });
    await app.ready();
    await activateConfiguration(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("switches an uncorrected automatic edit, but makes review and corrected edits whole-version candidates", async () => {
    const automatic = await createRecord(
      app,
      scenarios.automaticOld,
      "自动切换测试",
    );
    await organizeAndWait(app, automatic.id);
    await updateRecord(app, automatic, scenarios.automaticNew);
    await organizeAndWait(app, automatic.id);

    const automaticDetail = await getDetail(app, automatic.id);

    expect(automaticDetail.presentation.title).toBe("甲新知识唯一词");
    expect(automaticDetail.organization.candidate).toBeUndefined();
    expect(automaticDetail.organizedItems).toEqual([
      expect.objectContaining({
        title: "甲新知识唯一词",
        publicationStatus: "AUTO_PUBLISHED",
      }),
    ]);
    await expectSearch(app, "甲旧知识唯一词", []);
    await expectSearch(app, "甲新知识唯一词", [automatic.id]);

    const reviewed = await createRecord(app, scenarios.reviewOld, "整版审查测试");
    await organizeAndWait(app, reviewed.id);
    await updateRecord(app, reviewed, scenarios.reviewNew);
    await organizeAndWait(app, reviewed.id, "review");

    const reviewDetail = await getDetail(app, reviewed.id);

    expect(reviewDetail.presentation.title).toBe("乙旧知识唯一词");
    expect(reviewDetail.organization.candidate).toMatchObject({
      reason: "source_updated",
      sourceTextVersion: 2,
      presentation: { title: "乙新知识唯一词" },
      organizedItems: [
        expect.objectContaining({
          title: "乙新知识唯一词",
          publicationStatus: "AI_CREATED",
        }),
      ],
    });
    await expectSearch(app, "乙旧知识唯一词", [reviewed.id]);
    await expectSearch(app, "乙新知识唯一词", []);

    const queue = await app.inject({ method: "GET", url: "/api/v1/review-queue" });

    expect(queue.statusCode).toBe(200);
    expect(queue.json()).toEqual({ items: [], page: { nextCursor: null } });

    const corrected = await createRecord(
      app,
      scenarios.correctedOld,
      "修正保护测试",
    );
    await organizeAndWait(app, corrected.id);
    const correctedBeforeEdit = await getDetail(app, corrected.id);
    const correctedItemId = correctedBeforeEdit.organizedItems[0]?.id;

    if (!correctedItemId) {
      throw new Error("the active analysis must expose a knowledge point");
    }

    const correctionOnlyTerm = "用户保留判断唯一词";
    const correction = await app.inject({
      method: "PUT",
      url:
        `/api/v1/records/${corrected.id}/organized-items/` +
        `${correctedItemId}/correction`,
      payload: {
        title: correctionOnlyTerm,
        body: `${correctionOnlyTerm}，这是用户明确保留的判断。`,
      },
    });

    expect(correction.statusCode).toBe(200);
    await updateRecord(app, corrected, scenarios.correctedNew);
    await organizeAndWait(app, corrected.id, "automatic");

    const protectedDetail = await getDetail(app, corrected.id);
    const protectedCandidate = protectedDetail.organization.candidate;

    expect(protectedDetail.presentation.title).toBe("丙旧 AI 知识唯一词");
    expect(protectedDetail.organizedItems[0]).toMatchObject({
      id: correctedItemId,
      title: correctionOnlyTerm,
      publicationStatus: "CONFIRMED",
      correction: expect.objectContaining({ title: correctionOnlyTerm }),
    });
    expect(protectedCandidate).toMatchObject({
      reason: "source_updated",
      sourceTextVersion: 2,
      presentation: { title: "丙新知识唯一词" },
      organizedItems: [
        expect.objectContaining({
          title: "丙新知识唯一词",
          publicationStatus: "AI_CREATED",
        }),
      ],
    });
    await expectSearch(app, correctionOnlyTerm, [corrected.id]);
    await expectSearch(app, "丙新知识唯一词", []);

    const protectedCandidateId = protectedCandidate?.id;

    if (!protectedCandidateId) {
      throw new Error("the corrected active version must force a candidate");
    }

    const adopted = await app.inject({
      method: "POST",
      url:
        `/api/v1/records/${corrected.id}/organization-candidates/` +
        `${protectedCandidateId}/adopt`,
    });

    expect(adopted.statusCode).toBe(200);
    await expectSearch(app, correctionOnlyTerm, []);
    await expectSearch(app, "丙新知识唯一词", [corrected.id]);
    expect(generateAnalysis).toHaveBeenCalledTimes(6);
  });
});

function sourceAnalysis(source: string, title: string): GeneratedAnalysis {
  return {
    title,
    summary: `${title}的摘要。`,
    knowledgePoints: [
      {
        title,
        body: source,
        candidateTags: ["版本切换"],
        evidenceSpans: [spanFor(source, source)],
      },
    ],
  };
}

function analysis(
  title: string,
  pointTitle: string,
  summary: string,
): GeneratedAnalysis {
  return {
    title,
    summary,
    knowledgePoints: [
      {
        title: pointTitle,
        body: `${pointTitle}来自对数据库变更流程的有据整理。`,
        candidateTags: ["数据库变更"],
        evidenceSpans: [spanFor(sourceTextForAnalysis, sourceTextForAnalysis)],
      },
    ],
  };
}

function spanFor(source: string, quote: string) {
  const start = source.indexOf(quote);

  return { quote, start, end: start + quote.length };
}

async function organizeAndWait(
  app: FastifyInstance,
  recordId: string,
  handling: "automatic" | "review" = "automatic",
): Promise<void> {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/records/${recordId}/organize`,
    payload: { handling },
  });

  expect(started.statusCode).toBe(202);

  const taskId = (started.json() as { task: PublicTask }).task.id;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/ai-tasks/${taskId}`,
    });
    const task = (response.json() as { task: PublicTask }).task;

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not finish`);
}

async function getDetail(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    presentation: { title: string; summary?: string };
    editable: {
      text: string;
      textVersion: number;
      myTags: Array<{ id: string; name: string }>;
    };
    organization: {
      candidate?: {
        id: string;
        reason: "reanalysis" | "source_updated";
        sourceTextVersion: number;
        presentation: { title: string; summary: string };
        organizedItems: Array<{
          title: string;
          publicationStatus: string;
          usageStatus: string;
        }>;
      };
    };
    organizedItems: Array<{
      id: string;
      title: string;
      publicationStatus: string;
      correction?: null | { title: string; body: string; updatedAt: string };
    }>;
  };
}

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName: string,
): Promise<{ id: string; tagId: string }> {
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
  const record = (response.json() as {
    record: { id: string; myTags: Array<{ id: string }> };
  }).record;

  return { id: record.id, tagId: record.myTags[0]!.id };
}

async function updateRecord(
  app: FastifyInstance,
  record: { id: string; tagId: string },
  text: string,
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/api/v1/records/${record.id}`,
    payload: {
      text,
      myTags: [{ id: record.tagId }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(200);
}

async function expectSearch(
  app: FastifyInstance,
  query: string,
  recordIds: string[],
): Promise<void> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?q=${encodeURIComponent(query)}`,
  });

  expect(response.statusCode).toBe(200);
  expect(
    (response.json() as { items: Array<{ record: { id: string } }> }).items.map(
      (item) => item.record.id,
    ),
  ).toEqual(recordIds);
}

async function getHistory(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}/history`,
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as { items: Array<Record<string, unknown>> }).items;
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const draft = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://reanalysis-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "fake-reanalysis-text-key",
      },
      embedding: {
        baseUrl: "https://reanalysis-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "fake-reanalysis-embedding-key",
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
