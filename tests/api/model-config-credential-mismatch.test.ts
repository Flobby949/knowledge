import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import {
  prepareTestDatabase,
  type PreparedTestDatabase,
} from "../support/prepare-test-database.js";

describe("model configuration credential encryption key mismatch", () => {
  let app: FastifyInstance | undefined;
  let database: PreparedTestDatabase;

  beforeAll(() => {
    database = prepareTestDatabase();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    database?.dispose();
  }, 30_000);

  it("marks unreadable credentials invalid and lets the user replace them", async () => {
    const original = {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "text-model",
        apiKey: "original-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "embedding-model",
        apiKey: "original-embedding-key",
      },
    };

    const testModelEndpoint = vi.fn(async () => ({ status: "passed" as const }));

    app = await buildApp({
      credentialEncryptionKey: "original-encryption-key",
      databaseUrl: database.databaseUrl,
      testModelEndpoint,
    });
    await app.ready();

    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: original,
    });

    expect(saved.statusCode).toBe(200);

    for (const kind of ["text", "embedding"] as const) {
      const tested = await app.inject({
        method: "POST",
        url: `/api/v1/model-config/draft/tests/${kind}`,
      });

      expect(tested.statusCode).toBe(200);
    }

    const activated = await app.inject({
      method: "POST",
      url: "/api/v1/model-config/draft/activate",
    });

    expect(activated.statusCode).toBe(200);

    const nextDraft = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: original,
    });

    expect(nextDraft.statusCode).toBe(200);
    await app.close();

    app = await buildApp({
      credentialEncryptionKey: "replacement-encryption-key",
      databaseUrl: database.databaseUrl,
      testModelEndpoint: vi.fn(),
    });
    await app.ready();

    const unreadable = await app.inject({
      method: "GET",
      url: "/api/v1/model-config/draft",
    });

    expect(unreadable.statusCode).toBe(200);
    expect(unreadable.json()).toEqual({
      active: {
        version: 1,
        text: {
          baseUrl: original.text.baseUrl,
          model: original.text.model,
          credential: "invalid",
        },
        embedding: {
          baseUrl: original.embedding.baseUrl,
          model: original.embedding.model,
          credential: "invalid",
        },
      },
      draft: {
        version: 2,
        text: {
          baseUrl: original.text.baseUrl,
          model: original.text.model,
          credential: "invalid",
          testStatus: "not_tested",
        },
        embedding: {
          baseUrl: original.embedding.baseUrl,
          model: original.embedding.model,
          credential: "invalid",
          testStatus: "not_tested",
        },
      },
      canActivate: false,
    });

    const retained = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: {
        text: {
          baseUrl: original.text.baseUrl,
          model: original.text.model,
        },
        embedding: {
          baseUrl: original.embedding.baseUrl,
          model: original.embedding.model,
        },
      },
    });

    expect(retained.statusCode).toBe(422);
    expect(retained.json()).toMatchObject({
      error: { code: "MODEL_CREDENTIAL_REQUIRED" },
    });

    const replaced = await app.inject({
      method: "PUT",
      url: "/api/v1/model-config/draft",
      payload: {
        text: { ...original.text, apiKey: "replacement-text-key" },
        embedding: {
          ...original.embedding,
          apiKey: "replacement-embedding-key",
        },
      },
    });

    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({
      draft: {
        version: 3,
        text: { credential: "configured", testStatus: "not_tested" },
        embedding: { credential: "configured", testStatus: "not_tested" },
      },
      canActivate: false,
    });
    expect(replaced.body).not.toContain("replacement-text-key");
    expect(replaced.body).not.toContain("replacement-embedding-key");
  });
});
