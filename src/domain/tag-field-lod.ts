export type TagFieldLodLevel = "balanced" | "compact" | "dense" | "full";

export interface TagFieldRenderBudget {
  energyOpacity: { core: number; shell: number };
  glowTextureSize: number;
  labelTarget: number;
  level: TagFieldLodLevel;
  sphereSegments: { height: number; width: number };
  traceLimit: number;
  traceSegments: number;
}

export function getTagFieldRenderBudget(
  tagCount: number,
): TagFieldRenderBudget {
  if (tagCount <= 300) {
    return {
      energyOpacity: { core: 0.74, shell: 0.1 },
      glowTextureSize: 64,
      labelTarget: 96,
      level: "full",
      sphereSegments: { height: 12, width: 18 },
      traceLimit: 64,
      traceSegments: 36,
    };
  }

  if (tagCount <= 600) {
    return {
      energyOpacity: { core: 0.64, shell: 0.08 },
      glowTextureSize: 48,
      labelTarget: 72,
      level: "balanced",
      sphereSegments: { height: 9, width: 14 },
      traceLimit: 48,
      traceSegments: 28,
    };
  }

  if (tagCount <= 1_000) {
    return {
      energyOpacity: { core: 0.54, shell: 0.06 },
      glowTextureSize: 32,
      labelTarget: 48,
      level: "compact",
      sphereSegments: { height: 7, width: 10 },
      traceLimit: 32,
      traceSegments: 20,
    };
  }

  return {
    energyOpacity: { core: 0.44, shell: 0.04 },
    glowTextureSize: 24,
    labelTarget: 32,
    level: "dense",
    sphereSegments: { height: 5, width: 8 },
    traceLimit: 20,
    traceSegments: 12,
  };
}
