export interface NetworkLayoutNode {
  key: string;
  type: "concept" | "knowledge_point";
}

export interface NetworkLayoutEdge {
  edgeKey: string;
  source: string;
  target: string;
}

export interface NetworkPosition {
  x: number;
  y: number;
}

export interface NetworkLayoutSnapshot {
  version: 1;
  topologyKey: string;
  positions: Record<string, NetworkPosition>;
}

const NODE_SEPARATION = 112;
const LAYER_GAP = 176;
const COMPONENT_GAP = 240;
const EXPANSION_LAYER_GAP = 160;
const MIN_NODE_DISTANCE = 96;
const FNV_OFFSET = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;

export function networkTopologyKey(
  nodes: readonly NetworkLayoutNode[],
  edges: readonly NetworkLayoutEdge[],
): string {
  const canonical = JSON.stringify({
    nodes: [...nodes]
      .sort(compareNodes)
      .map(({ key, type }) => [key, type]),
    edges: [...edges]
      .sort(compareEdges)
      .map(({ edgeKey, source, target }) => [edgeKey, source, target]),
  });
  let hash = FNV_OFFSET;

  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }

  return `network-layout-v1:${hash.toString(16).padStart(16, "0")}`;
}

export function layoutNetwork(
  nodes: readonly NetworkLayoutNode[],
  edges: readonly NetworkLayoutEdge[],
): NetworkLayoutSnapshot {
  const orderedNodes = uniqueNodes(nodes);
  const adjacency = buildAdjacency(orderedNodes, edges);
  const components = connectedComponents(orderedNodes, adjacency).map(
    (keys) => layoutComponent(keys, orderedNodes, adjacency),
  );

  return {
    version: 1,
    topologyKey: networkTopologyKey(nodes, edges),
    positions: packComponents(components),
  };
}

