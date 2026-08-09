import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { createZip, readStoredZip } from "./zip-archive.js";

const manifest = {
  formatVersion: 1,
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

interface DomainSnapshot {
  formatVersion: 1;
  records: RecordSnapshotRow[];
  fragmentRevisions: FragmentRevisionSnapshotRow[];
  tags: TagSnapshotRow[];
  tagAssignments: TagAssignmentSnapshotRow[];
  analyses: AnalysisSnapshotRow[];
  knowledgePoints: KnowledgePointSnapshotRow[];
  evidenceSpans: EvidenceSpanSnapshotRow[];
  corrections: CorrectionSnapshotRow[];
  overviewCorrections: OverviewCorrectionSnapshotRow[];
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

      let snapshot: DomainSnapshot;

      try {
        snapshot = parseSnapshot(archive);
      } catch {
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
         VALUES ($1, 'VALID', 1, $2, $3, $4, $5)`,
        [
          inspectionId,
          snapshot.records.length,
          canRestore,
          canRestore ? null : "INSTANCE_NOT_EMPTY",
          archive,
        ],
      );

      return {
        inspection: {
          id: inspectionId,
          status: "valid",
          formatVersion: 1,
          recordCount: snapshot.records.length,
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

        const snapshot = parseSnapshot(inspection.archive);

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
    const snapshot: DomainSnapshot = {
      formatVersion: 1,
      records: records.rows,
      fragmentRevisions: fragmentRevisions.rows,
      tags: tags.rows,
      tagAssignments: tagAssignments.rows,
      analyses: analyses.rows,
      knowledgePoints: knowledgePoints.rows,
      evidenceSpans: evidenceSpans.rows,
      corrections: corrections.rows,
      overviewCorrections: overviewCorrections.rows,
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

function parseSnapshot(archive: Buffer): DomainSnapshot {
  const entries = readStoredZip(archive);
  const manifestJson = entries.get("manifest.json");
  const json = entries.get("domain.json");

  if (!manifestJson || !json || !entries.has("README.md")) {
    throw new Error("restore package is incomplete");
  }

  const publicManifest = JSON.parse(manifestJson.toString("utf8")) as unknown;
  const snapshot = JSON.parse(json.toString("utf8")) as unknown;

  if (
    !isDomainRow(publicManifest) ||
    publicManifest.formatVersion !== 1 ||
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

  validateDomainSnapshot(snapshot);

  if (publicManifest.recordCount !== snapshot.records.length) {
    throw new Error("restore manifest record count is invalid");
  }

  for (const record of snapshot.records) {
    if (!entries.has(recordMarkdownName(record.id))) {
      throw new Error(`record Markdown is missing: ${record.id}`);
    }
  }

  return snapshot;
}

function validateDomainSnapshot(value: unknown): asserts value is DomainSnapshot {
  if (!isDomainRow(value)) {
    throw new Error("domain snapshot must be an object");
  }

  requireExactKeys(value, [
    "formatVersion",
    "records",
    "fragmentRevisions",
    "tags",
    "tagAssignments",
    "analyses",
    "knowledgePoints",
    "evidenceSpans",
    "corrections",
    "overviewCorrections",
  ]);

  if (value.formatVersion !== 1) {
    throw new Error("domain snapshot version is unsupported");
  }

  const records = requireRows(value.records, "records");
  const fragmentRevisions = requireRows(
    value.fragmentRevisions,
    "fragmentRevisions",
  );
  const tags = requireRows(value.tags, "tags");
  const tagAssignments = requireRows(value.tagAssignments, "tagAssignments");
  const analyses = requireRows(value.analyses, "analyses");
  const knowledgePoints = requireRows(value.knowledgePoints, "knowledgePoints");
  const evidenceSpans = requireRows(value.evidenceSpans, "evidenceSpans");
  const corrections = requireRows(value.corrections, "corrections");
  const overviewCorrections = requireRows(
    value.overviewCorrections,
    "overviewCorrections",
  );

  records.forEach(validateRecordRow);
  fragmentRevisions.forEach(validateFragmentRevisionRow);
  tags.forEach(validateTagRow);
  tagAssignments.forEach(validateTagAssignmentRow);
  analyses.forEach(validateAnalysisRow);
  knowledgePoints.forEach(validateKnowledgePointRow);
  evidenceSpans.forEach(validateEvidenceSpanRow);
  corrections.forEach(validateCorrectionRow);
  overviewCorrections.forEach(validateOverviewCorrectionRow);

  const snapshot = value as unknown as DomainSnapshot;

  validateSnapshotReferences(snapshot);
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
  ]);
  requireUuid(row, "id");
  requireNullableUuid(row, "record_id");
  requireUuid(row, "tag_id");
  requireEnum(row, "assigned_by", ["USER", "AI"]);
  requireEnum(row, "status", ["ACTIVE", "SUPPRESSED"]);
  requireTimestamp(row, "created_at");
  requireNullableUuid(row, "knowledge_point_id");

  const hasRecord = row.record_id !== null;
  const hasKnowledgePoint = row.knowledge_point_id !== null;

  if (
    hasRecord === hasKnowledgePoint ||
    (row.assigned_by === "USER" && (!hasRecord || row.status !== "ACTIVE")) ||
    (row.assigned_by === "AI" && !hasKnowledgePoint)
  ) {
    throw new Error("tag assignment target is invalid");
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

  const records = new Map(snapshot.records.map((row) => [row.id, row]));
  const revisions = new Map(
    snapshot.fragmentRevisions.map((row) => [row.id, row]),
  );
  const tags = new Map(snapshot.tags.map((row) => [row.id, row]));
  const analyses = new Map(snapshot.analyses.map((row) => [row.id, row]));
  const points = new Map(snapshot.knowledgePoints.map((row) => [row.id, row]));

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
    if (
      !tags.has(assignment.tag_id) ||
      (assignment.record_id !== null && !records.has(assignment.record_id)) ||
      (assignment.knowledge_point_id !== null &&
        !points.has(assignment.knowledge_point_id))
    ) {
      throw new Error("tag assignment reference is invalid");
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
  ], snapshot.tagAssignments);
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
         OR EXISTS (SELECT 1 FROM tags) AS has_data`,
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
