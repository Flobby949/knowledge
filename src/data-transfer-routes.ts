import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { createZip, readStoredZip } from "./zip-archive.js";

const manifest = {
  formatVersion: 5,
  included: ["markdown", "domain_json"],
  excluded: [
    "model_credentials",
    "embeddings",
    "search_indexes",
    "ai_tasks",
    "logs",
  ],
} as const;

type DomainRow = Record<string, unknown>;

type Timestamp = Date | string;

interface RecordSnapshotRow extends DomainRow {
  id: string;
  current_fragment_revision_id: string;
  current_analysis_revision_id: string | null;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface FragmentRevisionSnapshotRow extends DomainRow {
  id: string;
  record_id: string;
  revision_number: number;
  content: string;
  grapheme_count: number;
  created_at: Timestamp;
}

interface TagSnapshotRow extends DomainRow {
  id: string;
  display_name: string;
  normalized_name: string;
  origin: "USER_CREATED" | "AI_CREATED";
  approval_status: "CANDIDATE" | "USER_APPROVED" | "ARCHIVED";
  user_approved_at: Timestamp | null;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface TagAssignmentSnapshotRow extends DomainRow {
  id: string;
  record_id: string | null;
  tag_id: string;
  assigned_by: "USER" | "AI";
  status: "ACTIVE" | "SUPPRESSED";
  created_at: Timestamp;
  knowledge_point_id: string | null;
  analysis_revision_id: string | null;
  raw_label: string | null;
}

interface TagAliasSnapshotRow extends DomainRow {
  id: string;
  tag_id: string;
  display_name: string;
  normalized_name: string;
  created_at: Timestamp;
}

interface TagMergeSnapshotRow extends DomainRow {
  id: string;
  operation_id: string;
  source_tag_id: string;
  target_tag_id: string;
  created_at: Timestamp;
  undone_at: Timestamp | null;
}

interface AnalysisSnapshotRow extends DomainRow {
  id: string;
  record_id: string;
  fragment_revision_id: string;
  text_model: string;
  title: string;
  summary: string;
  status: "GENERATED" | "ACTIVE" | "SUPERSEDED" | "DISCARDED" | "STALE";
  generated_at: Timestamp;
}

interface KnowledgePointSnapshotRow extends DomainRow {
  id: string;
  record_id: string;
  fragment_revision_id: string;
  analysis_revision_id: string;
  position: number;
  ai_title: string;
  ai_body: string;
  publication_status:
    | "AI_CREATED"
    | "PENDING_REVIEW"
    | "AUTO_PUBLISHED"
    | "CONFIRMED"
    | "REJECTED";
  usage_status: "INCLUDED" | "EXCLUDED";
  created_at: Timestamp;
}

interface EvidenceSpanSnapshotRow extends DomainRow {
  id: string;
  knowledge_point_id: string;
  fragment_revision_id: string;
  position: number;
  start_offset: number;
  end_offset: number;
  quote: string;
}

interface CorrectionSnapshotRow extends DomainRow {
  knowledge_point_id: string;
  title: string;
  body: string;
  updated_at: Timestamp;
}

interface OverviewCorrectionSnapshotRow extends DomainRow {
  record_id: string;
  analysis_revision_id: string;
  title: string;
  summary: string;
  updated_at: Timestamp;
}

interface DuplicateSuggestionSnapshotRow extends DomainRow {
  id: string;
  source_a_type: "KNOWLEDGE_POINT" | "ORIGINAL";
  source_a_id: string;
  source_a_record_id: string;
  source_a_fingerprint: string;
  source_b_type: "KNOWLEDGE_POINT" | "ORIGINAL";
  source_b_id: string;
  source_b_record_id: string;
  source_b_fingerprint: string;
  detection_kind: "EXACT" | "SEMANTIC";
  similarity_score: number;
  reason: string;
  status: "ACCEPTED" | "PENDING_REVIEW" | "REJECTED" | "REMOVED";
  primary_source_id: string | null;
  configuration_version: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  decided_at: Timestamp | null;
}

interface DuplicateConsolidationSnapshotRow extends DomainRow {
  id: string;
  suggestion_id: string;
  primary_source_id: string;
  created_at: Timestamp;
  removed_at: Timestamp | null;
}

interface RelationSuggestionSnapshotRow extends DomainRow {
  id: string;
  pair_key: string;
  input_fingerprint: string;
  source_knowledge_point_id: string;
  target_knowledge_point_id: string;
  source_content_fingerprint: string;
  target_content_fingerprint: string;
  relation_type: KnowledgeRelationSnapshotType;
  description: string;
  reason: string;
  confidence: number;
  model_configuration_version: number;
  text_model: string;
  status: "CONFIRMED" | "PENDING_REVIEW" | "REJECTED" | "REMOVED";
  created_at: Timestamp;
  updated_at: Timestamp;
  decided_at: Timestamp | null;
}

type KnowledgeRelationSnapshotType =
  | "ANALOGY"
  | "APPLIES"
  | "CONTRASTS"
  | "EXTENDS"
  | "PREREQUISITE"
  | "SIMILAR";

interface RelationEvidenceSnapshotRow extends DomainRow {
  suggestion_id: string;
  evidence_span_id: string;
  side: "SOURCE" | "TARGET";
}

interface KnowledgeRelationSnapshotRow extends DomainRow {
  id: string;
  suggestion_id: string;
  source_knowledge_point_id: string;
  target_knowledge_point_id: string;
  relation_type: KnowledgeRelationSnapshotType;
  description: string;
  confirmed_at: Timestamp;
  removed_at: Timestamp | null;
}

interface CoverageAnalysisSnapshotRow extends DomainRow {
  id: string;
  topic: string;
  framework_summary: string | null;
  caveat: string | null;
  input_count: number;
  model_configuration_version: number;
  text_model: string;
  input_kind: "KNOWLEDGE_POINTS" | "RECORDS";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  failure_code: string | null;
  failure_message: string | null;
  attempt_count: number;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
}

interface CoverageAnalysisPointSnapshotRow extends DomainRow {
  analysis_id: string;
  knowledge_point_id: string;
  content_fingerprint: string;
  position: number;
}

interface CoverageAnalysisRecordSnapshotRow extends DomainRow {
  analysis_id: string;
  record_id: string;
  fragment_revision_id: string;
  title: string;
  content_fingerprint: string;
  position: number;
}

interface CoverageAnalysisItemSnapshotRow extends DomainRow {
  id: string;
  analysis_id: string;
  kind: "COVERED" | "POSSIBLE_GAP";
  position: number;
  title: string;
  assessment: string;
  recommendation: string | null;
}

interface CoverageItemPointSnapshotRow extends DomainRow {
  item_id: string;
  knowledge_point_id: string;
}

interface CoverageItemRecordSnapshotRow extends DomainRow {
  item_id: string;
  record_id: string;
}

interface ConceptSnapshotRow extends DomainRow {
  id: string;
  current_revision_id: string;
  normalized_name: string;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ConceptRevisionSnapshotRow extends DomainRow {
  id: string;
  concept_id: string;
  revision_number: number;
  display_name: string;
  normalized_name: string;
  description: string;
  created_at: Timestamp;
}

interface ConceptMembershipSnapshotRow extends DomainRow {
  id: string;
  concept_id: string;
  knowledge_point_id: string;
  origin: "USER";
  created_at: Timestamp;
  removed_at: Timestamp | null;
}

type ConceptActivityKind =
  | "CREATED"
  | "UPDATED"
  | "ARCHIVED"
  | "RESTORED"
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED"
  | "MEMBER_RESTORED";

interface ConceptActivitySnapshotRow extends DomainRow {
  id: string;
  concept_id: string;
  sequence_number: number;
  kind: ConceptActivityKind;
  revision_id: string | null;
  membership_id: string | null;
  occurred_at: Timestamp;
}

interface DomainSnapshot {
  formatVersion: 5;
  records: RecordSnapshotRow[];
  fragmentRevisions: FragmentRevisionSnapshotRow[];
  tags: TagSnapshotRow[];
  tagAssignments: TagAssignmentSnapshotRow[];
  tagAliases: TagAliasSnapshotRow[];
  tagMerges: TagMergeSnapshotRow[];
  analyses: AnalysisSnapshotRow[];
  knowledgePoints: KnowledgePointSnapshotRow[];
  evidenceSpans: EvidenceSpanSnapshotRow[];
  corrections: CorrectionSnapshotRow[];
  overviewCorrections: OverviewCorrectionSnapshotRow[];
  duplicateSuggestions: DuplicateSuggestionSnapshotRow[];
  duplicateConsolidations: DuplicateConsolidationSnapshotRow[];
  relationSuggestions: RelationSuggestionSnapshotRow[];
  relationSuggestionEvidence: RelationEvidenceSnapshotRow[];
  knowledgeRelations: KnowledgeRelationSnapshotRow[];
  coverageAnalyses: CoverageAnalysisSnapshotRow[];
  coverageAnalysisPoints: CoverageAnalysisPointSnapshotRow[];
  coverageAnalysisRecords: CoverageAnalysisRecordSnapshotRow[];
  coverageAnalysisItems: CoverageAnalysisItemSnapshotRow[];
  coverageItemPoints: CoverageItemPointSnapshotRow[];
  coverageItemRecords: CoverageItemRecordSnapshotRow[];
  concepts: ConceptSnapshotRow[];
  conceptRevisions: ConceptRevisionSnapshotRow[];
  conceptMemberships: ConceptMembershipSnapshotRow[];
  conceptActivity: ConceptActivitySnapshotRow[];
}

interface ParsedSnapshot {
  snapshot: DomainSnapshot;
  sourceFormatVersion: 4 | 5;
}

interface ExportRow {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  manifest: null | (typeof manifest & { recordCount: number });
  archive: Buffer | null;
  completed_at: Date | string | null;
}

export function registerDataTransferRoutes(
  app: FastifyInstance,
  options: { pool: Pool; scheduleSemanticIndex: () => void },
): void {
  const { pool, scheduleSemanticIndex } = options;

  app.addContentTypeParser(
    "application/zip",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/v1/exports", async (_request, reply) => {
    const result = await pool.query<ExportRow>(
      "INSERT INTO data_exports DEFAULT VALUES RETURNING *",
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error("Export insert did not return a row");
    }

    setImmediate(() => {
      void buildExport(pool, row.id);
    });

    return reply.code(202).send({ export: publicExport(row) });
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/exports/:id",
    async (request, reply) => {
      const result = await pool.query<ExportRow>(
        "SELECT * FROM data_exports WHERE id = $1",
        [request.params.id],
      );
      const row = result.rows[0];

      if (!row) {
        return reply.code(404).send({ error: "Export not found" });
      }

      return { export: publicExport(row) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/exports/:id/download",
    async (request, reply) => {
      const result = await pool.query<ExportRow>(
        `SELECT *
           FROM data_exports
          WHERE id = $1
            AND status = 'SUCCEEDED'`,
        [request.params.id],
      );
      const row = result.rows[0];

      if (!row?.archive) {
        return reply.code(404).send({ error: "Export archive not found" });
      }

      return reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          `attachment; filename="knowledge-export-${row.id}.zip"`,
        )
        .send(row.archive);
    },
  );

  app.post(
    "/api/v1/restores/inspect",
    async (request, reply) => {
      const archive = request.body;

      if (!Buffer.isBuffer(archive)) {
        return reply.code(422).send({ error: "Restore package is required" });
      }

      let parsed: ParsedSnapshot;

      try {
        parsed = parseSnapshot(archive);
      } catch (error) {
        request.log.warn({ err: error }, "restore package inspection failed");
        return reply.code(422).send({
          error: {
            code: "RESTORE_PACKAGE_INVALID",
            message: "恢复包无效或版本不受支持。",
          },
        });
      }

      const canRestore = !(await instanceHasDomainData(pool));
      const inspectionId = randomUUID();

      await pool.query(
        `INSERT INTO restore_inspections
           (id, status, format_version, record_count, can_restore,
            blocking_reason, archive)
         VALUES ($1, 'VALID', $2, $3, $4, $5, $6)`,
        [
          inspectionId,
          parsed.sourceFormatVersion,
          parsed.snapshot.records.length,
          canRestore,
          canRestore ? null : "INSTANCE_NOT_EMPTY",
          archive,
        ],
      );

      return {
        inspection: {
          id: inspectionId,
          status: "valid",
          formatVersion: parsed.sourceFormatVersion,
          recordCount: parsed.snapshot.records.length,
          canRestore,
          ...(canRestore ? {} : { blockingReason: "INSTANCE_NOT_EMPTY" }),
        },
      };
    },
  );

  app.post<{ Body: { inspectionId?: string } }>(
    "/api/v1/restores",
    async (request, reply) => {
      if (!request.body?.inspectionId) {
        return reply.code(422).send({ error: "Inspection id is required" });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('knowledge-domain-restore'))",
        );
        const inspectionResult = await client.query<{
          id: string;
          archive: Buffer;
          status: "VALID" | "INVALID";
        }>(
          "SELECT id, archive, status FROM restore_inspections WHERE id = $1 FOR UPDATE",
          [request.body.inspectionId],
        );
        const inspection = inspectionResult.rows[0];

        if (!inspection || inspection.status !== "VALID") {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Restore inspection not found" });
        }

        if (await instanceHasDomainData(client)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "RESTORE_INSTANCE_NOT_EMPTY",
              message: "只能恢复到没有记录和标签的空实例。",
            },
          });
        }

