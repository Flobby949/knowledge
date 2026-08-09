import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  decryptCredential,
  encryptCredential,
  endpointFingerprint,
} from "./model-credentials.js";
import type {
  ModelEndpointTester,
  ModelEndpointTestInput,
} from "./model-endpoint-tester.js";

interface ModelConfigEndpointBody {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface ModelConfigDraftBody {
  text: ModelConfigEndpointBody;
  embedding: ModelConfigEndpointBody;
}

interface PreferenceBody {
  defaultAiHandling?: string;
}

export interface BootstrapModelDraft {
  text: Required<ModelConfigEndpointBody>;
  embedding: Required<ModelConfigEndpointBody>;
}

interface ModelConfigRow {
  version: number;
  state: "DRAFT" | "ACTIVE" | "SUPERSEDED";
  text_base_url: string;
  text_model: string;
  text_credential_ciphertext: string;
  text_test_fingerprint: string | null;
  embedding_base_url: string;
  embedding_model: string;
  embedding_credential_ciphertext: string;
  embedding_test_fingerprint: string | null;
}

export function registerModelConfigRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    credentialSecret: string;
    testModelEndpoint: ModelEndpointTester;
    scheduleSemanticIndex: () => void;
  },
): void {
  const {
    pool,
    credentialSecret,
    testModelEndpoint,
    scheduleSemanticIndex,
  } = options;

  app.get("/api/v1/model-config/draft", async () =>
    readPublicConfiguration(pool, credentialSecret),
  );

  app.get("/api/v1/preferences", async () => ({
    preferences: await readPreferences(pool),
  }));

  app.patch<{ Body: PreferenceBody }>(
    "/api/v1/preferences",
    async (request, reply) => {
      const handling = request.body?.defaultAiHandling;

      if (handling !== "automatic" && handling !== "review") {
        return reply.code(422).send({
          error: {
            code: "PREFERENCE_INVALID",
            message: "请选择自动采用或人工审查作为默认处理方式。",
          },
        });
      }

      const result = await pool.query<{ default_ai_handling: string }>(
        `UPDATE instance_preferences
            SET default_ai_handling = $1,
                updated_at = clock_timestamp()
          WHERE singleton = true
        RETURNING default_ai_handling`,
        [handling === "automatic" ? "AUTOMATIC" : "REVIEW"],
      );

      return {
        preferences: publicPreferences(result.rows[0]?.default_ai_handling),
      };
    },
  );

  app.put<{ Body: ModelConfigDraftBody }>(
    "/api/v1/model-config/draft",
    async (request, reply) => {
      const text = validEndpoint(request.body?.text);
      const embedding = validEndpoint(request.body?.embedding);

      if (!text || !embedding) {
        return reply.code(422).send({
          error: {
            code: "MODEL_CONFIG_INVALID",
            message: "请完整填写两个模型端点。",
          },
        });
      }

      const existing = await selectConfiguration(pool, "DRAFT");
      const textCredential = resolveCredential(
        text.apiKey,
        existing?.text_credential_ciphertext,
        credentialSecret,
      );
      const embeddingCredential = resolveCredential(
        embedding.apiKey,
        existing?.embedding_credential_ciphertext,
        credentialSecret,
      );

      if (!textCredential || !embeddingCredential) {
        return reply.code(422).send({
          error: {
            code: "MODEL_CREDENTIAL_REQUIRED",
            message: "两个模型端点都需要凭据。",
          },
        });
      }

      const encryptedTextCredential = encryptCredential(
        textCredential,
        credentialSecret,
      );
      const encryptedEmbeddingCredential = encryptCredential(
        embeddingCredential,
        credentialSecret,
      );

      if (existing) {
        const previousTextFingerprint = endpointFingerprint(
          endpointInput(existing, "text", credentialSecret),
        );
        const previousEmbeddingFingerprint = endpointFingerprint(
          endpointInput(existing, "embedding", credentialSecret),
        );
        const nextTextFingerprint = endpointFingerprint({
          baseUrl: text.baseUrl,
          model: text.model,
          apiKey: textCredential,
        });
        const nextEmbeddingFingerprint = endpointFingerprint({
          baseUrl: embedding.baseUrl,
          model: embedding.model,
          apiKey: embeddingCredential,
        });

        const client = await pool.connect();

        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE model_configurations
                SET state = 'SUPERSEDED',
                    updated_at = clock_timestamp()
              WHERE version = $1
                AND state = 'DRAFT'`,
            [existing.version],
          );
          await client.query(
            `INSERT INTO model_configurations
               (state,
                text_base_url,
                text_model,
                text_credential_ciphertext,
                text_test_fingerprint,
                embedding_base_url,
                embedding_model,
                embedding_credential_ciphertext,
                embedding_test_fingerprint)
             VALUES ('DRAFT', $1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              text.baseUrl,
              text.model,
              encryptedTextCredential,
              previousTextFingerprint === nextTextFingerprint
                ? existing.text_test_fingerprint
                : null,
              embedding.baseUrl,
              embedding.model,
              encryptedEmbeddingCredential,
              previousEmbeddingFingerprint === nextEmbeddingFingerprint
                ? existing.embedding_test_fingerprint
                : null,
            ],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } else {
        await pool.query(
          `INSERT INTO model_configurations
             (state,
              text_base_url,
              text_model,
              text_credential_ciphertext,
              embedding_base_url,
              embedding_model,
              embedding_credential_ciphertext)
           VALUES ('DRAFT', $1, $2, $3, $4, $5, $6)`,
          [
            text.baseUrl,
            text.model,
            encryptedTextCredential,
            embedding.baseUrl,
            embedding.model,
            encryptedEmbeddingCredential,
          ],
        );
      }

      return readPublicConfiguration(pool, credentialSecret);
    },
  );

  for (const kind of ["text", "embedding"] as const) {
    app.post(
      `/api/v1/model-config/draft/tests/${kind}`,
      async (_request, reply) => {
        const draft = await selectConfiguration(pool, "DRAFT");

        if (!draft) {
          return reply.code(404).send({
            error: {
              code: "MODEL_CONFIG_DRAFT_NOT_FOUND",
              message: "请先保存候选配置。",
            },
          });
        }

        const input = endpointInput(draft, kind, credentialSecret);

        try {
          await testModelEndpoint(input);
        } catch {
          return reply.code(422).send({
            kind,
            status: "failed",
            draftVersion: draft.version,
          });
        }

        const fingerprint = endpointFingerprint(input);
        const column =
          kind === "text"
            ? "text_test_fingerprint"
            : "embedding_test_fingerprint";
        const unchanged = await pool.query(
          `UPDATE model_configurations
              SET ${column} = $2,
                  updated_at = clock_timestamp()
            WHERE version = $1
              AND state = 'DRAFT'
              AND ${kind}_base_url = $3
              AND ${kind}_model = $4
              AND ${kind}_credential_ciphertext = $5
          RETURNING version`,
          [
            draft.version,
            fingerprint,
            input.baseUrl,
            input.model,
            kind === "text"
              ? draft.text_credential_ciphertext
              : draft.embedding_credential_ciphertext,
          ],
        );

        if (!unchanged.rows[0]) {
          return reply.code(409).send({
            error: {
              code: "MODEL_CONFIG_DRAFT_CHANGED",
              message: "候选配置已变化，请重新测试。",
            },
          });
        }

        return { kind, status: "passed", draftVersion: draft.version };
      },
    );
  }

  app.post("/api/v1/model-config/draft/activate", async (_request, reply) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const result = await client.query<ModelConfigRow>(
        `SELECT *
           FROM model_configurations
          WHERE state = 'DRAFT'
          FOR UPDATE`,
      );
      const draft = result.rows[0];

      if (!draft) {
        await client.query("ROLLBACK");
        return reply.code(404).send({
          error: {
            code: "MODEL_CONFIG_DRAFT_NOT_FOUND",
            message: "请先保存候选配置。",
          },
        });
      }

      const textFingerprint = endpointFingerprint(
        endpointInput(draft, "text", credentialSecret),
      );
      const embeddingFingerprint = endpointFingerprint(
        endpointInput(draft, "embedding", credentialSecret),
      );

      if (
        draft.text_test_fingerprint !== textFingerprint ||
        draft.embedding_test_fingerprint !== embeddingFingerprint
      ) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: {
            code: "MODEL_CONFIG_TESTS_REQUIRED",
            message: "两个候选端点都必须基于当前配置测试通过。",
          },
        });
      }

      const activeResult = await client.query<ModelConfigRow>(
        `SELECT *
           FROM model_configurations
          WHERE state = 'ACTIVE'
          FOR UPDATE`,
      );
      const previousActive = activeResult.rows[0];
      const canReuseSemanticIndex =
        previousActive?.embedding_base_url === draft.embedding_base_url &&
        previousActive.embedding_model === draft.embedding_model;

      await client.query(
        `UPDATE model_configurations
            SET state = 'SUPERSEDED',
                updated_at = clock_timestamp()
          WHERE state = 'ACTIVE'`,
      );
      const activated = await client.query<ModelConfigRow>(
        `UPDATE model_configurations
            SET state = 'ACTIVE',
                activated_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE version = $1
          RETURNING *`,
        [draft.version],
      );

      if (previousActive && canReuseSemanticIndex) {
        await reuseSemanticIndex(client, previousActive.version, draft.version);
      }

      await client.query("COMMIT");
      scheduleSemanticIndex();

      const active = activated.rows[0];

      if (!active) {
        throw new Error("Activated model configuration could not be read");
      }

      return { active: publicActiveConfiguration(active) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

async function reuseSemanticIndex(
  client: PoolClient,
  previousConfigurationVersion: number,
  nextConfigurationVersion: number,
): Promise<void> {
  await client.query(
    `INSERT INTO semantic_document_states
       (configuration_version, source_type, source_id, record_id,
        text_content, status, failure_reason, attempt_count, updated_at)
     SELECT $2, source_type, source_id, record_id,
            text_content, status, failure_reason, attempt_count, updated_at
       FROM semantic_document_states
      WHERE configuration_version = $1`,
    [previousConfigurationVersion, nextConfigurationVersion],
  );
  await client.query(
    `INSERT INTO semantic_embeddings
       (configuration_version, embedding_model, source_type, source_id,
        record_id, text_content, embedding, created_at)
     SELECT $2, embedding_model, source_type, source_id,
            record_id, text_content, embedding, created_at
       FROM semantic_embeddings
      WHERE configuration_version = $1`,
    [previousConfigurationVersion, nextConfigurationVersion],
  );
  await client.query(
    `INSERT INTO semantic_index_states (configuration_version, activated_at)
     SELECT $2,
            COALESCE(
              (SELECT activated_at
                 FROM semantic_index_states
                WHERE configuration_version = $1),
              clock_timestamp()
            )
      WHERE EXISTS (
              SELECT 1
                FROM semantic_index_states
               WHERE configuration_version = $1
            )
         OR NOT EXISTS (
              SELECT 1
                FROM semantic_embeddings
               WHERE configuration_version NOT IN ($1, $2)
            )`,
    [previousConfigurationVersion, nextConfigurationVersion],
  );
}

async function readPreferences(pool: Pool) {
  const result = await pool.query<{ default_ai_handling: string }>(
    `SELECT default_ai_handling
       FROM instance_preferences
      WHERE singleton = true`,
  );

  return publicPreferences(result.rows[0]?.default_ai_handling);
}

function publicPreferences(value: string | undefined): {
  defaultAiHandling: "automatic" | "review";
} {
  return {
    defaultAiHandling: value === "REVIEW" ? "review" : "automatic",
  };
}

export async function ensureBootstrapModelDraft(
  pool: Pool,
  credentialSecret: string,
  draft: BootstrapModelDraft,
): Promise<void> {
  await pool.query(
    `INSERT INTO model_configurations
       (state,
        text_base_url,
        text_model,
        text_credential_ciphertext,
        embedding_base_url,
        embedding_model,
        embedding_credential_ciphertext)
     SELECT 'DRAFT', $1, $2, $3, $4, $5, $6
      WHERE NOT EXISTS (
        SELECT 1 FROM model_configurations WHERE state = 'DRAFT'
      )`,
    [
      draft.text.baseUrl,
      draft.text.model,
      encryptCredential(draft.text.apiKey, credentialSecret),
      draft.embedding.baseUrl,
      draft.embedding.model,
      encryptCredential(draft.embedding.apiKey, credentialSecret),
    ],
  );
}

async function readPublicConfiguration(pool: Pool, credentialSecret: string) {
  const [active, draft] = await Promise.all([
    selectConfiguration(pool, "ACTIVE"),
    selectConfiguration(pool, "DRAFT"),
  ]);

  return {
    active: active ? publicActiveConfiguration(active) : null,
    draft: draft ? publicDraftConfiguration(draft, credentialSecret) : null,
    canActivate: draft ? draftCanActivate(draft, credentialSecret) : false,
  };
}

async function selectConfiguration(
  pool: Pool,
  state: "DRAFT" | "ACTIVE",
): Promise<ModelConfigRow | undefined> {
  const result = await pool.query<ModelConfigRow>(
    "SELECT * FROM model_configurations WHERE state = $1",
    [state],
  );

  return result.rows[0];
}

function publicActiveConfiguration(row: ModelConfigRow) {
  return {
    version: row.version,
    text: {
      baseUrl: row.text_base_url,
      model: row.text_model,
      credential: "configured" as const,
    },
    embedding: {
      baseUrl: row.embedding_base_url,
      model: row.embedding_model,
      credential: "configured" as const,
    },
  };
}

function publicDraftConfiguration(
  row: ModelConfigRow,
  credentialSecret: string,
) {
  const textPassed =
    row.text_test_fingerprint ===
    endpointFingerprint(endpointInput(row, "text", credentialSecret));
  const embeddingPassed =
    row.embedding_test_fingerprint ===
    endpointFingerprint(endpointInput(row, "embedding", credentialSecret));

  return {
    version: row.version,
    text: {
      baseUrl: row.text_base_url,
      model: row.text_model,
      credential: "configured" as const,
      testStatus: textPassed ? ("passed" as const) : ("not_tested" as const),
    },
    embedding: {
      baseUrl: row.embedding_base_url,
      model: row.embedding_model,
      credential: "configured" as const,
      testStatus: embeddingPassed
        ? ("passed" as const)
        : ("not_tested" as const),
    },
  };
}

function draftCanActivate(
  row: ModelConfigRow,
  credentialSecret: string,
): boolean {
  const publicDraft = publicDraftConfiguration(row, credentialSecret);

  return (
    publicDraft.text.testStatus === "passed" &&
    publicDraft.embedding.testStatus === "passed"
  );
}

function endpointInput(
  row: ModelConfigRow,
  kind: "text" | "embedding",
  credentialSecret: string,
): ModelEndpointTestInput {
  return {
    kind,
    baseUrl: kind === "text" ? row.text_base_url : row.embedding_base_url,
    model: kind === "text" ? row.text_model : row.embedding_model,
    apiKey: decryptCredential(
      kind === "text"
        ? row.text_credential_ciphertext
        : row.embedding_credential_ciphertext,
      credentialSecret,
    ),
  };
}

function resolveCredential(
  submitted: string | undefined,
  existingCiphertext: string | undefined,
  credentialSecret: string,
): string | null {
  if (submitted?.length) {
    return submitted;
  }

  return existingCiphertext
    ? decryptCredential(existingCiphertext, credentialSecret)
    : null;
}

function validEndpoint(
  endpoint: ModelConfigEndpointBody | undefined,
): ModelConfigEndpointBody | null {
  if (!endpoint || !endpoint.baseUrl?.trim() || !endpoint.model?.trim()) {
    return null;
  }

  try {
    const url = new URL(endpoint.baseUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }

  return {
    baseUrl: endpoint.baseUrl.trim(),
    model: endpoint.model.trim(),
    ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
  };
}
