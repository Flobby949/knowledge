import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import type { EmbedText } from "./embedding-provider.js";
import { decryptCredential } from "./model-credentials.js";

interface ActiveEmbeddingConfiguration {
  version: number;
  embedding_base_url: string;
  embedding_model: string;
  embedding_credential_ciphertext: string;
}

interface SearchDocument {
  sourceType: "ORIGINAL" | "KNOWLEDGE_POINT" | "OVERVIEW";
  sourceId: string;
  recordId: string;
  text: string;
}

interface DocumentState {
  text: string;
  status: "PENDING" | "READY" | "FAILED";
  hasEmbedding: boolean;
}

export interface SemanticMatch {
  recordId: string;
  score: number;
  sourceId: string;
  sourceType: SearchDocument["sourceType"];
  text: string;
}

export interface SemanticIndexScheduler {
  schedule(options?: { retryFailed?: boolean }): void;
}

export function createSemanticIndexScheduler(options: {
  pool: Pool;
  credentialSecret: string;
  embedText: EmbedText;
}): SemanticIndexScheduler {
  const { pool, credentialSecret, embedText } = options;
  let queued = false;
  let running = false;
  let rerunRequested = false;
  let retryFailedRequested = false;

  function queueDrain(): void {
    if (queued || running) {
      return;
    }

    queued = true;
    setImmediate(() => {
      queued = false;
      void drain().catch(() => undefined);
    });
  }

  async function drain(): Promise<void> {
    if (running) {
      return;
    }

    running = true;

    try {
      while (rerunRequested) {
        rerunRequested = false;
        const retryFailed = retryFailedRequested;

        retryFailedRequested = false;
        const configuration = await readActiveConfiguration(pool);

        if (configuration) {
          await rebuildSemanticIndex({
            pool,
            credentialSecret,
            embedText,
            configuration,
            retryFailed,
          });
        }
      }
    } finally {
      running = false;

      if (rerunRequested) {
        queueDrain();
      }
    }
  }

  return {
    schedule(scheduleOptions) {
      rerunRequested = true;
      retryFailedRequested ||= scheduleOptions?.retryFailed === true;
      queueDrain();
    },
  };
}

export function registerSemanticSearchRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    scheduler: SemanticIndexScheduler;
  },
): void {
  const { pool, scheduler } = options;

  app.get("/api/v1/search-health", async () => ({
    keyword: { status: "ready" },
    semantic: await readSemanticHealth(pool),
  }));

  app.post("/api/v1/search-index/rebuild", async (_request, reply) => {
    const configuration = await readActiveConfiguration(pool);

    if (!configuration) {
      return reply.code(409).send({
        error: {
          code: "MODEL_CONFIG_REQUIRED",
          message: "请先启用完整的模型配置。",
        },
      });
    }

    scheduler.schedule({ retryFailed: true });

    return reply.code(202).send({
      rebuild: {
        status: "queued",
        model: configuration.embedding_model,
        configurationVersion: configuration.version,
      },
    });
  });
}

