import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  conceptRelationRequestTimeoutMs,
  type ConceptRelationGenerator,
  type GenerateConceptRelationInput,
  type GeneratedConceptRelation,
  type GeneratedConceptRelationType,
} from "./concept-relation-generator.js";
import {
  SYMMETRIC_CONCEPT_RELATION_TYPES,
  type ConceptRelationType,
} from "./domain/concept-relation.js";
import { decryptCredential } from "./model-credentials.js";
import { cosineSimilarity } from "./semantic-search.js";

type ConceptRelationSuggestionStatus =
  | "CONFIRMED"
  | "PENDING_REVIEW"
  | "REJECTED"
  | "REMOVED";

type Timestamp = Date | string;

interface ActiveTextConfiguration {
  text_base_url: string;
  text_credential_ciphertext: string;
  text_model: string;
  version: number;
}

interface ConceptState {
  archived: boolean;
  description: string;
  id: string;
  memberCount: number;
  membershipFingerprint: string;
  memberships: Array<{ id: string; knowledgePointId: string }>;
  name: string;
  revisionId: string;
}

interface ConceptRelationCandidate {
  conceptA: ConceptState;
  conceptB: ConceptState;
  inputFingerprint: string;
  pairKey: string;
  score: number;
}

interface ValidatedConceptRelation {
  confidence: number;
  description: string;
  reason: string;
  source: ConceptState;
  target: ConceptState;
  type: ConceptRelationType;
}

interface ConceptRelationSuggestionRow {
  confidence: number;
  created_at: Timestamp;
  decided_at: Timestamp | null;
  description: string;
  formal_confirmed_at: Timestamp | null;
  formal_description: string | null;
  formal_relation_id: string | null;
  formal_relation_type: ConceptRelationType | null;
  formal_source_concept_id: string | null;
  formal_target_concept_id: string | null;
  id: string;
  input_fingerprint: string;
  model_configuration_version: number;
  pair_key: string;
  reason: string;
  relation_removed_at: Timestamp | null;
  relation_type: ConceptRelationType;
  source_concept_id: string;
  source_concept_revision_id: string;
  source_description: string;
  source_membership_fingerprint: string;
  source_name: string;
  status: ConceptRelationSuggestionStatus;
  target_concept_id: string;
  target_concept_revision_id: string;
  target_description: string;
  target_membership_fingerprint: string;
  target_name: string;
  text_model: string;
  updated_at: Timestamp;
}

const CONCEPT_RELATION_RECALL_THRESHOLD = 0.65;
const MAX_CONCEPT_RELATION_CANDIDATES = 12;
const MAX_SCANNED_CONCEPTS = 100;
const CONCEPT_RELATION_SCAN_TIMEOUT_MS = 900_000;
const PUBLIC_CONCEPT_RELATION_TYPES = new Set<GeneratedConceptRelationType>([
  "analogy",
  "applies",
  "contrasts",
  "extends",
  "prerequisite",
  "similar",
]);

