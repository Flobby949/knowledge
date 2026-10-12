/*
 * THESIS: Search is a verification table with a fixed reading drawer, never a modal interruption.
 * OWN-WORLD: Paper-white result groups switch between berry-petal and graphite-blue signal languages without changing evidence.
 * STORY: A submitted query freezes a result sequence, then one record opens beside that stable context.
 * FIRST VIEWPORT: 60px global navigation, full result stage, and an optional 480px push drawer.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import {
  getRecordDetail,
  getSearchHealth,
  getTagField,
  searchRecords,
  type RecordDetail,
  type SearchHealth,
  type SearchMatch,
  type SearchPage as SearchPageResponse,
  type SearchResult,
  type TagFieldItem,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import { tagPathLabel } from "./tag-path.js";
import "./search-page.css";

type SearchScope = "current" | "include_review";

interface SearchWorkspaceSnapshot {
  items: SearchResult[];
  nextCursor: string | null;
  queryKey: string;
  scrollTop: number;
  v: 1;
}

const SEARCH_PAGE_SIZE = 12;

export function SearchPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const tagIds = searchParams.getAll("tag");
  const scope: SearchScope =
    searchParams.get("scope") === "include_review"
      ? "include_review"
      : "current";
  const selectedId = searchParams.get("record") ?? "";
  const queryKey = searchQueryKey(location.pathname, searchParams);
  const [initialSnapshot] = useState<SearchWorkspaceSnapshot | null>(() =>
    readSearchWorkspaceSnapshot(location.state, queryKey),
  );
  const [results, setResults] = useState<SearchResult[]>(
    () => initialSnapshot?.items ?? [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    () => initialSnapshot?.nextCursor ?? null,
  );
  const [loading, setLoading] = useState(!initialSnapshot);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [health, setHealth] = useState<SearchHealth | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [availableTags, setAvailableTags] = useState<TagFieldItem[]>([]);
  const [queryDraft, setQueryDraft] = useState(query);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [restorationReady, setRestorationReady] = useState(!initialSnapshot);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const resultStage = useRef<HTMLElement>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedId = useRef("");
  const drawerOpenedHere = useRef(false);
  const leftRestoredQuery = useRef(!initialSnapshot);
  const restorationApplied = useRef(false);
  const initialRequest = useRef<{
    key: string;
    promise: Promise<SearchPageResponse>;
  } | null>(null);
  const selected =
    results.find((result) => result.record.id === selectedId) ?? null;

  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  useLayoutEffect(() => {
    if (!initialSnapshot || restorationApplied.current) {
      return;
    }

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (restorationApplied.current) {
          return;
        }

        restorationApplied.current = true;

        if (resultStage.current) {
          resultStage.current.scrollTop = initialSnapshot.scrollTop;
        }

        setRestorationReady(true);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);

      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [initialSnapshot]);

  useEffect(() => {
    if (
      !leftRestoredQuery.current &&
      initialSnapshot?.queryKey === queryKey &&
      refreshVersion === 0
    ) {
      return;
    }

    leftRestoredQuery.current = true;

    let active = true;
    const requestKey = `${queryKey}:${refreshVersion}`;

    setResults([]);
    setNextCursor(null);
    setLoading(true);
    setLoadingMore(false);
    setLoadError("");
    setRestorationReady(true);

    if (resultStage.current) {
      resultStage.current.scrollTop = 0;
    }

    const request =
      initialRequest.current?.key === requestKey
        ? initialRequest.current.promise
        : searchRecords({
            limit: SEARCH_PAGE_SIZE,
            query,
            scope,
            tagIds,
          });

    initialRequest.current = { key: requestKey, promise: request };

    void request
      .then((page) => {
        if (active) {
          setResults(page.items);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setLoadError("搜索暂时不可用，请重新提交查询。");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [queryKey, refreshVersion]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    setHealthError(false);
    void getSearchHealth(controller.signal)
      .then((nextHealth) => {
        if (active) {
          setHealth(nextHealth);
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setHealthError(true);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [queryKey]);

  useEffect(() => {
    let active = true;

    void getTagField()
      .then((tags) => {
        if (active) {
          setAvailableTags(tags);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;

    if (!sentinel || !nextCursor || !restorationReady) {
      return;
    }

    let active = true;
    const controller = new AbortController();
    const cursor = nextCursor;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        observer.disconnect();
        setLoadingMore(true);
        setLoadError("");

        void searchRecords({
          cursor,
          limit: SEARCH_PAGE_SIZE,
          query,
          scope,
          signal: controller.signal,
          tagIds,
        })
          .then((page) => {
            if (!active) {
              return;
            }

            setResults((current) => {
              const existingIds = new Set(
                current.map((result) => result.record.id),
              );

              return [
                ...current,
                ...page.items.filter(
                  (result) => !existingIds.has(result.record.id),
                ),
              ];
            });
            setNextCursor(page.nextCursor);
          })
          .catch((error: unknown) => {
            if (active && !isAbortError(error)) {
              setLoadError(
                "后续结果暂时无法载入；已显示的搜索快照不会改变。",
              );
            }
          })
          .finally(() => {
            if (active) {
              setLoadingMore(false);
            }
          });
      },
      { root: resultStage.current, rootMargin: "0px 0px 240px" },
    );

    observer.observe(sentinel);

    return () => {
      active = false;
      controller.abort();
      observer.disconnect();
    };
  }, [nextCursor, queryKey, restorationReady]);

  useEffect(() => {
    if (selectedId) {
      lastSelectedId.current = selectedId;
      return;
    }

    drawerOpenedHere.current = false;
    const resultId = lastSelectedId.current;

    if (resultId) {
      window.requestAnimationFrame(() =>
        resultButtons.current.get(resultId)?.focus(),
      );
    }
  }, [selectedId]);

  const closeDrawer = useCallback(() => {
    if (!selectedId) {
      return;
    }

    if (drawerOpenedHere.current) {
      drawerOpenedHere.current = false;
      navigate(-1);
      return;
    }

    const next = new URLSearchParams(searchParams);

    next.delete("record");
    setSearchParams(next, { replace: true });
  }, [navigate, searchParams, selectedId, setSearchParams]);

  useEffect(() => {
    if (!selected) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, selected]);

  function submitQuery() {
    const next = new URLSearchParams(searchParams);
    const normalized = queryDraft.trim();

    if (normalized) {
      next.set("q", normalized);
    } else {
      next.delete("q");
    }

    next.delete("record");

    if (searchQueryKey(location.pathname, next) === queryKey) {
      setRefreshVersion((version) => version + 1);
    } else {
      setSearchParams(next, { preventScrollReset: true });
    }
  }

  function changeReviewScope(includeReview: boolean) {
    const next = new URLSearchParams(searchParams);

    if (includeReview) {
      next.set("scope", "include_review");
    } else {
      next.delete("scope");
    }

    next.delete("record");
    setSearchParams(next, { preventScrollReset: true });
  }

  function removeTag(tagId: string) {
    const next = new URLSearchParams(searchParams);
    const remaining = next.getAll("tag").filter((value) => value !== tagId);

    next.delete("tag");

    for (const remainingTag of remaining) {
      next.append("tag", remainingTag);
    }

    next.delete("record");
    setSearchParams(next, { preventScrollReset: true });
  }

  function openDrawer(result: SearchResult) {
    const next = new URLSearchParams(searchParams);

    next.set("record", result.record.id);
    drawerOpenedHere.current = true;
    setSearchParams(next, { preventScrollReset: true });
  }

  function preserveSearchEntry() {
    const currentHistoryState = isObject(window.history.state)
      ? window.history.state
      : {};
    const currentUserState = isObject(location.state) ? location.state : {};
    const preserved: SearchWorkspaceSnapshot = {
      items: results,
      nextCursor,
      queryKey,
      scrollTop: resultStage.current?.scrollTop ?? 0,
      v: 1,
    };

    window.history.replaceState(
      {
        ...currentHistoryState,
        usr: { ...currentUserState, searchWorkspace: preserved },
      },
      "",
    );
  }

  function handleSaved() {
    setNewRecordOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  return (
    <div className="search-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <div className={selected ? "search-layout drawer-open" : "search-layout"}>
        <main className="search-result-stage">
          <section
            aria-label="搜索结果"
            className="search-result-region"
            ref={resultStage}
          >
            <header className="search-stage-header">
              <div>
                <p>全库知识检索</p>
                <h1>搜索结果</h1>
              </div>
              <span>
                {loading
                  ? "检索中"
                  : nextCursor
                    ? `已载入 ${results.length} 条记录`
                    : `${results.length} 条记录`}
              </span>
            </header>

            <form
              aria-label="搜索工作台"
              className="search-query-toolbar"
              onSubmit={(event) => {
                event.preventDefault();
                submitQuery();
              }}
              role="search"
            >
              <label>
                <span>关键词或自然语言</span>
                <input
                  aria-label="搜索关键词或自然语言"
                  onChange={(event) => setQueryDraft(event.target.value)}
                  type="search"
                  value={queryDraft}
                />
              </label>
              <button type="submit">搜索记录</button>
              <label className="search-review-scope">
                <input
                  checked={scope === "include_review"}
                  onChange={(event) => changeReviewScope(event.target.checked)}
                  type="checkbox"
                />
                <span>包含待审查内容</span>
              </label>
            </form>

            <SearchReadiness health={health} loadFailed={healthError} />

            {tagIds.length > 0 ? (
              <section aria-label="标签硬筛选" className="search-tag-filters">
                <strong>匹配任一标签</strong>
                <div>
                  {tagIds.map((tagId) => {
                    const selectedTag = availableTags.find(
                      (tag) => tag.id === tagId,
                    );
                    const name = selectedTag ? tagPathLabel(selectedTag) : tagId;
                    const includesChildren = availableTags.some(
                      (tag) => tag.parentId === tagId,
                    );

                    return (
                      <button
                        aria-label={`移除标签：${name}`}
                        key={tagId}
                        onClick={() => removeTag(tagId)}
                        type="button"
                      >
                        {name}
                        {includesChildren ? "（含下级）" : ""}{" "}
                        <span aria-hidden="true">×</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {loadError ? (
              <div className="search-feedback search-error" role="alert">
                <span>{loadError}</span>
                <button
                  onClick={() => setRefreshVersion((version) => version + 1)}
                  type="button"
                >
                  重新提交
                </button>
              </div>
            ) : null}
            {loading ? (
              <p className="search-feedback" role="status">
                正在建立本次搜索快照…
              </p>
            ) : null}
            {!loading && !loadError && results.length === 0 ? (
              <div className="search-empty" role="status">
                <span aria-hidden="true" className="search-empty-signal">
                  <span />
                </span>
                <div>
                  <h2>没有找到匹配记录</h2>
                  <p>
                    {scope === "include_review"
                      ? "尝试更换关键词或移除标签筛选。"
                      : "可更换关键词，或显式包含待审查内容。"}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="search-result-list">
              {results.map((result) => (
                <SearchResultGroup
                  key={result.record.id}
                  buttonRef={(element) => {
                    if (element) {
                      resultButtons.current.set(result.record.id, element);
                    } else {
                      resultButtons.current.delete(result.record.id);
                    }
                  }}
                  onSelect={() => openDrawer(result)}
                  result={result}
                  selected={selected?.record.id === result.record.id}
                />
              ))}
            </div>

            {nextCursor ? (
              <div
                aria-label="继续加载搜索结果"
                className="search-load-sentinel"
                data-testid="search-load-sentinel"
                ref={loadMoreSentinel}
                role="status"
              >
                {loadingMore
                  ? "正在载入后续结果…"
                  : "继续向下滚动，自动载入后续结果。"}
              </div>
            ) : null}
          </section>
        </main>

        {selected ? (
          <SearchDetailDrawer
            onClose={closeDrawer}
            onOpenRecord={preserveSearchEntry}
            result={selected}
          />
        ) : null}
      </div>

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          window.requestAnimationFrame(() => newRecordButton.current?.focus());
        }}
        onSaved={handleSaved}
        open={newRecordOpen}
      />
    </div>
  );
}

function SearchReadiness({
  health,
  loadFailed,
}: {
  health: SearchHealth | null;
  loadFailed: boolean;
}) {
  if (loadFailed) {
    return (
      <p className="search-readiness unavailable" role="status">
        检索状态暂时无法读取，已返回的结果仍可核验。
      </p>
    );
  }

  if (!health) {
    return (
      <p className="search-readiness" role="status">
        正在读取检索状态…
      </p>
    );
  }

  return (
    <div aria-label="检索能力状态" className="search-readiness" role="status">
      <span className="ready">关键词检索可用</span>
      <span className={health.semantic.status}>
        {semanticReadinessLabel(health.semantic)}
      </span>
    </div>
  );
}

function SearchResultGroup({
  buttonRef,
  onSelect,
  result,
  selected,
}: {
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  result: SearchResult;
  selected: boolean;
}) {
  const matches = searchMatches(result);
  const [otherMatchesOpen, setOtherMatchesOpen] = useState(false);
  const otherMatchCount = Math.max(0, matches.length - 1);
  const visibleMatches = otherMatchesOpen ? matches : matches.slice(0, 1);

  return (
    <article className={selected ? "search-result-group selected" : "search-result-group"}>
      <div className="search-result-copy">
        <div className="search-match-meta">
          <p>{matchReasonLabel(result.match.reason)}</p>
          {matches.some((match) => match.visibility === "pending_review") ? (
            <span>待审查内容</span>
          ) : null}
        </div>
        <h2>{result.record.title}</h2>
        <p className="search-result-summary">{result.record.preview}</p>
        <div aria-label="命中来源" className="search-result-sources">
          {visibleMatches.map((match, matchIndex) => {
            const snippets =
              match.snippets.length > 0
                ? match.snippets
                : [{ text: result.record.preview, highlights: [] }];

            return (
              <section
                aria-label={`${sourceMatchLabel(match)}${matchIndex === 0 ? " · 最相关" : ""}`}
                className="search-result-source"
                key={`${match.source.type}-${match.source.id}`}
              >
                <div>
                  <strong>{sourceMatchLabel(match)}</strong>
                  {matchIndex === 0 ? <span>最相关</span> : null}
                  {match.visibility === "pending_review" ? (
                    <span>待审查</span>
                  ) : null}
                </div>
                <div className="search-result-snippets">
                  {snippets.map((snippet, index) => (
                    <p
                      className="search-result-snippet"
                      key={`${snippet.text}-${index}`}
                    >
                      {snippet.text}
                    </p>
                  ))}
                </div>
              </section>
            );
          })}
          {otherMatchCount > 0 ? (
            <button
              aria-expanded={otherMatchesOpen}
              className="search-source-disclosure"
              onClick={() => setOtherMatchesOpen((open) => !open)}
              type="button"
            >
              {otherMatchesOpen ? "收起" : "查看"}其他 {otherMatchCount} 个命中来源
              <span aria-hidden="true">{otherMatchesOpen ? "↑" : "↓"}</span>
            </button>
          ) : null}
        </div>
        <div className="search-result-tags">
          {result.record.myTags.map((tag) => (
            <span key={tag.id}>{tag.name}</span>
          ))}
        </div>
      </div>
      <button
        aria-label={`查看搜索详情：${result.record.title}`}
        className="search-open-detail"
        onClick={onSelect}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function SearchDetailDrawer({
  onClose,
  onOpenRecord,
  result,
}: {
  onClose: () => void;
  onOpenRecord: () => void;
  result: SearchResult;
}) {
  const [detail, setDetail] = useState<RecordDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const matches = searchMatches(result);
  const snippet = result.match.snippets[0]?.text ?? result.record.preview;
  const matchedPointIds = new Set(
    matches.flatMap((match) =>
      match.source.type === "knowledge_point" ? [match.source.id] : [],
    ),
  );
  const isMatchedPoint = (item: RecordDetail["organizedItems"][number]) =>
    matchedPointIds.has(item.id);

  useEffect(() => {
    const controller = new AbortController();

    setDetail(null);
    setDetailError(false);
    void getRecordDetail(result.record.id, controller.signal)
      .then(setDetail)
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          setDetailError(true);
        }
      });

    return () => controller.abort();
  }, [result.record.id]);

  return (
    <aside aria-label="搜索详情" className="search-detail-drawer" role="region">
      <header className="search-drawer-heading">
        <div>
          <p>记录命中核验</p>
          <h2>{detail?.presentation.title ?? result.record.title}</h2>
          {matches.some((match) => match.visibility === "pending_review") ? (
            <span className="search-drawer-review">待审查内容</span>
          ) : null}
        </div>
        <button aria-label="关闭搜索详情" onClick={onClose} type="button">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {detail ? (
        <section aria-label="当前有效记录" className="search-drawer-effective">
          <div>
            <h3>当前有效记录</h3>
            <span>{presentationSourceLabel(detail.presentation.source)}</span>
          </div>
          <p>{detail.presentation.summary ?? "当前记录尚无整理摘要。"}</p>
        </section>
      ) : detailError ? (
        <p className="search-drawer-detail-state" role="status">
          记录详情暂时无法载入；仍可打开完整详情。
        </p>
      ) : (
        <p className="search-drawer-detail-state" role="status">
          正在载入记录详情…
        </p>
      )}
      <section aria-labelledby="matched-content-title" className="matched-original">
        <div>
          <h3 id="matched-content-title">
            {matchedContentTitle(result.match)}
          </h3>
          <span>
            {result.match.reason === "knowledge_point"
              ? "本次命中"
              : matchReasonLabel(result.match.reason)}
          </span>
        </div>
        <p
          aria-label={
            result.match.source.type === "knowledge_point"
              ? "知识点匹配片段"
              : result.match.source.type === "overview"
                ? "概览匹配片段"
                : "原文匹配片段"
          }
        >
          {snippet}
        </p>
      </section>
      {detail && detail.organizedItems.length > 0 ? (
        <section aria-label="当前知识点" className="search-drawer-points">
          <h3>当前知识点</h3>
          <div>
            {detail.organizedItems.map((item) => {
              const matched = isMatchedPoint(item);

              return (
                <article key={item.id}>
                  <div>
                    <h4>{item.title}</h4>
                    <span className={matched ? "matched" : undefined}>
                      {matched ? "本次命中" : "当前知识点"}
                    </span>
                  </div>
                  <p>{item.body}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {detail ? (
        <section aria-label="原文片段" className="search-drawer-original">
          <div>
            <h3>原文片段</h3>
            <span>原文 v{detail.editable.textVersion}</span>
          </div>
          <pre>{detail.editable.text}</pre>
        </section>
      ) : null}
      <section aria-labelledby="drawer-tags-title" className="search-drawer-tags">
        <h3 id="drawer-tags-title">我的标签</h3>
        <div>
          {(detail?.editable.myTags ?? result.record.myTags).map((tag) => (
            <span key={tag.id}>{tag.name}</span>
          ))}
        </div>
      </section>
      <Link
        className="search-open-record"
        onClick={onOpenRecord}
        to={`/records/${encodeURIComponent(result.record.id)}`}
      >
        打开完整详情
        <span aria-hidden="true">→</span>
      </Link>
    </aside>
  );
}

function semanticReadinessLabel(semantic: SearchHealth["semantic"]): string {
  if (semantic.status === "ready") {
    return "语义检索可用";
  }

  if (semantic.status === "paused") {
    return "语义检索暂不可用";
  }

  if (semantic.failedDocuments > 0) {
    return (
      `语义检索部分可用 · ${semantic.readyDocuments}/${semantic.totalDocuments}` +
      `，${semantic.failedDocuments} 条待重试`
    );
  }

  return `语义索引构建中 · ${semantic.readyDocuments}/${semantic.totalDocuments}`;
}

function matchReasonLabel(reason: SearchResult["match"]["reason"]): string {
  if (reason === "knowledge_point") {
    return "AI 整理命中";
  }

  return reason === "semantic" ? "语义相关" : "命中原文";
}

function searchMatches(result: SearchResult): SearchMatch[] {
  return [result.match, ...(result.otherMatches ?? [])];
}

function sourceMatchLabel(match: SearchMatch): string {
  if (match.reason === "semantic") {
    if (match.source.type === "knowledge_point") {
      return "语义相关 · 知识点";
    }

    return match.source.type === "overview"
      ? "语义相关 · AI 概览"
      : "语义相关 · 原文";
  }

  if (match.source.type === "knowledge_point") {
    return "知识点命中";
  }

  return match.source.type === "overview" ? "AI 概览命中" : "原文命中";
}

function matchedContentTitle(match: SearchMatch): string {
  if (match.source.type === "knowledge_point") {
    return "命中知识点";
  }

  if (match.source.type === "overview") {
    return "命中 AI 概览";
  }

  return match.reason === "semantic" ? "语义相关片段" : "命中原文";
}

function presentationSourceLabel(
  source: RecordDetail["presentation"]["source"],
): string {
  if (source === "user_correction") {
    return "用户修订";
  }

  return source === "ai" ? "AI 整理" : "原始记录";
}

function searchQueryKey(pathname: string, params: URLSearchParams): string {
  const query = new URLSearchParams(params);

  query.delete("record");

  return `${pathname}?${query.toString()}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSearchWorkspaceSnapshot(
  state: unknown,
  queryKey: string,
): SearchWorkspaceSnapshot | null {
  if (!isObject(state) || !isObject(state.searchWorkspace)) {
    return null;
  }

  const candidate = state.searchWorkspace;

  if (
    candidate.v !== 1 ||
    candidate.queryKey !== queryKey ||
    !Array.isArray(candidate.items) ||
    !(typeof candidate.nextCursor === "string" || candidate.nextCursor === null) ||
    typeof candidate.scrollTop !== "number"
  ) {
    return null;
  }

  return candidate as unknown as SearchWorkspaceSnapshot;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
