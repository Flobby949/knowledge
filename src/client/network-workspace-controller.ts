import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  getNetworkPath,
  getNetworkSubgraph,
  searchNetworkNodes,
  type NetworkEdge,
  type NetworkEdgeKind,
  type NetworkNode,
  type NetworkNodeType,
  type NetworkPath,
} from "./api.js";
import type { NetworkLayoutSnapshot } from "./network-layout.js";
import type {
  NetworkLayoutWorkerRequest,
  NetworkLayoutWorkerResponse,
} from "./network-layout-worker.js";

export const NETWORK_NODE_TYPES = ["concept", "knowledge_point"] as const;
export const NETWORK_EDGE_KINDS = [
  "concept_membership",
  "concept_relation",
  "knowledge_relation",
] as const;

const TYPED_KEY_PATTERN =
  /^(concept|knowledge_point):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type NetworkView = "graph" | "list";

export interface NetworkGraphState {
  edges: NetworkEdge[];
  nodes: NetworkNode[];
  truncated: boolean;
}

export interface NetworkWorkspaceActions {
  clearPath: () => void;
  closeDrawer: () => void;
  fallBackToList: (reason: string) => void;
  focusSelectedNode: () => void;
  openNode: (node: NetworkNode) => void;
  refresh: () => void;
  resetView: () => void;
  setEndpoint: (kind: "from" | "to", key: string) => void;
  setQueryDraft: (value: string) => void;
  setSearchOpen: (open: boolean) => void;
  setView: (view: NetworkView) => void;
  submitSearch: () => void;
  toggleEdgeKind: (kind: NetworkEdgeKind) => void;
  toggleNodeType: (type: NetworkNodeType) => void;
}

export interface NetworkWorkspaceController {
  actions: NetworkWorkspaceActions;
  drawerOpen: boolean;
  edgeKinds: Set<NetworkEdgeKind>;
  focusedKey: string;
  fromKey: string;
  graph: NetworkGraphState;
  layout: NetworkLayoutSnapshot | null;
  layoutLoading: boolean;
  loadError: string;
  loading: boolean;
  nodeByKey: Map<string, NetworkNode>;
  nodeTypes: Set<NetworkNodeType>;
  path: NetworkPath | null;
  pathError: string;
  pathLoading: boolean;
  pathResolved: boolean;
  pathTruncated: boolean;
  query: string;
  queryDraft: string;
  rendererFailure: string;
  searchError: string;
  searchItems: NetworkNode[];
  searchLoading: boolean;
  searchOpen: boolean;
  searchTruncated: boolean;
  selectedKey: string;
  selectedNode: NetworkNode | null;
  toKey: string;
  view: NetworkView;
  visibleEdges: NetworkEdge[];
  visibleNodes: NetworkNode[];
}

