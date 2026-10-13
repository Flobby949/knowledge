import { describe, expect, it } from "vitest";
import {
  paintHighlights,
  rebaseHighlights,
  type TextHighlight,
} from "../../src/domain/text-highlights.js";

describe("independent text highlights", () => {
  const original: TextHighlight[] = [{ start: 0, end: 10, color: "yellow" }];
  it("recolors only the intersection and merges adjacent equal colors", () => {
    const painted = paintHighlights(original, 3, 6, "pink");
    expect(painted).toEqual([
      { start: 0, end: 3, color: "yellow" },
      { start: 3, end: 6, color: "pink" },
      { start: 6, end: 10, color: "yellow" },
    ]);
    expect(paintHighlights(painted, 3, 6, "yellow")).toEqual(original);
    expect(original).toEqual([{ start: 0, end: 10, color: "yellow" }]);
  });
  it("erases only the selected portion", () => {
    expect(paintHighlights(original, 3, 6, null)).toEqual([
      { start: 0, end: 3, color: "yellow" },
      { start: 6, end: 10, color: "yellow" },
    ]);
  });
  it("keeps unchanged Unicode text after an insertion and drops rewritten highlights", () => {
    const text = "学习🧠，保持原文";
    const marks: TextHighlight[] = [
      { start: 0, end: 4, color: "green" },
      { start: 5, end: 9, color: "blue" },
    ];
    expect(rebaseHighlights(marks, text, `今天${text}`)).toEqual([
      { start: 2, end: 6, color: "green" },
      { start: 7, end: 11, color: "blue" },
    ]);
    expect(rebaseHighlights(marks, text, "复习🧠，保持原文")).toEqual([
      marks[1],
    ]);
    expect(rebaseHighlights(original, "aaaaaaaaaa", "bbbbb")).toEqual([]);
  });
});