        const { snapshot } = parseSnapshot(inspection.archive);

        await restoreSnapshot(client, snapshot);

        const restoreId = randomUUID();
        await client.query(
          `INSERT INTO data_restores
             (id, inspection_id, status, record_count)
           VALUES ($1, $2, 'SUCCEEDED', $3)`,
          [restoreId, inspection.id, snapshot.records.length],
        );
        await client.query("COMMIT");
        scheduleSemanticIndex();

        return reply.code(201).send({
          restore: {
            id: restoreId,
            status: "succeeded",
            recordCount: snapshot.records.length,
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}

async function buildExport(pool: Pool, exportId: string): Promise<void> {
  try {
    await pool.query(
      "UPDATE data_exports SET status = 'RUNNING' WHERE id = $1 AND status = 'QUEUED'",
      [exportId],
    );
    const snapshot = await readSnapshot(pool);
    const publicManifest = {
      ...manifest,
      recordCount: snapshot.records.length,
    };
    const archive = createZip([
      {
        name: "manifest.json",
        data: Buffer.from(JSON.stringify(publicManifest, null, 2), "utf8"),
      },
      {
        name: "domain.json",
        data: Buffer.from(JSON.stringify(snapshot), "utf8"),
      },
      {
        name: "README.md",
        data: Buffer.from(renderReadme(snapshot), "utf8"),
      },
      ...snapshot.records.map((record) => ({
        name: recordMarkdownName(record.id),
        data: Buffer.from(renderRecordMarkdown(snapshot, record), "utf8"),
      })),
    ]);

    await pool.query(
      `UPDATE data_exports
          SET status = 'SUCCEEDED',
              manifest = $2,
              archive = $3,
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [exportId, publicManifest, archive],
    );
  } catch (error) {
    await pool.query(
      `UPDATE data_exports
          SET status = 'FAILED',
              failure_message = $2,
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [exportId, error instanceof Error ? error.message : "Export failed"],
    );
  }
}

async function readSnapshot(pool: Pool): Promise<DomainSnapshot> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;

    const records = await client.query(
      "SELECT * FROM records ORDER BY created_at, id",
    );
    const fragmentRevisions = await client.query(
      "SELECT * FROM fragment_revisions ORDER BY record_id, revision_number",
    );
    const tags = await client.query("SELECT * FROM tags ORDER BY created_at, id");
    const tagAssignments = await client.query(
      "SELECT * FROM tag_assignments ORDER BY created_at, id",
    );
    const tagAliases = await client.query(
      "SELECT * FROM tag_aliases ORDER BY created_at, id",
    );
    const tagMerges = await client.query(
      "SELECT * FROM tag_merges ORDER BY created_at, id",
    );
    const analyses = await client.query(
      `SELECT id,
              record_id,
              fragment_revision_id,
              text_model,
              title,
              summary,
              status,
              generated_at
         FROM ai_analysis_revisions
        ORDER BY generated_at, id`,
    );
    const knowledgePoints = await client.query(
      "SELECT * FROM knowledge_points ORDER BY record_id, analysis_revision_id, position",
    );
    const evidenceSpans = await client.query(
      "SELECT * FROM evidence_spans ORDER BY knowledge_point_id, position",
    );
    const corrections = await client.query(
      "SELECT * FROM knowledge_point_corrections ORDER BY knowledge_point_id",
    );
    const overviewCorrections = await client.query(
      "SELECT * FROM record_overview_corrections ORDER BY record_id",
    );
    const duplicateSuggestions = await client.query(
      "SELECT * FROM duplicate_suggestions ORDER BY created_at, id",
    );
    const duplicateConsolidations = await client.query(
      "SELECT * FROM duplicate_consolidations ORDER BY created_at, id",
    );
    const relationSuggestions = await client.query(
      "SELECT * FROM relation_suggestions ORDER BY created_at, id",
    );
    const relationSuggestionEvidence = await client.query(
      `SELECT *
         FROM relation_suggestion_evidence
        ORDER BY suggestion_id, side, evidence_span_id`,
    );
    const knowledgeRelations = await client.query(
      "SELECT * FROM knowledge_relations ORDER BY confirmed_at, id",
    );
    const coverageAnalyses = await client.query(
      `SELECT *
         FROM coverage_analyses
        WHERE status IN ('SUCCEEDED', 'FAILED')
        ORDER BY created_at, id`,
    );
    const coverageAnalysisPoints = await client.query(
      `SELECT input.*
         FROM coverage_analysis_points AS input
         INNER JOIN coverage_analyses AS analysis
           ON analysis.id = input.analysis_id
          AND analysis.status IN ('SUCCEEDED', 'FAILED')
        ORDER BY input.analysis_id, input.position`,
    );
    const coverageAnalysisRecords = await client.query(
      `SELECT input.*
         FROM coverage_analysis_records AS input
         INNER JOIN coverage_analyses AS analysis
           ON analysis.id = input.analysis_id
          AND analysis.status IN ('SUCCEEDED', 'FAILED')
        ORDER BY input.analysis_id, input.position`,
    );
    const coverageAnalysisItems = await client.query(
      `SELECT item.*
         FROM coverage_analysis_items AS item
         INNER JOIN coverage_analyses AS analysis
           ON analysis.id = item.analysis_id
          AND analysis.status IN ('SUCCEEDED', 'FAILED')
        ORDER BY item.analysis_id, item.position`,
    );
    const coverageItemPoints = await client.query(
      `SELECT link.*
         FROM coverage_item_points AS link
         INNER JOIN coverage_analysis_items AS item ON item.id = link.item_id
         INNER JOIN coverage_analyses AS analysis
           ON analysis.id = item.analysis_id
          AND analysis.status IN ('SUCCEEDED', 'FAILED')
        ORDER BY link.item_id, link.knowledge_point_id`,
    );
    const coverageItemRecords = await client.query(
      `SELECT link.*
         FROM coverage_item_records AS link
         INNER JOIN coverage_analysis_items AS item ON item.id = link.item_id
         INNER JOIN coverage_analyses AS analysis
           ON analysis.id = item.analysis_id
          AND analysis.status IN ('SUCCEEDED', 'FAILED')
        ORDER BY link.item_id, link.record_id`,
    );
    const concepts = await client.query(
      "SELECT * FROM concepts ORDER BY created_at, id",
    );
    const conceptRevisions = await client.query(
      "SELECT * FROM concept_revisions ORDER BY concept_id, revision_number",
    );
    const conceptMemberships = await client.query(
      "SELECT * FROM concept_memberships ORDER BY concept_id, created_at, id",
    );
    const conceptActivity = await client.query(
      "SELECT * FROM concept_activity ORDER BY concept_id, sequence_number",
    );
    const snapshot: DomainSnapshot = {
      formatVersion: 5,
      records: records.rows,
      fragmentRevisions: fragmentRevisions.rows,
      tags: tags.rows,
      tagAssignments: tagAssignments.rows,
      tagAliases: tagAliases.rows,
      tagMerges: tagMerges.rows,
      analyses: analyses.rows,
      knowledgePoints: knowledgePoints.rows,
      evidenceSpans: evidenceSpans.rows,
      corrections: corrections.rows,
      overviewCorrections: overviewCorrections.rows,
      duplicateSuggestions: duplicateSuggestions.rows,
      duplicateConsolidations: duplicateConsolidations.rows,
      relationSuggestions: relationSuggestions.rows,
      relationSuggestionEvidence: relationSuggestionEvidence.rows,
      knowledgeRelations: knowledgeRelations.rows,
      coverageAnalyses: coverageAnalyses.rows,
      coverageAnalysisPoints: coverageAnalysisPoints.rows,
      coverageAnalysisRecords: coverageAnalysisRecords.rows,
      coverageAnalysisItems: coverageAnalysisItems.rows,
      coverageItemPoints: coverageItemPoints.rows,
      coverageItemRecords: coverageItemRecords.rows,
      concepts: concepts.rows,
      conceptRevisions: conceptRevisions.rows,
      conceptMemberships: conceptMemberships.rows,
      conceptActivity: conceptActivity.rows,
    };

    await client.query("COMMIT");
    transactionOpen = false;

    return snapshot;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    throw error;
  } finally {
    client.release();
  }
}

function parseSnapshot(archive: Buffer): ParsedSnapshot {
  const entries = readStoredZip(archive);
  const manifestJson = entries.get("manifest.json");
  const json = entries.get("domain.json");

  if (!manifestJson || !json || !entries.has("README.md")) {
    throw new Error("restore package is incomplete");
  }

  const publicManifest = JSON.parse(manifestJson.toString("utf8")) as unknown;
  const snapshotValue = JSON.parse(json.toString("utf8")) as unknown;

  if (
    !isDomainRow(publicManifest) ||
    (publicManifest.formatVersion !== 4 && publicManifest.formatVersion !== 5) ||
    !Number.isInteger(publicManifest.recordCount) ||
    !isStringArray(publicManifest.included) ||
    !isStringArray(publicManifest.excluded)
  ) {
    throw new Error("restore manifest is invalid");
  }

  const included = publicManifest.included;
  const excluded = publicManifest.excluded;

  if (
    Object.keys(publicManifest).length !== 4 ||
    included.length !== manifest.included.length ||
    excluded.length !== manifest.excluded.length ||
    !manifest.included.every((value) => included.includes(value)) ||
    !manifest.excluded.every((value) => excluded.includes(value))
  ) {
    throw new Error("restore manifest is invalid");
  }

  if (
    !isDomainRow(snapshotValue) ||
    snapshotValue.formatVersion !== publicManifest.formatVersion
  ) {
    throw new Error("restore snapshot version does not match its manifest");
  }

  const snapshot = validateDomainSnapshot(snapshotValue);

  if (publicManifest.recordCount !== snapshot.records.length) {
    throw new Error("restore manifest record count is invalid");
  }

  for (const record of snapshot.records) {
    if (!entries.has(recordMarkdownName(record.id))) {
      throw new Error(`record Markdown is missing: ${record.id}`);
    }
  }

  return {
    snapshot,
    sourceFormatVersion: publicManifest.formatVersion,
  };
}

function validateDomainSnapshot(value: unknown): DomainSnapshot {
  if (!isDomainRow(value)) {
    throw new Error("domain snapshot must be an object");
  }

  if (value.formatVersion !== 4 && value.formatVersion !== 5) {
    throw new Error("domain snapshot version is unsupported");
  }

  const baseKeys = [
    "formatVersion",
    "records",
    "fragmentRevisions",
    "tags",
    "tagAssignments",
    "tagAliases",
    "tagMerges",
    "analyses",
    "knowledgePoints",
    "evidenceSpans",
    "corrections",
    "overviewCorrections",
    "duplicateSuggestions",
    "duplicateConsolidations",
    "relationSuggestions",
    "relationSuggestionEvidence",
    "knowledgeRelations",
    "coverageAnalyses",
    "coverageAnalysisPoints",
    "coverageAnalysisItems",
    "coverageItemPoints",
    "coverageAnalysisRecords",
    "coverageItemRecords",
  ];
  const conceptKeys = [
    "concepts",
    "conceptRevisions",
    "conceptMemberships",
    "conceptActivity",
  ];

  requireExactKeys(
    value,
    value.formatVersion === 5 ? [...baseKeys, ...conceptKeys] : baseKeys,
  );

  const normalizedValue: DomainRow =
    value.formatVersion === 4
      ? {
          ...value,
          formatVersion: 5,
          concepts: [],
          conceptRevisions: [],
          conceptMemberships: [],
          conceptActivity: [],
        }
      : value;

  const records = requireRows(normalizedValue.records, "records");
  const fragmentRevisions = requireRows(
    normalizedValue.fragmentRevisions,
    "fragmentRevisions",
  );
  const tags = requireRows(normalizedValue.tags, "tags");
  const tagAssignments = requireRows(
    normalizedValue.tagAssignments,
    "tagAssignments",
  );
  const tagAliases = requireRows(normalizedValue.tagAliases, "tagAliases");
  const tagMerges = requireRows(normalizedValue.tagMerges, "tagMerges");
  const analyses = requireRows(normalizedValue.analyses, "analyses");
  const knowledgePoints = requireRows(
    normalizedValue.knowledgePoints,
    "knowledgePoints",
  );
  const evidenceSpans = requireRows(
    normalizedValue.evidenceSpans,
    "evidenceSpans",
  );
  const corrections = requireRows(normalizedValue.corrections, "corrections");
  const overviewCorrections = requireRows(
    normalizedValue.overviewCorrections,
    "overviewCorrections",
  );
  const duplicateSuggestions = requireRows(
    normalizedValue.duplicateSuggestions,
    "duplicateSuggestions",
  );
  const duplicateConsolidations = requireRows(
    normalizedValue.duplicateConsolidations,
    "duplicateConsolidations",
  );
  const relationSuggestions = requireRows(
    normalizedValue.relationSuggestions,
    "relationSuggestions",
  );
  const relationSuggestionEvidence = requireRows(
    normalizedValue.relationSuggestionEvidence,
    "relationSuggestionEvidence",
  );
  const knowledgeRelations = requireRows(
    normalizedValue.knowledgeRelations,
    "knowledgeRelations",
  );
  const coverageAnalyses = requireRows(
    normalizedValue.coverageAnalyses,
    "coverageAnalyses",
  );
  const coverageAnalysisPoints = requireRows(
    normalizedValue.coverageAnalysisPoints,
    "coverageAnalysisPoints",
  );
  const coverageAnalysisRecords = requireRows(
    normalizedValue.coverageAnalysisRecords,
    "coverageAnalysisRecords",
  );
  const coverageAnalysisItems = requireRows(
    normalizedValue.coverageAnalysisItems,
    "coverageAnalysisItems",
  );
  const coverageItemPoints = requireRows(
    normalizedValue.coverageItemPoints,
    "coverageItemPoints",
  );
  const coverageItemRecords = requireRows(
    normalizedValue.coverageItemRecords,
    "coverageItemRecords",
  );
  const concepts = requireRows(normalizedValue.concepts, "concepts");
  const conceptRevisions = requireRows(
    normalizedValue.conceptRevisions,
    "conceptRevisions",
  );
  const conceptMemberships = requireRows(
    normalizedValue.conceptMemberships,
    "conceptMemberships",
  );
  const conceptActivity = requireRows(
    normalizedValue.conceptActivity,
    "conceptActivity",
  );

  records.forEach(validateRecordRow);
  fragmentRevisions.forEach(validateFragmentRevisionRow);
  tags.forEach(validateTagRow);
  tagAssignments.forEach(validateTagAssignmentRow);
  tagAliases.forEach(validateTagAliasRow);
  tagMerges.forEach(validateTagMergeRow);
  analyses.forEach(validateAnalysisRow);
  knowledgePoints.forEach(validateKnowledgePointRow);
  evidenceSpans.forEach(validateEvidenceSpanRow);
  corrections.forEach(validateCorrectionRow);
  overviewCorrections.forEach(validateOverviewCorrectionRow);
  duplicateSuggestions.forEach(validateDuplicateSuggestionRow);
  duplicateConsolidations.forEach(validateDuplicateConsolidationRow);
  relationSuggestions.forEach(validateRelationSuggestionRow);
  relationSuggestionEvidence.forEach(validateRelationEvidenceRow);
  knowledgeRelations.forEach(validateKnowledgeRelationRow);
  coverageAnalyses.forEach(validateCoverageAnalysisRow);
  coverageAnalysisPoints.forEach(validateCoverageAnalysisPointRow);
  coverageAnalysisRecords.forEach(validateCoverageAnalysisRecordRow);
  coverageAnalysisItems.forEach(validateCoverageAnalysisItemRow);
  coverageItemPoints.forEach(validateCoverageItemPointRow);
  coverageItemRecords.forEach(validateCoverageItemRecordRow);
  concepts.forEach(validateConceptRow);
  conceptRevisions.forEach(validateConceptRevisionRow);
  conceptMemberships.forEach(validateConceptMembershipRow);
  conceptActivity.forEach(validateConceptActivityRow);

  const snapshot = normalizedValue as unknown as DomainSnapshot;

  validateSnapshotReferences(snapshot);

  return snapshot;
}

function validateRecordRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "current_fragment_revision_id",
    "archived_at",
    "created_at",
    "updated_at",
    "current_analysis_revision_id",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "current_fragment_revision_id");
  requireNullableUuid(row, "current_analysis_revision_id");
  requireNullableTimestamp(row, "archived_at");
  requireTimestamp(row, "created_at");
  requireTimestamp(row, "updated_at");
}

function validateFragmentRevisionRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "record_id",
    "revision_number",
    "content",
    "grapheme_count",
    "created_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "record_id");
  requireInteger(row, "revision_number", 1);
  requireNonEmptyString(row, "content");
  requireInteger(row, "grapheme_count", 1, 1000);
  requireTimestamp(row, "created_at");
}

function validateTagRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "display_name",
    "normalized_name",
    "origin",
    "approval_status",
    "user_approved_at",
    "archived_at",
    "created_at",
    "updated_at",
  ]);
  requireUuid(row, "id");
  requireNonEmptyString(row, "display_name");
  requireNonEmptyString(row, "normalized_name");
  requireEnum(row, "origin", ["USER_CREATED", "AI_CREATED"]);
  requireEnum(row, "approval_status", [
    "CANDIDATE",
    "USER_APPROVED",
    "ARCHIVED",
  ]);
  requireNullableTimestamp(row, "user_approved_at");
  requireNullableTimestamp(row, "archived_at");
  requireTimestamp(row, "created_at");
  requireTimestamp(row, "updated_at");

  if (
    (row.origin === "USER_CREATED" && row.approval_status === "CANDIDATE") ||
    (row.approval_status === "CANDIDATE" &&
      (row.user_approved_at !== null || row.archived_at !== null)) ||
    (row.approval_status === "USER_APPROVED" &&
      (row.user_approved_at === null || row.archived_at !== null)) ||
    (row.approval_status === "ARCHIVED" &&
      (row.user_approved_at === null || row.archived_at === null))
  ) {
    throw new Error("tag lifecycle is invalid");
  }
}

function validateTagAssignmentRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "record_id",
    "tag_id",
    "assigned_by",
    "status",
    "created_at",
    "knowledge_point_id",
    "analysis_revision_id",
    "raw_label",
  ]);
  requireUuid(row, "id");
  requireNullableUuid(row, "record_id");
  requireUuid(row, "tag_id");
  requireEnum(row, "assigned_by", ["USER", "AI"]);
  requireEnum(row, "status", ["ACTIVE", "SUPPRESSED"]);
  requireTimestamp(row, "created_at");
  requireNullableUuid(row, "knowledge_point_id");
  requireNullableUuid(row, "analysis_revision_id");

  if (
    row.raw_label !== null &&
    (typeof row.raw_label !== "string" || row.raw_label.length === 0)
  ) {
    throw new Error("raw_label must be a nullable non-empty string");
  }

  const hasRecord = row.record_id !== null;
  const hasKnowledgePoint = row.knowledge_point_id !== null;

  if (
    hasRecord === hasKnowledgePoint ||
    (row.assigned_by === "USER" &&
      (!hasRecord ||
        row.status !== "ACTIVE" ||
        row.analysis_revision_id !== null ||
        row.raw_label !== null)) ||
    (row.assigned_by === "AI" &&
      (!hasKnowledgePoint ||
        row.analysis_revision_id === null ||
        row.raw_label === null))
  ) {
    throw new Error("tag assignment target is invalid");
  }
}

function validateTagAliasRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "tag_id",
    "display_name",
    "normalized_name",
    "created_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "tag_id");
  requireNonEmptyString(row, "display_name");
  requireNonEmptyString(row, "normalized_name");
  requireTimestamp(row, "created_at");
}

function validateTagMergeRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "operation_id",
    "source_tag_id",
    "target_tag_id",
    "created_at",
    "undone_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "operation_id");
  requireUuid(row, "source_tag_id");
  requireUuid(row, "target_tag_id");
  requireTimestamp(row, "created_at");
  requireNullableTimestamp(row, "undone_at");

  if (row.source_tag_id === row.target_tag_id) {
    throw new Error("tag merge source and target must differ");
  }
}

function validateAnalysisRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "record_id",
    "fragment_revision_id",
    "text_model",
    "title",
    "summary",
    "status",
    "generated_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "record_id");
  requireUuid(row, "fragment_revision_id");
  requireNonEmptyString(row, "text_model");
  requireNonEmptyString(row, "title");
  requireNonEmptyString(row, "summary");
  requireEnum(row, "status", [
    "GENERATED",
    "ACTIVE",
    "SUPERSEDED",
    "DISCARDED",
    "STALE",
  ]);
  requireTimestamp(row, "generated_at");
}

function validateKnowledgePointRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "record_id",
    "fragment_revision_id",
    "analysis_revision_id",
    "position",
    "ai_title",
    "ai_body",
    "publication_status",
    "usage_status",
    "created_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "record_id");
  requireUuid(row, "fragment_revision_id");
  requireUuid(row, "analysis_revision_id");
  requireInteger(row, "position", 1, 5);
  requireNonEmptyString(row, "ai_title");
  requireNonEmptyString(row, "ai_body");
  requireEnum(row, "publication_status", [
    "AI_CREATED",
    "PENDING_REVIEW",
    "AUTO_PUBLISHED",
    "CONFIRMED",
    "REJECTED",
  ]);
  requireEnum(row, "usage_status", ["INCLUDED", "EXCLUDED"]);
  requireTimestamp(row, "created_at");
}

function validateEvidenceSpanRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "knowledge_point_id",
    "fragment_revision_id",
    "position",
    "start_offset",
    "end_offset",
    "quote",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "knowledge_point_id");
  requireUuid(row, "fragment_revision_id");
  requireInteger(row, "position", 1);
  requireInteger(row, "start_offset", 0);
  requireInteger(row, "end_offset", 1);
  requireNonEmptyString(row, "quote");

  if ((row.end_offset as number) <= (row.start_offset as number)) {
    throw new Error("evidence offsets are invalid");
  }
}

function validateCorrectionRow(row: DomainRow): void {
  requireExactKeys(row, ["knowledge_point_id", "title", "body", "updated_at"]);
  requireUuid(row, "knowledge_point_id");
  requireNonEmptyString(row, "title");
  requireNonEmptyString(row, "body");
  requireTimestamp(row, "updated_at");
}

function validateOverviewCorrectionRow(row: DomainRow): void {
  requireExactKeys(row, [
    "record_id",
    "analysis_revision_id",
    "title",
    "summary",
    "updated_at",
  ]);
  requireUuid(row, "record_id");
  requireUuid(row, "analysis_revision_id");
  requireNonEmptyString(row, "title");
  requireNonEmptyString(row, "summary");
  requireTimestamp(row, "updated_at");
}

function validateDuplicateSuggestionRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "source_a_type",
    "source_a_id",
    "source_a_record_id",
    "source_a_fingerprint",
    "source_b_type",
    "source_b_id",
    "source_b_record_id",
    "source_b_fingerprint",
    "detection_kind",
    "similarity_score",
    "reason",
    "status",
    "primary_source_id",
    "configuration_version",
    "created_at",
    "updated_at",
    "decided_at",
  ]);
  requireUuid(row, "id");
  requireEnum(row, "source_a_type", ["ORIGINAL", "KNOWLEDGE_POINT"]);
  requireUuid(row, "source_a_id");
  requireUuid(row, "source_a_record_id");
  requireFingerprint(row, "source_a_fingerprint");
  requireEnum(row, "source_b_type", ["ORIGINAL", "KNOWLEDGE_POINT"]);
  requireUuid(row, "source_b_id");
  requireUuid(row, "source_b_record_id");
  requireFingerprint(row, "source_b_fingerprint");
  requireEnum(row, "detection_kind", ["EXACT", "SEMANTIC"]);
  requireNumberInRange(row, "similarity_score", 0, 1);
  requireNonEmptyString(row, "reason");
  requireEnum(row, "status", [
    "PENDING_REVIEW",
    "ACCEPTED",
    "REJECTED",
    "REMOVED",
  ]);
  requireNullableUuid(row, "primary_source_id");
  requireNullableInteger(row, "configuration_version", 1);
  requireTimestamp(row, "created_at");
  requireTimestamp(row, "updated_at");
  requireNullableTimestamp(row, "decided_at");

  const primaryMatches =
    row.primary_source_id === row.source_a_id ||
    row.primary_source_id === row.source_b_id;

  if (
    row.source_a_type !== row.source_b_type ||
    row.source_a_id === row.source_b_id ||
    row.source_a_record_id === row.source_b_record_id ||
    (row.detection_kind === "EXACT" && row.similarity_score !== 1) ||
    (row.status === "PENDING_REVIEW" &&
      (row.primary_source_id !== null || row.decided_at !== null)) ||
    (row.status === "REJECTED" &&
      (row.primary_source_id !== null || row.decided_at === null)) ||
    ((row.status === "ACCEPTED" || row.status === "REMOVED") &&
      (!primaryMatches || row.decided_at === null))
  ) {
    throw new Error("duplicate suggestion lifecycle is invalid");
  }
}

function validateDuplicateConsolidationRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "suggestion_id",
    "primary_source_id",
    "created_at",
    "removed_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "suggestion_id");
  requireUuid(row, "primary_source_id");
  requireTimestamp(row, "created_at");
  requireNullableTimestamp(row, "removed_at");

  if (
    row.removed_at !== null &&
    Date.parse(row.removed_at as string) < Date.parse(row.created_at as string)
  ) {
    throw new Error("duplicate consolidation lifecycle is invalid");
  }
}

function validateRelationSuggestionRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "pair_key",
    "input_fingerprint",
    "source_knowledge_point_id",
    "target_knowledge_point_id",
    "source_content_fingerprint",
    "target_content_fingerprint",
    "relation_type",
    "description",
    "reason",
    "confidence",
    "model_configuration_version",
    "text_model",
    "status",
    "created_at",
    "updated_at",
    "decided_at",
  ]);
  requireUuid(row, "id");
  requireNonEmptyString(row, "pair_key");
  requireFingerprint(row, "input_fingerprint");
  requireUuid(row, "source_knowledge_point_id");
  requireUuid(row, "target_knowledge_point_id");
  requireFingerprint(row, "source_content_fingerprint");
  requireFingerprint(row, "target_content_fingerprint");
  requireRelationType(row, "relation_type");
  requireNonEmptyString(row, "description");
  requireNonEmptyString(row, "reason");
  requireNumberInRange(row, "confidence", 0, 1);
  requireInteger(row, "model_configuration_version", 1);
  requireNonEmptyString(row, "text_model");
  requireEnum(row, "status", [
    "PENDING_REVIEW",
    "CONFIRMED",
    "REJECTED",
    "REMOVED",
  ]);
  requireTimestamp(row, "created_at");
  requireTimestamp(row, "updated_at");
  requireNullableTimestamp(row, "decided_at");

  if (
    row.source_knowledge_point_id === row.target_knowledge_point_id ||
    (row.status === "PENDING_REVIEW") !== (row.decided_at === null)
  ) {
    throw new Error("relation suggestion lifecycle is invalid");
  }
}

function validateRelationEvidenceRow(row: DomainRow): void {
  requireExactKeys(row, ["suggestion_id", "evidence_span_id", "side"]);
  requireUuid(row, "suggestion_id");
  requireUuid(row, "evidence_span_id");
  requireEnum(row, "side", ["SOURCE", "TARGET"]);
}

function validateKnowledgeRelationRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "suggestion_id",
    "source_knowledge_point_id",
    "target_knowledge_point_id",
    "relation_type",
    "description",
    "confirmed_at",
    "removed_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "suggestion_id");
  requireUuid(row, "source_knowledge_point_id");
  requireUuid(row, "target_knowledge_point_id");
  requireRelationType(row, "relation_type");
  requireNonEmptyString(row, "description");
  requireTimestamp(row, "confirmed_at");
  requireNullableTimestamp(row, "removed_at");

  if (
    row.source_knowledge_point_id === row.target_knowledge_point_id ||
    (row.removed_at !== null &&
      Date.parse(row.removed_at as string) < Date.parse(row.confirmed_at as string))
  ) {
    throw new Error("knowledge relation lifecycle is invalid");
  }
}

function validateCoverageAnalysisRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "topic",
    "framework_summary",
    "caveat",
    "input_count",
    "model_configuration_version",
    "text_model",
    "input_kind",
    "status",
    "failure_code",
    "failure_message",
    "attempt_count",
    "started_at",
    "completed_at",
    "created_at",
  ]);
  requireUuid(row, "id");
  requireNonEmptyString(row, "topic");
  if (row.framework_summary !== null) {
    requireNonEmptyString(row, "framework_summary");
  }
  if (row.caveat !== null) {
    requireNonEmptyString(row, "caveat");
  }
  requireInteger(row, "input_count", 1, 50);
  requireInteger(row, "model_configuration_version", 1);
  requireNonEmptyString(row, "text_model");
  requireEnum(row, "input_kind", ["KNOWLEDGE_POINTS", "RECORDS"]);
  requireEnum(row, "status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
  requireInteger(row, "attempt_count", 1);
  requireNullableTimestamp(row, "started_at");
  requireNullableTimestamp(row, "completed_at");
  requireTimestamp(row, "created_at");

  const hasFailure =
    typeof row.failure_code === "string" &&
    row.failure_code.length > 0 &&
    typeof row.failure_message === "string" &&
    row.failure_message.length > 0;
  const hasResult =
    typeof row.framework_summary === "string" &&
    row.framework_summary.length > 0 &&
    typeof row.caveat === "string" &&
    row.caveat.length > 0;
  const validLifecycle =
    (row.status === "QUEUED" &&
      !hasResult &&
      !hasFailure &&
      row.started_at === null &&
      row.completed_at === null) ||
    (row.status === "RUNNING" &&
      !hasResult &&
      !hasFailure &&
      row.started_at !== null &&
      row.completed_at === null) ||
    (row.status === "SUCCEEDED" &&
      hasResult &&
      !hasFailure &&
      row.started_at !== null &&
      row.completed_at !== null) ||
    (row.status === "FAILED" &&
      !hasResult &&
      hasFailure &&
      row.completed_at !== null);

  if (
    !validLifecycle ||
    (row.failure_code === null) !== (row.failure_message === null)
  ) {
    throw new Error("coverage analysis lifecycle is invalid");
  }
}

