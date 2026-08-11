/*
 * THESIS: The Knowledge Network is a cartographer's proof sheet for confirmed facts, not a cloud of related cards or an AI-generated constellation.
 * OWN-WORLD: One continuous paper-white SVG map, concentric Concept stations, square Knowledge Point ports, and three auditable line grammars inherit strawberry or electric-blue ink from the active workbench theme.
 * STORY: Start from stable Concepts, search or select one to unfold its current Knowledge Points, inspect its source, then trace a server-verified path step by step.
 * FIRST VIEWPORT: A compact title/search band and cartographic controls sit above the full map; path findings form a narrow docket below, while a selected node opens a 480px verification drawer without recomputing the map.
 * FORM: Operate-mode knowledge cartography desk; precisely pinned structure inside the established dual-theme world, with no decorative or inferred edges.
 */
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  getNetworkPath,
  getNetworkSubgraph,
  searchNetworkNodes,
  type NetworkEdge,
  type NetworkEdgeKind,
  type NetworkNode,
  type NetworkNodeType,
  type NetworkPath,
  type NetworkTraversalDirection,
} from "./api.js";
import type {
  NetworkLayoutSnapshot,
  NetworkPosition,
} from "./network-layout.js";
import type {
  NetworkLayoutWorkerRequest,
  NetworkLayoutWorkerResponse,
} from "./network-layout-worker.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./network-page.css";

const NODE_TYPES = ["concept", "knowledge_point"] as const;
const EDGE_KINDS = [
  "concept_membership",
  "concept_relation",
  "knowledge_relation",
] as const;
const TYPED_KEY_PATTERN =
  /^(concept|knowledge_point):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type NetworkView = "graph" | "list";

interface NetworkGraphState {
  edges: NetworkEdge[];
  nodes: NetworkNode[];
  truncated: boolean;
}

export interface NetworkCanvasProps {
  edges: NetworkEdge[];
  nodes: NetworkNode[];
  onSelect: (node: NetworkNode) => void;
  path: NetworkPath | null;
  positions: Record<string, NetworkPosition>;
  selectedKey: string;
  focusedKey: string;
}

