import {
  expect,
  test as base,
  type APIRequestContext,
} from "@playwright/test";
import { Pool } from "pg";

export { expect };
export type {
  APIRequestContext,
  Download,
  Locator,
  Page,
} from "@playwright/test";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://knowledge:knowledge_dev@127.0.0.1:5432/knowledge_test";

export const test = base.extend<{ cleanKnowledgeInstance: void }>({
  cleanKnowledgeInstance: [
    async ({ request }, use) => {
      const pool = new Pool({ connectionString: databaseUrl });

      try {
        await settlePreviousBackgroundWork(pool, request);
        await resetKnowledgeInstance(pool);
      } finally {
        await pool.end();
      }

      await use();
    },
    { auto: true },
  ],
});

async function settlePreviousBackgroundWork(
  pool: Pool,
  request: APIRequestContext,
): Promise<void> {
  const unfinished = await pool.query<{ content: string }>(
    `SELECT revision.content
       FROM ai_tasks AS task
       INNER JOIN fragment_revisions AS revision
         ON revision.id = task.fragment_revision_id
      WHERE task.status IN ('QUEUED', 'RUNNING')`,
  );

  for (const row of unfinished.rows) {
    for (const gateId of aiGateIds(row.content)) {
      await request.post(
        `/api/v1/e2e/ai-gates/${encodeURIComponent(gateId)}/release`,
      );
    }
  }

  const deadline = Date.now() + 5_000;
  let quietSince = 0;

  while (Date.now() < deadline) {
    // Semantic publication rechecks both the active configuration and source
    // identity, so truncation safely invalidates a provider request still in flight.
    const result = await pool.query<{ busy_count: number }>(
      `SELECT (
          (SELECT COUNT(*) FROM ai_tasks
            WHERE status IN ('QUEUED', 'RUNNING'))
          + (SELECT COUNT(*) FROM data_exports
              WHERE status IN ('QUEUED', 'RUNNING'))
          + (SELECT COUNT(*) FROM concept_candidate_scans
              WHERE status IN ('QUEUED', 'RUNNING'))
        )::integer AS busy_count`,
    );
    const busyCount = result.rows[0]?.busy_count ?? 0;

    if (busyCount === 0) {
      quietSince ||= Date.now();

      if (Date.now() - quietSince >= 150) {
        return;
      }
    } else {
      quietSince = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("E2E background work did not settle before database reset");
}

function aiGateIds(sourceText: string): string[] {
  return [
    ...sourceText.matchAll(
      /E2E_(?:DELETE_DURING_AI|AI_TASK_RETRY) ([0-9a-f]{8})/gu,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
}

async function resetKnowledgeInstance(pool: Pool): Promise<void> {
  await pool.query("BEGIN");

  try {
    await pool.query(
      `TRUNCATE
         data_restores,
         restore_inspections,
         data_exports,
         coverage_analyses,
         model_configurations,
         concept_candidate_decision_members,
         concept_candidate_members,
         concept_candidates,
         concept_candidate_inputs,
         concept_candidate_scans,
         concept_activity,
         concept_memberships,
         concept_revisions,
         concepts,
         records,
         tags
       RESTART IDENTITY CASCADE`,
    );
    await pool.query(
      `INSERT INTO instance_preferences
         (singleton, default_ai_handling, updated_at)
       VALUES (true, 'AUTOMATIC', clock_timestamp())
       ON CONFLICT (singleton) DO UPDATE
             SET default_ai_handling = 'AUTOMATIC',
                 analysis_prompt = DEFAULT,
                 updated_at = clock_timestamp()`,
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