export function expandNetworkLayout(
  previous: NetworkLayoutSnapshot,
  nodes: readonly NetworkLayoutNode[],
  edges: readonly NetworkLayoutEdge[],
  focusKey: string,
): NetworkLayoutSnapshot {
  const orderedNodes = uniqueNodes(nodes);
  const currentKeys = new Set(orderedNodes.map(({ key }) => key));
  const positions = new Map<string, NetworkPosition>();

  for (const key of [...currentKeys].sort()) {
    const previousPosition = previous.positions[key];

    if (previousPosition) {
      positions.set(key, { ...previousPosition });
    }
  }

  if (positions.size === 0) {
    return layoutNetwork(nodes, edges);
  }

  const newKeys = new Set(
    orderedNodes
      .map(({ key }) => key)
      .filter((key) => !positions.has(key)),
  );
  const adjacency = buildAdjacency(orderedNodes, edges);
  const assignments = assignExpansionLayers(
    adjacency,
    newKeys,
    new Set(positions.keys()),
    focusKey,
  );
  const occupied = [...positions.values()];
  const byAnchor = new Map<
    string,
    Map<number, string[]>
  >();

  for (const [key, assignment] of assignments) {
    const layers = byAnchor.get(assignment.anchor) ?? new Map<number, string[]>();
    const layer = layers.get(assignment.depth) ?? [];

    layer.push(key);
    layers.set(assignment.depth, layer);
    byAnchor.set(assignment.anchor, layers);
  }

  for (const anchor of [...byAnchor.keys()].sort((left, right) => {
    if (left === focusKey) {
      return -1;
    }

    if (right === focusKey) {
      return 1;
    }

    return left.localeCompare(right);
  })) {
    const anchorPosition = positions.get(anchor)!;
    const layers = byAnchor.get(anchor)!;
    let previousRadius = 0;

    for (const depth of [...layers.keys()].sort((left, right) => left - right)) {
      const layer = layers.get(depth)!.sort();
      const circumferenceRadius =
        (layer.length * NODE_SEPARATION) / (Math.PI * 2);
      const radius = Math.max(
        previousRadius + EXPANSION_LAYER_GAP,
        circumferenceRadius,
      );

      layer.forEach((key, index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / layer.length;
        const position = findOpenPosition(
          anchorPosition,
          radius,
          angle,
          occupied,
        );

        positions.set(key, position);
        occupied.push(position);
      });
      previousRadius = radius;
    }
  }

  const unanchoredKeys = [...newKeys]
    .filter((key) => !assignments.has(key))
    .sort();

  if (unanchoredKeys.length > 0) {
    placeUnanchoredNodes(
      positions,
      orderedNodes,
      edges,
      new Set(unanchoredKeys),
    );
  }

  return {
    version: 1,
    topologyKey: networkTopologyKey(nodes, edges),
    positions: Object.fromEntries(
      [...positions].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function assignExpansionLayers(
  adjacency: Map<string, string[]>,
  newKeys: Set<string>,
  anchors: Set<string>,
  focusKey: string,
): Map<string, { anchor: string; depth: number }> {
  const orderedAnchors = [...anchors].sort((left, right) => {
    if (left === focusKey) {
      return -1;
    }

    if (right === focusKey) {
      return 1;
    }

    return left.localeCompare(right);
  });
  const queue = orderedAnchors.map((key) => ({
    anchor: key,
    depth: 0,
    key,
  }));
  const assignments = new Map<string, { anchor: string; depth: number }>();

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;

    for (const neighbor of adjacency.get(current.key) ?? []) {
      if (!newKeys.has(neighbor) || assignments.has(neighbor)) {
        continue;
      }

      const assignment = {
        anchor: current.anchor,
        depth: current.depth + 1,
      };

      assignments.set(neighbor, assignment);
      queue.push({ ...assignment, key: neighbor });
    }
  }

  return assignments;
}

function findOpenPosition(
  anchor: NetworkPosition,
  desiredRadius: number,
  desiredAngle: number,
  occupied: readonly NetworkPosition[],
): NetworkPosition {
  const angleSlots = 24;

  for (let ring = 0; ring < 24; ring += 1) {
    const radius = desiredRadius + ring * NODE_SEPARATION;

    for (let offset = 0; offset < angleSlots; offset += 1) {
      const signedOffset =
        offset === 0 ? 0 : Math.ceil(offset / 2) * (offset % 2 === 0 ? -1 : 1);
      const angle =
        desiredAngle + (signedOffset * Math.PI * 2) / angleSlots;
      const candidate = {
        x: roundCoordinate(anchor.x + radius * Math.cos(angle)),
        y: roundCoordinate(anchor.y + radius * Math.sin(angle)),
      };

      if (
        occupied.every(
          (position) =>
            Math.hypot(candidate.x - position.x, candidate.y - position.y) >=
            MIN_NODE_DISTANCE,
        )
      ) {
        return candidate;
      }
    }
  }

  return {
    x: roundCoordinate(anchor.x + desiredRadius + COMPONENT_GAP),
    y: roundCoordinate(anchor.y + occupied.length * NODE_SEPARATION),
  };
}

function placeUnanchoredNodes(
  positions: Map<string, NetworkPosition>,
  nodes: readonly NetworkLayoutNode[],
  edges: readonly NetworkLayoutEdge[],
  unanchoredKeys: Set<string>,
): void {
  const unanchoredNodes = nodes.filter(({ key }) => unanchoredKeys.has(key));
  const unanchoredEdges = edges.filter(
    ({ source, target }) =>
      unanchoredKeys.has(source) && unanchoredKeys.has(target),
  );
  const layout = layoutNetwork(unanchoredNodes, unanchoredEdges);
  const newBounds = positionBounds(Object.values(layout.positions));
  const occupiedBounds = positionBounds([...positions.values()]);
  const shiftX = occupiedBounds.maxX + COMPONENT_GAP - newBounds.minX;
  const shiftY =
    (occupiedBounds.minY + occupiedBounds.maxY) / 2 -
    (newBounds.minY + newBounds.maxY) / 2;

  for (const [key, position] of Object.entries(layout.positions)) {
    positions.set(key, {
      x: roundCoordinate(position.x + shiftX),
      y: roundCoordinate(position.y + shiftY),
    });
  }
}

function positionBounds(positions: readonly NetworkPosition[]) {
  return {
    maxX: Math.max(...positions.map(({ x }) => x)),
    maxY: Math.max(...positions.map(({ y }) => y)),
    minX: Math.min(...positions.map(({ x }) => x)),
    minY: Math.min(...positions.map(({ y }) => y)),
  };
}

interface LayoutComponent {
  bounds: { height: number; minX: number; minY: number; width: number };
  key: string;
  positions: Map<string, NetworkPosition>;
}

function uniqueNodes(
  nodes: readonly NetworkLayoutNode[],
): NetworkLayoutNode[] {
  const byKey = new Map<string, NetworkLayoutNode>();

  for (const node of [...nodes].sort(compareNodes)) {
    if (!byKey.has(node.key)) {
      byKey.set(node.key, node);
    }
  }

  return [...byKey.values()];
}

function buildAdjacency(
  nodes: readonly NetworkLayoutNode[],
  edges: readonly NetworkLayoutEdge[],
): Map<string, string[]> {
  const neighbors = new Map(
    nodes.map(({ key }) => [key, new Set<string>()]),
  );

  for (const edge of [...edges].sort(compareEdges)) {
    if (
      edge.source === edge.target ||
      !neighbors.has(edge.source) ||
      !neighbors.has(edge.target)
    ) {
      continue;
    }

    neighbors.get(edge.source)!.add(edge.target);
    neighbors.get(edge.target)!.add(edge.source);
  }

  return new Map(
    [...neighbors].map(([key, values]) => [key, [...values].sort()]),
  );
}

function connectedComponents(
  nodes: readonly NetworkLayoutNode[],
  adjacency: Map<string, string[]>,
): string[][] {
  const unseen = new Set(nodes.map(({ key }) => key));
  const components: string[][] = [];

  for (const { key } of nodes) {
    if (!unseen.delete(key)) {
      continue;
    }

    const component: string[] = [];
    const queue = [key];

    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;

      component.push(current);

      for (const neighbor of adjacency.get(current) ?? []) {
        if (unseen.delete(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    component.sort();
    components.push(component);
  }

  return components;
}

function layoutComponent(
  keys: string[],
  nodes: readonly NetworkLayoutNode[],
  adjacency: Map<string, string[]>,
): LayoutComponent {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const root = [...keys].sort((left, right) => {
    const degreeDifference =
      (adjacency.get(right)?.length ?? 0) -
      (adjacency.get(left)?.length ?? 0);

    if (degreeDifference !== 0) {
      return degreeDifference;
    }

    const typeDifference =
      Number(nodeByKey.get(left)?.type !== "concept") -
      Number(nodeByKey.get(right)?.type !== "concept");

    return typeDifference || left.localeCompare(right);
  })[0]!;
  const layers = breadthFirstLayers(root, adjacency);
  const positions = new Map<string, NetworkPosition>([
    [root, { x: 0, y: 0 }],
  ]);
  let previousRadius = 0;

  for (let depth = 1; depth < layers.length; depth += 1) {
    const layer = layers[depth] ?? [];

    if (layer.length === 0) {
      continue;
    }

    const circumferenceRadius =
      (layer.length * NODE_SEPARATION) / (Math.PI * 2);
    const radius = Math.max(previousRadius + LAYER_GAP, circumferenceRadius);

    layer.forEach((key, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / layer.length;

      positions.set(key, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
    });
    previousRadius = radius;
  }

  return {
    bounds: componentBounds(positions),
    key: keys[0]!,
    positions,
  };
}

function breadthFirstLayers(
  root: string,
  adjacency: Map<string, string[]>,
): string[][] {
  const layers = [[root]];
  const visited = new Set([root]);

  for (let depth = 0; depth < layers.length; depth += 1) {
    const next: string[] = [];

    for (const key of layers[depth] ?? []) {
      for (const neighbor of adjacency.get(key) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }

    if (next.length > 0) {
      next.sort();
      layers.push(next);
    }
  }

  return layers;
}

function componentBounds(positions: Map<string, NetworkPosition>) {
  const values = [...positions.values()];
  const minX = Math.min(...values.map(({ x }) => x)) - NODE_SEPARATION / 2;
  const maxX = Math.max(...values.map(({ x }) => x)) + NODE_SEPARATION / 2;
  const minY = Math.min(...values.map(({ y }) => y)) - NODE_SEPARATION / 2;
  const maxY = Math.max(...values.map(({ y }) => y)) + NODE_SEPARATION / 2;

  return { height: maxY - minY, minX, minY, width: maxX - minX };
}

function packComponents(
  components: readonly LayoutComponent[],
): Record<string, NetworkPosition> {
  if (components.length === 0) {
    return {};
  }

  const ordered = [...components].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
  const totalArea = ordered.reduce(
    (sum, { bounds }) => sum + bounds.width * bounds.height,
    0,
  );
  const targetWidth = Math.max(
    ...ordered.map(({ bounds }) => bounds.width),
    Math.sqrt(totalArea) * 1.4,
  );
  const packed = new Map<string, NetworkPosition>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let packedWidth = 0;

  for (const component of ordered) {
    if (
      cursorX > 0 &&
      cursorX + component.bounds.width > targetWidth
    ) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_GAP;
      rowHeight = 0;
    }

    const offsetX = cursorX - component.bounds.minX;
    const offsetY = cursorY - component.bounds.minY;

    for (const [key, position] of component.positions) {
      packed.set(key, {
        x: position.x + offsetX,
        y: position.y + offsetY,
      });
    }

    cursorX += component.bounds.width + COMPONENT_GAP;
    rowHeight = Math.max(rowHeight, component.bounds.height);
    packedWidth = Math.max(packedWidth, cursorX - COMPONENT_GAP);
  }

  const packedHeight = cursorY + rowHeight;

  return Object.fromEntries(
    [...packed]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, position]) => [
        key,
        {
          x: roundCoordinate(position.x - packedWidth / 2),
          y: roundCoordinate(position.y - packedHeight / 2),
        },
      ]),
  );
}

function compareNodes(
  left: NetworkLayoutNode,
  right: NetworkLayoutNode,
): number {
  return left.key.localeCompare(right.key) || left.type.localeCompare(right.type);
}

function compareEdges(
  left: NetworkLayoutEdge,
  right: NetworkLayoutEdge,
): number {
  return (
    left.edgeKey.localeCompare(right.edgeKey) ||
    left.source.localeCompare(right.source) ||
    left.target.localeCompare(right.target)
  );
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
