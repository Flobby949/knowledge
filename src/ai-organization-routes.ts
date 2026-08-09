import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import type { AnalysisGenerator, GeneratedAnalysis } from "./analysis-generator.js";
import {
  validateAnalysisOutput,
  type AnalysisOutput,
} from "./domain/analysis-output.js";
import { normalizeTagName } from "./domain/tag-name.js";
import { decryptCredential } from "./model-credentials.js";

interface OrganizeParams {
  id: string;
}

interface OrganizeBody {
  handling: "automatic" | "review";
}

interface TaskParams {
  id: string;
}

interface TaskListQuery {
  scope?: "all" | "attention";
}

interface OrganizationCandidateParams extends OrganizeParams {
  candidateId: string;
}

interface EvidenceParams {
  id: string;
  itemId: string;
}

interface ReviewDecisionBody {
  decision: "confirm" | "reject";
}

interface CorrectionBody {
  title: string;
  body: string;
}

interface InclusionBody {
  status: "included" | "excluded";
}

interface AiTaskRow {
  id: string;
  record_id: string;
  fragment_revision_id: string;
  model_config_version: number;
  retry_of_task_id: string | null;
  handling: "AUTOMATIC" | "REVIEW";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  failure_code: string | null;
  failure_message: string | null;
}

interface ObservableAiTaskRow extends AiTaskRow {
  source_text_version: number;
}

interface AiTaskListRow extends ObservableAiTaskRow {
  archived_at: Date | string | null;
  created_at: Date | string;
  current_source_text: string;
  effective_title: string | null;
  finished_at: Date | string | null;
  retry_task_id: string | null;
  started_at: Date | string | null;
}

export interface PublicAiTask {
  id: string;
  recordId: string;
  handling: "automatic" | "review";
  status: "queued" | "running" | "succeeded" | "failed";
  sourceTextVersion: number;
  modelConfigurationVersion: number;
  retryOfTaskId: string | null;
  failure?: { code: string; message: string | null };
}

interface TaskSourceRow extends AiTaskRow {
  source_text: string;
  text_base_url: string;
  text_model: string;
  text_credential_ciphertext: string;
}

export interface CurrentOrganization {
  title: string;
  summary: string;
  items: Array<{
    id: string;
    title: string;
    body: string;
    publicationStatus:
      | "AI_CREATED"
      | "PENDING_REVIEW"
      | "AUTO_PUBLISHED"
      | "CONFIRMED"
      | "REJECTED";
    usageStatus: "INCLUDED" | "EXCLUDED";
    tags: Array<{ id: string; name: string }>;
    evidenceCount: number;
    aiOriginal: { title: string; body: string };
    correction: null | { title: string; body: string; updatedAt: string };
  }>;
}

export interface OrganizationCandidate {
  id: string;
  reason: "reanalysis" | "source_updated";
  sourceTextVersion: number;
  presentation: { title: string; summary: string };
  organizedItems: CurrentOrganization["items"];
}

interface OrganizationPointRow {
  id: string;
  ai_title: string;
  ai_body: string;
  publication_status: CurrentOrganization["items"][number]["publicationStatus"];
  usage_status: CurrentOrganization["items"][number]["usageStatus"];
  tags: Array<{ id: string; name: string }>;
  evidence_count: number;
  correction_title: string | null;
  correction_body: string | null;
  correction_updated_at: Date | string | null;
}