export function NetworkPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = validTypedKey(searchParams.get("node"));
  const fromKey = validTypedKey(searchParams.get("from"));
  const toKey = validTypedKey(searchParams.get("to"));
  const query = (searchParams.get("q") ?? "").trim();
  const view: NetworkView =
    searchParams.get("view") === "list" ? "list" : "graph";
  const nodeTypes = readRepeatedFilter(
    searchParams,
    "type",
    NODE_TYPES,
  );
  const edgeKinds = readRepeatedFilter(
    searchParams,
    "relation",
    EDGE_KINDS,
  );
  const [graph, setGraph] = useState<NetworkGraphState>({
    edges: [],
    nodes: [],
    truncated: false,
  });
  const [path, setPath] = useState<NetworkPath | null>(null);
  const [pathResolved, setPathResolved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pathLoading, setPathLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [pathError, setPathError] = useState("");
  const [layout, setLayout] = useState<NetworkLayoutSnapshot | null>(null);
  const layoutRef = useRef<NetworkLayoutSnapshot | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(false);
  const [rendererFailure, setRendererFailure] = useState("");
  const [focusedKey, setFocusedKey] = useState("");
  const [selectedPreview, setSelectedPreview] = useState<NetworkNode | null>(
    null,
  );
  const [queryDraft, setQueryDraft] = useState(query);
  const [searchItems, setSearchItems] = useState<NetworkNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(Boolean(query));
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const drawerOpenedHere = useRef(false);
  const drawerEntryMutated = useRef(false);

  const nodeByKey = useMemo(
    () => new Map(graph.nodes.map((node) => [node.key, node])),
    [graph.nodes],
  );
  const selectedNode =
    nodeByKey.get(selectedKey) ??
    (selectedPreview?.key === selectedKey ? selectedPreview : null);
  const pathNodeKeys = useMemo(
    () => new Set(path?.nodes.map(({ key }) => key) ?? []),
    [path],
  );
  const pathEdgeKeys = useMemo(
    () => new Set(path?.steps.map(({ edgeKey }) => edgeKey) ?? []),
    [path],
  );
  const visibleNodes = useMemo(
    () =>
      graph.nodes.filter(
        (node) => nodeTypes.has(node.type) || pathNodeKeys.has(node.key),
      ),
    [graph.nodes, nodeTypes, pathNodeKeys],
  );
  const visibleNodeKeys = useMemo(
    () => new Set(visibleNodes.map(({ key }) => key)),
    [visibleNodes],
  );
  const visibleEdges = useMemo(
    () =>
      graph.edges.filter(
        (edge) =>
          pathEdgeKeys.has(edge.edgeKey) ||
          (edgeKinds.has(edge.kind) &&
            visibleNodeKeys.has(edge.source) &&
            visibleNodeKeys.has(edge.target)),
      ),
    [edgeKinds, graph.edges, pathEdgeKeys, visibleNodeKeys],
  );
  const searchType: "all" | NetworkNodeType =
    nodeTypes.size === 1 ? ([...nodeTypes][0] ?? "concept") : "all";

  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const roots = [...new Set([selectedKey, fromKey, toKey].filter(Boolean))];

    setLoading(true);
    setLoadError("");
    setPath(null);
    setPathError("");
    setPathLoading(Boolean(fromKey && toKey));
    setPathResolved(false);

    void (async () => {
      try {
        const graphPromise = Promise.all([
          getNetworkSubgraph({ signal: controller.signal }),
          ...roots.map((root) =>
            getNetworkSubgraph({
              depth: 1,
              root,
              signal: controller.signal,
            }),
          ),
        ]);
        const pathPromise =
          fromKey && toKey
            ? getNetworkPath({
                from: fromKey,
                maxDepth: 6,
                signal: controller.signal,
                to: toKey,
              })
                .then((result) => ({ result }))
                .catch((error: unknown) => ({ error }))
            : Promise.resolve(null);
        const [graphs, pathOutcome] = await Promise.all([
          graphPromise,
          pathPromise,
        ]);

        if (!active) {
          return;
        }

        if (pathOutcome && "error" in pathOutcome) {
          if (!isAbortError(pathOutcome.error)) {
            setPathError(
              messageFrom(pathOutcome.error, "路径暂时无法探索，请缩短范围后重试。"),
            );
          }
          setPath(null);
        } else {
          const nextPath = pathOutcome?.result.path ?? null;

          setPath(nextPath);
          setPathResolved(Boolean(pathOutcome));
          if (nextPath) {
            graphs.push({
              edges: nextPath.edges,
              limits: { depth: 6, edgeLimit: 600, nodeLimit: 1_000 },
              nodes: nextPath.nodes,
              root: null,
              truncated: false,
              truncation: { edges: false, nodes: false },
            });
          }
        }

        setGraph(mergeGraphs(graphs));
      } catch (caught) {
        if (active && !isAbortError(caught)) {
          setLoadError(
            messageFrom(caught, "知识网络暂时无法载入，请稍后重试。"),
          );
        }
      } finally {
        if (active) {
          setLoading(false);
          setPathLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [fromKey, selectedKey, toKey]);

  useEffect(() => {
    if (!query) {
      setSearchItems([]);
      setSearchError("");
      setSearchLoading(false);
      setSearchTruncated(false);
      return;
    }

    let active = true;
    const controller = new AbortController();
    setSearchItems([]);
    setSearchLoading(true);
    setSearchError("");
    setSearchTruncated(false);
    setSearchOpen(true);
    void searchNetworkNodes({
      limit: 12,
      query,
      signal: controller.signal,
      type: searchType,
    })
      .then(({ items, truncated }) => {
        if (active) {
          setSearchItems(items);
          setSearchTruncated(truncated);
        }
      })
      .catch((caught: unknown) => {
        if (active && !isAbortError(caught)) {
          setSearchError(
            messageFrom(caught, "网络节点搜索失败，请修改关键词后重试。"),
          );
        }
      })
      .finally(() => {
        if (active) {
          setSearchLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [query, searchType]);

  const fallBackToList = useCallback(
    (_reason: string) => {
      if (selectedKey) {
        drawerEntryMutated.current = true;
      }
      setRendererFailure(
        "图形渲染不可用，已切换到等价列表。所有查询状态均已保留。",
      );
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          next.set("view", "list");
          return next;
        },
        { replace: true },
      );
    },
    [selectedKey, setSearchParams],
  );

  useEffect(() => {
    if (
      view !== "graph" ||
      rendererFailure ||
      graph.nodes.length === 0
    ) {
      return;
    }

    let active = true;
    let worker: Worker;

    setLayoutLoading(true);
    try {
      worker = new Worker(
        new URL("./network-layout-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (caught) {
      setLayoutLoading(false);
      fallBackToList(messageFrom(caught, "布局 Worker 无法启动。"));
      return;
    }

    worker.onmessage = (event: MessageEvent<NetworkLayoutWorkerResponse>) => {
      if (!active) {
        return;
      }

      if (event.data.type === "error") {
        setLayoutLoading(false);
        fallBackToList(event.data.error);
        return;
      }

      layoutRef.current = event.data.snapshot;
      setLayout(event.data.snapshot);
      setLayoutLoading(false);
    };
    worker.onerror = () => {
      if (active) {
        setLayoutLoading(false);
        fallBackToList("布局 Worker 执行失败。");
      }
    };

    const common = {
      nodes: graph.nodes.map(({ key, type }) => ({ key, type })),
      edges: graph.edges.map(({ edgeKey, source, target }) => ({
        edgeKey,
        source,
        target,
      })),
    };
    const focusKey = selectedKey || toKey || fromKey;
    const request: NetworkLayoutWorkerRequest =
      layoutRef.current && focusKey
        ? {
            type: "expand",
            ...common,
            focusKey,
            previous: layoutRef.current,
          }
        : { type: "initial", ...common };

    worker.postMessage(request);

    return () => {
      active = false;
      worker.terminate();
    };
  }, [fallBackToList, fromKey, graph.edges, graph.nodes, rendererFailure, selectedKey, toKey, view]);

  useEffect(() => {
    if (!selectedKey) {
      setSelectedPreview(null);
      drawerOpenedHere.current = false;
      drawerEntryMutated.current = false;
    }
  }, [selectedKey]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && selectedKey) {
        closeDrawer();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  function updateParams(
    mutate: (next: URLSearchParams) => void,
    options: { drawerMutation?: boolean; replace?: boolean } = {},
  ) {
    const mutatesDrawerEntry =
      Boolean(selectedKey) && (options.drawerMutation ?? true);

    if (mutatesDrawerEntry) {
      drawerEntryMutated.current = true;
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);

        mutate(next);
        return next;
      },
      { replace: options.replace ?? mutatesDrawerEntry },
    );
  }

  function openNode(node: NetworkNode) {
    const alreadyOpen = Boolean(selectedKey);

    setSelectedPreview(node);
    setFocusedKey(node.key);
    setSearchOpen(false);
    if (!alreadyOpen) {
      drawerOpenedHere.current = true;
      drawerEntryMutated.current = false;
    }
    updateParams(
      (next) => next.set("node", node.key),
      { drawerMutation: false, replace: alreadyOpen },
    );
  }

  function closeDrawer() {
    if (drawerOpenedHere.current && !drawerEntryMutated.current) {
      drawerOpenedHere.current = false;
      drawerEntryMutated.current = false;
      navigate(-1);
      return;
    }

    drawerOpenedHere.current = false;
    drawerEntryMutated.current = false;
    updateParams((next) => next.delete("node"), {
      drawerMutation: false,
      replace: true,
    });
  }

  function submitSearch() {
    const nextQuery = queryDraft.trim().slice(0, 200);

    updateParams((next) => {
      if (nextQuery) {
        next.set("q", nextQuery);
      } else {
        next.delete("q");
      }
    });
    setSearchOpen(Boolean(nextQuery));
  }

  function setEndpoint(kind: "from" | "to", key: string) {
    updateParams((next) => next.set(kind, key));
  }

  function clearPath() {
    updateParams((next) => {
      next.delete("from");
      next.delete("to");
    });
  }

  function resetView() {
    layoutRef.current = null;
    setLayout(null);
    setFocusedKey("");
    updateParams((next) => {
      next.delete("node");
      next.delete("from");
      next.delete("to");
      next.delete("q");
    });
  }

  function toggleRepeated<T extends string>(
    name: "relation" | "type",
    value: T,
    selected: Set<T>,
    all: readonly T[],
  ) {
    const nextValues = new Set(selected);

    if (nextValues.has(value)) {
      if (nextValues.size === 1) {
        return;
      }
      nextValues.delete(value);
    } else {
      nextValues.add(value);
    }

    updateParams((next) => {
      next.delete(name);
      if (nextValues.size !== all.length) {
        for (const item of all.filter((candidate) => nextValues.has(candidate))) {
          next.append(name, item);
        }
      }
    });
  }

  const drawerOpen = Boolean(selectedKey);

  return (
    <div className="network-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main
        aria-label="知识网络"
        className={`network-main${drawerOpen ? " drawer-open" : ""}`}
      >
        <section className="network-stage">
          <header className="network-heading">
            <div className="network-title">
              <span aria-hidden="true" className="network-title-mark">
                <i />
                <i />
                <i />
              </span>
              <div>
                <span>已确认事实的制图台</span>
                <h1>知识网络</h1>
              </div>
            </div>

            <form
              aria-label="网络节点搜索"
              className="network-search"
              onSubmit={(event) => {
                event.preventDefault();
                submitSearch();
              }}
              role="search"
            >
              <label>
                <span aria-hidden="true" className="network-search-glyph" />
                <span className="visually-hidden">搜索网络节点</span>
                <input
                  aria-controls={searchOpen && query ? "network-node-search-results" : undefined}
                  aria-expanded={searchOpen && query ? true : false}
                  aria-label="搜索网络节点"
                  maxLength={200}
                  onChange={(event) => setQueryDraft(event.currentTarget.value)}
                  onFocus={() => query && setSearchOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && searchOpen) {
                      event.stopPropagation();
                      setSearchOpen(false);
                    }
                  }}
                  placeholder="搜索 Concept 或 Knowledge Point"
                  type="search"
                  value={queryDraft}
                />
              </label>
              <button disabled={!queryDraft.trim()} type="submit">定位节点</button>

              {searchOpen && query ? (
                <SearchResults
                  error={searchError}
                  items={searchItems}
                  loading={searchLoading}
                  onClose={() => setSearchOpen(false)}
                  onSelect={openNode}
                  query={query}
                  truncated={searchTruncated}
                />
              ) : null}
            </form>

            <div className="network-heading-proof">
              <strong>{graph.nodes.length} 节点 · {graph.edges.length} 真实边</strong>
              <span>只读聚合 · 无推断边</span>
            </div>
          </header>

          <div className="network-toolbar" role="toolbar" aria-label="网络视图工具">
            <FilterGroup label="节点">
              {NODE_TYPES.map((type) => (
                <FilterCheck
                  checked={nodeTypes.has(type)}
                  key={type}
                  label={nodeTypeLabel(type)}
                  onChange={() =>
                    toggleRepeated("type", type, nodeTypes, NODE_TYPES)
                  }
                />
              ))}
            </FilterGroup>
            <FilterGroup label="真实边">
              {EDGE_KINDS.map((kind) => (
                <FilterCheck
                  checked={edgeKinds.has(kind)}
                  key={kind}
                  label={edgeKindLabel(kind)}
                  onChange={() =>
                    toggleRepeated("relation", kind, edgeKinds, EDGE_KINDS)
                  }
                />
              ))}
            </FilterGroup>
            <div aria-label="边图例" className="network-legend">
              <span><i className="is-membership" />Membership</span>
              <span><i className="is-symmetric" />对称关系</span>
              <span><i className="is-directed" />有向关系</span>
            </div>
            <div className="network-view-actions">
              <button
                aria-pressed={view === "graph"}
                disabled={Boolean(rendererFailure)}
                onClick={() =>
                  updateParams((next) => next.delete("view"))
                }
                type="button"
              >
                图幅视图
              </button>
              <button
                aria-pressed={view === "list"}
                onClick={() =>
                  updateParams((next) => next.set("view", "list"))
                }
                type="button"
              >
                列表视图
              </button>
              <button
                disabled={!selectedKey}
                onClick={() => setFocusedKey(selectedKey)}
                type="button"
              >
                聚焦节点
              </button>
              <button onClick={resetView} type="button">重置视图</button>
            </div>
          </div>

          {rendererFailure ? (
            <p
              aria-label="网络渲染状态"
              className="network-renderer-alert"
              role="alert"
            >
              {rendererFailure}
            </p>
          ) : null}
          {loadError ? (
            <p className="network-load-error" role="alert">{loadError}</p>
          ) : null}

          <div className="network-viewport">
            {graph.truncated ? (
              <p className="network-truncated-notice" role="status">
                当前局部图已按服务端预算截断；选择节点可继续核验其局部关系。
              </p>
            ) : null}
            {loading && graph.nodes.length === 0 ? (
              <div className="network-loading" role="status">
                <span aria-hidden="true" />
                <strong>正在读取真实知识网络…</strong>
                <p>首先装载当前有效的 Concept。</p>
              </div>
            ) : null}
            {!loading && !loadError && graph.nodes.length === 0 ? (
              <div className="network-empty">
                <span aria-hidden="true">◎</span>
                <strong>还没有可绘制的 Concept</strong>
                <p>先在 Concept 图册确认定义与 Membership，网络才会出现真实节点。</p>
                <Link to="/concepts">打开 Concept 图册</Link>
              </div>
            ) : null}
            {graph.nodes.length > 0 && visibleNodes.length === 0 ? (
              <div className="network-empty">
                <span aria-hidden="true">◇</span>
                <strong>当前筛选没有可见节点</strong>
                <p>重新启用另一类节点，即可回到当前真实网络。</p>
              </div>
            ) : null}
            {visibleNodes.length > 0 && view === "graph" ? (
              layout ? (
                <NetworkRendererBoundary onFailure={fallBackToList}>
                  <NetworkCanvas
                    edges={visibleEdges}
                    focusedKey={focusedKey}
                    nodes={visibleNodes}
                    onSelect={openNode}
                    path={path}
                    positions={layout.positions}
                    selectedKey={selectedKey}
                  />
                </NetworkRendererBoundary>
              ) : (
                <div className="network-loading" role="status">
                  <span aria-hidden="true" />
                  <strong>{layoutLoading ? "正在排布稳定图幅…" : "等待布局 Worker…"}</strong>
                  <p>抽屉开合不会重新计算节点坐标。</p>
                </div>
              )
            ) : null}
            {visibleNodes.length > 0 && view === "list" ? (
              <NetworkList
                edges={visibleEdges}
                nodes={visibleNodes}
                onSelect={openNode}
                path={path}
                selectedKey={selectedKey}
              />
            ) : null}
          </div>

          <PathDocket
            error={pathError}
            from={nodeByKey.get(fromKey) ?? null}
            loading={pathLoading}
            onClear={clearPath}
            path={path}
            resolved={pathResolved}
            to={nodeByKey.get(toKey) ?? null}
          />
        </section>

        {drawerOpen ? (
          <NetworkNodeDrawer
            edges={graph.edges}
            fromKey={fromKey}
            loading={!selectedNode && loading}
            node={selectedNode}
            nodeByKey={nodeByKey}
            onClose={closeDrawer}
            onSelect={openNode}
            onSetEndpoint={setEndpoint}
            toKey={toKey}
          />
        ) : null}
      </main>

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          window.requestAnimationFrame(() => newRecordButton.current?.focus());
        }}
        onSaved={() => setNewRecordOpen(false)}
        open={newRecordOpen}
      />
    </div>
  );
}

export function NetworkCanvas({
  edges,
  focusedKey,
  nodes,
  onSelect,
  path,
  positions,
  selectedKey,
}: NetworkCanvasProps) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const drawableNodes = nodes.filter(({ key }) => positions[key]);
  const drawableEdges = edges.filter(
    ({ source, target }) => positions[source] && positions[target],
  );
  const pathEdgeIndex = new Map(
    (path?.steps ?? []).map(({ edgeKey }, index) => [edgeKey, index + 1]),
  );
  const pathNodeKeys = new Set(path?.nodes.map(({ key }) => key) ?? []);
  const viewBox = networkViewBox(drawableNodes, positions, focusedKey);
  const parallelIndexes = parallelEdgeIndexes(drawableEdges);

  return (
    <svg
      aria-label="真实知识网络图幅"
      className="network-canvas"
      preserveAspectRatio="xMidYMid meet"
      role="group"
      viewBox={viewBox}
    >
      <defs>
        <marker
          id="network-arrow"
          markerHeight="8"
          markerUnits="strokeWidth"
          markerWidth="8"
          orient="auto"
          refX="7"
          refY="4"
          viewBox="0 0 8 8"
        >
          <path d="M0 0 8 4 0 8z" />
        </marker>
      </defs>
      <g aria-label="真实关系边" className="network-edges" role="list">
        {drawableEdges.map((edge) => {
          const source = positions[edge.source]!;
          const target = positions[edge.target]!;
          const sourceNode = nodeByKey.get(edge.source)!;
          const targetNode = nodeByKey.get(edge.target)!;
          const pathNumber = pathEdgeIndex.get(edge.edgeKey);
          const d = edgeCurve(
            source,
            target,
            sourceNode.type,
            targetNode.type,
            parallelIndexes.get(edge.edgeKey) ?? { count: 1, index: 0 },
          );

          return (
            <g
              aria-label={edgeAccessibleLabel(edge, sourceNode, targetNode)}
              data-path-edge={pathNumber ? "true" : undefined}
              key={edge.edgeKey}
              role="listitem"
            >
              {pathNumber ? (
                <path className="network-path-underlay" d={d} />
              ) : null}
              <path
                className={`network-edge is-${edgeClass(edge)}`}
                d={d}
                markerEnd={edge.directed ? "url(#network-arrow)" : undefined}
              />
              {pathNumber ? (
                <g className="network-path-step-mark" transform={midpointTransform(source, target)}>
                  <circle r="12" />
                  <text dominantBaseline="central" textAnchor="middle">{pathNumber}</text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>
      <g aria-label="知识网络节点" className="network-nodes" role="list">
        {drawableNodes.map((node) => {
          const position = positions[node.key]!;
          const selected = node.key === selectedKey;
          const onPath = pathNodeKeys.has(node.key);

          return (
            <g
              aria-label={`打开节点：${node.label}`}
              className={`network-node is-${node.type}${selected ? " is-selected" : ""}${onPath ? " is-path" : ""}`}
              data-node-key={node.key}
              data-path-node={onPath ? "true" : undefined}
              key={node.key}
              onClick={() => onSelect(node)}
              onKeyDown={(event) => activateNode(event, () => onSelect(node))}
              role="button"
              tabIndex={0}
              transform={`translate(${position.x} ${position.y})`}
            >
              <title>{node.label}</title>
              {node.type === "concept" ? (
                <>
                  <circle className="network-node-halo" r="48" />
                  <circle className="network-concept-outer" r="40" />
                  <circle className="network-concept-inner" r="30" />
                  <circle className="network-concept-core" r="4" />
                </>
              ) : (
                <>
                  <rect className="network-point-halo" height="34" rx="4" width="34" x="-17" y="-17" />
                  <rect className="network-point-port" height="24" rx="2" width="24" x="-12" y="-12" />
                  <circle className="network-point-core" r="3" />
                </>
              )}
              <text
                className="network-node-label"
                dominantBaseline="hanging"
                textAnchor="middle"
                y={node.type === "concept" ? 54 : 27}
              >
                {shortLabel(node.label)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function NetworkList({
  edges,
  nodes,
  onSelect,
  path,
  selectedKey,
}: {
  edges: NetworkEdge[];
  nodes: NetworkNode[];
  onSelect: (node: NetworkNode) => void;
  path: NetworkPath | null;
  selectedKey: string;
}) {
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const pathStepNumbers = new Map(
    path?.steps.map(({ edgeKey }, index) => [edgeKey, index + 1]) ?? [],
  );

  return (
    <section aria-label="网络等价列表" className="network-list-view" role="region">
      <div className="network-list-heading">
        <div>
          <h2>等价节点与关系列表</h2>
          <p>键盘可完成节点打开、来源核验与路径端点设置。</p>
        </div>
        <span>{nodes.length} 节点 · {edges.length} 边</span>
      </div>
      <div className="network-list-columns">
        <section aria-label="网络节点列表">
          <header><strong>节点</strong><span>类型 / 当前来源</span></header>
          <div>
            {nodes.map((node) => (
              <button
                aria-current={node.key === selectedKey ? "true" : undefined}
                aria-label={`打开节点：${node.label}`}
                key={node.key}
                onClick={() => onSelect(node)}
                type="button"
              >
                <i aria-hidden="true" className={`is-${node.type}`} />
                <span><strong>{node.label}</strong><small>{nodeSourceLabel(node)}</small></span>
                <em>{nodeTypeLabel(node.type)}</em>
              </button>
            ))}
          </div>
        </section>
        <section aria-label="真实关系列表">
          <header><strong>真实边</strong><span>规范方向 / 确认来源</span></header>
          <div role="list">
            {edges.map((edge) => {
              const source = nodeByKey.get(edge.source);
              const target = nodeByKey.get(edge.target);
              const pathStepNumber = pathStepNumbers.get(edge.edgeKey);

              if (!source || !target) return null;

              return (
                <article
                  data-path-edge={pathStepNumber ? "true" : undefined}
                  key={edge.edgeKey}
                  role="listitem"
                >
                  <span>{pathStepNumber ? `路径 ${pathStepNumber}` : edgeKindLabel(edge.kind)}</span>
                  <strong>{source.label} {edge.directed ? "→" : "↔"} {target.label}</strong>
                  <p>{relationTypeLabel(edge.relationType)} · {edgeSourceLabel(edge)}</p>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </section>
  );
}

function SearchResults({
  error,
  items,
  loading,
  onClose,
  onSelect,
  query,
  truncated,
}: {
  error: string;
  items: NetworkNode[];
  loading: boolean;
  onClose: () => void;
  onSelect: (node: NetworkNode) => void;
  query: string;
  truncated: boolean;
}) {
  return (
    <section
      aria-label="网络节点搜索结果"
      className="network-search-results"
      id="network-node-search-results"
      role="region"
    >
      <header>
        <span>
          “{query}” 的节点结果
          {truncated ? " · 结果已截断，请缩小关键词" : ""}
        </span>
        <button aria-label="关闭网络节点搜索结果" onClick={onClose} type="button">×</button>
      </header>
      {loading ? <p role="status">正在查找当前有效节点…</p> : null}
      {error ? <p className="is-error" role="alert">{error}</p> : null}
      {!loading && !error && items.length === 0 ? (
        <p>没有匹配的 Concept 或 Knowledge Point。</p>
      ) : null}
      {items.length > 0 ? (
        <div>
          {items.map((node) => (
            <button
              aria-label={`选择搜索结果：${node.label}`}
              key={node.key}
              onClick={() => onSelect(node)}
              type="button"
            >
              <i aria-hidden="true" className={`is-${node.type}`} />
              <span><strong>{node.label}</strong><small>{nodeSourceLabel(node)}</small></span>
              <em>{nodeTypeLabel(node.type)}</em>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function NetworkNodeDrawer({
  edges,
  fromKey,
  loading,
  node,
  nodeByKey,
  onClose,
  onSelect,
  onSetEndpoint,
  toKey,
}: {
  edges: NetworkEdge[];
  fromKey: string;
  loading: boolean;
  node: NetworkNode | null;
  nodeByKey: Map<string, NetworkNode>;
  onClose: () => void;
  onSelect: (node: NetworkNode) => void;
  onSetEndpoint: (kind: "from" | "to", key: string) => void;
  toKey: string;
}) {
  const incident = node
    ? edges.filter(({ source, target }) => source === node.key || target === node.key)
    : [];
  const membershipCount = incident.filter(
    ({ kind }) => kind === "concept_membership",
  ).length;

  return (
    <aside aria-label="节点详情" className="network-drawer" role="region">
      <header>
        <div>
          <span>{node ? nodeTypeLabel(node.type) : "节点"} · 当前有效视图</span>
          <h2>{node?.label ?? "正在读取节点…"}</h2>
        </div>
        <button aria-label="关闭节点详情" onClick={onClose} type="button">×</button>
      </header>
      {loading ? <p className="network-drawer-state" role="status">正在读取节点来源与邻居…</p> : null}
      {!loading && !node ? (
        <p className="network-drawer-state is-error" role="alert">节点不存在或已退出当前有效网络。</p>
      ) : null}
      {node ? (
        <div className="network-drawer-scroll">
          <section className="network-drawer-definition">
            <span>{nodeSourceLabel(node)}</span>
            <p>{node.description ?? "当前节点没有补充描述。"}</p>
            {node.type === "concept" ? (
              <Link to={`/concepts?concept=${encodeURIComponent(node.id)}`}>打开 Concept</Link>
            ) : (
              <Link to={`/records/${encodeURIComponent(node.source.kind === "knowledge_point" ? node.source.recordId : "")}`}>
                打开来源记录
              </Link>
            )}
          </section>
          <section className="network-drawer-path-actions" aria-label="路径端点">
            <div>
              <strong>路径端点</strong>
              <span>路径由服务端在真实边上探索，最大深度 6。</span>
            </div>
            <button
              aria-pressed={fromKey === node.key}
              onClick={() => onSetEndpoint("from", node.key)}
              type="button"
            >
              {fromKey === node.key ? "已设为起点" : "设为路径起点"}
            </button>
            <button
              aria-pressed={toKey === node.key}
              onClick={() => onSetEndpoint("to", node.key)}
              type="button"
            >
              {toKey === node.key ? "已设为终点" : "设为路径终点"}
            </button>
          </section>
          <section className="network-drawer-connections">
            <header>
              <div><strong>直接真实关系</strong><span>{incident.length} 条</span></div>
              {node.type === "concept" ? <p>{membershipCount} 个 Knowledge Point</p> : null}
            </header>
            {incident.length === 0 ? (
              <p className="network-drawer-state">当前局部图没有直接关系。</p>
            ) : (
              <div role="list">
                {incident.map((edge) => {
                  const neighborKey = edge.source === node.key ? edge.target : edge.source;
                  const neighbor = nodeByKey.get(neighborKey);
                  const outward = edge.source === node.key;

                  return (
                    <article key={edge.edgeKey} role="listitem">
                      <span>{edgeKindLabel(edge.kind)} · {relationTypeLabel(edge.relationType)}</span>
                      <div>
                        <i aria-hidden="true">{edge.directed ? (outward ? "→" : "←") : "↔"}</i>
                        {neighbor ? (
                          <button onClick={() => onSelect(neighbor)} type="button">
                            {neighbor.label}
                          </button>
                        ) : <strong>{neighborKey}</strong>}
                      </div>
                      {edge.description ? <p>{edge.description}</p> : null}
                      <small>{edgeSourceLabel(edge)}</small>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function PathDocket({
  error,
  from,
  loading,
  onClear,
  path,
  resolved,
  to,
}: {
  error: string;
  from: NetworkNode | null;
  loading: boolean;
  onClear: () => void;
  path: NetworkPath | null;
  resolved: boolean;
  to: NetworkNode | null;
}) {
  let status = "选择起点和终点，服务端最多探索 6 步。";

  if (loading) status = "正在沿真实边探索路径…";
  else if (error) status = error;
  else if (from && !to) status = `起点：${from.label}。请选择终点。`;
  else if (!from && to) status = `终点：${to.label}。请选择起点。`;
  else if (from && to && resolved && path) {
    status = `已找到 ${path.steps.length} 步真实路径。可逐边核验方向与来源。`;
  } else if (from && to && resolved) {
    status = "没有找到由当前真实边构成的路径。";
  }

  return (
    <footer className="network-path-docket">
      <div>
        <span>路径核验</span>
        <p aria-label="路径探索结果" role="status">{status}</p>
      </div>
      {path ? (
        <ol aria-label="有序路径步骤">
          {path.steps.map((step, index) => (
            <li key={step.edgeKey}>
              <span>{index + 1}</span>
              <strong>{relationTypeLabel(step.relationType)}</strong>
              <em>{traversalLabel(step.traversalDirection)}</em>
            </li>
          ))}
        </ol>
      ) : null}
      {from || to ? <button onClick={onClear} type="button">清除路径</button> : null}
    </footer>
  );
}

function FilterGroup({ children, label }: { children: ReactNode; label: string }) {
  return <fieldset className="network-filter-group"><legend>{label}</legend>{children}</fieldset>;
}

function FilterCheck({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label>
      <input checked={checked} onChange={onChange} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

class NetworkRendererBoundary extends Component<
  { children: ReactNode; onFailure: (reason: string) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onFailure(error.message);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function mergeGraphs(
  graphs: Array<{
    edges: NetworkEdge[];
    nodes: NetworkNode[];
    truncated: boolean;
  }>,
): NetworkGraphState {
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();

  for (const graph of graphs) {
    for (const node of graph.nodes) nodes.set(node.key, node);
    for (const edge of graph.edges) edges.set(edge.edgeKey, edge);
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.key.localeCompare(right.key)),
    edges: [...edges.values()].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey)),
    truncated: graphs.some(({ truncated }) => truncated),
  };
}

function readRepeatedFilter<T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[],
): Set<T> {
  const allowedSet = new Set<string>(allowed);
  const values = params.getAll(name).filter((value): value is T => allowedSet.has(value));

  return new Set(values.length > 0 ? values : allowed);
}

function validTypedKey(value: string | null): string {
  return value && TYPED_KEY_PATTERN.test(value) ? value.toLowerCase() : "";
}

function nodeTypeLabel(type: NetworkNodeType): string {
  return type === "concept" ? "Concept" : "Knowledge Point";
}

function edgeKindLabel(kind: NetworkEdgeKind): string {
  if (kind === "concept_membership") return "Concept Membership";
  if (kind === "concept_relation") return "Concept Relation";
  return "Knowledge Relation";
}

function relationTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    analogy: "类比",
    applies: "应用于",
    contrasts: "对照",
    extends: "扩展",
    membership: "归属",
    prerequisite: "前置依赖",
    similar: "相似",
  };

  return labels[type] ?? type;
}

function traversalLabel(direction: NetworkTraversalDirection): string {
  if (direction === "forward") return "顺向";
  if (direction === "reverse") return "反向遍历";
  return "无向";
}

function nodeSourceLabel(node: NetworkNode): string {
  return node.source.kind === "concept_revision"
    ? `Concept Revision ${node.source.revisionNumber}`
    : `来源记录：${node.source.recordTitle}`;
}

function edgeSourceLabel(edge: NetworkEdge): string {
  return edge.sourceRecord.kind === "concept_membership"
    ? `Membership · ${edge.sourceRecord.origin}`
    : `用户确认 · ${formatDate(edge.sourceRecord.confirmedAt)}`;
}

function edgeClass(edge: NetworkEdge): "directed" | "membership" | "symmetric" {
  if (edge.kind === "concept_membership") return "membership";
  return edge.directed ? "directed" : "symmetric";
}

function edgeAccessibleLabel(
  edge: NetworkEdge,
  source: NetworkNode,
  target: NetworkNode,
): string {
  return `${edgeKindLabel(edge.kind)}：${source.label}${edge.directed ? " 指向 " : " 与 "}${target.label}，${relationTypeLabel(edge.relationType)}`;
}

function networkViewBox(
  nodes: NetworkNode[],
  positions: Record<string, NetworkPosition>,
  focusedKey: string,
): string {
  const focused = focusedKey ? positions[focusedKey] : undefined;

  if (focused) return `${focused.x - 380} ${focused.y - 260} 760 520`;
  const values = nodes.flatMap(({ key }) => positions[key] ? [positions[key]!] : []);

  if (values.length === 0) return "-600 -360 1200 720";
  const minX = Math.min(...values.map(({ x }) => x));
  const maxX = Math.max(...values.map(({ x }) => x));
  const minY = Math.min(...values.map(({ y }) => y));
  const maxY = Math.max(...values.map(({ y }) => y));
  const width = Math.max(1_100, maxX - minX + 260);
  const height = Math.max(650, maxY - minY + 220);

  return `${(minX + maxX - width) / 2} ${(minY + maxY - height) / 2} ${width} ${height}`;
}

function parallelEdgeIndexes(edges: NetworkEdge[]) {
  const groups = new Map<string, NetworkEdge[]>();

  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join("|");
    const group = groups.get(key) ?? [];

    group.push(edge);
    groups.set(key, group);
  }

  const result = new Map<string, { count: number; index: number }>();

  for (const group of groups.values()) {
    group.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
    group.forEach((edge, index) => result.set(edge.edgeKey, { count: group.length, index }));
  }

  return result;
}

function edgeCurve(
  source: NetworkPosition,
  target: NetworkPosition,
  sourceType: NetworkNodeType,
  targetType: NetworkNodeType,
  parallel: { count: number; index: number },
): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const startRadius = sourceType === "concept" ? 42 : 16;
  const endRadius = targetType === "concept" ? 48 : 21;
  const start = { x: source.x + ux * startRadius, y: source.y + uy * startRadius };
  const end = { x: target.x - ux * endRadius, y: target.y - uy * endRadius };
  const offset = (parallel.index - (parallel.count - 1) / 2) * 22;
  const control = {
    x: (start.x + end.x) / 2 - uy * offset,
    y: (start.y + end.y) / 2 + ux * offset,
  };

  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function midpointTransform(source: NetworkPosition, target: NetworkPosition): string {
  return `translate(${(source.x + target.x) / 2} ${(source.y + target.y) / 2})`;
}

function activateNode(event: ReactKeyboardEvent<SVGGElement>, activate: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activate();
  }
}

function shortLabel(label: string): string {
  return Array.from(label).length > 16 ? `${Array.from(label).slice(0, 15).join("")}…` : label;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
