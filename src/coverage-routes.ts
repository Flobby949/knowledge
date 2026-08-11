import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import type {
  CoverageGenerator,
  GeneratedCoverageAnalysis,
} from "./coverage-generator.js";
import { decryptCredential } from "./model-credentials.js";

interface ActiveTextConfiguration {
  text_base_url: string;
  text_credential_ciphertext: string;
  text_model: string;
  version: number;
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
  caveat: string;
  created_at: Date | string;
  framework_summary: string;
  id: string;
  input_count: number;
  model_configuration_version: number;
  text_model: string;
  topic: string;
}

interface CoverageItemRow {
  analysis_id: string;
  assessment: string;
  id: string;
  kind: "COVERED" | "POSSIBLE_GAP";
  position: number;
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

  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/coverage-sources",
    async (request) => ({
      items: await readCoverageSources(pool, request.query.q?.trim() ?? ""),
    }),
  );

  app.post<{
    Body: { knowledgePointIds?: unknown; topic?: unknown };
  }>("/api/v1/coverage-analyses", async (request, reply) => {
    const topic =
      typeof request.body?.topic === "string" ? request.body.topic.trim() : "";
    const rawIds = request.body?.knowledgePointIds;

    if (!topic || topic.length > 120) {
      return reply.code(422).send({
        error: {
          code: "COVERAGE_TOPIC_INVALID",
          message: "请输入 1–120 个字符的分析主题。",
        },
      });
    }

    if (
      !Array.isArray(rawIds) ||
      rawIds.length < 1 ||
      rawIds.length > 50 ||
      rawIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
      new Set(rawIds).size !== rawIds.length
    ) {
      return reply.code(422).send({
        error: {
          code: "COVERAGE_POINTS_INVALID",
          message: "请选择 1–50 个不同的当前知识点。",
        },
      });
    }

    const knowledgePointIds = rawIds as string[];
    const points = await readCoveragePoints(pool, knowledgePointIds);
    const pointMap = new Map(points.map((point) => [point.id, point]));
    const orderedPoints = knowledgePointIds.flatMap((id) => {
      const point = pointMap.get(id);

      return point ? [point] : [];
    });

    if (
      orderedPoints.length !== knowledgePointIds.length ||
      orderedPoints.some((point) => !point.current)
    ) {
      return reply.code(409).send({
        error: {
          code: "COVERAGE_POINTS_STALE",
          message: "部分知识点已不再生效，请刷新选择后重试。",
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

    let generated: GeneratedCoverageAnalysis;

    try {
      generated = await generateValidatedCoverage(generateCoverage, {
        apiKey: decryptCredential(
          configuration.text_credential_ciphertext,
          credentialSecret,
        ),
        baseUrl: configuration.text_base_url,
        configurationVersion: configuration.version,
        model: configuration.text_model,
        topic,
        knowledgePoints: orderedPoints.map((point) => ({
          id: point.id,
          title: point.title,
          body: point.body,
        })),
      });
    } catch {
      return reply.code(502).send({
        error: {
          code: "COVERAGE_GENERATION_FAILED",
          message: "覆盖分析未能生成，请稍后重试；已选知识不会变化。",
        },
      });
    }

    const analysisId = await saveCoverageAnalysis(
      pool,
      topic,
      orderedPoints,
      generated,
      configuration,
    );
    const analysis = await readCoverageAnalysis(pool, analysisId);

    if (!analysis) {
      throw new Error("Created coverage analysis could not be read");
    }

    return reply
      .code(201)
      .header("location", `/api/v1/coverage-analyses/${analysisId}`)
      .send({ analysis });
  });

  app.get("/api/v1/coverage-analyses", async () => {
    const result = await pool.query<CoverageAnalysisRow>(
      `SELECT *
         FROM coverage_analyses
        ORDER BY created_at DESC, id DESC`,
    );
    const items = await Promise.all(
      result.rows.map((row) => readCoverageAnalysis(pool, row.id)),
    );

    return {
      items: items.flatMap((analysis) => (analysis ? [analysis] : [])),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/coverage-analyses/:id",
    async (request, reply) => {
      const analysis = await readCoverageAnalysis(pool, request.params.id);

      if (!analysis) {
        return reply.code(404).send({
          error: {
            code: "COVERAGE_ANALYSIS_NOT_FOUND",
            message: "知识覆盖分析不存在。",
          },
        });
      }

      return { analysis };
    },
  );
}

async function readCoverageSources(pool: Pool, query: string) {
  const result = await pool.query<{
    body: string;
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
            COALESCE(overview.title, analysis.title) AS record_title,
            revision.content AS record_source
       FROM knowledge_points AS point
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.archived_at IS NULL
        AND record.current_analysis_revision_id = point.analysis_revision_id
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = analysis.id
      WHERE point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
        AND (
          $1::text = ''
          OR COALESCE(correction.title, point.ai_title) ILIKE '%' || $1 || '%'
          OR COALESCE(correction.body, point.ai_body) ILIKE '%' || $1 || '%'
          OR COALESCE(overview.title, analysis.title) ILIKE '%' || $1 || '%'
          OR EXISTS (
            SELECT 1
              FROM tag_assignments AS assignment
              INNER JOIN tags AS tag
                ON tag.id = resolve_tag_id(assignment.tag_id)
             WHERE assignment.knowledge_point_id = point.id
               AND assignment.status = 'ACTIVE'
               AND tag.display_name ILIKE '%' || $1 || '%'
          )
        )
      ORDER BY record.updated_at DESC, point.position, point.id
      LIMIT 100`,
    [query],
  );

  return result.rows.map((row) => ({
    id: row.id,
    recordId: row.record_id,
    recordTitle: row.record_title ?? firstNonEmptyLine(row.record_source),
    title: row.title,
    excerpt: excerpt(row.body),
  }));
}

async function readCoveragePoints(
  pool: Pool | PoolClient,
  knowledgePointIds?: string[],
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
       INNER JOIN records AS record
         ON record.id = point.record_id
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
      WHERE ($1::uuid[] IS NULL OR point.id = ANY($1::uuid[]))
      ORDER BY point.id`,
    [knowledgePointIds ?? null],
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

async function generateValidatedCoverage(
  generateCoverage: CoverageGenerator,
  input: Parameters<CoverageGenerator>[0],
): Promise<GeneratedCoverageAnalysis> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generated = await generateCoverage(input);

    if (validCoverageAnalysis(generated, new Set(input.knowledgePoints.map(({ id }) => id)))) {
      return generated;
    }
  }

  throw new Error("Coverage response failed validation twice");
}

function validCoverageAnalysis(
  value: unknown,
  allowedPointIds: Set<string>,
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
      Array.isArray(item.knowledgePointIds) &&
      item.knowledgePointIds.length > 0 &&
      new Set(item.knowledgePointIds).size === item.knowledgePointIds.length &&
      item.knowledgePointIds.every(
        (id) => typeof id === "string" && allowedPointIds.has(id),
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

async function saveCoverageAnalysis(
  pool: Pool,
  topic: string,
  points: CoveragePoint[],
  generated: GeneratedCoverageAnalysis,
  configuration: ActiveTextConfiguration,
): Promise<string> {
  const client = await pool.connect();
  const analysisId = randomUUID();
  const caveat =
    "实验性建议：本结果只基于你选择的知识点和模型参考框架，" +
    `不代表客观完备度。${generated.caveat.trim()}`;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO coverage_analyses
         (id, topic, framework_summary, caveat, input_count,
          model_configuration_version, text_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        analysisId,
        topic,
        generated.frameworkSummary.trim(),
        caveat,
        points.length,
        configuration.version,
        configuration.text_model,
      ],
    );

    for (const [index, point] of points.entries()) {
      await client.query(
        `INSERT INTO coverage_analysis_points
           (analysis_id, knowledge_point_id, content_fingerprint, position)
         VALUES ($1, $2, $3, $4)`,
        [analysisId, point.id, coveragePointFingerprint(point), index + 1],
      );
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
        `INSERT INTO coverage_item_points (item_id, knowledge_point_id)
         SELECT $1, point_id
           FROM unnest($2::uuid[]) AS point_id`,
        [itemId, item.knowledgePointIds],
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

    await client.query("COMMIT");
    return analysisId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readCoverageAnalysis(pool: Pool, analysisId: string) {
  const [analysisResult, inputResult, itemResult, itemPointResult] =
    await Promise.all([
      pool.query<CoverageAnalysisRow>(
        `SELECT * FROM coverage_analyses WHERE id = $1`,
        [analysisId],
      ),
      pool.query<{
        content_fingerprint: string;
        knowledge_point_id: string;
        position: number;
      }>(
        `SELECT knowledge_point_id, content_fingerprint, position
           FROM coverage_analysis_points
          WHERE analysis_id = $1
          ORDER BY position`,
        [analysisId],
      ),
      pool.query<CoverageItemRow>(
        `SELECT *
           FROM coverage_analysis_items
          WHERE analysis_id = $1
          ORDER BY position`,
        [analysisId],
      ),
      pool.query<{ item_id: string; knowledge_point_id: string }>(
        `SELECT link.item_id, link.knowledge_point_id
           FROM coverage_item_points AS link
           INNER JOIN coverage_analysis_items AS item
             ON item.id = link.item_id
          WHERE item.analysis_id = $1
          ORDER BY item.position, link.knowledge_point_id`,
        [analysisId],
      ),
    ]);
  const analysis = analysisResult.rows[0];

  if (!analysis) {
    return null;
  }

  const points = await readCoveragePoints(
    pool,
    inputResult.rows.map(({ knowledge_point_id }) => knowledge_point_id),
  );
  const pointsById = new Map(points.map((point) => [point.id, point]));
  const inputFingerprints = new Map(
    inputResult.rows.map((row) => [
      row.knowledge_point_id,
      row.content_fingerprint,
    ]),
  );
  const publicPoints = inputResult.rows.flatMap((row) => {
    const point = pointsById.get(row.knowledge_point_id);

    if (!point) {
      return [];
    }

    return [publicCoveragePoint(point, row.content_fingerprint)];
  });
  const itemPointIds = new Map<string, string[]>();

  for (const link of itemPointResult.rows) {
    const current = itemPointIds.get(link.item_id) ?? [];

    current.push(link.knowledge_point_id);
    itemPointIds.set(link.item_id, current);
  }
  const publicItems = itemResult.rows.map((item) => ({
    id: item.id,
    kind: item.kind === "COVERED" ? ("covered" as const) : ("possible_gap" as const),
    title: item.title,
    assessment: item.assessment,
    recommendation: item.recommendation,
    sources: (itemPointIds.get(item.id) ?? []).flatMap((pointId) => {
      const point = pointsById.get(pointId);
      const storedFingerprint = inputFingerprints.get(pointId);

      return point && storedFingerprint
        ? [publicCoveragePoint(point, storedFingerprint)]
        : [];
    }),
  }));
  const inputChanged =
    publicPoints.length !== analysis.input_count ||
    publicPoints.some(
      (point) => !point.current || point.changedSinceAnalysis,
    );

  return {
    id: analysis.id,
    advisory: true,
    topic: analysis.topic,
    frameworkSummary: analysis.framework_summary,
    caveat: analysis.caveat,
    inputCount: analysis.input_count,
    inputChanged,
    model: {
      name: analysis.text_model,
      configurationVersion: analysis.model_configuration_version,
    },
    createdAt: new Date(analysis.created_at).toISOString(),
    sources: publicPoints,
    covered: publicItems.filter(({ kind }) => kind === "covered"),
    possibleGaps: publicItems.filter(({ kind }) => kind === "possible_gap"),
  };
}

function publicCoveragePoint(point: CoveragePoint, storedFingerprint: string) {
  return {
    id: point.id,
    recordId: point.recordId,
    recordTitle: point.recordTitle,
    title: point.title,
    excerpt: excerpt(point.body),
    current: point.current,
    changedSinceAnalysis:
      coveragePointFingerprint(point) !== storedFingerprint,
  };
}

async function readActiveTextConfiguration(
  pool: Pool,
): Promise<ActiveTextConfiguration | null> {
  const result = await pool.query<ActiveTextConfiguration>(
    `SELECT version,
            text_base_url,
            text_model,
            text_credential_ciphertext
       FROM model_configurations
      WHERE state = 'ACTIVE'`,
  );

  return result.rows[0] ?? null;
}

function coveragePointFingerprint(point: CoveragePoint): string {
  return createHash("sha256")
    .update(`${point.title.trim()}\n${point.body.trim()}`.normalize("NFKC"))
    .digest("hex");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(text: string): string {
  const compact = text.trim().replace(/\s+/gu, " ");

  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "未命名记录";
}