function validateCoverageAnalysisPointRow(row: DomainRow): void {
  requireExactKeys(row, [
    "analysis_id",
    "knowledge_point_id",
    "content_fingerprint",
    "position",
  ]);
  requireUuid(row, "analysis_id");
  requireUuid(row, "knowledge_point_id");
  requireFingerprint(row, "content_fingerprint");
  requireInteger(row, "position", 1, 50);
}

function validateCoverageAnalysisRecordRow(row: DomainRow): void {
  requireExactKeys(row, [
    "analysis_id",
    "record_id",
    "fragment_revision_id",
    "title",
    "content_fingerprint",
    "position",
  ]);
  requireUuid(row, "analysis_id");
  requireUuid(row, "record_id");
  requireUuid(row, "fragment_revision_id");
  requireNonEmptyString(row, "title");
  requireFingerprint(row, "content_fingerprint");
  requireInteger(row, "position", 1, 50);
}

function validateCoverageAnalysisItemRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "analysis_id",
    "kind",
    "position",
    "title",
    "assessment",
    "recommendation",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "analysis_id");
  requireEnum(row, "kind", ["COVERED", "POSSIBLE_GAP"]);
  requireInteger(row, "position", 1);
  requireNonEmptyString(row, "title");
  requireNonEmptyString(row, "assessment");

  if (
    (row.kind === "COVERED" && row.recommendation !== null) ||
    (row.kind === "POSSIBLE_GAP" &&
      (typeof row.recommendation !== "string" ||
        row.recommendation.length === 0))
  ) {
    throw new Error("coverage item recommendation is invalid");
  }
}

function validateCoverageItemPointRow(row: DomainRow): void {
  requireExactKeys(row, ["item_id", "knowledge_point_id"]);
  requireUuid(row, "item_id");
  requireUuid(row, "knowledge_point_id");
}

function validateCoverageItemRecordRow(row: DomainRow): void {
  requireExactKeys(row, ["item_id", "record_id"]);
  requireUuid(row, "item_id");
  requireUuid(row, "record_id");
}

function validateConceptRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "current_revision_id",
    "normalized_name",
    "archived_at",
    "created_at",
    "updated_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "current_revision_id");
  requireNonEmptyString(row, "normalized_name");
  requireNullableTimestamp(row, "archived_at");
  requireTimestamp(row, "created_at");
  requireTimestamp(row, "updated_at");

  if (
    timestampValue(row.updated_at) < timestampValue(row.created_at) ||
    (row.archived_at !== null &&
      timestampValue(row.archived_at) < timestampValue(row.created_at))
  ) {
    throw new Error("concept lifecycle is invalid");
  }
}

function validateConceptRevisionRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "concept_id",
    "revision_number",
    "display_name",
    "normalized_name",
    "description",
    "created_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "concept_id");
  requireInteger(row, "revision_number", 1);
  requireNonEmptyString(row, "display_name");
  requireNonEmptyString(row, "normalized_name");
  requireNonEmptyString(row, "description");
  requireTimestamp(row, "created_at");
}

function validateConceptMembershipRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "concept_id",
    "knowledge_point_id",
    "origin",
    "created_at",
    "removed_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "concept_id");
  requireUuid(row, "knowledge_point_id");
  requireEnum(row, "origin", ["USER"]);
  requireTimestamp(row, "created_at");
  requireNullableTimestamp(row, "removed_at");

  if (
    row.removed_at !== null &&
    timestampValue(row.removed_at) < timestampValue(row.created_at)
  ) {
    throw new Error("concept membership lifecycle is invalid");
  }
}

function validateConceptActivityRow(row: DomainRow): void {
  requireExactKeys(row, [
    "id",
    "concept_id",
    "sequence_number",
    "kind",
    "revision_id",
    "membership_id",
    "occurred_at",
  ]);
  requireUuid(row, "id");
  requireUuid(row, "concept_id");
  requireInteger(row, "sequence_number", 1);
  requireEnum(row, "kind", [
    "CREATED",
    "UPDATED",
    "ARCHIVED",
    "RESTORED",
    "MEMBER_ADDED",
    "MEMBER_REMOVED",
    "MEMBER_RESTORED",
  ]);
  requireNullableUuid(row, "revision_id");
  requireNullableUuid(row, "membership_id");
  requireTimestamp(row, "occurred_at");

  const revisionActivity = row.kind === "CREATED" || row.kind === "UPDATED";
  const membershipActivity =
    row.kind === "MEMBER_ADDED" ||
    row.kind === "MEMBER_REMOVED" ||
    row.kind === "MEMBER_RESTORED";

  if (
    (revisionActivity &&
      (row.revision_id === null || row.membership_id !== null)) ||
    (membershipActivity &&
      (row.revision_id !== null || row.membership_id === null)) ||
    (!revisionActivity &&
      !membershipActivity &&
      (row.revision_id !== null || row.membership_id !== null))
  ) {
    throw new Error("concept activity target is invalid");
  }
}

function requireRelationType(row: DomainRow, key: string): void {
  requireEnum(row, key, [
    "SIMILAR",
    "CONTRASTS",
    "PREREQUISITE",
    "EXTENDS",
    "APPLIES",
    "ANALOGY",
  ]);
}

