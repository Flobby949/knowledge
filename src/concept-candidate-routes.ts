import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  conceptCandidateTimeoutMs,
  type ConceptCandidateGenerator,
  type ConceptCandidatePointInput,
  type GenerateConceptCandidateInput,
  type GeneratedConceptCandidate,
} from "./concept-candidate-generator.js";
import { recallConceptKnowledgePoints } from "./concept-recall.js";
import { readConceptDetail } from "./concept-routes.js";
import { normalizeConceptName } from "./domain/concept-name.js";
import { decryptCredential } from "./model-credentials.js";

type Timestamp = Date | string;

interface TextConfiguration {
  text_base_url: string;
  text_credential_ciphertext: string;
  text_model: string;
  version: number;
}

interface EvidenceSnapshot {
  endOffset: number;
  fragmentRevisionId: string;
  id: string;
  position: number;
  quote: string;
  startOffset: number;
}

interface CandidatePointSnapshot {
  body: string;
  contentFingerprint: string;
  evidence: EvidenceSnapshot[];
  id: string;
  inputId: string;
  position: number;
  recordId: string;
  recordTitle: string;
  title: string;
}

interface CurrentCandidatePoint {
  body: string;
  evidence: EvidenceSnapshot[];
  id: string;
  recordId: string;
  recordTitle: string;
  title: string;
}

interface ScanRow {
  attempt_count: number;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  failure_code: string | null;
  failure_message: string | null;
  id: string;
  input_count: number;
  input_fingerprint: string;
  model_configuration_version: number;
  outcome: "CANDIDATE" | "DUPLICATE" | "NO_SUGGESTION" | null;
  outcome_reason: string | null;
  started_at: Timestamp | null;
  status: "FAILED" | "QUEUED" | "RUNNING" | "SUCCEEDED";
  text_model: string;
  trigger_analysis_revision_id: string | null;
}

interface CandidateRow {
  accepted_concept_id: string | null;
  confirmed_description: string | null;
  confirmed_name: string | null;
  created_at: Timestamp;
  decided_at: Timestamp | null;
  id: string;
  reason: string;
  review_status: "ACCEPTED" | "PENDING" | "REJECTED";
  suggested_description: string;
  suggested_name: string;
}

interface CandidateInputRow {
  body_snapshot: string;
  content_fingerprint: string;
  evidence_snapshot: unknown;
  id: string;
  knowledge_point_id: string;
  position: number;
  record_id: string;
  record_title_snapshot: string;
  title_snapshot: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ConceptCandidateAutomation {
  schedulePending(): Promise<void>;
  scheduleForAnalysis(analysisRevisionId: string): void;
  settle(): Promise<void>;
}

export function registerConceptCandidateRoutes(
  app: FastifyInstance,
  options: {
    credentialSecret: string;
    generateConceptCandidate: ConceptCandidateGenerator;
    pool: Pool;
    scheduleSemanticIndex: () => Promise<void>;
  },
): ConceptCandidateAutomation {
  const {
    credentialSecret,
    generateConceptCandidate,
    pool,
    scheduleSemanticIndex,
  } = options;
  const backgroundWork = new Set<Promise<void>>();
  const scheduledAnalyses = new Set<string>();
  let candidateScanTail = Promise.resolve();
  let discoveryTail = Promise.resolve();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );

