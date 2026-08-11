import { describe, expect, it, vi } from "vitest";

import type { NetworkEdge, NetworkNode } from "../../src/client/api.js";
import {
  NETWORK_GRAPH_3D_BUDGET,
  NETWORK_GRAPH_3D_LABEL_BUDGET,
  buildNetworkGraph3DRenderModel,
  createDemandRenderScheduler,
  createNetworkResourceRegistry,
  networkGraph3DLabelNodes,
  networkDepthV1,
  placeNetworkGraph3DLabels,
  resolveNetworkCameraUpdate,
  type DemandRenderScheduler,
  type NetworkGraph3DProjectedLabel,
  type NetworkGraph3DRenderNode,
} from "../../src/client/network-graph-3d-model.js";
import type { NetworkLayoutSnapshot } from "../../src/client/network-layout.js";

describe("real knowledge network 3D render model", () => {
  it("keeps canonical x/y and derives stable bounded depth from typed keys", () => {
    const nodes = [node(0), node(1), node(2)];
    const layout = snapshot(nodes);
    const initial = buildNetworkGraph3DRenderModel({
      edges: [edge(0, nodes[0]!, nodes[1]!)],
      layout,
      nodes,
      pathEdgeKeys: [],
      pathNodeKeys: [],
      selectedKey: nodes[0]!.key,
    });
    const expandedNodes = [...nodes, node(3), node(4)];
    const expandedLayout = snapshot(expandedNodes);
    const expanded = buildNetworkGraph3DRenderModel({
      edges: [
        edge(0, nodes[0]!, nodes[1]!),
        edge(1, nodes[1]!, expandedNodes[3]!),
      ],
      layout: expandedLayout,
      nodes: [...expandedNodes].reverse(),
      pathEdgeKeys: [],
      pathNodeKeys: [],
      selectedKey: nodes[0]!.key,
    });

    for (const sourceNode of nodes) {
      const first = initial.nodes.find(({ key }) => key === sourceNode.key)!;
      const afterExpansion = expanded.nodes.find(
        ({ key }) => key === sourceNode.key,
      )!;
      const canonical = layout.positions[sourceNode.key]!;

      expect(first.position).toEqual(afterExpansion.position);
      expect(first.position.x).toBe(canonical.x);
      expect(first.position.y).toBe(canonical.y);
      expect(first.position.z).toBe(networkDepthV1(sourceNode.key));
      expect(Math.abs(first.position.z)).toBeLessThanOrEqual(
        NETWORK_GRAPH_3D_BUDGET.depthStep * 3,
      );
    }

    const possibleDepths = new Set(
      Array.from({ length: NETWORK_GRAPH_3D_BUDGET.depthLayers }, (_, index) =>
        (index - 3) * NETWORK_GRAPH_3D_BUDGET.depthStep,
      ),
    );

    expect(
      expanded.nodes.every(({ position }) => possibleDepths.has(position.z)),
    ).toBe(true);
    expect(() => networkDepthV1("tag:not-a-network-node")).toThrow(
      "Invalid typed network key",
    );
  });

  it("builds all 500 nodes and 1000 real edges within the bounded draw-call model", () => {
    const nodes = Array.from({ length: 500 }, (_, index) => node(index));
    const edges = Array.from({ length: 1_000 }, (_, index) =>
      edge(
        index,
        nodes[index % nodes.length]!,
        nodes[(index * 17 + 1) % nodes.length]!,
      ),
    );
    const layout = snapshot(nodes);
    const build = () =>
      buildNetworkGraph3DRenderModel({
        edges,
        layout,
        nodes,
        pathEdgeKeys: new Set(edges.slice(0, 9).map(({ edgeKey }) => edgeKey)),
        pathNodeKeys: new Set(nodes.slice(0, 10).map(({ key }) => key)),
        selectedKey: nodes[0]!.key,
      });

    build();
    const durations = Array.from({ length: 5 }, () => {
      const startedAt = performance.now();

      build();
      return performance.now() - startedAt;
    }).sort((left, right) => left - right);
    const model = build();

    expect(durations[durations.length - 1]).toBeLessThan(
      NETWORK_GRAPH_3D_BUDGET.targetInteractionMs,
    );
    expect(model.nodes).toHaveLength(500);
    expect(model.edges).toHaveLength(1_000);
    expect(new Set(model.nodes.map(({ key }) => key)).size).toBe(500);
    expect(new Set(model.edges.map(({ edgeKey }) => edgeKey)).size).toBe(1_000);
    expect(model.budget).toEqual({
      drawCalls: 5,
      edgeCount: 1_000,
      nodeCount: 500,
      withinTarget: true,
    });
    expect(model.lod).toEqual({
      arrowRadialSegments: 5,
      conceptHeightSegments: 6,
      conceptWidthSegments: 8,
    });
    expect(model.nodes.filter(({ onPath }) => onPath)).toHaveLength(10);
    expect(model.edges.filter(({ onPath }) => onPath)).toHaveLength(9);
  });

  it("keeps membership, symmetric, and directed line grammars within six draw calls", () => {
    const nodes = [node(0), node(1), node(2), node(5)];
    const membership: NetworkEdge = {
      confirmation: null,
      description: null,
      directed: false,
      edgeKey: "concept_membership:0000",
      kind: "concept_membership",
      relationType: "membership",
      source: nodes[0]!.key,
      sourceRecord: {
        createdAt: "2026-08-12T00:00:00.000Z",
        id: "membership-0000",
        kind: "concept_membership",
        origin: "manual",
      },
      target: nodes[1]!.key,
    };
    const symmetric = edge(1, nodes[1]!, nodes[2]!);
    const directed = edge(2, nodes[0]!, nodes[3]!);
    const model = buildNetworkGraph3DRenderModel({
      edges: [membership, symmetric, directed],
      layout: snapshot(nodes),
      nodes,
      pathEdgeKeys: [],
      pathNodeKeys: [],
      selectedKey: nodes[0]!.key,
    });

    expect(model.budget).toMatchObject({ drawCalls: 6, withinTarget: true });
    expect(new Set(model.edges.map(({ kind }) => kind))).toEqual(
      new Set(["concept_membership", "knowledge_relation"]),
    );
  });

  it("is input-order invariant and rejects missing coordinates instead of dropping facts", () => {
    const nodes = [node(0), node(1), node(2), node(3)];
    const edges = [
      edge(0, nodes[0]!, nodes[1]!),
      edge(1, nodes[1]!, nodes[2]!),
      edge(2, nodes[2]!, nodes[3]!),
    ];
    const layout = snapshot(nodes);
    const options = {
      edges,
      layout,
      nodes,
      pathEdgeKeys: new Set([edges[1]!.edgeKey]),
      pathNodeKeys: new Set([nodes[1]!.key, nodes[2]!.key]),
      selectedKey: nodes[2]!.key,
    };
    const model = buildNetworkGraph3DRenderModel(options);
    const reordered = buildNetworkGraph3DRenderModel({
      ...options,
      edges: [...edges].reverse(),
      nodes: [...nodes].reverse(),
    });

    expect(reordered).toEqual(model);
    expect(model.nodes).toHaveLength(nodes.length);
    expect(model.edges).toHaveLength(edges.length);
    expect(() =>
      buildNetworkGraph3DRenderModel({
        ...options,
        layout: {
          ...layout,
          positions: { [nodes[0]!.key]: layout.positions[nodes[0]!.key]! },
        },
      }),
    ).toThrow("Missing finite network layout position");
  });

  it("shows every low-density label and keeps dense selected/path labels complete", () => {
    const lowDensityNodes = Array.from({ length: 100 }, (_, index) =>
      renderNode(index),
    );
    const lowDensityLabels = networkGraph3DLabelNodes(lowDensityNodes).map(
      (renderNode, index): NetworkGraph3DProjectedLabel => ({
        height: 28,
        key: renderNode.key,
        label: renderNode.label,
        priority: renderNode.type,
        width: 120,
        x: 20 + (index % 10) * 140,
        y: 40 + Math.floor(index / 10) * 80,
      }),
    );

    expect(networkGraph3DLabelNodes(lowDensityNodes)).toHaveLength(100);
    expect(
      placeNetworkGraph3DLabels(
        lowDensityLabels,
        { height: 1_000, width: 1_600 },
        false,
      ),
    ).toHaveLength(100);

    const denseNodes = Array.from({ length: 500 }, (_, index) =>
      renderNode(index, {
        onPath: index === 103 || index === 207,
        selected: index === 499,
      }),
    );
    const denseCandidates = networkGraph3DLabelNodes(denseNodes);
    const projected = denseCandidates.map(
      (renderNode, index): NetworkGraph3DProjectedLabel => ({
        height: renderNode.selected || renderNode.onPath ? 44 : 28,
        key: renderNode.key,
        label: renderNode.label,
        priority: renderNode.selected
          ? "selected"
          : renderNode.onPath
            ? "path"
            : renderNode.type,
        width: renderNode.selected || renderNode.onPath ? 240 : 120,
        x: 30 + (index % 12) * 130,
        y: 50 + Math.floor(index / 12) * 82,
      }),
    );
    const placed = placeNetworkGraph3DLabels(
      projected,
      { height: 1_000, width: 1_600 },
      true,
    );
    const important = denseNodes.filter(
      ({ onPath, selected }) => onPath || selected,
    );

    expect(denseCandidates.every(
      ({ onPath, selected, type }) => selected || onPath || type === "concept",
    )).toBe(true);
    expect(
      important.every(({ key, label }) =>
        placed.some(
          (placedLabel) =>
            placedLabel.key === key && placedLabel.label === label,
        ),
      ),
    ).toBe(true);
    expect(
      placed.filter(({ priority }) => priority === "concept").length,
    ).toBeLessThanOrEqual(
      NETWORK_GRAPH_3D_LABEL_BUDGET.maxDenseConceptLabels,
    );
    expect(
      placed.some(({ priority }) => priority === "knowledge_point"),
    ).toBe(false);
  });

  it("reframes only when a cleared selection leaves its focused node outside the model", () => {
    const conceptKey = "concept:0000";
    const pointKey = "knowledge_point:0001";

    expect(
      resolveNetworkCameraUpdate({
        focusedKey: "",
        modelNodeKeys: [conceptKey, pointKey],
        selectedKey: pointKey,
      }),
    ).toEqual({ kind: "focus", key: pointKey });
    expect(
      resolveNetworkCameraUpdate({
        focusedKey: pointKey,
        modelNodeKeys: [conceptKey, pointKey],
        selectedKey: "",
      }),
    ).toEqual({ kind: "preserve" });
    expect(
      resolveNetworkCameraUpdate({
        focusedKey: pointKey,
        modelNodeKeys: [conceptKey],
        selectedKey: "",
      }),
    ).toEqual({ kind: "frame" });
    expect(
      resolveNetworkCameraUpdate({
        focusedKey: conceptKey,
        modelNodeKeys: [conceptKey],
        selectedKey: "",
      }),
    ).toEqual({ kind: "preserve" });
  });
});

