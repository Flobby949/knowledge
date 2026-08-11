import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { cosineSimilarity } from "./semantic-search.js";

type DuplicateSourceType = "KNOWLEDGE_POINT" | "ORIGINAL";
type DuplicateStatus = "ACCEPTED" | "PENDING_REVIEW" | "REJECTED" | "REMOVED";

interface DuplicateSource {
  current: boolean;
  id: string;
  recordId: string;
  recordTitle: string;
  sourceType: DuplicateSourceType;
  text: string;
  title: string;
}

interface DuplicateCandidate {
  configurationVersion: number | null;
  detectionKind: "EXACT" | "SEMANTIC";
  reason: string;
  score: number;
  sourceA: DuplicateSource;
  sourceB: DuplicateSource;
}

interface StoredSuggestionRow {
  configuration_version: number | null;
  consolidation_id: string | null;
  created_at: Date | string;
  detection_kind: "EXACT" | "SEMANTIC";
  id: string;
  primary_source_id: string | null;
  reason: string;
  similarity_score: number;
  source_a_fingerprint: string;
  source_a_id: string;
  source_a_type: DuplicateSourceType;
  source_b_fingerprint: string;
  source_b_id: string;
  source_b_type: DuplicateSourceType;
  status: DuplicateStatus;
}

const SEMANTIC_DUPLICATE_THRESHOLD = 0.92;