function validateSnapshotReferences(snapshot: DomainSnapshot): void {
  assertUnique(snapshot.records, (row) => row.id, "record id");
  assertUnique(
    snapshot.fragmentRevisions,
    (row) => row.id,
    "fragment revision id",
  );
  assertUnique(snapshot.tags, (row) => row.id, "tag id");
  assertUnique(snapshot.tags, (row) => row.normalized_name, "tag name");
  assertUnique(snapshot.tagAssignments, (row) => row.id, "tag assignment id");
  assertUnique(snapshot.tagAliases, (row) => row.id, "tag alias id");
  assertUnique(snapshot.tagAliases, (row) => row.normalized_name, "tag alias name");
  assertUnique(snapshot.tagMerges, (row) => row.id, "tag merge id");
  assertUnique(snapshot.analyses, (row) => row.id, "analysis id");
  assertUnique(snapshot.knowledgePoints, (row) => row.id, "knowledge point id");
  assertUnique(snapshot.evidenceSpans, (row) => row.id, "evidence id");
  assertUnique(
    snapshot.corrections,
    (row) => row.knowledge_point_id,
    "correction knowledge point",
  );
  assertUnique(
    snapshot.overviewCorrections,
    (row) => row.record_id,
    "overview correction record",
  );
  assertUnique(
    snapshot.duplicateSuggestions,
    (row) => row.id,
    "duplicate suggestion id",
  );
  assertUnique(
    snapshot.duplicateSuggestions,
    (row) =>
      `${row.detection_kind}:${row.source_a_type}:${row.source_a_id}:` +
      `${row.source_a_fingerprint}:${row.source_b_type}:${row.source_b_id}:` +
      row.source_b_fingerprint,
    "duplicate suggestion input",
  );
  assertUnique(
    snapshot.duplicateConsolidations,
    (row) => row.id,
    "duplicate consolidation id",
  );
  assertUnique(
    snapshot.duplicateConsolidations,
    (row) => row.suggestion_id,
    "duplicate consolidation suggestion",
  );
  assertUnique(
    snapshot.relationSuggestions,
    (row) => row.id,
    "relation suggestion id",
  );
  assertUnique(
    snapshot.relationSuggestions,
    (row) => `${row.pair_key}:${row.input_fingerprint}`,
    "relation suggestion input",
  );
  assertUnique(
    snapshot.relationSuggestionEvidence,
    (row) => `${row.suggestion_id}:${row.evidence_span_id}`,
    "relation suggestion evidence",
  );
  assertUnique(
    snapshot.knowledgeRelations,
    (row) => row.id,
    "knowledge relation id",
  );
  assertUnique(
    snapshot.knowledgeRelations,
    (row) => row.suggestion_id,
    "knowledge relation suggestion",
  );
  assertUnique(
    snapshot.coverageAnalyses,
    (row) => row.id,
    "coverage analysis id",
  );
  assertUnique(
    snapshot.coverageAnalysisPoints,
    (row) => `${row.analysis_id}:${row.knowledge_point_id}`,
    "coverage analysis point",
  );
  assertUnique(
    snapshot.coverageAnalysisRecords,
    (row) => `${row.analysis_id}:${row.record_id}`,
    "coverage analysis record",
  );
  assertUnique(
    snapshot.coverageAnalysisRecords,
    (row) => `${row.analysis_id}:${row.position}`,
    "coverage analysis record position",
  );
  assertUnique(
    snapshot.coverageAnalysisPoints,
    (row) => `${row.analysis_id}:${row.position}`,
    "coverage analysis point position",
  );
  assertUnique(
    snapshot.coverageAnalysisItems,
    (row) => row.id,
    "coverage analysis item id",
  );
  assertUnique(
    snapshot.coverageAnalysisItems,
    (row) => `${row.analysis_id}:${row.position}`,
    "coverage analysis item position",
  );
  assertUnique(
    snapshot.coverageItemPoints,
    (row) => `${row.item_id}:${row.knowledge_point_id}`,
    "coverage item point",
  );
  assertUnique(
    snapshot.coverageItemRecords,
    (row) => `${row.item_id}:${row.record_id}`,
    "coverage item record",
  );
  assertUnique(
    snapshot.fragmentRevisions,
    (row) => `${row.record_id}:${row.revision_number}`,
    "record revision number",
  );
  assertUnique(
    snapshot.knowledgePoints,
    (row) => `${row.analysis_revision_id}:${row.position}`,
    "analysis knowledge point position",
  );
  assertUnique(
    snapshot.evidenceSpans,
    (row) => `${row.knowledge_point_id}:${row.position}`,
    "knowledge point evidence position",
  );
  assertUnique(
    snapshot.tagAssignments,
    (row) =>
      `${row.record_id ?? row.knowledge_point_id}:${row.tag_id}`,
    "tag assignment target",
  );
  assertUnique(snapshot.concepts, (row) => row.id, "concept id");
  assertUnique(
    snapshot.concepts,
    (row) => row.normalized_name,
    "concept name",
  );
  assertUnique(snapshot.conceptRevisions, (row) => row.id, "concept revision id");
  assertUnique(
    snapshot.conceptRevisions,
    (row) => `${row.concept_id}:${row.revision_number}`,
    "concept revision number",
  );
  assertUnique(
    snapshot.conceptMemberships,
    (row) => row.id,
    "concept membership id",
  );
  assertUnique(
    snapshot.conceptMemberships,
    (row) => `${row.concept_id}:${row.knowledge_point_id}`,
    "concept membership point",
  );
  assertUnique(snapshot.conceptActivity, (row) => row.id, "concept activity id");
  assertUnique(
    snapshot.conceptActivity,
    (row) => `${row.concept_id}:${row.sequence_number}`,
    "concept activity sequence",
  );

  const records = new Map(snapshot.records.map((row) => [row.id, row]));
  const revisions = new Map(
    snapshot.fragmentRevisions.map((row) => [row.id, row]),
  );
  const tags = new Map(snapshot.tags.map((row) => [row.id, row]));
  const analyses = new Map(snapshot.analyses.map((row) => [row.id, row]));
  const points = new Map(snapshot.knowledgePoints.map((row) => [row.id, row]));
  const evidenceSpans = new Map(
    snapshot.evidenceSpans.map((row) => [row.id, row]),
  );
  const duplicateSuggestions = new Map(
    snapshot.duplicateSuggestions.map((row) => [row.id, row]),
  );
  const relationSuggestions = new Map(
    snapshot.relationSuggestions.map((row) => [row.id, row]),
  );
  const coverageAnalyses = new Map(
    snapshot.coverageAnalyses.map((row) => [row.id, row]),
  );
  const coverageItems = new Map(
    snapshot.coverageAnalysisItems.map((row) => [row.id, row]),
  );
  const concepts = new Map(snapshot.concepts.map((row) => [row.id, row]));
  const conceptRevisions = new Map(
    snapshot.conceptRevisions.map((row) => [row.id, row]),
  );
  const conceptMemberships = new Map(
    snapshot.conceptMemberships.map((row) => [row.id, row]),
  );

  for (const revision of snapshot.conceptRevisions) {
    if (!concepts.has(revision.concept_id)) {
      throw new Error("concept revision reference is invalid");
    }
  }

  for (const concept of snapshot.concepts) {
    const revisionsForConcept = snapshot.conceptRevisions
      .filter((revision) => revision.concept_id === concept.id)
      .sort((left, right) => left.revision_number - right.revision_number);
    const currentRevision = conceptRevisions.get(concept.current_revision_id);

    if (
      revisionsForConcept.length === 0 ||
      revisionsForConcept.some(
        (revision, index) => revision.revision_number !== index + 1,
      ) ||
      !currentRevision ||
      currentRevision.concept_id !== concept.id ||
      currentRevision.normalized_name !== concept.normalized_name ||
      revisionsForConcept.at(-1)?.id !== currentRevision.id
    ) {
      throw new Error("concept current revision is invalid");
    }
  }

  for (const membership of snapshot.conceptMemberships) {
    if (
      !concepts.has(membership.concept_id) ||
      !points.has(membership.knowledge_point_id)
    ) {
      throw new Error("concept membership reference is invalid");
    }
  }

  for (const concept of snapshot.concepts) {
    const activity = snapshot.conceptActivity
      .filter((entry) => entry.concept_id === concept.id)
      .sort((left, right) => left.sequence_number - right.sequence_number);
    const firstRevision = snapshot.conceptRevisions.find(
      (revision) =>
        revision.concept_id === concept.id && revision.revision_number === 1,
    );

    if (
      activity.length === 0 ||
      activity.some((entry, index) => entry.sequence_number !== index + 1) ||
      activity[0]?.kind !== "CREATED" ||
      activity[0]?.revision_id !== firstRevision?.id
    ) {
      throw new Error("concept activity sequence is invalid");
    }

    const lifecycleActivity = activity.filter(
      (entry) => entry.kind === "ARCHIVED" || entry.kind === "RESTORED",
    );
    const latestLifecycle = lifecycleActivity.at(-1);

    if (
      (concept.archived_at === null && latestLifecycle?.kind === "ARCHIVED") ||
      (concept.archived_at !== null && latestLifecycle?.kind !== "ARCHIVED")
    ) {
      throw new Error("concept archive activity is invalid");
    }
  }

  for (const entry of snapshot.conceptActivity) {
    const revision = entry.revision_id
      ? conceptRevisions.get(entry.revision_id)
      : undefined;
    const membership = entry.membership_id
      ? conceptMemberships.get(entry.membership_id)
      : undefined;

    if (
      !concepts.has(entry.concept_id) ||
      (entry.revision_id !== null && revision?.concept_id !== entry.concept_id) ||
      (entry.membership_id !== null &&
        membership?.concept_id !== entry.concept_id)
    ) {
      throw new Error("concept activity reference is invalid");
    }
  }

  for (const revision of snapshot.conceptRevisions) {
    const matchingActivity = snapshot.conceptActivity.filter(
      (entry) => entry.revision_id === revision.id,
    );
    const expectedKind = revision.revision_number === 1 ? "CREATED" : "UPDATED";

    if (matchingActivity.length !== 1 || matchingActivity[0]?.kind !== expectedKind) {
      throw new Error("concept revision activity is invalid");
    }
  }

  for (const membership of snapshot.conceptMemberships) {
    const membershipActivity = snapshot.conceptActivity
      .filter((entry) => entry.membership_id === membership.id)
      .sort((left, right) => left.sequence_number - right.sequence_number);

    if (
      membershipActivity[0]?.kind !== "MEMBER_ADDED" ||
      (membership.removed_at === null &&
        membershipActivity.at(-1)?.kind === "MEMBER_REMOVED") ||
      (membership.removed_at !== null &&
        membershipActivity.at(-1)?.kind !== "MEMBER_REMOVED")
    ) {
      throw new Error("concept membership activity is invalid");
    }
  }

  for (const alias of snapshot.tagAliases) {
    const tag = tags.get(alias.tag_id);

    if (
      !tag ||
      tag.approval_status !== "USER_APPROVED" ||
      tag.archived_at !== null ||
      snapshot.tags.some(
        (candidate) => candidate.normalized_name === alias.normalized_name,
      )
    ) {
      throw new Error("tag alias reference is invalid");
    }
  }

  const activeMerges = snapshot.tagMerges.filter((merge) => merge.undone_at === null);

  assertUnique(activeMerges, (row) => row.source_tag_id, "active tag merge source");

  const activeSourceIds = new Set(activeMerges.map((merge) => merge.source_tag_id));
  const activeTargetIds = new Set(activeMerges.map((merge) => merge.target_tag_id));
  const operationTargets = new Map<string, string>();

  for (const merge of snapshot.tagMerges) {
    const source = tags.get(merge.source_tag_id);
    const target = tags.get(merge.target_tag_id);
    const existingTarget = operationTargets.get(merge.operation_id);

    if (!source || !target || (existingTarget && existingTarget !== target.id)) {
      throw new Error("tag merge reference is invalid");
    }

    operationTargets.set(merge.operation_id, target.id);

    if (
      merge.undone_at === null &&
      (source.archived_at !== null ||
        target.approval_status !== "USER_APPROVED" ||
        target.archived_at !== null)
    ) {
      throw new Error("active tag merge lifecycle is invalid");
    }
  }

  if ([...activeSourceIds].some((id) => activeTargetIds.has(id))) {
    throw new Error("active tag merge chains are not supported");
  }

  for (const revision of snapshot.fragmentRevisions) {
    if (!records.has(revision.record_id)) {
      throw new Error("fragment revision record reference is invalid");
    }
  }

  for (const record of snapshot.records) {
    const currentRevision = revisions.get(record.current_fragment_revision_id);
    const recordRevisions = snapshot.fragmentRevisions.filter(
      (revision) => revision.record_id === record.id,
    );
    const latestRevision = recordRevisions.reduce<
      FragmentRevisionSnapshotRow | undefined
    >(
      (latest, revision) =>
        !latest || revision.revision_number > latest.revision_number
          ? revision
          : latest,
      undefined,
    );

    if (
      !currentRevision ||
      currentRevision.record_id !== record.id ||
      latestRevision?.id !== currentRevision.id
    ) {
      throw new Error("record current fragment revision is invalid");
    }

    if (record.current_analysis_revision_id) {
      const currentAnalysis = analyses.get(record.current_analysis_revision_id);

      if (
        !currentAnalysis ||
        currentAnalysis.record_id !== record.id ||
        currentAnalysis.status !== "ACTIVE"
      ) {
        throw new Error("record current analysis revision is invalid");
      }
    }

    const hasRequiredTag = snapshot.tagAssignments.some((assignment) => {
      const tag = tags.get(assignment.tag_id);

      return (
        assignment.record_id === record.id &&
        assignment.assigned_by === "USER" &&
        assignment.status === "ACTIVE" &&
        tag?.approval_status === "USER_APPROVED"
      );
    });

    if (!hasRequiredTag) {
      throw new Error("record requires an active user-approved tag");
    }
  }

  for (const analysis of snapshot.analyses) {
    const revision = revisions.get(analysis.fragment_revision_id);

    if (
      !records.has(analysis.record_id) ||
      !revision ||
      revision.record_id !== analysis.record_id
    ) {
      throw new Error("analysis source reference is invalid");
    }
  }

  for (const point of snapshot.knowledgePoints) {
    const analysis = analyses.get(point.analysis_revision_id);
    const revision = revisions.get(point.fragment_revision_id);

    if (
      !records.has(point.record_id) ||
      !analysis ||
      analysis.record_id !== point.record_id ||
      analysis.fragment_revision_id !== point.fragment_revision_id ||
      !revision ||
      revision.record_id !== point.record_id
    ) {
      throw new Error("knowledge point reference is invalid");
    }

    if (
      !snapshot.evidenceSpans.some(
        (evidence) => evidence.knowledge_point_id === point.id,
      )
    ) {
      throw new Error("knowledge point evidence is missing");
    }
  }

  for (const evidence of snapshot.evidenceSpans) {
    const point = points.get(evidence.knowledge_point_id);
    const revision = revisions.get(evidence.fragment_revision_id);

    if (
      !point ||
      !revision ||
      evidence.fragment_revision_id !== point.fragment_revision_id ||
      evidence.end_offset > revision.content.length ||
      revision.content.slice(evidence.start_offset, evidence.end_offset) !==
        evidence.quote
    ) {
      throw new Error("evidence reference is invalid");
    }
  }

  for (const correction of snapshot.corrections) {
    if (!points.has(correction.knowledge_point_id)) {
      throw new Error("correction reference is invalid");
    }
  }

  for (const correction of snapshot.overviewCorrections) {
    const record = records.get(correction.record_id);
    const analysis = analyses.get(correction.analysis_revision_id);

    if (
      !record ||
      !analysis ||
      analysis.record_id !== record.id ||
      analysis.status !== "ACTIVE" ||
      record.current_analysis_revision_id !== analysis.id
    ) {
      throw new Error("overview correction reference is invalid");
    }
  }

  for (const assignment of snapshot.tagAssignments) {
    const point = assignment.knowledge_point_id
      ? points.get(assignment.knowledge_point_id)
      : undefined;

    if (
      !tags.has(assignment.tag_id) ||
      (assignment.record_id !== null && !records.has(assignment.record_id)) ||
      (assignment.knowledge_point_id !== null &&
        (!point || assignment.analysis_revision_id !== point.analysis_revision_id))
    ) {
      throw new Error("tag assignment reference is invalid");
    }
  }

  for (const suggestion of snapshot.duplicateSuggestions) {
    const sourceARecord = records.get(suggestion.source_a_record_id);
    const sourceBRecord = records.get(suggestion.source_b_record_id);
    const sourceA =
      suggestion.source_a_type === "ORIGINAL"
        ? revisions.get(suggestion.source_a_id)
        : points.get(suggestion.source_a_id);
    const sourceB =
      suggestion.source_b_type === "ORIGINAL"
        ? revisions.get(suggestion.source_b_id)
        : points.get(suggestion.source_b_id);

    if (
      !sourceARecord ||
      !sourceBRecord ||
      !sourceA ||
      !sourceB ||
      sourceA.record_id !== sourceARecord.id ||
      sourceB.record_id !== sourceBRecord.id
    ) {
      throw new Error("duplicate suggestion source reference is invalid");
    }
  }

  for (const consolidation of snapshot.duplicateConsolidations) {
    const suggestion = duplicateSuggestions.get(consolidation.suggestion_id);
    const active = suggestion?.status === "ACCEPTED";
    const removed = suggestion?.status === "REMOVED";

    if (
      !suggestion ||
      consolidation.primary_source_id !== suggestion.primary_source_id ||
      (!active && !removed) ||
      (active && consolidation.removed_at !== null) ||
      (removed && consolidation.removed_at === null)
    ) {
      throw new Error("duplicate consolidation reference is invalid");
    }
  }

  for (const suggestion of snapshot.relationSuggestions) {
    if (
      !points.has(suggestion.source_knowledge_point_id) ||
      !points.has(suggestion.target_knowledge_point_id)
    ) {
      throw new Error("relation suggestion endpoint is invalid");
    }
  }

  for (const link of snapshot.relationSuggestionEvidence) {
    const suggestion = relationSuggestions.get(link.suggestion_id);
    const evidence = evidenceSpans.get(link.evidence_span_id);
    const expectedPointId =
      link.side === "SOURCE"
        ? suggestion?.source_knowledge_point_id
        : suggestion?.target_knowledge_point_id;

    if (!suggestion || !evidence || evidence.knowledge_point_id !== expectedPointId) {
      throw new Error("relation suggestion evidence reference is invalid");
    }
  }

  for (const relation of snapshot.knowledgeRelations) {
    const suggestion = relationSuggestions.get(relation.suggestion_id);
    const active = suggestion?.status === "CONFIRMED";
    const removed = suggestion?.status === "REMOVED";

    if (
      !suggestion ||
      relation.source_knowledge_point_id !==
        suggestion.source_knowledge_point_id ||
      relation.target_knowledge_point_id !==
        suggestion.target_knowledge_point_id ||
      (!active && !removed) ||
      (active && relation.removed_at !== null) ||
      (removed && relation.removed_at === null)
    ) {
      throw new Error("knowledge relation reference is invalid");
    }
  }

  for (const analysis of snapshot.coverageAnalyses) {
    const inputs =
      analysis.input_kind === "RECORDS"
        ? snapshot.coverageAnalysisRecords.filter(
            (record) => record.analysis_id === analysis.id,
          )
        : snapshot.coverageAnalysisPoints.filter(
            (point) => point.analysis_id === analysis.id,
          );

    if (inputs.length !== analysis.input_count) {
      throw new Error("coverage analysis input count is invalid");
    }
  }

  for (const input of snapshot.coverageAnalysisPoints) {
    const analysis = coverageAnalyses.get(input.analysis_id);

    if (
      analysis?.input_kind !== "KNOWLEDGE_POINTS" ||
      !points.has(input.knowledge_point_id)
    ) {
      throw new Error("coverage analysis input reference is invalid");
    }
  }

  for (const input of snapshot.coverageAnalysisRecords) {
    const analysis = coverageAnalyses.get(input.analysis_id);
    const revision = revisions.get(input.fragment_revision_id);

    if (
      analysis?.input_kind !== "RECORDS" ||
      !records.has(input.record_id) ||
      !revision ||
      revision.record_id !== input.record_id
    ) {
      throw new Error("coverage analysis record input reference is invalid");
    }
  }

  for (const item of snapshot.coverageAnalysisItems) {
    if (!coverageAnalyses.has(item.analysis_id)) {
      throw new Error("coverage analysis item reference is invalid");
    }
  }

  for (const link of snapshot.coverageItemPoints) {
    const item = coverageItems.get(link.item_id);
    const analysis = item ? coverageAnalyses.get(item.analysis_id) : undefined;
    const belongsToInput = snapshot.coverageAnalysisPoints.some(
      (input) =>
        input.analysis_id === item?.analysis_id &&
        input.knowledge_point_id === link.knowledge_point_id,
    );

    if (
      !item ||
      analysis?.input_kind !== "KNOWLEDGE_POINTS" ||
      item.kind !== "COVERED" ||
      !belongsToInput
    ) {
      throw new Error("coverage item evidence reference is invalid");
    }
  }

  for (const link of snapshot.coverageItemRecords) {
    const item = coverageItems.get(link.item_id);
    const analysis = item ? coverageAnalyses.get(item.analysis_id) : undefined;
    const belongsToInput = snapshot.coverageAnalysisRecords.some(
      (input) =>
        input.analysis_id === item?.analysis_id &&
        input.record_id === link.record_id,
    );

    if (
      !item ||
      analysis?.input_kind !== "RECORDS" ||
      item.kind !== "COVERED" ||
      !belongsToInput
    ) {
      throw new Error("coverage item record evidence reference is invalid");
    }
  }

  for (const item of snapshot.coverageAnalysisItems) {
    const pointEvidenceCount = snapshot.coverageItemPoints.filter(
      (link) => link.item_id === item.id,
    ).length;
    const recordEvidenceCount = snapshot.coverageItemRecords.filter(
      (link) => link.item_id === item.id,
    ).length;
    const evidenceCount = pointEvidenceCount + recordEvidenceCount;

    if (
      (item.kind === "COVERED" && evidenceCount === 0) ||
      (item.kind === "POSSIBLE_GAP" && evidenceCount !== 0)
    ) {
      throw new Error("coverage item evidence lifecycle is invalid");
    }
  }
}

