/*
 * THESIS: Home is the first spatial view of confirmed knowledge, not a decorative Tag cloud.
 * OWN-WORLD: The same typed nodes and real edges read as a warm physical model or a deep-space instrument.
 * STORY: Search a node, inspect its source, expand local Knowledge Points, then verify a server-computed path.
 * FIRST VIEWPORT: One uninterrupted network stage below navigation, with compact network controls above and Tag/record search below.
 * FORM: Experience-mode 3D knowledge atlas with canonical 2D and keyboard-list fallbacks.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  getTagField,
  type NetworkEdgeKind,
  type NetworkNodeType,
  type TagFieldItem,
} from "./api.js";
import {
  NetworkGraph3D,
  type NetworkGraph3DCameraSnapshot,
  type NetworkGraph3DFailure,
  type NetworkGraph3DHandle,
} from "./network-graph-3d.js";
import {
  NetworkCanvas,
  NetworkList,
  NetworkNodeDrawer,
  NetworkRendererBoundary,
  PathDocket,
  SearchResults,
} from "./network-page.js";
import {
  NETWORK_EDGE_KINDS,
  NETWORK_NODE_TYPES,
  useNetworkWorkspaceController,
} from "./network-workspace-controller.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import { tagPathLabel } from "./tag-path.js";
import { useTheme } from "./theme.js";
import "./network-page.css";
import "./home-page.css";

type HomeRenderer = "list" | "2d" | "webgl2";

export function ConceptHomePage({
  initialCamera,
  onCameraChange,
}: {
  initialCamera: NetworkGraph3DCameraSnapshot | null;
  onCameraChange: (camera: NetworkGraph3DCameraSnapshot) => void;
}) {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const controller = useNetworkWorkspaceController();
  const {
    actions,
    drawerOpen,
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
  } = controller;
  const [tags, setTags] = useState<TagFieldItem[]>([]);
  const [tagStatus, setTagStatus] = useState<"failed" | "loading" | "ready">(
    "loading",
  );
  const [tagQuery, setTagQuery] = useState("");
  const [tagSuggestionsOpen, setTagSuggestionsOpen] = useState(false);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [threeFailure, setThreeFailure] = useState("");
  const reducedMotion = useReducedMotion();
  const graph3dRef = useRef<NetworkGraph3DHandle>(null);
  const newRecordButton = useRef<HTMLButtonElement>(null);

  const loadTags = useCallback(async () => {
    try {
      const items = await getTagField();

      setTags(items);
      setTagStatus("ready");
    } catch {
      setTagStatus("failed");
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const matchingTags = useMemo(() => {
    const normalized = tagQuery.trim().toLocaleLowerCase();

    return normalized
      ? tags
          .filter((tag) =>
            tagPathLabel(tag).toLocaleLowerCase().includes(normalized),
          )
          .slice(0, 8)
      : [];
  }, [tagQuery, tags]);
  const pathNodeKeys = useMemo(
    () => new Set(path?.nodes.map(({ key }) => key) ?? []),
    [path],
  );
  const pathEdgeKeys = useMemo(
    () => new Set(path?.steps.map(({ edgeKey }) => edgeKey) ?? []),
    [path],
  );
  const renderer: HomeRenderer =
    view === "list" || rendererFailure
      ? "list"
      : threeFailure
        ? "2d"
        : "webgl2";
  const rendererMessage = rendererFailure || threeFailure;
  const nodeKeys = useMemo(
    () => visibleNodes.map(({ key }) => key).sort().join(" "),
    [visibleNodes],
  );
  const edgeKeys = useMemo(
    () => visibleEdges.map(({ edgeKey }) => edgeKey).sort().join(" "),
    [visibleEdges],
  );
  const renderLayout = useMemo(
    () =>
      layout && visibleNodes.every(({ key }) => layout.positions[key])
        ? layout
        : null,
    [layout, visibleNodes],
  );
  const orderedPathEdgeKeys =
    path?.steps.map(({ edgeKey }) => edgeKey).join(" ") ?? "";

  function handleThreeFailure(failure: NetworkGraph3DFailure) {
    setThreeFailure(
      `3D 渲染暂不可用（${failure.message}），已切换到功能性 2D 视图。`,
    );
  }

  function submitTagSearch() {
    const normalized = tagQuery.trim();

    if (!normalized) return;
    const search = new URLSearchParams({ q: normalized });

    void navigate(`/search?${search.toString()}`);
  }

  function openTag(tag: TagFieldItem) {
    const search = new URLSearchParams({ tag: tag.id });

    void navigate(`/search?${search.toString()}`);
  }

  function restoreCreateFocus() {
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  return (
    <div className="home-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main aria-label="首页" className="home-main">
        <div className={`home-workbench${drawerOpen ? " drawer-open" : ""}`}>
          <section className="home-network-stage">
            <header className="home-network-command">
              <div className="home-network-title">
                <span aria-hidden="true" className="home-network-title-mark">
                  <i />
                  <i />
                  <i />
                </span>
                <div>
                  <span>CONFIRMED KNOWLEDGE</span>
                  <h1>知识网络</h1>
                </div>
              </div>

              <form
                aria-label="首页网络节点搜索"
                className="home-network-search"
                onSubmit={(event) => {
                  event.preventDefault();
                  actions.submitSearch();
                }}
                role="search"
              >
                <label>
                  <span aria-hidden="true" className="home-network-search-glyph" />
                  <span className="visually-hidden">搜索网络节点</span>
                  <input
                    aria-controls={
                      searchOpen && query
                        ? "network-node-search-results"
                        : undefined
                    }
                    aria-expanded={searchOpen && query ? true : false}
                    aria-label="搜索网络节点"
                    maxLength={200}
                    onChange={(event) =>
                      actions.setQueryDraft(event.currentTarget.value)
                    }
                    onFocus={() => query && actions.setSearchOpen(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && searchOpen) {
                        event.stopPropagation();
                        actions.setSearchOpen(false);
                      }
                    }}
                    placeholder="定位 Concept 或 Knowledge Point"
                    type="search"
                    value={queryDraft}
                  />
                </label>
                <button disabled={!queryDraft.trim()} type="submit">
                  定位
                </button>

                {searchOpen && query ? (
                  <SearchResults
                    error={searchError}
                    items={searchItems}
                    loading={searchLoading}
                    onClose={() => actions.setSearchOpen(false)}
                    onSelect={actions.openNode}
                    query={query}
                    truncated={searchTruncated}
                  />
                ) : null}
              </form>

              <div className="home-network-actions">
                <span className="home-network-proof">
                  {graph.nodes.length} 节点 · {graph.edges.length} 真实边
                </span>
                <HomeNetworkFilters
                  edgeKinds={edgeKinds}
                  nodeTypes={nodeTypes}
                  onToggleEdge={actions.toggleEdgeKind}
                  onToggleNode={actions.toggleNodeType}
                />
                <button
                  aria-label={
                    renderer === "list" ? "切换到图幅视图" : "切换到列表视图"
                  }
                  disabled={renderer === "list" && Boolean(rendererFailure)}
                  onClick={() =>
                    actions.setView(renderer === "list" ? "graph" : "list")
                  }
                  type="button"
                >
                  {renderer === "list" ? "图幅" : "列表"}
                </button>
                <button
                  disabled={renderer !== "webgl2"}
                  onClick={() => graph3dRef.current?.resetCamera()}
                  type="button"
                >
                  重置镜头
                </button>
              </div>
            </header>

            <section
              aria-busy={
                loading || layoutLoading || (visibleNodes.length > 0 && !renderLayout)
              }
              aria-label="真实 3D 知识网络"
              className="home-network-viewport"
              data-edge-count={visibleEdges.length}
              data-edge-keys={edgeKeys}
              data-motion={reducedMotion ? "reduce" : "full"}
              data-node-count={visibleNodes.length}
              data-node-keys={nodeKeys}
              data-path-edge-count={path?.steps.length ?? 0}
              data-path-edge-keys={orderedPathEdgeKeys}
              data-renderer={renderer}
              role="region"
            >
              {rendererMessage || loadError || graph.truncated ? (
                <div className="home-network-messages">
                  {rendererMessage ? (
                    <p
                      aria-label="首页网络渲染状态"
                      className="home-renderer-alert"
                      role="alert"
                    >
                      {rendererMessage}
                    </p>
                  ) : null}
                  {loadError ? (
                    <p className="home-network-error" role="alert">
                      {loadError}
                    </p>
                  ) : null}
                  {graph.truncated ? (
                    <p className="home-network-truncated" role="status">
                      当前局部网络已按服务端预算截断；选择节点可继续核验局部关系。
                    </p>
                  ) : null}
                </div>
              ) : null}

              {loading && graph.nodes.length === 0 ? (
                <div className="home-network-state" role="status">
                  <span aria-hidden="true" />
                  <strong>正在读取真实知识网络…</strong>
                  <p>首先装载当前有效的 Concept。</p>
                </div>
              ) : null}
              {!loading && !loadError && graph.nodes.length === 0 ? (
                <div className="home-network-state is-empty" role="status">
                  <span aria-hidden="true">◎</span>
                  <strong>记录第一条知识，让网络开始生长</strong>
                  <p>确认 Concept 与 Membership 后，真实节点和关系会出现在这里。</p>
                  <div>
                    <button onClick={() => setNewRecordOpen(true)} type="button">
                      新建第一条记录
                    </button>
                    <Link to="/concepts">打开 Concept 图册</Link>
                  </div>
                </div>
              ) : null}
              {graph.nodes.length > 0 && visibleNodes.length === 0 ? (
                <div className="home-network-state is-empty" role="status">
                  <span aria-hidden="true">◇</span>
                  <strong>当前筛选没有可见节点</strong>
                  <p>重新启用另一类节点，即可回到当前真实网络。</p>
                </div>
              ) : null}

              {visibleNodes.length > 0 && renderer === "webgl2" ? (
                renderLayout ? (
                  <NetworkGraph3D
                    className="home-network-canvas"
                    edges={visibleEdges}
                    initialCamera={initialCamera}
                    layout={renderLayout}
                    nodes={visibleNodes}
                    onCameraChange={onCameraChange}
                    onFailure={handleThreeFailure}
                    onSelect={actions.openNode}
                    pathEdgeKeys={pathEdgeKeys}
                    pathNodeKeys={pathNodeKeys}
                    reducedMotion={reducedMotion}
                    ref={graph3dRef}
                    selectedKey={selectedKey}
                    theme={theme}
                  />
                ) : (
                  <HomeLayoutLoading loading={layoutLoading} />
                )
              ) : null}
              {visibleNodes.length > 0 && renderer === "2d" ? (
                renderLayout ? (
                  <NetworkRendererBoundary onFailure={actions.fallBackToList}>
                    <NetworkCanvas
                      edges={visibleEdges}
                      focusedKey={focusedKey}
                      nodes={visibleNodes}
                      onSelect={actions.openNode}
                      path={path}
                      positions={renderLayout.positions}
                      selectedKey={selectedKey}
                    />
                  </NetworkRendererBoundary>
                ) : (
                  <HomeLayoutLoading loading={layoutLoading} />
                )
              ) : null}
              {visibleNodes.length > 0 && renderer === "list" ? (
                <NetworkList
                  edges={visibleEdges}
                  nodes={visibleNodes}
                  onSelect={actions.openNode}
                  path={path}
                  selectedKey={selectedKey}
                />
              ) : null}

              <div className="home-network-legend" aria-label="网络图例">
                <span><i className="is-concept" />Concept 球体</span>
                <span><i className="is-point" />Knowledge Point 方体</span>
                <span><i className="is-membership" />Membership</span>
                <span><i className="is-symmetric" />对称关系</span>
                <span><i className="is-directed" />有向关系</span>
              </div>
            </section>

            <PathDocket
              error={pathError}
              from={nodeByKey.get(fromKey) ?? null}
              loading={pathLoading}
              onClear={actions.clearPath}
              path={path}
              resolved={pathResolved}
              to={nodeByKey.get(toKey) ?? null}
              truncated={pathTruncated}
            />

            <form
              aria-label="首页搜索"
              className="home-search-hud"
              onSubmit={(event) => {
                event.preventDefault();
                submitTagSearch();
              }}
              role="search"
            >
              <label htmlFor="home-search-input">定位标签或搜索记录</label>
              <input
                aria-controls={
                  tagSuggestionsOpen && tagQuery.trim()
                    ? "home-search-suggestions"
                    : undefined
                }
                aria-expanded={Boolean(tagSuggestionsOpen && tagQuery.trim())}
                autoComplete="off"
                id="home-search-input"
                onChange={(event) => {
                  setTagQuery(event.currentTarget.value);
                  setTagSuggestionsOpen(Boolean(event.currentTarget.value.trim()));
                }}
                onFocus={() => {
                  if (tagQuery.trim()) setTagSuggestionsOpen(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && tagSuggestionsOpen) {
                    event.preventDefault();
                    event.stopPropagation();
                    setTagSuggestionsOpen(false);
                  }
                }}
                placeholder="定位标签或搜索记录"
                type="search"
                value={tagQuery}
              />
              {tagSuggestionsOpen && tagQuery.trim() ? (
                <div
                  aria-label="搜索建议"
                  className="home-search-suggestions"
                  id="home-search-suggestions"
                  role="region"
                >
                  <div aria-label="定位标签" className="suggestion-group" role="group">
                    <p aria-hidden="true">按 Tag 筛选记录</p>
                    {tagStatus === "loading" ? (
                      <span className="suggestion-empty">正在读取标签…</span>
                    ) : matchingTags.length > 0 ? (
                      matchingTags.map((tag) => (
                        <button
                          key={tag.id}
                          onClick={() => openTag(tag)}
                          type="button"
                        >
                          {tagPathLabel(tag)}
                        </button>
                      ))
                    ) : (
                      <span className="suggestion-empty">
                        {tagStatus === "failed" ? "标签暂时无法读取" : "没有匹配标签"}
                      </span>
                    )}
                  </div>
                  <div aria-label="搜索记录" className="suggestion-group" role="group">
                    <p aria-hidden="true">搜索记录</p>
                    <button
                      onClick={submitTagSearch}
                      type="button"
                    >
                      搜索记录“{tagQuery.trim()}”
                    </button>
                  </div>
                </div>
              ) : null}
            </form>
          </section>

          {drawerOpen ? (
            <NetworkNodeDrawer
              edges={graph.edges}
              fromKey={fromKey}
              loading={!selectedNode && loading}
              node={selectedNode}
              nodeByKey={nodeByKey}
              onClose={actions.closeDrawer}
              onSelect={actions.openNode}
              onSetEndpoint={actions.setEndpoint}
              toKey={toKey}
            />
          ) : null}
        </div>
      </main>

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          restoreCreateFocus();
        }}
        onSaved={() => {
          setNewRecordOpen(false);
          void loadTags();
          actions.refresh();
          restoreCreateFocus();
        }}
        open={newRecordOpen}
      />
    </div>
  );
}

function HomeNetworkFilters({
  edgeKinds,
  nodeTypes,
  onToggleEdge,
  onToggleNode,
}: {
  edgeKinds: Set<NetworkEdgeKind>;
  nodeTypes: Set<NetworkNodeType>;
  onToggleEdge: (kind: NetworkEdgeKind) => void;
  onToggleNode: (type: NetworkNodeType) => void;
}) {
  return (
    <details
      className="home-network-filters"
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>筛选</summary>
      <div>
        <fieldset>
          <legend>节点类型</legend>
          {NETWORK_NODE_TYPES.map((type) => (
            <label key={type}>
              <input
                checked={nodeTypes.has(type)}
                onChange={() => onToggleNode(type)}
                type="checkbox"
              />
              {type === "concept" ? "Concept" : "Knowledge Point"}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>真实边</legend>
          {NETWORK_EDGE_KINDS.map((kind) => (
            <label key={kind}>
              <input
                checked={edgeKinds.has(kind)}
                onChange={() => onToggleEdge(kind)}
                type="checkbox"
              />
              {edgeKindLabel(kind)}
            </label>
          ))}
        </fieldset>
      </div>
    </details>
  );
}

function HomeLayoutLoading({ loading }: { loading: boolean }) {
  return (
    <div className="home-network-state" role="status">
      <span aria-hidden="true" />
      <strong>{loading ? "正在排布稳定图幅…" : "等待布局 Worker…"}</strong>
      <p>3D 与 2D 共享同一份确定性 x/y。</p>
    </div>
  );
}

function edgeKindLabel(kind: NetworkEdgeKind): string {
  switch (kind) {
    case "concept_membership":
      return "Membership";
    case "concept_relation":
      return "Concept Relation";
    case "knowledge_relation":
      return "Knowledge Relation";
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);

    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  return reduced;
}
