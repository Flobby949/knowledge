import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record text length validation public HTTP flow", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;

    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for API tests");
    }

    app = await buildApp({ databaseUrl });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("rejects text containing 1001 extended grapheme clusters", async () => {
    const text = `${"a".repeat(999)}👨‍👩‍👧‍👦e\u0301`;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text,
        myTags: [{ name: `有效标签 ${crypto.randomUUID()}` }],
        processing: "save_only",
      },
    });

    expect(response.statusCode).toBe(422);

    const body = response.json() as {
      error: {
        code: string;
        message: string;
        details: {
          graphemeCount: number;
          max: number;
        };
      };
    };

    expect(body).toEqual({
      error: {
        code: "TEXT_TOO_LONG",
        message: expect.any(String),
        details: {
          graphemeCount: 1_001,
          max: 1_000,
        },
      },
    });
    expect(body.error.message.trim()).not.toBe("");
  });
});