    backgroundWork.add(settled);
    void settled.finally(() => backgroundWork.delete(settled));
    return operation;
  };
  const queueSerialBackground = (
    previous: Promise<void>,
    operation: () => Promise<void>,
    context: Record<string, unknown>,
    message: string,
  ): Promise<void> => {
    const pending = previous
      .then(operation)
      .catch((error) => app.log.error({ ...context, err: error }, message));

    backgroundWork.add(pending);
    void pending.finally(() => backgroundWork.delete(pending));
    return pending;
  };
  const schedule = (scanId: string) => {
    candidateScanTail = queueSerialBackground(
      candidateScanTail,
      () =>
        processConceptCandidateScan({
          credentialSecret,
          generateConceptCandidate,
          log: app.log,
          pool,
          scanId,
        }),
      { scanId },
      "Concept Candidate background task failed",
    );
  };
  const scheduleForAnalysis = (analysisRevisionId: string) => {
    if (scheduledAnalyses.has(analysisRevisionId)) {
      return;
    }

    scheduledAnalyses.add(analysisRevisionId);
    discoveryTail = queueSerialBackground(
      discoveryTail,
      async () => {
        try {
          await processAutomaticConceptDiscovery({
            analysisRevisionId,
            pool,
            scheduleCandidateScan: schedule,
            scheduleSemanticIndex,
          });
        } finally {
          scheduledAnalyses.delete(analysisRevisionId);
        }
      },
      { analysisRevisionId },
      "Automatic Concept discovery failed",
    );
  };
  const schedulePending = () =>
    track(
      pool
        .query<{ analysis_revision_id: string }>(
          `SELECT analysis_revision_id
             FROM concept_candidate_discovery_queue
            WHERE processed_at IS NULL
            ORDER BY enqueued_at, analysis_revision_id`,
        )
        .then((pending) => {
          pending.rows.forEach(({ analysis_revision_id }) =>
            scheduleForAnalysis(analysis_revision_id),
          );
        }),
    );
  const settle = async () => {
    while (backgroundWork.size > 0) {
      await Promise.all([...backgroundWork]);
    }
  };

  app.addHook("onReady", async () => {
    await pool.query(
      `UPDATE concept_candidate_scans
          SET status = 'FAILED',
              outcome = NULL,
              outcome_reason = NULL,
              failure_code = 'SYSTEM_INTERRUPTED',
              failure_message = '服务进程终止，Concept Candidate 扫描未完成，请重试。',
              started_at = COALESCE(started_at, clock_timestamp()),
              completed_at = clock_timestamp()
        WHERE status IN ('QUEUED', 'RUNNING')`,
    );
    await schedulePending();
  });

  app.post("/api/v1/concept-candidate-discovery/full", async (_request, reply) => {
    const configuration = await readActiveTextConfiguration(pool);

    if (!configuration) {
      return reply.code(409).send({
        error: {
          code: "MODEL_CONFIG_REQUIRED",
          message: "请先启用完整模型配置，再执行全量 Concept 发现。",
        },
      });
    }

    const result = await pool.query<{
      covered_count: number;
      enqueued_count: number;
    }>(
      `WITH eligible AS MATERIALIZED (
         SELECT DISTINCT analysis.id
           FROM ai_analysis_revisions AS analysis
           INNER JOIN records AS record
             ON record.current_analysis_revision_id = analysis.id
            AND record.archived_at IS NULL
          WHERE analysis.status = 'ACTIVE'
       ), inserted AS (
         INSERT INTO concept_candidate_discovery_queue (analysis_revision_id)
         SELECT eligible.id
           FROM eligible
          WHERE NOT EXISTS (
            SELECT 1
              FROM concept_candidate_scans AS scan
             WHERE scan.trigger_analysis_revision_id = eligible.id
          )
         ON CONFLICT (analysis_revision_id) DO NOTHING
         RETURNING analysis_revision_id
       )
       SELECT (SELECT count(*)::integer FROM inserted) AS enqueued_count,
              ((SELECT count(*) FROM eligible) -
               (SELECT count(*) FROM inserted))::integer AS covered_count`,
    );
    const counts = result.rows[0] ?? {
      covered_count: 0,
      enqueued_count: 0,
    };

    await schedulePending();
    return reply.code(202).send({
      coveredCount: counts.covered_count,
      enqueuedCount: counts.enqueued_count,
    });
  });

  app.post<{ Body: unknown }>(
    "/api/v1/concept-candidate-scans",
    async (request, reply) => {
      if (!isCreateScanBody(request.body)) {
        return invalidScanInput(reply);
      }

      const knowledgePointIds = request.body.knowledgePointIds;
      const points = await readCurrentCandidatePoints(pool, knowledgePointIds);
      const pointsById = new Map(points.map((point) => [point.id, point]));
      const orderedPoints = knowledgePointIds.flatMap((id) => {
        const point = pointsById.get(id);

        return point ? [point] : [];
      });

      if (orderedPoints.length !== knowledgePointIds.length) {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_INPUT_STALE",
            message: "只能扫描当前生效、已发布且未排除的知识点。",
          },
        });
      }

      const configuration = await readActiveTextConfiguration(pool);

      if (!configuration) {
        return reply.code(409).send({
          error: {
            code: "MODEL_CONFIG_REQUIRED",
            message: "请先启用完整模型配置，再生成 Concept Candidate。",
          },
        });
      }

      const scanId = await createCandidateScan(
        pool,
        orderedPoints,
        configuration,
        {},
      );
      const scan = await readConceptCandidateScan(pool, scanId);

      if (!scan) {
        throw new Error("Created Concept Candidate Scan could not be read");
      }

      schedule(scanId);
      return reply
        .code(202)
        .header("location", `/api/v1/concept-candidate-scans/${scanId}`)
        .send({ scan });
    },
  );

  app.get<{ Querystring: { scope?: string } }>(
    "/api/v1/concept-candidate-scans",
    async (request, reply) => {
      const scope = request.query.scope ?? "attention";

      if (scope !== "all" && scope !== "attention") {
        return reply.code(422).send({
          error: {
            code: "CONCEPT_CANDIDATE_QUERY_INVALID",
            message: "Concept Candidate 列表筛选无效。",
          },
        });
      }

      const result = await pool.query<{ id: string }>(
        `SELECT scan.id
           FROM concept_candidate_scans AS scan
           LEFT JOIN concept_candidates AS candidate
             ON candidate.scan_id = scan.id
          WHERE $1 = 'all'
             OR scan.status IN ('QUEUED', 'RUNNING', 'FAILED')
             OR candidate.review_status = 'PENDING'
          ORDER BY scan.created_at DESC, scan.id DESC
          LIMIT 100`,
        [scope],
      );
      const items = await Promise.all(
        result.rows.map(({ id }) => readConceptCandidateScan(pool, id)),
      );

      return { items: items.flatMap((scan) => (scan ? [scan] : [])) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/concept-candidate-scans/:id",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return candidateScanNotFound(reply);
      }

      const scan = await readConceptCandidateScan(pool, request.params.id);

      if (!scan) {
        return candidateScanNotFound(reply);
      }

      return { scan };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/concept-candidate-scans/:id/retry",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return candidateScanNotFound(reply);
      }

      const snapshots = await readCandidatePointSnapshots(pool, request.params.id);

      if (snapshots.length === 0) {
        return candidateScanNotFound(reply);
      }

      if (await candidateInputsStale(pool, snapshots)) {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_STALE",
            message:
              "扫描输入已经变化，不能重试；后续知识生效时系统会重新自动发现。",
          },
        });
      }

      const retried = await pool.query<{ id: string }>(
        `UPDATE concept_candidate_scans
            SET status = 'QUEUED',
                outcome = NULL,
                outcome_reason = NULL,
                attempt_count = attempt_count + 1,
                failure_code = NULL,
                failure_message = NULL,
                started_at = NULL,
                completed_at = NULL
          WHERE id = $1
            AND status = 'FAILED'
            AND attempt_count < 2
        RETURNING id`,
        [request.params.id],
      );

      if (!retried.rows[0]) {
        const existing = await pool.query(
          "SELECT 1 FROM concept_candidate_scans WHERE id = $1",
          [request.params.id],
        );

        if (!existing.rows[0]) {
          return candidateScanNotFound(reply);
        }

        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_NOT_RETRYABLE",
            message: "只有首次失败且输入未变化的扫描可以重试。",
          },
        });
      }

      const scan = await readConceptCandidateScan(pool, request.params.id);

      if (!scan) {
        throw new Error("Retried Concept Candidate Scan could not be read");
      }

      schedule(request.params.id);
      return reply.code(202).send({ scan });
    },
  );

  app.post<{ Body: unknown; Params: { id: string } }>(
    "/api/v1/concept-candidates/:id/accept",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return candidateNotFound(reply);
      }

      if (!isAcceptCandidateBody(request.body)) {
        return invalidCandidateDecision(reply);
      }

      const name = request.body.name.trim();
      const normalizedName = normalizeConceptName(name);
      const description = request.body.description.trim();
      const knowledgePointIds = request.body.knowledgePointIds;

      if (!normalizedName || !description) {
        return invalidCandidateDecision(reply);
      }

      const accepted = await acceptConceptCandidate(pool, {
        candidateId: request.params.id,
        description,
        knowledgePointIds,
        name,
        normalizedName,
      });

      if (accepted.status === "not_found") {
        return candidateNotFound(reply);
      }

      if (accepted.status === "not_pending") {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_ALREADY_DECIDED",
            message: "这个 Concept Candidate 已经完成审查。",
          },
        });
      }

      if (accepted.status === "stale") {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_STALE",
            message:
              "候选输入已经变化，不能直接确认；后续知识生效时系统会重新自动发现。",
          },
        });
      }

      if (accepted.status === "members_invalid") {
        return invalidCandidateDecision(reply);
      }

      if (accepted.status === "name_conflict") {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_NAME_CONFLICT",
            message: "已存在同名 Concept，请修改候选名称。",
            details: { existingConcept: accepted.existingConcept },
          },
        });
      }

      if (accepted.status !== "accepted") {
        throw new Error("Unhandled Concept Candidate acceptance result");
      }

      const [scan, concept] = await Promise.all([
        readConceptCandidateScan(pool, accepted.scanId),
        readConceptDetail(pool, accepted.conceptId),
      ]);

      if (!scan?.candidate || !concept) {
        throw new Error("Accepted Concept Candidate could not be read");
      }

      return reply
        .code(201)
        .header("location", `/api/v1/concepts/${accepted.conceptId}`)
        .send({ detail: { candidate: scan.candidate, concept } });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/concept-candidates/:id/reject",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return candidateNotFound(reply);
      }

      const rejected = await pool.query<{ scan_id: string }>(
        `UPDATE concept_candidates
            SET review_status = 'REJECTED',
                decided_at = clock_timestamp()
          WHERE id = $1 AND review_status = 'PENDING'
        RETURNING scan_id`,
        [request.params.id],
      );
      const row = rejected.rows[0];

      if (!row) {
        const existing = await pool.query(
          "SELECT 1 FROM concept_candidates WHERE id = $1",
          [request.params.id],
        );

        if (!existing.rows[0]) {
          return candidateNotFound(reply);
        }

        return reply.code(409).send({
          error: {
            code: "CONCEPT_CANDIDATE_ALREADY_DECIDED",
            message: "这个 Concept Candidate 已经完成审查。",
          },
        });
      }

      const scan = await readConceptCandidateScan(pool, row.scan_id);

      if (!scan) {
        throw new Error("Rejected Concept Candidate could not be read");
      }

      return { scan };
    },
  );

  return { scheduleForAnalysis, schedulePending, settle };
}