export async function findSemanticMatches(options: {
  pool: Pool;
  credentialSecret: string;
  embedText: EmbedText;
  query: string;
}): Promise<SemanticMatch[]> {
  const { pool, credentialSecret, embedText, query } = options;
  const configuration = await readActiveConfiguration(pool);

  if (!configuration) {
    return [];
  }

  const documents = await readSearchDocuments(pool);
  const states = await readDocumentStates(pool, configuration.version);
  const ready = readyDocumentIds(documents, states);

  if (documents.length === 0 || ready.size === 0) {
    return [];
  }

  if (
    ready.size < documents.length &&
    (await semanticSearchIsGloballyPaused(pool, configuration.version))
  ) {
    return [];
  }

  let queryVector: number[];

  try {
    queryVector = await embedText({
      text: query,
      purpose: "query",
      baseUrl: configuration.embedding_base_url,
      model: configuration.embedding_model,
      apiKey: decryptCredential(
        configuration.embedding_credential_ciphertext,
        credentialSecret,
      ),
      configurationVersion: configuration.version,
    });
  } catch {
    return [];
  }
  const stored = await pool.query<{
    record_id: string;
    source_type: "ORIGINAL" | "KNOWLEDGE_POINT" | "OVERVIEW";
    source_id: string;
    text_content: string;
    embedding: number[];
  }>(
    `SELECT record_id, source_type, source_id, text_content, embedding
       FROM semantic_embeddings
      WHERE configuration_version = $1`,
    [configuration.version],
  );
  const matches: SemanticMatch[] = [];
  const currentDocuments = new Map(
    documents.map((document) => [documentKey(document), document]),
  );

  for (const row of stored.rows) {
    const key = `${row.source_type}:${row.source_id}`;
    const currentDocument = currentDocuments.get(key);

    if (
      !ready.has(key) ||
      !currentDocument ||
      currentDocument.text !== row.text_content
    ) {
      continue;
    }

    const score = cosineSimilarity(queryVector, row.embedding);
    if (score >= 0.75) {
      matches.push({
        recordId: row.record_id,
        score,
        sourceId: row.source_id,
        sourceType: row.source_type,
        text: row.text_content,
      });
    }
  }

  return matches.sort(
    (left, right) =>
      right.score - left.score ||
      left.recordId.localeCompare(right.recordId) ||
      left.sourceType.localeCompare(right.sourceType) ||
      left.sourceId.localeCompare(right.sourceId),
  );
}

export async function readSemanticHealth(pool: Pool) {
  const configuration = await readActiveConfiguration(pool);
  const documents = await readSearchDocuments(pool);

  if (!configuration) {
    return {
      status: "paused" as const,
      model: "",
      configurationVersion: 0,
      readyDocuments: 0,
      failedDocuments: 0,
      totalDocuments: documents.length,
    };
  }

  const states = await readDocumentStates(pool, configuration.version);
  const readyDocuments = readyDocumentIds(documents, states).size;
  const failedDocuments = documents.filter((document) => {
    const state = states.get(documentKey(document));

    return state?.text === document.text && state.status === "FAILED";
  }).length;
  const globallyPaused = await semanticSearchIsGloballyPaused(
    pool,
    configuration.version,
  );
  const status =
    readyDocuments === documents.length && documents.length > 0
      ? "ready"
      : globallyPaused
        ? "paused"
        : "building";

  return {
    status,
    model: configuration.embedding_model,
    configurationVersion: configuration.version,
    readyDocuments,
    failedDocuments,
    totalDocuments: documents.length,
  };
}

async function rebuildSemanticIndex(options: {
  pool: Pool;
  credentialSecret: string;
  embedText: EmbedText;
  configuration: ActiveEmbeddingConfiguration;
  retryFailed: boolean;
}): Promise<void> {
  const {
    pool,
    credentialSecret,
    embedText,
    configuration,
    retryFailed,
  } = options;
  const documents = await readSearchDocuments(pool);
  const apiKey = decryptCredential(
    configuration.embedding_credential_ciphertext,
    credentialSecret,
  );
  const states = await readDocumentStates(pool, configuration.version);
  const documentsToEmbed = documents.filter((document) => {
    const state = states.get(documentKey(document));

    if (
      !retryFailed &&
      state?.text === document.text &&
      state.status === "FAILED"
    ) {
      return false;
    }

    return !(
      state?.text === document.text &&
      state.status === "READY" &&
      state.hasEmbedding
    );
  });

  await Promise.allSettled(
    documentsToEmbed.map((document) =>
      embedSearchDocument({
        pool,
        embedText,
        configuration,
        apiKey,
        document,
      }),
    ),
  );
  await activateVectorSpaceIfComplete(pool, configuration.version);
}

