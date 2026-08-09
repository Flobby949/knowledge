import type { FastifyInstance } from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type PublicExport = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  downloadUrl?: string;
};

describe("complete export snapshot consistency", () => {
  let sourceApp: FastifyInstance;
  let targetApp: FastifyInstance;
  let sourceDatabase: PreparedTestDatabase;
  let targetDatabase: PreparedTestDatabase;

  beforeAll(async () => {
    sourceDatabase = prepareTestDatabase();
    targetDatabase = prepareTestDatabase();
    sourceApp = await buildApp({ databaseUrl: sourceDatabase.databaseUrl });
    targetApp = await buildApp({ databaseUrl: targetDatabase.databaseUrl });
    await Promise.all([sourceApp.ready(), targetApp.ready()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([sourceApp?.close(), targetApp?.close()]);
    sourceDatabase?.dispose();
    targetDatabase?.dispose();
  }, 30_000);

  it("exports one restorable point-in-time snapshot while a record is edited", async () => {
    const created = await sourceApp.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "并发导出前的原文",
        myTags: [{ name: `导出快照 ${crypto.randomUUID()}` }],
        processing: "save_only",
      },
    });

    expect(created.statusCode).toBe(201);

    const recordId = (created.json() as { record: { id: string } }).record.id;
    const controlPool = new Pool({
      connectionString: sourceDatabase.databaseUrl,
      max: 5,
    });
    const recordsHolder = await controlPool.connect();
    const recordsBlocker = await controlPool.connect();
    const revisionsHolder = await controlPool.connect();
    const revisionsBlocker = await controlPool.connect();
    const observer = await controlPool.connect();
    let recordsExclusiveLock: Promise<unknown> | undefined;
    let revisionsExclusiveLock: Promise<unknown> | undefined;

    try {
      await recordsHolder.query("BEGIN");
      await recordsHolder.query("LOCK TABLE records IN ROW EXCLUSIVE MODE");
      await recordsBlocker.query("BEGIN");
      const recordsBlockerPid = await backendPid(recordsBlocker);
      recordsExclusiveLock = recordsBlocker.query(
        "LOCK TABLE records IN ACCESS EXCLUSIVE MODE",
      );

      await revisionsHolder.query("BEGIN");
      await revisionsHolder.query(
        "LOCK TABLE fragment_revisions IN ROW EXCLUSIVE MODE",
      );
      await revisionsBlocker.query("BEGIN");
      const revisionsBlockerPid = await backendPid(revisionsBlocker);
      revisionsExclusiveLock = revisionsBlocker.query(
        "LOCK TABLE fragment_revisions IN ACCESS EXCLUSIVE MODE",
      );

      await Promise.all([
        waitForLockWait(observer, recordsBlockerPid),
        waitForLockWait(observer, revisionsBlockerPid),
      ]);

      const requested = await sourceApp.inject({
        method: "POST",
        url: "/api/v1/exports",
      });

      expect(requested.statusCode).toBe(202);

      const exportId = (requested.json() as { export: PublicExport }).export.id;
      const recordsReaderPid = await waitForBlockedTableRead(
        observer,
        "SELECT * FROM records ORDER BY created_at, id",
      );

      await recordsHolder.query("COMMIT");
      await recordsExclusiveLock;
      recordsExclusiveLock = undefined;
      await recordsBlocker.query("COMMIT");
      await waitForQueryToFinish(observer, recordsReaderPid);
      await waitForBlockedTableRead(
        observer,
        "SELECT * FROM fragment_revisions ORDER BY record_id, revision_number",
      );

      const insertedRevision = await revisionsHolder.query<{ id: string }>(
        `INSERT INTO fragment_revisions
           (record_id, revision_number, content, grapheme_count)
         VALUES ($1, 2, $2, $3)
         RETURNING id`,
        [recordId, "并发导出期间保存的新版原文", 13],
      );
      const revisionId = insertedRevision.rows[0]?.id;

      if (!revisionId) {
        throw new Error("Concurrent revision insert did not return an id");
      }

      await revisionsHolder.query(
        `UPDATE records
            SET current_fragment_revision_id = $2,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [recordId, revisionId],
      );
      await revisionsHolder.query("COMMIT");
      await revisionsExclusiveLock;
      revisionsExclusiveLock = undefined;
      await revisionsBlocker.query("COMMIT");

      const completed = await waitForSucceededExport(sourceApp, exportId);

      if (!completed.downloadUrl) {
        throw new Error("Successful export did not provide a download URL");
      }

      const download = await sourceApp.inject({
        method: "GET",
        url: completed.downloadUrl,
      });

      expect(download.statusCode).toBe(200);

      const inspectionResponse = await targetApp.inject({
        method: "POST",
        url: "/api/v1/restores/inspect",
        headers: { "content-type": "application/zip" },
        payload: download.rawPayload,
      });

      expect(inspectionResponse.statusCode).toBe(200);

      const inspection = (
        inspectionResponse.json() as {
          inspection: {
            id: string;
            status: "valid";
            recordCount: number;
            canRestore: boolean;
          };
        }
      ).inspection;

      expect(inspection).toMatchObject({
        status: "valid",
        recordCount: 1,
        canRestore: true,
      });

      const restored = await targetApp.inject({
        method: "POST",
        url: "/api/v1/restores",
        payload: { inspectionId: inspection.id },
      });

      expect(restored.statusCode).toBe(201);

      const restoredRecord = await targetApp.inject({
        method: "GET",
        url: `/api/v1/records/${recordId}`,
      });

      expect(restoredRecord.statusCode).toBe(200);
      expect(restoredRecord.json()).toMatchObject({
        id: recordId,
        editable: {
          text: "并发导出前的原文",
          textVersion: 1,
        },
      });
    } finally {
      await Promise.allSettled([
        recordsHolder.query("ROLLBACK"),
        revisionsHolder.query("ROLLBACK"),
      ]);
      await Promise.allSettled(
        [recordsExclusiveLock, revisionsExclusiveLock].filter(
          (pending): pending is Promise<unknown> => pending !== undefined,
        ),
      );
      await Promise.allSettled([
        recordsBlocker.query("ROLLBACK"),
        revisionsBlocker.query("ROLLBACK"),
      ]);
      releaseAll([
        recordsHolder,
        recordsBlocker,
        revisionsHolder,
        revisionsBlocker,
        observer,
      ]);
      await controlPool.end();
    }
  }, 30_000);
});

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;

  if (pid === undefined) {
    throw new Error("Database connection did not expose its backend pid");
  }

  return pid;
}

async function waitForLockWait(
  observer: PoolClient,
  pid: number,
): Promise<void> {
  await eventually(async () => {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );

    return result.rows[0]?.waiting === true;
  }, `backend ${pid} did not wait for its table lock`);
}

async function waitForBlockedTableRead(
  observer: PoolClient,
  queryText: string,
): Promise<number> {
  let readerPid: number | undefined;

  await eventually(async () => {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query = $1
        ORDER BY pid
        LIMIT 1`,
      [queryText],
    );
    readerPid = result.rows[0]?.pid;

    return readerPid !== undefined;
  }, `export did not block while reading ${queryText}`);

  return readerPid!;
}

async function waitForQueryToFinish(
  observer: PoolClient,
  pid: number,
): Promise<void> {
  await eventually(async () => {
    const result = await observer.query<{ query: string; state: string }>(
      "SELECT query, state FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    const activity = result.rows[0];

    return (
      activity === undefined ||
      activity.state !== "active" ||
      activity.query !== "SELECT * FROM records ORDER BY created_at, id"
    );
  }, "export did not finish reading records before the concurrent edit");
}

async function eventually(
  condition: () => Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  throw new Error(failureMessage);
}

async function waitForSucceededExport(
  app: FastifyInstance,
  exportId: string,
): Promise<PublicExport> {
  let completed: PublicExport | undefined;
  let failure: string | undefined;

  await eventually(async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}`,
    });
    const current = (response.json() as { export: PublicExport }).export;

    if (current.status === "failed") {
      failure = `export ${exportId} failed`;
      return true;
    }

    if (current.status === "succeeded") {
      completed = current;
      return true;
    }

    return false;
  }, `export ${exportId} did not settle`);

  if (failure) {
    throw new Error(failure);
  }

  if (!completed) {
    throw new Error(`export ${exportId} did not succeed`);
  }

  return completed;
}

function releaseAll(clients: PoolClient[]): void {
  clients.forEach((client) => client.release());
}
