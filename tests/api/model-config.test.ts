import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

type EndpointTestInput = {
  kind: "text" | "embedding";
  baseUrl: string;
  model: string;
  apiKey: string;
};

describe("instance model configuration public HTTP flow", () => {
  let app: FastifyInstance;
  let testDatabase: PreparedTestDatabase;
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );

  beforeAll(async () => {
    testDatabase = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: testDatabase.databaseUrl,
      testModelEndpoint,
    });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    testDatabase?.dispose();
  }, 30_000);

  it("tests both independent endpoints before atomically activating a key-safe configuration", async () => {
    const text = {
      baseUrl: "https://text-provider.invalid/v1",
      model: "deepseek-v4-flash",
      apiKey: "local-text-test-key",
    };
    const embedding = {
      baseUrl: "https://embedding-provider.invalid/v1",
      model: "BAAI/bge-m3",
      apiKey: "local-embedding-test-key",
    };

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/model-config/draft",
    });

    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      active: null,
      draft: null,
      canActivate: false,
    });
    expectNoCredentialLeak(initial.body, text.apiKey, embedding.apiKey);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: { text, embedding },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      active: null,
      draft: {
        version: 1,
        text: {
          baseUrl: text.baseUrl,
          model: text.model,
          credential: "configured",
          testStatus: "not_tested",
        },
        embedding: {
          baseUrl: embedding.baseUrl,
          model: embedding.model,
          credential: "configured",
          testStatus: "not_tested",
        },
      },
      canActivate: false,
    });
    expectNoCredentialLeak(saved.body, text.apiKey, embedding.apiKey);

    const textTest = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/tests/text",
    });

    expect(textTest.statusCode).toBe(200);
    expect(textTest.json()).toEqual({
      kind: "text",
      status: "passed",
      draftVersion: 1,
    });
    expect(testModelEndpoint).toHaveBeenNthCalledWith(1, {
      kind: "text",
      ...text,
    });

    const activatedTooSoon = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(activatedTooSoon.statusCode).toBe(409);
    expect(activatedTooSoon.json()).toEqual({
      error: {
        code: "MODEL_CONFIG_TESTS_REQUIRED",
        message: expect.any(String),
      },
    });

    const embeddingTest = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/tests/embedding",
    });

    expect(embeddingTest.statusCode).toBe(200);
    expect(embeddingTest.json()).toEqual({
      kind: "embedding",
      status: "passed",
      draftVersion: 1,
    });
    expect(testModelEndpoint).toHaveBeenNthCalledWith(2, {
      kind: "embedding",
      ...embedding,
    });

    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({
      active: {
        version: 1,
        text: {
          baseUrl: text.baseUrl,
          model: text.model,
          credential: "configured",
        },
        embedding: {
          baseUrl: embedding.baseUrl,
          model: embedding.model,
          credential: "configured",
        },
      },
    });
    expectNoCredentialLeak(activated.body, text.apiKey, embedding.apiKey);

    const afterActivation = await app.inject({
      method: "GET",
      url: "/api/v1/model-config/draft",
    });

    expect(afterActivation.statusCode).toBe(200);
    expect(afterActivation.json()).toEqual({
      active: {
        version: 1,
        text: {
          baseUrl: text.baseUrl,
          model: text.model,
          credential: "configured",
        },
        embedding: {
          baseUrl: embedding.baseUrl,
          model: embedding.model,
          credential: "configured",
        },
      },
      draft: null,
      canActivate: false,
    });
    expectNoCredentialLeak(
      afterActivation.body,
      text.apiKey,
      embedding.apiKey,
    );

    const wrongTextApiKey = "definitely-wrong-text-key";
    const savedWrongCredential = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: {
        text: { ...text, apiKey: wrongTextApiKey },
        embedding,
      },
    });

    expect(savedWrongCredential.statusCode).toBe(200);
    expect(savedWrongCredential.json()).toMatchObject({
      draft: {
        version: 2,
        text: { credential: "configured", testStatus: "not_tested" },
        embedding: { credential: "configured", testStatus: "not_tested" },
      },
      canActivate: false,
    });

    testModelEndpoint.mockRejectedValueOnce(new Error("invalid credential"));

    const failedWrongCredential = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/tests/text",
    });

    expect(failedWrongCredential.statusCode).toBe(422);
    expect(failedWrongCredential.json()).toEqual({
      kind: "text",
      status: "failed",
      draftVersion: 2,
    });
    expect(testModelEndpoint).toHaveBeenNthCalledWith(3, {
      kind: "text",
      baseUrl: text.baseUrl,
      model: text.model,
      apiKey: wrongTextApiKey,
    });
    expectNoCredentialLeak(savedWrongCredential.body, wrongTextApiKey);
  });
});

function expectNoCredentialLeak(
  responseBody: string,
  ...credentials: string[]
): void {
  expect(responseBody).not.toContain("apiKey");

  for (const credential of credentials) {
    expect(responseBody).not.toContain(credential);
  }
}