async function processAutomaticConceptDiscovery(options: {
  analysisRevisionId: string;
  pool: Pool;
  scheduleCandidateScan: (scanId: string) => void;
  scheduleSemanticIndex: () => Promise<void>;
}): Promise<void> {
  const {
    analysisRevisionId,
    pool,
    scheduleCandidateScan,
    scheduleSemanticIndex,
  } = options;
  const queueEntry = await pool.query(
    `SELECT 1
       FROM concept_candidate_discovery_queue
      WHERE analysis_revision_id = $1
        AND processed_at IS NULL`,
    [analysisRevisionId],
  );

  if (!queueEntry.rows[0]) {
    return;
  }

  const existing = await pool.query<{ id: string }>(
    `SELECT id
       FROM concept_candidate_scans
      WHERE trigger_analysis_revision_id = $1`,
    [analysisRevisionId],
  );

  if (existing.rows[0]) {
    await markConceptDiscoveryProcessed(pool, analysisRevisionId);
    return;
  }

  await scheduleSemanticIndex();
  const [configuration, seedResult] = await Promise.all([
    readActiveTextConfiguration(pool),
    pool.query<{ id: string }>(
      `SELECT point.id
         FROM ai_analysis_revisions AS analysis
         INNER JOIN records AS record
           ON record.current_analysis_revision_id = analysis.id
          AND record.archived_at IS NULL
         INNER JOIN knowledge_points AS point
           ON point.analysis_revision_id = analysis.id
          AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          AND point.usage_status = 'INCLUDED'
        WHERE analysis.id = $1
          AND analysis.status = 'ACTIVE'
        ORDER BY point.position`,
      [analysisRevisionId],
    ),
  ]);
  const seedIds = seedResult.rows.map(({ id }) => id);

  if (!configuration) {
    return;
  }

  if (seedIds.length === 0) {
    await markConceptDiscoveryProcessed(pool, analysisRevisionId);
    return;
  }

  const recall = await recallConceptKnowledgePoints({
    configurationVersion: configuration.version,
    pool,
    seedKnowledgePointIds: seedIds,
  });

  if (!recall.embeddingReady) {
    return;
  }

  const currentPoints = await readCurrentCandidatePoints(
    pool,
    recall.knowledgePointIds,
  );
  const byId = new Map(currentPoints.map((point) => [point.id, point]));
  const orderedPoints = recall.knowledgePointIds.flatMap((id) => {
    const point = byId.get(id);

    return point ? [point] : [];
  });

  if (orderedPoints.length !== recall.knowledgePointIds.length) {
    return;
  }

  const shouldGenerate = orderedPoints.length >= 2;
  const scanId = await createCandidateScan(pool, orderedPoints, configuration, {
    triggerAnalysisRevisionId: analysisRevisionId,
    ...(shouldGenerate
      ? {}
      : {
          noSuggestionReason:
            "全局召回没有找到足以与新增知识共同形成 Concept 的当前知识点。",
        }),
  });

  await markConceptDiscoveryProcessed(pool, analysisRevisionId);

  if (shouldGenerate) {
    scheduleCandidateScan(scanId);
  }
}