export function registerDuplicateRoutes(
  app: FastifyInstance,
  options: { pool: Pool },
): void {
  const { pool } = options;

  app.post("/api/v1/duplicate-suggestions/scan", async () => ({
    scan: await scanDuplicateSuggestions(pool),
  }));

  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/duplicate-suggestions",
    async (request, reply) => {
      const status = request.query.status ?? "pending";

      if (status !== "pending" && status !== "resolved") {
        return reply.code(422).send({
          error: {
            code: "DUPLICATE_SUGGESTION_QUERY_INVALID",
            message: "重复建议分区无效。",
          },
        });
      }

      return {
        items: await readDuplicateSuggestions(pool, status),
      };
    },
  );

  app.post<{
    Body: { primarySourceId?: unknown };
    Params: { id: string };
  }>(
    "/api/v1/duplicate-suggestions/:id/accept",
    async (request, reply) => {
      if (typeof request.body?.primarySourceId !== "string") {
        return reply.code(422).send({
          error: {
            code: "DUPLICATE_PRIMARY_REQUIRED",
            message: "请选择合并后保留的主知识。",
          },
        });
      }

      const outcome = await acceptDuplicateSuggestion(
        pool,
        request.params.id,
        request.body.primarySourceId,
      );

      if (outcome === "not_found") {
        return reply.code(404).send({
          error: {
            code: "DUPLICATE_SUGGESTION_NOT_FOUND",
            message: "重复建议不存在。",
          },
        });
      }

      if (outcome === "not_pending") {
        return reply.code(409).send({
          error: {
            code: "DUPLICATE_SUGGESTION_ALREADY_DECIDED",
            message: "这条重复建议已经处理。",
          },
        });
      }

      if (outcome === "invalid_primary") {
        return reply.code(422).send({
          error: {
            code: "DUPLICATE_PRIMARY_INVALID",
            message: "主知识必须是建议中的一项。",
          },
        });
      }

      if (outcome === "stale") {
        return reply.code(409).send({
          error: {
            code: "DUPLICATE_SUGGESTION_STALE",
            message: "相关内容已经变化，请重新扫描后再决定。",
          },
        });
      }

      const suggestion = await readDuplicateSuggestion(pool, request.params.id);

      if (!suggestion) {
        throw new Error("Accepted duplicate suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/duplicate-suggestions/:id/reject",
    async (request, reply) => {
      const result = await pool.query(
        `UPDATE duplicate_suggestions
            SET status = 'REJECTED',
                decided_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1
            AND status = 'PENDING_REVIEW'
        RETURNING id`,
        [request.params.id],
      );

      if (!result.rows[0]) {
        const exists = await suggestionExists(pool, request.params.id);

        return reply.code(exists ? 409 : 404).send({
          error: {
            code: exists
              ? "DUPLICATE_SUGGESTION_ALREADY_DECIDED"
              : "DUPLICATE_SUGGESTION_NOT_FOUND",
            message: exists ? "这条重复建议已经处理。" : "重复建议不存在。",
          },
        });
      }

      const suggestion = await readDuplicateSuggestion(pool, request.params.id);

      if (!suggestion) {
        throw new Error("Rejected duplicate suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/duplicate-suggestions/:id/consolidation",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const suggestion = await client.query<{ status: DuplicateStatus }>(
          `SELECT status
             FROM duplicate_suggestions
            WHERE id = $1
            FOR UPDATE`,
          [request.params.id],
        );

        if (!suggestion.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(404).send({
            error: {
              code: "DUPLICATE_SUGGESTION_NOT_FOUND",
              message: "重复建议不存在。",
            },
          });
        }

        if (suggestion.rows[0].status !== "ACCEPTED") {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "DUPLICATE_CONSOLIDATION_NOT_ACTIVE",
              message: "当前没有可撤销的来源保留合并。",
            },
          });
        }

        await client.query(
          `UPDATE duplicate_consolidations
              SET removed_at = clock_timestamp()
            WHERE suggestion_id = $1
              AND removed_at IS NULL`,
          [request.params.id],
        );
        await client.query(
          `UPDATE duplicate_suggestions
              SET status = 'REMOVED',
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [request.params.id],
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
}

async function scanDuplicateSuggestions(pool: Pool) {
  const sources = (await readDuplicateSources(pool)).filter(
    (source) => source.current,
  );
  const semantic = await readReadyEmbeddings(pool);
  const candidates: DuplicateCandidate[] = [];

  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    const left = sources[leftIndex];

    if (!left) {
      continue;
    }

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < sources.length;
      rightIndex += 1
    ) {
      const right = sources[rightIndex];

      if (
        !right ||
        left.sourceType !== right.sourceType ||
        left.recordId === right.recordId
      ) {
        continue;
      }

      const [sourceA, sourceB] = orderedSources(left, right);
      const sourceAFingerprint = duplicateFingerprint(sourceA.text);
      const sourceBFingerprint = duplicateFingerprint(sourceB.text);

      if (sourceAFingerprint === sourceBFingerprint) {
        candidates.push({
          configurationVersion: null,
          detectionKind: "EXACT",
          reason: "两项知识在统一兼容字符、大小写与空白后内容完全一致。",
          score: 1,
          sourceA,
          sourceB,
        });
        continue;
      }

      const sourceAVector = semantic.embeddings.get(sourceKey(sourceA));
      const sourceBVector = semantic.embeddings.get(sourceKey(sourceB));

      if (!sourceAVector || !sourceBVector) {
        continue;
      }

      const score = cosineSimilarity(sourceAVector, sourceBVector);

      if (score >= SEMANTIC_DUPLICATE_THRESHOLD) {
        candidates.push({
          configurationVersion: semantic.configurationVersion,
          detectionKind: "SEMANTIC",
          reason: `两项知识的当前语义向量相似度为 ${Math.round(score * 100)}%，建议人工核验是否重复。`,
          score,
          sourceA,
          sourceB,
        });
      }
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const candidate of candidates) {
      await upsertDuplicateCandidate(client, candidate);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const pending = await readDuplicateSuggestions(pool, "pending");

  return {
    exactCandidates: candidates.filter(
      ({ detectionKind }) => detectionKind === "EXACT",
    ).length,
    semanticCandidates: candidates.filter(
      ({ detectionKind }) => detectionKind === "SEMANTIC",
    ).length,
    semanticReadySources: semantic.embeddings.size,
    semanticStatus:
      semantic.configurationVersion === null ? ("unavailable" as const) : ("ready" as const),
    pendingSuggestions: pending.length,
  };
}

async function upsertDuplicateCandidate(
  client: PoolClient,
  candidate: DuplicateCandidate,
): Promise<void> {
  await client.query(
    `INSERT INTO duplicate_suggestions
       (id, source_a_type, source_a_id, source_a_record_id,
        source_a_fingerprint, source_b_type, source_b_id,
        source_b_record_id, source_b_fingerprint, detection_kind,
        similarity_score, reason, configuration_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT
       (detection_kind, source_a_type, source_a_id, source_a_fingerprint,
        source_b_type, source_b_id, source_b_fingerprint)
     DO UPDATE
           SET similarity_score = EXCLUDED.similarity_score,
               reason = EXCLUDED.reason,
               configuration_version = EXCLUDED.configuration_version,
               updated_at = clock_timestamp()`,
    [
      randomUUID(),
      candidate.sourceA.sourceType,
      candidate.sourceA.id,
      candidate.sourceA.recordId,
      duplicateFingerprint(candidate.sourceA.text),
      candidate.sourceB.sourceType,
      candidate.sourceB.id,
      candidate.sourceB.recordId,
      duplicateFingerprint(candidate.sourceB.text),
      candidate.detectionKind,
      candidate.score,
      candidate.reason,
      candidate.configurationVersion,
    ],
  );
}

async function acceptDuplicateSuggestion(
  pool: Pool,
  suggestionId: string,
  primarySourceId: string,
): Promise<"accepted" | "invalid_primary" | "not_found" | "not_pending" | "stale"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<StoredSuggestionRow>(
      `${SUGGESTION_SELECT}
        WHERE suggestion.id = $1
        FOR UPDATE OF suggestion`,
      [suggestionId],
    );
    const suggestion = result.rows[0];

    if (!suggestion) {
      await client.query("ROLLBACK");
      return "not_found";
    }

    if (suggestion.status !== "PENDING_REVIEW") {
      await client.query("ROLLBACK");
      return "not_pending";
    }

    if (
      primarySourceId !== suggestion.source_a_id &&
      primarySourceId !== suggestion.source_b_id
    ) {
      await client.query("ROLLBACK");
      return "invalid_primary";
    }

    const sources = sourceMap(await readDuplicateSources(client));
    const sourceA = sources.get(
      `${suggestion.source_a_type}:${suggestion.source_a_id}`,
    );
    const sourceB = sources.get(
      `${suggestion.source_b_type}:${suggestion.source_b_id}`,
    );

    if (
      !sourceA?.current ||
      !sourceB?.current ||
      duplicateFingerprint(sourceA.text) !== suggestion.source_a_fingerprint ||
      duplicateFingerprint(sourceB.text) !== suggestion.source_b_fingerprint
    ) {
      await client.query("ROLLBACK");
      return "stale";
    }

    await client.query(
      `UPDATE duplicate_suggestions
          SET status = 'ACCEPTED',
              primary_source_id = $2,
              decided_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [suggestionId, primarySourceId],
    );
    await client.query(
      `INSERT INTO duplicate_consolidations
         (id, suggestion_id, primary_source_id)
       VALUES ($1, $2, $3)`,
      [randomUUID(), suggestionId, primarySourceId],
    );
    await client.query("COMMIT");
    return "accepted";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readDuplicateSuggestions(
  pool: Pool | PoolClient,
  section: "pending" | "resolved",
) {
  const result = await pool.query<StoredSuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE ${
        section === "pending"
          ? "suggestion.status = 'PENDING_REVIEW'"
          : "suggestion.status <> 'PENDING_REVIEW'"
      }
      ORDER BY CASE suggestion.detection_kind WHEN 'EXACT' THEN 0 ELSE 1 END,
               suggestion.similarity_score DESC,
               suggestion.created_at DESC,
               suggestion.id DESC`,
  );
  const sources = sourceMap(await readDuplicateSources(pool));

  return result.rows.flatMap((row) => {
    const suggestion = publicSuggestion(row, sources);

    if (!suggestion) {
      return [];
    }

    return section === "pending" && !suggestion.canDecide ? [] : [suggestion];
  });
}

async function readDuplicateSuggestion(pool: Pool, suggestionId: string) {
  const result = await pool.query<StoredSuggestionRow>(
    `${SUGGESTION_SELECT}
      WHERE suggestion.id = $1`,
    [suggestionId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return publicSuggestion(row, sourceMap(await readDuplicateSources(pool)));
}

function publicSuggestion(
  row: StoredSuggestionRow,
  sources: Map<string, DuplicateSource>,
) {
  const sourceA = sources.get(`${row.source_a_type}:${row.source_a_id}`);
  const sourceB = sources.get(`${row.source_b_type}:${row.source_b_id}`);

  if (!sourceA || !sourceB) {
    return null;
  }

  const sourceAChanged =
    duplicateFingerprint(sourceA.text) !== row.source_a_fingerprint;
  const sourceBChanged =
    duplicateFingerprint(sourceB.text) !== row.source_b_fingerprint;

  return {
    id: row.id,
    kind: row.detection_kind === "EXACT" ? ("exact" as const) : ("semantic" as const),
    score: row.similarity_score,
    reason: row.reason,
    status: publicDuplicateStatus(row.status),
    primarySourceId: row.primary_source_id,
    consolidationId: row.consolidation_id,
    canDecide:
      row.status === "PENDING_REVIEW" &&
      sourceA.current &&
      sourceB.current &&
      !sourceAChanged &&
      !sourceBChanged,
    createdAt: new Date(row.created_at).toISOString(),
    sources: [
      publicDuplicateSource(sourceA, sourceAChanged),
      publicDuplicateSource(sourceB, sourceBChanged),
    ],
  };
}

function publicDuplicateSource(source: DuplicateSource, changed: boolean) {
  return {
    id: source.id,
    type:
      source.sourceType === "ORIGINAL"
        ? ("original" as const)
        : ("knowledge_point" as const),
    recordId: source.recordId,
    recordTitle: source.recordTitle,
    title: source.title,
    excerpt: excerpt(source.text),
    current: source.current,
    changedSinceSuggestion: changed,
  };
}

function publicDuplicateStatus(status: DuplicateStatus) {
  if (status === "PENDING_REVIEW") {
    return "pending_review" as const;
  }

  if (status === "ACCEPTED") {
    return "accepted" as const;
  }

  return status === "REJECTED" ? ("rejected" as const) : ("removed" as const);
}

async function readDuplicateSources(
  pool: Pool | PoolClient,
): Promise<DuplicateSource[]> {
  const result = await pool.query<{
    current: boolean;
    record_id: string;
    record_title: string | null;
    source_id: string;
    source_text: string;
    source_title: string | null;
    source_type: DuplicateSourceType;
  }>(
    `SELECT 'ORIGINAL'::duplicate_source_type AS source_type,
            revision.id AS source_id,
            record.id AS record_id,
            NULL::text AS source_title,
            revision.content AS source_text,
            COALESCE(overview.title, active.title) AS record_title,
            record.archived_at IS NULL
              AND record.current_fragment_revision_id = revision.id AS current
       FROM fragment_revisions AS revision
       INNER JOIN records AS record
         ON record.id = revision.record_id
       LEFT JOIN ai_analysis_revisions AS active
         ON active.id = record.current_analysis_revision_id
        AND active.status = 'ACTIVE'
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = active.id
      UNION ALL
     SELECT 'KNOWLEDGE_POINT'::duplicate_source_type,
            point.id,
            point.record_id,
            COALESCE(correction.title, point.ai_title),
            COALESCE(correction.title, point.ai_title) || E'\n' ||
              COALESCE(correction.body, point.ai_body),
            COALESCE(overview.title, active.title),
            record.archived_at IS NULL
              AND record.current_analysis_revision_id = point.analysis_revision_id
              AND active.id IS NOT NULL
              AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
              AND point.usage_status = 'INCLUDED'
       FROM knowledge_points AS point
       INNER JOIN records AS record
         ON record.id = point.record_id
       LEFT JOIN ai_analysis_revisions AS active
         ON active.id = point.analysis_revision_id
        AND active.status = 'ACTIVE'
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = record.current_analysis_revision_id
      ORDER BY source_type, source_id`,
  );

  return result.rows.map((row) => {
    const title = row.source_title ?? firstNonEmptyLine(row.source_text);

    return {
      current: row.current,
      id: row.source_id,
      recordId: row.record_id,
      recordTitle: row.record_title ?? firstNonEmptyLine(row.source_text),
      sourceType: row.source_type,
      text: row.source_text,
      title,
    };
  });
}

async function readReadyEmbeddings(pool: Pool): Promise<{
  configurationVersion: number | null;
  embeddings: Map<string, number[]>;
}> {
  const configuration = await pool.query<{ version: number }>(
    `SELECT version
       FROM model_configurations
      WHERE state = 'ACTIVE'`,
  );
  const configurationVersion = configuration.rows[0]?.version;

  if (configurationVersion === undefined) {
    return { configurationVersion: null, embeddings: new Map() };
  }

  const result = await pool.query<{
    embedding: number[];
    source_id: string;
    source_type: DuplicateSourceType;
  }>(
    `SELECT embedding.source_type,
            embedding.source_id,
            embedding.embedding
       FROM semantic_embeddings AS embedding
       INNER JOIN semantic_document_states AS state
         ON state.configuration_version = embedding.configuration_version
        AND state.source_type = embedding.source_type
        AND state.source_id = embedding.source_id
        AND state.text_content = embedding.text_content
        AND state.status = 'READY'
      WHERE embedding.configuration_version = $1
        AND embedding.source_type IN ('ORIGINAL', 'KNOWLEDGE_POINT')`,
    [configurationVersion],
  );

  return {
    configurationVersion,
    embeddings: new Map(
      result.rows.map((row) => [
        `${row.source_type}:${row.source_id}`,
        row.embedding,
      ]),
    ),
  };
}

async function suggestionExists(
  pool: Pool,
  suggestionId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM duplicate_suggestions
        WHERE id = $1
     )`,
    [suggestionId],
  );

  return result.rows[0]?.exists ?? false;
}

function sourceMap(sources: DuplicateSource[]) {
  return new Map(sources.map((source) => [sourceKey(source), source]));
}

function sourceKey(source: DuplicateSource): string {
  return `${source.sourceType}:${source.id}`;
}

function orderedSources(
  left: DuplicateSource,
  right: DuplicateSource,
): [DuplicateSource, DuplicateSource] {
  return sourceKey(left).localeCompare(sourceKey(right)) <= 0
    ? [left, right]
    : [right, left];
}

function duplicateFingerprint(text: string): string {
  return createHash("sha256").update(normalizeDuplicateText(text)).digest("hex");
}

function normalizeDuplicateText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function excerpt(text: string): string {
  const compact = text.trim().replace(/\s+/gu, " ");

  return compact.length > 220 ? `${compact.slice(0, 219)}…` : compact;
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "未命名记录";
}

const SUGGESTION_SELECT = `SELECT suggestion.id,
       suggestion.source_a_type,
       suggestion.source_a_id,
       suggestion.source_a_fingerprint,
       suggestion.source_b_type,
       suggestion.source_b_id,
       suggestion.source_b_fingerprint,
       suggestion.detection_kind,
       suggestion.similarity_score,
       suggestion.reason,
       suggestion.status,
       suggestion.primary_source_id,
       suggestion.configuration_version,
       suggestion.created_at,
       consolidation.id AS consolidation_id
  FROM duplicate_suggestions AS suggestion
  LEFT JOIN duplicate_consolidations AS consolidation
    ON consolidation.suggestion_id = suggestion.id`;
