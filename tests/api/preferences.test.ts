import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("instance preferences public HTTP flow", () => {
  let app: FastifyInstance;
  let testDatabase: PreparedTestDatabase;

  beforeAll(async () => {
    testDatabase = prepareTestDatabase();
    app = await buildApp({ databaseUrl: testDatabase.databaseUrl });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    testDatabase?.dispose();
  }, 30_000);

  it("defaults to automatic publishing and persists a user-selected review default", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/preferences",
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      preferences: { defaultAiHandling: "automatic" },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { defaultAiHandling: "review" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      preferences: { defaultAiHandling: "review" },
    });

    await app.close();
    app = await buildApp({ databaseUrl: testDatabase.databaseUrl });
    await app.ready();

    const afterRestart = await app.inject({
      method: "GET",
      url: "/api/v1/preferences",
    });

    expect(afterRestart.statusCode).toBe(200);
    expect(afterRestart.json()).toEqual({
      preferences: { defaultAiHandling: "review" },
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { defaultAiHandling: "surprise-me" },
    });

    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({
      error: {
        code: "PREFERENCE_INVALID",
        message: expect.any(String),
      },
    });
  });
});