export async function enqueueConceptCandidateDiscovery(
  client: Pool | PoolClient,
  analysisRevisionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO concept_candidate_discovery_queue (analysis_revision_id)
     VALUES ($1)
     ON CONFLICT (analysis_revision_id) DO NOTHING`,
    [analysisRevisionId],
  );
}

async function markConceptDiscoveryProcessed(
  pool: Pool,
  analysisRevisionId: string,
): Promise<void> {
  await pool.query(
    `UPDATE concept_candidate_discovery_queue
        SET processed_at = clock_timestamp()
      WHERE analysis_revision_id = $1
        AND processed_at IS NULL`,
    [analysisRevisionId],
  );
}

async function processConceptCandidateScan(options: {
  credentialSecret: string;
  generateConceptCandidate: ConceptCandidateGenerator;
  log: FastifyInstance["log"];
  pool: Pool;
  scanId: string;
}): Promise<void> {
  const { credentialSecret, generateConceptCandidate, log, pool, scanId } =
    options;
  const claimed = await pool.query<{
    model_configuration_version: number;
  }>(
    `UPDATE concept_candidate_scans
        SET status = 'RUNNING',
            started_at = clock_timestamp()
      WHERE id = $1 AND status = 'QUEUED'
    RETURNING model_configuration_version`,
    [scanId],
  );
  const task = claimed.rows[0];

  if (!task) {
    return;
  }

  try {
    const [configuration, points] = await Promise.all([
      readTextConfiguration(pool, task.model_configuration_version),
      readCandidatePointSnapshots(pool, scanId),
    ]);

    if (!configuration || points.length < 2) {
      throw new Error("Candidate task input or model configuration is missing");
    }

    const generatorPoints = points.map(publicGeneratorPoint);
    const timeoutMs = conceptCandidateTimeoutMs(generatorPoints);
    const generated = await generateValidatedCandidate(
      generateConceptCandidate,
      {
        apiKey: decryptCredential(
          configuration.text_credential_ciphertext,
          credentialSecret,
        ),
        baseUrl: configuration.text_base_url,
        configurationVersion: configuration.version,
        model: configuration.text_model,
        points: generatorPoints,
      },
      Date.now() + timeoutMs,
    );

    await completeCandidateScan(pool, scanId, points, generated);
  } catch (error) {
    log.error({ err: error, scanId }, "Concept Candidate Scan failed");
    await pool.query(
      `UPDATE concept_candidate_scans
          SET status = 'FAILED',
              outcome = NULL,
              outcome_reason = NULL,
              failure_code = 'CONCEPT_CANDIDATE_GENERATION_FAILED',
              failure_message = 'Concept Candidate 未能生成；输入快照仍保留，可以重试。',
              completed_at = clock_timestamp()
        WHERE id = $1 AND status = 'RUNNING'`,
      [scanId],
    );
  }
}

async function createCandidateScan(
  pool: Pool,
  points: CurrentCandidatePoint[],
  configuration: TextConfiguration,
  options: {
    noSuggestionReason?: string;
    triggerAnalysisRevisionId?: string;
  },
): Promise<string> {
  const client = await pool.connect();
  const scanId = randomUUID();
  const status = options.noSuggestionReason ? "SUCCEEDED" : "QUEUED";
  const snapshots = points.map((point, index) => ({
    ...point,
    contentFingerprint: candidatePointFingerprint(point),
    inputId: randomUUID(),
    position: index + 1,
  }));

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO concept_candidate_scans
         (id, input_fingerprint, input_count, model_configuration_version,
          text_model, trigger_analysis_revision_id, status, outcome,
          outcome_reason, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7::concept_candidate_scan_status,
               $8::concept_candidate_scan_outcome, $9,
               CASE WHEN $7 = 'SUCCEEDED' THEN clock_timestamp() END,
               CASE WHEN $7 = 'SUCCEEDED' THEN clock_timestamp() END)`,
      [
        scanId,
        candidateInputFingerprint(snapshots),
        snapshots.length,
        configuration.version,
        configuration.text_model,
        options.triggerAnalysisRevisionId ?? null,
        status,
        options.noSuggestionReason ? "NO_SUGGESTION" : null,
        options.noSuggestionReason ?? null,
      ],
    );

    for (const snapshot of snapshots) {
      await client.query(
        `INSERT INTO concept_candidate_inputs
           (id, scan_id, knowledge_point_id, record_id, position,
            record_title_snapshot, title_snapshot, body_snapshot,
            evidence_snapshot, content_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          snapshot.inputId,
          scanId,
          snapshot.id,
          snapshot.recordId,
          snapshot.position,
          snapshot.recordTitle,
          snapshot.title,
          snapshot.body,
          JSON.stringify(snapshot.evidence),
          snapshot.contentFingerprint,
        ],
      );
    }

    await client.query("COMMIT");
    return scanId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function completeCandidateScan(
  pool: Pool,
  scanId: string,
  points: CandidatePointSnapshot[],
  generated: GeneratedConceptCandidate,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const locked = await client.query<{ input_fingerprint: string }>(
      `SELECT input_fingerprint
         FROM concept_candidate_scans
        WHERE id = $1 AND status = 'RUNNING'
        FOR UPDATE`,
      [scanId],
    );
    const scan = locked.rows[0];

    if (!scan) {
      await client.query("ROLLBACK");
      return;
    }

    if (generated.candidate === null) {
      await client.query(
        `UPDATE concept_candidate_scans
            SET status = 'SUCCEEDED',
                outcome = 'NO_SUGGESTION',
                outcome_reason = $2,
                completed_at = clock_timestamp()
          WHERE id = $1`,
        [scanId, generated.reason.trim()],
      );
      await client.query("COMMIT");
      return;
    }

    const candidate = generated.candidate;
    const normalizedName = normalizeConceptName(candidate.name.trim());
    const fingerprint = candidateFingerprint(candidate, normalizedName);
    const duplicate = await client.query<{ id: string }>(
      `SELECT candidate.id
         FROM concept_candidates AS candidate
         INNER JOIN concept_candidate_scans AS prior_scan
           ON prior_scan.id = candidate.scan_id
        WHERE prior_scan.input_fingerprint = $1
          AND candidate.candidate_fingerprint = $2
          AND prior_scan.id <> $3
        LIMIT 1`,
      [scan.input_fingerprint, fingerprint, scanId],
    );

    if (duplicate.rows[0]) {
      await client.query(
        `UPDATE concept_candidate_scans
            SET status = 'SUCCEEDED',
                outcome = 'DUPLICATE',
                outcome_reason = '相同输入下的等价候选已经进入过审查队列。',
                completed_at = clock_timestamp()
          WHERE id = $1`,
        [scanId],
      );
      await client.query("COMMIT");
      return;
    }

    const candidateId = randomUUID();
    const inputByPointId = new Map(points.map((point) => [point.id, point]));

    await client.query(
      `INSERT INTO concept_candidates
         (id, scan_id, candidate_fingerprint, suggested_name,
          normalized_name, suggested_description, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        candidateId,
        scanId,
        fingerprint,
        candidate.name.trim(),
        normalizedName,
        candidate.description.trim(),
        candidate.reason.trim(),
      ],
    );

    for (const [index, knowledgePointId] of candidate.knowledgePointIds.entries()) {
      const input = inputByPointId.get(knowledgePointId);

      if (!input) {
        throw new Error("Generated Candidate referenced a missing input");
      }

      await client.query(
        `INSERT INTO concept_candidate_members
           (candidate_id, input_id, position)
         VALUES ($1, $2, $3)`,
        [candidateId, input.inputId, index + 1],
      );
    }

    await client.query(
      `UPDATE concept_candidate_scans
          SET status = 'SUCCEEDED',
              outcome = 'CANDIDATE',
              completed_at = clock_timestamp()
        WHERE id = $1`,
      [scanId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type AcceptResult =
  | { status: "members_invalid" | "not_found" | "not_pending" | "stale" }
  | {
      existingConcept: { id: string; name: string };
      status: "name_conflict";
    }
  | { conceptId: string; scanId: string; status: "accepted" };

async function acceptConceptCandidate(
  pool: Pool,
  input: {
    candidateId: string;
    description: string;
    knowledgePointIds: string[];
    name: string;
    normalizedName: string;
  },
): Promise<AcceptResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      review_status: "ACCEPTED" | "PENDING" | "REJECTED";
      scan_id: string;
    }>(
      `SELECT candidate.scan_id, candidate.review_status
         FROM concept_candidates AS candidate
        WHERE candidate.id = $1
        FOR UPDATE`,
      [input.candidateId],
    );
    const candidate = locked.rows[0];

    if (!candidate) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }

    if (candidate.review_status !== "PENDING") {
      await client.query("ROLLBACK");
      return { status: "not_pending" };
    }

    const snapshots = await readCandidatePointSnapshots(client, candidate.scan_id);

    if (await candidateInputsStale(client, snapshots)) {
      await client.query("ROLLBACK");
      return { status: "stale" };
    }

    const allowedIds = new Set(snapshots.map(({ id }) => id));

    if (
      input.knowledgePointIds.length < 2 ||
      input.knowledgePointIds.length > 12 ||
      new Set(input.knowledgePointIds).size !== input.knowledgePointIds.length ||
      input.knowledgePointIds.some((id) => !allowedIds.has(id))
    ) {
      await client.query("ROLLBACK");
      return { status: "members_invalid" };
    }

    const existing = await client.query<{ display_name: string; id: string }>(
      `SELECT concept.id, revision.display_name
         FROM concepts AS concept
         INNER JOIN concept_revisions AS revision
           ON revision.id = concept.current_revision_id
        WHERE concept.normalized_name = $1`,
      [input.normalizedName],
    );

    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return {
        status: "name_conflict",
        existingConcept: {
          id: existing.rows[0].id,
          name: existing.rows[0].display_name,
        },
      };
    }

    const currentPoints = await lockCurrentKnowledgePoints(
      client,
      input.knowledgePointIds,
    );

    if (currentPoints.size !== input.knowledgePointIds.length) {
      await client.query("ROLLBACK");
      return { status: "stale" };
    }

    const conceptId = randomUUID();
    const revisionId = randomUUID();

    await client.query(
      `INSERT INTO concepts (id, current_revision_id, normalized_name)
       VALUES ($1, $2, $3)`,
      [conceptId, revisionId, input.normalizedName],
    );
    await client.query(
      `INSERT INTO concept_revisions
         (id, concept_id, revision_number, display_name, normalized_name,
          description)
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        revisionId,
        conceptId,
        input.name,
        input.normalizedName,
        input.description,
      ],
    );
    await client.query(
      `INSERT INTO concept_activity
         (concept_id, sequence_number, kind, revision_id)
       VALUES ($1, 1, 'CREATED', $2)`,
      [conceptId, revisionId],
    );

    const inputByPointId = new Map(snapshots.map((point) => [point.id, point]));

    for (const [index, knowledgePointId] of input.knowledgePointIds.entries()) {
      const snapshot = inputByPointId.get(knowledgePointId);
      const membershipId = randomUUID();

      if (!snapshot) {
        throw new Error("Confirmed Candidate input disappeared");
      }

      await client.query(
        `INSERT INTO concept_memberships
           (id, concept_id, knowledge_point_id)
         VALUES ($1, $2, $3)`,
        [membershipId, conceptId, knowledgePointId],
      );
      await client.query(
        `INSERT INTO concept_activity
           (concept_id, sequence_number, kind, membership_id)
         VALUES ($1, $2, 'MEMBER_ADDED', $3)`,
        [conceptId, index + 2, membershipId],
      );
      await client.query(
        `INSERT INTO concept_candidate_decision_members
           (candidate_id, input_id, concept_membership_id, position)
         VALUES ($1, $2, $3, $4)`,
        [input.candidateId, snapshot.inputId, membershipId, index + 1],
      );
    }

    await client.query(
      `UPDATE concept_candidates
          SET review_status = 'ACCEPTED',
              accepted_concept_id = $2,
              confirmed_name = $3,
              confirmed_description = $4,
              decided_at = clock_timestamp()
        WHERE id = $1`,
      [input.candidateId, conceptId, input.name, input.description],
    );
    await client.query("COMMIT");
    return { status: "accepted", conceptId, scanId: candidate.scan_id };
  } catch (error) {
    await client.query("ROLLBACK");

    if (isConceptNameUniqueViolation(error)) {
      const existing = await pool.query<{ display_name: string; id: string }>(
        `SELECT concept.id, revision.display_name
           FROM concepts AS concept
           INNER JOIN concept_revisions AS revision
             ON revision.id = concept.current_revision_id
          WHERE concept.normalized_name = $1`,
        [input.normalizedName],
      );

      if (existing.rows[0]) {
        return {
          status: "name_conflict",
          existingConcept: {
            id: existing.rows[0].id,
            name: existing.rows[0].display_name,
          },
        };
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

async function readConceptCandidateScan(pool: Pool | PoolClient, scanId: string) {
  const [scanResult, inputResult, candidateResult] = await Promise.all([
    pool.query<ScanRow>(
      `SELECT id, input_fingerprint, input_count, model_configuration_version,
              text_model, trigger_analysis_revision_id, status, outcome,
              outcome_reason, attempt_count,
              failure_code, failure_message, created_at, started_at, completed_at
         FROM concept_candidate_scans
        WHERE id = $1`,
      [scanId],
    ),
    pool.query<CandidateInputRow>(
      `SELECT id, knowledge_point_id, record_id, position,
              record_title_snapshot, title_snapshot, body_snapshot,
              evidence_snapshot, content_fingerprint
         FROM concept_candidate_inputs
        WHERE scan_id = $1
        ORDER BY position`,
      [scanId],
    ),
    pool.query<CandidateRow>(
      `SELECT id, suggested_name, suggested_description, reason,
              review_status, accepted_concept_id, confirmed_name,
              confirmed_description, decided_at, created_at
         FROM concept_candidates
        WHERE scan_id = $1`,
      [scanId],
    ),
  ]);
  const scan = scanResult.rows[0];

  if (!scan) {
    return null;
  }

  const inputs = inputResult.rows.map(candidateInputFromRow);
  const candidate = candidateResult.rows[0];
  const stale = await candidateInputsStale(pool, inputs);
  const seedIds = scan.trigger_analysis_revision_id
    ? new Set(
        (
          await pool.query<{ id: string }>(
            `SELECT id
               FROM knowledge_points
              WHERE analysis_revision_id = $1`,
            [scan.trigger_analysis_revision_id],
          )
        ).rows.map(({ id }) => id),
      )
    : new Set<string>();
  let publicCandidate = null;

  if (candidate) {
    const memberResult = await pool.query<{ knowledge_point_id: string }>(
      `SELECT input.knowledge_point_id
         FROM concept_candidate_members AS member
         INNER JOIN concept_candidate_inputs AS input ON input.id = member.input_id
        WHERE member.candidate_id = $1
        ORDER BY member.position`,
      [candidate.id],
    );

    publicCandidate = {
      id: candidate.id,
      name: candidate.suggested_name,
      description: candidate.suggested_description,
      reason: candidate.reason,
      memberIds: memberResult.rows.map(({ knowledge_point_id }) => knowledge_point_id),
      reviewStatus: candidate.review_status.toLowerCase() as Lowercase<
        CandidateRow["review_status"]
      >,
      canConfirm: candidate.review_status === "PENDING" && !stale,
      acceptedConceptId: candidate.accepted_concept_id,
      confirmedName: candidate.confirmed_name,
      confirmedDescription: candidate.confirmed_description,
      decidedAt: nullableIsoString(candidate.decided_at),
      createdAt: asIsoString(candidate.created_at),
    };
  }

  return {
    id: scan.id,
    origin: scan.trigger_analysis_revision_id
      ? ("automatic" as const)
      : ("manual" as const),
    triggerAnalysisRevisionId: scan.trigger_analysis_revision_id,
    status: scan.status.toLowerCase() as Lowercase<ScanRow["status"]>,
    outcome: scan.outcome
      ? (scan.outcome.toLowerCase() as Lowercase<NonNullable<ScanRow["outcome"]>>)
      : null,
    outcomeReason: scan.outcome_reason,
    attemptCount: scan.attempt_count,
    canRetry: scan.status === "FAILED" && scan.attempt_count < 2 && !stale,
    stale,
    failure:
      scan.failure_code && scan.failure_message
        ? { code: scan.failure_code, message: scan.failure_message }
        : null,
    model: {
      name: scan.text_model,
      configurationVersion: scan.model_configuration_version,
    },
    createdAt: asIsoString(scan.created_at),
    startedAt: nullableIsoString(scan.started_at),
    completedAt: nullableIsoString(scan.completed_at),
    inputs: inputs.map((point) => ({
      id: point.id,
      seed: seedIds.has(point.id),
      recordId: point.recordId,
      recordTitle: point.recordTitle,
      title: point.title,
      body: point.body,
      evidence: point.evidence,
    })),
    candidate: publicCandidate,
  };
}

async function readCandidatePointSnapshots(
  pool: Pool | PoolClient,
  scanId: string,
): Promise<CandidatePointSnapshot[]> {
  const result = await pool.query<CandidateInputRow>(
    `SELECT id, knowledge_point_id, record_id, position,
            record_title_snapshot, title_snapshot, body_snapshot,
            evidence_snapshot, content_fingerprint
       FROM concept_candidate_inputs
      WHERE scan_id = $1
      ORDER BY position`,
    [scanId],
  );

  return result.rows.map(candidateInputFromRow);
}

function candidateInputFromRow(row: CandidateInputRow): CandidatePointSnapshot {
  return {
    inputId: row.id,
    id: row.knowledge_point_id,
    recordId: row.record_id,
    position: row.position,
    recordTitle: row.record_title_snapshot,
    title: row.title_snapshot,
    body: row.body_snapshot,
    evidence: parseEvidenceSnapshot(row.evidence_snapshot),
    contentFingerprint: row.content_fingerprint,
  };
}

async function readCurrentCandidatePoints(
  pool: Pool | PoolClient,
  knowledgePointIds: string[],
): Promise<CurrentCandidatePoint[]> {
  if (knowledgePointIds.length === 0) {
    return [];
  }

  const pointResult = await pool.query<{
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
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = analysis.id
        AND record.archived_at IS NULL
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = analysis.id
      WHERE point.id = ANY($1::uuid[])
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      ORDER BY point.id`,
    [knowledgePointIds],
  );
  const evidenceResult = await pool.query<{
    end_offset: number;
    fragment_revision_id: string;
    id: string;
    knowledge_point_id: string;
    position: number;
    quote: string;
    start_offset: number;
  }>(
    `SELECT id, knowledge_point_id, fragment_revision_id, position,
            start_offset, end_offset, quote
       FROM evidence_spans
      WHERE knowledge_point_id = ANY($1::uuid[])
      ORDER BY knowledge_point_id, position`,
    [knowledgePointIds],
  );
  const evidenceByPoint = new Map<string, EvidenceSnapshot[]>();

  for (const evidence of evidenceResult.rows) {
    const items = evidenceByPoint.get(evidence.knowledge_point_id) ?? [];

    items.push({
      id: evidence.id,
      fragmentRevisionId: evidence.fragment_revision_id,
      position: evidence.position,
      startOffset: evidence.start_offset,
      endOffset: evidence.end_offset,
      quote: evidence.quote,
    });
    evidenceByPoint.set(evidence.knowledge_point_id, items);
  }

  return pointResult.rows.flatMap((row) => {
    const evidence = evidenceByPoint.get(row.id) ?? [];

    return evidence.length > 0
      ? [
          {
            id: row.id,
            recordId: row.record_id,
            recordTitle: row.record_title ?? firstNonEmptyLine(row.record_source),
            title: row.title,
            body: row.body,
            evidence,
          },
        ]
      : [];
  });
}

