import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { readStoredZip } from "../../src/zip-archive.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

const V2_TABLES = [
  "duplicate_suggestions",
  "duplicate_consolidations",
  "relation_suggestions",
  "relation_suggestion_evidence",
  "knowledge_relations",
  "coverage_analyses",
  "coverage_analysis_points",
  "coverage_analysis_records",
  "coverage_analysis_items",
  "coverage_item_points",
  "coverage_item_records",
] as const;

describe("V2 governance export and restore", () => {
  let sourceApp: FastifyInstance;
  let targetApp: FastifyInstance;
  let sourceDatabase: PreparedTestDatabase;
  let targetDatabase: PreparedTestDatabase;
  let sourcePool: Pool;
  let targetPool: Pool;

  beforeAll(async () => {
    sourceDatabase = prepareTestDatabase();
    targetDatabase = prepareTestDatabase();
    sourcePool = new Pool({ connectionString: sourceDatabase.databaseUrl });
    targetPool = new Pool({ connectionString: targetDatabase.databaseUrl });
    sourceApp = await buildApp({
      databaseUrl: sourceDatabase.databaseUrl,
      generateAnalysis: async () => {
        throw new Error("export test must not generate analysis");
      },
    });
    targetApp = await buildApp({
      databaseUrl: targetDatabase.databaseUrl,
      generateAnalysis: async () => {
        throw new Error("restore test must not generate analysis");
      },
    });
    await Promise.all([sourceApp.ready(), targetApp.ready()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([sourceApp?.close(), targetApp?.close()]);
    await Promise.all([sourcePool?.end(), targetPool?.end()]);
    sourceDatabase?.dispose();
    targetDatabase?.dispose();
  }, 30_000);

  it("round-trips reversible duplicate, relation, and coverage state without model configuration rows", async () => {
    const ids = await seedCompleteV2Domain(sourcePool);
    const beforeCore = await snapshotTables(sourcePool, [
      "records",
      "fragment_revisions",
      "tags",
      "tag_assignments",
      "ai_analysis_revisions",
      "knowledge_points",
      "evidence_spans",
    ]);
    const beforeV2 = await snapshotTables(sourcePool, [...V2_TABLES]);
    const requested = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/exports",
    });

    expect(requested.statusCode).toBe(202);
    const exportId = (requested.json() as { export: { id: string } }).export.id;
    const completed = await waitForExport(sourceApp, exportId);

    expect(completed).toMatchObject({
      status: "succeeded",
      manifest: { formatVersion: 9, recordCount: 2 },
    });

    const downloaded = await sourceApp.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/download`,
    });

    expect(downloaded.statusCode).toBe(200);
    const archive = downloaded.rawPayload;
    const domainEntry = readStoredZip(archive).get("domain.json");

    if (!domainEntry) {
      throw new Error("domain.json is missing");
    }

    const domain = JSON.parse(domainEntry.toString("utf8")) as Record<
      string,
      unknown
    >;

    expect(domain).toMatchObject({
      formatVersion: 9,
      duplicateSuggestions: [expect.objectContaining({ id: ids.duplicateSuggestionId })],
      duplicateConsolidations: [
        expect.objectContaining({ id: ids.duplicateConsolidationId }),
      ],
      relationSuggestions: [expect.objectContaining({ id: ids.relationSuggestionId })],
      relationSuggestionEvidence: expect.arrayContaining([
        expect.objectContaining({ suggestion_id: ids.relationSuggestionId }),
      ]),
      knowledgeRelations: [expect.objectContaining({ id: ids.knowledgeRelationId })],
      coverageAnalyses: [expect.objectContaining({ id: ids.coverageAnalysisId })],
      coverageAnalysisPoints: expect.arrayContaining([
        expect.objectContaining({ analysis_id: ids.coverageAnalysisId }),
      ]),
      coverageAnalysisItems: expect.arrayContaining([
        expect.objectContaining({ analysis_id: ids.coverageAnalysisId }),
      ]),
      coverageItemPoints: expect.arrayContaining([
        expect.objectContaining({ item_id: ids.coveredItemId }),
      ]),
    });
    expect(JSON.stringify(domain)).not.toMatch(
      /credential_ciphertext|api[_-]?key|base_url/iu,
    );

    const inspected = await targetApp.inject({
      method: "POST",
      url: "/api/v1/restores/inspect",
      headers: { "content-type": "application/zip" },
      payload: archive,
    });

    expect(inspected.statusCode).toBe(200);
    const inspection = (
      inspected.json() as {
        inspection: { id: string; canRestore: boolean; formatVersion: number };
      }
    ).inspection;

    expect(inspection).toMatchObject({ canRestore: true, formatVersion: 9 });

    const restored = await targetApp.inject({
      method: "POST",
      url: "/api/v1/restores",
      payload: { inspectionId: inspection.id },
    });

    expect(restored.statusCode).toBe(201);
    expect(await snapshotTables(targetPool, [
      "records",
      "fragment_revisions",
      "tags",
      "tag_assignments",
      "ai_analysis_revisions",
      "knowledge_points",
      "evidence_spans",
    ])).toEqual(beforeCore);
    expect(await snapshotTables(targetPool, [...V2_TABLES])).toEqual(beforeV2);
    expect(
      await targetPool.query("SELECT version FROM model_configurations"),
    ).toMatchObject({ rowCount: 0 });
  }, 30_000);
});

async function seedCompleteV2Domain(pool: Pool) {
  const client = await pool.connect();
  const ids = {
    tagId: crypto.randomUUID(),
    recordAId: crypto.randomUUID(),
    recordBId: crypto.randomUUID(),
    revisionAId: crypto.randomUUID(),
    revisionBId: crypto.randomUUID(),
    analysisAId: crypto.randomUUID(),
    analysisBId: crypto.randomUUID(),
    pointAId: crypto.randomUUID(),
    pointBId: crypto.randomUUID(),
    evidenceAId: crypto.randomUUID(),
    evidenceBId: crypto.randomUUID(),
    duplicateSuggestionId: crypto.randomUUID(),
    duplicateConsolidationId: crypto.randomUUID(),
    relationSuggestionId: crypto.randomUUID(),
    knowledgeRelationId: crypto.randomUUID(),
    coverageAnalysisId: crypto.randomUUID(),
    coveredItemId: crypto.randomUUID(),
    gapItemId: crypto.randomUUID(),
  };
  const source = "same source";

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, 'V2 恢复测试', 'v2 恢复测试', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [ids.tagId],
    );

    for (const [recordId, revisionId, analysisId, title] of [
      [ids.recordAId, ids.revisionAId, ids.analysisAId, "记录甲"],
      [ids.recordBId, ids.revisionBId, ids.analysisBId, "记录乙"],
    ] as const) {
      await client.query(
        `INSERT INTO records
           (id, current_fragment_revision_id, current_analysis_revision_id)
         VALUES ($1, $2, $3)`,
        [recordId, revisionId, analysisId],
      );
      await client.query(
        `INSERT INTO fragment_revisions
           (id, record_id, revision_number, content, grapheme_count)
         VALUES ($1, $2, 1, $3, $4)`,
        [revisionId, recordId, source, source.length],
      );
      await client.query(
        `INSERT INTO ai_analysis_revisions
           (id, record_id, fragment_revision_id, text_model, title, summary,
            status)
         VALUES ($1, $2, $3, 'v2-export-model', $4, '恢复测试摘要', 'ACTIVE')`,
        [analysisId, recordId, revisionId, title],
      );
      await client.query(
        `INSERT INTO tag_assignments (id, record_id, tag_id)
         VALUES ($1, $2, $3)`,
        [crypto.randomUUID(), recordId, ids.tagId],
      );
    }

    for (const [pointId, recordId, revisionId, analysisId, evidenceId, title] of [
      [
        ids.pointAId,
        ids.recordAId,
        ids.revisionAId,
        ids.analysisAId,
        ids.evidenceAId,
        "知识点甲",
      ],
      [
        ids.pointBId,
        ids.recordBId,
        ids.revisionBId,
        ids.analysisBId,
        ids.evidenceBId,
        "知识点乙",
      ],
    ] as const) {
      await client.query(
        `INSERT INTO knowledge_points
           (id, record_id, fragment_revision_id, analysis_revision_id,
            position, ai_title, ai_body, publication_status, usage_status)
         VALUES ($1, $2, $3, $4, 1, $5, '自包含知识正文', 'CONFIRMED',
                 'INCLUDED')`,
        [pointId, recordId, revisionId, analysisId, title],
      );
      await client.query(
        `INSERT INTO evidence_spans
           (id, knowledge_point_id, fragment_revision_id, position,
            start_offset, end_offset, quote)
         VALUES ($1, $2, $3, 1, 0, $4, $5)`,
        [evidenceId, pointId, revisionId, source.length, source],
      );
    }

    await client.query(
      `INSERT INTO duplicate_suggestions
         (id, source_a_type, source_a_id, source_a_record_id,
          source_a_fingerprint, source_b_type, source_b_id, source_b_record_id,
          source_b_fingerprint, detection_kind, similarity_score, reason,
          status, primary_source_id, configuration_version, decided_at)
       VALUES ($1, 'ORIGINAL', $2, $3, $4, 'ORIGINAL', $5, $6, $7,
               'EXACT', 1, '标准化文本相同。', 'ACCEPTED', $2, 7, now())`,
      [
        ids.duplicateSuggestionId,
        ids.revisionAId,
        ids.recordAId,
        "a".repeat(64),
        ids.revisionBId,
        ids.recordBId,
        "b".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO duplicate_consolidations
         (id, suggestion_id, primary_source_id)
       VALUES ($1, $2, $3)`,
      [
        ids.duplicateConsolidationId,
        ids.duplicateSuggestionId,
        ids.revisionAId,
      ],
    );
    await client.query(
      `INSERT INTO relation_suggestions
         (id, pair_key, input_fingerprint, source_knowledge_point_id,
          target_knowledge_point_id, source_content_fingerprint,
          target_content_fingerprint, relation_type, description, reason,
          confidence, model_configuration_version, text_model, status,
          decided_at)
       VALUES ($1, 'point-a:point-b', $2, $3, $4, $5, $6, 'EXTENDS',
               '甲知识延伸到乙知识。', '两端证据相互补充。', 0.9, 7,
               'v2-export-model', 'CONFIRMED', now())`,
      [
        ids.relationSuggestionId,
        "c".repeat(64),
        ids.pointAId,
        ids.pointBId,
        "d".repeat(64),
        "e".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO relation_suggestion_evidence
         (suggestion_id, evidence_span_id, side)
       VALUES ($1, $2, 'SOURCE'), ($1, $3, 'TARGET')`,
      [ids.relationSuggestionId, ids.evidenceAId, ids.evidenceBId],
    );
    await client.query(
      `INSERT INTO knowledge_relations
         (id, suggestion_id, source_knowledge_point_id,
          target_knowledge_point_id, relation_type, description)
       VALUES ($1, $2, $3, $4, 'APPLIES', '甲知识可应用于乙知识。')`,
      [
        ids.knowledgeRelationId,
        ids.relationSuggestionId,
        ids.pointAId,
        ids.pointBId,
      ],
    );
    await client.query(
      `INSERT INTO coverage_analyses
         (id, topic, framework_summary, caveat, input_count,
          model_configuration_version, text_model, started_at, completed_at)
       VALUES ($1, '恢复覆盖分析', '按输入和缺口两个方面检查。',
               '这是建议性快照。', 2, 7, 'v2-export-model', now(), now())`,
      [ids.coverageAnalysisId],
    );
    await client.query(
      `INSERT INTO coverage_analysis_points
         (analysis_id, knowledge_point_id, content_fingerprint, position)
       VALUES ($1, $2, $3, 1), ($1, $4, $5, 2)`,
      [
        ids.coverageAnalysisId,
        ids.pointAId,
        "f".repeat(64),
        ids.pointBId,
        "0".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO coverage_analysis_items
         (id, analysis_id, kind, position, title, assessment, recommendation)
       VALUES ($1, $3, 'COVERED', 1, '已有覆盖', '两个知识点覆盖核心主题。', NULL),
              ($2, $3, 'POSSIBLE_GAP', 2, '可能缺口', '还可检查失败场景。',
               '补充失败恢复案例。')`,
      [ids.coveredItemId, ids.gapItemId, ids.coverageAnalysisId],
    );
    await client.query(
      `INSERT INTO coverage_item_points (item_id, knowledge_point_id)
       VALUES ($1, $2), ($1, $3)`,
      [ids.coveredItemId, ids.pointAId, ids.pointBId],
    );
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForExport(app: FastifyInstance, exportId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}`,
    });
    const value = (response.json() as { export: Record<string, unknown> }).export;

    if (value.status === "succeeded") {
      return value;
    }

    if (value.status === "failed") {
      throw new Error("export failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("export did not complete");
}

async function snapshotTables(pool: Pool, tables: string[]) {
  const result: Record<string, unknown[]> = {};

  for (const table of tables) {
    const rows = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);

    result[table] = JSON.parse(JSON.stringify(rows.rows)) as unknown[];
  }

  return result;
}