export function registerAiOrganizationRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    credentialSecret: string;
    generateAnalysis: AnalysisGenerator;
    onTaskSettled?: (taskId: string) => void;
    scheduleSemanticIndex: () => void;
  },
): void {
  const {
    pool,
    credentialSecret,
    generateAnalysis,
    onTaskSettled,
    scheduleSemanticIndex,
  } = options;

  app.post<{ Body: OrganizeBody; Params: OrganizeParams }>(
    "/api/v1/records/:id/organize",
    async (request, reply) => {
      if (
        request.body?.handling !== "automatic" &&
        request.body?.handling !== "review"
      ) {
        return reply.code(422).send({
          error: {
            code: "ORGANIZATION_HANDLING_INVALID",
            message: "请选择受支持的发布方式。",
          },
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const recordResult = await client.query<{
          id: string;
          current_fragment_revision_id: string;
          current_text_version: number;
        }>(
          `SELECT record.id,
                  record.current_fragment_revision_id,
                  revision.revision_number AS current_text_version
             FROM records AS record
             INNER JOIN fragment_revisions AS revision
               ON revision.id = record.current_fragment_revision_id
            WHERE record.id = $1
              AND record.archived_at IS NULL
            FOR UPDATE OF record`,
          [request.params.id],
        );
        const record = recordResult.rows[0];

        if (!record) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Record not found" });
        }

        const unfinishedResult = await client.query<AiTaskRow>(
          `SELECT *
             FROM ai_tasks
            WHERE fragment_revision_id = $1
              AND status IN ('QUEUED', 'RUNNING')
            LIMIT 1`,
          [record.current_fragment_revision_id],
        );
        const unfinishedTask = unfinishedResult.rows[0];

        if (unfinishedTask) {
          await client.query("COMMIT");
          return reply.code(202).send({
            task: publicTask({
              ...unfinishedTask,
              source_text_version: record.current_text_version,
            }),
          });
        }

        const configuration = await client.query<{ version: number }>(
          "SELECT version FROM model_configurations WHERE state = 'ACTIVE'",
        );
        const config = configuration.rows[0];

        if (!config) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "MODEL_CONFIG_REQUIRED",
              message: "请先启用完整的模型配置。",
            },
          });
        }

        const taskResult = await client.query<AiTaskRow>(
          `INSERT INTO ai_tasks
             (record_id, fragment_revision_id, model_config_version, handling)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [
            record.id,
            record.current_fragment_revision_id,
            config.version,
            request.body.handling === "automatic" ? "AUTOMATIC" : "REVIEW",
          ],
        );
        const task = taskResult.rows[0];

        if (!task) {
          throw new Error("AI task insert did not return a task");
        }

        await client.query("COMMIT");
        setImmediate(() => {
          void processTask({
            pool,
            credentialSecret,
            generateAnalysis,
            ...(onTaskSettled ? { onTaskSettled } : {}),
            scheduleSemanticIndex,
            taskId: task.id,
          });
        });

        return reply.code(202).send({
          task: publicTask({
            ...task,
            source_text_version: record.current_text_version,
          }),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: TaskParams }>(
    "/api/v1/ai-tasks/:id",
    async (request, reply) => {
      const result = await pool.query<ObservableAiTaskRow>(
        `SELECT task.*,
                revision.revision_number AS source_text_version
           FROM ai_tasks AS task
           INNER JOIN fragment_revisions AS revision
             ON revision.id = task.fragment_revision_id
          WHERE task.id = $1`,
        [request.params.id],
      );
      const task = result.rows[0];

      if (!task) {
        return reply.code(404).send({ error: "AI task not found" });
      }

      return { task: publicTask(task) };
    },
  );

  app.get<{ Querystring: TaskListQuery }>(
    "/api/v1/ai-tasks",
    async (request, reply) => {
      const scope = request.query.scope ?? "all";

      if (scope !== "all" && scope !== "attention") {
        return reply.code(422).send({
          error: {
            code: "AI_TASK_SCOPE_INVALID",
            message: "请选择受支持的 AI 任务范围。",
          },
        });
      }

      const result = await pool.query<AiTaskListRow>(
        `SELECT task.*,
                source_revision.revision_number AS source_text_version,
                current_revision.content AS current_source_text,
                COALESCE(overview.title, active.title) AS effective_title,
                record.archived_at,
                retry.id AS retry_task_id
           FROM ai_tasks AS task
           INNER JOIN records AS record
             ON record.id = task.record_id
           INNER JOIN fragment_revisions AS source_revision
             ON source_revision.id = task.fragment_revision_id
           INNER JOIN fragment_revisions AS current_revision
             ON current_revision.id = record.current_fragment_revision_id
           LEFT JOIN ai_analysis_revisions AS active
             ON active.id = record.current_analysis_revision_id
            AND active.status = 'ACTIVE'
           LEFT JOIN record_overview_corrections AS overview
             ON overview.record_id = record.id
            AND overview.analysis_revision_id = active.id
           LEFT JOIN LATERAL (
             SELECT child.id
               FROM ai_tasks AS child
              WHERE child.retry_of_task_id = task.id
              LIMIT 1
           ) AS retry ON TRUE
          WHERE $1 = 'all'
             OR task.status IN ('QUEUED', 'RUNNING')
             OR (
               task.status = 'FAILED'
               AND retry.id IS NULL
               AND record.archived_at IS NULL
             )
          ORDER BY task.created_at DESC, task.id DESC
          LIMIT 100`,
        [scope],
      );

      return {
        items: result.rows.map((task) => ({
          ...publicTask(task),
          record: {
            id: task.record_id,
            title:
              task.effective_title ?? firstNonEmptyLine(task.current_source_text),
          },
          createdAt: asIsoString(task.created_at),
          startedAt: task.started_at ? asIsoString(task.started_at) : null,
          finishedAt: task.finished_at ? asIsoString(task.finished_at) : null,
          retryTaskId: task.retry_task_id,
          canRetry:
            task.status === "FAILED" &&
            task.retry_task_id === null &&
            task.archived_at === null,
        })),
      };
    },
  );

  app.post<{ Params: TaskParams }>(
    "/api/v1/ai-tasks/:id/retry",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const taskIdentityResult = await client.query<{ record_id: string }>(
          "SELECT record_id FROM ai_tasks WHERE id = $1",
          [request.params.id],
        );
        const taskIdentity = taskIdentityResult.rows[0];

        if (!taskIdentity) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "AI task not found" });
        }

        const recordResult = await client.query<{
          archived_at: Date | string | null;
        }>(
          "SELECT archived_at FROM records WHERE id = $1 FOR UPDATE",
          [taskIdentity.record_id],
        );
        const record = recordResult.rows[0];

        if (!record) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "AI task not found" });
        }

        if (record.archived_at) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "AI_TASK_RECORD_ARCHIVED",
              message: "归档记录不能重试 AI 整理，请先恢复记录。",
            },
          });
        }

        const failedResult = await client.query<ObservableAiTaskRow>(
          `SELECT task.*,
                  revision.revision_number AS source_text_version
             FROM ai_tasks AS task
             INNER JOIN fragment_revisions AS revision
               ON revision.id = task.fragment_revision_id
            WHERE task.id = $1
            FOR UPDATE OF task`,
          [request.params.id],
        );
        const failedTask = failedResult.rows[0];

        if (!failedTask) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "AI task not found" });
        }

        if (failedTask.status !== "FAILED") {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "AI_TASK_NOT_RETRYABLE",
              message: "只有失败的 AI 任务可以重试。",
            },
          });
        }

        const existingResult = await client.query<ObservableAiTaskRow>(
          `SELECT task.*,
                  revision.revision_number AS source_text_version
             FROM ai_tasks AS task
             INNER JOIN fragment_revisions AS revision
               ON revision.id = task.fragment_revision_id
            WHERE task.retry_of_task_id = $1
            LIMIT 1`,
          [failedTask.id],
        );
        const existingTask = existingResult.rows[0];

        if (existingTask) {
          await client.query("COMMIT");
          return reply.code(202).send({ task: publicTask(existingTask) });
        }

        const retryResult = await client.query<AiTaskRow>(
          `INSERT INTO ai_tasks
             (record_id,
              fragment_revision_id,
              model_config_version,
              handling,
              retry_of_task_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            failedTask.record_id,
            failedTask.fragment_revision_id,
            failedTask.model_config_version,
            failedTask.handling,
            failedTask.id,
          ],
        );
        const retryTask = retryResult.rows[0];

        if (!retryTask) {
          throw new Error("AI task retry insert did not return a task");
        }

        await client.query("COMMIT");
        setImmediate(() => {
          void processTask({
            pool,
            credentialSecret,
            generateAnalysis,
            ...(onTaskSettled ? { onTaskSettled } : {}),
            scheduleSemanticIndex,
            taskId: retryTask.id,
          });
        });

        return reply.code(202).send({
          task: publicTask({
            ...retryTask,
            source_text_version: failedTask.source_text_version,
          }),
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post<{ Params: OrganizationCandidateParams }>(
    "/api/v1/records/:id/organization-candidates/:candidateId/adopt",
    async (request, reply) => {
      const adopted = await decideOrganizationCandidate({
        pool,
        recordId: request.params.id,
        candidateId: request.params.candidateId,
        decision: "adopt",
      });

      if (!adopted) {
        return reply.code(404).send({ error: "Organization candidate not found" });
      }

      scheduleSemanticIndex();

      return {
        candidate: { id: request.params.candidateId, status: "adopted" },
      };
    },
  );

  app.post<{ Params: OrganizationCandidateParams }>(
    "/api/v1/records/:id/organization-candidates/:candidateId/discard",
    async (request, reply) => {
      const discarded = await decideOrganizationCandidate({
        pool,
        recordId: request.params.id,
        candidateId: request.params.candidateId,
        decision: "discard",
      });

      if (!discarded) {
        return reply.code(404).send({ error: "Organization candidate not found" });
      }

      return {
        candidate: { id: request.params.candidateId, status: "discarded" },
      };
    },
  );

  app.get("/api/v1/review-queue", async () => {
    const result = await pool.query<{
      record_id: string;
      title: string;
      pending_count: number;
    }>(
      `SELECT analysis.record_id,
              analysis.title,
              COUNT(point.id)::integer AS pending_count
         FROM ai_analysis_revisions AS analysis
         INNER JOIN knowledge_points AS point
           ON point.analysis_revision_id = analysis.id
          AND point.publication_status = 'PENDING_REVIEW'
        WHERE analysis.status = 'GENERATED'
        GROUP BY analysis.id
        ORDER BY analysis.generated_at, analysis.id`,
    );

    return {
      items: result.rows.map((row) => ({
        record: { id: row.record_id, title: row.title },
        pendingCount: row.pending_count,
      })),
      page: { nextCursor: null },
    };
  });

  app.post<{ Body: ReviewDecisionBody; Params: EvidenceParams }>(
    "/api/v1/records/:id/organized-items/:itemId/review-decision",
    async (request, reply) => {
      if (
        request.body?.decision !== "confirm" &&
        request.body?.decision !== "reject"
      ) {
        return reply.code(422).send({
          error: {
            code: "REVIEW_DECISION_INVALID",
            message: "请选择采用或拒绝。",
          },
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const selected = await client.query<{
          analysis_revision_id: string;
        }>(
          `SELECT point.analysis_revision_id
             FROM knowledge_points AS point
             INNER JOIN ai_analysis_revisions AS analysis
               ON analysis.id = point.analysis_revision_id
             INNER JOIN records AS record
               ON record.id = point.record_id
              AND record.current_fragment_revision_id = point.fragment_revision_id
            WHERE point.id = $1
              AND point.record_id = $2
              AND point.publication_status = 'PENDING_REVIEW'
              AND analysis.status = 'GENERATED'
            FOR UPDATE OF point, analysis, record`,
          [request.params.itemId, request.params.id],
        );
        const point = selected.rows[0];

        if (!point) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Review item not found" });
        }

        const publicationStatus =
          request.body.decision === "confirm" ? "CONFIRMED" : "REJECTED";
        await client.query(
          `UPDATE knowledge_points
              SET publication_status = $2,
                  usage_status = $3
            WHERE id = $1`,
          [
            request.params.itemId,
            publicationStatus,
            request.body.decision === "confirm" ? "INCLUDED" : "EXCLUDED",
          ],
        );

        await settleFirstReviewIfComplete(
          client,
          request.params.id,
          point.analysis_revision_id,
        );

        await client.query("COMMIT");
        scheduleSemanticIndex();
        return {
          item: {
            id: request.params.itemId,
            publicationStatus,
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

  app.put<{ Body: CorrectionBody; Params: EvidenceParams }>(
    "/api/v1/records/:id/organized-items/:itemId/correction",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      const body = request.body?.body?.trim();

      if (!title || !body) {
        return reply.code(422).send({
          error: {
            code: "KNOWLEDGE_CORRECTION_INVALID",
            message: "修正后的标题与正文不能为空。",
          },
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const eligible = await client.query<{
          analysis_revision_id: string;
          publication_status: CurrentOrganization["items"][number]["publicationStatus"];
        }>(
          `SELECT point.analysis_revision_id,
                  point.publication_status
             FROM knowledge_points AS point
             INNER JOIN records AS record
               ON record.id = point.record_id
             INNER JOIN ai_analysis_revisions AS analysis
               ON analysis.id = point.analysis_revision_id
            WHERE point.id = $1
              AND point.record_id = $2
              AND (
                (
                  point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
                  AND record.current_analysis_revision_id = point.analysis_revision_id
                  AND analysis.status = 'ACTIVE'
                )
                OR (
                  point.publication_status = 'PENDING_REVIEW'
                  AND record.current_fragment_revision_id = point.fragment_revision_id
                  AND analysis.status = 'GENERATED'
                )
              )
            FOR UPDATE OF point, analysis, record`,
          [request.params.itemId, request.params.id],
        );
        const point = eligible.rows[0];

        if (!point) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "Knowledge item not found" });
        }

        await client.query(
          `INSERT INTO knowledge_point_corrections
             (knowledge_point_id, title, body)
           VALUES ($1, $2, $3)
           ON CONFLICT (knowledge_point_id) DO UPDATE
             SET title = EXCLUDED.title,
                 body = EXCLUDED.body,
                 updated_at = clock_timestamp()`,
          [request.params.itemId, title, body],
        );
        await client.query(
          `UPDATE knowledge_points
              SET publication_status = 'CONFIRMED'
            WHERE id = $1`,
          [request.params.itemId],
        );

        if (point.publication_status === "PENDING_REVIEW") {
          await settleFirstReviewIfComplete(
            client,
            request.params.id,
            point.analysis_revision_id,
          );
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const item = await readCurrentOrganizationItem(
        pool,
        request.params.id,
        request.params.itemId,
      );

      scheduleSemanticIndex();
      return { item };
    },
  );

  app.delete<{ Params: EvidenceParams }>(
    "/api/v1/records/:id/organized-items/:itemId/correction",
    async (request, reply) => {
      const removed = await pool.query(
        `DELETE FROM knowledge_point_corrections AS correction
          USING knowledge_points AS point,
                records AS record,
                ai_analysis_revisions AS analysis
          WHERE correction.knowledge_point_id = $1
            AND point.id = correction.knowledge_point_id
            AND point.record_id = $2
            AND record.id = point.record_id
            AND record.current_analysis_revision_id = point.analysis_revision_id
            AND analysis.id = point.analysis_revision_id
            AND analysis.status = 'ACTIVE'
          RETURNING correction.knowledge_point_id`,
        [request.params.itemId, request.params.id],
      );

      if (!removed.rows[0]) {
        return reply.code(404).send({ error: "Knowledge correction not found" });
      }

      scheduleSemanticIndex();
      return reply.code(204).send();
    },
  );

  app.put<{ Body: InclusionBody; Params: EvidenceParams }>(
    "/api/v1/records/:id/organized-items/:itemId/inclusion",
    async (request, reply) => {
      if (
        request.body?.status !== "included" &&
        request.body?.status !== "excluded"
      ) {
        return reply.code(422).send({
          error: {
            code: "KNOWLEDGE_INCLUSION_INVALID",
            message: "请选择采用或不采用。",
          },
        });
      }

      const updated = await pool.query(
        `UPDATE knowledge_points AS point
            SET usage_status = $3
           FROM records AS record,
                ai_analysis_revisions AS analysis
          WHERE point.id = $1
            AND point.record_id = $2
            AND record.id = point.record_id
            AND record.current_analysis_revision_id = point.analysis_revision_id
            AND analysis.id = point.analysis_revision_id
            AND analysis.status = 'ACTIVE'
            AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          RETURNING point.id`,
        [
          request.params.itemId,
          request.params.id,
          request.body.status === "included" ? "INCLUDED" : "EXCLUDED",
        ],
      );

      if (!updated.rows[0]) {
        return reply.code(404).send({ error: "Published item not found" });
      }

      const item = await readCurrentOrganizationItem(
        pool,
        request.params.id,
        request.params.itemId,
      );

      scheduleSemanticIndex();
      return { item };
    },
  );

  app.get<{ Params: EvidenceParams }>(
    "/api/v1/records/:id/organized-items/:itemId/evidence",
    async (request, reply) => {
      const result = await pool.query<{
        quote: string;
        start_offset: number;
        end_offset: number;
        revision_number: number;
      }>(
        `SELECT evidence.quote,
                evidence.start_offset,
                evidence.end_offset,
                revision.revision_number
           FROM knowledge_points AS point
           INNER JOIN evidence_spans AS evidence
             ON evidence.knowledge_point_id = point.id
           INNER JOIN fragment_revisions AS revision
             ON revision.id = evidence.fragment_revision_id
          WHERE point.id = $1
            AND point.record_id = $2
          ORDER BY evidence.position`,
        [request.params.itemId, request.params.id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: "Evidence not found" });
      }

      return {
        items: result.rows.map((row) => ({
          quote: row.quote,
          start: row.start_offset,
          end: row.end_offset,
          sourceTextVersion: row.revision_number,
        })),
      };
    },
  );
}

async function settleFirstReviewIfComplete(
  client: PoolClient,
  recordId: string,
  analysisId: string,
): Promise<void> {
  const remaining = await client.query<{ pending_count: number }>(
    `SELECT COUNT(*)::integer AS pending_count
       FROM knowledge_points
      WHERE analysis_revision_id = $1
        AND publication_status = 'PENDING_REVIEW'`,
    [analysisId],
  );

  if (remaining.rows[0]?.pending_count !== 0) {
    return;
  }

  const confirmed = await client.query<{ confirmed_count: number }>(
    `SELECT COUNT(*)::integer AS confirmed_count
       FROM knowledge_points
      WHERE analysis_revision_id = $1
        AND publication_status = 'CONFIRMED'
        AND usage_status = 'INCLUDED'`,
    [analysisId],
  );

  if ((confirmed.rows[0]?.confirmed_count ?? 0) === 0) {
    await client.query(
      "UPDATE ai_analysis_revisions SET status = 'DISCARDED' WHERE id = $1",
      [analysisId],
    );
    return;
  }

  const previous = await client.query<{
    current_analysis_revision_id: string | null;
  }>(
    "SELECT current_analysis_revision_id FROM records WHERE id = $1",
    [recordId],
  );
  const previousId = previous.rows[0]?.current_analysis_revision_id;

  if (previousId) {
    await client.query(
      `UPDATE ai_analysis_revisions
          SET status = 'SUPERSEDED'
        WHERE id = $1
          AND status = 'ACTIVE'`,
      [previousId],
    );
  }

  await client.query(
    "UPDATE ai_analysis_revisions SET status = 'ACTIVE' WHERE id = $1",
    [analysisId],
  );
  await client.query(
    `UPDATE records
        SET current_analysis_revision_id = $2,
            updated_at = clock_timestamp()
      WHERE id = $1`,
    [recordId, analysisId],
  );
}

async function decideOrganizationCandidate(options: {
  pool: Pool;
  recordId: string;
  candidateId: string;
  decision: "adopt" | "discard";
}): Promise<boolean> {
  const { pool, recordId, candidateId, decision } = options;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      candidate_id: string;
      current_analysis_revision_id: string | null;
    }>(
      `SELECT candidate.id AS candidate_id,
              record.current_analysis_revision_id
         FROM records AS record
         INNER JOIN ai_analysis_revisions AS candidate
           ON candidate.id = $2
          AND candidate.record_id = record.id
          AND candidate.fragment_revision_id = record.current_fragment_revision_id
          AND candidate.status = 'GENERATED'
        WHERE record.id = $1
          AND record.archived_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM knowledge_points AS point
             WHERE point.analysis_revision_id = candidate.id
               AND point.publication_status = 'AI_CREATED'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM knowledge_points AS point
             WHERE point.analysis_revision_id = candidate.id
               AND point.publication_status <> 'AI_CREATED'
          )
        FOR UPDATE OF record, candidate`,
      [recordId, candidateId],
    );
    const candidate = selected.rows[0];

    if (!candidate) {
      await client.query("ROLLBACK");
      return false;
    }

    if (decision === "discard") {
      await client.query(
        "UPDATE ai_analysis_revisions SET status = 'DISCARDED' WHERE id = $1",
        [candidateId],
      );
      await client.query("COMMIT");
      return true;
    }

    if (candidate.current_analysis_revision_id) {
      await client.query(
        `UPDATE ai_analysis_revisions
            SET status = 'SUPERSEDED'
          WHERE id = $1
            AND status = 'ACTIVE'`,
        [candidate.current_analysis_revision_id],
      );
      await client.query(
        `DELETE FROM record_overview_corrections
          WHERE record_id = $1
            AND analysis_revision_id = $2`,
        [recordId, candidate.current_analysis_revision_id],
      );
    }
    await client.query(
      `UPDATE knowledge_points
          SET publication_status = 'CONFIRMED'
        WHERE analysis_revision_id = $1
          AND publication_status = 'AI_CREATED'`,
      [candidateId],
    );
    await client.query(
      "UPDATE ai_analysis_revisions SET status = 'ACTIVE' WHERE id = $1",
      [candidateId],
    );
    await client.query(
      `UPDATE records
          SET current_analysis_revision_id = $2,
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [recordId, candidateId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readCurrentOrganization(
  pool: Pool,
  recordId: string,
): Promise<CurrentOrganization | null> {
  let analysisResult = await pool.query<{
    id: string;
    title: string;
    summary: string;
  }>(
    `SELECT analysis.id, analysis.title, analysis.summary
       FROM records AS record
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = record.current_analysis_revision_id
      WHERE record.id = $1
        AND analysis.status = 'ACTIVE'`,
    [recordId],
  );
  let analysis = analysisResult.rows[0];

  if (!analysis) {
    analysisResult = await pool.query<{
      id: string;
      title: string;
      summary: string;
    }>(
      `SELECT analysis.id, analysis.title, analysis.summary
         FROM records AS record
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.record_id = record.id
          AND analysis.fragment_revision_id = record.current_fragment_revision_id
          AND analysis.status = 'GENERATED'
        WHERE record.id = $1
          AND EXISTS (
            SELECT 1
              FROM knowledge_points AS point
             WHERE point.analysis_revision_id = analysis.id
               AND point.publication_status = 'PENDING_REVIEW'
          )
        ORDER BY analysis.generated_at DESC, analysis.id DESC
        LIMIT 1`,
      [recordId],
    );
    analysis = analysisResult.rows[0];
  }

  if (!analysis) {
    return null;
  }

  return {
    title: analysis.title,
    summary: analysis.summary,
    items: await readOrganizationItems(pool, analysis.id),
  };
}

export async function readOrganizationCandidate(
  pool: Pool,
  recordId: string,
): Promise<OrganizationCandidate | null> {
  const result = await pool.query<{
    id: string;
    title: string;
    summary: string;
    source_text_version: number;
    reason: "reanalysis" | "source_updated";
  }>(
    `SELECT candidate.id,
            candidate.title,
            candidate.summary,
            revision.revision_number AS source_text_version,
            CASE
              WHEN active.fragment_revision_id = candidate.fragment_revision_id
                THEN 'reanalysis'
              ELSE 'source_updated'
            END AS reason
       FROM records AS record
       INNER JOIN ai_analysis_revisions AS candidate
         ON candidate.record_id = record.id
        AND candidate.fragment_revision_id = record.current_fragment_revision_id
        AND candidate.status = 'GENERATED'
       INNER JOIN fragment_revisions AS revision
         ON revision.id = candidate.fragment_revision_id
       LEFT JOIN ai_analysis_revisions AS active
         ON active.id = record.current_analysis_revision_id
        AND active.status = 'ACTIVE'
      WHERE record.id = $1
        AND record.archived_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM knowledge_points AS point
           WHERE point.analysis_revision_id = candidate.id
             AND point.publication_status = 'AI_CREATED'
        )
        AND NOT EXISTS (
          SELECT 1
            FROM knowledge_points AS point
           WHERE point.analysis_revision_id = candidate.id
             AND point.publication_status <> 'AI_CREATED'
        )
      ORDER BY candidate.generated_at DESC, candidate.id DESC
      LIMIT 1`,
    [recordId],
  );
  const candidate = result.rows[0];

  if (!candidate) {
    return null;
  }

  return {
    id: candidate.id,
    reason: candidate.reason,
    sourceTextVersion: candidate.source_text_version,
    presentation: { title: candidate.title, summary: candidate.summary },
    organizedItems: await readOrganizationItems(pool, candidate.id),
  };
}

async function readOrganizationItems(
  pool: Pool,
  analysisId: string,
): Promise<CurrentOrganization["items"]> {
  const points = await pool.query<OrganizationPointRow>(
    `SELECT point.id,
            point.ai_title,
            point.ai_body,
            point.publication_status,
            point.usage_status,
            correction.title AS correction_title,
            correction.body AS correction_body,
            correction.updated_at AS correction_updated_at,
            COALESCE(
              (SELECT json_agg(
                      json_build_object('id', tag.id, 'name', tag.display_name)
                        ORDER BY tag.normalized_name, tag.id
                      )
                 FROM tag_assignments AS assignment
                 INNER JOIN tags AS tag ON tag.id = assignment.tag_id
                WHERE assignment.knowledge_point_id = point.id
                  AND assignment.status = 'ACTIVE'),
              '[]'::json
            ) AS tags,
            (SELECT COUNT(*)::integer
               FROM evidence_spans AS evidence
              WHERE evidence.knowledge_point_id = point.id) AS evidence_count
       FROM knowledge_points AS point
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
      WHERE point.analysis_revision_id = $1
      ORDER BY point.position`,
    [analysisId],
  );

  return points.rows.map((point) => ({
    id: point.id,
    title: point.correction_title ?? point.ai_title,
    body: point.correction_body ?? point.ai_body,
    publicationStatus: point.publication_status,
    usageStatus: point.usage_status,
    tags: point.tags,
    evidenceCount: point.evidence_count,
    aiOriginal: { title: point.ai_title, body: point.ai_body },
    correction:
      point.correction_title &&
      point.correction_body &&
      point.correction_updated_at
        ? {
            title: point.correction_title,
            body: point.correction_body,
            updatedAt: asIsoString(point.correction_updated_at),
          }
        : null,
  }));
}

export async function readObservableOrganizationTask(
  pool: Pool,
  recordId: string,
): Promise<PublicAiTask | null> {
  const result = await pool.query<ObservableAiTaskRow>(
    `SELECT task.*,
            revision.revision_number AS source_text_version
       FROM records AS record
       INNER JOIN ai_tasks AS task
         ON task.record_id = record.id
        AND task.fragment_revision_id = record.current_fragment_revision_id
       INNER JOIN fragment_revisions AS revision
         ON revision.id = task.fragment_revision_id
      WHERE record.id = $1
      ORDER BY task.created_at DESC, task.id DESC
      LIMIT 1`,
    [recordId],
  );
  const task = result.rows[0];

  return task && task.status !== "SUCCEEDED" ? publicTask(task) : null;
}

async function readCurrentOrganizationItem(
  pool: Pool,
  recordId: string,
  itemId: string,
) {
  const organization = await readCurrentOrganization(pool, recordId);

  return organization?.items.find((item) => item.id === itemId) ?? null;
}

async function processTask(options: {
  pool: Pool;
  credentialSecret: string;
  generateAnalysis: AnalysisGenerator;
  onTaskSettled?: (taskId: string) => void;
  scheduleSemanticIndex: () => void;
  taskId: string;
}): Promise<void> {
  const {
    pool,
    credentialSecret,
    generateAnalysis,
    onTaskSettled,
    scheduleSemanticIndex,
    taskId,
  } = options;

  try {
    const started = await pool.query<TaskSourceRow>(
      `UPDATE ai_tasks AS task
          SET status = 'RUNNING',
              started_at = clock_timestamp()
         FROM fragment_revisions AS revision,
              model_configurations AS config
        WHERE task.id = $1
          AND task.status = 'QUEUED'
          AND revision.id = task.fragment_revision_id
          AND config.version = task.model_config_version
        RETURNING task.*,
                  revision.content AS source_text,
                  config.text_base_url,
                  config.text_model,
                  config.text_credential_ciphertext`,
      [taskId],
    );
    const task = started.rows[0];

    if (!task) {
      return;
    }

    const generationInput = {
      sourceText: task.source_text,
      baseUrl: task.text_base_url,
      model: task.text_model,
      apiKey: decryptCredential(
        task.text_credential_ciphertext,
        credentialSecret,
      ),
      configurationVersion: task.model_config_version,
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await pool.query(
        "UPDATE ai_tasks SET generation_attempts = $2 WHERE id = $1",
        [taskId, attempt],
      );
      const generated = await generateAnalysis(generationInput);
      const validation = validateGeneratedAnalysis(task.source_text, generated);

      if (validation.ok) {
        await publishAnalysis(pool, task, validation.value);
        scheduleSemanticIndex();
        return;
      }

      if (attempt === 2) {
        await failTask(
          pool,
          taskId,
          "ANALYSIS_VALIDATION_FAILED",
          validation.errors.map((error) => error.path).join(", "),
        );
      }
    }
  } catch (error) {
    await failTask(
      pool,
      taskId,
      "MODEL_REQUEST_FAILED",
      error instanceof Error ? error.message : "Unknown model request failure",
    );
  } finally {
    try {
      onTaskSettled?.(taskId);
    } catch {
      // Test observability must never change the task's domain outcome.
    }
  }
}

function validateGeneratedAnalysis(sourceText: string, generated: GeneratedAnalysis) {
  return validateAnalysisOutput(sourceText, {
    title: generated.title,
    summary: generated.summary,
    knowledgePoints: Array.isArray(generated.knowledgePoints)
      ? generated.knowledgePoints.map((point) => ({
          title: point.title,
          body: point.body,
          tags: point.candidateTags,
          evidence: point.evidenceSpans,
        }))
      : generated.knowledgePoints,
  });
}

async function publishAnalysis(
  pool: Pool,
  task: TaskSourceRow,
  analysis: AnalysisOutput,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const recordResult = await client.query<{
      current_fragment_revision_id: string;
      current_analysis_revision_id: string | null;
      current_analysis_fragment_revision_id: string | null;
      current_analysis_has_corrections: boolean;
      archived_at: Date | string | null;
    }>(
      `SELECT record.current_fragment_revision_id,
              record.current_analysis_revision_id,
              active.fragment_revision_id AS current_analysis_fragment_revision_id,
              (
                EXISTS (
                  SELECT 1
                    FROM knowledge_points AS point
                    INNER JOIN knowledge_point_corrections AS correction
                      ON correction.knowledge_point_id = point.id
                   WHERE point.analysis_revision_id = record.current_analysis_revision_id
                )
                OR EXISTS (
                  SELECT 1
                    FROM record_overview_corrections AS correction
                   WHERE correction.record_id = record.id
                     AND correction.analysis_revision_id =
                       record.current_analysis_revision_id
                )
              ) AS current_analysis_has_corrections,
              record.archived_at
         FROM records AS record
         LEFT JOIN ai_analysis_revisions AS active
           ON active.id = record.current_analysis_revision_id
          AND active.status = 'ACTIVE'
        WHERE record.id = $1
        FOR UPDATE OF record`,
      [task.record_id],
    );
    const record = recordResult.rows[0];

    if (!record) {
      await client.query("ROLLBACK");
      return;
    }

    const publishable =
      record.archived_at === null &&
      record.current_fragment_revision_id === task.fragment_revision_id;
    const automatic = task.handling === "AUTOMATIC";
    const hasActiveAnalysis = Boolean(record.current_analysis_revision_id);
    const sameSourceReanalysis =
      hasActiveAnalysis &&
      record.current_analysis_fragment_revision_id === task.fragment_revision_id;
    const wholeVersionCandidate =
      publishable &&
      hasActiveAnalysis &&
      (sameSourceReanalysis ||
        !automatic ||
        record.current_analysis_has_corrections);
    const automaticPublish =
      publishable && automatic && !wholeVersionCandidate;
    const analysisId = randomUUID();

    if (automaticPublish && record.current_analysis_revision_id) {
      await client.query(
        `UPDATE ai_analysis_revisions
            SET status = 'SUPERSEDED'
          WHERE id = $1
            AND status = 'ACTIVE'`,
        [record.current_analysis_revision_id],
      );
    }

    await client.query(
      `INSERT INTO ai_analysis_revisions
         (id,
          record_id,
          fragment_revision_id,
          task_id,
          model_config_version,
          text_model,
          title,
          summary,
          status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        analysisId,
        task.record_id,
        task.fragment_revision_id,
        task.id,
        task.model_config_version,
        task.text_model,
        analysis.title,
        analysis.summary,
        publishable ? (automaticPublish ? "ACTIVE" : "GENERATED") : "STALE",
      ],
    );

    for (const [pointIndex, point] of analysis.knowledgePoints.entries()) {
      const pointId = randomUUID();

      await client.query(
        `INSERT INTO knowledge_points
           (id,
            record_id,
            fragment_revision_id,
            analysis_revision_id,
            position,
            ai_title,
            ai_body,
            publication_status,
            usage_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INCLUDED')`,
        [
          pointId,
          task.record_id,
          task.fragment_revision_id,
          analysisId,
          pointIndex + 1,
          point.title,
          point.body,
          publishable
            ? automaticPublish
              ? "AUTO_PUBLISHED"
              : wholeVersionCandidate
                ? "AI_CREATED"
                : "PENDING_REVIEW"
            : "AI_CREATED",
        ],
      );

      for (const [evidenceIndex, evidence] of point.evidence.entries()) {
        await client.query(
          `INSERT INTO evidence_spans
             (knowledge_point_id,
              fragment_revision_id,
              position,
              start_offset,
              end_offset,
              quote)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            pointId,
            task.fragment_revision_id,
            evidenceIndex + 1,
            evidence.start,
            evidence.end,
            evidence.quote,
          ],
        );
      }

      await assignCandidateTags(client, pointId, point.tags ?? []);
    }

    if (automaticPublish) {
      await client.query(
        `UPDATE records
            SET current_analysis_revision_id = $2,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [task.record_id, analysisId],
      );
    }

    await client.query(
      `UPDATE ai_tasks
          SET status = 'SUCCEEDED',
              finished_at = clock_timestamp(),
              failure_code = NULL,
              failure_message = NULL
        WHERE id = $1`,
      [task.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function assignCandidateTags(
  client: PoolClient,
  pointId: string,
  names: string[],
): Promise<void> {
  for (const displayName of names) {
    const normalizedName = normalizeTagName(displayName);

    if (!normalizedName) {
      continue;
    }

    const existing = await client.query<{ id: string }>(
      "SELECT id FROM tags WHERE normalized_name = $1",
      [normalizedName],
    );
    let tagId = existing.rows[0]?.id;

    if (!tagId) {
      tagId = randomUUID();
      await client.query(
        `INSERT INTO tags
           (id, display_name, normalized_name, origin, approval_status)
         VALUES ($1, $2, $3, 'AI_CREATED', 'CANDIDATE')`,
        [tagId, displayName, normalizedName],
      );
    }

    await client.query(
      `INSERT INTO tag_assignments
         (knowledge_point_id, tag_id, assigned_by, status)
       VALUES ($1, $2, 'AI', 'ACTIVE')
       ON CONFLICT DO NOTHING`,
      [pointId, tagId],
    );
  }
}

async function failTask(
  pool: Pool,
  taskId: string,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE ai_tasks
        SET status = 'FAILED',
            failure_code = $2,
            failure_message = $3,
            finished_at = clock_timestamp()
      WHERE id = $1
        AND status IN ('QUEUED', 'RUNNING')`,
    [taskId, failureCode, failureMessage],
  );
}

function publicTask(task: ObservableAiTaskRow): PublicAiTask {
  const status: PublicAiTask["status"] =
    task.status === "QUEUED"
      ? "queued"
      : task.status === "RUNNING"
        ? "running"
        : task.status === "SUCCEEDED"
          ? "succeeded"
          : "failed";

  return {
    id: task.id,
    recordId: task.record_id,
    handling: task.handling === "AUTOMATIC" ? "automatic" : "review",
    status,
    sourceTextVersion: task.source_text_version,
    modelConfigurationVersion: task.model_config_version,
    retryOfTaskId: task.retry_of_task_id,
    ...(task.failure_code
      ? {
          failure: {
            code: task.failure_code,
            message: task.failure_message,
          },
        }
      : {}),
  };
}

function asIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function firstNonEmptyLine(value: string): string {
  return value.split(/\r\n|\n|\r/u).find((line) => line.trim())?.trim() ?? value;
}