async function candidateInputsStale(
  pool: Pool | PoolClient,
  snapshots: CandidatePointSnapshot[],
): Promise<boolean> {
  const current = await readCurrentCandidatePoints(
    pool,
    snapshots.map(({ id }) => id),
  );
  const currentById = new Map(current.map((point) => [point.id, point]));

  return snapshots.some((snapshot) => {
    const point = currentById.get(snapshot.id);

    return !point || candidatePointFingerprint(point) !== snapshot.contentFingerprint;
  });
}

async function lockCurrentKnowledgePoints(
  client: PoolClient,
  knowledgePointIds: string[],
): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    `SELECT point.id
       FROM knowledge_points AS point
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = analysis.id
        AND record.archived_at IS NULL
      WHERE point.id = ANY($1::uuid[])
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      FOR SHARE OF point, analysis, record`,
    [knowledgePointIds],
  );

  return new Set(result.rows.map(({ id }) => id));
}

async function generateValidatedCandidate(
  generator: ConceptCandidateGenerator,
  input: GenerateConceptCandidateInput,
  deadlineAt: number,
): Promise<GeneratedConceptCandidate> {
  const allowedIds = new Set(input.points.map(({ id }) => id));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();

    if (remainingMs <= 0) {
      throw new Error("Concept Candidate generation exceeded its time budget");
    }

    const generated = await generator({ ...input, timeoutMs: remainingMs });

    if (validGeneratedCandidate(generated, allowedIds)) {
      return generated;
    }
  }

  throw new Error("Concept Candidate response failed validation twice");
}

