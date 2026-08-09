import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("record tag validation public HTTP flow", () => {
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

  it("rejects a record without a user-approved tag", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "这是一条有效正文。",
        myTags: [],
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
        code: "MY_TAG_REQUIRED",
        message: expect.any(String),
      },
    });
    expect(body.error.message.trim()).not.toBe("");
  });
});
