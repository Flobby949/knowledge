import type { NetworkEdge, NetworkNode } from "./api.js";
import type { NetworkLayoutSnapshot } from "./network-layout.js";

export const NETWORK_GRAPH_3D_BUDGET = Object.freeze({
  depthLayers: 7,
  depthStep: 28,
  maxDrawCalls: 6,
  maxEdges: 1_000,
  maxHeapBytes: 64 * 1_024 * 1_024,
  maxNodes: 500,
  maxPixelRatio: 2,
  targetFrameMs: 20,
  targetInteractionMs: 50,
});

export const NETWORK_GRAPH_3D_LABEL_BUDGET = Object.freeze({
  collisionGap: 6,
  denseNodeThreshold: 120,
  maxDenseConceptLabels: 32,
  viewportInset: 8,
});

export interface NetworkGraph3DPosition {
  x: number;
  y: number;
  z: number;
}

export interface NetworkGraph3DRenderNode {
  key: string;
  label: string;
  onPath: boolean;
  position: NetworkGraph3DPosition;
  selected: boolean;
  type: NetworkNode["type"];
}

export interface NetworkGraph3DRenderEdge {
  directed: boolean;
  edgeKey: string;
  kind: NetworkEdge["kind"];
  onPath: boolean;
  relationType: string;
  source: string;
  sourcePosition: NetworkGraph3DPosition;
  target: string;
  targetPosition: NetworkGraph3DPosition;
}

export interface NetworkGraph3DRenderModel {
  budget: {
    drawCalls: number;
    edgeCount: number;
    nodeCount: number;
    withinTarget: boolean;
  };
  edges: NetworkGraph3DRenderEdge[];
  lod: {
    arrowRadialSegments: number;
    conceptHeightSegments: number;
    conceptWidthSegments: number;
  };
  nodes: NetworkGraph3DRenderNode[];
  topologyKey: string;
  version: 1;
}

export type NetworkGraph3DLabelPriority =
  | "concept"
  | "knowledge_point"
  | "path"
  | "selected";

export interface NetworkGraph3DProjectedLabel {
  height: number;
  key: string;
  label: string;
  priority: NetworkGraph3DLabelPriority;
  width: number;
  x: number;
  y: number;
}

export interface NetworkGraph3DPlacedLabel
  extends NetworkGraph3DProjectedLabel {
  left: number;
  top: number;
}

export interface NetworkGraph3DLabelViewport {
  height: number;
  width: number;
}

export type NetworkCameraUpdate =
  | { kind: "focus"; key: string }
  | { kind: "frame" }
  | { kind: "preserve" };

export interface BuildNetworkGraph3DRenderModelOptions {
  edges: readonly NetworkEdge[];
  layout: NetworkLayoutSnapshot;
  nodes: readonly NetworkNode[];
  pathEdgeKeys?: ReadonlySet<string> | readonly string[];
  pathNodeKeys?: ReadonlySet<string> | readonly string[];
  selectedKey?: string | null;
}

/**
 * Adds a shallow, deterministic third dimension without changing the canonical
 * V3.3 x/y layout. The version name is part of the persistence contract.
 */
export function networkDepthV1(typedKey: string): number {
  if (
    !typedKey.startsWith("concept:") &&
    !typedKey.startsWith("knowledge_point:")
  ) {
    throw new Error(`Invalid typed network key: ${typedKey}`);
  }

  const layer =
    stableHash(`network-depth-v1:${typedKey}`) %
    NETWORK_GRAPH_3D_BUDGET.depthLayers;
  const centeredLayer = layer - Math.floor(NETWORK_GRAPH_3D_BUDGET.depthLayers / 2);

  return centeredLayer * NETWORK_GRAPH_3D_BUDGET.depthStep;
}

