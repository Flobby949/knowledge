import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  coverageTaskTimeoutMs,
  type CoverageGenerator,
  type GenerateCoverageInput,
  type GeneratedCoverageAnalysis,
} from "./coverage-generator.js";
import { decryptCredential } from "./model-credentials.js";

interface TextConfiguration {
  text_base_url: string;
  text_credential_ciphertext: string;
  text_model: string;
  version: number;
}

interface CoverageRecord {
  body: string;
  current: boolean;
  fragmentRevisionId: string;
  id: string;
  organized: boolean;
  tags: string[];
  title: string;
  updatedAt: Date | string;
}

interface CoverageRecordSnapshot {
  body: string;
  contentFingerprint: string;
  fragmentRevisionId: string;
  id: string;
  position: number;
  title: string;
}

interface CoveragePoint {
  body: string;
  current: boolean;
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
}

interface CoverageAnalysisRow {
  attempt_count: number;
  caveat: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  failure_code: string | null;
  failure_message: string | null;
  framework_summary: string | null;
  id: string;
  input_count: number;
  input_kind: "KNOWLEDGE_POINTS" | "RECORDS";
  model_configuration_version: number;
  started_at: Date | string | null;
  status: "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";
  text_model: string;
  topic: string;
}

interface CoverageItemRow {
  assessment: string;
  id: string;
  kind: "COVERED" | "POSSIBLE_GAP";
  recommendation: string | null;
  title: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function registerCoverageRoutes(
  app: FastifyInstance,
  options: {
    credentialSecret: string;
    generateCoverage: CoverageGenerator;
    pool: Pool;
  },
): void {
  const { credentialSecret, generateCoverage, pool } = options;

  const schedule = (analysisId: string) => {
    setImmediate(() => {
      void processCoverageAnalysis({
        analysisId,
        credentialSecret,
        generateCoverage,
        log: app.log,
        pool,
      });
    });
  };

  app.addHook("onReady", async () => {
    await pool.query(
      `UPDATE coverage_analyses
          SET status = 'FAILED',
              framework_summary = NULL,
              caveat = NULL,
              failure_code = 'SYSTEM_INTERRUPTED',
              failure_message = '服务进程终止，覆盖分析未完成，请重试。',
              completed_at = clock_timestamp()
        WHERE status IN ('QUEUED', 'RUNNING')`,
    );
  });

  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/coverage-sources",
    async (request) => ({
      items: (await readCoverageRecords(pool, undefined, request.query.q?.trim() ?? ""))
        .map(publicCoverageRecord),
    }),
  );

