import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { Pool, type PoolClient } from "pg";

import {
  generateOpenAICompatibleAnalysis,
  type AnalysisGenerator,
} from "./analysis-generator.js";
import {
  generateOpenAICompatibleCoverage,
  type CoverageGenerator,
} from "./coverage-generator.js";
import { registerCoverageRoutes } from "./coverage-routes.js";
import {
  generateOpenAICompatibleConceptCandidate,
  type ConceptCandidateGenerator,
} from "./concept-candidate-generator.js";
import { registerConceptCandidateRoutes } from "./concept-candidate-routes.js";
import { registerConceptRoutes } from "./concept-routes.js";
import {
  embedOpenAICompatibleText,
  type EmbedText,
} from "./embedding-provider.js";
import {
  readCurrentOrganization,
  readObservableOrganizationTask,
  readOrganizationCandidate,
  registerAiOrganizationRoutes,
} from "./ai-organization-routes.js";
import { countGraphemes, hasNonWhitespace } from "./domain/fragment-text.js";
import { normalizeTagName } from "./domain/tag-name.js";
import { registerDataTransferRoutes } from "./data-transfer-routes.js";
import { registerDuplicateRoutes } from "./duplicate-routes.js";
import {
  ensureBootstrapModelDraft,
  registerModelConfigRoutes,
  type BootstrapModelDraft,
} from "./model-config-routes.js";
import {
  testOpenAICompatibleEndpoint,
  type ModelEndpointTester,
} from "./model-endpoint-tester.js";
import {
  generateOpenAICompatibleRelation,
  type RelationGenerator,
} from "./relation-generator.js";
import { registerRelationRoutes } from "./relation-routes.js";
import {
  createSemanticIndexScheduler,
  findSemanticMatches,
  registerSemanticSearchRoutes,
  type SemanticMatch,
} from "./semantic-search.js";

export interface BuildAppOptions {
  bootstrapModelDraft?: BootstrapModelDraft;
  credentialEncryptionKey?: string;
  databaseUrl: string;
  embedText?: EmbedText;
  generateAnalysis?: AnalysisGenerator;
  generateConceptCandidate?: ConceptCandidateGenerator;
  generateCoverage?: CoverageGenerator;
  generateRelation?: RelationGenerator;
  logger?: boolean;
  onAiTaskSettled?: (taskId: string) => void;
  testModelEndpoint?: ModelEndpointTester;
}

interface CreateRecordBody {
  text: string;
  myTags: RequestedTag[];
  processing: "save_only";
}

type RequestedTag = { id: string } | { name: string };

interface RecordQuery {
  archive?: "active" | "archived" | "all";
  cursor?: string;
  limit?: string;
  processing?: "saved" | "processing" | "processed" | "failed";
  q?: string;
  sort?: "updated_desc" | "updated_asc";
  tag?: string | string[];
}

interface SearchQuery {
  cursor?: string;
  limit?: string;
  q?: string;
  scope?: "include_review";
  tag?: string | string[];
}

type RecordArchiveScope = "active" | "archived" | "all";
type RecordProcessingFilter =
  | "all"
  | "saved"
  | "processing"
  | "processed"
  | "failed";
type RecordSort = "updated_desc" | "updated_asc";
type SearchScope = "current" | "include_review";

interface RecordCursor {
  id: string;
  updatedAt: string;
}

interface FindRecordsOptions {
  archive?: RecordArchiveScope;
  cursor?: RecordCursor | null;
  limit?: number;
  processing?: RecordProcessingFilter;
  searchScope?: SearchScope;
  sort?: RecordSort;
}

interface RecordParams {
  id: string;
}

interface OverviewCorrectionBody {
  title: string;
  summary: string;
}

interface HistoryEntryParams extends RecordParams {
  entryId: string;
}

interface TagQuery {
  approval?: "candidate" | "user_approved";
  q?: string;
  sort?: "name_asc" | "name_desc" | "record_count_desc";
}

interface TagParams {
  id: string;
}

interface TagAliasParams extends TagParams {
  aliasId: string;
}

interface TagMergeParams {
  id: string;
}

interface TagVisibilityParams extends TagParams {
  itemId: string;
  recordId: string;
}

type TagPatchBody =
  | { name: string }
  | { approvalStatus: "archived" | "user_approved" };

interface TagVisibilityBody {
  status: "active" | "suppressed";
}

interface CreateTagBody {
  name: string;
}

interface CreateTagMergeBody {
  sourceTagIds: string[];
  targetTagId: string;
}

interface DeleteCandidateTagsBody {
  ids: string[];
}

interface TagChip {
  id: string;
  name: string;
}

interface PublicTag extends TagChip {
  approvalStatus: "archived" | "candidate" | "user_approved";
  origin: "ai_created" | "user_created";
  recordCount: number;
}

interface TagSummaryRow {
  approval_status: "ARCHIVED" | "CANDIDATE" | "USER_APPROVED";
  display_name: string;
  id: string;
  origin: "AI_CREATED" | "USER_CREATED";
  record_count: number;
}

class TagNameConflictError extends Error {
  constructor(readonly existingTag: TagChip) {
    super("Tag name conflicts with an existing tag");
  }
}

interface RecordCard {
  id: string;
  title: string;
  preview: string;
  myTags: TagChip[];
  lifecycle: "active" | "archived";
  organization: {
    view: "original" | "organized";
    activity: "idle" | "queued" | "running" | "failed";
  };
  textVersion: number;
  updatedAt: string;
}

interface SearchMatch {
  reason: "knowledge_point" | "original_text" | "semantic";
  snippets: Array<{
    text: string;
    highlights: Array<{ start: number; end: number }>;
  }>;
  source: {
    id: string;
    type: "fragment" | "knowledge_point" | "overview";
  };
  visibility: "current" | "pending_review";
}

interface SearchResultItem {
  record: RecordCard;
  match: SearchMatch;
  otherMatches: SearchMatch[];
}

interface ScoredSearchMatch {
  match: SearchMatch;
  score: number;
}

interface SearchableKnowledgePoint {
  body: string;
  id: string;
  title: string;
  visibility: "current" | "pending_review";
}

interface SearchSnapshot {
  items: SearchResultItem[];
  signature: string;
}

interface SearchCursor {
  offset: number;
  snapshotId: string;
}

const MAX_SEARCH_SNAPSHOTS = 32;

interface RecordRow {
  id: string;
  content: string;
  fragment_revision_id: string;
  revision_number: number;
  updated_at: Date | string;
  updated_cursor: string;
  archived_at: Date | string | null;
  tag_id: string;
  display_name: string;
  knowledge_match_title: string | null;
  knowledge_match_body: string | null;
  knowledge_match_publication_status: string | null;
  active_analysis_id: string | null;
  effective_title: string | null;
  effective_summary: string | null;
  organization_task_status: string | null;
}

interface StoredRecord {
  activeAnalysisId: string | null;
  card: RecordCard;
  content: string;
  cursor: RecordCursor;
  fragmentRevisionId: string;
  knowledgeMatch: null | {
    title: string;
    body: string;
    visibility: "current" | "pending_review";
  };
}

const EFFECTIVE_TAG_RECORDS_CTE = `effective_tag_records AS (
  SELECT resolve_tag_id(assignment.tag_id) AS tag_id, assignment.record_id
    FROM tag_assignments AS assignment
    INNER JOIN tags AS effective_tag
      ON effective_tag.id = resolve_tag_id(assignment.tag_id)
     AND effective_tag.approval_status IN ('CANDIDATE', 'USER_APPROVED')
     AND effective_tag.archived_at IS NULL
    INNER JOIN records AS effective_record
      ON effective_record.id = assignment.record_id
     AND effective_record.archived_at IS NULL
   WHERE assignment.assigned_by = 'USER'
     AND assignment.status = 'ACTIVE'
  UNION
  SELECT resolve_tag_id(assignment.tag_id) AS tag_id, point.record_id
    FROM tag_assignments AS assignment
    INNER JOIN tags AS effective_tag
      ON effective_tag.id = resolve_tag_id(assignment.tag_id)
     AND effective_tag.approval_status IN ('CANDIDATE', 'USER_APPROVED')
     AND effective_tag.archived_at IS NULL
    INNER JOIN knowledge_points AS point
      ON point.id = assignment.knowledge_point_id
     AND point.usage_status = 'INCLUDED'
     AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
    INNER JOIN ai_analysis_revisions AS analysis
      ON analysis.id = point.analysis_revision_id
     AND analysis.status = 'ACTIVE'
    INNER JOIN records AS effective_record
      ON effective_record.id = point.record_id
     AND effective_record.current_analysis_revision_id = analysis.id
     AND effective_record.archived_at IS NULL
   WHERE assignment.assigned_by = 'AI'
     AND assignment.status = 'ACTIVE'
)`;