async function readActiveConfiguration(
  pool: Pool,
): Promise<ActiveEmbeddingConfiguration | undefined> {
  const result = await pool.query<ActiveEmbeddingConfiguration>(
    `SELECT version,
            embedding_base_url,
            embedding_model,
            embedding_credential_ciphertext
       FROM model_configurations
      WHERE state = 'ACTIVE'`,
  );

  return result.rows[0];
}

async function readSearchDocuments(pool: Pool): Promise<SearchDocument[]> {
  const result = await pool.query<{
    source_type: "ORIGINAL" | "KNOWLEDGE_POINT" | "OVERVIEW";
    source_id: string;
    record_id: string;
    text_content: string;
  }>(
    `SELECT 'ORIGINAL'::semantic_source_type AS source_type,
            revision.id AS source_id,
            record.id AS record_id,
            revision.content AS text_content
       FROM records AS record
       INNER JOIN fragment_revisions AS revision
         ON revision.id = record.current_fragment_revision_id
      WHERE record.archived_at IS NULL
      UNION ALL
     SELECT 'OVERVIEW'::semantic_source_type,
            analysis.id,
            record.id,
            COALESCE(overview.title, analysis.title) || E'\n' ||
              COALESCE(overview.summary, analysis.summary)
       FROM records AS record
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = record.current_analysis_revision_id
        AND analysis.status = 'ACTIVE'
       LEFT JOIN record_overview_corrections AS overview
         ON overview.record_id = record.id
        AND overview.analysis_revision_id = analysis.id
      WHERE record.archived_at IS NULL
      UNION ALL
     SELECT 'KNOWLEDGE_POINT'::semantic_source_type,
            point.id,
            point.record_id,
            COALESCE(correction.title, point.ai_title) || E'\n' ||
              COALESCE(correction.body, point.ai_body)
       FROM knowledge_points AS point
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = point.analysis_revision_id
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       LEFT JOIN knowledge_point_corrections AS correction
         ON correction.knowledge_point_id = point.id
      WHERE record.archived_at IS NULL
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      ORDER BY source_type, source_id`,
  );

  return result.rows.map((row) => ({
    sourceType: row.source_type,
    sourceId: row.source_id,
    recordId: row.record_id,
    text: row.text_content,
  }));
}

async function readDocumentStates(
  pool: Pool,
  configurationVersion: number,
): Promise<Map<string, DocumentState>> {
  const result = await pool.query<{
    source_type: "ORIGINAL" | "KNOWLEDGE_POINT" | "OVERVIEW";
    source_id: string;
    text_content: string;
    status: "PENDING" | "READY" | "FAILED";
    has_embedding: boolean;
  }>(
    `SELECT state.source_type,
            state.source_id,
            state.text_content,
            state.status,
            embedding.source_id IS NOT NULL AS has_embedding
       FROM semantic_document_states AS state
       LEFT JOIN semantic_embeddings AS embedding
         ON embedding.configuration_version = state.configuration_version
        AND embedding.source_type = state.source_type
        AND embedding.source_id = state.source_id
        AND embedding.text_content = state.text_content
      WHERE state.configuration_version = $1`,
    [configurationVersion],
  );

  return new Map(
    result.rows.map((row) => [
      `${row.source_type}:${row.source_id}`,
      {
        text: row.text_content,
        status: row.status,
        hasEmbedding: row.has_embedding,
      },
    ]),
  );
}

function readyDocumentIds(
  documents: SearchDocument[],
  states: Map<string, DocumentState>,
): Set<string> {
  return new Set(
    documents.flatMap((document) => {
      const key = documentKey(document);
      const state = states.get(key);

      return state?.text === document.text &&
        state.status === "READY" &&
        state.hasEmbedding
        ? [key]
        : [];
    }),
  );
}