function validGeneratedCandidate(
  value: unknown,
  allowedIds: Set<string>,
): value is GeneratedConceptCandidate {
  if (!isObject(value)) {
    return false;
  }

  if (value.candidate === null) {
    return nonEmptyString(value.reason);
  }

  if (!isObject(value.candidate)) {
    return false;
  }

  const ids = value.candidate.knowledgePointIds;

  return (
    nonEmptyString(value.candidate.name) &&
    Boolean(normalizeConceptName(value.candidate.name.trim())) &&
    nonEmptyString(value.candidate.description) &&
    nonEmptyString(value.candidate.reason) &&
    Array.isArray(ids) &&
    ids.length >= 2 &&
    ids.length <= 12 &&
    ids.every((id) => typeof id === "string" && allowedIds.has(id)) &&
    new Set(ids).size === ids.length
  );
}

function publicGeneratorPoint(
  point: CandidatePointSnapshot,
): ConceptCandidatePointInput {
  return {
    id: point.id,
    title: point.title,
    body: point.body,
    evidence: point.evidence.map((evidence) => ({
      id: evidence.id,
      quote: evidence.quote,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
    })),
  };
}

function candidatePointFingerprint(
  point: Pick<CurrentCandidatePoint, "body" | "evidence" | "id" | "title">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: point.id,
        title: normalizeCandidateText(point.title),
        body: normalizeCandidateText(point.body),
        evidence: point.evidence.map((evidence) => ({
          id: evidence.id,
          fragmentRevisionId: evidence.fragmentRevisionId,
          position: evidence.position,
          startOffset: evidence.startOffset,
          endOffset: evidence.endOffset,
          quote: evidence.quote,
        })),
      }),
    )
    .digest("hex");
}