const LIBRARY_TAG_RECORDS_CTE = `library_tag_records AS (
  SELECT resolve_tag_id(assignment.tag_id) AS tag_id, assignment.record_id
    FROM tag_assignments AS assignment
    INNER JOIN tags AS library_tag
      ON library_tag.id = resolve_tag_id(assignment.tag_id)
     AND library_tag.approval_status IN ('CANDIDATE', 'USER_APPROVED')
     AND library_tag.archived_at IS NULL
   WHERE assignment.assigned_by = 'USER'
     AND assignment.status = 'ACTIVE'
  UNION
  SELECT resolve_tag_id(assignment.tag_id) AS tag_id, point.record_id
    FROM tag_assignments AS assignment
    INNER JOIN tags AS library_tag
      ON library_tag.id = resolve_tag_id(assignment.tag_id)
     AND library_tag.approval_status IN ('CANDIDATE', 'USER_APPROVED')
     AND library_tag.archived_at IS NULL
    INNER JOIN knowledge_points AS point
      ON point.id = assignment.knowledge_point_id
     AND point.usage_status = 'INCLUDED'
     AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
    INNER JOIN ai_analysis_revisions AS analysis
      ON analysis.id = point.analysis_revision_id
     AND analysis.status = 'ACTIVE'
    INNER JOIN records AS library_record
      ON library_record.id = point.record_id
     AND library_record.current_analysis_revision_id = analysis.id
   WHERE assignment.assigned_by = 'AI'
     AND assignment.status = 'ACTIVE'
)`;

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const pool = new Pool({ connectionString: options.databaseUrl });
  const searchSnapshots = new Map<string, SearchSnapshot>();

  app.addHook("onClose", async () => {
    await pool.end();
  });

  const credentialSecret =
    options.credentialEncryptionKey ??
    process.env.MODEL_CONFIG_ENCRYPTION_KEY ??
    options.databaseUrl;

  if (options.bootstrapModelDraft) {
    await ensureBootstrapModelDraft(
      pool,
      credentialSecret,
      options.bootstrapModelDraft,
    );
  }

  const embedText = options.embedText ?? embedOpenAICompatibleText;
  const semanticIndexScheduler = createSemanticIndexScheduler({
    pool,
    credentialSecret,
    embedText,
  });
  const scheduleSemanticIndex = () => semanticIndexScheduler.schedule();

  registerModelConfigRoutes(app, {
    pool,
    credentialSecret,
    scheduleSemanticIndex,
    testModelEndpoint:
      options.testModelEndpoint ?? testOpenAICompatibleEndpoint,
  });
  registerAiOrganizationRoutes(app, {
    pool,
    credentialSecret,
    generateAnalysis:
      options.generateAnalysis ?? generateOpenAICompatibleAnalysis,
    ...(options.onAiTaskSettled
      ? { onTaskSettled: options.onAiTaskSettled }
      : {}),
    scheduleSemanticIndex,
  });
  registerDataTransferRoutes(app, { pool, scheduleSemanticIndex });
  registerSemanticSearchRoutes(app, {
    pool,
    scheduler: semanticIndexScheduler,
  });
  registerDuplicateRoutes(app, { pool });
  registerRelationRoutes(app, {
    pool,
    credentialSecret,
    generateRelation:
      options.generateRelation ?? generateOpenAICompatibleRelation,
  });
  registerCoverageRoutes(app, {
    pool,
    credentialSecret,
    generateCoverage:
      options.generateCoverage ?? generateOpenAICompatibleCoverage,
  });
  registerConceptRoutes(app, { pool });
  registerConceptCandidateRoutes(app, {
    pool,
    credentialSecret,
    generateConceptCandidate:
      options.generateConceptCandidate ?? generateOpenAICompatibleConceptCandidate,
  });

  app.post<{ Body: CreateRecordBody }>(
    "/api/v1/records",
    async (request, reply) => {
      const { text, myTags, processing } = request.body;

      if (typeof text !== "string" || !hasNonWhitespace(text)) {
        return reply.code(422).send({
          error: {
            code: "TEXT_REQUIRED",
            message: "请输入至少一个非空白字符。",
          },
        });
      }

      const textGraphemeCount = countGraphemes(text);

      if (textGraphemeCount > 1_000) {
        return reply.code(422).send({
          error: {
            code: "TEXT_TOO_LONG",
            message: "正文不能超过 1000 个字符，请拆分后再保存。",
            details: {
              graphemeCount: textGraphemeCount,
              max: 1_000,
            },
          },
        });
      }

      if (!Array.isArray(myTags) || myTags.length === 0) {
        return reply.code(422).send({
          error: {
            code: "MY_TAG_REQUIRED",
            message: "请至少选择或创建一个我的标签。",
          },
        });
      }

      if (processing !== "save_only") {
        return reply.code(422).send({ error: "Invalid record" });
      }

      const client = await pool.connect();

      try {
        try {
          const record = await createSaveOnlyRecord(client, text, myTags);

          scheduleSemanticIndex();
          return reply
            .code(201)
            .header("location", `/api/v1/records/${record.id}`)
            .send({ record, task: null });
        } catch (error) {
          if (error instanceof TagNameConflictError) {
            return reply.code(409).send({
              error: {
                code: "TAG_NAME_CONFLICT",
                message: "已存在同名标签，请选择现有标签。",
                details: { existingTag: error.existingTag },
              },
            });
          }

          throw error;
        }
      } finally {
        client.release();
      }
    },
  );

  app.put<{ Body: CreateRecordBody; Params: RecordParams }>(
    "/api/v1/records/:id",
    async (request, reply) => {
      const { text, myTags, processing } = request.body;

      if (typeof text !== "string" || !hasNonWhitespace(text)) {
        return reply.code(422).send({
          error: {
            code: "TEXT_REQUIRED",
            message: "请输入至少一个非空白字符。",
          },
        });
      }

      const textGraphemeCount = countGraphemes(text);

      if (textGraphemeCount > 1_000) {
        return reply.code(422).send({
          error: {
            code: "TEXT_TOO_LONG",
            message: "正文不能超过 1000 个字符，请拆分后再保存。",
            details: { graphemeCount: textGraphemeCount, max: 1_000 },
          },
        });
      }

      if (!Array.isArray(myTags) || myTags.length === 0) {
        return reply.code(422).send({
          error: {
            code: "MY_TAG_REQUIRED",
            message: "请至少选择或创建一个我的标签。",
          },
        });
      }

      if (processing !== "save_only") {
        return reply.code(422).send({ error: "Invalid record" });
      }

      const client = await pool.connect();

      try {
        try {
          const record = await updateSaveOnlyRecord(
            client,
            request.params.id,
            text,
            myTags,
          );

          if (!record) {
            return reply.code(404).send({ error: "Record not found" });
          }

          scheduleSemanticIndex();
          return { record, task: null };
        } catch (error) {
          if (error instanceof TagNameConflictError) {
            return reply.code(409).send({
              error: {
                code: "TAG_NAME_CONFLICT",
                message: "已存在同名标签，请选择现有标签。",
                details: { existingTag: error.existingTag },
              },
            });
          }

          throw error;
        }
      } finally {
        client.release();
      }
    },
  );

  app.put<{ Body: OverviewCorrectionBody; Params: RecordParams }>(
    "/api/v1/records/:id/overview-correction",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      const summary = request.body?.summary?.trim();

      if (!title || !summary) {
        return reply.code(422).send({
          error: {
            code: "RECORD_OVERVIEW_CORRECTION_INVALID",
            message: "修正后的标题与摘要不能为空。",
          },
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const activeResult = await client.query<{
          id: string;
          title: string;
          summary: string;
        }>(
          `SELECT analysis.id, analysis.title, analysis.summary
             FROM records AS record
             INNER JOIN ai_analysis_revisions AS analysis
               ON analysis.id = record.current_analysis_revision_id
              AND analysis.status = 'ACTIVE'
            WHERE record.id = $1
              AND record.archived_at IS NULL
            FOR UPDATE OF record, analysis`,
          [request.params.id],
        );
        const active = activeResult.rows[0];

        if (!active) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Active organization not found" });
        }

        const correctionResult = await client.query<{
          updated_at: Date | string;
        }>(
          `INSERT INTO record_overview_corrections
             (record_id, analysis_revision_id, title, summary)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (record_id) DO UPDATE
             SET analysis_revision_id = EXCLUDED.analysis_revision_id,
                 title = EXCLUDED.title,
                 summary = EXCLUDED.summary,
                 updated_at = clock_timestamp()
           RETURNING updated_at`,
          [request.params.id, active.id, title, summary],
        );
        const updatedAt = correctionResult.rows[0]?.updated_at;

        if (!updatedAt) {
          throw new Error("Overview correction upsert did not return updated_at");
        }

        await client.query("COMMIT");
        scheduleSemanticIndex();

        return {
          presentation: {
            title,
            summary,
            source: "user_correction",
            aiOriginal: { title: active.title, summary: active.summary },
            correction: { title, summary, updatedAt: asIsoString(updatedAt) },
          },
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: RecordParams }>(
    "/api/v1/records/:id/overview-correction",
    async (request, reply) => {
      const removed = await pool.query(
        `DELETE FROM record_overview_corrections AS correction
          USING records AS record,
                ai_analysis_revisions AS analysis
          WHERE correction.record_id = $1
            AND record.id = correction.record_id
            AND record.archived_at IS NULL
            AND analysis.id = record.current_analysis_revision_id
            AND analysis.status = 'ACTIVE'
            AND correction.analysis_revision_id = analysis.id
          RETURNING correction.record_id`,
        [request.params.id],
      );

      if (!removed.rows[0]) {
        return reply.code(404).send({ error: "Overview correction not found" });
      }

      scheduleSemanticIndex();
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RecordParams }>(
    "/api/v1/records/:id/archive",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const recordResult = await client.query<{ id: string }>(
          "SELECT id FROM records WHERE id = $1 FOR UPDATE",
          [request.params.id],
        );

        if (!recordResult.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Record not found" });
        }

        const unfinishedResult = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM ai_tasks
              WHERE record_id = $1
                AND status IN ('QUEUED', 'RUNNING')
           ) AS exists`,
          [request.params.id],
        );

        if (unfinishedResult.rows[0]?.exists) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "AI_TASK_IN_PROGRESS",
              message: "AI 整理进行中，完成后才能归档记录。",
            },
          });
        }

        await client.query(
          `UPDATE records
              SET archived_at = COALESCE(archived_at, now()),
                  updated_at = now()
            WHERE id = $1`,
          [request.params.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const [record] = await findRecords(pool, "", request.params.id);

      if (!record) {
        throw new Error("Archived record could not be read");
      }

      return { record: record.card };
    },
  );

  app.post<{ Params: RecordParams }>(
    "/api/v1/records/:id/restore",
    async (request, reply) => {
      const restored = await pool.query(
        `UPDATE records
            SET archived_at = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [request.params.id],
      );

      if (!restored.rows[0]) {
        return reply.code(404).send({ error: "Record not found" });
      }

      const [record] = await findRecords(pool, "", request.params.id);

      if (!record) {
        throw new Error("Restored record could not be read");
      }

      scheduleSemanticIndex();
      return { record: record.card };
    },
  );

  app.delete<{ Params: RecordParams }>(
    "/api/v1/records/:id",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const record = await client.query<{ id: string }>(
          "SELECT id FROM records WHERE id = $1 FOR UPDATE",
          [request.params.id],
        );

        if (!record.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Record not found" });
        }

        await client.query("DELETE FROM records WHERE id = $1", [
          request.params.id,
        ]);
        await client.query(
          `DELETE FROM tags AS tag
            WHERE tag.approval_status = 'CANDIDATE'
              AND NOT EXISTS (
                SELECT 1
                  FROM tag_assignments AS assignment
                 WHERE assignment.tag_id = tag.id
              )`,
        );
        await client.query("COMMIT");

        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Querystring: RecordQuery }>(
    "/api/v1/records",
    async (request, reply) => {
      const archive = request.query.archive ?? "active";
      const limit = parseRecordPageLimit(request.query.limit);
      const cursor = decodeRecordCursor(request.query.cursor);
      const processing = request.query.processing ?? "all";
      const sort = request.query.sort ?? "updated_desc";
      const requestedTags = request.query.tag;
      const tagIds = requestedTags
        ? Array.isArray(requestedTags)
          ? requestedTags
          : [requestedTags]
        : [];

      if (
        !isRecordArchiveScope(archive) ||
        !isRecordProcessingFilter(processing) ||
        !isRecordSort(sort) ||
        !limit ||
        cursor === undefined ||
        !tagIds.every(isUuid)
      ) {
        return reply.code(422).send({
          error: {
            code: "RECORD_LIBRARY_QUERY_INVALID",
            message: "记录库的筛选、排序或游标无效。",
          },
        });
      }

      const records = await findRecords(
        pool,
        request.query.q ?? "",
        undefined,
        tagIds,
        { archive, cursor, limit: limit + 1, processing, sort },
      );
      const hasNextPage = records.length > limit;
      const pageRecords = records.slice(0, limit);
      const lastRecord = pageRecords.at(-1);

      return {
        items: pageRecords.map(({ card }) => card),
        page: {
          nextCursor:
            hasNextPage && lastRecord
              ? encodeRecordCursor(lastRecord.cursor)
              : null,
        },
      };
    },
  );

  app.post<{ Body: CreateTagBody }>(
    "/api/v1/tags",
    async (request, reply) => {
      const name = request.body?.name;
      const normalizedName =
        typeof name === "string" ? normalizeTagName(name) : "";

      if (!normalizedName) {
        return reply.code(422).send({
          error: {
            code: "TAG_CREATE_INVALID",
            message: "标签名称不能为空。",
          },
        });
      }

      const existing = await readTagByNormalizedName(pool, normalizedName);

      if (existing) {
        return reply.code(409).send({
          error: {
            code: "TAG_NAME_CONFLICT",
            message: "已存在同名标签，请使用现有标签或换一个名称。",
            details: {
              existingTag: {
                id: existing.id,
                name: existing.name,
              },
            },
          },
        });
      }

      const tagId = randomUUID();

      try {
        await pool.query(
          `INSERT INTO tags
             (id, display_name, normalized_name, origin, approval_status,
              user_approved_at)
           VALUES ($1, $2, $3, 'USER_CREATED', 'USER_APPROVED', now())`,
          [tagId, name, normalizedName],
        );
      } catch (error) {
        if (!isTagNameUniqueViolation(error)) {
          throw error;
        }

        const conflict = await readTagByNormalizedName(pool, normalizedName);

        if (!conflict) {
          throw error;
        }

        return reply.code(409).send({
          error: {
            code: "TAG_NAME_CONFLICT",
            message: "已存在同名标签，请使用现有标签或换一个名称。",
            details: {
              existingTag: {
                id: conflict.id,
                name: conflict.name,
              },
            },
          },
        });
      }

      const tag = await readPublicTag(pool, tagId);

      if (!tag) {
        throw new Error("Created tag could not be read");
      }

      return reply
        .code(201)
        .header("location", `/api/v1/tags/${tag.id}`)
        .send({ tag });
    },
  );

  app.get<{ Querystring: TagQuery }>(
    "/api/v1/tags",
    async (request, reply) => {
      const approval = request.query.approval ?? "user_approved";
      const sort = request.query.sort ?? "name_asc";

      if (!isTagApproval(approval) || !isTagSort(sort)) {
        return reply.code(422).send({
          error: {
            code: "TAG_LIBRARY_QUERY_INVALID",
            message: "标签分区或排序方式无效。",
          },
        });
      }

      const query = request.query.q ?? "";
      const approvalStatus =
        approval === "user_approved" ? "USER_APPROVED" : "CANDIDATE";
      const orderBy =
        sort === "name_desc"
          ? "tag.display_name DESC, tag.id DESC"
          : sort === "record_count_desc"
            ? "record_count DESC, tag.display_name, tag.id"
            : "tag.display_name, tag.id";
      const result = await pool.query<{
        id: string;
        display_name: string;
        origin: "USER_CREATED" | "AI_CREATED";
        approval_status: "CANDIDATE" | "USER_APPROVED";
        record_count: number;
      }>(
        `WITH ${EFFECTIVE_TAG_RECORDS_CTE}
         SELECT tag.id,
                tag.display_name,
                tag.origin,
                tag.approval_status,
                COUNT(DISTINCT effective_record.record_id)::integer AS record_count
           FROM tags AS tag
           LEFT JOIN effective_tag_records AS effective_record
             ON effective_record.tag_id = tag.id
          WHERE tag.approval_status = $2
            AND tag.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM tag_merges AS active_merge
               WHERE active_merge.source_tag_id = tag.id
                 AND active_merge.undone_at IS NULL
            )
            AND (
              $1::text = ''
              OR tag.display_name ILIKE '%' || $1 || '%'
              OR EXISTS (
                SELECT 1
                  FROM tag_aliases AS alias
                 WHERE resolve_tag_id(alias.tag_id) = tag.id
                   AND alias.display_name ILIKE '%' || $1 || '%'
              )
              OR EXISTS (
                SELECT 1
                  FROM tag_merges AS active_merge
                  INNER JOIN tags AS source_tag
                    ON source_tag.id = active_merge.source_tag_id
                 WHERE active_merge.target_tag_id = tag.id
                   AND active_merge.undone_at IS NULL
                   AND source_tag.display_name ILIKE '%' || $1 || '%'
              )
            )
          GROUP BY tag.id
          ORDER BY ${orderBy}`,
        [query, approvalStatus],
      );

      return {
        items: result.rows.map(publicTagFromRow),
        page: { nextCursor: null },
      };
    },
  );

  app.get("/api/v1/tag-field", async () => {
    const result = await pool.query<{
      id: string;
      display_name: string;
      approval_status: "CANDIDATE" | "USER_APPROVED";
      record_count: number;
    }>(
      `WITH ${EFFECTIVE_TAG_RECORDS_CTE}
       SELECT tag.id,
              tag.display_name,
              tag.approval_status,
              COUNT(DISTINCT effective_record.record_id)::integer AS record_count
         FROM tags AS tag
         LEFT JOIN effective_tag_records AS effective_record
           ON effective_record.tag_id = tag.id
        WHERE tag.approval_status IN ('CANDIDATE', 'USER_APPROVED')
          AND tag.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM tag_merges AS active_merge
             WHERE active_merge.source_tag_id = tag.id
               AND active_merge.undone_at IS NULL
          )
        GROUP BY tag.id
        ORDER BY tag.display_name, tag.id`,
    );

    return {
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.display_name,
        approval:
          row.approval_status === "USER_APPROVED" ? "approved" : "candidate",
        recordCount: row.record_count,
      })),
    };
  });

  app.post<{ Params: TagParams }>(
    "/api/v1/tags/:id/approve",
    async (request, reply) => {
      const result = await pool.query<{
        id: string;
        display_name: string;
        origin: "AI_CREATED";
      }>(
        `UPDATE tags
            SET approval_status = 'USER_APPROVED',
                user_approved_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1
            AND origin = 'AI_CREATED'
            AND approval_status = 'CANDIDATE'
            AND NOT EXISTS (
              SELECT 1
                FROM tag_merges AS active_merge
               WHERE active_merge.source_tag_id = tags.id
                 AND active_merge.undone_at IS NULL
            )
          RETURNING id, display_name, origin`,
        [request.params.id],
      );
      const tag = result.rows[0];

      if (!tag) {
        const governed = await pool.query<{ in_use: boolean }>(
          `SELECT EXISTS (
             SELECT 1
               FROM tag_merges
              WHERE source_tag_id = $1
                AND undone_at IS NULL
           ) AS in_use`,
          [request.params.id],
        );

        if (governed.rows[0]?.in_use) {
          return reply.code(409).send({
            error: {
              code: "TAG_GOVERNANCE_IN_USE",
              message: "合并来源标签需先撤销合并，再认可为独立标签。",
            },
          });
        }

        return reply.code(404).send({ error: "Candidate tag not found" });
      }

      return {
        tag: {
          id: tag.id,
          name: tag.display_name,
          origin: "ai_created",
          approvalStatus: "user_approved",
        },
      };
    },
  );

  app.post<{ Body: CreateTagBody; Params: TagParams }>(
    "/api/v1/tags/:id/aliases",
    async (request, reply) => {
      const name = request.body?.name;
      const normalizedName =
        typeof name === "string" ? normalizeTagName(name) : "";

      if (!normalizedName) {
        return reply.code(422).send({
          error: {
            code: "TAG_ALIAS_INVALID",
            message: "标签别名不能为空。",
          },
        });
      }

      const tag = await readPublicTag(pool, request.params.id);

      if (!tag || tag.approvalStatus !== "user_approved") {
        return reply.code(404).send({
          error: {
            code: "TAG_ALIAS_TARGET_NOT_FOUND",
            message: "只能为当前有效的“我的标签”添加别名。",
          },
        });
      }

      const existing = await readTagByNormalizedName(pool, normalizedName);

      if (existing) {
        return tagNameConflict(reply, existing);
      }

      const aliasId = randomUUID();

      try {
        await pool.query(
          `INSERT INTO tag_aliases
             (id, tag_id, display_name, normalized_name)
           VALUES ($1, $2, $3, $4)`,
          [aliasId, tag.id, name, normalizedName],
        );
      } catch (error) {
        if (!isTagVocabularyNameViolation(error)) {
          throw error;
        }

        const conflict = await readTagByNormalizedName(pool, normalizedName);

        if (!conflict) {
          throw error;
        }

        return tagNameConflict(reply, conflict);
      }

      scheduleSemanticIndex();

      return reply
        .code(201)
        .header(
          "location",
          `/api/v1/tags/${tag.id}/aliases/${aliasId}`,
        )
        .send({ alias: { id: aliasId, name }, tag });
    },
  );

  app.delete<{ Params: TagAliasParams }>(
    "/api/v1/tags/:id/aliases/:aliasId",
    async (request, reply) => {
      const deleted = await pool.query(
        `DELETE FROM tag_aliases
              WHERE id = $2
                AND resolve_tag_id(tag_id) = resolve_tag_id($1::uuid)
          RETURNING id`,
        [request.params.id, request.params.aliasId],
      );

      if (!deleted.rows[0]) {
        return reply.code(404).send({
          error: { code: "TAG_ALIAS_NOT_FOUND", message: "标签别名不存在。" },
        });
      }

      scheduleSemanticIndex();
      return reply.code(204).send();
    },
  );

  app.post<{ Body: CreateTagMergeBody }>(
    "/api/v1/tag-merges",
    async (request, reply) => {
      if (!isCreateTagMergeBody(request.body)) {
        return reply.code(422).send({
          error: {
            code: "TAG_MERGE_INVALID",
            message: "请选择一个主标签和至少一个不同的来源标签。",
          },
        });
      }

      const { sourceTagIds, targetTagId } = request.body;
      const [targetTag, ...sourceTags] = await Promise.all([
        readPublicTag(pool, targetTagId),
        ...sourceTagIds.map((id) => readPublicTag(pool, id)),
      ]);

      if (
        !targetTag ||
        targetTag.id !== targetTagId ||
        targetTag.approvalStatus !== "user_approved" ||
        sourceTags.some(
          (tag, index) =>
            !tag ||
            tag.id !== sourceTagIds[index] ||
            tag.approvalStatus === "archived",
        )
      ) {
        return reply.code(409).send({
          error: {
            code: "TAG_MERGE_NOT_ALLOWED",
            message: "主标签必须已认可，且来源标签必须是尚未合并的有效标签。",
          },
        });
      }

      const operationId = randomUUID();

      try {
        await pool.query(
          `INSERT INTO tag_merges
             (operation_id, source_tag_id, target_tag_id)
           SELECT $1, source_tag_id, $3
             FROM unnest($2::uuid[]) AS source_tag_id`,
          [operationId, sourceTagIds, targetTagId],
        );
      } catch (error) {
        if (!isTagMergeConstraintViolation(error)) {
          throw error;
        }

        return reply.code(409).send({
          error: {
            code: "TAG_MERGE_NOT_ALLOWED",
            message: "标签已参与其他有效合并，不能形成合并链或重复合并。",
          },
        });
      }

      const mergedTarget = await readPublicTag(pool, targetTagId);

      if (!mergedTarget) {
        throw new Error("Merged target tag could not be read");
      }

      scheduleSemanticIndex();

      return reply.code(201).send({
        merge: {
          id: operationId,
          sourceTags,
          targetTag: mergedTarget,
        },
      });
    },
  );

  app.delete<{ Params: TagMergeParams }>(
    "/api/v1/tag-merges/:id",
    async (request, reply) => {
      const undone = await pool.query(
        `UPDATE tag_merges
            SET undone_at = clock_timestamp()
          WHERE operation_id = $1
            AND undone_at IS NULL
        RETURNING id`,
        [request.params.id],
      );

      if (!undone.rows[0]) {
        return reply.code(404).send({
          error: {
            code: "TAG_MERGE_NOT_FOUND",
            message: "有效的标签合并不存在。",
          },
        });
      }

      scheduleSemanticIndex();
      return reply.code(204).send();
    },
  );

  app.get<{ Params: TagParams }>(
    "/api/v1/tags/:id",
    async (request, reply) => {
      const detail = await readTagDetail(pool, request.params.id);

      if (!detail) {
        return reply.code(404).send({
          error: { code: "TAG_NOT_FOUND", message: "标签不存在。" },
        });
      }

      return detail;
    },
  );

  app.patch<{ Body: TagPatchBody; Params: TagParams }>(
    "/api/v1/tags/:id",
    async (request, reply) => {
      if (!isTagPatchBody(request.body)) {
        return reply.code(422).send({
          error: {
            code: "TAG_UPDATE_INVALID",
            message: "一次只能改名，或变更归档状态。",
          },
        });
      }

      if ("name" in request.body) {
        const normalizedName = normalizeTagName(request.body.name);

        if (!normalizedName) {
          return reply.code(422).send({
            error: {
              code: "TAG_UPDATE_INVALID",
              message: "标签名称不能为空。",
            },
          });
        }

        const existing = await readTagByNormalizedName(pool, normalizedName);

        if (existing && existing.id !== request.params.id) {
          return tagNameConflict(reply, existing);
        }

        try {
          const renamed = await pool.query<{ id: string }>(
            `UPDATE tags
                SET display_name = $2,
                    normalized_name = $3,
                    updated_at = clock_timestamp()
              WHERE id = $1
                AND approval_status = 'USER_APPROVED'
              RETURNING id`,
            [request.params.id, request.body.name, normalizedName],
          );

          if (!renamed.rows[0]) {
            return tagUpdateNotFoundOrAllowed(pool, request.params.id, reply);
          }
        } catch (error) {
          if (!isTagNameUniqueViolation(error)) {
            throw error;
          }

          const conflict = await readTagByNormalizedName(pool, normalizedName);

          if (!conflict) {
            throw error;
          }

          return tagNameConflict(reply, conflict);
        }
      } else {
        const client = await pool.connect();

        try {
          await client.query("BEGIN");
          const current = await client.query<{
            approval_status: "ARCHIVED" | "CANDIDATE" | "USER_APPROVED";
          }>(
            `SELECT approval_status
               FROM tags
              WHERE id = $1
              FOR UPDATE`,
            [request.params.id],
          );
          const tag = current.rows[0];

          if (!tag) {
            await client.query("ROLLBACK");
            return reply.code(404).send({
              error: { code: "TAG_NOT_FOUND", message: "标签不存在。" },
            });
          }

          if (request.body.approvalStatus === "archived") {
            if (tag.approval_status === "CANDIDATE") {
              await client.query("ROLLBACK");
              return reply.code(409).send({
                error: {
                  code: "TAG_UPDATE_NOT_ALLOWED",
                  message: "AI 候选只能认可或删除，不能归档。",
                },
              });
            }

            if (tag.approval_status === "USER_APPROVED") {
              const governed = await client.query<{ in_use: boolean }>(
                `SELECT EXISTS (
                   SELECT 1
                     FROM tag_aliases AS alias
                    WHERE alias.tag_id = $1
                 ) OR EXISTS (
                   SELECT 1
                     FROM tag_merges AS active_merge
                    WHERE (
                      active_merge.source_tag_id = $1
                      OR active_merge.target_tag_id = $1
                    )
                      AND active_merge.undone_at IS NULL
                 ) AS in_use`,
                [request.params.id],
              );

              if (governed.rows[0]?.in_use) {
                await client.query("ROLLBACK");
                return reply.code(409).send({
                  error: {
                    code: "TAG_GOVERNANCE_IN_USE",
                    message: "请先移除标签别名或撤销相关合并，再变更标签状态。",
                  },
                });
              }

              const blocked = await client.query<{ record_id: string }>(
                `SELECT assignment.record_id
                   FROM tag_assignments AS assignment
                   INNER JOIN records AS record
                     ON record.id = assignment.record_id
                  WHERE assignment.tag_id = $1
                    AND assignment.assigned_by = 'USER'
                    AND assignment.status = 'ACTIVE'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM tag_assignments AS alternative
                        INNER JOIN tags AS alternative_tag
                          ON alternative_tag.id = alternative.tag_id
                         AND alternative_tag.approval_status = 'USER_APPROVED'
                         AND alternative_tag.archived_at IS NULL
                       WHERE alternative.record_id = assignment.record_id
                         AND alternative.assigned_by = 'USER'
                         AND alternative.status = 'ACTIVE'
                         AND alternative.tag_id <> assignment.tag_id
                    )
                  LIMIT 1
                  FOR UPDATE OF record`,
                [request.params.id],
              );

              if (blocked.rows[0]) {
                await client.query("ROLLBACK");
                return reply.code(409).send({
                  error: {
                    code: "TAG_ARCHIVE_RECORD_TAG_REQUIRED",
                    message: "仍有记录只使用这个“我的标签”，请先为它们添加其他标签。",
                  },
                });
              }

              await client.query(
                `UPDATE tags
                    SET approval_status = 'ARCHIVED',
                        archived_at = clock_timestamp(),
                        updated_at = clock_timestamp()
                  WHERE id = $1`,
                [request.params.id],
              );
            }
          } else {
            if (tag.approval_status === "CANDIDATE") {
              await client.query("ROLLBACK");
              return reply.code(409).send({
                error: {
                  code: "TAG_UPDATE_NOT_ALLOWED",
                  message: "请使用认可操作升级 AI 候选。",
                },
              });
            }

            if (tag.approval_status === "ARCHIVED") {
              await client.query(
                `UPDATE tags
                    SET approval_status = 'USER_APPROVED',
                        archived_at = NULL,
                        updated_at = clock_timestamp()
                  WHERE id = $1`,
                [request.params.id],
              );
            }
          }

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");

          if (isRecordTagRequiredViolation(error)) {
            return reply.code(409).send({
              error: {
                code: "TAG_ARCHIVE_RECORD_TAG_REQUIRED",
                message: "仍有记录只使用这个“我的标签”，请先为它们添加其他标签。",
              },
            });
          }

          if (isTagGovernanceStateViolation(error)) {
            return reply.code(409).send({
              error: {
                code: "TAG_GOVERNANCE_IN_USE",
                message: "请先移除标签别名或撤销相关合并，再变更标签状态。",
              },
            });
          }

          throw error;
        } finally {
          client.release();
        }
      }

      const updated = await readPublicTag(pool, request.params.id);

      if (!updated) {
        throw new Error("Updated tag could not be read");
      }

      return { tag: updated };
    },
  );

  app.delete<{ Body: DeleteCandidateTagsBody }>(
    "/api/v1/tags",
    async (request, reply) => {
      if (!isDeleteCandidateTagsBody(request.body)) {
        return reply.code(422).send({
          error: {
            code: "TAG_BATCH_DELETE_INVALID",
            message: "请选择至少一个有效的 AI 候选标签。",
          },
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const current = await client.query<{
          approval_status: "ARCHIVED" | "CANDIDATE" | "USER_APPROVED";
          id: string;
          is_merge_source: boolean;
        }>(
          `SELECT tag.id,
                  tag.approval_status,
                  EXISTS (
                    SELECT 1
                      FROM tag_merges AS active_merge
                     WHERE active_merge.source_tag_id = tag.id
                       AND active_merge.undone_at IS NULL
                  ) AS is_merge_source
             FROM tags AS tag
            WHERE id = ANY($1::uuid[])
            ORDER BY id
            FOR UPDATE`,
          [request.body.ids],
        );

        if (current.rows.length !== request.body.ids.length) {
          await client.query("ROLLBACK");
          return reply.code(404).send({
            error: {
              code: "TAG_NOT_FOUND",
              message: "部分标签不存在，请刷新后重试。",
            },
          });
        }

        if (current.rows.some((tag) => tag.approval_status !== "CANDIDATE")) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "TAG_DELETE_NOT_ALLOWED",
              message: "已认可标签不能删除，请使用归档。",
            },
          });
        }

        if (current.rows.some((tag) => tag.is_merge_source)) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "TAG_GOVERNANCE_IN_USE",
              message: "合并来源标签需先撤销合并，不能直接删除。",
            },
          });
        }

        await client.query(
          "DELETE FROM tag_assignments WHERE tag_id = ANY($1::uuid[])",
          [request.body.ids],
        );
        await client.query("DELETE FROM tags WHERE id = ANY($1::uuid[])", [
          request.body.ids,
        ]);
        await client.query("COMMIT");

        return { deletedCount: request.body.ids.length };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: TagParams }>(
    "/api/v1/tags/:id",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const current = await client.query<{
          approval_status: "ARCHIVED" | "CANDIDATE" | "USER_APPROVED";
          is_merge_source: boolean;
        }>(
          `SELECT tag.approval_status,
                  EXISTS (
                    SELECT 1
                      FROM tag_merges AS active_merge
                     WHERE active_merge.source_tag_id = tag.id
                       AND active_merge.undone_at IS NULL
                  ) AS is_merge_source
             FROM tags AS tag
            WHERE tag.id = $1
            FOR UPDATE`,
          [request.params.id],
        );
        const tag = current.rows[0];

        if (!tag) {
          await client.query("ROLLBACK");
          return reply.code(404).send({
            error: { code: "TAG_NOT_FOUND", message: "标签不存在。" },
          });
        }

        if (tag.approval_status !== "CANDIDATE") {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "TAG_DELETE_NOT_ALLOWED",
              message: "已认可标签不能删除，请使用归档。",
            },
          });
        }

        if (tag.is_merge_source) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "TAG_GOVERNANCE_IN_USE",
              message: "合并来源标签需先撤销合并，不能直接删除。",
            },
          });
        }

        await client.query("DELETE FROM tag_assignments WHERE tag_id = $1", [
          request.params.id,
        ]);
        await client.query("DELETE FROM tags WHERE id = $1", [
          request.params.id,
        ]);
        await client.query("COMMIT");

        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.put<{ Body: TagVisibilityBody; Params: TagVisibilityParams }>(
    "/api/v1/tags/:id/records/:recordId/items/:itemId/visibility",
    async (request, reply) => {
      if (
        request.body?.status !== "active" &&
        request.body?.status !== "suppressed"
      ) {
        return reply.code(422).send({
          error: {
            code: "TAG_VISIBILITY_INVALID",
            message: "标签关联状态无效。",
          },
        });
      }

      const updated = await pool.query(
        `UPDATE tag_assignments AS assignment
            SET status = $4
           FROM knowledge_points AS point
          WHERE resolve_tag_id(assignment.tag_id) = resolve_tag_id($1::uuid)
            AND assignment.knowledge_point_id = $3
            AND assignment.assigned_by = 'AI'
            AND point.id = assignment.knowledge_point_id
            AND point.record_id = $2
          RETURNING assignment.id`,
        [
          request.params.id,
          request.params.recordId,
          request.params.itemId,
          request.body.status === "active" ? "ACTIVE" : "SUPPRESSED",
        ],
      );

      if (!updated.rows[0]) {
        return reply.code(404).send({
          error: {
            code: "TAG_ASSOCIATION_NOT_FOUND",
            message: "未找到这条知识点标签关联。",
          },
        });
      }

      return reply.code(204).send();
    },
  );

  app.get<{ Params: TagParams }>(
    "/api/v1/tags/:id/records",
    async (request, reply) => {
      const tagResult = await pool.query<{
        id: string;
        display_name: string;
      }>(
        `SELECT id, display_name
           FROM tags
          WHERE id = resolve_tag_id($1::uuid)
            AND approval_status IN ('CANDIDATE', 'USER_APPROVED')
            AND archived_at IS NULL`,
        [request.params.id],
      );
      const tag = tagResult.rows[0];

      if (!tag) {
        return reply.code(404).send({ error: "Tag not found" });
      }

      const records = await findRecords(pool, "", undefined, [tag.id]);

      return {
        tag: { id: tag.id, name: tag.display_name },
        items: records.map(({ card }) => card),
        page: { nextCursor: null },
      };
    },
  );

  app.get<{ Params: RecordParams }>(
    "/api/v1/records/:id",
    async (request, reply) => {
      const [record] = await findRecords(pool, "", request.params.id);

      if (!record) {
        return reply.code(404).send({ error: "Record not found" });
      }

      const { card, content } = record;
      const [
        currentOrganization,
        observableTask,
        organizationCandidate,
        overviewCorrection,
      ] =
        await Promise.all([
          readCurrentOrganization(pool, request.params.id),
          readObservableOrganizationTask(pool, request.params.id),
          readOrganizationCandidate(pool, request.params.id),
          readOverviewCorrection(pool, request.params.id),
        ]);

      return {
        id: card.id,
        lifecycle: card.lifecycle,
        presentation:
          currentOrganization && overviewCorrection
            ? {
                title: overviewCorrection.title,
                summary: overviewCorrection.summary,
                source: "user_correction",
                aiOriginal: {
                  title: currentOrganization.title,
                  summary: currentOrganization.summary,
                },
                correction: overviewCorrection,
              }
            : {
                title: currentOrganization?.title ?? card.title,
                summary: currentOrganization?.summary ?? null,
                source: currentOrganization ? "ai" : "original",
              },
        editable: {
          text: content,
          textVersion: card.textVersion,
          myTags: card.myTags,
        },
        organization: {
          view: currentOrganization ? "organized" : "original",
          activity: observableTask?.status ?? "idle",
          task: observableTask,
          ...(organizationCandidate
            ? { candidate: organizationCandidate }
            : {}),
        },
        organizedItems:
          currentOrganization?.items.filter(
            (item) => item.usageStatus === "INCLUDED",
          ) ?? [],
        excludedItems:
          currentOrganization?.items.filter(
            (item) => item.usageStatus === "EXCLUDED",
          ) ?? [],
        updatedAt: card.updatedAt,
      };
    },
  );

  app.get<{ Params: RecordParams }>(
    "/api/v1/records/:id/history",
    async (request, reply) => {
      const [originalResult, organizationResult] = await Promise.all([
        pool.query<{
        id: string;
        revision_number: number;
        created_at: Date | string;
        is_current: boolean;
        }>(
        `SELECT revision.id,
                revision.revision_number,
                revision.created_at,
                revision.id = record.current_fragment_revision_id AS is_current
           FROM records AS record
           INNER JOIN fragment_revisions AS revision
             ON revision.record_id = record.id
          WHERE record.id = $1
          ORDER BY revision.revision_number DESC`,
        [request.params.id],
        ),
        pool.query<{
          id: string;
          source_text_version: number;
          status: string;
          created_at: Date | string;
          is_current: boolean;
        }>(
          `SELECT analysis.id,
                  revision.revision_number AS source_text_version,
                  analysis.status,
                  analysis.generated_at AS created_at,
                  COALESCE(
                    analysis.id = record.current_analysis_revision_id,
                    false
                  ) AS is_current
             FROM records AS record
             INNER JOIN ai_analysis_revisions AS analysis
               ON analysis.record_id = record.id
             INNER JOIN fragment_revisions AS revision
               ON revision.id = analysis.fragment_revision_id
            WHERE record.id = $1`,
          [request.params.id],
        ),
      ]);

      if (originalResult.rows.length === 0) {
        return reply.code(404).send({ error: "Record not found" });
      }

      const items = [
        ...originalResult.rows.map((row) => ({
          id: row.id,
          type: "original" as const,
          version: row.revision_number,
          createdAt: asIsoString(row.created_at),
          isCurrent: row.is_current,
        })),
        ...organizationResult.rows.map((row) => ({
          id: row.id,
          type: "organization" as const,
          sourceTextVersion: row.source_text_version,
          status: row.status,
          createdAt: asIsoString(row.created_at),
          isCurrent: row.is_current,
        })),
      ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

      return {
        items,
        page: { nextCursor: null },
      };
    },
  );

  app.get<{ Params: HistoryEntryParams }>(
    "/api/v1/records/:id/history/:entryId",
    async (request, reply) => {
      const result = await pool.query<{
        id: string;
        revision_number: number;
        content: string;
        created_at: Date | string;
        current_version: number;
      }>(
        `SELECT selected.id,
                selected.revision_number,
                selected.content,
                selected.created_at,
                current.revision_number AS current_version
           FROM records AS record
           INNER JOIN fragment_revisions AS selected
             ON selected.record_id = record.id
            AND selected.id = $2
           INNER JOIN fragment_revisions AS current
             ON current.id = record.current_fragment_revision_id
          WHERE record.id = $1`,
        [request.params.id, request.params.entryId],
      );
      const entry = result.rows[0];

      if (entry) {
        return {
          id: entry.id,
          type: "original",
          version: entry.revision_number,
          createdAt: asIsoString(entry.created_at),
          snapshot: { text: entry.content },
          currentVersion: entry.current_version,
        };
      }

      const organization = await pool.query<{
        id: string;
        title: string;
        summary: string;
        status: string;
        generated_at: Date | string;
        source_text_version: number;
        current_text_version: number;
      }>(
        `SELECT analysis.id,
                analysis.title,
                analysis.summary,
                analysis.status,
                analysis.generated_at,
                source_revision.revision_number AS source_text_version,
                current_revision.revision_number AS current_text_version
           FROM records AS record
           INNER JOIN ai_analysis_revisions AS analysis
             ON analysis.record_id = record.id
            AND analysis.id = $2
           INNER JOIN fragment_revisions AS source_revision
             ON source_revision.id = analysis.fragment_revision_id
           INNER JOIN fragment_revisions AS current_revision
             ON current_revision.id = record.current_fragment_revision_id
          WHERE record.id = $1`,
        [request.params.id, request.params.entryId],
      );
      const analysis = organization.rows[0];

      if (!analysis) {
        return reply.code(404).send({ error: "History entry not found" });
      }

      const points = await pool.query<{ ai_title: string; ai_body: string }>(
        `SELECT ai_title, ai_body
           FROM knowledge_points
          WHERE analysis_revision_id = $1
          ORDER BY position`,
        [analysis.id],
      );

      return {
        id: analysis.id,
        type: "organization",
        sourceTextVersion: analysis.source_text_version,
        status: analysis.status,
        createdAt: asIsoString(analysis.generated_at),
        snapshot: {
          title: analysis.title,
          summary: analysis.summary,
          organizedItems: points.rows.map((point) => ({
            title: point.ai_title,
            body: point.ai_body,
          })),
        },
        currentTextVersion: analysis.current_text_version,
      };
    },
  );

  app.get<{ Querystring: SearchQuery }>(
    "/api/v1/search",
    async (request, reply) => {
      const query = request.query.q ?? "";
      const requestedTags = request.query.tag;
      const tagIds = requestedTags
        ? Array.isArray(requestedTags)
          ? requestedTags
          : [requestedTags]
        : [];
      const scope: SearchScope =
        request.query.scope === "include_review"
          ? "include_review"
          : "current";
      const limit = parseRecordPageLimit(request.query.limit);
      const cursor = decodeSearchCursor(request.query.cursor);

      if (limit === null || cursor === undefined) {
        return reply.code(400).send({
          error: {
            code: "INVALID_SEARCH_PAGE",
            message: "搜索分页参数无效。",
          },
        });
      }

      const signature = searchSignature(query, tagIds, scope);

      if (cursor) {
        const snapshot = searchSnapshots.get(cursor.snapshotId);

        if (!snapshot) {
          return reply.code(410).send({
            error: {
              code: "SEARCH_SNAPSHOT_EXPIRED",
              message: "本次搜索快照已失效，请重新提交查询。",
            },
          });
        }

        if (snapshot.signature !== signature) {
          return reply.code(400).send({
            error: {
              code: "SEARCH_CURSOR_MISMATCH",
              message: "搜索条件已变化，请重新提交查询。",
            },
          });
        }

        return searchSnapshotPage(
          cursor.snapshotId,
          snapshot,
          cursor.offset,
          limit,
        );
      }

      const records = await findRecords(pool, "", undefined, tagIds, {
        searchScope: scope,
      });
      const pointsByRecord = await findSearchableKnowledgePoints(
        pool,
        records.map((record) => record.card.id),
        query,
        scope,
      );
      const groupedByRecord = new Map<
        string,
        { matches: ScoredSearchMatch[]; record: StoredRecord }
      >();

      for (const record of records) {
        const matches = keywordMatchesForRecord(
          record,
          pointsByRecord.get(record.card.id) ?? [],
          query,
        );

        if (matches.length > 0) {
          groupedByRecord.set(record.card.id, { matches, record });
        }
      }

      const recordsById = new Map(
        records.map((record) => [record.card.id, record]),
      );
      const semanticMatches =
        query
          ? await findSemanticMatches({
              pool,
              credentialSecret,
              embedText,
              query,
            })
          : [];

      for (const semanticMatch of semanticMatches) {
        const record = recordsById.get(semanticMatch.recordId);

        if (!record) {
          continue;
        }

        const group = groupedByRecord.get(record.card.id) ?? {
          matches: [],
          record,
        };
        const source = semanticSource(semanticMatch);
        const keywordMatch = group.matches.find(
          ({ match }) =>
            match.source.id === source.id &&
            match.source.type === source.type,
        );

        if (keywordMatch) {
          keywordMatch.score += semanticMatch.score;
        } else {
          group.matches.push({
            match: {
              reason: "semantic",
              snippets: [{ text: semanticMatch.text, highlights: [] }],
              source,
              visibility: "current",
            },
            score: semanticMatch.score,
          });
        }

        groupedByRecord.set(record.card.id, group);
      }

      const rankedResults = [...groupedByRecord.values()].flatMap<{
        item: SearchResultItem;
        score: number;
      }>(({ matches, record }) => {
        matches.sort(compareSearchMatches);

        const [primary, ...others] = matches;

        return primary
          ? [
              {
                item: {
                  record: record.card,
                  match: primary.match,
                  otherMatches: others.map(({ match }) => match),
                },
                score: primary.score,
              },
            ]
          : [];
      });

      rankedResults.sort(compareSearchResults);

      const snapshotId = randomUUID();
      const snapshot: SearchSnapshot = {
        signature,
        items: rankedResults.map(({ item }) => item),
      };

      if (snapshot.items.length > limit) {
        searchSnapshots.set(snapshotId, snapshot);

        if (searchSnapshots.size > MAX_SEARCH_SNAPSHOTS) {
          const oldestSnapshotId = searchSnapshots.keys().next().value;

          if (typeof oldestSnapshotId === "string") {
            searchSnapshots.delete(oldestSnapshotId);
          }
        }
      }

      return searchSnapshotPage(snapshotId, snapshot, 0, limit);
    },
  );

  return app;
}

