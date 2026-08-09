import { describe, expect, it } from "vitest";

import { normalizeTagName } from "../../src/domain/tag-name.js";

describe("tag name normalization", () => {
  it("uses NFKC and ignores Latin letter case", () => {
    expect(normalizeTagName(" CDC ")).toBe("cdc");
    expect(normalizeTagName("cdc")).toBe("cdc");
    expect(normalizeTagName("ＣＤＣ")).toBe("cdc");
  });

  it("trims and folds Unicode whitespace to one ASCII space", () => {
    expect(normalizeTagName("\u00A0数据\u3000\t\n同步\u00A0")).toBe(
      "数据 同步",
    );
  });

  it("preserves punctuation and does not translate or merge synonyms", () => {
    expect(normalizeTagName("C.D.C.")).toBe("c.d.c.");
    expect(normalizeTagName("CDC")).toBe("cdc");
    expect(normalizeTagName("Change Data Capture")).toBe(
      "change data capture",
    );
    expect(normalizeTagName("变更数据捕获")).toBe("变更数据捕获");

    expect(normalizeTagName("C.D.C.")).not.toBe(normalizeTagName("CDC"));
    expect(normalizeTagName("CDC")).not.toBe(
      normalizeTagName("Change Data Capture"),
    );
    expect(normalizeTagName("CDC")).not.toBe(
      normalizeTagName("变更数据捕获"),
    );
  });
});