function candidateInputFingerprint(
  points: Array<Pick<CandidatePointSnapshot, "contentFingerprint" | "id">>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        points.map((point) => ({
          id: point.id,
          contentFingerprint: point.contentFingerprint,
        })),
      ),
    )
    .digest("hex");
}

function candidateFingerprint(
  candidate: NonNullable<GeneratedConceptCandidate["candidate"]>,
  normalizedName: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: normalizedName,
        description: normalizeCandidateText(candidate.description),
        knowledgePointIds: [...candidate.knowledgePointIds].sort(),
      }),
    )
    .digest("hex");
}

function normalizeCandidateText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function parseEvidenceSnapshot(value: unknown): EvidenceSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("Concept Candidate evidence snapshot is invalid");
  }

  return value.map((entry) => {
    if (
      !isObject(entry) ||
      !UUID_PATTERN.test(String(entry.id)) ||
      !UUID_PATTERN.test(String(entry.fragmentRevisionId)) ||
      !Number.isInteger(entry.position) ||
      !Number.isInteger(entry.startOffset) ||
      !Number.isInteger(entry.endOffset) ||
      typeof entry.quote !== "string"
    ) {
      throw new Error("Concept Candidate evidence snapshot is invalid");
    }

    return {
      id: String(entry.id),
      fragmentRevisionId: String(entry.fragmentRevisionId),
      position: Number(entry.position),
      startOffset: Number(entry.startOffset),
      endOffset: Number(entry.endOffset),
      quote: entry.quote,
    };
  });
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