describe("demand render and resource lifecycle", () => {
  it("coalesces invalidations, honors a render-time invalidation, and becomes idle", () => {
    const frames = new Map<number, (time: number) => void>();
    const cancelled: number[] = [];
    let nextHandle = 1;
    let renderCount = 0;
    let scheduler!: DemandRenderScheduler;

    scheduler = createDemandRenderScheduler({
      cancelFrame(handle) {
        cancelled.push(handle);
        frames.delete(handle);
      },
      now: () => 50,
      onError: vi.fn(),
      render() {
        renderCount += 1;
        if (renderCount === 1) {
          scheduler.invalidate();
        }
      },
      requestFrame(callback) {
        const handle = nextHandle;

        nextHandle += 1;
        frames.set(handle, callback);
        return handle;
      },
    });

    scheduler.invalidate();
    scheduler.invalidate();
    expect(scheduler.getState()).toBe("scheduled");
    expect(frames.size).toBe(1);

    flushFirst(frames, 16);
    expect(renderCount).toBe(1);
    expect(scheduler.getState()).toBe("scheduled");
    expect(frames.size).toBe(1);

    flushFirst(frames, 32);
    expect(renderCount).toBe(2);
    expect(scheduler.getState()).toBe("idle");
    expect(frames.size).toBe(0);

    scheduler.invalidate();
    scheduler.renderNow();
    expect(renderCount).toBe(3);
    expect(cancelled).toHaveLength(1);
    expect(scheduler.getState()).toBe("idle");

    scheduler.dispose();
    scheduler.invalidate();
    expect(scheduler.getState()).toBe("disposed");
    expect(frames.size).toBe(0);
  });

  it("fails once on a frame exception and disposes each resource exactly once", () => {
    const errors: unknown[] = [];
    const scheduled: { frame?: (time: number) => void } = {};
    const scheduler = createDemandRenderScheduler({
      cancelFrame: vi.fn(),
      now: () => 0,
      onError: (error) => errors.push(error),
      render() {
        throw new Error("gpu frame failed");
      },
      requestFrame(callback) {
        scheduled.frame = callback;
        return 1;
      },
    });

    scheduler.invalidate();
    expect(scheduled.frame).toBeTypeOf("function");
    scheduled.frame!(16);
    scheduler.invalidate();
    expect(scheduler.getState()).toBe("failed");
    expect(errors).toHaveLength(1);

    const registry = createNetworkResourceRegistry();
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };

    registry.track(first);
    registry.track(first);
    registry.track(second);
    expect(registry.size()).toBe(2);
    registry.dispose();
    registry.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(registry.getState()).toBe("disposed");

    const late = { dispose: vi.fn() };

    registry.track(late);
    expect(late.dispose).toHaveBeenCalledTimes(1);
  });
});