export function buildNetworkGraph3DRenderModel({
  edges,
  layout,
  nodes,
  pathEdgeKeys = [],
  pathNodeKeys = [],
  selectedKey = null,
}: BuildNetworkGraph3DRenderModelOptions): NetworkGraph3DRenderModel {
  if (layout.version !== 1) {
    throw new Error(`Unsupported network layout version: ${String(layout.version)}`);
  }

  const pathNodes = new Set(pathNodeKeys);
  const pathEdges = new Set(pathEdgeKeys);
  const seenNodeKeys = new Set<string>();
  const renderNodes = [...nodes]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((node): NetworkGraph3DRenderNode => {
      if (seenNodeKeys.has(node.key)) {
        throw new Error(`Duplicate network node key: ${node.key}`);
      }
      seenNodeKeys.add(node.key);

      const position = layout.positions[node.key];

      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        throw new Error(`Missing finite network layout position: ${node.key}`);
      }

      return {
        key: node.key,
        label: node.label,
        onPath: pathNodes.has(node.key),
        position: {
          x: position.x,
          y: position.y,
          z: networkDepthV1(node.key),
        },
        selected: node.key === selectedKey,
        type: node.type,
      };
    });
  const positionByKey = new Map(
    renderNodes.map((node) => [node.key, node.position] as const),
  );
  const seenEdgeKeys = new Set<string>();
  const renderEdges = [...edges]
    .sort((left, right) => {
      const byKey = left.edgeKey.localeCompare(right.edgeKey);

      if (byKey !== 0) {
        return byKey;
      }

      return `${left.source}:${left.target}`.localeCompare(
        `${right.source}:${right.target}`,
      );
    })
    .map((edge): NetworkGraph3DRenderEdge => {
      if (seenEdgeKeys.has(edge.edgeKey)) {
        throw new Error(`Duplicate network edge key: ${edge.edgeKey}`);
      }
      seenEdgeKeys.add(edge.edgeKey);

      const sourcePosition = positionByKey.get(edge.source);
      const targetPosition = positionByKey.get(edge.target);

      if (!sourcePosition || !targetPosition) {
        throw new Error(
          `Network edge ${edge.edgeKey} references a node outside the render model.`,
        );
      }

      return {
        directed: edge.directed,
        edgeKey: edge.edgeKey,
        kind: edge.kind,
        onPath: pathEdges.has(edge.edgeKey),
        relationType: edge.relationType,
        source: edge.source,
        sourcePosition,
        target: edge.target,
        targetPosition,
      };
    });
  const membershipEdgeCount = renderEdges.filter(
    ({ kind }) => kind === "concept_membership",
  ).length;
  const directedEdgeCount = renderEdges.filter(
    ({ directed, kind }) => directed && kind !== "concept_membership",
  ).length;
  const symmetricRelationCount = renderEdges.filter(
    ({ directed, kind }) => !directed && kind !== "concept_membership",
  ).length;
  const conceptCount = renderNodes.filter(({ type }) => type === "concept").length;
  const knowledgePointCount = renderNodes.length - conceptCount;
  const drawCalls =
    Number(conceptCount > 0) +
    Number(knowledgePointCount > 0) +
    Number(membershipEdgeCount > 0) +
    Number(symmetricRelationCount > 0) +
    Number(directedEdgeCount > 0) * 2;
  const dense = renderNodes.length > 350 || renderEdges.length > 700;

  return {
    budget: {
      drawCalls,
      edgeCount: renderEdges.length,
      nodeCount: renderNodes.length,
      withinTarget:
        renderNodes.length <= NETWORK_GRAPH_3D_BUDGET.maxNodes &&
        renderEdges.length <= NETWORK_GRAPH_3D_BUDGET.maxEdges &&
        drawCalls <= NETWORK_GRAPH_3D_BUDGET.maxDrawCalls,
    },
    edges: renderEdges,
    lod: {
      arrowRadialSegments: dense ? 5 : 7,
      conceptHeightSegments: dense ? 6 : 10,
      conceptWidthSegments: dense ? 8 : 14,
    },
    nodes: renderNodes,
    topologyKey: layout.topologyKey,
    version: 1,
  };
}

export function networkGraph3DLabelNodes(
  nodes: readonly NetworkGraph3DRenderNode[],
): NetworkGraph3DRenderNode[] {
  const ordered = [...nodes].sort((left, right) => left.key.localeCompare(right.key));

  if (ordered.length <= NETWORK_GRAPH_3D_LABEL_BUDGET.denseNodeThreshold) {
    return ordered;
  }

  return ordered.filter(
    (node) => node.selected || node.onPath || node.type === "concept",
  );
}

export function placeNetworkGraph3DLabels(
  labels: readonly NetworkGraph3DProjectedLabel[],
  viewport: NetworkGraph3DLabelViewport,
  dense: boolean,
): NetworkGraph3DPlacedLabel[] {
  const placed = labels.map((label) => placeLabelInViewport(label, viewport));

  if (!dense) {
    return placed.sort(comparePlacedLabels);
  }

  const important = placed
    .filter(({ priority }) => priority === "selected" || priority === "path")
    .sort(comparePlacedLabels);
  const occupied = important.map(labelBounds);
  const concepts: NetworkGraph3DPlacedLabel[] = [];

  for (const label of placed
    .filter(({ priority }) => priority === "concept")
    .sort((left, right) => {
      const byRow = Math.round(left.top / 48) - Math.round(right.top / 48);

      if (byRow !== 0) {
        return byRow;
      }

      const byColumn = Math.round(left.left / 96) - Math.round(right.left / 96);

      return byColumn || left.key.localeCompare(right.key);
    })) {
    if (concepts.length >= NETWORK_GRAPH_3D_LABEL_BUDGET.maxDenseConceptLabels) {
      break;
    }

    const bounds = labelBounds(label);

    if (occupied.every((other) => !rectanglesOverlap(bounds, other))) {
      concepts.push(label);
      occupied.push(bounds);
    }
  }

  // Important labels render last and are never removed by collision handling.
  return [...concepts, ...important];
}

export function resolveNetworkCameraUpdate(options: {
  focusedKey: string;
  modelNodeKeys: ReadonlySet<string> | readonly string[];
  selectedKey: string;
}): NetworkCameraUpdate {
  const modelNodeKeys = new Set(options.modelNodeKeys);

  if (options.selectedKey && modelNodeKeys.has(options.selectedKey)) {
    return options.selectedKey === options.focusedKey
      ? { kind: "preserve" }
      : { kind: "focus", key: options.selectedKey };
  }

  if (
    !options.selectedKey &&
    options.focusedKey &&
    !modelNodeKeys.has(options.focusedKey)
  ) {
    return { kind: "frame" };
  }

  return { kind: "preserve" };
}

