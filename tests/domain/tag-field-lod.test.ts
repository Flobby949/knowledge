import { describe, expect, it } from "vitest";

import { getTagFieldRenderBudget } from "../../src/domain/tag-field-lod.js";

describe("home tag-field render budget", () => {
  it("steps down visual work at the 300 and 1000 tag boundaries without imposing a cap", () => {
    expect(getTagFieldRenderBudget(300)).toEqual({
      energyOpacity: { core: 0.74, shell: 0.1 },
      glowTextureSize: 64,
      labelTarget: 96,
      level: "full",
      sphereSegments: { height: 12, width: 18 },
      traceLimit: 4,
      traceSegments: 36,
    });
    expect(getTagFieldRenderBudget(301)).toEqual({
      energyOpacity: { core: 0.64, shell: 0.08 },
      glowTextureSize: 48,
      labelTarget: 72,
      level: "balanced",
      sphereSegments: { height: 9, width: 14 },
      traceLimit: 3,
      traceSegments: 28,
    });
    expect(getTagFieldRenderBudget(1_000)).toEqual({
      energyOpacity: { core: 0.54, shell: 0.06 },
      glowTextureSize: 32,
      labelTarget: 48,
      level: "compact",
      sphereSegments: { height: 7, width: 10 },
      traceLimit: 2,
      traceSegments: 20,
    });
    expect(getTagFieldRenderBudget(1_001)).toEqual({
      energyOpacity: { core: 0.44, shell: 0.04 },
      glowTextureSize: 24,
      labelTarget: 32,
      level: "dense",
      sphereSegments: { height: 5, width: 8 },
      traceLimit: 1,
      traceSegments: 12,
    });
  });
});
