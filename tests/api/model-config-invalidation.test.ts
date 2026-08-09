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

describe("model configuration test invalidation public HTTP flow", () => {
  let app: FastifyInstance;
  let database: PreparedTestDatabase;
  const testModelEndpoint = vi.fn(
    async (_input: EndpointTestInput): Promise<{ status: "passed" }> => ({
      status: "passed",
    }),
  );

  beforeAll(async () => {
    database = prepareTestDatabase();
    app = await buildApp({
      databaseUrl: database.databaseUrl,
      testModelEndpoint,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  });

  it("invalidates only the changed endpoint test while retaining saved credentials", async () => {
    const text = {
      baseUrl: "https://text-provider.invalid/v1",
      model: "deepseek-v4-flash",
      apiKey: "local-retained-text-key",
    };
    const embedding = {
      baseUrl: "https://embedding-provider.invalid/v1",
      model: "BAAI/bge-m3",
      apiKey: "local-retained-embedding-key",
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: { text, embedding },
    });

    expect(saved.statusCode).toBe(200);

    for (const kind of ["text", "embedding"] as const) {
      const tested = await app.inject({
        method: "POST",
        url: `/api/v1/model-config/draft/tests/${kind}`,
      });

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toEqual({
        kind,
        status: "passed",
        draftVersion: 1,
      });
    }

    const updatedTextModel = "deepseek-v4-flash-updated";
    const changed = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: {
        text: {
          baseUrl: text.baseUrl,
          model: updatedTextModel,
        },
        embedding: {
          baseUrl: embedding.baseUrl,
          model: embedding.model,
        },
      },
    });

    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({
      active: null,
      draft: {
        version: 2,
        text: {
          baseUrl: text.baseUrl,
          model: updatedTextModel,
          credential: "configured",
          testStatus: "not_tested",
        },
        embedding: {
          baseUrl: embedding.baseUrl,
          model: embedding.model,
          credential: "configured",
          testStatus: "passed",
        },
      },
      canActivate: false,
    });
    expectNoCredentialLeak(changed.body, text.apiKey, embedding.apiKey);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: {
        code: "MODEL_CONFIG_TESTS_REQUIRED",
        message: expect.any(String),
      },
    });

    const retested = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/tests/text",
    });

    expect(retested.statusCode).toBe(200);
    expect(retested.json()).toEqual({
      kind: "text",
      status: "passed",
      draftVersion: 2,
    });
    expect(testModelEndpoint).toHaveBeenNthCalledWith(3, {
      kind: "text",
      baseUrl: text.baseUrl,
      model: updatedTextModel,
      apiKey: text.apiKey,
    });
    expect(testModelEndpoint).toHaveBeenCalledTimes(3);

    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({
      active: {
        version: 2,
        text: {
          baseUrl: text.baseUrl,
          model: updatedTextModel,
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
