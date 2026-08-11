import { describe, expect, it } from "vitest";

import { coverageTaskTimeoutMs } from "../../src/coverage-generator.js";
import { EMBEDDING_REQUEST_TIMEOUT_MS } from "../../src/embedding-provider.js";
import { relationRequestTimeoutMs } from "../../src/relation-generator.js";

describe("V2 AI capability timeout policy", () => {
  it("allows two minutes for one embedding request", () => {
    expect(EMBEDDING_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it("scales one relation request from five to ten minutes", () => {
    expect(
      [250, 750, 1_250, 2_000].map((length) =>
        relationRequestTimeoutMs({
          pointA: { id: "a", title: "", body: "甲".repeat(length), evidence: [] },
          pointB: { id: "b", title: "", body: "", evidence: [] },
        }),
      ),
    ).toEqual([300_000, 420_000, 540_000, 600_000]);
  });

  it("scales one coverage task from ten to thirty minutes", () => {
    expect(
      [1_000, 6_000, 21_000, 50_000].map((length) =>
        coverageTaskTimeoutMs([{ body: "知".repeat(length) }]),
      ),
    ).toEqual([600_000, 900_000, 1_800_000, 1_800_000]);
  });
});