async function hasOtherVectorSpace(
  pool: Pool,
  configurationVersion: number,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM semantic_embeddings
        WHERE configuration_version <> $1
     )`,
    [configurationVersion],
  );

  return result.rows[0]?.exists ?? false;
}

async function semanticSearchIsGloballyPaused(
  pool: Pool,
  configurationVersion: number,
): Promise<boolean> {
  const activated = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM semantic_index_states
        WHERE configuration_version = $1
     )`,
    [configurationVersion],
  );

  if (activated.rows[0]?.exists) {
    return false;
  }

  return hasOtherVectorSpace(pool, configurationVersion);
}

async function activateVectorSpaceIfComplete(
  pool: Pool,
  configurationVersion: number,
): Promise<void> {
  const configuration = await readActiveConfiguration(pool);

  if (configuration?.version !== configurationVersion) {
    return;
  }

  const documents = await readSearchDocuments(pool);
  const states = await readDocumentStates(pool, configurationVersion);

  if (readyDocumentIds(documents, states).size !== documents.length) {
    return;
  }

  await pool.query(
    `INSERT INTO semantic_index_states (configuration_version)
     SELECT $1
      WHERE EXISTS (
        SELECT 1
          FROM model_configurations
         WHERE version = $1
           AND state = 'ACTIVE'
      )
     ON CONFLICT (configuration_version) DO NOTHING`,
    [configurationVersion],
  );
}

async function embedSearchDocument(options: {
  pool: Pool;
  embedText: EmbedText;
  configuration: ActiveEmbeddingConfiguration;
  apiKey: string;
  document: SearchDocument;
}): Promise<void> {
  const { pool, embedText, configuration, apiKey, document } = options;

  try {
    const pending = await markDocumentPending(pool, configuration, document);

    if (!pending) {
      return;
    }

    const embedding = await embedText({
      text: document.text,
      purpose: "document",
      baseUrl: configuration.embedding_base_url,
      model: configuration.embedding_model,
      apiKey,
      configurationVersion: configuration.version,
    });

    await publishReadyDocument(pool, configuration, document, embedding);
  } catch (error) {
    await publishFailedDocument(
      pool,
      configuration,
      document,
      failureReason(error),
    );
  }
}

async function markDocumentPending(
  pool: Pool,
  configuration: ActiveEmbeddingConfiguration,
  document: SearchDocument,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO semantic_document_states
       (configuration_version, source_type, source_id, record_id,
        text_content, status, failure_reason, attempt_count)
     SELECT $1, $2, $3, $4, $5, 'PENDING', NULL, 1
      WHERE EXISTS (
        SELECT 1
          FROM model_configurations
         WHERE version = $1
           AND state = 'ACTIVE'
      )
     ON CONFLICT (configuration_version, source_type, source_id)
     DO UPDATE
           SET record_id = EXCLUDED.record_id,
               text_content = EXCLUDED.text_content,
               status = 'PENDING',
               failure_reason = NULL,
               attempt_count = semantic_document_states.attempt_count + 1,
               updated_at = now()
     RETURNING source_id`,
    [
      configuration.version,
      document.sourceType,
      document.sourceId,
      document.recordId,
      document.text,
    ],
  );

  if (!result.rows[0]) {
    return false;
  }

  await pool.query(
    `DELETE FROM semantic_embeddings
      WHERE configuration_version = $1
        AND source_type = $2
        AND source_id = $3
        AND text_content <> $4`,
    [
      configuration.version,
      document.sourceType,
      document.sourceId,
      document.text,
    ],
  );

  return true;
}

async function publishReadyDocument(
  pool: Pool,
  configuration: ActiveEmbeddingConfiguration,
  document: SearchDocument,
  embedding: number[],
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (
      !(await configurationIsStillActive(client, configuration.version)) ||
      !(await searchDocumentIsCurrent(client, document))
    ) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `INSERT INTO semantic_embeddings
         (configuration_version, embedding_model, source_type, source_id,
          record_id, text_content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (configuration_version, source_type, source_id)
       DO UPDATE
             SET embedding_model = EXCLUDED.embedding_model,
                 record_id = EXCLUDED.record_id,
                 text_content = EXCLUDED.text_content,
                 embedding = EXCLUDED.embedding,
                 created_at = now()`,
      [
        configuration.version,
        configuration.embedding_model,
        document.sourceType,
        document.sourceId,
        document.recordId,
        document.text,
        embedding,
      ],
    );
    await client.query(
      `UPDATE semantic_document_states
          SET status = 'READY',
              failure_reason = NULL,
              updated_at = now()
        WHERE configuration_version = $1
          AND source_type = $2
          AND source_id = $3
          AND text_content = $4`,
      [
        configuration.version,
        document.sourceType,
        document.sourceId,
        document.text,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function publishFailedDocument(
  pool: Pool,
  configuration: ActiveEmbeddingConfiguration,
  document: SearchDocument,
  reason: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (
      !(await configurationIsStillActive(client, configuration.version)) ||
      !(await searchDocumentIsCurrent(client, document))
    ) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `DELETE FROM semantic_embeddings
        WHERE configuration_version = $1
          AND source_type = $2
          AND source_id = $3`,
      [configuration.version, document.sourceType, document.sourceId],
    );
    await client.query(
      `UPDATE semantic_document_states
          SET status = 'FAILED',
              failure_reason = $5,
              updated_at = now()
        WHERE configuration_version = $1
          AND source_type = $2
          AND source_id = $3
          AND text_content = $4`,
      [
        configuration.version,
        document.sourceType,
        document.sourceId,
        document.text,
        reason,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function configurationIsStillActive(
  client: PoolClient,
  configurationVersion: number,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM model_configurations
      WHERE version = $1
        AND state = 'ACTIVE'`,
    [configurationVersion],
  );

  return Boolean(result.rows[0]);
}