export function registerConceptRelationRoutes(
  app: FastifyInstance,
  options: {
    credentialSecret: string;
    generateConceptRelation: ConceptRelationGenerator;
    pool: Pool;
  },
): void {
  const { credentialSecret, generateConceptRelation, pool } = options;

  app.post(
    "/api/v1/concept-relation-suggestions/scan",
    async (_request, reply) => {
      const configuration = await readActiveTextConfiguration(pool);

      if (!configuration) {
        return reply.code(409).send({
          error: {
            code: "MODEL_CONFIG_REQUIRED",
            message: "请先启用完整模型配置，再扫描 Concept 关系。",
          },
        });
      }

      return {
        scan: await scanConceptRelationSuggestions({
          configuration,
          credentialSecret,
          generateConceptRelation,
          pool,
        }),
      };
    },
  );

  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/concept-relation-suggestions",
    async (request, reply) => {
      const section = request.query.status ?? "pending";

      if (section !== "pending" && section !== "resolved") {
        return reply.code(422).send({
          error: {
            code: "CONCEPT_RELATION_SUGGESTION_QUERY_INVALID",
            message: "Concept 关系建议分区无效。",
          },
        });
      }

      return {
        items: await readConceptRelationSuggestions(pool, section),
      };
    },
  );

  app.post<{
    Body: { description?: unknown; type?: unknown };
    Params: { id: string };
  }>(
    "/api/v1/concept-relation-suggestions/:id/confirm",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptRelationSuggestionNotFound(reply);
      }

      const type = request.body?.type;
      const description = request.body?.description;

      if (
        typeof type !== "string" ||
        !PUBLIC_CONCEPT_RELATION_TYPES.has(
          type as GeneratedConceptRelationType,
        ) ||
        typeof description !== "string" ||
        !description.trim()
      ) {
        return reply.code(422).send({
          error: {
            code: "CONCEPT_RELATION_CONFIRMATION_INVALID",
            message: "请选择关系类型并填写关系描述。",
          },
        });
      }

      const outcome = await confirmConceptRelationSuggestion(
        pool,
        request.params.id,
        databaseConceptRelationType(type as GeneratedConceptRelationType),
        description.trim(),
      );

      if (outcome !== "confirmed") {
        const responses = {
          conflict: {
            status: 409,
            code: "CONCEPT_RELATION_CONFLICT",
            message: "相同类型的有效 Concept 关系已经存在。",
          },
          not_found: {
            status: 404,
            code: "CONCEPT_RELATION_SUGGESTION_NOT_FOUND",
            message: "Concept 关系建议不存在。",
          },
          not_pending: {
            status: 409,
            code: "CONCEPT_RELATION_SUGGESTION_ALREADY_DECIDED",
            message: "这条 Concept 关系建议已经处理。",
          },
          stale: {
            status: 409,
            code: "CONCEPT_RELATION_SUGGESTION_STALE",
            message: "相关 Concept 已经变化，请重新扫描后再确认。",
          },
        } as const;
        const response = responses[outcome];

        return reply.code(response.status).send({
          error: { code: response.code, message: response.message },
        });
      }

      const suggestion = await readConceptRelationSuggestion(
        pool,
        request.params.id,
      );

      if (!suggestion) {
        throw new Error("Confirmed Concept relation suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/concept-relation-suggestions/:id/reject",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptRelationSuggestionNotFound(reply);
      }

      const result = await pool.query(
        `UPDATE concept_relation_suggestions
            SET status = 'REJECTED',
                decided_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1
            AND status = 'PENDING_REVIEW'
        RETURNING id`,
        [request.params.id],
      );

      if (!result.rows[0]) {
        const exists = await conceptRelationSuggestionExists(
          pool,
          request.params.id,
        );

        return reply.code(exists ? 409 : 404).send({
          error: {
            code: exists
              ? "CONCEPT_RELATION_SUGGESTION_ALREADY_DECIDED"
              : "CONCEPT_RELATION_SUGGESTION_NOT_FOUND",
            message: exists
              ? "这条 Concept 关系建议已经处理。"
              : "Concept 关系建议不存在。",
          },
        });
      }

      const suggestion = await readConceptRelationSuggestion(
        pool,
        request.params.id,
      );

      if (!suggestion) {
        throw new Error("Rejected Concept relation suggestion could not be read");
      }

      return { suggestion };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/concept-relations/:id",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptRelationNotFound(reply);
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const result = await client.query<{ suggestion_id: string }>(
          `SELECT suggestion_id
             FROM concept_relations
            WHERE id = $1
              AND removed_at IS NULL
            FOR UPDATE`,
          [request.params.id],
        );
        const relation = result.rows[0];

        if (!relation) {
          await client.query("ROLLBACK");
          return conceptRelationNotFound(reply);
        }

        await client.query(
          `UPDATE concept_relation_suggestions
              SET status = 'REMOVED',
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [relation.suggestion_id],
        );
        await client.query(
          `UPDATE concept_relations
              SET removed_at = clock_timestamp()
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

  app.get<{ Querystring: { conceptId?: string } }>(
    "/api/v1/concept-relations",
    async (request, reply) => {
      const { conceptId } = request.query;

      if (conceptId !== undefined && !isUuid(conceptId)) {
        return reply.code(422).send({
          error: {
            code: "CONCEPT_RELATION_QUERY_INVALID",
            message: "Concept 筛选条件无效。",
          },
        });
      }

      return {
        items: await readConceptRelations(pool, conceptId),
      };
    },
  );
}

async function scanConceptRelationSuggestions(options: {
  configuration: ActiveTextConfiguration;
  credentialSecret: string;
  generateConceptRelation: ConceptRelationGenerator;
  pool: Pool;
}) {
  const { configuration, credentialSecret, generateConceptRelation, pool } =
    options;
  const concepts = await readConceptStates(pool, {
    activeOnly: true,
    includeMemberships: true,
    limit: MAX_SCANNED_CONCEPTS,
  });
  const embeddings = await readCurrentKnowledgePointEmbeddings(
    pool,
    configuration.version,
    concepts.flatMap((concept) =>
      concept.memberships.map(({ knowledgePointId }) => knowledgePointId),
    ),
  );
  const centroids = new Map<string, number[]>();

  for (const concept of concepts) {
    const centroid = conceptCentroid(concept, embeddings);

    if (centroid) {
      centroids.set(concept.id, centroid);
    }
  }

  const candidates: ConceptRelationCandidate[] = [];

  for (let leftIndex = 0; leftIndex < concepts.length; leftIndex += 1) {
    const left = concepts[leftIndex];

    if (!left) {
      continue;
    }

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < concepts.length;
      rightIndex += 1
    ) {
      const right = concepts[rightIndex];

      if (!right) {
        continue;
      }

      const leftCentroid = centroids.get(left.id);
      const rightCentroid = centroids.get(right.id);

      if (!leftCentroid || !rightCentroid) {
        continue;
      }

      const score = cosineSimilarity(leftCentroid, rightCentroid);

      if (score < CONCEPT_RELATION_RECALL_THRESHOLD) {
        continue;
      }

      candidates.push({
        conceptA: left,
        conceptB: right,
        inputFingerprint: conceptRelationInputFingerprint(left, right),
        pairKey: conceptRelationPairKey(left.id, right.id),
        score,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score || left.pairKey.localeCompare(right.pairKey),
  );
  const recalled = candidates.slice(0, MAX_CONCEPT_RELATION_CANDIDATES);
  const existingInputs = await readExistingConceptRelationInputs(pool, recalled);
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
  const generationDeadline = Date.now() + CONCEPT_RELATION_SCAN_TIMEOUT_MS;
  let failedPairs = 0;
  let skippedPairs = 0;
  let suggestedRelations = 0;

  for (const candidate of toGenerate) {
    try {
      const generated = await generateValidatedConceptRelation(
        generateConceptRelation,
        {
          apiKey,
          baseUrl: configuration.text_base_url,
          conceptA: publicGeneratorConcept(candidate.conceptA),
          conceptB: publicGeneratorConcept(candidate.conceptB),
          configurationVersion: configuration.version,
          model: configuration.text_model,
        },
        generationDeadline,
      );

      if (!generated) {
        skippedPairs += 1;
        continue;
      }

      const inserted = await insertConceptRelationSuggestion(
        pool,
        candidate,
        normalizeGeneratedConceptRelation(candidate, generated),
        configuration,
      );

      if (inserted) {
        suggestedRelations += 1;
      }
    } catch {
      failedPairs += 1;
    }
  }

  return {
    scannedConcepts: concepts.length,
    recalledPairs: recalled.length,
    alreadyReviewedPairs: recalled.length - toGenerate.length,
    suggestedRelations,
    skippedPairs,
    failedPairs,
    embeddingStatus:
      centroids.size >= 2 ? ("ready" as const) : ("building" as const),
    pendingSuggestions: (
      await readConceptRelationSuggestions(pool, "pending")
    ).length,
  };
}

async function generateValidatedConceptRelation(
  generateConceptRelation: ConceptRelationGenerator,
  input: GenerateConceptRelationInput,
  deadlineAt: number,
): Promise<Exclude<GeneratedConceptRelation, { related: false }> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();

    if (remainingMs <= 0) {
      throw new Error("Concept relation scan exceeded its time budget");
    }

    const generated = await generateConceptRelation({
      ...input,
      timeoutMs: Math.min(conceptRelationRequestTimeoutMs(input), remainingMs),
    });

    if (isUnrelated(generated)) {
      return null;
    }

    if (validGeneratedConceptRelation(generated)) {
      return generated;
    }
  }

  throw new Error("Concept relation response failed validation twice");
}

function normalizeGeneratedConceptRelation(
  candidate: ConceptRelationCandidate,
  generated: Exclude<GeneratedConceptRelation, { related: false }>,
): ValidatedConceptRelation {
  const type = databaseConceptRelationType(generated.type);
  const reverse = generated.direction === "b_to_a";
  let source = reverse ? candidate.conceptB : candidate.conceptA;
  let target = reverse ? candidate.conceptA : candidate.conceptB;

  if (
    SYMMETRIC_CONCEPT_RELATION_TYPES.has(type) &&
    source.id.localeCompare(target.id) > 0
  ) {
    [source, target] = [target, source];
  }

  return {
    confidence: generated.confidence,
    description: generated.description.trim(),
    reason: generated.reason.trim(),
    source,
    target,
    type,
  };
}

async function insertConceptRelationSuggestion(
  pool: Pool,
  candidate: ConceptRelationCandidate,
  relation: ValidatedConceptRelation,
  configuration: ActiveTextConfiguration,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO concept_relation_suggestions
       (id, pair_key, input_fingerprint, source_concept_id,
        target_concept_id, source_concept_revision_id,
        target_concept_revision_id, source_membership_fingerprint,
        target_membership_fingerprint, relation_type, description, reason,
        confidence, model_configuration_version, text_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15)
     ON CONFLICT (pair_key, input_fingerprint) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      candidate.pairKey,
      candidate.inputFingerprint,
      relation.source.id,
      relation.target.id,
      relation.source.revisionId,
      relation.target.revisionId,
      relation.source.membershipFingerprint,
      relation.target.membershipFingerprint,
      relation.type,
      relation.description,
      relation.reason,
      relation.confidence,
      configuration.version,
      configuration.text_model,
    ],
  );

  return Boolean(result.rows[0]);
}

