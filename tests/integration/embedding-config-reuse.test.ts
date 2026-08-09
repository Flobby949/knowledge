import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import type {
  EmbedText,
  EmbedTextInput,
} from "../../src/embedding-provider.js";
import { prepareTestDatabase } from "../support/prepare-test-database.js";

interface ModelEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface ModelConfiguration {
  text: ModelEndpoint;
  embedding: ModelEndpoint;
}

interface SemanticHealth {
  status: "building" | "paused" | "ready";
  model: string;
  configurationVersion: number;
  readyDocuments: number;
  failedDocuments: number;
  totalDocuments: number;
}

describe("embedding configuration reuse", () => {
  it("keeps ready vectors when only text settings or the embedding credential changes", async () => {
    const database = prepareTestDatabase();
    const embeddingCalls: Array<Omit<EmbedTextInput, "apiKey">> = [];
    const embedText = vi.fn<EmbedText>(async (input) => {
      embeddingCalls.push({
        text: input.text,
        purpose: input.purpose,
        baseUrl: input.baseUrl,
        model: input.model,
        configurationVersion: input.configurationVersion,
      });

      if (input.purpose === "document" && input.configurationVersion > 1) {
        throw new Error("unchanged documents must reuse their ready vectors");
      }

      return [1, 0, 0];
    });
    const app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });

    try {
      await app.ready();
      const sourceText = "事务日志持续记录变化，并将已提交的变化主动发送给下游。";
      const semanticQuery = "怎样让下游持续收到数据库增量事件";
      const recordId = await createRecord(app, sourceText);
      const firstConfiguration: ModelConfiguration = {
        text: {
          baseUrl: "https://text-provider.invalid/v1",
          model: "deepseek-v4-flash",
          apiKey: "first-text-key",
        },
        embedding: {
          baseUrl: "https://embedding-provider.invalid/v1",
          model: "BAAI/bge-m3",
          apiKey: "first-embedding-key",
        },
      };
      const firstVersion = await activateConfiguration(
        app,
        firstConfiguration,
      );

      expect(firstVersion).toBe(1);
      await expectSemanticHealth(app, {
        status: "ready",
        model: firstConfiguration.embedding.model,
        configurationVersion: firstVersion,
        readyDocuments: 1,
        failedDocuments: 0,
        totalDocuments: 1,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([recordId]);

      const initialDocumentCalls = documentCallCount(embeddingCalls);
      const textChangedVersion = await activateConfiguration(app, {
        text: {
          baseUrl: "https://second-text-provider.invalid/v1",
          model: "deepseek-v4-flash-next",
          apiKey: "second-text-key",
        },
        embedding: firstConfiguration.embedding,
      });

      expect(textChangedVersion).toBe(2);
      await expectSemanticHealth(app, {
        status: "ready",
        model: firstConfiguration.embedding.model,
        configurationVersion: textChangedVersion,
        readyDocuments: 1,
        failedDocuments: 0,
        totalDocuments: 1,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([recordId]);
      expect(documentCallCount(embeddingCalls)).toBe(initialDocumentCalls);

      const credentialChangedVersion = await activateConfiguration(app, {
        text: {
          baseUrl: "https://second-text-provider.invalid/v1",
          model: "deepseek-v4-flash-next",
          apiKey: "second-text-key",
        },
        embedding: {
          ...firstConfiguration.embedding,
          apiKey: "rotated-embedding-key",
        },
      });

      expect(credentialChangedVersion).toBe(3);
      await expectSemanticHealth(app, {
        status: "ready",
        model: firstConfiguration.embedding.model,
        configurationVersion: credentialChangedVersion,
        readyDocuments: 1,
        failedDocuments: 0,
        totalDocuments: 1,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([recordId]);
      expect(documentCallCount(embeddingCalls)).toBe(initialDocumentCalls);
    } finally {
      await app.close();
      database.dispose();
    }
  }, 30_000);

  it("does not unpause a changed vector space that was never fully activated", async () => {
    const database = prepareTestDatabase();
    const changedModelDocuments = deferred<void>();
    const embeddingCalls: Array<Omit<EmbedTextInput, "apiKey">> = [];
    const embedText = vi.fn<EmbedText>(async (input) => {
      embeddingCalls.push({
        text: input.text,
        purpose: input.purpose,
        baseUrl: input.baseUrl,
        model: input.model,
        configurationVersion: input.configurationVersion,
      });

      if (
        input.purpose === "document" &&
        input.model === "BAAI/bge-m3-next"
      ) {
        await changedModelDocuments.promise;
      }

      return [1, 0, 0];
    });
    const app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    const originalConfiguration: ModelConfiguration = {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "embedding-key",
      },
    };

    try {
      await app.ready();
      await createRecord(app, "变更中的向量空间必须完成后再对搜索开放。");
      await activateConfiguration(app, originalConfiguration);
      await expectSemanticHealth(app, {
        status: "ready",
        model: originalConfiguration.embedding.model,
        configurationVersion: 1,
        readyDocuments: 1,
        failedDocuments: 0,
        totalDocuments: 1,
      });

      const changedEmbedding = {
        ...originalConfiguration.embedding,
        model: "BAAI/bge-m3-next",
      };
      await activateConfiguration(app, {
        text: originalConfiguration.text,
        embedding: changedEmbedding,
      });
      await waitForDocumentCall(embeddingCalls, 2);
      await expectSemanticHealth(app, {
        status: "paused",
        model: changedEmbedding.model,
        configurationVersion: 2,
        readyDocuments: 0,
        failedDocuments: 0,
        totalDocuments: 1,
      });

      const credentialChangedVersion = await activateConfiguration(app, {
        text: originalConfiguration.text,
        embedding: {
          ...changedEmbedding,
          apiKey: "rotated-next-model-key",
        },
      });
      const semantic = await readSemanticHealth(app);

      expect(credentialChangedVersion).toBe(3);
      expect(semantic).toEqual({
        status: "paused",
        model: changedEmbedding.model,
        configurationVersion: credentialChangedVersion,
        readyDocuments: 0,
        failedDocuments: 0,
        totalDocuments: 1,
      });
    } finally {
      changedModelDocuments.resolve();
      await app.close();
      database.dispose();
    }
  }, 30_000);

  it("keeps ready documents searchable when the same vector space is partially ready", async () => {
    const database = prepareTestDatabase();
    const readySource = "事务日志记录已经提交的数据库变化，并持续推送给下游。";
    const failedKeyword = "手冲咖啡水温";
    const failedSource = `${failedKeyword}需要结合烘焙度调整。`;
    const semanticQuery = "怎样可靠地持续消费数据库增量事件";
    const embeddingCalls: Array<Omit<EmbedTextInput, "apiKey">> = [];
    const embedText = vi.fn<EmbedText>(async (input) => {
      embeddingCalls.push({
        text: input.text,
        purpose: input.purpose,
        baseUrl: input.baseUrl,
        model: input.model,
        configurationVersion: input.configurationVersion,
      });

      if (input.purpose === "document" && input.text === failedSource) {
        throw new Error("deterministic document embedding failure");
      }

      if (input.purpose === "query" && input.text !== semanticQuery) {
        return [0, 1, 0];
      }

      return [1, 0, 0];
    });
    const app = await buildApp({
      databaseUrl: database.databaseUrl,
      embedText,
      testModelEndpoint: vi.fn(async () => ({ status: "passed" as const })),
    });
    const firstConfiguration: ModelConfiguration = {
      text: {
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "first-text-key",
      },
      embedding: {
        baseUrl: "https://embedding-provider.invalid/v1",
        model: "BAAI/bge-m3",
        apiKey: "first-embedding-key",
      },
    };

    try {
      await app.ready();
      const readyRecordId = await createRecord(app, readySource, "增量系统");
      const failedRecordId = await createRecord(app, failedSource, "咖啡冲泡");
      await activateConfiguration(app, firstConfiguration);
      await expectSemanticHealth(app, {
        status: "building",
        model: firstConfiguration.embedding.model,
        configurationVersion: 1,
        readyDocuments: 1,
        failedDocuments: 1,
        totalDocuments: 2,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([
        readyRecordId,
      ]);
      expect(await searchRecordIds(app, failedKeyword)).toContain(
        failedRecordId,
      );

      const initialDocumentCalls = documentCallCount(embeddingCalls);
      const textChangedVersion = await activateConfiguration(app, {
        text: {
          baseUrl: "https://second-text-provider.invalid/v1",
          model: "deepseek-v4-flash-next",
          apiKey: "second-text-key",
        },
        embedding: firstConfiguration.embedding,
      });

      await expectSemanticHealth(app, {
        status: "building",
        model: firstConfiguration.embedding.model,
        configurationVersion: textChangedVersion,
        readyDocuments: 1,
        failedDocuments: 1,
        totalDocuments: 2,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([
        readyRecordId,
      ]);
      expect(await searchRecordIds(app, failedKeyword)).toContain(
        failedRecordId,
      );
      expect(documentCallCount(embeddingCalls)).toBe(initialDocumentCalls);

      const credentialChangedVersion = await activateConfiguration(app, {
        text: {
          baseUrl: "https://second-text-provider.invalid/v1",
          model: "deepseek-v4-flash-next",
          apiKey: "second-text-key",
        },
        embedding: {
          ...firstConfiguration.embedding,
          apiKey: "rotated-embedding-key",
        },
      });

      await expectSemanticHealth(app, {
        status: "building",
        model: firstConfiguration.embedding.model,
        configurationVersion: credentialChangedVersion,
        readyDocuments: 1,
        failedDocuments: 1,
        totalDocuments: 2,
      });
      expect(await searchRecordIds(app, semanticQuery)).toEqual([
        readyRecordId,
      ]);
      expect(await searchRecordIds(app, failedKeyword)).toContain(
        failedRecordId,
      );
      expect(documentCallCount(embeddingCalls)).toBe(initialDocumentCalls);
    } finally {
      await app.close();
      database.dispose();
    }
  }, 30_000);
});

async function createRecord(
  app: FastifyInstance,
  text: string,
  tagName = "配置复用",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/records",
    payload: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });

  expect(response.statusCode).toBe(201);

  return (response.json() as { record: { id: string } }).record.id;
}

async function activateConfiguration(
  app: FastifyInstance,
  configuration: ModelConfiguration,
): Promise<number> {
  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/model-config/draft",
    payload: configuration,
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

  return (activated.json() as { active: { version: number } }).active.version;
}

async function expectSemanticHealth(
  app: FastifyInstance,
  expected: SemanticHealth,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/search-health",
    });

    expect(response.statusCode).toBe(200);

    const semantic = (response.json() as { semantic: SemanticHealth }).semantic;

    if (
      semantic.status === expected.status &&
      semantic.model === expected.model &&
      semantic.configurationVersion === expected.configurationVersion &&
      semantic.readyDocuments === expected.readyDocuments &&
      semantic.failedDocuments === expected.failedDocuments &&
      semantic.totalDocuments === expected.totalDocuments
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `semantic search health did not reach ${JSON.stringify(expected)}`,
  );
}

async function readSemanticHealth(
  app: FastifyInstance,
): Promise<SemanticHealth> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/search-health",
  });

  expect(response.statusCode).toBe(200);

  return (response.json() as { semantic: SemanticHealth }).semantic;
}

async function searchRecordIds(
  app: FastifyInstance,
  query: string,
): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/search?${new URLSearchParams({ q: query }).toString()}`,
  });

  expect(response.statusCode).toBe(200);

  return (
    response.json() as { items: Array<{ record: { id: string } }> }
  ).items.map((item) => item.record.id);
}

function documentCallCount(
  calls: Array<Omit<EmbedTextInput, "apiKey">>,
): number {
  return calls.filter((call) => call.purpose === "document").length;
}

async function waitForDocumentCall(
  calls: Array<Omit<EmbedTextInput, "apiKey">>,
  configurationVersion: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      calls.some(
        (call) =>
          call.purpose === "document" &&
          call.configurationVersion === configurationVersion,
      )
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `document embedding did not start for configuration ${configurationVersion}`,
  );
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return { promise, resolve: resolvePromise };
}