function requireRows(value: unknown, name: string): DomainRow[] {
  if (!Array.isArray(value) || !value.every(isDomainRow)) {
    throw new Error(`${name} must be an array of objects`);
  }

  return value;
}

function requireExactKeys(row: DomainRow, expected: string[]): void {
  const actual = Object.keys(row).sort();
  const sortedExpected = [...expected].sort();

  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error("domain row has unexpected fields");
  }
}

function requireUuid(row: DomainRow, key: string): void {
  if (!isUuid(row[key])) {
    throw new Error(`${key} must be a UUID`);
  }
}

function requireNullableUuid(row: DomainRow, key: string): void {
  if (row[key] !== null && !isUuid(row[key])) {
    throw new Error(`${key} must be a nullable UUID`);
  }
}

function requireNonEmptyString(row: DomainRow, key: string): void {
  if (typeof row[key] !== "string" || row[key].length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
}

function requireTimestamp(row: DomainRow, key: string): void {
  if (!isTimestamp(row[key])) {
    throw new Error(`${key} must be a timestamp`);
  }
}

function requireNullableTimestamp(row: DomainRow, key: string): void {
  if (row[key] !== null && !isTimestamp(row[key])) {
    throw new Error(`${key} must be a nullable timestamp`);
  }
}

function requireFingerprint(row: DomainRow, key: string): void {
  if (
    typeof row[key] !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row[key] as string)
  ) {
    throw new Error(`${key} must be a SHA-256 fingerprint`);
  }
}

function requireNumberInRange(
  row: DomainRow,
  key: string,
  minimum: number,
  maximum: number,
): void {
  const value = row[key];

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${key} must be a number in range`);
  }
}

function requireNullableInteger(
  row: DomainRow,
  key: string,
  minimum: number,
): void {
  if (row[key] === null) {
    return;
  }

  requireInteger(row, key, minimum);
}

function requireInteger(
  row: DomainRow,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  const value = row[key];

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${key} must be an integer in range`);
  }
}

function requireEnum(
  row: DomainRow,
  key: string,
  allowed: readonly string[],
): void {
  if (typeof row[key] !== "string" || !allowed.includes(row[key])) {
    throw new Error(`${key} has an unsupported value`);
  }
}

function assertUnique<T>(
  rows: T[],
  keyFor: (row: T) => string,
  name: string,
): void {
  const keys = new Set<string>();

  for (const row of rows) {
    const key = keyFor(row);

    if (keys.has(key)) {
      throw new Error(`${name} must be unique`);
    }

    keys.add(key);
  }
}

function isDomainRow(value: unknown): value is DomainRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function timestampValue(value: unknown): number {
  return Date.parse(value as string);
}

