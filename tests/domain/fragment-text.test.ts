import { describe, expect, it } from "vitest";

import {
  countGraphemes,
  hasNonWhitespace,
} from "../../src/domain/fragment-text.js";

describe("fragment text", () => {
  it("counts Unicode extended grapheme clusters", () => {
    expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
    expect(countGraphemes("e\u0301")).toBe(1);
    expect(countGraphemes(" \t\n")).toBe(3);
  });

  it("rejects text made only from Unicode White_Space", () => {
    const whitespace =
      "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680" +
      "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
      "\u2028\u2029\u202F\u205F\u3000";

    expect(hasNonWhitespace(whitespace)).toBe(false);
  });

  it("accepts content surrounded by whitespace without rewriting the text", () => {
    const text = "\u00A0\t知识\n\u3000";
    const originalText = text;
    const count = countGraphemes(text);
    const valid = hasNonWhitespace(text);

    expect(count).toBe(6);
    expect(typeof count).toBe("number");
    expect(valid).toBe(true);
    expect(typeof valid).toBe("boolean");
    expect(text).toBe(originalText);
  });
});
