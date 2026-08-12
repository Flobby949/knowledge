import { describe, expect, it } from "vitest";

import {
  expandNetworkLayout,
  layoutNetwork,
  networkTopologyKey,
  type NetworkLayoutEdge,
  type NetworkLayoutNode,
} from "../../src/client/network-layout.js";

describe("knowledge network layout", () => {
  it("is independent of input order and expresses real connected structure", () => {
    const nodes: NetworkLayoutNode[] = [
      { key: "knowledge_point:c", type: "knowledge_point" },
      { key: "concept:isolated", type: "concept" },
      { key: "knowledge_point:a", type: "knowledge_point" },
      { key: "concept:root", type: "concept" },
      { key: "knowledge_point:b", type: "knowledge_point" },
    ];
    const edges: NetworkLayoutEdge[] = [
      {
        edgeKey: "concept_membership:c",
        source: "concept:root",
        target: "knowledge_point:c",
      },
      {
        edgeKey: "concept_membership:a",
        source: "concept:root",
        target: "knowledge_point:a",
      },
      {
        edgeKey: "concept_membership:b",
        source: "concept:root",
        target: "knowledge_point:b",
      },
    ];

    const snapshot = layoutNetwork(nodes, edges);
    const reordered = layoutNetwork([...nodes].reverse(), [
      edges[1]!,
      edges[2]!,
      edges[0]!,
    ]);

    expect(reordered).toEqual(snapshot);
    expect(networkTopologyKey(nodes, edges)).toBe(
      networkTopologyKey([...nodes].reverse(), [...edges].reverse()),
    );
    expect(networkTopologyKey(nodes, edges.slice(1))).not.toBe(
      snapshot.topologyKey,
    );
    expect(snapshot.positions["concept:root"]).toEqual(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );

    const root = snapshot.positions["concept:root"]!;
    const connectedRadii = ["knowledge_point:a", "knowledge_point:b", "knowledge_point:c"]
      .map((key) => distance(root, snapshot.positions[key]!));
    const isolatedDistance = distance(
      root,
      snapshot.positions["concept:isolated"]!,
    );

    expect(Math.max(...connectedRadii) - Math.min(...connectedRadii)).toBeLessThan(
      0.001,
    );
    expect(isolatedDistance).toBeGreaterThan(Math.max(...connectedRadii));
  });

  it("keeps every existing coordinate fixed during a stable local expansion", () => {
    const initialNodes: NetworkLayoutNode[] = [
      { key: "concept:focus", type: "concept" },
      { key: "knowledge_point:existing", type: "knowledge_point" },
      { key: "concept:existing-island", type: "concept" },
    ];
    const initialEdges: NetworkLayoutEdge[] = [
      {
        edgeKey: "concept_membership:existing",
        source: "concept:focus",
        target: "knowledge_point:existing",
      },
    ];
    const previous = layoutNetwork(initialNodes, initialEdges);
    const nodes: NetworkLayoutNode[] = [
      ...initialNodes,
      { key: "knowledge_point:new-neighbor", type: "knowledge_point" },
      { key: "knowledge_point:new-leaf", type: "knowledge_point" },
      { key: "concept:new-island", type: "concept" },
    ];
    const edges: NetworkLayoutEdge[] = [
      ...initialEdges,
      {
        edgeKey: "concept_membership:new",
        source: "concept:focus",
        target: "knowledge_point:new-neighbor",
      },
      {
        edgeKey: "knowledge_relation:new",
        source: "knowledge_point:new-neighbor",
        target: "knowledge_point:new-leaf",
      },
    ];

    const expanded = expandNetworkLayout(
      previous,
      nodes,
      edges,
      "concept:focus",
    );
    const reordered = expandNetworkLayout(
      previous,
      [...nodes].reverse(),
      [...edges].reverse(),
      "concept:focus",
    );

    expect(reordered).toEqual(expanded);

    for (const node of initialNodes) {
      expect(expanded.positions[node.key]).toEqual(previous.positions[node.key]);
      expect(
        distance(expanded.positions[node.key]!, previous.positions[node.key]!),
      ).toBe(0);
    }

    const focus = expanded.positions["concept:focus"]!;

    expect(
      distance(focus, expanded.positions["knowledge_point:new-neighbor"]!),
    ).toBeLessThan(
      distance(focus, expanded.positions["concept:new-island"]!),
    );
    expect(expanded.topologyKey).not.toBe(previous.topologyKey);
  });

  it("uses a wide two-dimensional composition for a sparse Concept-first graph", () => {
    const nodes: NetworkLayoutNode[] = Array.from({ length: 7 }, (_, index) => ({
      key: `concept:${String(index).padStart(2, "0")}`,
      type: "concept",
    }));
    const edges: NetworkLayoutEdge[] = [
      {
        edgeKey: "concept_relation:00-01",
        source: "concept:00",
        target: "concept:01",
      },
      {
        edgeKey: "concept_relation:01-02",
        source: "concept:01",
        target: "concept:02",
      },
    ];
    const snapshot = layoutNetwork(nodes, edges);
    const positions = Object.values(snapshot.positions);
    const xSpan = coordinateSpan(positions.map(({ x }) => x));
    const ySpan = coordinateSpan(positions.map(({ y }) => y));
    const center = snapshot.positions["concept:01"]!;
    const connectedXSpread = Math.max(
      Math.abs(snapshot.positions["concept:00"]!.x - center.x),
      Math.abs(snapshot.positions["concept:02"]!.x - center.x),
    );
    const isolatedOffsets = ["concept:03", "concept:04", "concept:05", "concept:06"]
      .map((key) => ({
        x: snapshot.positions[key]!.x - center.x,
        y: snapshot.positions[key]!.y - center.y,
      }));

    expect(xSpan).toBeGreaterThan(ySpan * 0.8);
    expect(connectedXSpread).toBeGreaterThan(80);
    expect(isolatedOffsets.some(({ x }) => x < -250)).toBe(true);
    expect(isolatedOffsets.some(({ x }) => x > 250)).toBe(true);
    expect(isolatedOffsets.some(({ y }) => y < -250)).toBe(true);
    expect(isolatedOffsets.some(({ y }) => y > 250)).toBe(true);
  });

  it("keeps a 300-node and 600-edge layout finite, usable, and within budget", () => {
    const nodes: NetworkLayoutNode[] = Array.from({ length: 300 }, (_, index) => ({
      key: `${index % 5 === 0 ? "concept" : "knowledge_point"}:${String(index).padStart(3, "0")}`,
      type: index % 5 === 0 ? "concept" : "knowledge_point",
    }));
    const edges: NetworkLayoutEdge[] = Array.from({ length: 600 }, (_, index) => {
      const sourceIndex = index % nodes.length;
      const targetIndex =
        (sourceIndex + (index < nodes.length ? 1 : 17)) % nodes.length;

      return {
        edgeKey: `edge:${String(index).padStart(3, "0")}`,
        source: nodes[sourceIndex]!.key,
        target: nodes[targetIndex]!.key,
      };
    });

    layoutNetwork(nodes, edges);
    const durations = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();

      layoutNetwork(nodes, edges);
      return performance.now() - startedAt;
    }).sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    const snapshot = layoutNetwork(nodes, edges);
    const positions = Object.values(snapshot.positions);

    expect(p95).toBeLessThan(250);
    expect(positions).toHaveLength(300);
    expect(
      positions.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)),
    ).toBe(true);

    let minimumDistance = Number.POSITIVE_INFINITY;

    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        minimumDistance = Math.min(
          minimumDistance,
          distance(positions[left]!, positions[right]!),
        );
      }
    }

    expect(minimumDistance).toBeGreaterThanOrEqual(80);
  });
});

function distance(
  first: { x: number; y: number },
  second: { x: number; y: number },
): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function coordinateSpan(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}