  app.post<{
    Body: { recordIds?: unknown; topic?: unknown };
  }>("/api/v1/coverage-analyses", async (request, reply) => {
    const topic =
      typeof request.body?.topic === "string" ? request.body.topic.trim() : "";
    const rawIds = request.body?.recordIds;

    if (!topic || topic.length > 120) {
      return reply.code(422).send({
        error: {
          code: "COVERAGE_TOPIC_INVALID",
          message: "请输入 1–120 个字符的分析主题。",
        },
      });
    }

    if (!validIds(rawIds)) {
      return reply.code(422).send({
        error: {
          code: "COVERAGE_RECORDS_INVALID",
          message: "请选择 1–50 条不同的当前记录。",
        },
      });
    }

    const recordIds = rawIds as string[];
    const records = await readCoverageRecords(pool, recordIds);
    const recordMap = new Map(records.map((record) => [record.id, record]));
    const orderedRecords = recordIds.flatMap((id) => {
      const record = recordMap.get(id);

      return record ? [record] : [];
    });

    if (
      orderedRecords.length !== recordIds.length ||
      orderedRecords.some((record) => !record.current)
    ) {
      return reply.code(409).send({
        error: {
          code: "COVERAGE_RECORDS_STALE",
          message: "部分记录已归档或发生变化，请刷新选择后重试。",
        },
      });
    }

    const configuration = await readActiveTextConfiguration(pool);

    if (!configuration) {
      return reply.code(409).send({
        error: {
          code: "MODEL_CONFIG_REQUIRED",
          message: "请先启用完整模型配置，再生成覆盖分析。",
        },
      });
    }

    const analysisId = await createCoverageTask(
      pool,
      topic,
      orderedRecords,
      configuration,
    );
    const analysis = await readCoverageAnalysis(pool, analysisId);

    if (!analysis) {
      throw new Error("Created coverage task could not be read");
    }

    schedule(analysisId);

    return reply
      .code(202)
      .header("location", `/api/v1/coverage-analyses/${analysisId}`)
      .send({ analysis });
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/coverage-analyses/:id/retry",
    async (request, reply) => {
      const configuration = await readActiveTextConfiguration(pool);

      if (!configuration) {
        return reply.code(409).send({
          error: {
            code: "MODEL_CONFIG_REQUIRED",
            message: "请先启用完整模型配置，再重试覆盖分析。",
          },
        });
      }

      const result = await pool.query<{ id: string }>(
        `UPDATE coverage_analyses
            SET status = 'QUEUED',
                model_configuration_version = $2,
                text_model = $3,
                framework_summary = NULL,
                caveat = NULL,
                failure_code = NULL,
                failure_message = NULL,
                attempt_count = attempt_count + 1,
                started_at = NULL,
                completed_at = NULL
          WHERE id = $1
            AND input_kind = 'RECORDS'
            AND status = 'FAILED'
        RETURNING id`,
        [request.params.id, configuration.version, configuration.text_model],
      );

      if (!result.rows[0]) {
        const exists = await pool.query<{ status: string }>(
          "SELECT status FROM coverage_analyses WHERE id = $1",
          [request.params.id],
        );

        if (!exists.rows[0]) {
          return reply.code(404).send({
            error: {
              code: "COVERAGE_ANALYSIS_NOT_FOUND",
              message: "覆盖分析不存在。",
            },
          });
        }

        return reply.code(409).send({
          error: {
            code: "COVERAGE_ANALYSIS_NOT_RETRYABLE",
            message: "只有失败的记录覆盖分析可以重试。",
          },
        });
      }

      const analysis = await readCoverageAnalysis(pool, request.params.id);

      if (!analysis) {
        throw new Error("Retried coverage task could not be read");
      }

      schedule(request.params.id);
      return reply.code(202).send({ analysis });
    },
  );

  app.get("/api/v1/coverage-analyses", async () => {
    const result = await pool.query<{ id: string }>(
      `SELECT id
         FROM coverage_analyses
        ORDER BY created_at DESC, id DESC`,
    );
    const items = await Promise.all(
      result.rows.map((row) => readCoverageAnalysis(pool, row.id)),
    );

    return { items: items.flatMap((analysis) => (analysis ? [analysis] : [])) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/coverage-analyses/:id",
    async (request, reply) => {
      const analysis = await readCoverageAnalysis(pool, request.params.id);

      if (!analysis) {
        return reply.code(404).send({
          error: {
            code: "COVERAGE_ANALYSIS_NOT_FOUND",
            message: "覆盖分析不存在。",
          },
        });
      }

      return { analysis };
    },
  );
}

async function processCoverageAnalysis(options: {
  analysisId: string;
  credentialSecret: string;
  generateCoverage: CoverageGenerator;
  log: FastifyInstance["log"];
  pool: Pool;
}): Promise<void> {
  const { analysisId, credentialSecret, generateCoverage, log, pool } = options;
  const claimed = await pool.query<TextConfiguration & { topic: string }>(
    `UPDATE coverage_analyses AS analysis
        SET status = 'RUNNING',
            model_configuration_version = config.version,
            text_model = config.text_model,
            started_at = clock_timestamp()
       FROM model_configurations AS config
      WHERE analysis.id = $1
        AND analysis.input_kind = 'RECORDS'
        AND analysis.status = 'QUEUED'
        AND config.state = 'ACTIVE'
    RETURNING config.version,
              config.text_base_url,
              config.text_model,
              config.text_credential_ciphertext,
              analysis.topic`,
    [analysisId],
  );
  const configuration = claimed.rows[0];

  if (!configuration) {
    return;
  }

  try {
    const records = await readCoverageRecordSnapshots(pool, analysisId);

    if (records.length === 0) {
      throw new Error("Coverage task input or model configuration is missing");
    }

    const timeoutMs = coverageTaskTimeoutMs(records);
    const generated = await generateValidatedCoverage(
      generateCoverage,
      {
        apiKey: decryptCredential(
          configuration.text_credential_ciphertext,
          credentialSecret,
        ),
        baseUrl: configuration.text_base_url,
        configurationVersion: configuration.version,
        model: configuration.text_model,
        records: records.map((record) => ({
          body: record.body,
          id: record.id,
          title: record.title,
        })),
        topic: configuration.topic,
      },
      Date.now() + timeoutMs,
    );

    await completeCoverageTask(pool, analysisId, generated);
  } catch (error) {
    log.error({ err: error, analysisId }, "coverage analysis failed");
    await failCoverageTask(pool, analysisId);
  }
}

async function createCoverageTask(
  pool: Pool,
  topic: string,
  records: CoverageRecord[],
  configuration: TextConfiguration,
): Promise<string> {
  const client = await pool.connect();
  const analysisId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO coverage_analyses
         (id, topic, framework_summary, caveat, input_count,
          model_configuration_version, text_model, input_kind, status)
       VALUES ($1, $2, NULL, NULL, $3, $4, $5, 'RECORDS', 'QUEUED')`,
      [
        analysisId,
        topic,
        records.length,
        configuration.version,
        configuration.text_model,
      ],
    );

    for (const [index, record] of records.entries()) {
      await client.query(
        `INSERT INTO coverage_analysis_records
           (analysis_id, record_id, fragment_revision_id, title,
            content_fingerprint, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          analysisId,
          record.id,
          record.fragmentRevisionId,
          record.title,
          coverageRecordFingerprint(record),
          index + 1,
        ],
      );
    }

    await client.query("COMMIT");
    return analysisId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeCoverageTask(
  pool: Pool,
  analysisId: string,
  generated: GeneratedCoverageAnalysis,
): Promise<void> {
  const client = await pool.connect();
  const caveat =
    "实验性建议：本结果只基于你选择的记录和模型参考框架，" +
    `不代表客观完备度。${generated.caveat.trim()}`;

  try {
    await client.query("BEGIN");
    const locked = await client.query<{ id: string }>(
      `SELECT id
         FROM coverage_analyses
        WHERE id = $1
          AND status = 'RUNNING'
        FOR UPDATE`,
      [analysisId],
    );

    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return;
    }

    let position = 1;

    for (const item of generated.covered) {
      const itemId = randomUUID();

      await client.query(
        `INSERT INTO coverage_analysis_items
           (id, analysis_id, kind, position, title, assessment)
         VALUES ($1, $2, 'COVERED', $3, $4, $5)`,
        [itemId, analysisId, position, item.title.trim(), item.assessment.trim()],
      );
      await client.query(
        `INSERT INTO coverage_item_records (item_id, record_id)
         SELECT $1, record_id
           FROM unnest($2::uuid[]) AS record_id`,
        [itemId, item.recordIds],
      );
      position += 1;
    }

    for (const item of generated.possibleGaps) {
      await client.query(
        `INSERT INTO coverage_analysis_items
           (id, analysis_id, kind, position, title, assessment, recommendation)
         VALUES ($1, $2, 'POSSIBLE_GAP', $3, $4, $5, $6)`,
        [
          randomUUID(),
          analysisId,
          position,
          item.title.trim(),
          item.assessment.trim(),
          item.recommendation.trim(),
        ],
      );
      position += 1;
    }

    await client.query(
      `UPDATE coverage_analyses
          SET status = 'SUCCEEDED',
              framework_summary = $2,
              caveat = $3,
              failure_code = NULL,
              failure_message = NULL,
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [analysisId, generated.frameworkSummary.trim(), caveat],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failCoverageTask(pool: Pool, analysisId: string): Promise<void> {
  await pool.query(
    `UPDATE coverage_analyses
        SET status = 'FAILED',
            framework_summary = NULL,
            caveat = NULL,
            failure_code = 'COVERAGE_GENERATION_FAILED',
            failure_message = '覆盖分析未能生成。已选记录快照仍保留，可以直接重试。',
            completed_at = clock_timestamp()
      WHERE id = $1
        AND status = 'RUNNING'`,
    [analysisId],
  );
}

async function generateValidatedCoverage(
  generateCoverage: CoverageGenerator,
  input: GenerateCoverageInput,
  deadlineAt: number,
): Promise<GeneratedCoverageAnalysis> {
  const allowedRecordIds = new Set(input.records.map(({ id }) => id));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();

    if (remainingMs <= 0) {
      throw new Error("Coverage analysis exceeded its time budget");
    }

    const generated = await generateCoverage({
      ...input,
      timeoutMs: remainingMs,
    });

    if (validCoverageAnalysis(generated, allowedRecordIds)) {
      return generated;
    }
  }

  throw new Error("Coverage response failed validation twice");
}

function validCoverageAnalysis(
  value: unknown,
  allowedRecordIds: Set<string>,
): value is GeneratedCoverageAnalysis {
  if (!isObject(value)) {
    return false;
  }

  if (
    typeof value.frameworkSummary !== "string" ||
    !value.frameworkSummary.trim() ||
    typeof value.caveat !== "string" ||
    !value.caveat.trim() ||
    !Array.isArray(value.covered) ||
    !Array.isArray(value.possibleGaps) ||
    value.covered.length > 12 ||
    value.possibleGaps.length > 12 ||
    value.covered.length + value.possibleGaps.length < 1
  ) {
    return false;
  }

  const validCovered = value.covered.every(
    (item) =>
      isObject(item) &&
      nonEmptyString(item.title) &&
      nonEmptyString(item.assessment) &&
      Array.isArray(item.recordIds) &&
      item.recordIds.length > 0 &&
      new Set(item.recordIds).size === item.recordIds.length &&
      item.recordIds.every(
        (id) => typeof id === "string" && allowedRecordIds.has(id),
      ),
  );
  const validGaps = value.possibleGaps.every(
    (item) =>
      isObject(item) &&
      nonEmptyString(item.title) &&
      nonEmptyString(item.assessment) &&
      nonEmptyString(item.recommendation),
  );

  return validCovered && validGaps;
}

async function readCoverageRecords(
  pool: Pool | PoolClient,
  recordIds?: string[],
  query = "",
): Promise<CoverageRecord[]> {
  const result = await pool.query<{
    active_analysis_id: string | null;
    body: string;
    current: boolean;
    fragment_revision_id: string;
    id: string;
    record_title: string | null;
    tags: string[];
    updated_at: Date | string;
  }>(
    `SELECT record.id,
            record.current_fragment_revision_id AS fragment_revision_id,
            revision.content AS body,
            record.updated_at,
            record.archived_at IS NULL AS current,
            analysis.id AS active_analysis_id,
            COALESCE(overview.title, analysis.title) AS record_title,
            ARRAY(
              SELECT DISTINCT resolved.display_name
                FROM tag_assignments AS assignment
                INNER JOIN tags AS resolved
                  ON resolved.id = resolve_tag_id(assignment.tag_id)
               WHERE assignment.record_id = record.id
                 AND assignment.status = 'ACTIVE'
                 AND resolved.archived_at IS NULL
               ORDER BY resolved.display_name
            ) AS tags
       FROM records AS record
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
       LEFT JOIN ai_analysis_revisions AS analysis
         ON analysis.id = record.current_analysis_revision_id
        AND analysis.status = 'ACTIVE'
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = analysis.id
      WHERE record.archived_at IS NULL
        AND ($1::uuid[] IS NULL OR record.id = ANY($1::uuid[]))
        AND (
          $2::text = ''
          OR revision.content ILIKE '%' || $2 || '%'
          OR COALESCE(overview.title, analysis.title, '') ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1
              FROM tag_assignments AS assignment
              INNER JOIN tags AS resolved
                ON resolved.id = resolve_tag_id(assignment.tag_id)
             WHERE assignment.record_id = record.id
               AND assignment.status = 'ACTIVE'
               AND resolved.display_name ILIKE '%' || $2 || '%'
          )
        )
      ORDER BY record.updated_at DESC, record.id DESC
      LIMIT 100`,
    [recordIds ?? null, query],
  );

  return result.rows.map((row) => ({
    body: row.body,
    current: row.current,
    fragmentRevisionId: row.fragment_revision_id,
    id: row.id,
    organized: row.active_analysis_id !== null,
    tags: row.tags,
    title: row.record_title ?? firstNonEmptyLine(row.body),
    updatedAt: row.updated_at,
  }));
}

async function readCoverageRecordSnapshots(
  pool: Pool | PoolClient,
  analysisId: string,
): Promise<CoverageRecordSnapshot[]> {
  const result = await pool.query<{
    body: string;
    content_fingerprint: string;
    fragment_revision_id: string;
    position: number;
    record_id: string;
    title: string;
  }>(
    `SELECT input.record_id,
            input.fragment_revision_id,
            input.title,
            input.content_fingerprint,
            input.position,
            revision.content AS body
       FROM coverage_analysis_records AS input
       INNER JOIN fragment_revisions AS revision
         ON revision.id = input.fragment_revision_id
      WHERE input.analysis_id = $1
      ORDER BY input.position`,
    [analysisId],
  );

  return result.rows.map((row) => ({
    body: row.body,
    contentFingerprint: row.content_fingerprint,
    fragmentRevisionId: row.fragment_revision_id,
    id: row.record_id,
    position: row.position,
    title: row.title,
  }));
}

async function readCoverageAnalysis(pool: Pool, analysisId: string) {
  const [analysisResult, itemResult, itemRecordResult, itemPointResult] =
    await Promise.all([
      pool.query<CoverageAnalysisRow>(
        "SELECT * FROM coverage_analyses WHERE id = $1",
        [analysisId],
      ),
      pool.query<CoverageItemRow>(
        `SELECT id, kind, title, assessment, recommendation
           FROM coverage_analysis_items
          WHERE analysis_id = $1
          ORDER BY position`,
        [analysisId],
      ),
      pool.query<{ item_id: string; record_id: string }>(
        `SELECT link.item_id, link.record_id
           FROM coverage_item_records AS link
           INNER JOIN coverage_analysis_items AS item ON item.id = link.item_id
          WHERE item.analysis_id = $1
          ORDER BY item.position, link.record_id`,
        [analysisId],
      ),
      pool.query<{ item_id: string; knowledge_point_id: string }>(
        `SELECT link.item_id, link.knowledge_point_id
           FROM coverage_item_points AS link
           INNER JOIN coverage_analysis_items AS item ON item.id = link.item_id
          WHERE item.analysis_id = $1
          ORDER BY item.position, link.knowledge_point_id`,
        [analysisId],
      ),
    ]);
  const analysis = analysisResult.rows[0];

  if (!analysis) {
    return null;
  }

  const sourceData =
    analysis.input_kind === "RECORDS"
      ? await readPublicRecordInputs(pool, analysisId)
      : await readPublicPointInputs(pool, analysisId);
  const recordLinks = groupLinks(itemRecordResult.rows, "record_id");
  const pointLinks = groupLinks(itemPointResult.rows, "knowledge_point_id");
  const sourcesById = new Map(sourceData.sources.map((source) => [source.id, source]));
  const publicItems = itemResult.rows.map((item) => ({
    id: item.id,
    kind: item.kind === "COVERED" ? ("covered" as const) : ("possible_gap" as const),
    title: item.title,
    assessment: item.assessment,
    recommendation: item.recommendation,
    sources: (
      analysis.input_kind === "RECORDS"
        ? recordLinks.get(item.id) ?? []
        : pointLinks.get(item.id) ?? []
    ).flatMap((id) => {
      const source = sourcesById.get(id);

      return source ? [source] : [];
    }),
  }));

  return {
    id: analysis.id,
    advisory: true as const,
    topic: analysis.topic,
    status: analysis.status.toLowerCase(),
    canRetry: analysis.status === "FAILED" && analysis.input_kind === "RECORDS",
    failure:
      analysis.failure_code && analysis.failure_message
        ? { code: analysis.failure_code, message: analysis.failure_message }
        : null,
    attemptCount: analysis.attempt_count,
    frameworkSummary: analysis.framework_summary,
    caveat: analysis.caveat,
    inputCount: analysis.input_count,
    inputKind:
      analysis.input_kind === "RECORDS" ? ("records" as const) : ("knowledge_points" as const),
    inputChanged: sourceData.inputChanged,
    model: {
      name: analysis.text_model,
      configurationVersion: analysis.model_configuration_version,
    },
    createdAt: new Date(analysis.created_at).toISOString(),
    startedAt: nullableIsoString(analysis.started_at),
    completedAt: nullableIsoString(analysis.completed_at),
    sources: sourceData.sources,
    covered: publicItems.filter(({ kind }) => kind === "covered"),
    possibleGaps: publicItems.filter(({ kind }) => kind === "possible_gap"),
  };
}

async function readPublicRecordInputs(pool: Pool, analysisId: string) {
  const snapshots = await readCoverageRecordSnapshots(pool, analysisId);
  const currentRecords = await readCoverageRecords(
    pool,
    snapshots.map(({ id }) => id),
  );
  const currentById = new Map(currentRecords.map((record) => [record.id, record]));
  const sources = snapshots.map((snapshot) => {
    const current = currentById.get(snapshot.id);
    const changedSinceAnalysis =
      !current ||
      current.fragmentRevisionId !== snapshot.fragmentRevisionId ||
      coverageRecordFingerprint(current) !== snapshot.contentFingerprint;

    return {
      id: snapshot.id,
      recordId: snapshot.id,
      title: snapshot.title,
      excerpt: excerpt(snapshot.body),
      current: Boolean(current),
      changedSinceAnalysis,
    };
  });

  return {
    sources,
    inputChanged: sources.some(
      (source) => !source.current || source.changedSinceAnalysis,
    ),
  };
}

async function readPublicPointInputs(pool: Pool, analysisId: string) {
  const inputResult = await pool.query<{
    content_fingerprint: string;
    knowledge_point_id: string;
  }>(
    `SELECT knowledge_point_id, content_fingerprint
       FROM coverage_analysis_points
      WHERE analysis_id = $1
      ORDER BY position`,
    [analysisId],
  );
  const points = await readCoveragePoints(
    pool,
    inputResult.rows.map(({ knowledge_point_id }) => knowledge_point_id),
  );
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const sources = inputResult.rows.flatMap((row) => {
    const point = pointsById.get(row.knowledge_point_id);

    return point ? [publicCoveragePoint(point, row.content_fingerprint)] : [];
  });

  return {
    sources,
    inputChanged:
      sources.length !== inputResult.rows.length ||
      sources.some((source) => !source.current || source.changedSinceAnalysis),
  };
}

async function readCoveragePoints(
  pool: Pool | PoolClient,
  knowledgePointIds: string[],
): Promise<CoveragePoint[]> {
  const result = await pool.query<{
    body: string;
    current: boolean;
    id: string;
    record_id: string;
    record_source: string;
    record_title: string | null;
    title: string;
  }>(
    `SELECT point.id,
            point.record_id,
            COALESCE(correction.title, point.ai_title) AS title,
            COALESCE(correction.body, point.ai_body) AS body,
            COALESCE(overview.title, active.title) AS record_title,
            current_revision.content AS record_source,
            record.archived_at IS NULL
              AND record.current_analysis_revision_id = point.analysis_revision_id
              AND active.id IS NOT NULL
              AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
              AND point.usage_status = 'INCLUDED' AS current
       FROM knowledge_points AS point
       INNER JOIN records AS record ON record.id = point.record_id
       INNER JOIN fragment_revisions AS current_revision
         ON current_revision.id = record.current_fragment_revision_id
       LEFT JOIN ai_analysis_revisions AS active
         ON active.id = point.analysis_revision_id
        AND active.status = 'ACTIVE'
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = record.current_analysis_revision_id
      WHERE point.id = ANY($1::uuid[])
      ORDER BY point.id`,
    [knowledgePointIds],
  );

  return result.rows.map((row) => ({
    body: row.body,
    current: row.current,
    id: row.id,
    recordId: row.record_id,
    recordTitle: row.record_title ?? firstNonEmptyLine(row.record_source),
    title: row.title,
  }));
}

function publicCoverageRecord(record: CoverageRecord) {
  return {
    id: record.id,
    title: record.title,
    excerpt: excerpt(record.body),
    tags: record.tags,
    organization: record.organized ? ("organized" as const) : ("original" as const),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}

function publicCoveragePoint(point: CoveragePoint, storedFingerprint: string) {
  return {
    id: point.id,
    recordId: point.recordId,
    title: point.title,
    excerpt: excerpt(point.body),
    current: point.current,
    changedSinceAnalysis: coveragePointFingerprint(point) !== storedFingerprint,
  };
}

function groupLinks<T extends { item_id: string }>(
  rows: T[],
  key: Exclude<keyof T, "item_id">,
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();

  for (const row of rows) {
    const value = row[key];

    if (typeof value !== "string") {
      continue;
    }

    const current = grouped.get(row.item_id) ?? [];

    current.push(value);
    grouped.set(row.item_id, current);
  }

  return grouped;
}

async function readActiveTextConfiguration(
  pool: Pool,
): Promise<TextConfiguration | null> {
  const result = await pool.query<TextConfiguration>(
    `SELECT version, text_base_url, text_model, text_credential_ciphertext
       FROM model_configurations
      WHERE state = 'ACTIVE'`,
  );

  return result.rows[0] ?? null;
}

function coverageRecordFingerprint(
  record: Pick<CoverageRecord, "body" | "title">,
): string {
  return createHash("sha256")
    .update(`${record.title.trim()}\n${record.body.trim()}`.normalize("NFKC"))
    .digest("hex");
}

function coveragePointFingerprint(point: CoveragePoint): string {
  return createHash("sha256")
    .update(`${point.title.trim()}\n${point.body.trim()}`.normalize("NFKC"))
    .digest("hex");
}

function validIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 50 &&
    value.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) &&
    new Set(value).size === value.length
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableIsoString(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function excerpt(text: string): string {
  const compact = text.trim().replace(/\s+/gu, " ");

  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "未命名记录"
  );
}
