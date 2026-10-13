import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { readStoredZip } from "../../src/zip-archive.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("persistent text highlights", () => {
  let database: PreparedTestDatabase;
  let app: FastifyInstance;
  let recordId: string;
  let tagId: string;
  const content = "学习🧠，保留原文并标记重点。";
  const url = () => `/api/v1/records/${recordId}/highlights/source:1`;

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({ databaseUrl: database.databaseUrl });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: content,
        myTags: [{ name: "学习" }],
        processing: "save_only",
      },
    });
    expect(created.statusCode).toBe(201);
    recordId = created.json().record.id;
    tagId = created.json().record.myTags[0].id;
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    database?.dispose();
  });

  it("saves Unicode ranges, rejects stale and invalid writes, and survives a server restart", async () => {
    const first = await app.inject({
      method: "PUT",
      url: url(),
      payload: {
        content,
        revision: 0,
        start: 2,
        end: 10,
        color: "yellow",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().highlights).toEqual([
      { start: 2, end: 10, color: "yellow" },
    ]);
    const overlap = await app.inject({
      method: "PUT",
      url: url(),
      payload: {
        content,
        revision: 1,
        start: 5,
        end: 9,
        color: "pink",
      },
    });
    expect(overlap.statusCode).toBe(200);
    expect(overlap.json().highlights).toHaveLength(3);
    for (const payload of [
      { content, revision: 1, start: 2, end: 4, color: "blue" },
      { content: "changed", revision: 2, start: 0, end: 2, color: "blue" },
    ]) {
      expect(
        (await app.inject({ method: "PUT", url: url(), payload })).statusCode,
      ).toBe(409);
    }
    for (const range of [
      { start: -1, end: 2 },
      { start: 3, end: 2 },
      { start: 0, end: 999 },
      { start: 0, end: 2, color: "red" },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: url(),
            payload: {
              content,
              revision: 2,
              color: "blue",
              ...range,
            },
          })
        ).statusCode,
      ).toBe(422);
    }
    expect(
      (
        await app.inject({
          method: "GET",
          url: url().replace("source:1", "source:99"),
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    app = await buildApp({ databaseUrl: database.databaseUrl });
    const loaded = await app.inject({ method: "GET", url: url() });
    expect(loaded.json()).toEqual(overlap.json());
    const erased = await app.inject({
      method: "PUT",
      url: url(),
      payload: {
        content,
        revision: 2,
        start: 5,
        end: 9,
        color: null,
      },
    });
    expect(erased.json().highlights).toEqual([
      { start: 2, end: 5, color: "yellow" },
      { start: 9, end: 10, color: "yellow" },
    ]);
  });

  it("keeps source version marks separate and includes them in a restorable export", async () => {
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/records/${recordId}`,
      payload: {
        text: `更新：${content}`,
        myTags: [{ id: tagId }],
        processing: "save_only",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: url().replace("source:1", "source:2"),
        })
      ).json().highlights,
    ).toEqual([]);
    const original = (await app.inject({ method: "GET", url: url() })).json();
    expect(original.highlights).toHaveLength(2);
    const requested = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
    });
    const exportId = requested.json().export.id;
    await expect
      .poll(
        async () =>
          (
            await app.inject({
              method: "GET",
              url: `/api/v1/exports/${exportId}`,
            })
          ).json().export.status,
      )
      .toBe("succeeded");
    const archive = await app.inject({
      method: "GET",
      url: `/api/v1/exports/${exportId}/download`,
    });
    const domain = JSON.parse(
      readStoredZip(archive.rawPayload).get("domain.json")!.toString(),
    );
    expect(domain.textHighlights).toHaveLength(1);
    expect(domain.textHighlights[0].highlights).toEqual(original.highlights);
    const targetDb = prepareTestDatabase();
    const targetApp = await buildApp({ databaseUrl: targetDb.databaseUrl });
    try {
      const inspected = await targetApp.inject({
        method: "POST",
        url: "/api/v1/restores/inspect",
        headers: { "content-type": "application/zip" },
        payload: archive.rawPayload,
      });
      expect(inspected.statusCode).toBe(200);
      const restored = await targetApp.inject({
        method: "POST",
        url: "/api/v1/restores",
        payload: { inspectionId: inspected.json().inspection.id },
      });
      expect(restored.statusCode).toBe(201);
      expect(
        (await targetApp.inject({ method: "GET", url: url() })).json(),
      ).toEqual(original);
    } finally {
      await targetApp.close();
      targetDb.dispose();
    }
  }, 30_000);
});
