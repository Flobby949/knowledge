import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createZip, readStoredZip } from "../../src/zip-archive.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

interface PublicTag {
  ancestors: Array<{ id: string; name: string }>;
  approvalStatus: "archived" | "candidate" | "user_approved";
  childCount: number;
  directRecordCount: number;
  id: string;
  name: string;
  origin: "ai_created" | "user_created";
  parentId: string | null;
  recordCount: number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

describe("multi-level tag hierarchy", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = prepareTestDatabase();
    pool = new Pool({ connectionString: database.databaseUrl });
    app = await buildApp({ databaseUrl: database.databaseUrl });
    await app.ready();
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    database?.dispose();
  }, 20_000);

  it("derives paths and filters records through the whole subtree", async () => {
    const root = await createTag(app, "编程");
    const frontend = await createTag(app, "前端", root.id);
    const react = await createTag(app, "React", frontend.id);
    const slashName = await createTag(app, "CI/CD");

    expect(react).toMatchObject({
      parentId: frontend.id,
      ancestors: [
        { id: root.id, name: "编程" },
        { id: frontend.id, name: "前端" },
      ],
      childCount: 0,
    });
    expect(slashName).toMatchObject({
      name: "CI/CD",
      parentId: null,
      ancestors: [],
    });

    const reactRecord = await createRecord(app, "React 组件记录", [react.id]);
    const frontendRecord = await createRecord(app, "前端构建记录", [frontend.id]);
    const sharedRecord = await createRecord(app, "同时属于两级的记录", [
      frontend.id,
      react.id,
    ]);
    const unrelatedRecord = await createRecord(app, "部署流水线记录", [
      slashName.id,
    ]);
    const approved = await listApproved(app);

    expect(findTag(approved, root.id)).toMatchObject({
      recordCount: 3,
      directRecordCount: 0,
      childCount: 1,
    });
    expect(findTag(approved, frontend.id)).toMatchObject({
      recordCount: 3,
      directRecordCount: 2,
      childCount: 1,
    });
    expect(findTag(approved, react.id)).toMatchObject({
      recordCount: 2,
      directRecordCount: 2,
    });

    const subtree = [reactRecord, frontendRecord, sharedRecord].sort();

    expect(await libraryRecordIds(app, [root.id])).toEqual(subtree);
    expect(await searchRecordIds(app, [frontend.id])).toEqual(subtree);
    expect(await libraryRecordIds(app, [react.id])).toEqual(
      [reactRecord, sharedRecord].sort(),
    );
    expect(await libraryRecordIds(app, [react.id, slashName.id])).toEqual(
      [reactRecord, sharedRecord, unrelatedRecord].sort(),
    );

    const tagRecords = await getJson<{ items: Array<{ id: string }> }>(
      app,
      `/api/v1/tags/${root.id}/records`,
    );

    expect(tagRecords.items.map(({ id }) => id).sort()).toEqual(subtree);

    const field = await getJson<{
      items: Array<{
        ancestors: Array<{ id: string; name: string }>;
        id: string;
        recordCount: number;
      }>;
    }>(app, "/api/v1/tag-field");

    expect(field.items.find(({ id }) => id === react.id)).toMatchObject({
      recordCount: 2,
      ancestors: [
        { id: root.id, name: "编程" },
        { id: frontend.id, name: "前端" },
      ],
    });
    expect(field.items.find(({ id }) => id === root.id)).toMatchObject({
      recordCount: 3,
    });

    expect((await listApproved(app, "前端")).map(({ id }) => id).sort()).toEqual(
      [frontend.id, react.id].sort(),
    );

    const detail = await getJson<{ children: PublicTag[]; tag: PublicTag }>(
      app,
      `/api/v1/tags/${frontend.id}`,
    );

    expect(detail.tag).toMatchObject({ id: frontend.id, childCount: 1 });
    expect(detail.children).toEqual([
      expect.objectContaining({ id: react.id, name: "React", recordCount: 2 }),
    ]);
  });

  it("moves tags and rejects cycles, self parents and more than five levels", async () => {
    const marker = randomUUID().slice(0, 8);
    const chain: PublicTag[] = [];

    for (let level = 1; level <= 5; level += 1) {
      chain.push(
        await createTag(app, `层级 ${level} ${marker}`, chain.at(-1)?.id),
      );
    }

    const [first, second, third, fourth, fifth] = chain as [
      PublicTag,
      PublicTag,
      PublicTag,
      PublicTag,
      PublicTag,
    ];

    expect(fifth.ancestors.map(({ id }) => id)).toEqual(
      [first, second, third, fourth].map(({ id }) => id),
    );

    const tooDeep = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: `第六层 ${marker}`, parentId: fifth.id },
    });

    expectError(tooDeep, 409, "TAG_HIERARCHY_TOO_DEEP");
    expectError(await moveTag(app, first.id, third.id), 409, "TAG_HIERARCHY_CYCLE");
    expectError(await moveTag(app, second.id, second.id), 409, "TAG_HIERARCHY_CYCLE");

    const other = [] as PublicTag[];

    for (let level = 1; level <= 4; level += 1) {
      other.push(
        await createTag(app, `另一分支 ${level} ${marker}`, other.at(-1)?.id),
      );
    }

    // `fourth` carries `fifth`, so the moved subtree is two levels high.
    expectError(
      await moveTag(app, fourth.id, other[3]!.id),
      409,
      "TAG_HIERARCHY_TOO_DEEP",
    );

    const moved = await moveTag(app, fourth.id, other[2]!.id);

    expect(moved.statusCode, moved.body).toBe(200);
    expect((moved.json() as { tag: PublicTag }).tag).toMatchObject({
      parentId: other[2]!.id,
      ancestors: other.slice(0, 3).map(({ id, name }) => ({ id, name })),
    });

    const toTop = await moveTag(app, fourth.id, null);

    expect(toTop.statusCode, toTop.body).toBe(200);
    expect((toTop.json() as { tag: PublicTag }).tag).toMatchObject({
      parentId: null,
      ancestors: [],
      childCount: 1,
    });

    expectError(
      await moveTag(app, first.id, randomUUID()),
      404,
      "TAG_PARENT_NOT_FOUND",
    );

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${first.id}`,
      payload: { parentId: "not-a-tag" },
    });

    expectError(invalid, 422, "TAG_UPDATE_INVALID");
  });

  it("keeps AI candidates at the top level until approval places them", async () => {
    const marker = randomUUID().slice(0, 8);
    const parent = await createTag(app, `候选上级 ${marker}`);
    const candidateId = randomUUID();

    await pool.query(
      `INSERT INTO tags (id, display_name, normalized_name, origin, approval_status)
       VALUES ($1, $2, $3, 'AI_CREATED', 'CANDIDATE')`,
      [candidateId, `候选 ${marker}`, `候选 ${marker}`],
    );

    const childOfCandidate = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: `候选下级 ${marker}`, parentId: candidateId },
    });

    expectError(childOfCandidate, 409, "TAG_PARENT_NOT_ALLOWED");
    expectError(
      await moveTag(app, candidateId, parent.id),
      409,
      "TAG_UPDATE_NOT_ALLOWED",
    );
    await expect(
      pool.query("UPDATE tags SET parent_tag_id = $2 WHERE id = $1", [
        candidateId,
        parent.id,
      ]),
    ).rejects.toMatchObject({
      constraint: "tags_parent_requires_active_approved_check",
    });

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/tags/${candidateId}/approve`,
      payload: { parentId: parent.id },
    });

    expect(approved.statusCode, approved.body).toBe(200);

    const detail = await getJson<{ tag: PublicTag }>(
      app,
      `/api/v1/tags/${candidateId}`,
    );

    expect(detail.tag).toMatchObject({
      approvalStatus: "user_approved",
      origin: "ai_created",
      parentId: parent.id,
    });
  });

  it("requires children to leave before archiving or merging and detaches archived or merged tags", async () => {
    const marker = randomUUID().slice(0, 8);
    const parent = await createTag(app, `归档上级 ${marker}`);
    const child = await createTag(app, `归档下级 ${marker}`, parent.id);
    const fallback = await createTag(app, `兜底标签 ${marker}`);

    await createRecord(app, `仍使用上级的记录 ${marker}`, [parent.id, fallback.id]);

    expectError(await archiveTag(app, parent.id), 409, "TAG_ARCHIVE_HAS_CHILDREN");

    const archived = await archiveTag(app, child.id);

    expect(archived.statusCode, archived.body).toBe(200);
    expect((archived.json() as { tag: PublicTag }).tag).toMatchObject({
      approvalStatus: "archived",
      parentId: null,
    });
    expect(
      (await getJson<{ tag: PublicTag }>(app, `/api/v1/tags/${parent.id}`)).tag,
    ).toMatchObject({ childCount: 0 });

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/tags/${child.id}`,
      payload: { approvalStatus: "user_approved" },
    });

    expect((restored.json() as { tag: PublicTag }).tag).toMatchObject({
      approvalStatus: "user_approved",
      parentId: null,
    });

    const mergeParent = await createTag(app, `合并上级 ${marker}`);
    const mergeSource = await createTag(app, `合并来源 ${marker}`, mergeParent.id);
    const mergeTarget = await createTag(app, `合并主标签 ${marker}`);
    const mergedRecord = await createRecord(app, `来源标签记录 ${marker}`, [
      mergeSource.id,
    ]);

    expectError(
      await mergeTags(app, mergeTarget.id, [mergeParent.id]),
      409,
      "TAG_MERGE_SOURCE_HAS_CHILDREN",
    );

    const merged = await mergeTags(app, mergeTarget.id, [mergeSource.id]);

    expect(merged.statusCode, merged.body).toBe(201);
    expect(
      (
        await pool.query<{ parent_tag_id: string | null }>(
          "SELECT parent_tag_id FROM tags WHERE id = $1",
          [mergeSource.id],
        )
      ).rows[0],
    ).toEqual({ parent_tag_id: null });
    expect(await libraryRecordIds(app, [mergeTarget.id])).toEqual([mergedRecord]);
    expect(await libraryRecordIds(app, [mergeParent.id])).toEqual([]);

    const childOfMergeSource = await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      payload: { name: `来源下级 ${marker}`, parentId: mergeSource.id },
    });

    expectError(childOfMergeSource, 409, "TAG_PARENT_NOT_ALLOWED");
  });

  it("serializes concurrent moves so they cannot form a cycle", async () => {
    const marker = randomUUID().slice(0, 8);
    const left = await createTag(app, `并发左 ${marker}`);
    const right = await createTag(app, `并发右 ${marker}`);
    const responses = await Promise.all([
      moveTag(app, left.id, right.id),
      moveTag(app, right.id, left.id),
    ]);

    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find(({ statusCode }) => statusCode === 409)?.json(),
    ).toMatchObject({ error: { code: "TAG_HIERARCHY_CYCLE" } });
  });

  it.each(["archive", "move", "approve", "merge", "rename"] as const)(
    "takes the mutation lock before locking tag rows during %s",
    async (operation) => {
      const marker = randomUUID().slice(0, 8);
      const parent = await createTag(app, `锁上级 ${marker}`);
      const subject = await createTag(app, `锁标签 ${marker}`, parent.id);
      const target = await createTag(app, `锁目标 ${marker}`);

      if (operation === "approve") {
        await pool.query(
          `UPDATE tags SET parent_tag_id = NULL, origin = 'AI_CREATED',
             approval_status = 'CANDIDATE', user_approved_at = NULL
           WHERE id = $1`,
          [subject.id],
        );
      }

      const blocker = await pool.connect();
      let pending: ReturnType<typeof archiveTag> | undefined;

      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [operation === "rename"
            ? "knowledge-tag-vocabulary-names"
            : "knowledge-tag-hierarchy"],
        );
        const { rows } = await blocker.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = rows[0]!.pid;

        pending = operation === "archive"
          ? archiveTag(app, subject.id)
          : operation === "move"
            ? moveTag(app, subject.id, target.id)
            : operation === "approve"
              ? app.inject({
                  method: "POST",
                  url: `/api/v1/tags/${subject.id}/approve`,
                  payload: { parentId: target.id },
                })
              : operation === "rename"
                ? app.inject({
                    method: "PATCH",
                    url: `/api/v1/tags/${subject.id}`,
                    payload: { name: `改名标签 ${marker}` },
                  })
                : mergeTags(app, target.id, [subject.id]);

        // Start injection before observing its database lock wait.
        pending = pending.then((response) => response);
        await expect.poll(async () => {
          const result = await pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database()
                  AND $1::integer = ANY(pg_blocking_pids(pid))
             ) AS blocked`,
            [pid],
          );

          return result.rows[0]?.blocked;
        }, { timeout: 5_000 }).toBe(true);

        // A waiting mutation must not hold a row needed by the lock owner.
        await blocker.query("SELECT id FROM tags WHERE id = $1 FOR UPDATE NOWAIT", [
          subject.id,
        ]);
        await blocker.query("COMMIT");

        const response = await pending;

        expect(response.statusCode, response.body).toBe(
          operation === "merge" ? 201 : 200,
        );
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    },
  );

  it("round-trips the hierarchy in format 9 and restores format 8 tags at the top level", async () => {
    const marker = randomUUID().slice(0, 8);
    const root = await createTag(app, `导出顶层 ${marker}`);
    const leaf = await createTag(app, `导出下级 ${marker}`, root.id);

    await createRecord(app, `导出层级记录 ${marker}`, [leaf.id]);

    const archive = await exportArchive(app);
    const domain = readDomain(archive);

    expect(domain.formatVersion).toBe(9);
    expect(domain.tags.find(({ id }) => id === leaf.id)).toMatchObject({
      parent_tag_id: root.id,
    });

    const cyclic = rewriteDomain(archive, (snapshot) => {
      snapshot.tags.find(({ id }) => id === root.id)!.parent_tag_id = leaf.id;
    });
    const cyclicInspection = await app.inject({
      method: "POST",
      url: "/api/v1/restores/inspect",
      headers: { "content-type": "application/zip" },
      payload: cyclic,
    });

    expectError(cyclicInspection, 422, "RESTORE_PACKAGE_INVALID");

    const format9Target = prepareTestDatabase();
    const format8Target = prepareTestDatabase();
    const format9App = await buildApp({ databaseUrl: format9Target.databaseUrl });
    const format8App = await buildApp({ databaseUrl: format8Target.databaseUrl });

    try {
      await restoreArchive(format9App, archive, 9);

      const restoredSource = await listApproved(app);
      const restoredTarget = await listApproved(format9App);

      expect(
        restoredTarget.map(({ id, parentId, ancestors }) => ({
          id,
          parentId,
          ancestors,
        })),
      ).toEqual(
        restoredSource.map(({ id, parentId, ancestors }) => ({
          id,
          parentId,
          ancestors,
        })),
      );
      expect(findTag(restoredTarget, root.id)).toMatchObject({
        childCount: 1,
        recordCount: 1,
        directRecordCount: 0,
      });

      const format8Archive = rewriteDomain(archive, (snapshot) => {
        snapshot.formatVersion = 8;

        for (const tag of snapshot.tags) {
          delete tag.parent_tag_id;
        }
      }, 8);

      await restoreArchive(format8App, format8Archive, 8);
      expect(
        (await listApproved(format8App)).every(
          ({ parentId, ancestors }) => parentId === null && ancestors.length === 0,
        ),
      ).toBe(true);
    } finally {
      await Promise.all([format9App.close(), format8App.close()]);
      format9Target.dispose();
      format8Target.dispose();
    }
  }, 30_000);
});

