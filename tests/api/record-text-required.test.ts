import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record text validation public HTTP flow", () => {
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

  it("rejects text made only from Unicode whitespace", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "\u00A0\u3000\t\n",
        myTags: [{ name: `有效标签 ${crypto.randomUUID()}` }],
        processing: "save_only",
      },
    });

    expect(response.statusCode).toBe(422);

    const body = response.json() as {
      error: {
        code: string;
        message: string;
      };
    };

    expect(body).toEqual({
      error: {
        code: "TEXT_REQUIRED",
        message: expect.any(String),
      },
    });
    expect(body.error.message.trim()).not.toBe("");
  });
});