async function confirmConceptRelationSuggestion(
  pool: Pool,
  suggestionId: string,
  type: ConceptRelationType,
  description: string,
): Promise<"confirmed" | "conflict" | "not_found" | "not_pending" | "stale"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await client.query<ConceptRelationSuggestionRow>(
      `${CONCEPT_RELATION_SUGGESTION_SELECT}
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

    const endpointIds = [
      suggestion.source_concept_id,
      suggestion.target_concept_id,
    ].sort();

    await client.query(
      `SELECT id
         FROM concepts
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE`,
      [endpointIds],
    );
    await client.query(
      `SELECT revision.id
         FROM concepts AS concept
         INNER JOIN concept_revisions AS revision
           ON revision.id = concept.current_revision_id
          AND revision.concept_id = concept.id
        WHERE concept.id = ANY($1::uuid[])
        ORDER BY concept.id
        FOR SHARE OF revision`,
      [endpointIds],
    );

    const concepts = conceptStateMap(
      await readConceptStates(client, {
        ids: endpointIds,
        lockMembershipDependencies: true,
      }),
    );
    const source = concepts.get(suggestion.source_concept_id);
    const target = concepts.get(suggestion.target_concept_id);

    if (
      !source ||
      !target ||
      source.archived ||
      target.archived ||
      source.revisionId !== suggestion.source_concept_revision_id ||
      target.revisionId !== suggestion.target_concept_revision_id ||
      source.membershipFingerprint !==
        suggestion.source_membership_fingerprint ||
      target.membershipFingerprint !== suggestion.target_membership_fingerprint
    ) {
      await client.query("ROLLBACK");
      return "stale";
    }

    let relationSourceId = suggestion.source_concept_id;
    let relationTargetId = suggestion.target_concept_id;

    if (
      SYMMETRIC_CONCEPT_RELATION_TYPES.has(type) &&
      relationSourceId.localeCompare(relationTargetId) > 0
    ) {
      [relationSourceId, relationTargetId] = [
        relationTargetId,
        relationSourceId,
      ];
    }

    await client.query(
      `UPDATE concept_relation_suggestions
          SET status = 'CONFIRMED',
              decided_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [suggestionId],
    );
    await client.query(
      `INSERT INTO concept_relations
         (id, suggestion_id, source_concept_id, target_concept_id,
          relation_type, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        suggestionId,
        relationSourceId,
        relationTargetId,
        type,
        description,
      ],
    );
    await client.query("COMMIT");

    return "confirmed";
  } catch (error) {
    await client.query("ROLLBACK");

    if (isConceptRelationConflict(error)) {
      return "conflict";
    }

    throw error;
  } finally {
    client.release();
  }
}

async function readConceptRelationSuggestions(
  pool: Pool | PoolClient,
  section: "pending" | "resolved",
) {
  const result = await pool.query<ConceptRelationSuggestionRow>(
    `${CONCEPT_RELATION_SUGGESTION_SELECT}
      WHERE ${
        section === "pending"
          ? "suggestion.status = 'PENDING_REVIEW'"
          : "suggestion.status <> 'PENDING_REVIEW'"
      }
      ORDER BY suggestion.confidence DESC,
               suggestion.created_at DESC,
               suggestion.id DESC`,
  );

  return publicConceptRelationSuggestions(pool, result.rows);
}

async function readConceptRelationSuggestion(
  pool: Pool,
  suggestionId: string,
) {
  const result = await pool.query<ConceptRelationSuggestionRow>(
    `${CONCEPT_RELATION_SUGGESTION_SELECT}
      WHERE suggestion.id = $1`,
    [suggestionId],
  );
  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const suggestions = await publicConceptRelationSuggestions(pool, [row]);

  return suggestions[0] ?? null;
}

async function readConceptRelations(pool: Pool, conceptId?: string) {
  const parameters = conceptId === undefined ? [] : [conceptId];
  const filter = conceptId
    ? `AND (relation.source_concept_id = $1
            OR relation.target_concept_id = $1)`
    : "";
  const result = await pool.query<ConceptRelationSuggestionRow>(
    `${CONCEPT_RELATION_SUGGESTION_SELECT}
      WHERE relation.id IS NOT NULL
      ${filter}
      ORDER BY relation.confirmed_at DESC, relation.id DESC`,
    parameters,
  );

  return publicConceptRelationSuggestions(pool, result.rows);
}

async function publicConceptRelationSuggestions(
  pool: Pool | PoolClient,
  rows: ConceptRelationSuggestionRow[],
) {
  if (rows.length === 0) {
    return [];
  }

  const conceptIds = [
    ...new Set(
      rows.flatMap((row) => [
        row.source_concept_id,
        row.target_concept_id,
      ]),
    ),
  ];
  const concepts = conceptStateMap(
    await readConceptStates(pool, { ids: conceptIds }),
  );

  return rows.map((row) => publicConceptRelationSuggestion(row, concepts));
}

function publicConceptRelationSuggestion(
  row: ConceptRelationSuggestionRow,
  concepts: Map<string, ConceptState>,
) {
  const source = concepts.get(row.source_concept_id);
  const target = concepts.get(row.target_concept_id);
  const sourceChanged = conceptChangedSinceSuggestion(
    source,
    row.source_concept_revision_id,
    row.source_membership_fingerprint,
  );
  const targetChanged = conceptChangedSinceSuggestion(
    target,
    row.target_concept_revision_id,
    row.target_membership_fingerprint,
  );
  const needsReview = sourceChanged || targetChanged;

  return {
    id: row.id,
    type: publicConceptRelationType(row.relation_type),
    description: row.description,
    reason: row.reason,
    confidence: row.confidence,
    status: publicConceptRelationStatus(row.status),
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at),
    decidedAt: nullableIsoString(row.decided_at),
    model: {
      name: row.text_model,
      configurationVersion: row.model_configuration_version,
    },
    canDecide: row.status === "PENDING_REVIEW" && !needsReview,
    needsReview,
    source: publicConceptEndpoint(
      row.source_concept_id,
      row.source_concept_revision_id,
      row.source_name,
      row.source_description,
      row.source_membership_fingerprint,
      source,
    ),
    target: publicConceptEndpoint(
      row.target_concept_id,
      row.target_concept_revision_id,
      row.target_name,
      row.target_description,
      row.target_membership_fingerprint,
      target,
    ),
    relation: row.formal_relation_id
      ? {
          id: row.formal_relation_id,
          suggestionId: row.id,
          confirmationSource: {
            type: "concept_relation_suggestion" as const,
            id: row.id,
          },
          type: publicConceptRelationType(
            row.formal_relation_type ?? row.relation_type,
          ),
          description: row.formal_description ?? row.description,
          sourceConceptId:
            row.formal_source_concept_id ?? row.source_concept_id,
          targetConceptId:
            row.formal_target_concept_id ?? row.target_concept_id,
          confirmedAt: nullableIsoString(row.formal_confirmed_at),
          removedAt: nullableIsoString(row.relation_removed_at),
          removed: row.relation_removed_at !== null,
        }
      : null,
  };
}

function publicConceptEndpoint(
  id: string,
  revisionId: string,
  name: string,
  description: string,
  membershipFingerprint: string,
  current: ConceptState | undefined,
) {
  return {
    id,
    revisionId,
    name,
    description,
    membershipFingerprint,
    archived: current?.archived ?? true,
    current: Boolean(current && !current.archived),
    changedSinceSuggestion: conceptChangedSinceSuggestion(
      current,
      revisionId,
      membershipFingerprint,
    ),
    currentRevisionId: current?.revisionId ?? null,
    currentMembershipFingerprint: current?.membershipFingerprint ?? null,
    memberCount: current?.memberCount ?? 0,
  };
}

function conceptChangedSinceSuggestion(
  current: ConceptState | undefined,
  revisionId: string,
  membershipFingerprint: string,
): boolean {
  return (
    !current ||
    current.archived ||
    current.revisionId !== revisionId ||
    current.membershipFingerprint !== membershipFingerprint
  );
}

async function readConceptStates(
  pool: Pool | PoolClient,
  options: {
    activeOnly?: boolean;
    ids?: string[];
    includeMemberships?: boolean;
    limit?: number;
    lockMembershipDependencies?: boolean;
  } = {},
): Promise<ConceptState[]> {
  if (options.ids?.length === 0) {
    return [];
  }

  const ids = options.ids ?? null;
  const limit = options.limit ?? null;
  const result = await pool.query<{
    archived_at: Timestamp | null;
    current_revision_id: string;
    description: string;
    id: string;
    name: string;
  }>(
    `SELECT concept.id,
            concept.current_revision_id,
            concept.archived_at,
            revision.display_name AS name,
            revision.description
       FROM concepts AS concept
       INNER JOIN concept_revisions AS revision
         ON revision.id = concept.current_revision_id
        AND revision.concept_id = concept.id
      WHERE ($1::uuid[] IS NULL OR concept.id = ANY($1::uuid[]))
        AND ($2::boolean = false OR concept.archived_at IS NULL)
      ORDER BY concept.updated_at DESC, concept.id DESC
      LIMIT COALESCE($3::integer, 2147483647)`,
    [ids, options.activeOnly ?? false, limit],
  );
  const conceptIds = result.rows.map(({ id }) => id);
  const summaries = new Map(
    (
      await readConceptMembershipSummaries(
        pool,
        conceptIds,
        options.lockMembershipDependencies ?? false,
      )
    ).map((summary) => [summary.conceptId, summary]),
  );
  const memberships = options.includeMemberships
    ? await readEffectiveConceptMemberships(pool, conceptIds)
    : [];
  const byConcept = new Map<
    string,
    Array<{ id: string; knowledgePointId: string }>
  >();

  for (const membership of memberships) {
    const current = byConcept.get(membership.conceptId) ?? [];

    current.push({
      id: membership.id,
      knowledgePointId: membership.knowledgePointId,
    });
    byConcept.set(membership.conceptId, current);
  }

  return result.rows.map((row) => {
    const currentMemberships = byConcept.get(row.id) ?? [];
    const summary = summaries.get(row.id);

    return {
      archived: row.archived_at !== null,
      description: row.description,
      id: row.id,
      memberCount: summary?.memberCount ?? 0,
      membershipFingerprint: summary?.membershipFingerprint ?? fingerprint(""),
      memberships: currentMemberships,
      name: row.name,
      revisionId: row.current_revision_id,
    };
  });
}

async function readConceptMembershipSummaries(
  pool: Pool | PoolClient,
  conceptIds: string[],
  lockDependencies: boolean,
): Promise<
  Array<{
    conceptId: string;
    memberCount: number;
    membershipFingerprint: string;
  }>
> {
  if (conceptIds.length === 0) {
    return [];
  }

  const effectiveMemberships = lockDependencies
    ? `locked_memberships AS MATERIALIZED (
         SELECT membership.id,
                membership.concept_id,
                membership.knowledge_point_id,
                membership.removed_at,
                point.publication_status,
                point.usage_status,
                point.analysis_revision_id,
                record.archived_at,
                record.current_analysis_revision_id,
                analysis.status AS analysis_status
           FROM concept_memberships AS membership
           INNER JOIN knowledge_points AS point
             ON point.id = membership.knowledge_point_id
           INNER JOIN records AS record
             ON record.id = point.record_id
           INNER JOIN ai_analysis_revisions AS analysis
             ON analysis.id = point.analysis_revision_id
          WHERE membership.concept_id = ANY($1::uuid[])
          ORDER BY membership.concept_id, membership.id
          FOR SHARE OF membership, point, record, analysis
       ),
       effective_memberships AS (
         SELECT id, concept_id, knowledge_point_id
           FROM locked_memberships
          WHERE removed_at IS NULL
            AND publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
            AND usage_status = 'INCLUDED'
            AND archived_at IS NULL
            AND current_analysis_revision_id = analysis_revision_id
            AND analysis_status = 'ACTIVE'
       )`
    : `effective_memberships AS (
         SELECT membership.id,
                membership.concept_id,
                membership.knowledge_point_id
           FROM concept_memberships AS membership
           INNER JOIN knowledge_points AS point
             ON point.id = membership.knowledge_point_id
            AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
            AND point.usage_status = 'INCLUDED'
           INNER JOIN records AS record
             ON record.id = point.record_id
            AND record.archived_at IS NULL
            AND record.current_analysis_revision_id = point.analysis_revision_id
           INNER JOIN ai_analysis_revisions AS analysis
             ON analysis.id = point.analysis_revision_id
            AND analysis.status = 'ACTIVE'
          WHERE membership.concept_id = ANY($1::uuid[])
            AND membership.removed_at IS NULL
       )`;
  const result = await pool.query<{
    concept_id: string;
    member_count: number;
    membership_fingerprint: string;
  }>(
    `WITH requested_concepts AS (
       SELECT unnest($1::uuid[]) AS concept_id
     ),
     ${effectiveMemberships}
     SELECT requested.concept_id,
            COUNT(effective.id)::integer AS member_count,
            encode(
              sha256(
                convert_to(
                  COALESCE(
                    string_agg(
                      effective.id::text || ':' ||
                        effective.knowledge_point_id::text,
                      E'\n'
                      ORDER BY (
                        effective.id::text || ':' ||
                          effective.knowledge_point_id::text
                      ) COLLATE "C"
                    ) FILTER (WHERE effective.id IS NOT NULL),
                    ''
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ) AS membership_fingerprint
       FROM requested_concepts AS requested
       LEFT JOIN effective_memberships AS effective
         ON effective.concept_id = requested.concept_id
      GROUP BY requested.concept_id
      ORDER BY requested.concept_id`,
    [conceptIds],
  );

  return result.rows.map((row) => ({
    conceptId: row.concept_id,
    memberCount: row.member_count,
    membershipFingerprint: row.membership_fingerprint,
  }));
}

async function readEffectiveConceptMemberships(
  pool: Pool | PoolClient,
  conceptIds: string[],
): Promise<
  Array<{ conceptId: string; id: string; knowledgePointId: string }>
> {
  if (conceptIds.length === 0) {
    return [];
  }

  const result = await pool.query<{
    concept_id: string;
    id: string;
    knowledge_point_id: string;
  }>(
    `SELECT membership.id,
            membership.concept_id,
            membership.knowledge_point_id
       FROM concept_memberships AS membership
       INNER JOIN knowledge_points AS point
         ON point.id = membership.knowledge_point_id
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.archived_at IS NULL
        AND record.current_analysis_revision_id = point.analysis_revision_id
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
      WHERE membership.concept_id = ANY($1::uuid[])
        AND membership.removed_at IS NULL
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      ORDER BY membership.concept_id,
               membership.knowledge_point_id,
               membership.id`,
    [conceptIds],
  );

  return result.rows.map((row) => ({
    conceptId: row.concept_id,
    id: row.id,
    knowledgePointId: row.knowledge_point_id,
  }));
}

async function readCurrentKnowledgePointEmbeddings(
  pool: Pool,
  configurationVersion: number,
  knowledgePointIds: string[],
): Promise<Map<string, number[]>> {
  const uniqueIds = [...new Set(knowledgePointIds)];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<{
    embedding: number[];
    source_id: string;
  }>(
    `SELECT embedding.source_id, embedding.embedding
       FROM semantic_document_states AS state
       INNER JOIN semantic_embeddings AS embedding
         ON embedding.configuration_version = state.configuration_version
        AND embedding.source_type = state.source_type
        AND embedding.source_id = state.source_id
        AND embedding.text_content = state.text_content
      WHERE state.configuration_version = $1
        AND state.source_type = 'KNOWLEDGE_POINT'
        AND state.source_id = ANY($2::uuid[])
        AND state.status = 'READY'
      ORDER BY state.source_id`,
    [configurationVersion, uniqueIds],
  );

  return new Map(result.rows.map((row) => [row.source_id, row.embedding]));
}

function conceptCentroid(
  concept: ConceptState,
  embeddings: Map<string, number[]>,
): number[] | null {
  const vectors = concept.memberships.flatMap(({ knowledgePointId }) => {
    const embedding = embeddings.get(knowledgePointId);

    return embedding ? [embedding] : [];
  });
  const dimensions = vectors[0]?.length ?? 0;

  if (
    dimensions === 0 ||
    vectors.some((embedding) => embedding.length !== dimensions)
  ) {
    return null;
  }

  const centroid = Array.from({ length: dimensions }, () => 0);

  for (const embedding of vectors) {
    for (let index = 0; index < dimensions; index += 1) {
      centroid[index] = (centroid[index] ?? 0) + (embedding[index] ?? 0);
    }
  }

  return centroid.map((value) => value / vectors.length);
}

async function readExistingConceptRelationInputs(
  pool: Pool,
  candidates: ConceptRelationCandidate[],
): Promise<Set<string>> {
  if (candidates.length === 0) {
    return new Set();
  }

  const result = await pool.query<{
    input_fingerprint: string;
    pair_key: string;
  }>(
    `SELECT pair_key, input_fingerprint
       FROM concept_relation_suggestions
      WHERE pair_key = ANY($1::text[])`,
    [[...new Set(candidates.map(({ pairKey }) => pairKey))]],
  );

  return new Set(
    result.rows.map((row) => `${row.pair_key}:${row.input_fingerprint}`),
  );
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

async function conceptRelationSuggestionExists(
  pool: Pool,
  suggestionId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM concept_relation_suggestions
        WHERE id = $1
     ) AS exists`,
    [suggestionId],
  );

  return result.rows[0]?.exists ?? false;
}

function publicGeneratorConcept(concept: ConceptState) {
  return {
    description: concept.description,
    id: concept.id,
    memberCount: concept.memberCount,
    name: concept.name,
  };
}

function validGeneratedConceptRelation(
  value: unknown,
): value is Exclude<GeneratedConceptRelation, { related: false }> {
  return (
    isObject(value) &&
    value.related === true &&
    typeof value.type === "string" &&
    PUBLIC_CONCEPT_RELATION_TYPES.has(
      value.type as GeneratedConceptRelationType,
    ) &&
    (value.direction === "a_to_b" || value.direction === "b_to_a") &&
    typeof value.description === "string" &&
    Boolean(value.description.trim()) &&
    typeof value.reason === "string" &&
    Boolean(value.reason.trim()) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function isUnrelated(value: unknown): value is { related: false } {
  return isObject(value) && value.related === false;
}

function conceptStateMap(concepts: ConceptState[]) {
  return new Map(concepts.map((concept) => [concept.id, concept]));
}

function conceptRelationPairKey(firstId: string, secondId: string): string {
  return [firstId, secondId].sort().join(":");
}

function conceptRelationInputFingerprint(
  first: ConceptState,
  second: ConceptState,
): string {
  const ordered = [first, second].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  return fingerprint(
    ordered
      .map(
        (concept) =>
          `${concept.id}:${concept.revisionId}:${concept.membershipFingerprint}`,
      )
      .join("|"),
  );
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.normalize("NFKC")).digest("hex");
}

function databaseConceptRelationType(
  type: GeneratedConceptRelationType,
): ConceptRelationType {
  return type.toUpperCase() as ConceptRelationType;
}

function publicConceptRelationType(type: ConceptRelationType) {
  return type.toLowerCase() as GeneratedConceptRelationType;
}

function publicConceptRelationStatus(status: ConceptRelationSuggestionStatus) {
  if (status === "PENDING_REVIEW") {
    return "pending_review" as const;
  }

  if (status === "CONFIRMED") {
    return "confirmed" as const;
  }

  return status === "REJECTED" ? ("rejected" as const) : ("removed" as const);
}

function asIsoString(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIsoString(value: Timestamp | null): string | null {
  return value === null ? null : asIsoString(value);
}

function isConceptRelationConflict(error: unknown): boolean {
  return (
    isObject(error) &&
    error.code === "23505" &&
    error.constraint === "concept_relations_active_identity_unique"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function conceptRelationSuggestionNotFound(reply: {
  code(statusCode: number): { send(payload: unknown): unknown };
}) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_RELATION_SUGGESTION_NOT_FOUND",
      message: "Concept 关系建议不存在。",
    },
  });
}

function conceptRelationNotFound(reply: {
  code(statusCode: number): { send(payload: unknown): unknown };
}) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_RELATION_NOT_FOUND",
      message: "有效 Concept 关系不存在。",
    },
  });
}

