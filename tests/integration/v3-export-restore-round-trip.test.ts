import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createZip, readStoredZip } from "../../src/zip-archive.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

const V3_TABLES = [
  "concepts",
  "concept_revisions",
  "concept_memberships",
  "concept_activity",
  "concept_candidate_scans",
  "concept_candidate_inputs",
  "concept_candidates",
  "concept_candidate_members",
  "concept_candidate_decision_members",
] as const;

describe("V3 Concept and Candidate export and restore", () => {
  let sourceApp: FastifyInstance;
  let currentTargetApp: FastifyInstance;
  let format6TargetApp: FastifyInstance;
  let format5TargetApp: FastifyInstance;
  let format4TargetApp: FastifyInstance;
  let sourceDatabase: PreparedTestDatabase;
  let currentTargetDatabase: PreparedTestDatabase;
  let format6TargetDatabase: PreparedTestDatabase;
  let format5TargetDatabase: PreparedTestDatabase;
  let format4TargetDatabase: PreparedTestDatabase;
  let sourcePool: Pool;
  let currentTargetPool: Pool;
  let format6TargetPool: Pool;
  let format5TargetPool: Pool;

  beforeAll(async () => {
    sourceDatabase = prepareTestDatabase();
    currentTargetDatabase = prepareTestDatabase();
    format6TargetDatabase = prepareTestDatabase();
    format5TargetDatabase = prepareTestDatabase();
    format4TargetDatabase = prepareTestDatabase();
    sourcePool = new Pool({ connectionString: sourceDatabase.databaseUrl });
    currentTargetPool = new Pool({
      connectionString: currentTargetDatabase.databaseUrl,
    });
    format6TargetPool = new Pool({
      connectionString: format6TargetDatabase.databaseUrl,
    });
    format5TargetPool = new Pool({
      connectionString: format5TargetDatabase.databaseUrl,
    });
    sourceApp = await buildApp({ databaseUrl: sourceDatabase.databaseUrl });
    currentTargetApp = await buildApp({
      databaseUrl: currentTargetDatabase.databaseUrl,
    });
    format6TargetApp = await buildApp({
      databaseUrl: format6TargetDatabase.databaseUrl,
    });
    format5TargetApp = await buildApp({
      databaseUrl: format5TargetDatabase.databaseUrl,
    });
    format4TargetApp = await buildApp({
      databaseUrl: format4TargetDatabase.databaseUrl,
    });
    await Promise.all([
      sourceApp.ready(),
      currentTargetApp.ready(),
      format6TargetApp.ready(),
      format5TargetApp.ready(),
      format4TargetApp.ready(),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([
      sourceApp?.close(),
      currentTargetApp?.close(),
      format6TargetApp?.close(),
      format5TargetApp?.close(),
      format4TargetApp?.close(),
    ]);
    await Promise.all([
      sourcePool?.end(),
      currentTargetPool?.end(),
      format6TargetPool?.end(),
      format5TargetPool?.end(),
    ]);
    sourceDatabase?.dispose();
    currentTargetDatabase?.dispose();
    format6TargetDatabase?.dispose();
    format5TargetDatabase?.dispose();
    format4TargetDatabase?.dispose();
  }, 30_000);

  it("round-trips automatic Candidate provenance in format 7 and restores formats 4–6", async () => {
    const ids = await seedConceptDomain(sourcePool);
    const before = await snapshotTables(sourcePool, [...V3_TABLES]);
    const requested = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/exports",
    });

    expect(requested.statusCode).toBe(202);
    const exportId = (requested.json() as { export: { id: string } }).export.id;
    const completed = await waitForExport(sourceApp, exportId);

    expect(completed).toMatchObject({
      status: "succeeded",
      manifest: { formatVersion: 7, recordCount: 2 },
    });

    const downloaded = await sourceApp.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/download`,
    });

    expect(downloaded.statusCode).toBe(200);
    const format7Archive = downloaded.rawPayload;
    const domainEntry = readStoredZip(format7Archive).get("domain.json");

    if (!domainEntry) {
      throw new Error("domain.json is missing");
    }

    const domain = JSON.parse(domainEntry.toString("utf8")) as Record<
      string,
      unknown
    >;

    expect(domain).toMatchObject({
      formatVersion: 7,
      concepts: [expect.objectContaining({ id: ids.conceptId })],
      conceptRevisions: expect.arrayContaining([
        expect.objectContaining({ id: ids.firstConceptRevisionId }),
        expect.objectContaining({ id: ids.secondConceptRevisionId }),
      ]),
      conceptMemberships: expect.arrayContaining([
        expect.objectContaining({ id: ids.firstMembershipId, removed_at: null }),
        expect.objectContaining({
          id: ids.secondMembershipId,
          removed_at: expect.any(String),
        }),
      ]),
      conceptActivity: expect.arrayContaining([
        expect.objectContaining({ concept_id: ids.conceptId, sequence_number: 6 }),
      ]),
      conceptCandidateScans: [
        expect.objectContaining({
          id: ids.candidateScanId,
          status: "SUCCEEDED",
          outcome: "CANDIDATE",
          trigger_analysis_revision_id: ids.firstAnalysisId,
        }),
      ],
      conceptCandidateInputs: expect.arrayContaining([
        expect.objectContaining({ id: ids.firstCandidateInputId }),
        expect.objectContaining({ id: ids.secondCandidateInputId }),
      ]),
      conceptCandidates: [
        expect.objectContaining({
          id: ids.candidateId,
          review_status: "ACCEPTED",
          accepted_concept_id: ids.conceptId,
        }),
      ],
      conceptCandidateDecisionMembers: expect.arrayContaining([
        expect.objectContaining({ concept_membership_id: ids.firstMembershipId }),
        expect.objectContaining({ concept_membership_id: ids.secondMembershipId }),
      ]),
    });

    const currentInspection = await inspect(currentTargetApp, format7Archive);

    expect(currentInspection).toMatchObject({
      canRestore: true,
      formatVersion: 7,
      recordCount: 2,
    });
    await restore(currentTargetApp, currentInspection.id);
    expect(await snapshotTables(currentTargetPool, [...V3_TABLES])).toEqual(
      before,
    );

    const restoredDetail = await currentTargetApp.inject({
      method: "GET",
      url: `/api/v1/concepts/${ids.conceptId}`,
    });

    expect(restoredDetail.statusCode).toBe(200);
    expect(restoredDetail.json()).toMatchObject({
      detail: {
        concept: {
          id: ids.conceptId,
          name: "事件系统",
          description: "事件在生产者与消费者之间异步流动。",
          lifecycle: "archived",
          revisionNumber: 2,
        },
        memberships: expect.arrayContaining([
          expect.objectContaining({ id: ids.firstMembershipId, status: "active" }),
          expect.objectContaining({ id: ids.secondMembershipId, status: "removed" }),
        ]),
      },
    });

    const legacyFormat6Archive = downgradeToFormat6(format7Archive);
    const format6Inspection = await inspect(
      format6TargetApp,
      legacyFormat6Archive,
    );

    expect(format6Inspection).toMatchObject({
      canRestore: true,
      formatVersion: 6,
      recordCount: 2,
    });
    await restore(format6TargetApp, format6Inspection.id);
    expect(
      await format6TargetPool.query(
        "SELECT trigger_analysis_revision_id FROM concept_candidate_scans",
      ),
    ).toMatchObject({ rows: [{ trigger_analysis_revision_id: null }] });

    const legacyFormat5Archive = downgradeToFormat5(format7Archive);
    const format5Inspection = await inspect(
      format5TargetApp,
      legacyFormat5Archive,
    );

    expect(format5Inspection).toMatchObject({
      canRestore: true,
      formatVersion: 5,
      recordCount: 2,
    });
    await restore(format5TargetApp, format5Inspection.id);

    const format5Concepts = await format5TargetApp.inject({
      method: "GET",
      url: "/api/v1/concepts?archive=all",
    });
    const format5Candidates = await format5TargetApp.inject({
      method: "GET",
      url: "/api/v1/concept-candidate-scans?scope=all",
    });

    expect(
      (format5Concepts.json() as { items: unknown[] }).items,
    ).toHaveLength(1);
    expect(format5Candidates.json()).toEqual({ items: [] });

    const format4Archive = downgradeToFormat4(format7Archive);
    const format4Inspection = await inspect(format4TargetApp, format4Archive);

    expect(format4Inspection).toMatchObject({
      canRestore: true,
      formatVersion: 4,
      recordCount: 2,
    });
    await restore(format4TargetApp, format4Inspection.id);

    const restoredConcepts = await format4TargetApp.inject({
      method: "GET",
      url: "/api/v1/concepts?archive=all",
    });
    const restoredRecords = await format4TargetApp.inject({
      method: "GET",
      url: "/api/v1/records?archive=all",
    });

    expect(restoredConcepts.json()).toEqual({ items: [] });
    expect(
      (restoredRecords.json() as { items: unknown[] }).items,
    ).toHaveLength(2);
  }, 30_000);
});

async function seedConceptDomain(pool: Pool) {
  const ids = {
    tagId: crypto.randomUUID(),
    firstRecordId: crypto.randomUUID(),
    secondRecordId: crypto.randomUUID(),
    firstRevisionId: crypto.randomUUID(),
    secondRevisionId: crypto.randomUUID(),
    firstAnalysisId: crypto.randomUUID(),
    secondAnalysisId: crypto.randomUUID(),
    firstPointId: crypto.randomUUID(),
    secondPointId: crypto.randomUUID(),
    firstEvidenceId: crypto.randomUUID(),
    secondEvidenceId: crypto.randomUUID(),
    conceptId: crypto.randomUUID(),
    firstConceptRevisionId: crypto.randomUUID(),
    secondConceptRevisionId: crypto.randomUUID(),
    firstMembershipId: crypto.randomUUID(),
    secondMembershipId: crypto.randomUUID(),
    candidateScanId: crypto.randomUUID(),
    firstCandidateInputId: crypto.randomUUID(),
    secondCandidateInputId: crypto.randomUUID(),
    candidateId: crypto.randomUUID(),
  };
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tags
         (id, display_name, normalized_name, origin, approval_status,
          user_approved_at)
       VALUES ($1, 'V3 恢复', 'v3 恢复', 'USER_CREATED',
               'USER_APPROVED', now())`,
      [ids.tagId],
    );

    for (const [recordId, revisionId, analysisId, pointId, evidenceId, source, title] of [
      [
        ids.firstRecordId,
        ids.firstRevisionId,
        ids.firstAnalysisId,
        ids.firstPointId,
        ids.firstEvidenceId,
        "event producer",
        "事件生产者",
      ],
      [
        ids.secondRecordId,
        ids.secondRevisionId,
        ids.secondAnalysisId,
        ids.secondPointId,
        ids.secondEvidenceId,
        "event consumer",
        "事件消费者",
      ],
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
         VALUES ($1, $2, $3, 'v3-export-model', $4, '测试摘要', 'ACTIVE')`,
        [analysisId, recordId, revisionId, title],
      );
      await client.query(
        `INSERT INTO knowledge_points
           (id, record_id, fragment_revision_id, analysis_revision_id,
            position, ai_title, ai_body, publication_status, usage_status)
         VALUES ($1, $2, $3, $4, 1, $5, $6, 'CONFIRMED', 'INCLUDED')`,
        [pointId, recordId, revisionId, analysisId, title, `${title}知识正文`],
      );
      await client.query(
        `INSERT INTO evidence_spans
           (id, knowledge_point_id, fragment_revision_id, position,
            start_offset, end_offset, quote)
         VALUES ($1, $2, $3, 1, 0, $4, $5)`,
        [evidenceId, pointId, revisionId, source.length, source],
      );
      await client.query(
        "INSERT INTO tag_assignments (record_id, tag_id) VALUES ($1, $2)",
        [recordId, ids.tagId],
      );
    }

    await client.query(
      `INSERT INTO concepts
         (id, current_revision_id, normalized_name, archived_at)
       VALUES ($1, $2, '事件系统', now())`,
      [ids.conceptId, ids.secondConceptRevisionId],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $3, 1, '事件机制', '事件机制', '事件传递机制。'),
              ($2, $3, 2, '事件系统', '事件系统',
               '事件在生产者与消费者之间异步流动。')`,
      [ids.firstConceptRevisionId, ids.secondConceptRevisionId, ids.conceptId],
    );
    await client.query(
      `INSERT INTO concept_memberships
         (id, concept_id, knowledge_point_id, removed_at)
       VALUES ($1, $3, $4, NULL), ($2, $3, $5, now())`,
      [
        ids.firstMembershipId,
        ids.secondMembershipId,
        ids.conceptId,
        ids.firstPointId,
        ids.secondPointId,
      ],
    );
    await client.query(
      `INSERT INTO concept_activity
         (concept_id, sequence_number, kind, revision_id, membership_id)
       VALUES
         ($1, 1, 'CREATED', $2, NULL),
         ($1, 2, 'MEMBER_ADDED', NULL, $3),
         ($1, 3, 'MEMBER_ADDED', NULL, $4),
         ($1, 4, 'UPDATED', $5, NULL),
         ($1, 5, 'MEMBER_REMOVED', NULL, $4),
         ($1, 6, 'ARCHIVED', NULL, NULL)`,
      [
        ids.conceptId,
        ids.firstConceptRevisionId,
        ids.firstMembershipId,
        ids.secondMembershipId,
        ids.secondConceptRevisionId,
      ],
    );
    await client.query(
      `INSERT INTO concept_candidate_scans
         (id, input_fingerprint, input_count, model_configuration_version,
          text_model, trigger_analysis_revision_id, status, outcome,
          attempt_count, started_at, completed_at)
       VALUES ($1, $2, 2, 7, 'v3-candidate-model', $3, 'SUCCEEDED',
               'CANDIDATE', 1, now(), now())`,
      [ids.candidateScanId, "a".repeat(64), ids.firstAnalysisId],
    );
    await client.query(
      `INSERT INTO concept_candidate_inputs
         (id, scan_id, knowledge_point_id, record_id, position,
          record_title_snapshot, title_snapshot, body_snapshot,
          evidence_snapshot, content_fingerprint)
       VALUES
         ($1, $3, $4, $5, 1, '事件生产者', '事件生产者', '事件生产者知识正文',
          $6::jsonb, $7),
         ($2, $3, $8, $9, 2, '事件消费者', '事件消费者', '事件消费者知识正文',
          $10::jsonb, $11)`,
      [
        ids.firstCandidateInputId,
        ids.secondCandidateInputId,
        ids.candidateScanId,
        ids.firstPointId,
        ids.firstRecordId,
        JSON.stringify([
          {
            id: ids.firstEvidenceId,
            fragmentRevisionId: ids.firstRevisionId,
            position: 1,
            startOffset: 0,
            endOffset: "event producer".length,
            quote: "event producer",
          },
        ]),
        "b".repeat(64),
        ids.secondPointId,
        ids.secondRecordId,
        JSON.stringify([
          {
            id: ids.secondEvidenceId,
            fragmentRevisionId: ids.secondRevisionId,
            position: 1,
            startOffset: 0,
            endOffset: "event consumer".length,
            quote: "event consumer",
          },
        ]),
        "c".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO concept_candidates
         (id, scan_id, candidate_fingerprint, suggested_name,
          normalized_name, suggested_description, reason, review_status,
          accepted_concept_id, confirmed_name, confirmed_description,
          decided_at)
       VALUES ($1, $2, $3, '事件机制候选', '事件机制候选',
               '事件通过生产与消费形成协作。', '两个知识点共同描述事件协作。',
               'ACCEPTED', $4, '事件机制', '事件传递机制。', now())`,
      [ids.candidateId, ids.candidateScanId, "d".repeat(64), ids.conceptId],
    );
    await client.query(
      `INSERT INTO concept_candidate_members (candidate_id, input_id, position)
       VALUES ($1, $2, 1), ($1, $3, 2)`,
      [
        ids.candidateId,
        ids.firstCandidateInputId,
        ids.secondCandidateInputId,
      ],
    );
    await client.query(
      `INSERT INTO concept_candidate_decision_members
         (candidate_id, input_id, concept_membership_id, position)
       VALUES ($1, $2, $3, 1), ($1, $4, $5, 2)`,
      [
        ids.candidateId,
        ids.firstCandidateInputId,
        ids.firstMembershipId,
        ids.secondCandidateInputId,
        ids.secondMembershipId,
      ],
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

function downgradeToFormat6(archive: Buffer): Buffer {
  const entries = readStoredZip(archive);
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    formatVersion: number;
  };
  const domain = JSON.parse(entries.get("domain.json")!.toString("utf8")) as {
    conceptCandidateScans: Array<Record<string, unknown>>;
    formatVersion: number;
  };

  manifest.formatVersion = 6;
  domain.formatVersion = 6;

  for (const scan of domain.conceptCandidateScans) {
    delete scan.trigger_analysis_revision_id;
  }

  return createZip(
    [...entries].map(([name, data]) => ({
      name,
      data:
        name === "manifest.json"
          ? Buffer.from(JSON.stringify(manifest), "utf8")
          : name === "domain.json"
            ? Buffer.from(JSON.stringify(domain), "utf8")
            : data,
    })),
  );
}

function downgradeToFormat5(archive: Buffer): Buffer {
  const entries = readStoredZip(downgradeToFormat6(archive));
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    formatVersion: number;
  };
  const domain = JSON.parse(entries.get("domain.json")!.toString("utf8")) as Record<
    string,
    unknown
  >;

  manifest.formatVersion = 5;
  domain.formatVersion = 5;
  delete domain.conceptCandidateScans;
  delete domain.conceptCandidateInputs;
  delete domain.conceptCandidates;
  delete domain.conceptCandidateMembers;
  delete domain.conceptCandidateDecisionMembers;

  return createZip(
    [...entries].map(([name, data]) => ({
      name,
      data:
        name === "manifest.json"
          ? Buffer.from(JSON.stringify(manifest), "utf8")
          : name === "domain.json"
            ? Buffer.from(JSON.stringify(domain), "utf8")
            : data,
    })),
  );
}

function downgradeToFormat4(archive: Buffer): Buffer {
  const entries = readStoredZip(downgradeToFormat5(archive));
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as {
    formatVersion: number;
  };
  const domain = JSON.parse(entries.get("domain.json")!.toString("utf8")) as Record<
    string,
    unknown
  >;

  manifest.formatVersion = 4;
  domain.formatVersion = 4;
  delete domain.concepts;
  delete domain.conceptRevisions;
  delete domain.conceptMemberships;
  delete domain.conceptActivity;

  return createZip(
    [...entries].map(([name, data]) => ({
      name,
      data:
        name === "manifest.json"
          ? Buffer.from(JSON.stringify(manifest), "utf8")
          : name === "domain.json"
            ? Buffer.from(JSON.stringify(domain), "utf8")
            : data,
    })),
  );
}

async function inspect(app: FastifyInstance, archive: Buffer) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/restores/inspect",
    headers: { "content-type": "application/zip" },
    payload: archive,
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as {
    inspection: {
      canRestore: boolean;
      formatVersion: number;
      id: string;
      recordCount: number;
    };
  }).inspection;
}

async function restore(app: FastifyInstance, inspectionId: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/restores",
    payload: { inspectionId },
  });

  expect(response.statusCode, response.body).toBe(201);
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
  const snapshot: Record<string, unknown[]> = {};

  for (const table of tables) {
    const result = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);

    snapshot[table] = JSON.parse(JSON.stringify(result.rows)) as unknown[];
  }

  return snapshot;
}