export function useNetworkWorkspaceController(): NetworkWorkspaceController {
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
    NETWORK_NODE_TYPES,
  );
  const edgeKinds = readRepeatedFilter(
    searchParams,
    "relation",
    NETWORK_EDGE_KINDS,
  );
  const [graph, setGraph] = useState<NetworkGraphState>({
    edges: [],
    nodes: [],
    truncated: false,
  });
  const [path, setPath] = useState<NetworkPath | null>(null);
  const [pathResolved, setPathResolved] = useState(false);
  const [pathTruncated, setPathTruncated] = useState(false);
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
  const [refreshSequence, setRefreshSequence] = useState(0);
  const drawerOpenedHere = useRef(false);
  const drawerEntryMutated = useRef(false);
  const drawerOpener = useRef<HTMLElement | null>(null);

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
    setPathTruncated(false);

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
          setPathTruncated(pathOutcome?.result.truncated ?? false);
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
  }, [fromKey, refreshSequence, selectedKey, toKey]);

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
        () => {
          const next = new URLSearchParams(window.location.search);

          next.set("view", "list");
          return next;
        },
        { replace: true },
      );
    },
    [selectedKey, setSearchParams],
  );

  useEffect(() => {
    if (view !== "graph" || rendererFailure || graph.nodes.length === 0) {
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
  }, [
    fallBackToList,
    fromKey,
    graph.edges,
    graph.nodes,
    rendererFailure,
    selectedKey,
    toKey,
    view,
  ]);

  useEffect(() => {
    if (!selectedKey) {
      setSelectedPreview(null);
      drawerOpenedHere.current = false;
      drawerEntryMutated.current = false;
    }
  }, [selectedKey]);

  const updateParams = useCallback(
    (
      mutate: (next: URLSearchParams) => void,
      options: { drawerMutation?: boolean; replace?: boolean } = {},
    ) => {
      const mutatesDrawerEntry =
        Boolean(selectedKey) && (options.drawerMutation ?? true);

      if (mutatesDrawerEntry) {
        drawerEntryMutated.current = true;
      }
      setSearchParams(
        () => {
          // Browser history updates before the router's transition renders.
          // Preserve parameters set by a preceding interaction in that gap.
          const next = new URLSearchParams(window.location.search);

          mutate(next);
          return next;
        },
        { replace: options.replace ?? mutatesDrawerEntry },
      );
    },
    [selectedKey, setSearchParams],
  );

  const openNode = useCallback(
    (node: NetworkNode) => {
      const alreadyOpen = Boolean(selectedKey);

      setSelectedPreview(node);
      setFocusedKey(node.key);
      setSearchOpen(false);
      if (!alreadyOpen) {
        drawerOpenedHere.current = true;
        drawerEntryMutated.current = false;
        drawerOpener.current =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null;
      }
      updateParams(
        (next) => next.set("node", node.key),
        { drawerMutation: false, replace: alreadyOpen },
      );
    },
    [selectedKey, updateParams],
  );

  const closeDrawer = useCallback(() => {
    const opener = drawerOpener.current;

    drawerOpener.current = null;
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) {
        opener.focus();
        return;
      }

      document.querySelector<HTMLElement>(
        'input[aria-label="搜索网络节点"]',
      )?.focus();
    });

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
  }, [navigate, updateParams]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        !selectedKey ||
        event.defaultPrevented ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }

      closeDrawer();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeDrawer, selectedKey]);

  const submitSearch = useCallback(() => {
    const nextQuery = queryDraft.trim().slice(0, 200);

    updateParams((next) => {
      if (nextQuery) {
        next.set("q", nextQuery);
      } else {
        next.delete("q");
      }
    });
    setSearchOpen(Boolean(nextQuery));
  }, [queryDraft, updateParams]);

  const setEndpoint = useCallback(
    (kind: "from" | "to", key: string) => {
      updateParams((next) => next.set(kind, key));
    },
    [updateParams],
  );

  const clearPath = useCallback(() => {
    updateParams((next) => {
      next.delete("from");
      next.delete("to");
    });
  }, [updateParams]);

  const resetView = useCallback(() => {
    layoutRef.current = null;
    setLayout(null);
    setFocusedKey("");
    updateParams((next) => {
      next.delete("node");
      next.delete("from");
      next.delete("to");
      next.delete("q");
    });
  }, [updateParams]);

  const toggleRepeated = useCallback(
    <T extends string>(
      name: "relation" | "type",
      value: T,
      selected: Set<T>,
      all: readonly T[],
    ) => {
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
    },
    [updateParams],
  );

  const toggleNodeType = useCallback(
    (type: NetworkNodeType) => {
      toggleRepeated("type", type, nodeTypes, NETWORK_NODE_TYPES);
    },
    [nodeTypes, toggleRepeated],
  );
  const toggleEdgeKind = useCallback(
    (kind: NetworkEdgeKind) => {
      toggleRepeated("relation", kind, edgeKinds, NETWORK_EDGE_KINDS);
    },
    [edgeKinds, toggleRepeated],
  );
  const setView = useCallback(
    (nextView: NetworkView) => {
      updateParams((next) => {
        if (nextView === "list") {
          next.set("view", "list");
        } else {
          next.delete("view");
        }
      });
    },
    [updateParams],
  );
  const focusSelectedNode = useCallback(() => {
    setFocusedKey(selectedKey);
  }, [selectedKey]);
  const refresh = useCallback(() => {
    setRefreshSequence((current) => current + 1);
  }, []);

  const actions = useMemo<NetworkWorkspaceActions>(
    () => ({
      clearPath,
      closeDrawer,
      fallBackToList,
      focusSelectedNode,
      openNode,
      refresh,
      resetView,
      setEndpoint,
      setQueryDraft,
      setSearchOpen,
      setView,
      submitSearch,
      toggleEdgeKind,
      toggleNodeType,
    }),
    [
      clearPath,
      closeDrawer,
      fallBackToList,
      focusSelectedNode,
      openNode,
      refresh,
      resetView,
      setEndpoint,
      setView,
      submitSearch,
      toggleEdgeKind,
      toggleNodeType,
    ],
  );

  return {
    actions,
    drawerOpen: Boolean(selectedKey),
    edgeKinds,
    focusedKey,
    fromKey,
    graph,
    layout,
    layoutLoading,
    loadError,
    loading,
    nodeByKey,
    nodeTypes,
    path,
    pathError,
    pathLoading,
    pathResolved,
    pathTruncated,
    query,
    queryDraft,
    rendererFailure,
    searchError,
    searchItems,
    searchLoading,
    searchOpen,
    searchTruncated,
    selectedKey,
    selectedNode,
    toKey,
    view,
    visibleEdges,
    visibleNodes,
  };
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
