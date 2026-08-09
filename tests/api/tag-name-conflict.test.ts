import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";

describe("tag name conflict public HTTP flow", () => {
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

  it("rejects a user-created tag whose normalized name already exists", async () => {
    const normalizedName = `tag-${crypto.randomUUID()}`;
    const firstDisplayName = `\u00A0${toFullWidth(
      normalizedName.toUpperCase(),
    )}\u3000`;

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "第一条有效记录。",
        myTags: [{ name: firstDisplayName }],
        processing: "save_only",
      },
    });

    expect(first.statusCode).toBe(201);

    const firstBody = first.json() as {
      record: {
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const firstTag = firstBody.record.myTags[0]!;

    expect(firstTag).toEqual({
      id: expect.any(String),
      name: firstDisplayName,
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/records",
      payload: {
        text: "第二条有效记录。",
        myTags: [{ name: normalizedName }],
        processing: "save_only",
      },
    });

    expect(second.statusCode).toBe(409);

    const secondBody = second.json() as {
      error: {
        code: string;
        message: string;
        details: {
          existingTag: {
            id: string;
            name: string;
          };
        };
      };
    };

    expect(secondBody).toEqual({
      error: {
        code: "TAG_NAME_CONFLICT",
        message: expect.any(String),
        details: {
          existingTag: {
            id: firstTag.id,
            name: firstDisplayName,
          },
        },
      },
    });
    expect(secondBody.error.message.trim()).not.toBe("");
  });
});

function toFullWidth(value: string): string {
  return value.replace(/[!-~]/gu, (character) =>
    String.fromCodePoint(character.codePointAt(0)! + 0xfee0),
  );
}
