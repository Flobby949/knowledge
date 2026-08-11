import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { EmbedText } from "../../src/embedding-provider.js";
import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type DuplicateSource = {
  changedSinceSuggestion: boolean;
  current: boolean;
  id: string;
  recordId: string;
  title: string;
  type: "knowledge_point" | "original";
};

type DuplicateSuggestion = {
  canDecide: boolean;
  id: string;
  kind: "exact" | "semantic";
  primarySourceId: string | null;
  reason: string;
  score: number;
  sources: [DuplicateSource, DuplicateSource];
  status: "accepted" | "pending_review" | "rejected" | "removed";
};

describe("V2 duplicate suggestions and source-preserving consolidation", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;
  const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));
  const embedText = vi.fn<EmbedText>(async ({ text }) => {
    if (text.includes("语义重复候选甲") || text.includes("语义重复候选乙")) {
      return [1, 0, 0, 0];
    }

    if (text.includes("标准化精确重复")) {
      return [0, 1, 0, 0];
    }

    return [0, 0, 1, 0];
  });

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 30_000);

  it("detects normalized exact duplicates and accepts or removes a grouping without changing either source", async () => {
    const firstRecordId = await createRecord(
      app,
      "标准化精确重复 Ａ\n同一段内容",
      "重复检查一",
    );
    const secondRecordId = await createRecord(
      app,
      "  标准化精确重复 A \n  同一段内容  ",
      "重复检查二",
    );
    const before = await sourceSnapshot(pool, [firstRecordId, secondRecordId]);
    const scan = await app.inject({
      method: "POST",
      url: "/api/v1/duplicate-suggestions/scan",
    });

    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({
      scan: {
        exactCandidates: 1,
        semanticCandidates: 0,
        semanticStatus: "unavailable",
        pendingSuggestions: 1,
      },
    });

    const pending = await listSuggestions(app, "pending");
    const suggestion = pending.find((item) =>
      sameRecordPair(item, firstRecordId, secondRecordId),
    );

    expect(suggestion).toMatchObject({
      kind: "exact",
      score: 1,
      status: "pending_review",
      canDecide: true,
      primarySourceId: null,
    });

    if (!suggestion) {
      throw new Error("Expected exact duplicate suggestion");
    }

    const primary = suggestion.sources.find(
      (source) => source.recordId === firstRecordId,
    );

    if (!primary) {
      throw new Error("Expected first record source");
    }

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/duplicate-suggestions/${suggestion.id}/accept`,
      payload: { primarySourceId: primary.id },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      suggestion: {
        id: suggestion.id,
        status: "accepted",
        primarySourceId: primary.id,
        consolidationId: expect.any(String),
      },
    });
    expect(await sourceSnapshot(pool, [firstRecordId, secondRecordId])).toEqual(
      before,
    );
    const sourceResponses = await Promise.all(
      [firstRecordId, secondRecordId].map((id) =>
        app.inject({ method: "GET", url: `/api/v1/records/${id}` }),
      ),
    );

    expect(sourceResponses.every((response) => response.statusCode === 200)).toBe(
      true,
    );

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/duplicate-suggestions/${suggestion.id}/consolidation`,
    });

    expect(removed.statusCode).toBe(204);
    expect(await sourceSnapshot(pool, [firstRecordId, secondRecordId])).toEqual(
      before,
    );
    expect(await listSuggestions(app, "resolved")).toContainEqual(
      expect.objectContaining({ id: suggestion.id, status: "removed" }),
    );

    await app.inject({
      method: "POST",
      url: "/api/v1/duplicate-suggestions/scan",
    });
    expect(
      (await listSuggestions(app, "pending")).some(
        (item) => item.id === suggestion.id,
      ),
    ).toBe(false);
  });

  it("keeps a rejected source-version pair resolved and detects high-similarity current embeddings", async () => {
    const rejectedFirst = await createRecord(
      app,
      "拒绝后不重复推荐",
      "拒绝检查一",
    );
    const rejectedSecond = await createRecord(
      app,
      "拒绝后不重复推荐",
      "拒绝检查二",
    );

    await app.inject({
      method: "POST",
      url: "/api/v1/duplicate-suggestions/scan",
    });

    const rejectedSuggestion = (await listSuggestions(app, "pending")).find(
      (item) => sameRecordPair(item, rejectedFirst, rejectedSecond),
    );

    if (!rejectedSuggestion) {
      throw new Error("Expected rejectable duplicate suggestion");
    }

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/duplicate-suggestions/${rejectedSuggestion.id}/reject`,
    });

    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      suggestion: { status: "rejected" },
    });

    await activateConfiguration(app);

    const semanticFirst = await createRecord(
      app,
      "语义重复候选甲：从事务日志持续消费数据库变更。",
      "语义检查一",
    );
    const semanticSecond = await createRecord(
      app,
      "语义重复候选乙：订阅提交日志以获得连续增量事件。",
      "语义检查二",
    );

    await waitForSemanticReady(app);

    const scan = await app.inject({
      method: "POST",
      url: "/api/v1/duplicate-suggestions/scan",
    });

    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({
      scan: {
        semanticStatus: "ready",
        semanticCandidates: expect.any(Number),
      },
    });

    const semanticSuggestion = (await listSuggestions(app, "pending")).find(
      (item) => sameRecordPair(item, semanticFirst, semanticSecond),
    );

    expect(semanticSuggestion).toMatchObject({
      kind: "semantic",
      score: 1,
      status: "pending_review",
      canDecide: true,
    });
    expect(semanticSuggestion?.reason).toContain("语义向量相似度");

    await app.inject({
      method: "POST",
      url: "/api/v1/duplicate-suggestions/scan",
    });
    expect(
      (await listSuggestions(app, "pending")).some(
        (item) => item.id === rejectedSuggestion.id,
      ),
    ).toBe(false);
  });
});

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

async function listSuggestions(
  app: FastifyInstance,
  status: "pending" | "resolved",
): Promise<DuplicateSuggestion[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/duplicate-suggestions?status=${status}`,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { items: DuplicateSuggestion[] }).items;
}

function sameRecordPair(
  suggestion: DuplicateSuggestion,
  firstRecordId: string,
  secondRecordId: string,
): boolean {
  const ids = new Set(suggestion.sources.map((source) => source.recordId));

  return ids.has(firstRecordId) && ids.has(secondRecordId);
}

async function sourceSnapshot(pool: Pool, recordIds: string[]) {
  const [records, revisions, assignments] = await Promise.all([
    pool.query(
      `SELECT * FROM records WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [recordIds],
    ),
    pool.query(
      `SELECT * FROM fragment_revisions
        WHERE record_id = ANY($1::uuid[])
        ORDER BY record_id, revision_number`,
      [recordIds],
    ),
    pool.query(
      `SELECT * FROM tag_assignments
        WHERE record_id = ANY($1::uuid[])
        ORDER BY record_id, id`,
      [recordIds],
    ),
  ]);

  return {
    records: records.rows,
    revisions: revisions.rows,
    assignments: assignments.rows,
  };
}

async function activateConfiguration(app: FastifyInstance): Promise<void> {
  const draft = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: {
      text: {
        baseUrl: "http://127.0.0.1:9/duplicate-text/v1",
        model: "duplicate-text",
        apiKey: "duplicate-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/duplicate-embedding/v1",
        model: "duplicate-embedding",
        apiKey: "duplicate-embedding-key",
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

async function waitForSemanticReady(app: FastifyInstance): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });
    const semantic = (response.json() as {
      semantic: { status: "building" | "paused" | "ready" };
    }).semantic;

    if (semantic.status === "ready") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Semantic documents did not become ready");
}