type DomainJson = {
  formatVersion: number;
  tags: Array<{ id: string; parent_tag_id?: string | null }>;
};

async function createTag(
  app: FastifyInstance,
  name: string,
  parentId?: string,
): Promise<PublicTag> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tags",
    payload: parentId === undefined ? { name } : { name, parentId },
  });

  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { tag: PublicTag }).tag;
}

function moveTag(app: FastifyInstance, tagId: string, parentId: string | null) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/tags/${tagId}`,
    payload: { parentId },
  });
}

function archiveTag(app: FastifyInstance, tagId: string) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/tags/${tagId}`,
    payload: { approvalStatus: "archived" },
  });
}

function mergeTags(
  app: FastifyInstance,
  targetTagId: string,
  sourceTagIds: string[],
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/tag-merges",
    payload: { targetTagId, sourceTagIds },
  });
}

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagIds: string[],
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: tagIds.map((id) => ({ id })),
      processing: "save_only",
    },
  });

  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { record: { id: string } }).record.id;
}

async function listApproved(app: FastifyInstance, query = ""): Promise<PublicTag[]> {
  const search = new URLSearchParams({ approval: "user_approved", q: query });

  return (await getJson<{ items: PublicTag[] }>(app, `/api/v1/tags?${search}`))
    .items;
}