export type DemandRenderState =
  | "disposed"
  | "failed"
  | "idle"
  | "rendering"
  | "scheduled";

export interface DemandRenderScheduler {
  dispose(): void;
  getState(): DemandRenderState;
  invalidate(): void;
  renderNow(): void;
}

export interface DemandRenderSchedulerOptions {
  cancelFrame: (handle: number) => void;
  now: () => number;
  onError: (error: unknown) => void;
  render: (time: number) => void;
  requestFrame: (callback: (time: number) => void) => number;
}

export function createDemandRenderScheduler({
  cancelFrame,
  now,
  onError,
  render,
  requestFrame,
}: DemandRenderSchedulerOptions): DemandRenderScheduler {
  let frameHandle: number | null = null;
  let rerenderRequested = false;
  let state: DemandRenderState = "idle";

  function fail(error: unknown) {
    frameHandle = null;
    rerenderRequested = false;
    state = "failed";
    onError(error);
  }

  function schedule() {
    state = "scheduled";
    frameHandle = requestFrame((time) => {
      frameHandle = null;
      execute(time);
    });
  }

  function execute(time: number) {
    if (state === "disposed" || state === "failed") {
      return;
    }

    state = "rendering";
    rerenderRequested = false;
    try {
      render(time);
    } catch (error) {
      fail(error);
      return;
    }

    if (rerenderRequested) {
      schedule();
    } else {
      state = "idle";
    }
  }

  return {
    dispose() {
      if (state === "disposed") {
        return;
      }

      if (frameHandle !== null) {
        cancelFrame(frameHandle);
      }
      frameHandle = null;
      rerenderRequested = false;
      state = "disposed";
    },
    getState() {
      return state;
    },
    invalidate() {
      if (state === "disposed" || state === "failed" || state === "scheduled") {
        return;
      }

      if (state === "rendering") {
        rerenderRequested = true;
        return;
      }

      schedule();
    },
    renderNow() {
      if (state === "disposed" || state === "failed") {
        return;
      }

      if (state === "rendering") {
        rerenderRequested = true;
        return;
      }

      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
      execute(now());
    },
  };
}

export interface NetworkDisposable {
  dispose(): void;
}

export type NetworkResourceRegistryState = "active" | "disposed";

export interface NetworkResourceRegistry {
  dispose(): void;
  getState(): NetworkResourceRegistryState;
  size(): number;
  track<T extends NetworkDisposable>(resource: T): T;
}

export function createNetworkResourceRegistry(): NetworkResourceRegistry {
  const resources = new Set<NetworkDisposable>();
  let state: NetworkResourceRegistryState = "active";

  return {
    dispose() {
      if (state === "disposed") {
        return;
      }

      state = "disposed";
      const failures: unknown[] = [];

      for (const resource of [...resources].reverse()) {
        try {
          resource.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      resources.clear();

      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose network graph resources.");
      }
    },
    getState() {
      return state;
    },
    size() {
      return resources.size;
    },
    track<T extends NetworkDisposable>(resource: T): T {
      if (state === "disposed") {
        resource.dispose();
      } else {
        resources.add(resource);
      }

      return resource;
    },
  };
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function comparePlacedLabels(
  left: NetworkGraph3DPlacedLabel,
  right: NetworkGraph3DPlacedLabel,
): number {
  const priorityOrder: Record<NetworkGraph3DLabelPriority, number> = {
    concept: 0,
    knowledge_point: 1,
    path: 2,
    selected: 3,
  };

  return (
    priorityOrder[left.priority] - priorityOrder[right.priority] ||
    left.key.localeCompare(right.key)
  );
}

function labelBounds(label: NetworkGraph3DPlacedLabel) {
  const gap = NETWORK_GRAPH_3D_LABEL_BUDGET.collisionGap;

  return {
    bottom: label.top + label.height + gap,
    left: label.left - gap,
    right: label.left + label.width + gap,
    top: label.top - gap,
  };
}

function placeLabelInViewport(
  label: NetworkGraph3DProjectedLabel,
  viewport: NetworkGraph3DLabelViewport,
): NetworkGraph3DPlacedLabel {
  const inset = NETWORK_GRAPH_3D_LABEL_BUDGET.viewportInset;
  const maximumLeft = Math.max(inset, viewport.width - label.width - inset);
  const maximumTop = Math.max(inset, viewport.height - label.height - inset);

  return {
    ...label,
    left: clamp(label.x - label.width / 2, inset, maximumLeft),
    top: clamp(label.y - label.height - 12, inset, maximumTop),
  };
}

function rectanglesOverlap(
  left: { bottom: number; left: number; right: number; top: number },
  right: { bottom: number; left: number; right: number; top: number },
): boolean {
  return !(
    left.right <= right.left ||
    left.left >= right.right ||
    left.bottom <= right.top ||
    left.top >= right.bottom
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
