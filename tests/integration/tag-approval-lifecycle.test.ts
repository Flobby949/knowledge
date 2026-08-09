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

type PublicTag = {
  id: string;
  name: string;
};

type OrganizedItem = {
  id: string;
  tags: PublicTag[];
};

describe("unified AI candidate tag approval public flow", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const sourceText =
    "CDC 读取事务日志捕获数据变化，并把变化发送给下游。";
  const firstQuote = "CDC 读取事务日志捕获数据变化";
  const secondQuote = "把变化发送给下游。";
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );
  const generateAnalysis = vi.fn(async () => ({
    title: "CDC 的数据变化捕获",
    summary: "CDC 读取事务日志捕获数据变化，并将变化发送给下游。",
    knowledgePoints: [
      {
        title: "CDC 捕获数据变化",
        body: "CDC 读取事务日志捕获数据变化。",
        candidateTags: ["CDC"],
        evidenceSpans: [spanFor(sourceText, firstQuote)],
      },
      {
        title: "变化发送到下游",
        body: secondQuote,
        candidateTags: ["ＣＤＣ"],
        evidenceSpans: [spanFor(sourceText, secondQuote)],
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

  it("upgrades one normalized AI tag identity without changing its knowledge-point associations", async () => {
    await activateLocalConfiguration(app);
    expect(testModelEndpoint).toHaveBeenCalledTimes(2);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: sourceText,
        myTags: [{ name: "数据变化记录" }],
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

    const taskId = (started.json() as { task: { id: string } }).task.id;

    await waitForSucceededTask(app, taskId);
    expect(generateAnalysis).toHaveBeenCalledTimes(1);

    const detailBeforeApproval = await getDetail(app, recordId);

    expect(detailBeforeApproval.organizedItems).toHaveLength(2);

    const candidateTags = detailBeforeApproval.organizedItems.flatMap(
      (item) => item.tags,
    );
    const candidateIds = new Set(candidateTags.map((tag) => tag.id));

    expect(candidateTags).toHaveLength(2);
    expect(candidateIds.size).toBe(1);
    expect(candidateTags.map((tag) => tag.name)).toEqual(["CDC", "CDC"]);

    const candidateId = candidateTags[0]?.id;

    if (!candidateId) {
      throw new Error("organized knowledge must expose its AI candidate tag");
    }

    expect(
      detailBeforeApproval.editable.myTags.some(
        (tag) => tag.id === candidateId,
      ),
    ).toBe(false);

    const approvedBefore = await listApprovedTags(app, "CDC");

    expect(approvedBefore.items).toEqual([]);

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/tags/${candidateId}/approve`,
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({
      tag: {
        id: candidateId,
        name: "CDC",
        origin: "ai_created",
        approvalStatus: "user_approved",
      },
    });

    const approvedAfter = await listApprovedTags(app, "CDC");

    expect(approvedAfter).toEqual({
      items: [
        {
          id: candidateId,
          name: "CDC",
          origin: "ai_created",
          approvalStatus: "user_approved",
          recordCount: 1,
        },
      ],
      page: { nextCursor: null },
    });

    const detailAfterApproval = await getDetail(app, recordId);

    expect(
      detailAfterApproval.organizedItems.flatMap((item) => item.tags),
    ).toEqual([
      { id: candidateId, name: "CDC" },
      { id: candidateId, name: "CDC" },
    ]);
    expect(
      detailAfterApproval.editable.myTags.some(
        (tag) => tag.id === candidateId,
      ),
    ).toBe(false);
  });
});

async function getDetail(app: FastifyInstance, recordId: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/records/${recordId}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    editable: { myTags: PublicTag[] };
    organizedItems: OrganizedItem[];
  };
}

async function listApprovedTags(app: FastifyInstance, query: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/tags?${new URLSearchParams({
      approval: "user_approved",
      q: query,
    }).toString()}`,
  });

  expect(response.statusCode).toBe(200);

  return response.json() as {
    items: Array<{
      id: string;
      name: string;
      origin: "user_created" | "ai_created";
      approvalStatus: "user_approved";
      recordCount: number;
    }>;
    page: { nextCursor: string | null };
  };
}

async function activateLocalConfiguration(app: FastifyInstance): Promise<void> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "https://tag-text.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "tag-lifecycle-text-key",
      },
      embedding: {
        baseUrl: "https://tag-embedding.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "tag-lifecycle-embedding-key",
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

    const task = response.json() as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (task.task.status === "succeeded") {
      return;
    }

    if (task.task.status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`AI task ${taskId} did not succeed in time`);
}

function spanFor(sourceText: string, quote: string) {
  const start = sourceText.indexOf(quote);

  if (start < 0) {
    throw new Error(`quote is missing from source text: ${quote}`);
  }

  return { quote, start, end: start + quote.length };
}