async function readTextConfiguration(
  pool: Pool,
  version: number,
): Promise<TextConfiguration | null> {
  const result = await pool.query<TextConfiguration>(
    `SELECT version, text_base_url, text_model, text_credential_ciphertext
       FROM model_configurations
      WHERE version = $1`,
    [version],
  );

  return result.rows[0] ?? null;
}

function isCreateScanBody(
  value: unknown,
): value is { knowledgePointIds: string[] } {
  return (
    isObject(value) &&
    Array.isArray(value.knowledgePointIds) &&
    value.knowledgePointIds.length >= 2 &&
    value.knowledgePointIds.length <= 12 &&
    value.knowledgePointIds.every(
      (id) => typeof id === "string" && UUID_PATTERN.test(id),
    ) &&
    new Set(value.knowledgePointIds).size === value.knowledgePointIds.length
  );
}

function isAcceptCandidateBody(
  value: unknown,
): value is {
  description: string;
  knowledgePointIds: string[];
  name: string;
} {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.knowledgePointIds) &&
    value.knowledgePointIds.every(
      (id) => typeof id === "string" && UUID_PATTERN.test(id),
    )
  );
}

function invalidScanInput(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "CONCEPT_CANDIDATE_INPUT_INVALID",
      message: "请选择 2–12 个不同的当前知识点。",
    },
  });
}

function invalidCandidateDecision(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "CONCEPT_CANDIDATE_DECISION_INVALID",
      message: "请填写名称和描述，并从候选输入中选择至少两个知识点。",
    },
  });
}

function candidateScanNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_CANDIDATE_SCAN_NOT_FOUND",
      message: "没有找到这次 Concept Candidate 扫描。",
    },
  });
}

function candidateNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_CANDIDATE_NOT_FOUND",
      message: "没有找到这个 Concept Candidate。",
    },
  });
}

function isConceptNameUniqueViolation(error: unknown): boolean {
  return (
    isObject(error) &&
    error.code === "23505" &&
    error.constraint === "concepts_normalized_name_unique"
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asIsoString(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIsoString(value: Timestamp | null): string | null {
  return value === null ? null : asIsoString(value);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "未命名记录"
  );
}