async function searchDocumentIsCurrent(
  client: PoolClient,
  document: SearchDocument,
): Promise<boolean> {
  if (document.sourceType === "ORIGINAL") {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM records AS record
           INNER JOIN fragment_revisions AS revision
             ON revision.id = record.current_fragment_revision_id
          WHERE record.id = $1
            AND record.archived_at IS NULL
            AND revision.id = $2
            AND revision.content = $3
       )`,
      [document.recordId, document.sourceId, document.text],
    );

    return result.rows[0]?.exists ?? false;
  }

  if (document.sourceType === "OVERVIEW") {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM records AS record
           INNER JOIN ai_analysis_revisions AS analysis
             ON analysis.id = record.current_analysis_revision_id
            AND analysis.status = 'ACTIVE'
           LEFT JOIN record_overview_corrections AS overview
             ON overview.record_id = record.id
            AND overview.analysis_revision_id = analysis.id
          WHERE record.id = $1
            AND record.archived_at IS NULL
            AND analysis.id = $2
            AND COALESCE(overview.title, analysis.title) || E'\n' ||
                  COALESCE(overview.summary, analysis.summary) = $3
       )`,
      [document.recordId, document.sourceId, document.text],
    );

    return result.rows[0]?.exists ?? false;
  }

  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM knowledge_points AS point
         INNER JOIN records AS record
           ON record.id = point.record_id
          AND record.current_analysis_revision_id = point.analysis_revision_id
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.id = point.analysis_revision_id
          AND analysis.status = 'ACTIVE'
         LEFT JOIN knowledge_point_corrections AS correction
           ON correction.knowledge_point_id = point.id
        WHERE point.id = $2
          AND point.record_id = $1
          AND record.archived_at IS NULL
          AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          AND point.usage_status = 'INCLUDED'
          AND COALESCE(correction.title, point.ai_title) || E'\n' ||
                COALESCE(correction.body, point.ai_body) = $3
     )`,
    [document.recordId, document.sourceId, document.text],
  );

  return result.rows[0]?.exists ?? false;
}

function failureReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);

  return reason.slice(0, 1_000) || "Embedding failed";
}

function documentKey(document: SearchDocument): string {
  return `${document.sourceType}:${document.sourceId}`;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return -1;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return -1;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