function flushFirst(
  frames: Map<number, (time: number) => void>,
  time: number,
) {
  const entry = frames.entries().next().value as
    | [number, (time: number) => void]
    | undefined;

  if (!entry) {
    throw new Error("Expected a scheduled frame.");
  }
  frames.delete(entry[0]);
  entry[1](time);
}

function node(index: number): NetworkNode {
  const concept = index % 5 === 0;
  const id = String(index).padStart(4, "0");

  return concept
    ? {
        description: `Concept ${id}`,
        id,
        key: `concept:${id}`,
        label: `Concept ${id}`,
        source: {
          kind: "concept_revision",
          revisionId: `revision-${id}`,
          revisionNumber: 1,
        },
        type: "concept",
      }
    : {
        description: `Knowledge point ${id}`,
        id,
        key: `knowledge_point:${id}`,
        label: `Knowledge point ${id}`,
        source: {
          analysisRevisionId: `analysis-${id}`,
          fragmentRevisionId: `fragment-${id}`,
          kind: "knowledge_point",
          recordId: `record-${id}`,
          recordTitle: `Record ${id}`,
        },
        type: "knowledge_point",
      };
}

function edge(
  index: number,
  source: NetworkNode,
  target: NetworkNode,
): NetworkEdge {
  const id = String(index).padStart(4, "0");

  return {
    confirmation: {
      confirmedAt: "2026-08-12T00:00:00.000Z",
      id: `confirmation-${id}`,
      relationId: `relation-${id}`,
    },
    description: null,
    directed: index % 2 === 0,
    edgeKey: `knowledge_relation:${id}`,
    kind: "knowledge_relation",
    relationType: index % 2 === 0 ? "extends" : "similar",
    source: source.key,
    sourceRecord: {
      confidence: 1,
      confirmedAt: "2026-08-12T00:00:00.000Z",
      id: `confirmation-${id}`,
      kind: "knowledge_relation_confirmation",
      reason: "Test fixture",
      relationId: `relation-${id}`,
    },
    target: target.key,
  };
}

function snapshot(nodes: readonly NetworkNode[]): NetworkLayoutSnapshot {
  return {
    positions: Object.fromEntries(
      nodes.map((sourceNode, index) => [
        sourceNode.key,
        { x: (index % 25) * 112, y: Math.floor(index / 25) * 112 },
      ]),
    ),
    topologyKey: `test:${nodes.length}`,
    version: 1,
  };
}

function renderNode(
  index: number,
  state: { onPath?: boolean; selected?: boolean } = {},
): NetworkGraph3DRenderNode {
  const concept = index % 5 === 0;
  const id = String(index).padStart(4, "0");

  return {
    key: `${concept ? "concept" : "knowledge_point"}:${id}`,
    label: `完整节点名称 ${id} 不允许被 LOD 截断`,
    onPath: state.onPath ?? false,
    position: { x: index * 4, y: index * 2, z: networkDepthV1(
      `${concept ? "concept" : "knowledge_point"}:${id}`,
    ) },
    selected: state.selected ?? false,
    type: concept ? "concept" : "knowledge_point",
  };
}
