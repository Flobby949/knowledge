import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import { decryptCredential } from "./model-credentials.js";
import type {
  GeneratedRelation,
  GeneratedRelationType,
  RelationGenerator,
} from "./relation-generator.js";
import { cosineSimilarity } from "./semantic-search.js";

type DatabaseRelationType =
  | "ANALOGY"
  | "APPLIES"
  | "CONTRASTS"
  | "EXTENDS"
  | "PREREQUISITE"
  | "SIMILAR";

type RelationSuggestionStatus =
  | "CONFIRMED"
  | "PENDING_REVIEW"
  | "REJECTED"
  | "REMOVED";

interface ActiveTextConfiguration {
  text_base_url: string;
  text_credential_ciphertext: string;
  text_model: string;
  version: number;
}

interface RelationEvidence {
  id: string;
  quote: string;
}

interface RelationPoint {
  analysisRevisionId: string;
  body: string;
  current: boolean;
  evidence: RelationEvidence[];
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
}

interface RelationCandidate {
  inputFingerprint: string;
  pairKey: string;
  pointA: RelationPoint;
  pointB: RelationPoint;
  score: number;
}

interface ValidatedRelation {
  confidence: number;
  description: string;
  evidenceSourceIds: string[];
  evidenceTargetIds: string[];
  reason: string;
  source: RelationPoint;
  target: RelationPoint;
  type: DatabaseRelationType;
}

interface RelationSuggestionRow {
  confidence: number;
  created_at: Date | string;
  description: string;
  formal_description: string | null;
  formal_relation_id: string | null;
  formal_relation_type: DatabaseRelationType | null;
  id: string;
  input_fingerprint: string;
  model_configuration_version: number;
  pair_key: string;
  reason: string;
  relation_removed_at: Date | string | null;
  relation_type: DatabaseRelationType;
  source_content_fingerprint: string;
  source_knowledge_point_id: string;
  status: RelationSuggestionStatus;
  target_content_fingerprint: string;
  target_knowledge_point_id: string;
  text_model: string;
}

const RELATION_RECALL_THRESHOLD = 0.65;
const MAX_RELATION_CANDIDATES = 12;
const PUBLIC_RELATION_TYPES = new Set<GeneratedRelationType>([
  "analogy",
  "applies",
  "contrasts",
  "extends",
  "prerequisite",
  "similar",
]);