async function libraryRecordIds(
  app: FastifyInstance,
  tagIds: string[],
): Promise<string[]> {
  const search = new URLSearchParams({ limit: "100" });

  tagIds.forEach((tagId) => search.append("tag", tagId));

  return (
    await getJson<{ items: Array<{ id: string }> }>(app, `/api/v1/records?${search}`)
  ).items
    .map(({ id }) => id)
    .sort();
}

async function searchRecordIds(
  app: FastifyInstance,
  tagIds: string[],
): Promise<string[]> {
  const search = new URLSearchParams({ limit: "100" });

  tagIds.forEach((tagId) => search.append("tag", tagId));

  return (
    await getJson<{ items: Array<{ record: { id: string } }> }>(
      app,
      `/api/v1/search?${search}`,
    )
  ).items
    .map(({ record }) => record.id)
    .sort();
}

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const response = await app.inject({ method: "GET", url });

  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}

function findTag(tags: PublicTag[], tagId: string): PublicTag | undefined {
  return tags.find(({ id }) => id === tagId);
}

function expectError(
  response: { body: string; json: () => unknown; statusCode: number },
  statusCode: number,
  code: string,
) {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect((response.json() as ErrorBody).error.code).toBe(code);
}

async function exportArchive(app: FastifyInstance): Promise<Buffer> {
  const requested = await app.inject({ method: "POST", url: "/api/v1/exports" });

  expect(requested.statusCode).toBe(202);
  const exportId = (requested.json() as { export: { id: string } }).export.id;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await getJson<{ export: { status: string } }>(
      app,
      `/api/v1/exports/${exportId}`,
    );

    if (status.export.status === "succeeded") {
      const downloaded = await app.inject({
        method: "GET",
        url: `/api/v1/exports/${exportId}/download`,
      });

      expect(downloaded.statusCode).toBe(200);
      return downloaded.rawPayload;
    }

    if (status.export.status === "failed") {
      throw new Error("export failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("export did not complete");
}

function readDomain(archive: Buffer): DomainJson {
  return JSON.parse(
    readStoredZip(archive).get("domain.json")!.toString("utf8"),
  ) as DomainJson;
}

function rewriteDomain(
  archive: Buffer,
  mutate: (domain: DomainJson) => void,
  manifestFormatVersion?: number,
): Buffer {
  const entries = readStoredZip(archive);
  const domain = readDomain(archive);
  const manifest = JSON.parse(
    entries.get("manifest.json")!.toString("utf8"),
  ) as { formatVersion: number };

  mutate(domain);

  if (manifestFormatVersion !== undefined) {
    manifest.formatVersion = manifestFormatVersion;
  }

  return createZip(
    [...entries].map(([name, data]) => ({
      name,
      data:
        name === "domain.json"
          ? Buffer.from(JSON.stringify(domain), "utf8")
          : name === "manifest.json"
            ? Buffer.from(JSON.stringify(manifest), "utf8")
            : data,
    })),
  );
}

async function restoreArchive(
  app: FastifyInstance,
  archive: Buffer,
  formatVersion: number,
) {
  const inspected = await app.inject({
    method: "POST",
    url: "/api/v1/restores/inspect",
    headers: { "content-type": "application/zip" },
    payload: archive,
  });

  expect(inspected.statusCode, inspected.body).toBe(200);
  const inspection = (
    inspected.json() as {
      inspection: { canRestore: boolean; formatVersion: number; id: string };
    }
  ).inspection;

  expect(inspection).toMatchObject({ canRestore: true, formatVersion });

  const restored = await app.inject({
    method: "POST",
    url: "/api/v1/restores",
    payload: { inspectionId: inspection.id },
  });

  expect(restored.statusCode, restored.body).toBe(201);
}
