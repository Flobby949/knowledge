import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { DEFAULT_ANALYSIS_PROMPT } from "../../src/domain/analysis-prompt.js";
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

  it("persists independently updated AI preferences", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/preferences",
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      preferences: {
        defaultAiHandling: "automatic",
        analysisPrompt: DEFAULT_ANALYSIS_PROMPT,
      },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { defaultAiHandling: "review" },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      preferences: {
        defaultAiHandling: "review",
        analysisPrompt: DEFAULT_ANALYSIS_PROMPT,
      },
    });

    const customPrompt = "只提取原文中的关键知识，并为每个知识点保留至多两个核心标签。";
    const promptUpdated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { analysisPrompt: `  ${customPrompt}  ` },
    });

    expect(promptUpdated.statusCode).toBe(200);
    expect(promptUpdated.json()).toEqual({
      preferences: {
        defaultAiHandling: "review",
        analysisPrompt: customPrompt,
      },
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
      preferences: {
        defaultAiHandling: "review",
        analysisPrompt: customPrompt,
      },
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

    const emptyPrompt = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences",
      payload: { analysisPrompt: "   " },
    });

    expect(emptyPrompt.statusCode).toBe(422);
    expect(emptyPrompt.json()).toEqual({
      error: {
        code: "PREFERENCE_INVALID",
        message: expect.any(String),
      },
    });
  });
});