async function restoreSnapshot(
  client: PoolClient,
  snapshot: DomainSnapshot,
): Promise<void> {
  await insertRows(client, "tags", [
    "id",
    "display_name",
    "normalized_name",
    "origin",
    "approval_status",
    "user_approved_at",
    "archived_at",
    "created_at",
    "updated_at",
  ], snapshot.tags);
  await insertRows(client, "tag_aliases", [
    "id",
    "tag_id",
    "display_name",
    "normalized_name",
    "created_at",
  ], snapshot.tagAliases);
  await insertRows(client, "tag_merges", [
    "id",
    "operation_id",
    "source_tag_id",
    "target_tag_id",
    "created_at",
    "undone_at",
  ], snapshot.tagMerges);
  await insertRows(client, "records", [
    "id",
    "current_fragment_revision_id",
    "current_analysis_revision_id",
    "archived_at",
    "created_at",
    "updated_at",
  ], snapshot.records);
  await insertRows(client, "fragment_revisions", [
    "id",
    "record_id",
    "revision_number",
    "content",
    "grapheme_count",
    "created_at",
  ], snapshot.fragmentRevisions);
  await insertRows(client, "ai_analysis_revisions", [
    "id",
    "record_id",
    "fragment_revision_id",
    "text_model",
    "title",
    "summary",
    "status",
    "generated_at",
  ], snapshot.analyses);
  await insertRows(client, "knowledge_points", [
    "id",
    "record_id",
    "fragment_revision_id",
    "analysis_revision_id",
    "position",
    "ai_title",
    "ai_body",
    "publication_status",
    "usage_status",
    "created_at",
  ], snapshot.knowledgePoints);
  await insertRows(client, "evidence_spans", [
    "id",
    "knowledge_point_id",
    "fragment_revision_id",
    "position",
    "start_offset",
    "end_offset",
    "quote",
  ], snapshot.evidenceSpans);
  await insertRows(client, "knowledge_point_corrections", [
    "knowledge_point_id",
    "title",
    "body",
    "updated_at",
  ], snapshot.corrections);
  await insertRows(client, "record_overview_corrections", [
    "record_id",
    "analysis_revision_id",
    "title",
    "summary",
    "updated_at",
  ], snapshot.overviewCorrections);
  await insertRows(client, "tag_assignments", [
    "id",
    "record_id",
    "tag_id",
    "assigned_by",
    "status",
    "created_at",
    "knowledge_point_id",
    "analysis_revision_id",
    "raw_label",
  ], snapshot.tagAssignments);
  await insertRows(client, "concepts", [
    "id",
    "current_revision_id",
    "normalized_name",
    "archived_at",
    "created_at",
    "updated_at",
  ], snapshot.concepts);
  await insertRows(client, "concept_revisions", [
    "id",
    "concept_id",
    "revision_number",
    "display_name",
    "normalized_name",
    "description",
    "created_at",
  ], snapshot.conceptRevisions);
  await insertRows(client, "concept_memberships", [
    "id",
    "concept_id",
    "knowledge_point_id",
    "origin",
    "created_at",
    "removed_at",
  ], snapshot.conceptMemberships);
  await insertRows(client, "concept_activity", [
    "id",
    "concept_id",
    "sequence_number",
    "kind",
    "revision_id",
    "membership_id",
    "occurred_at",
  ], snapshot.conceptActivity);
  await insertRows(client, "duplicate_suggestions", [
    "id",
    "source_a_type",
    "source_a_id",
    "source_a_record_id",
    "source_a_fingerprint",
    "source_b_type",
    "source_b_id",
    "source_b_record_id",
    "source_b_fingerprint",
    "detection_kind",
    "similarity_score",
    "reason",
    "status",
    "primary_source_id",
    "configuration_version",
    "created_at",
    "updated_at",
    "decided_at",
  ], snapshot.duplicateSuggestions);
  await insertRows(client, "duplicate_consolidations", [
    "id",
    "suggestion_id",
    "primary_source_id",
    "created_at",
    "removed_at",
  ], snapshot.duplicateConsolidations);
  await insertRows(client, "relation_suggestions", [
    "id",
    "pair_key",
    "input_fingerprint",
    "source_knowledge_point_id",
    "target_knowledge_point_id",
    "source_content_fingerprint",
    "target_content_fingerprint",
    "relation_type",
    "description",
    "reason",
    "confidence",
    "model_configuration_version",
    "text_model",
    "status",
    "created_at",
    "updated_at",
    "decided_at",
  ], snapshot.relationSuggestions);
  await insertRows(client, "relation_suggestion_evidence", [
    "suggestion_id",
    "evidence_span_id",
    "side",
  ], snapshot.relationSuggestionEvidence);
  await insertRows(client, "knowledge_relations", [
    "id",
    "suggestion_id",
    "source_knowledge_point_id",
    "target_knowledge_point_id",
    "relation_type",
    "description",
    "confirmed_at",
    "removed_at",
  ], snapshot.knowledgeRelations);
  await insertRows(client, "coverage_analyses", [
    "id",
    "topic",
    "framework_summary",
    "caveat",
    "input_count",
    "model_configuration_version",
    "text_model",
    "input_kind",
    "status",
    "failure_code",
    "failure_message",
    "attempt_count",
    "started_at",
    "completed_at",
    "created_at",
  ], snapshot.coverageAnalyses);
  await insertRows(client, "coverage_analysis_points", [
    "analysis_id",
    "knowledge_point_id",
    "content_fingerprint",
    "position",
  ], snapshot.coverageAnalysisPoints);
  await insertRows(client, "coverage_analysis_records", [
    "analysis_id",
    "record_id",
    "fragment_revision_id",
    "title",
    "content_fingerprint",
    "position",
  ], snapshot.coverageAnalysisRecords);
  await insertRows(client, "coverage_analysis_items", [
    "id",
    "analysis_id",
    "kind",
    "position",
    "title",
    "assessment",
    "recommendation",
  ], snapshot.coverageAnalysisItems);
  await insertRows(client, "coverage_item_points", [
    "item_id",
    "knowledge_point_id",
  ], snapshot.coverageItemPoints);
  await insertRows(client, "coverage_item_records", [
    "item_id",
    "record_id",
  ], snapshot.coverageItemRecords);
}

async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: DomainRow[],
): Promise<void> {
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");

  for (const row of rows) {
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
      columns.map((column) => row[column] ?? null),
    );
  }
}

async function instanceHasDomainData(pool: Pool | PoolClient): Promise<boolean> {
  const result = await pool.query<{ has_data: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM records)
         OR EXISTS (SELECT 1 FROM tags)
         OR EXISTS (SELECT 1 FROM concepts) AS has_data`,
  );

  return result.rows[0]?.has_data ?? false;
}

function publicExport(row: ExportRow) {
  return {
    id: row.id,
    status: row.status.toLowerCase(),
    ...(row.status === "SUCCEEDED" && row.completed_at && row.manifest
      ? {
          completedAt: asIsoString(row.completed_at),
          downloadUrl: `/api/v1/exports/${row.id}/download`,
          manifest: row.manifest,
        }
      : {}),
  };
}

function renderReadme(snapshot: DomainSnapshot): string {
  const records = snapshot.records.map(
    (record) => `- [记录 ${record.id}](${recordMarkdownName(record.id)})`,
  );

  return [
    "# Knowledge 完整导出",
    "",
    "每条记录均有独立 Markdown 阅读文件；恢复只使用 domain.json。",
    "",
    "## 记录",
    "",
    ...(records.length > 0 ? records : ["无记录。"]),
    "",
  ].join("\n");
}

function renderRecordMarkdown(
  snapshot: DomainSnapshot,
  record: RecordSnapshotRow,
): string {
  const recordRevisions = snapshot.fragmentRevisions
    .filter((revision) => revision.record_id === record.id)
    .sort((left, right) => left.revision_number - right.revision_number);
  const myAssignments = snapshot.tagAssignments.filter(
    (assignment) =>
      assignment.record_id === record.id &&
      assignment.assigned_by === "USER" &&
      assignment.status === "ACTIVE",
  );
  const tags = new Map(snapshot.tags.map((tag) => [tag.id, tag]));
  const currentAnalysis = snapshot.analyses.find(
    (analysis) => analysis.id === record.current_analysis_revision_id,
  );
  const overviewCorrection = currentAnalysis
    ? snapshot.overviewCorrections.find(
        (correction) =>
          correction.record_id === record.id &&
          correction.analysis_revision_id === currentAnalysis.id,
      )
    : undefined;
  const currentPoints = currentAnalysis
    ? snapshot.knowledgePoints
        .filter((point) => point.analysis_revision_id === currentAnalysis.id)
        .sort((left, right) => left.position - right.position)
    : [];
  const lines = [
    `# 记录 ${record.id}`,
    "",
    `- 稳定记录 ID: \`${record.id}\``,
    `- 归档状态: \`${record.archived_at ? "ARCHIVED" : "ACTIVE"}\``,
    `- 当前原文版本 ID: \`${record.current_fragment_revision_id}\``,
    `- 当前 AI 分析版本 ID: ${
      record.current_analysis_revision_id
        ? `\`${record.current_analysis_revision_id}\``
        : "无"
    }`,
    "",
    "## 我的标签",
    "",
    ...(myAssignments.length > 0
      ? myAssignments.map((assignment) => {
          const tag = tags.get(assignment.tag_id);

          return tag
            ? `- ${escapeMarkdownInline(tag.display_name)} (\`${tag.id}\`)`
            : `- 未知标签 (\`${assignment.tag_id}\`)`;
        })
      : ["无。"]),
    "",
    "## 当前有效 AI 整理",
    "",
  ];

  if (currentAnalysis) {
    lines.push(
      `- 稳定分析版本 ID: \`${currentAnalysis.id}\``,
      `- 状态: \`${currentAnalysis.status}\``,
      "",
      "### AI 标题",
      "",
      rawTextBlock(currentAnalysis.title),
      "",
      "### AI 摘要",
      "",
      rawTextBlock(currentAnalysis.summary),
      "",
    );

    if (overviewCorrection) {
      lines.push(
        "### 用户修正的整体标题",
        "",
        rawTextBlock(overviewCorrection.title),
        "",
        "### 用户修正的整体摘要",
        "",
        rawTextBlock(overviewCorrection.summary),
        "",
        `- 用户修正时间: \`${asIsoString(overviewCorrection.updated_at)}\``,
        "",
      );
    } else {
      lines.push("### 整体用户修正", "", "无。", "");
    }
  } else {
    lines.push("无。", "");
  }

  lines.push("## 全部原文版本", "");

  for (const revision of recordRevisions) {
    const current = revision.id === record.current_fragment_revision_id;

    lines.push(
      `### 原文 v${revision.revision_number}${current ? " · 当前" : ""}`,
      "",
      `- 稳定原文版本 ID: \`${revision.id}\``,
      "",
      rawTextBlock(revision.content),
      "",
    );
  }

  lines.push("## 当前分析的知识点", "");

  if (currentPoints.length === 0) {
    lines.push("无。", "");
  }

  for (const point of currentPoints) {
    const correction = snapshot.corrections.find(
      (candidate) => candidate.knowledge_point_id === point.id,
    );
    const aiTagAssignments = snapshot.tagAssignments.filter(
      (assignment) =>
        assignment.knowledge_point_id === point.id &&
        assignment.assigned_by === "AI",
    );
    const evidence = snapshot.evidenceSpans
      .filter((span) => span.knowledge_point_id === point.id)
      .sort((left, right) => left.position - right.position);

    lines.push(
      `### 知识点 ${point.position}`,
      "",
      `- 稳定知识点 ID: \`${point.id}\``,
      `- 发布状态: \`${point.publication_status}\``,
      `- 使用状态: \`${point.usage_status}\``,
      `- 来源原文版本 ID: \`${point.fragment_revision_id}\``,
      "",
      "#### AI 原始标题",
      "",
      rawTextBlock(point.ai_title),
      "",
      "#### AI 原始正文",
      "",
      rawTextBlock(point.ai_body),
      "",
    );

    if (correction) {
      lines.push(
        "#### 用户修正标题",
        "",
        rawTextBlock(correction.title),
        "",
        "#### 用户修正正文",
        "",
        rawTextBlock(correction.body),
        "",
      );
    } else {
      lines.push("#### 用户修正", "", "无。", "");
    }

    lines.push("#### AI 候选标签", "");

    if (aiTagAssignments.length === 0) {
      lines.push("无。", "");
    } else {
      for (const assignment of aiTagAssignments) {
        const tag = tags.get(assignment.tag_id);

        lines.push(
          tag
            ? `- ${escapeMarkdownInline(tag.display_name)} (\`${tag.id}\`) · ` +
                `\`${tag.approval_status}\` · \`${assignment.status}\``
            : `- 未知标签 (\`${assignment.tag_id}\`)`,
        );
      }
      lines.push("");
    }

    for (const span of evidence) {
      lines.push(
        `#### Evidence ${span.position}`,
        "",
        `- 稳定 Evidence ID: \`${span.id}\``,
        `- 来源原文版本 ID: \`${span.fragment_revision_id}\``,
        `- 偏移: \`${span.start_offset}..${span.end_offset}\``,
        "",
        "##### 证据原文",
        "",
        rawTextBlock(span.quote),
        "",
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function recordMarkdownName(recordId: string): string {
  return `records/${recordId}.md`;
}

function rawTextBlock(value: string): string {
  const longestBacktickRun = Math.max(
    2,
    ...[...value.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);

  return `${fence}text\n${value}\n${fence}`;
}

function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\p{White_Space}+/gu, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()])/gu, "\\$1");
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