const CONCEPT_RELATION_SUGGESTION_SELECT = `SELECT suggestion.id,
       suggestion.pair_key,
       suggestion.input_fingerprint,
       suggestion.source_concept_id,
       suggestion.target_concept_id,
       suggestion.source_concept_revision_id,
       suggestion.target_concept_revision_id,
       suggestion.source_membership_fingerprint,
       suggestion.target_membership_fingerprint,
       suggestion.relation_type,
       suggestion.description,
       suggestion.reason,
       suggestion.confidence,
       suggestion.model_configuration_version,
       suggestion.text_model,
       suggestion.status,
       suggestion.created_at,
       suggestion.updated_at,
       suggestion.decided_at,
       source_revision.display_name AS source_name,
       source_revision.description AS source_description,
       target_revision.display_name AS target_name,
       target_revision.description AS target_description,
       relation.id AS formal_relation_id,
       relation.source_concept_id AS formal_source_concept_id,
       relation.target_concept_id AS formal_target_concept_id,
       relation.relation_type AS formal_relation_type,
       relation.description AS formal_description,
       relation.confirmed_at AS formal_confirmed_at,
       relation.removed_at AS relation_removed_at
  FROM concept_relation_suggestions AS suggestion
  INNER JOIN concept_revisions AS source_revision
    ON source_revision.id = suggestion.source_concept_revision_id
   AND source_revision.concept_id = suggestion.source_concept_id
  INNER JOIN concept_revisions AS target_revision
    ON target_revision.id = suggestion.target_concept_revision_id
   AND target_revision.concept_id = suggestion.target_concept_id
  LEFT JOIN concept_relations AS relation
    ON relation.suggestion_id = suggestion.id`;
