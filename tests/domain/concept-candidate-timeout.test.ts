import { describe, expect, it } from "vitest";

import {
  conceptCandidateTimeoutMs,
  type ConceptCandidatePointInput,
} from "../../src/concept-candidate-generator.js";

describe("Concept Candidate generation timeout", () => {
  it.each([
    { bodyLength: 1_000, expected: 300_000 },
    { bodyLength: 3_000, expected: 420_000 },
    { bodyLength: 6_000, expected: 540_000 },
    { bodyLength: 9_000, expected: 600_000 },
  ])(
    "budgets $expected ms for $bodyLength input graphemes",
    ({ bodyLength, expected }) => {
      expect(conceptCandidateTimeoutMs([candidatePoint(bodyLength)])).toBe(
        expected,
      );
    },
  );
});

function candidatePoint(bodyLength: number): ConceptCandidatePointInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "范围",
    body: "知".repeat(bodyLength),
    evidence: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        quote: "证据",
        startOffset: 0,
        endOffset: 2,
      },
    ],
  };
}
