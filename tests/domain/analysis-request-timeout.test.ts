import { describe, expect, it, vi } from "vitest";

import {
  analysisRequestTimeoutMs,
  generateOpenAICompatibleAnalysis,
} from "../../src/analysis-generator.js";

describe("AI analysis request timeout policy", () => {
  it("increases by grapheme-count tier and caps every request at ten minutes", () => {
    const family = "👨‍👩‍👧‍👦";

    expect(
      [
        "a".repeat(250),
        "a".repeat(251),
        family.repeat(500),
        family.repeat(501),
        "知".repeat(750),
        "知".repeat(751),
        "知".repeat(1_000),
        "知".repeat(1_001),
      ].map(analysisRequestTimeoutMs),
    ).toEqual([
      120_000,
      240_000,
      240_000,
      420_000,
      420_000,
      600_000,
      600_000,
      600_000,
    ]);
  });

  it("applies the selected tier to the external chat completion request", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "标题",
                    summary: "摘要",
                    knowledgePoints: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    try {
      await generateOpenAICompatibleAnalysis({
        sourceText: "👨‍👩‍👧‍👦".repeat(501),
        baseUrl: "https://text-provider.invalid/v1",
        model: "deepseek-v4-flash",
        apiKey: "test-only-key",
        configurationVersion: 1,
      });

      expect(timeout).toHaveBeenCalledWith(420_000);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