async function createSaveOnlyRecord(
  client: PoolClient,
  text: string,
  requestedTags: RequestedTag[],
): Promise<RecordCard> {
  const recordId = randomUUID();
  const revisionId = randomUUID();

  await client.query("BEGIN");

  try {
    const recordResult = await client.query<{ updated_at: Date | string }>(
      `INSERT INTO records (id, current_fragment_revision_id)
       VALUES ($1, $2)
       RETURNING updated_at`,
      [recordId, revisionId],
    );

    await client.query(
      `INSERT INTO fragment_revisions
         (id, record_id, revision_number, content, grapheme_count)
       VALUES ($1, $2, 1, $3, $4)`,
      [revisionId, recordId, text, countGraphemes(text)],
    );

    const tags = await assignRequestedTags(client, recordId, requestedTags);

    await client.query("COMMIT");

    const updatedAt = recordResult.rows[0]?.updated_at;

    if (!updatedAt) {
      throw new Error("Record insert did not return updated_at");
    }

    return recordCard(recordId, text, 1, updatedAt, tags);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function updateSaveOnlyRecord(
  client: PoolClient,
  recordId: string,
  text: string,
  requestedTags: RequestedTag[],
): Promise<RecordCard | null> {
  await client.query("BEGIN");

  try {
    const current = await client.query<{
      content: string;
      revision_number: number;
    }>(
      `SELECT revision.content,
              revision.revision_number
         FROM records AS record
         INNER JOIN fragment_revisions AS revision
           ON revision.id = record.current_fragment_revision_id
        WHERE record.id = $1
          AND record.archived_at IS NULL
        FOR UPDATE OF record`,
      [recordId],
    );

    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const textChanged = current.rows[0].content !== text;
    const revisionNumber =
      current.rows[0].revision_number + (textChanged ? 1 : 0);
    const revisionId = textChanged ? randomUUID() : null;

    if (revisionId) {
      await client.query(
        `INSERT INTO fragment_revisions
           (id, record_id, revision_number, content, grapheme_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [revisionId, recordId, revisionNumber, text, countGraphemes(text)],
      );
    }
    await client.query(
      "DELETE FROM tag_assignments WHERE record_id = $1",
      [recordId],
    );
    const tags = await assignRequestedTags(client, recordId, requestedTags);
    const updated = await client.query<{ updated_at: Date | string }>(
      `UPDATE records
          SET current_fragment_revision_id = COALESCE($2, current_fragment_revision_id),
              updated_at = now()
        WHERE id = $1
        RETURNING updated_at`,
      [recordId, revisionId],
    );

    await client.query("COMMIT");

    const updatedAt = updated.rows[0]?.updated_at;

    if (!updatedAt) {
      throw new Error("Record update did not return updated_at");
    }

    return recordCard(recordId, text, revisionNumber, updatedAt, tags);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function assignRequestedTags(
  client: PoolClient,
  recordId: string,
  requestedTags: RequestedTag[],
): Promise<TagChip[]> {
  const tags: TagChip[] = [];
  const assignedTagIds = new Set<string>();

  for (const requestedTag of requestedTags) {
    let tag: TagChip;

    if ("id" in requestedTag) {
      const selectedTag = await client.query<{
        id: string;
        display_name: string;
      }>(
        `SELECT id, display_name
           FROM tags
          WHERE id = resolve_tag_id($1::uuid)
            AND approval_status = 'USER_APPROVED'
            AND archived_at IS NULL`,
        [requestedTag.id],
      );

      if (!selectedTag.rows[0]) {
        throw new Error("Selected tag is not user-approved");
      }

      tag = {
        id: selectedTag.rows[0].id,
        name: selectedTag.rows[0].display_name,
      };
    } else {
      const tagId = randomUUID();
      const normalizedName = normalizeTagName(requestedTag.name);
      const existingTag = await client.query<{
        approval_status: "ARCHIVED" | "CANDIDATE" | "USER_APPROVED";
        id: string;
        display_name: string;
        match_kind: "ALIAS" | "TAG";
        matched_tag_id: string;
      }>(
        `WITH name_match AS (
           SELECT tag.id AS tag_id, 'TAG'::text AS match_kind, 0 AS priority
             FROM tags AS tag
            WHERE tag.normalized_name = $1
           UNION ALL
           SELECT alias.tag_id, 'ALIAS'::text, 1
             FROM tag_aliases AS alias
            WHERE alias.normalized_name = $1
         )
         SELECT resolved.id,
                resolved.display_name,
                resolved.approval_status,
                name_match.match_kind,
                name_match.tag_id AS matched_tag_id
           FROM name_match
           INNER JOIN tags AS resolved
             ON resolved.id = resolve_tag_id(name_match.tag_id)
          ORDER BY name_match.priority
          LIMIT 1`,
        [normalizedName],
      );

      if (existingTag.rows[0]) {
        const existing = existingTag.rows[0];

        if (
          existing.approval_status === "USER_APPROVED" &&
          (existing.match_kind === "ALIAS" ||
            existing.matched_tag_id !== existing.id)
        ) {
          tag = { id: existing.id, name: existing.display_name };
        } else {
          throw new TagNameConflictError({
            id: existing.id,
            name: existing.display_name,
          });
        }
      } else {
        try {
          await client.query(
            `INSERT INTO tags
               (id, display_name, normalized_name, origin, approval_status,
                user_approved_at)
             VALUES ($1, $2, $3, 'USER_CREATED', 'USER_APPROVED', now())`,
            [tagId, requestedTag.name, normalizedName],
          );
        } catch (error) {
          if (!isTagVocabularyNameViolation(error)) {
            throw error;
          }

          const conflict = await client.query<{
            display_name: string;
            id: string;
          }>(
            `SELECT id, display_name
               FROM tags
              WHERE id = resolve_tag_name($1)`,
            [normalizedName],
          );

          if (!conflict.rows[0]) {
            throw error;
          }

          throw new TagNameConflictError({
            id: conflict.rows[0].id,
            name: conflict.rows[0].display_name,
          });
        }

        tag = { id: tagId, name: requestedTag.name };
      }
    }

    if (assignedTagIds.has(tag.id)) {
      continue;
    }

    await client.query(
      `INSERT INTO tag_assignments (record_id, tag_id)
       VALUES ($1, $2)`,
      [recordId, tag.id],
    );
    tags.push(tag);
    assignedTagIds.add(tag.id);
  }

  return tags;
}

async function readOverviewCorrection(pool: Pool, recordId: string) {
  const result = await pool.query<{
    title: string;
    summary: string;
    updated_at: Date | string;
  }>(
    `SELECT correction.title,
            correction.summary,
            correction.updated_at
       FROM records AS record
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = record.current_analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN record_overview_corrections AS correction
         ON correction.record_id = record.id
        AND correction.analysis_revision_id = analysis.id
      WHERE record.id = $1`,
    [recordId],
  );
  const correction = result.rows[0];

  return correction
    ? {
        title: correction.title,
        summary: correction.summary,
        updatedAt: asIsoString(correction.updated_at),
      }
    : null;
}

async function readTagByNormalizedName(
  database: Pool | PoolClient,
  normalizedName: string,
): Promise<TagChip | null> {
  const result = await database.query<{
    display_name: string;
    id: string;
  }>(
    `SELECT tag.id, tag.display_name
       FROM tags AS tag
      WHERE tag.id = resolve_tag_name($1)`,
    [normalizedName],
  );
  const tag = result.rows[0];

  return tag ? { id: tag.id, name: tag.display_name } : null;
}

async function readPublicTag(
  pool: Pool,
  tagId: string,
): Promise<PublicTag | null> {
  const result = await pool.query<TagSummaryRow>(
    `WITH ${EFFECTIVE_TAG_RECORDS_CTE}
     SELECT tag.id,
            tag.display_name,
            tag.origin,
            tag.approval_status,
            COUNT(DISTINCT effective_record.record_id)::integer AS record_count
       FROM tags AS tag
       LEFT JOIN effective_tag_records AS effective_record
         ON effective_record.tag_id = tag.id
      WHERE tag.id = resolve_tag_id($1::uuid)
      GROUP BY tag.id`,
    [tagId],
  );

  return result.rows[0] ? publicTagFromRow(result.rows[0]) : null;
}

async function readTagDetail(pool: Pool, tagId: string) {
  const tag = await readPublicTag(pool, tagId);

  if (!tag) {
    return null;
  }

  const [result, aliasResult, mergedSourceResult] = await Promise.all([
    pool.query<{
    assignment_status: "ACTIVE" | "SUPPRESSED" | null;
    content: string;
    effective_title: string | null;
    from_my_tags: boolean;
    knowledge_point_id: string | null;
    knowledge_point_title: string | null;
    record_id: string;
    }>(
    `WITH raw_sources AS (
       SELECT assignment.record_id,
              TRUE AS from_my_tags,
              NULL::uuid AS knowledge_point_id,
              NULL::text AS knowledge_point_title,
              NULL::tag_assignment_status AS assignment_status,
              0 AS knowledge_point_position
         FROM tag_assignments AS assignment
        WHERE resolve_tag_id(assignment.tag_id) = resolve_tag_id($1::uuid)
          AND assignment.assigned_by = 'USER'
       UNION ALL
       SELECT point.record_id,
              FALSE AS from_my_tags,
              point.id AS knowledge_point_id,
              COALESCE(correction.title, point.ai_title) AS knowledge_point_title,
              assignment.status AS assignment_status,
              point.position AS knowledge_point_position
         FROM tag_assignments AS assignment
         INNER JOIN knowledge_points AS point
           ON point.id = assignment.knowledge_point_id
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.id = point.analysis_revision_id
         INNER JOIN records AS source_record
           ON source_record.id = point.record_id
         LEFT JOIN knowledge_point_corrections AS correction
           ON correction.knowledge_point_id = point.id
        WHERE resolve_tag_id(assignment.tag_id) = resolve_tag_id($1::uuid)
          AND assignment.assigned_by = 'AI'
          AND (
            (
              analysis.id = source_record.current_analysis_revision_id
              AND analysis.status = 'ACTIVE'
              AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
              AND point.usage_status = 'INCLUDED'
            )
            OR (
              analysis.status = 'GENERATED'
              AND analysis.fragment_revision_id =
                source_record.current_fragment_revision_id
              AND analysis.id = (
                SELECT candidate.id
                  FROM ai_analysis_revisions AS candidate
                 WHERE candidate.record_id = source_record.id
                   AND candidate.fragment_revision_id =
                     source_record.current_fragment_revision_id
                   AND candidate.status = 'GENERATED'
                 ORDER BY candidate.generated_at DESC, candidate.id DESC
                 LIMIT 1
              )
            )
          )
     ),
     sources AS (
       SELECT raw_source.record_id,
              raw_source.from_my_tags,
              raw_source.knowledge_point_id,
              raw_source.knowledge_point_title,
              CASE
                WHEN raw_source.knowledge_point_id IS NULL
                  THEN NULL::tag_assignment_status
                WHEN BOOL_OR(raw_source.assignment_status = 'ACTIVE')
                  THEN 'ACTIVE'::tag_assignment_status
                ELSE 'SUPPRESSED'::tag_assignment_status
              END AS assignment_status,
              raw_source.knowledge_point_position
         FROM raw_sources AS raw_source
        GROUP BY raw_source.record_id,
                 raw_source.from_my_tags,
                 raw_source.knowledge_point_id,
                 raw_source.knowledge_point_title,
                 raw_source.knowledge_point_position
     )
     SELECT source.record_id,
            source.from_my_tags,
            source.knowledge_point_id,
            source.knowledge_point_title,
            source.assignment_status,
            revision.content,
            COALESCE(overview.title, active.title) AS effective_title
       FROM sources AS source
       INNER JOIN records AS record
         ON record.id = source.record_id
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
       LEFT JOIN ai_analysis_revisions AS active
         ON active.id = record.current_analysis_revision_id
        AND active.status = 'ACTIVE'
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = active.id
      ORDER BY record.updated_at DESC,
               record.id,
               source.from_my_tags DESC,
               source.knowledge_point_position,
               source.knowledge_point_id`,
      [tag.id],
    ),
    pool.query<{ display_name: string; id: string }>(
      `SELECT alias.id, alias.display_name
         FROM tag_aliases AS alias
        WHERE resolve_tag_id(alias.tag_id) = $1
        ORDER BY alias.display_name, alias.id`,
      [tag.id],
    ),
    pool.query<{
      display_name: string;
      id: string;
      operation_id: string;
    }>(
      `SELECT source.id, source.display_name, active_merge.operation_id
         FROM tag_merges AS active_merge
         INNER JOIN tags AS source
           ON source.id = active_merge.source_tag_id
        WHERE active_merge.target_tag_id = $1
          AND active_merge.undone_at IS NULL
        ORDER BY active_merge.created_at, source.display_name, source.id`,
      [tag.id],
    ),
  ]);
  const records = new Map<
    string,
    {
      knowledgePoints: Array<{
        id: string;
        suppressed: boolean;
        title: string;
      }>;
      record: { id: string; title: string };
      sourceSummary: {
        activeKnowledgePointCount: number;
        fromMyTags: boolean;
      };
    }
  >();

  for (const row of result.rows) {
    let grouped = records.get(row.record_id);

    if (!grouped) {
      grouped = {
        record: {
          id: row.record_id,
          title: row.effective_title ?? firstNonEmptyLine(row.content),
        },
        sourceSummary: {
          fromMyTags: false,
          activeKnowledgePointCount: 0,
        },
        knowledgePoints: [],
      };
      records.set(row.record_id, grouped);
    }

    if (row.from_my_tags) {
      grouped.sourceSummary.fromMyTags = true;
    }

    if (row.knowledge_point_id && row.knowledge_point_title) {
      const suppressed = row.assignment_status === "SUPPRESSED";

      grouped.knowledgePoints.push({
        id: row.knowledge_point_id,
        title: row.knowledge_point_title,
        suppressed,
      });
      grouped.sourceSummary.activeKnowledgePointCount += suppressed ? 0 : 1;
    }
  }

  return {
    tag,
    aliases: aliasResult.rows.map((alias) => ({
      id: alias.id,
      name: alias.display_name,
    })),
    mergedSources: mergedSourceResult.rows.map((source) => ({
      id: source.id,
      mergeId: source.operation_id,
      name: source.display_name,
    })),
    records: [...records.values()],
  };
}

function publicTagFromRow(row: TagSummaryRow): PublicTag {
  return {
    id: row.id,
    name: row.display_name,
    origin: row.origin === "USER_CREATED" ? "user_created" : "ai_created",
    approvalStatus:
      row.approval_status === "USER_APPROVED"
        ? "user_approved"
        : row.approval_status === "CANDIDATE"
          ? "candidate"
          : "archived",
    recordCount: row.record_count,
  };
}

function isTagApproval(value: string): value is NonNullable<TagQuery["approval"]> {
  return value === "candidate" || value === "user_approved";
}

function isTagSort(value: string): value is NonNullable<TagQuery["sort"]> {
  return (
    value === "name_asc" ||
    value === "name_desc" ||
    value === "record_count_desc"
  );
}

function isTagPatchBody(value: unknown): value is TagPatchBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);

  return (
    (keys.length === 1 &&
      keys[0] === "name" &&
      typeof body.name === "string") ||
    (keys.length === 1 &&
      keys[0] === "approvalStatus" &&
      (body.approvalStatus === "archived" ||
        body.approvalStatus === "user_approved"))
  );
}

function isDeleteCandidateTagsBody(
  value: unknown,
): value is DeleteCandidateTagsBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);

  return (
    keys.length === 1 &&
    keys[0] === "ids" &&
    Array.isArray(body.ids) &&
    body.ids.length > 0 &&
    body.ids.every((id) => typeof id === "string" && isUuid(id)) &&
    new Set(body.ids).size === body.ids.length
  );
}

function isCreateTagMergeBody(value: unknown): value is CreateTagMergeBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();

  return (
    keys.length === 2 &&
    keys[0] === "sourceTagIds" &&
    keys[1] === "targetTagId" &&
    typeof body.targetTagId === "string" &&
    isUuid(body.targetTagId) &&
    Array.isArray(body.sourceTagIds) &&
    body.sourceTagIds.length > 0 &&
    body.sourceTagIds.length <= 100 &&
    body.sourceTagIds.every((id) => typeof id === "string" && isUuid(id)) &&
    new Set(body.sourceTagIds).size === body.sourceTagIds.length &&
    !body.sourceTagIds.includes(body.targetTagId)
  );
}

function tagNameConflict(reply: FastifyReply, existingTag: TagChip) {
  return reply.code(409).send({
    error: {
      code: "TAG_NAME_CONFLICT",
      message: "已存在同名标签或别名，请使用现有标签或换一个名称。",
      details: { existingTag },
    },
  });
}

async function tagUpdateNotFoundOrAllowed(
  pool: Pool,
  tagId: string,
  reply: FastifyReply,
) {
  const existing = await pool.query<{ approval_status: string }>(
    "SELECT approval_status FROM tags WHERE id = $1",
    [tagId],
  );

  return existing.rows[0]
    ? reply.code(409).send({
        error: {
          code: "TAG_UPDATE_NOT_ALLOWED",
          message: "当前标签状态不允许改名。",
        },
      })
    : reply.code(404).send({
        error: { code: "TAG_NOT_FOUND", message: "标签不存在。" },
      });
}

function isRecordTagRequiredViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as { code?: string; constraint?: string };

  return (
    postgresError.code === "23514" &&
    postgresError.constraint === "records_require_active_user_approved_tag"
  );
}

function isTagNameUniqueViolation(error: unknown): boolean {
  return isTagVocabularyNameViolation(error);
}

function isTagVocabularyNameViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as { code?: string; constraint?: string };

  return (
    postgresError.code === "23505" &&
    (postgresError.constraint === "tags_normalized_name_unique" ||
      postgresError.constraint === "tag_aliases_normalized_name_unique" ||
      postgresError.constraint === "tag_vocabulary_normalized_name_unique")
  );
}

function isTagMergeConstraintViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as { code?: string; constraint?: string };

  return (
    (postgresError.code === "23505" &&
      postgresError.constraint === "tag_merges_one_active_source_idx") ||
    (postgresError.code === "23514" &&
      postgresError.constraint?.startsWith("tag_merges_") === true)
  );
}

function isTagGovernanceStateViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const postgresError = error as { code?: string; constraint?: string };

  return (
    postgresError.code === "23514" &&
    postgresError.constraint?.startsWith("tag_governance_") === true
  );
}

function isRecordArchiveScope(value: string): value is RecordArchiveScope {
  return value === "active" || value === "archived" || value === "all";
}

function isRecordProcessingFilter(
  value: string,
): value is RecordProcessingFilter {
  return (
    value === "all" ||
    value === "saved" ||
    value === "processing" ||
    value === "processed" ||
    value === "failed"
  );
}

function isRecordSort(value: string): value is RecordSort {
  return value === "updated_desc" || value === "updated_asc";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function parseRecordPageLimit(value: string | undefined): number | null {
  if (value === undefined) {
    return 24;
  }

  if (!/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  return parsed >= 1 && parsed <= 100 ? parsed : null;
}

function encodeRecordCursor(cursor: RecordCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString(
    "base64url",
  );
}

function decodeRecordCursor(
  value: string | undefined,
): RecordCursor | null | undefined {
  if (value === undefined) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;

    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        parsed[1],
      )
    ) {
      return undefined;
    }

    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    return undefined;
  }
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.snapshotId, cursor.offset]),
  ).toString("base64url");
}

function decodeSearchCursor(
  value: string | undefined,
): SearchCursor | null | undefined {
  if (value === undefined) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;

    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      !isUuid(parsed[0]) ||
      typeof parsed[1] !== "number" ||
      !Number.isSafeInteger(parsed[1]) ||
      parsed[1] < 1
    ) {
      return undefined;
    }

    return { snapshotId: parsed[0], offset: parsed[1] };
  } catch {
    return undefined;
  }
}

function searchSignature(
  query: string,
  tagIds: string[],
  scope: SearchScope,
): string {
  return JSON.stringify([query, [...tagIds].sort(), scope]);
}

function searchSnapshotPage(
  snapshotId: string,
  snapshot: SearchSnapshot,
  offset: number,
  limit: number,
) {
  const items = snapshot.items.slice(offset, offset + limit);
  const nextOffset = offset + items.length;

  return {
    items,
    page: {
      nextCursor:
        nextOffset < snapshot.items.length
          ? encodeSearchCursor({ snapshotId, offset: nextOffset })
          : null,
    },
  };
}

async function findRecords(
  pool: Pool,
  query: string,
  recordId?: string,
  tagIds: string[] = [],
  options: FindRecordsOptions = {},
): Promise<StoredRecord[]> {
  const archive = options.archive ?? "active";
  const cursor = options.cursor ?? null;
  const processing = options.processing ?? "all";
  const searchScope = options.searchScope ?? "current";
  const sort = options.sort ?? "updated_desc";
  const cursorComparator = sort === "updated_asc" ? ">" : "<";
  const sortDirection = sort === "updated_asc" ? "ASC" : "DESC";
  const result = await pool.query<RecordRow>(
    `WITH ${LIBRARY_TAG_RECORDS_CTE}
     SELECT record.id,
            revision.content,
            revision.id AS fragment_revision_id,
            revision.revision_number,
            record.updated_at,
            record.updated_at::text AS updated_cursor,
            record.archived_at,
            tag.id AS tag_id,
            tag.display_name,
            active_analysis.id AS active_analysis_id,
            COALESCE(overview_correction.title, active_analysis.title)
              AS effective_title,
            COALESCE(overview_correction.summary, active_analysis.summary)
              AS effective_summary,
            observable_task.status AS organization_task_status,
            knowledge_match.ai_title AS knowledge_match_title,
            knowledge_match.ai_body AS knowledge_match_body,
            knowledge_match.publication_status
              AS knowledge_match_publication_status
       FROM records AS record
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
       INNER JOIN tag_assignments AS assignment
         ON assignment.record_id = record.id
        AND assignment.assigned_by = 'USER'
        AND assignment.status = 'ACTIVE'
       INNER JOIN tags AS tag
         ON tag.id = resolve_tag_id(assignment.tag_id)
        AND tag.approval_status = 'USER_APPROVED'
       LEFT JOIN ai_analysis_revisions AS active_analysis
         ON active_analysis.id = record.current_analysis_revision_id
        AND active_analysis.status = 'ACTIVE'
       LEFT JOIN record_overview_corrections AS overview_correction
         ON overview_correction.record_id = record.id
        AND overview_correction.analysis_revision_id = active_analysis.id
       LEFT JOIN LATERAL (
         SELECT task.status
           FROM ai_tasks AS task
          WHERE task.record_id = record.id
            AND task.fragment_revision_id = record.current_fragment_revision_id
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT 1
       ) AS observable_task ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(correction.title, point.ai_title) AS ai_title,
                COALESCE(correction.body, point.ai_body) AS ai_body,
                point.publication_status
           FROM knowledge_points AS point
           INNER JOIN ai_analysis_revisions AS analysis
            ON analysis.id = point.analysis_revision_id
           LEFT JOIN knowledge_point_corrections AS correction
             ON correction.knowledge_point_id = point.id
          WHERE point.record_id = record.id
            AND point.usage_status = 'INCLUDED'
            AND (
              (
                point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
                AND (
                  (
                    analysis.id = record.current_analysis_revision_id
                    AND analysis.status = 'ACTIVE'
                  )
                  OR (
                    analysis.fragment_revision_id = record.current_fragment_revision_id
                    AND analysis.status = 'GENERATED'
                  )
                )
              )
              OR (
                $9::text = 'include_review'
                AND point.publication_status = 'PENDING_REVIEW'
                AND analysis.fragment_revision_id = record.current_fragment_revision_id
                AND analysis.status = 'GENERATED'
              )
            )
            AND (
              COALESCE(correction.title, point.ai_title) ILIKE '%' || $1 || '%'
              OR COALESCE(correction.body, point.ai_body) ILIKE '%' || $1 || '%'
            )
          ORDER BY point.position
          LIMIT 1
       ) AS knowledge_match ON $1::text <> ''
      WHERE (
          $3::boolean
          OR $7::text = 'all'
          OR ($7::text = 'active' AND record.archived_at IS NULL)
          OR ($7::text = 'archived' AND record.archived_at IS NOT NULL)
        )
        AND (
          $1::text = ''
          OR revision.content ILIKE '%' || $1 || '%'
          OR COALESCE(overview_correction.title, active_analysis.title)
               ILIKE '%' || $1 || '%'
          OR COALESCE(overview_correction.summary, active_analysis.summary)
               ILIKE '%' || $1 || '%'
          OR knowledge_match.ai_title IS NOT NULL
        )
        AND ($2::uuid IS NULL OR record.id = $2)
        AND (
          $5::timestamptz IS NULL
          OR record.updated_at ${cursorComparator} $5::timestamptz
          OR (
            record.updated_at = $5::timestamptz
            AND record.id ${cursorComparator} $6::uuid
          )
        )
        AND (
          cardinality($4::uuid[]) = 0
          OR EXISTS (
            SELECT 1
              FROM library_tag_records AS filter_assignment
             WHERE filter_assignment.record_id = record.id
               AND EXISTS (
                 SELECT 1
                   FROM unnest($4::uuid[]) AS requested_tag(id)
                  WHERE filter_assignment.tag_id = resolve_tag_id(requested_tag.id)
               )
          )
        )
        AND (
          $8::text = 'all'
          OR (
            $8::text = 'saved'
            AND active_analysis.id IS NULL
            AND (
              observable_task.status IS NULL
              OR observable_task.status = 'SUCCEEDED'
            )
          )
          OR (
            $8::text = 'processing'
            AND observable_task.status IN ('QUEUED', 'RUNNING')
          )
          OR (
            $8::text = 'processed'
            AND active_analysis.id IS NOT NULL
            AND (
              observable_task.status IS NULL
              OR observable_task.status = 'SUCCEEDED'
            )
          )
          OR (
            $8::text = 'failed'
            AND observable_task.status = 'FAILED'
          )
        )
      ORDER BY record.updated_at ${sortDirection},
               record.id ${sortDirection},
               tag.display_name,
               tag.id`,
    [
      query,
      recordId ?? null,
      recordId !== undefined,
      tagIds,
      cursor?.updatedAt ?? null,
      cursor?.id ?? null,
      archive,
      processing,
      searchScope,
    ],
  );

  const records = new Map<string, StoredRecord>();

  for (const row of result.rows) {
    const existing = records.get(row.id);

    if (existing) {
      if (!existing.card.myTags.some(({ id }) => id === row.tag_id)) {
        existing.card.myTags.push({ id: row.tag_id, name: row.display_name });
      }
      continue;
    }

    records.set(row.id, {
      activeAnalysisId: row.active_analysis_id,
      content: row.content,
      cursor: { id: row.id, updatedAt: row.updated_cursor },
      fragmentRevisionId: row.fragment_revision_id,
      knowledgeMatch:
        row.knowledge_match_title && row.knowledge_match_body
          ? {
              title: row.knowledge_match_title,
              body: row.knowledge_match_body,
              visibility:
                row.knowledge_match_publication_status === "PENDING_REVIEW"
                  ? "pending_review"
                  : "current",
            }
          : null,
      card: recordCard(
        row.id,
        row.content,
        row.revision_number,
        row.updated_at,
        [{ id: row.tag_id, name: row.display_name }],
        row.archived_at ? "archived" : "active",
        {
          activity: recordOrganizationActivity(row.organization_task_status),
          preview:
            row.active_analysis_id && row.effective_summary !== null
              ? row.effective_summary
              : row.content,
          title:
            row.active_analysis_id && row.effective_title !== null
              ? row.effective_title
              : firstNonEmptyLine(row.content),
          view: row.active_analysis_id ? "organized" : "original",
        },
      ),
    });
  }

  const values = [...records.values()];

  return options.limit === undefined ? values : values.slice(0, options.limit);
}

function includesQuery(content: string, query: string): boolean {
  return content.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

// Lexical bands are intentionally far apart so a weaker field cannot outrank
// a stronger one. The semantic cosine score is added later within the 0..1
// interval; record recency is used only after relevance is tied.
const SEARCH_RELEVANCE = {
  exact: 700,
  title: 600,
  overview: 500,
  knowledgePointTitle: 400,
  originalText: 300,
  knowledgePointBody: 200,
} as const;

function compareSearchMatches(
  left: ScoredSearchMatch,
  right: ScoredSearchMatch,
): number {
  return right.score - left.score;
}

function semanticSource(match: SemanticMatch): SearchMatch["source"] {
  if (match.sourceType === "KNOWLEDGE_POINT") {
    return { id: match.sourceId, type: "knowledge_point" };
  }

  if (match.sourceType === "OVERVIEW") {
    return { id: match.sourceId, type: "overview" };
  }

  return { id: match.sourceId, type: "fragment" };
}

function compareSearchResults(
  left: { item: SearchResultItem; score: number },
  right: { item: SearchResultItem; score: number },
): number {
  const relevance = right.score - left.score;

  if (relevance !== 0) {
    return relevance;
  }

  const updated =
    Date.parse(right.item.record.updatedAt) -
    Date.parse(left.item.record.updatedAt);

  return updated !== 0
    ? updated
    : right.item.record.id.localeCompare(left.item.record.id);
}

async function findSearchableKnowledgePoints(
  pool: Pool,
  recordIds: string[],
  query: string,
  scope: SearchScope,
): Promise<Map<string, SearchableKnowledgePoint[]>> {
  if (!query || recordIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<{
    ai_body: string;
    ai_title: string;
    id: string;
    publication_status: string;
    record_id: string;
  }>(
    `SELECT point.id,
            point.record_id,
            COALESCE(correction.title, point.ai_title) AS ai_title,
            COALESCE(correction.body, point.ai_body) AS ai_body,
            point.publication_status
       FROM knowledge_points AS point
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
       INNER JOIN records AS record
         ON record.id = point.record_id
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
      WHERE point.record_id = ANY($1::uuid[])
        AND point.usage_status = 'INCLUDED'
        AND (
          (
            point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
            AND (
              (
                analysis.id = record.current_analysis_revision_id
                AND analysis.status = 'ACTIVE'
              )
              OR (
                analysis.fragment_revision_id = record.current_fragment_revision_id
                AND analysis.status = 'GENERATED'
              )
            )
          )
          OR (
            $3::text = 'include_review'
            AND point.publication_status = 'PENDING_REVIEW'
            AND analysis.fragment_revision_id = record.current_fragment_revision_id
            AND analysis.status = 'GENERATED'
          )
        )
        AND (
          COALESCE(correction.title, point.ai_title) ILIKE '%' || $2 || '%'
          OR COALESCE(correction.body, point.ai_body) ILIKE '%' || $2 || '%'
        )
      ORDER BY point.record_id, point.position, point.id`,
    [recordIds, query, scope],
  );
  const byRecord = new Map<string, SearchableKnowledgePoint[]>();

  for (const row of result.rows) {
    const points = byRecord.get(row.record_id) ?? [];

    points.push({
      body: row.ai_body,
      id: row.id,
      title: row.ai_title,
      visibility:
        row.publication_status === "PENDING_REVIEW"
          ? "pending_review"
          : "current",
    });
    byRecord.set(row.record_id, points);
  }

  return byRecord;
}

function keywordMatchesForRecord(
  record: StoredRecord,
  points: SearchableKnowledgePoint[],
  query: string,
): ScoredSearchMatch[] {
  if (!query) {
    return [
      {
        match: {
          reason: "original_text",
          snippets: [{ text: firstNonEmptyLine(record.content), highlights: [] }],
          source: { id: record.fragmentRevisionId, type: "fragment" },
          visibility: "current",
        },
        score: 0,
      },
    ];
  }

  const matches: ScoredSearchMatch[] = [];

  if (record.card.organization.view === "organized" && record.activeAnalysisId) {
    const titleSnippet = matchingSnippet(record.card.title, query);
    const summarySnippet = matchingSnippet(record.card.preview, query);
    const snippets = uniqueSnippets([titleSnippet, summarySnippet]);

    if (snippets.length > 0) {
      matches.push({
        match: {
          reason: "knowledge_point",
          snippets,
          source: { id: record.activeAnalysisId, type: "overview" },
          visibility: "current",
        },
        score: Math.max(
          titleSnippet
            ? lexicalFieldScore(
                record.card.title,
                query,
                SEARCH_RELEVANCE.title,
              )
            : 0,
          summarySnippet
            ? lexicalFieldScore(
                record.card.preview,
                query,
                SEARCH_RELEVANCE.overview,
              )
            : 0,
        ),
      });
    }
  }

  for (const point of points) {
    const titleSnippet = matchingSnippet(point.title, query);
    const bodySnippet = matchingSnippet(point.body, query);
    const snippets = uniqueSnippets([titleSnippet, bodySnippet]);

    if (snippets.length === 0) {
      continue;
    }

    matches.push({
      match: {
        reason: "knowledge_point",
        snippets,
        source: { id: point.id, type: "knowledge_point" },
        visibility: point.visibility,
      },
      score: Math.max(
        titleSnippet
          ? lexicalFieldScore(
              point.title,
              query,
              SEARCH_RELEVANCE.knowledgePointTitle,
            )
          : 0,
        bodySnippet
          ? lexicalFieldScore(
              point.body,
              query,
              SEARCH_RELEVANCE.knowledgePointBody,
            )
          : 0,
      ),
    });
  }

  const fragmentSnippets = matchingLineSnippets(record.content, query);

  if (fragmentSnippets.length > 0) {
    const displayTitleScore =
      record.card.organization.view === "original" &&
      includesQuery(record.card.title, query)
        ? lexicalFieldScore(
            record.card.title,
            query,
            SEARCH_RELEVANCE.title,
          )
        : 0;

    matches.push({
      match: {
        reason: "original_text",
        snippets: fragmentSnippets,
        source: { id: record.fragmentRevisionId, type: "fragment" },
        visibility: "current",
      },
      score: Math.max(displayTitleScore, SEARCH_RELEVANCE.originalText),
    });
  }

  return matches.sort((left, right) => right.score - left.score);
}

function lexicalFieldScore(
  text: string,
  query: string,
  fieldScore: number,
): number {
  return text.toLocaleLowerCase() === query.toLocaleLowerCase()
    ? SEARCH_RELEVANCE.exact
    : fieldScore;
}

function matchingLineSnippets(
  content: string,
  query: string,
): SearchMatch["snippets"] {
  return uniqueSnippets(
    content
      .split(/\r\n|\n|\r/u)
      .filter((line) => includesQuery(line, query))
      .map((line) => matchingSnippet(line, query)),
  );
}

function matchingSnippet(
  text: string,
  query: string,
): SearchMatch["snippets"][number] | null {
  const start = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());

  return start < 0
    ? null
    : { text, highlights: [{ start, end: start + query.length }] };
}

function uniqueSnippets(
  candidates: Array<SearchMatch["snippets"][number] | null>,
): SearchMatch["snippets"] {
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    if (!candidate || seen.has(candidate.text)) {
      return [];
    }

    seen.add(candidate.text);

    return [candidate];
  });
}

function recordCard(
  id: string,
  content: string,
  textVersion: number,
  updatedAt: Date | string,
  myTags: TagChip[],
  lifecycle: "active" | "archived" = "active",
  presentation: {
    activity: RecordCard["organization"]["activity"];
    preview: string;
    title: string;
    view: RecordCard["organization"]["view"];
  } = {
    activity: "idle",
    preview: content,
    title: firstNonEmptyLine(content),
    view: "original",
  },
): RecordCard {
  return {
    id,
    title: presentation.title,
    preview: presentation.preview,
    myTags,
    lifecycle,
    organization: {
      view: presentation.view,
      activity: presentation.activity,
    },
    textVersion,
    updatedAt: asIsoString(updatedAt),
  };
}

function recordOrganizationActivity(
  status: string | null,
): RecordCard["organization"]["activity"] {
  if (status === "QUEUED") {
    return "queued";
  }

  if (status === "RUNNING") {
    return "running";
  }

  if (status === "FAILED") {
    return "failed";
  }

  return "idle";
}

function firstNonEmptyLine(content: string): string {
  return (
    content.split(/\r\n|\n|\r/u).find((line) => hasNonWhitespace(line))?.trim() ??
    ""
  );
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