export function registerRelationRoutes(
  app: FastifyInstance,
  options: {
    credentialSecret: string;
    generateRelation: RelationGenerator;
    pool: Pool;
  },
): void {
  const { credentialSecret, generateRelation, pool } = options;

  app.post("/api/v1/relation-suggestions/scan", async (_request, reply) => {
    const configuration = await readActiveTextConfiguration(pool);

    if (!configuration) {
      return reply.code(409).send({
        error: {
          code: "MODEL_CONFIG_REQUIRED",
          message: "请先启用完整模型配置，再扫描知识关系。",
        },
      });
    }

    return {
      scan: await scanRelationSuggestions({
        pool,
        credentialSecret,
        configuration,
        generateRelation,
      }),
    };
  });

  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/relation-suggestions",
    async (request, reply) => {
      const section = request.query.status ?? "pending";

      if (section !== "pending" && section !== "resolved") {
        return reply.code(422).send({
          error: {
            code: "RELATION_SUGGESTION_QUERY_INVALID",
            message: "关系建议分区无效。",
          },
        });
      }

      return {
        items: await readRelationSuggestions(pool, section),
      };
    },
  );

  app.post<{
    Body: { description?: unknown; type?: unknown };
    Params: { id: string };
  }>(
    "/api/v1/relation-suggestions/:id/confirm",
    async (request, reply) => {
      const type = request.body?.type;
      const description = request.body?.description;

      if (
        typeof type !== "string" ||
        !PUBLIC_RELATION_TYPES.has(type as GeneratedRelationType) ||
        typeof description !== "string" ||
        !description.trim()
      ) {
        return reply.code(422).send({
          error: {
            code: "RELATION_CONFIRMATION_INVALID",
            message: "请选择关系类型并填写关系描述。",
          },
        });
      }

      const outcome = await confirmRelationSuggestion(
        pool,
        request.params.id,
        databaseRelationType(type as GeneratedRelationType),
        description.trim(),
      );

      if (outcome !== "confirmed") {
        const responses = {
          not_found: {
            status: 404,
            code: "RELATION_SUGGESTION_NOT_FOUND",
            message: "关系建议不存在。",
          },
          not_pending: {
            status: 409,
            code: "RELATION_SUGGESTION_ALREADY_DECIDED",
            message: "这条关系建议已经处理。",
          },
          stale: {
            status: 409,
            code: "RELATION_SUGGESTION_STALE",
            message: "相关知识点已经变化，请重新扫描后再确认。",
          },
        } as const;
        const response = responses[outcome];

        return reply.code(response.status).send({
          error: { code: response.code, message: response.message },
        });
      }

      const suggestion = await readRelationSuggestion(pool, request.params.id);

      if (!suggestion) {
        throw new Error("Confirmed relation suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/relation-suggestions/:id/reject",
    async (request, reply) => {
      const result = await pool.query(
        `UPDATE relation_suggestions
            SET status = 'REJECTED',
                decided_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1
            AND status = 'PENDING_REVIEW'
        RETURNING id`,
        [request.params.id],
      );

      if (!result.rows[0]) {
        const exists = await relationSuggestionExists(pool, request.params.id);

        return reply.code(exists ? 409 : 404).send({
          error: {
            code: exists
              ? "RELATION_SUGGESTION_ALREADY_DECIDED"
              : "RELATION_SUGGESTION_NOT_FOUND",
            message: exists ? "这条关系建议已经处理。" : "关系建议不存在。",
          },
        });
      }

      const suggestion = await readRelationSuggestion(pool, request.params.id);

      if (!suggestion) {
        throw new Error("Rejected relation suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/knowledge-relations/:id",
    async (request, reply) => {
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const relation = await client.query<{
          suggestion_id: string;
        }>(
          `SELECT suggestion_id
             FROM knowledge_relations
            WHERE id = $1
              AND removed_at IS NULL
            FOR UPDATE`,
          [request.params.id],
        );
        const row = relation.rows[0];

        if (!row) {
          await client.query("ROLLBACK");
          return reply.code(404).send({
            error: {
              code: "KNOWLEDGE_RELATION_NOT_FOUND",
              message: "有效知识关系不存在。",
            },
          });
        }

        await client.query(
          `UPDATE knowledge_relations
              SET removed_at = clock_timestamp()
            WHERE id = $1`,
          [request.params.id],
        );
        await client.query(
          `UPDATE relation_suggestions
              SET status = 'REMOVED',
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [row.suggestion_id],
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

  app.get("/api/v1/knowledge-relations", async () => ({
    items: await readKnowledgeRelations(pool),
  }));
}

async function scanRelationSuggestions(options: {
  configuration: ActiveTextConfiguration;
  credentialSecret: string;
  generateRelation: RelationGenerator;
  pool: Pool;
}) {
  const { configuration, credentialSecret, generateRelation, pool } = options;
  const points = (await readRelationPoints(pool)).filter((point) => point.current);
  const embeddings = await readKnowledgePointEmbeddings(
    pool,
    configuration.version,
  );
  const candidates: RelationCandidate[] = [];

  for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
    const left = points[leftIndex];

    if (!left) {
      continue;
    }

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < points.length;
      rightIndex += 1
    ) {
      const right = points[rightIndex];

      if (!right || left.recordId === right.recordId) {
        continue;
      }

      const leftEmbedding = embeddings.get(left.id);
      const rightEmbedding = embeddings.get(right.id);

      if (!leftEmbedding || !rightEmbedding) {
        continue;
      }

      const score = cosineSimilarity(leftEmbedding, rightEmbedding);

      if (score < RELATION_RECALL_THRESHOLD) {
        continue;
      }

      candidates.push({
        pointA: left,
        pointB: right,
        pairKey: relationPairKey(left.id, right.id),
        inputFingerprint: relationInputFingerprint(left, right),
        score,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score || left.pairKey.localeCompare(right.pairKey),
  );
  const recalled = candidates.slice(0, MAX_RELATION_CANDIDATES);
  const existingInputs = await readExistingRelationInputs(pool, recalled);
  const toGenerate = recalled.filter(
    (candidate) =>
      !existingInputs.has(
        `${candidate.pairKey}:${candidate.inputFingerprint}`,
      ),
  );
  const apiKey = decryptCredential(
    configuration.text_credential_ciphertext,
    credentialSecret,
  );
  const outcomes = await Promise.allSettled(
    toGenerate.map(async (candidate) => {
      const generated = await generateValidatedRelation(generateRelation, {
        apiKey,
        baseUrl: configuration.text_base_url,
        configurationVersion: configuration.version,
        model: configuration.text_model,
        pointA: {
          id: candidate.pointA.id,
          title: candidate.pointA.title,
          body: candidate.pointA.body,
          evidence: candidate.pointA.evidence,
        },
        pointB: {
          id: candidate.pointB.id,
          title: candidate.pointB.title,
          body: candidate.pointB.body,
          evidence: candidate.pointB.evidence,
        },
      });

      return generated
        ? {
            candidate,
            relation: normalizeGeneratedRelation(candidate, generated),
          }
        : null;
    }),
  );
  const suggestions = outcomes.flatMap((outcome) =>
    outcome.status === "fulfilled" && outcome.value ? [outcome.value] : [],
  );
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const suggestion of suggestions) {
      await insertRelationSuggestion(
        client,
        suggestion.candidate,
        suggestion.relation,
        configuration,
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    recalledPairs: recalled.length,
    alreadyReviewedPairs: recalled.length - toGenerate.length,
    suggestedRelations: suggestions.length,
    skippedPairs: outcomes.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value === null,
    ).length,
    failedPairs: outcomes.filter((outcome) => outcome.status === "rejected").length,
    embeddingStatus:
      embeddings.size >= 2 ? ("ready" as const) : ("building" as const),
    pendingSuggestions: (await readRelationSuggestions(pool, "pending")).length,
  };
}

async function generateValidatedRelation(
  generateRelation: RelationGenerator,
  input: Parameters<RelationGenerator>[0],
): Promise<Exclude<GeneratedRelation, { related: false }> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generated = await generateRelation(input);

    if (isUnrelated(generated)) {
      return null;
    }

    if (validGeneratedRelation(generated, input)) {
      return generated;
    }
  }

  throw new Error("Relation response failed validation twice");
}

function normalizeGeneratedRelation(
  candidate: RelationCandidate,
  generated: Exclude<GeneratedRelation, { related: false }>,
): ValidatedRelation {
  const reverse = generated.direction === "b_to_a";

  return {
    confidence: generated.confidence,
    description: generated.description.trim(),
    evidenceSourceIds: reverse
      ? generated.evidenceBIds
      : generated.evidenceAIds,
    evidenceTargetIds: reverse
      ? generated.evidenceAIds
      : generated.evidenceBIds,
    reason: generated.reason.trim(),
    source: reverse ? candidate.pointB : candidate.pointA,
    target: reverse ? candidate.pointA : candidate.pointB,
    type: databaseRelationType(generated.type),
  };
}

async function insertRelationSuggestion(
  client: PoolClient,
  candidate: RelationCandidate,
  relation: ValidatedRelation,
  configuration: ActiveTextConfiguration,
): Promise<void> {
  const suggestionId = randomUUID();
  const inserted = await client.query(
    `INSERT INTO relation_suggestions
       (id, pair_key, input_fingerprint, source_knowledge_point_id,
        target_knowledge_point_id, source_content_fingerprint,
        target_content_fingerprint, relation_type, description, reason,
        confidence, model_configuration_version, text_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (pair_key, input_fingerprint) DO NOTHING
     RETURNING id`,
    [
      suggestionId,
      candidate.pairKey,
      candidate.inputFingerprint,
      relation.source.id,
      relation.target.id,
      relationPointFingerprint(relation.source),
      relationPointFingerprint(relation.target),
      relation.type,
      relation.description,
      relation.reason,
      relation.confidence,
      configuration.version,
      configuration.text_model,
    ],
  );

  if (!inserted.rows[0]) {
    return;
  }

  for (const [side, evidenceIds] of [
    ["SOURCE", relation.evidenceSourceIds],
    ["TARGET", relation.evidenceTargetIds],
  ] as const) {
    await client.query(
      `INSERT INTO relation_suggestion_evidence
         (suggestion_id, evidence_span_id, side)
       SELECT $1, evidence_id, $3::relation_evidence_side
         FROM unnest($2::uuid[]) AS evidence_id`,
      [suggestionId, evidenceIds, side],
    );
  }
}

async function confirmRelationSuggestion(
  pool: Pool,
  suggestionId: string,
  type: DatabaseRelationType,
  description: string,
): Promise<"confirmed" | "not_found" | "not_pending" | "stale"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<RelationSuggestionRow>(
      `${RELATION_SUGGESTION_SELECT}
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

    const points = pointMap(await readRelationPoints(client));
    const source = points.get(suggestion.source_knowledge_point_id);
    const target = points.get(suggestion.target_knowledge_point_id);

    if (
      !source?.current ||
      !target?.current ||
      relationPointFingerprint(source) !==
        suggestion.source_content_fingerprint ||
      relationPointFingerprint(target) !== suggestion.target_content_fingerprint
    ) {
      await client.query("ROLLBACK");
      return "stale";
    }

    await client.query(
      `UPDATE relation_suggestions
          SET status = 'CONFIRMED',
              decided_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [suggestionId],
    );
    await client.query(
      `INSERT INTO knowledge_relations
         (id, suggestion_id, source_knowledge_point_id,
          target_knowledge_point_id, relation_type, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        suggestionId,
        suggestion.source_knowledge_point_id,
        suggestion.target_knowledge_point_id,
        type,
        description,
      ],
    );
    await client.query("COMMIT");
    return "confirmed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readRelationSuggestions(
  pool: Pool | PoolClient,
  section: "pending" | "resolved",
) {
  const result = await pool.query<RelationSuggestionRow>(
    `${RELATION_SUGGESTION_SELECT}
      WHERE ${
        section === "pending"
          ? "suggestion.status = 'PENDING_REVIEW'"
          : "suggestion.status <> 'PENDING_REVIEW'"
      }
      ORDER BY suggestion.confidence DESC,
               suggestion.created_at DESC,
               suggestion.id DESC`,
  );
  const points = pointMap(await readRelationPoints(pool));
  const evidence = await readSuggestionEvidence(pool, result.rows.map(({ id }) => id));

  return result.rows.flatMap((row) => {
    const suggestion = publicRelationSuggestion(row, points, evidence);

    return suggestion ? [suggestion] : [];
  });
}

async function readRelationSuggestion(pool: Pool, suggestionId: string) {
  const result = await pool.query<RelationSuggestionRow>(
    `${RELATION_SUGGESTION_SELECT}
      WHERE suggestion.id = $1`,
    [suggestionId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const points = pointMap(await readRelationPoints(pool));
  const evidence = await readSuggestionEvidence(pool, [suggestionId]);

  return publicRelationSuggestion(row, points, evidence);
}

async function readKnowledgeRelations(pool: Pool) {
  const result = await pool.query<RelationSuggestionRow>(
    `${RELATION_SUGGESTION_SELECT}
      WHERE suggestion.status = 'CONFIRMED'
        AND relation.removed_at IS NULL
      ORDER BY relation.confirmed_at DESC, relation.id DESC`,
  );
  const points = pointMap(await readRelationPoints(pool));
  const evidence = await readSuggestionEvidence(pool, result.rows.map(({ id }) => id));

  return result.rows.flatMap((row) => {
    const suggestion = publicRelationSuggestion(row, points, evidence);

    return suggestion ? [suggestion] : [];
  });
}

function publicRelationSuggestion(
  row: RelationSuggestionRow,
  points: Map<string, RelationPoint>,
  evidence: Map<string, { source: RelationEvidence[]; target: RelationEvidence[] }>,
) {
  const source = points.get(row.source_knowledge_point_id);
  const target = points.get(row.target_knowledge_point_id);

  if (!source || !target) {
    return null;
  }

  const sourceChanged =
    relationPointFingerprint(source) !== row.source_content_fingerprint;
  const targetChanged =
    relationPointFingerprint(target) !== row.target_content_fingerprint;
  const selectedEvidence = evidence.get(row.id) ?? { source: [], target: [] };

  return {
    id: row.id,
    type: publicRelationType(row.relation_type),
    description: row.description,
    reason: row.reason,
    confidence: row.confidence,
    status: publicRelationStatus(row.status),
    model: {
      name: row.text_model,
      configurationVersion: row.model_configuration_version,
    },
    canDecide:
      row.status === "PENDING_REVIEW" &&
      source.current &&
      target.current &&
      !sourceChanged &&
      !targetChanged,
    needsReview:
      !source.current || !target.current || sourceChanged || targetChanged,
    source: publicRelationPoint(source, sourceChanged, selectedEvidence.source),
    target: publicRelationPoint(target, targetChanged, selectedEvidence.target),
    relation: row.formal_relation_id
      ? {
          id: row.formal_relation_id,
          type: publicRelationType(row.formal_relation_type ?? row.relation_type),
          description: row.formal_description ?? row.description,
          removed: row.relation_removed_at !== null,
        }
      : null,
  };
}

function publicRelationPoint(
  point: RelationPoint,
  changed: boolean,
  evidence: RelationEvidence[],
) {
  return {
    id: point.id,
    recordId: point.recordId,
    recordTitle: point.recordTitle,
    title: point.title,
    body: point.body,
    current: point.current,
    changedSinceSuggestion: changed,
    evidence,
  };
}

async function readRelationPoints(
  pool: Pool | PoolClient,
): Promise<RelationPoint[]> {
  const [pointResult, evidenceResult] = await Promise.all([
    pool.query<{
      analysis_revision_id: string;
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
              point.analysis_revision_id,
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
        ORDER BY point.id`,
    ),
    pool.query<{
      id: string;
      knowledge_point_id: string;
      quote: string;
    }>(
      `SELECT id, knowledge_point_id, quote
         FROM evidence_spans
        ORDER BY knowledge_point_id, position, id`,
    ),
  ]);
  const evidence = new Map<string, RelationEvidence[]>();

  for (const row of evidenceResult.rows) {
    const current = evidence.get(row.knowledge_point_id) ?? [];

    current.push({ id: row.id, quote: row.quote });
    evidence.set(row.knowledge_point_id, current);
  }

  return pointResult.rows.map((row) => ({
    analysisRevisionId: row.analysis_revision_id,
    body: row.body,
    current: row.current,
    evidence: evidence.get(row.id) ?? [],
    id: row.id,
    recordId: row.record_id,
    recordTitle: row.record_title ?? firstNonEmptyLine(row.record_source),
    title: row.title,
  }));
}

async function readKnowledgePointEmbeddings(
  pool: Pool,
  configurationVersion: number,
): Promise<Map<string, number[]>> {
  const result = await pool.query<{ embedding: number[]; source_id: string }>(
    `SELECT embedding.source_id, embedding.embedding
       FROM semantic_embeddings AS embedding
       INNER JOIN semantic_document_states AS state
         ON state.configuration_version = embedding.configuration_version
        AND state.source_type = embedding.source_type
        AND state.source_id = embedding.source_id
        AND state.text_content = embedding.text_content
        AND state.status = 'READY'
      WHERE embedding.configuration_version = $1
        AND embedding.source_type = 'KNOWLEDGE_POINT'`,
    [configurationVersion],
  );

  return new Map(result.rows.map((row) => [row.source_id, row.embedding]));
}

async function readExistingRelationInputs(
  pool: Pool,
  candidates: RelationCandidate[],
): Promise<Set<string>> {
  if (candidates.length === 0) {
    return new Set();
  }

  const result = await pool.query<{
    input_fingerprint: string;
    pair_key: string;
  }>(
    `SELECT pair_key, input_fingerprint
       FROM relation_suggestions
      WHERE pair_key = ANY($1::text[])`,
    [[...new Set(candidates.map(({ pairKey }) => pairKey))]],
  );

  return new Set(
    result.rows.map((row) => `${row.pair_key}:${row.input_fingerprint}`),
  );
}

async function readSuggestionEvidence(
  pool: Pool | PoolClient,
  suggestionIds: string[],
): Promise<
  Map<string, { source: RelationEvidence[]; target: RelationEvidence[] }>
> {
  if (suggestionIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<{
    evidence_span_id: string;
    quote: string;
    side: "SOURCE" | "TARGET";
    suggestion_id: string;
  }>(
    `SELECT selected.suggestion_id,
            selected.evidence_span_id,
            selected.side,
            evidence.quote
       FROM relation_suggestion_evidence AS selected
       INNER JOIN evidence_spans AS evidence
         ON evidence.id = selected.evidence_span_id
      WHERE selected.suggestion_id = ANY($1::uuid[])
      ORDER BY selected.suggestion_id, selected.side, evidence.position, evidence.id`,
    [suggestionIds],
  );
  const evidence = new Map<
    string,
    { source: RelationEvidence[]; target: RelationEvidence[] }
  >();

  for (const row of result.rows) {
    const current = evidence.get(row.suggestion_id) ?? {
      source: [],
      target: [],
    };
    const target = row.side === "SOURCE" ? current.source : current.target;

    target.push({ id: row.evidence_span_id, quote: row.quote });
    evidence.set(row.suggestion_id, current);
  }

  return evidence;
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

async function relationSuggestionExists(
  pool: Pool,
  suggestionId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM relation_suggestions
        WHERE id = $1
     )`,
    [suggestionId],
  );

  return result.rows[0]?.exists ?? false;
}

function validGeneratedRelation(
  value: unknown,
  input: Parameters<RelationGenerator>[0],
): value is Exclude<GeneratedRelation, { related: false }> {
  if (!isObject(value) || value.related !== true) {
    return false;
  }

  const evidenceAIds = new Set(input.pointA.evidence.map(({ id }) => id));
  const evidenceBIds = new Set(input.pointB.evidence.map(({ id }) => id));

  return (
    typeof value.type === "string" &&
    PUBLIC_RELATION_TYPES.has(value.type as GeneratedRelationType) &&
    (value.direction === "a_to_b" || value.direction === "b_to_a") &&
    typeof value.description === "string" &&
    Boolean(value.description.trim()) &&
    typeof value.reason === "string" &&
    Boolean(value.reason.trim()) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    Array.isArray(value.evidenceAIds) &&
    value.evidenceAIds.length > 0 &&
    value.evidenceAIds.every(
      (id) => typeof id === "string" && evidenceAIds.has(id),
    ) &&
    Array.isArray(value.evidenceBIds) &&
    value.evidenceBIds.length > 0 &&
    value.evidenceBIds.every(
      (id) => typeof id === "string" && evidenceBIds.has(id),
    )
  );
}

function isUnrelated(value: unknown): value is { related: false } {
  return isObject(value) && value.related === false;
}

function pointMap(points: RelationPoint[]) {
  return new Map(points.map((point) => [point.id, point]));
}

function relationPairKey(firstId: string, secondId: string): string {
  return [firstId, secondId].sort().join(":");
}

function relationInputFingerprint(
  first: RelationPoint,
  second: RelationPoint,
): string {
  const ordered = [first, second].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return fingerprint(
    ordered
      .map((point) => `${point.id}:${relationPointFingerprint(point)}`)
      .join("|"),
  );
}

function relationPointFingerprint(point: RelationPoint): string {
  return fingerprint(`${point.title.trim()}\n${point.body.trim()}`);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex");
}

function databaseRelationType(type: GeneratedRelationType): DatabaseRelationType {
  return type.toUpperCase() as DatabaseRelationType;
}

function publicRelationType(type: DatabaseRelationType) {
  return type.toLowerCase() as GeneratedRelationType;
}

function publicRelationStatus(status: RelationSuggestionStatus) {
  if (status === "PENDING_REVIEW") {
    return "pending_review" as const;
  }

  if (status === "CONFIRMED") {
    return "confirmed" as const;
  }

  return status === "REJECTED" ? ("rejected" as const) : ("removed" as const);
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "未命名记录";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const RELATION_SUGGESTION_SELECT = `SELECT suggestion.id,
       suggestion.pair_key,
       suggestion.input_fingerprint,
       suggestion.source_knowledge_point_id,
       suggestion.target_knowledge_point_id,
       suggestion.source_content_fingerprint,
       suggestion.target_content_fingerprint,
       suggestion.relation_type,
       suggestion.description,
       suggestion.reason,
       suggestion.confidence,
       suggestion.model_configuration_version,
       suggestion.text_model,
       suggestion.status,
       suggestion.created_at,
       relation.id AS formal_relation_id,
       relation.relation_type AS formal_relation_type,
       relation.description AS formal_description,
       relation.removed_at AS relation_removed_at
  FROM relation_suggestions AS suggestion
  LEFT JOIN knowledge_relations AS relation
    ON relation.suggestion_id = suggestion.id`;
