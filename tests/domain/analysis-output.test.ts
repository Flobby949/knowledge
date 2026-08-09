import { describe, expect, it } from "vitest";

import { validateAnalysisOutput } from "../../src/domain/analysis-output.js";

describe("AI analysis output validation", () => {
  it("validates a complete output atomically against the exact source text", () => {
    const sourceText = "前缀👨‍👩‍👧‍👦 Redis 使用事件通知。";
    const quote = "Redis 使用事件通知";
    const validPoint = {
      title: "Redis 的事件通知",
      body: "Redis 使用事件通知。",
      evidence: [{ start: 14, end: 26, quote }],
    };
    const validOutput = {
      title: "Redis 事件通知",
      summary: "Redis 可以使用事件通知。",
      knowledgePoints: [validPoint],
    };

    expect(sourceText.slice(14, 26)).toBe(quote);
    expect(validateAnalysisOutput(sourceText, validOutput)).toEqual({
      ok: true,
      value: validOutput,
    });

    for (const knowledgePoints of [
      [],
      Array.from({ length: 6 }, () => validPoint),
    ]) {
      expect(
        validateAnalysisOutput(sourceText, {
          ...validOutput,
          knowledgePoints,
        }),
      ).toEqual({
        ok: false,
        errors: [
          {
            code: "KNOWLEDGE_POINT_COUNT",
            path: "knowledgePoints",
            message: expect.any(String),
          },
        ],
      });
    }

    expect(
      validateAnalysisOutput(sourceText, {
        ...validOutput,
        knowledgePoints: [{ title: "", body: "", evidence: [] }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        {
          code: "FIELD_REQUIRED",
          path: "knowledgePoints[0].title",
          message: expect.any(String),
        },
        {
          code: "FIELD_REQUIRED",
          path: "knowledgePoints[0].body",
          message: expect.any(String),
        },
        {
          code: "EVIDENCE_REQUIRED",
          path: "knowledgePoints[0].evidence",
          message: expect.any(String),
        },
      ],
    });

    const mismatchedOutput = {
      ...validOutput,
      knowledgePoints: [
        validPoint,
        {
          title: "Redis 的事件通知",
          body: "Redis 使用事件通知。",
          evidence: [{ start: 15, end: 26, quote }],
        },
      ],
    };
    const invalid = validateAnalysisOutput(sourceText, mismatchedOutput);

    expect(invalid).toEqual({
      ok: false,
      errors: [
        {
          code: "EVIDENCE_MISMATCH",
          path: "knowledgePoints[1].evidence[0]",
          message: expect.any(String),
        },
      ],
    });
    expect(invalid).not.toHaveProperty("value");
  });
});
