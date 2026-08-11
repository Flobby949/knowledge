import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Link,
  useLocation,
  useSearchParams,
} from "react-router-dom";

import {
  getTagField,
  listRecords,
  type RecordCard,
  type TagFieldItem,
} from "./api.js";
import { AiTaskPulse } from "./ai-task-pulse.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { ThemeToggleButton, useTheme } from "./theme.js";

type ArchiveScope = "active" | "archived" | "all";
type ProcessingFilter =
  | "all"
  | "saved"
  | "processing"
  | "processed"
  | "failed";
type RecordSort = "updated_desc" | "updated_asc";

interface RecordLibrarySnapshot {
  anchor: null | { recordId: string; viewportTop: number };
  items: RecordCard[];
  nextCursor: string | null;
  queryKey: string;
  scrollY: number;
  v: 1;
}

const RECORD_PAGE_SIZE = 24;

export function RecordsPage() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const archive = archiveScope(searchParams.get("archive"));
  const processing = processingFilter(searchParams.get("processing"));
  const query = searchParams.get("q")?.trim() ?? "";
  const sort = recordSort(searchParams.get("sort"));
  const tagIds = searchParams.getAll("tag");
  const tagKey = tagIds.join(",");
  const queryKey = `${location.pathname}${location.search}`;
  const [initialSnapshot] = useState<RecordLibrarySnapshot | null>(() =>
    readRecordLibrarySnapshot(location.state, queryKey),
  );
  const [records, setRecords] = useState<RecordCard[]>(
    () => initialSnapshot?.items ?? [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    () => initialSnapshot?.nextCursor ?? null,
  );
  const [initialLoading, setInitialLoading] = useState(!initialSnapshot);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingError, setLoadingError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [queryDraft, setQueryDraft] = useState(query);
  const [availableTags, setAvailableTags] = useState<TagFieldItem[]>([]);
  const [tagLoadFailed, setTagLoadFailed] = useState(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [restorationReady, setRestorationReady] = useState(!initialSnapshot);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);
  const tagFilter = useRef<HTMLDivElement>(null);
  const restorationQuery = useRef(initialSnapshot?.queryKey ?? null);
  const restorationApplied = useRef(false);

  useEffect(() => {
    setQueryDraft(query);
  }, [query]);

  useEffect(() => {
    let active = true;

    void getTagField()
      .then((items) => {
        if (active) {
          setAvailableTags(items);
          setTagLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setTagLoadFailed(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!tagFilterOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !tagFilter.current?.contains(event.target)
      ) {
        setTagFilterOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTagFilterOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [tagFilterOpen]);

  useLayoutEffect(() => {
    if (
      !initialSnapshot ||
      initialSnapshot.queryKey !== queryKey ||
      restorationApplied.current
    ) {
      return;
    }

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (restorationApplied.current) {
          return;
        }

        restorationApplied.current = true;
        const anchor = initialSnapshot.anchor;
        const anchorLink = anchor
          ? document.querySelector<HTMLElement>(
              `[data-record-id="${anchor.recordId}"] .record-card-link`,
            )
          : null;

        if (anchor && anchorLink) {
          window.scrollBy(
            0,
            anchorLink.getBoundingClientRect().top - anchor.viewportTop,
          );
        } else {
          window.scrollTo(0, initialSnapshot.scrollY);
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
  }, [initialSnapshot, queryKey]);

  useEffect(() => {
    if (restorationQuery.current === queryKey) {
      return;
    }

    restorationQuery.current = null;
    let active = true;
    const controller = new AbortController();

    setRecords([]);
    setNextCursor(null);
    setInitialLoading(true);
    setLoadingMore(false);
    setLoadingError("");
    setRestorationReady(true);

    void listRecords({
      archive,
      limit: RECORD_PAGE_SIZE,
      ...(processing === "all" ? {} : { processing }),
      ...(query ? { q: query } : {}),
      signal: controller.signal,
      sort,
      tagIds,
    })
      .then((page) => {
        if (active) {
          setRecords(page.items);
          setNextCursor(page.nextCursor);
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setLoadingError("记录暂时无法载入，请稍后重试。");
        }
      })
      .finally(() => {
        if (active) {
          setInitialLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [archive, processing, query, queryKey, sort, tagKey]);

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;

    if (!sentinel || !nextCursor || !restorationReady) {
      return;
    }

    let active = true;
    const controller = new AbortController();
    const cursor = nextCursor;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      observer.disconnect();
      setLoadingMore(true);
      setLoadingError("");

      void listRecords({
        archive,
        cursor,
        limit: RECORD_PAGE_SIZE,
        ...(processing === "all" ? {} : { processing }),
        ...(query ? { q: query } : {}),
        signal: controller.signal,
        sort,
        tagIds,
      })
        .then((page) => {
          if (!active) {
            return;
          }

          setRecords((current) => {
            const existingIds = new Set(current.map((record) => record.id));

            return [
              ...current,
              ...page.items.filter((record) => !existingIds.has(record.id)),
            ];
          });
          setNextCursor(page.nextCursor);
        })
        .catch((error: unknown) => {
          if (active && !isAbortError(error)) {
            setLoadingError(
              "后续记录暂时无法载入，已显示的记录仍可继续查看。",
            );
            setNextCursor(null);
          }
        })
        .finally(() => {
          if (active) {
            setLoadingMore(false);
          }
        });
    });

    observer.observe(sentinel);

    return () => {
      active = false;
      observer.disconnect();
      controller.abort();
    };
  }, [archive, nextCursor, processing, query, restorationReady, sort, tagKey]);

  function closeDialog() {
    setDialogOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  function handleSaved(record: RecordCard) {
    if (
      archive === "active" &&
      processing === "all" &&
      !query &&
      tagIds.length === 0 &&
      sort === "updated_desc"
    ) {
      setRecords((current) => [record, ...current]);
    }

    closeDialog();
  }

  function updateSearchParams(
    update: (next: URLSearchParams) => void,
  ) {
    const next = new URLSearchParams(searchParams);

    update(next);
    setSearchParams(next, { preventScrollReset: true });
  }

  function changeArchive(nextArchive: ArchiveScope) {
    updateSearchParams((next) => {
      if (nextArchive === "active") {
        next.delete("archive");
      } else {
        next.set("archive", nextArchive);
      }
    });
  }

  function changeProcessing(nextProcessing: ProcessingFilter) {
    updateSearchParams((next) => {
      if (nextProcessing === "all") {
        next.delete("processing");
      } else {
        next.set("processing", nextProcessing);
      }
    });
  }

  function changeSort(nextSort: RecordSort) {
    updateSearchParams((next) => {
      if (nextSort === "updated_desc") {
        next.delete("sort");
      } else {
        next.set("sort", nextSort);
      }
    });
  }

  function toggleTag(tagId: string, selected: boolean) {
    updateSearchParams((next) => {
      const selectedTags = next
        .getAll("tag")
        .filter((current) => current !== tagId);

      if (selected) {
        selectedTags.push(tagId);
      }

      next.delete("tag");

      for (const selectedTag of selectedTags) {
        next.append("tag", selectedTag);
      }
    });
  }

  function preserveLibraryEntry(recordId: string, viewportTop: number) {
    const currentHistoryState = isObject(window.history.state)
      ? window.history.state
      : {};
    const currentUserState = isObject(location.state) ? location.state : {};
    const snapshot: RecordLibrarySnapshot = {
      anchor: { recordId, viewportTop },
      items: records,
      nextCursor,
      queryKey,
      scrollY: window.scrollY,
      v: 1,
    };

    window.history.replaceState(
      {
        ...currentHistoryState,
        usr: { ...currentUserState, recordLibrary: snapshot },
      },
      "",
    );
  }

  const activeFilters =
    Boolean(query) ||
    tagIds.length > 0 ||
    processing !== "all" ||
    archive !== "active" ||
    sort !== "updated_desc";

  return (
    <div className="records-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setDialogOpen(true)}
      />

      <main className="records-main">
        <header className="records-library-heading">
          <div className="records-library-title">
            <span aria-hidden="true" className="records-library-orbit">
              <span />
            </span>
            <div>
              <p>原文与知识的入口</p>
              <h1>记录库</h1>
            </div>
          </div>
          <p className="records-library-thesis">
            从每条原文出发，继续阅读它的整理状态、知识点与历史。
          </p>
          <p aria-live="polite" className="records-library-count">
            {initialLoading ? "正在载入" : `当前已载入 ${records.length} 条`}
          </p>
        </header>

        <form
          aria-label="记录筛选"
          className="records-toolbar"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = queryDraft.trim();

            updateSearchParams((next) => {
              if (submitted) {
                next.set("q", submitted);
              } else {
                next.delete("q");
              }
            });
          }}
        >
          <label className="toolbar-search">
            <span className="visually-hidden">搜索记录</span>
            <span aria-hidden="true" className="search-icon" />
            <input
              aria-label="搜索记录"
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="搜索记录，按 Enter 应用"
              type="search"
              value={queryDraft}
            />
          </label>
          <div className="tag-filter" ref={tagFilter}>
            <button
              aria-expanded={tagFilterOpen}
              aria-haspopup="true"
              aria-label="标签"
              className="filter-control"
              onClick={() => setTagFilterOpen((open) => !open)}
              type="button"
            >
              标签 <span aria-hidden="true">⌄</span>
            </button>
            {tagFilterOpen ? (
              <div
                aria-label="标签筛选"
                className="tag-filter-popover"
                role="group"
              >
                {availableTags.length > 0 ? (
                  availableTags.map((tag) => (
                    <label className="tag-filter-option" key={tag.id}>
                      <input
                        aria-label={tag.name}
                        checked={tagIds.includes(tag.id)}
                        onChange={(event) =>
                          toggleTag(tag.id, event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span>{tag.name}</span>
                      <small>{tag.recordCount}</small>
                    </label>
                  ))
                ) : (
                  <p role="status">
                    {tagLoadFailed ? "标签暂时无法载入。" : "正在载入标签…"}
                  </p>
                )}
              </div>
            ) : null}
          </div>
          <label className="filter-control select-filter">
            <span aria-hidden="true">处理状态</span>
            <select
              aria-label="处理状态"
              onChange={(event) =>
                changeProcessing(event.target.value as ProcessingFilter)
              }
              value={processing}
            >
              <option value="all">全部</option>
              <option value="saved">仅保存</option>
              <option value="processing">AI 正在处理</option>
              <option value="processed">AI 整理完成</option>
              <option value="failed">AI 整理失败</option>
            </select>
          </label>
          <label className="filter-control archive-filter">
            <span aria-hidden="true">归档状态</span>
            <select
              aria-label="归档状态"
              onChange={(event) =>
                changeArchive(event.target.value as ArchiveScope)
              }
              value={archive}
            >
              <option value="active">当前记录</option>
              <option value="archived">已归档</option>
              <option value="all">全部记录</option>
            </select>
          </label>
          <label className="filter-control select-filter sort-control">
            <span aria-hidden="true">排序</span>
            <select
              aria-label="排序"
              onChange={(event) =>
                changeSort(event.target.value as RecordSort)
              }
              value={sort}
            >
              <option value="updated_desc">最近更新</option>
              <option value="updated_asc">最早更新</option>
            </select>
          </label>

          {activeFilters ? (
            <section aria-label="已启用筛选" className="active-filters">
              <span className="active-filter-label">已启用</span>
              {query ? (
                <button
                  aria-label={`移除搜索：${query}`}
                  className="filter-chip"
                  onClick={() =>
                    updateSearchParams((next) => next.delete("q"))
                  }
                  type="button"
                >
                  搜索：{query} <span aria-hidden="true">×</span>
                </button>
              ) : null}
              {tagIds.map((tagId) => {
                const name =
                  availableTags.find((tag) => tag.id === tagId)?.name ?? tagId;

                return (
                  <button
                    aria-label={`移除标签：${name}`}
                    className="filter-chip"
                    key={tagId}
                    onClick={() => toggleTag(tagId, false)}
                    type="button"
                  >
                    标签：{name} <span aria-hidden="true">×</span>
                  </button>
                );
              })}
              {processing !== "all" ? (
                <button
                  aria-label={`移除处理状态：${processingLabel(processing)}`}
                  className="filter-chip"
                  onClick={() => changeProcessing("all")}
                  type="button"
                >
                  {processingLabel(processing)} <span aria-hidden="true">×</span>
                </button>
              ) : null}
              {archive !== "active" ? (
                <button
                  aria-label={`移除归档状态：${archiveLabel(archive)}`}
                  className="filter-chip"
                  onClick={() => changeArchive("active")}
                  type="button"
                >
                  {archiveLabel(archive)} <span aria-hidden="true">×</span>
                </button>
              ) : null}
              {sort !== "updated_desc" ? (
                <button
                  aria-label="移除排序：最早更新"
                  className="filter-chip"
                  onClick={() => changeSort("updated_desc")}
                  type="button"
                >
                  最早更新 <span aria-hidden="true">×</span>
                </button>
              ) : null}
              <button
                className="clear-filters"
                onClick={() =>
                  setSearchParams(new URLSearchParams(), {
                    preventScrollReset: true,
                  })
                }
                type="button"
              >
                清除全部
              </button>
            </section>
          ) : null}
        </form>

        {loadingError ? (
          <p className="load-error" role="alert">
            {loadingError}
          </p>
        ) : null}

        {initialLoading ? (
          <p aria-label="正在载入记录" className="records-loading" role="status">
            正在载入记录…
          </p>
        ) : null}

        <section
          aria-label="记录列表"
          className="records-masonry"
          data-testid="records-masonry"
        >
          {records.map((record, index) => (
            <RecordArchiveCard
              leadLabel={
                index === 0
                  ? sort === "updated_desc"
                    ? "最近更新"
                    : "最早更新"
                  : null
              }
              key={record.id}
              index={records.length - index}
              onOpen={(viewportTop) =>
                preserveLibraryEntry(record.id, viewportTop)
              }
              record={record}
            />
          ))}
        </section>

        {!initialLoading && records.length === 0 && !loadingError ? (
          <div className="records-empty" role="status">
            <span aria-hidden="true" className="records-empty-signal">
              <span />
            </span>
            <p>
              {activeFilters
                ? "没有符合当前筛选的记录。"
                : "当前范围内还没有记录。"}
            </p>
          </div>
        ) : null}

        {nextCursor ? (
          <div
            aria-label="继续加载记录"
            className="records-load-sentinel"
            ref={loadMoreSentinel}
            role="status"
          >
            {loadingMore ? "正在载入后续记录…" : "继续向下滚动，自动载入更多记录。"}
          </div>
        ) : null}
      </main>

      <NewRecordDialog
        open={dialogOpen}
        onClose={closeDialog}
        onSaved={handleSaved}
      />
    </div>
  );
}

function archiveScope(value: string | null): ArchiveScope {
  return value === "archived" || value === "all" ? value : "active";
}

function processingFilter(value: string | null): ProcessingFilter {
  return value === "saved" ||
    value === "processing" ||
    value === "processed" ||
    value === "failed"
    ? value
    : "all";
}

function recordSort(value: string | null): RecordSort {
  return value === "updated_asc" ? value : "updated_desc";
}

function processingLabel(value: Exclude<ProcessingFilter, "all">): string {
  if (value === "saved") {
    return "仅保存";
  }

  if (value === "processing") {
    return "AI 正在处理";
  }

  return value === "processed" ? "AI 整理完成" : "AI 整理失败";
}

function archiveLabel(value: Exclude<ArchiveScope, "active">): string {
  return value === "archived" ? "已归档" : "全部记录";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecordLibrarySnapshot(
  state: unknown,
  queryKey: string,
): RecordLibrarySnapshot | null {
  if (!isObject(state) || !isObject(state.recordLibrary)) {
    return null;
  }

  const snapshot = state.recordLibrary;

  if (
    snapshot.v !== 1 ||
    snapshot.queryKey !== queryKey ||
    !Array.isArray(snapshot.items) ||
    !(typeof snapshot.nextCursor === "string" || snapshot.nextCursor === null) ||
    typeof snapshot.scrollY !== "number"
  ) {
    return null;
  }

  return snapshot as unknown as RecordLibrarySnapshot;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function AppNavigation({
  newRecordButton,
  onCreate,
}: {
  newRecordButton: React.RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
}) {
  const { theme } = useTheme();
  const location = useLocation();
  const darkNavigation = theme === "scifi" && location.pathname === "/";
  const workspaceNavigation = location.pathname !== "/";

  return (
    <header className={workspaceNavigation ? "app-header is-workspace" : "app-header"}>
      <nav
        aria-label="主导航"
        className={`app-navigation ${darkNavigation ? "dark" : "light"}${workspaceNavigation ? " workspace-navigation" : ""}`}
        data-testid="app-nav"
      >
        <div className="nav-primary">
          <Link aria-label="知识库首页" className="brand-mark" to="/">
            <span aria-hidden="true" className="brand-orbit" />
          </Link>
          <span aria-hidden="true" className="nav-divider" />
          <Link aria-current={location.pathname === "/" ? "page" : undefined} className={location.pathname === "/" ? "active" : undefined} to="/">
            <NavigationGlyph kind="home" />
            <span className="nav-link-label">首页</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/records") ? "page" : undefined} className={location.pathname.startsWith("/records") ? "active" : undefined} to="/records">
            <NavigationGlyph kind="records" />
            <span className="nav-link-label">记录</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/review") ? "page" : undefined} className={location.pathname.startsWith("/review") ? "active" : undefined} to="/review">
            <NavigationGlyph kind="review" />
            <span className="nav-link-label">待审查</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/tags") ? "page" : undefined} className={location.pathname.startsWith("/tags") ? "active" : undefined} to="/tags">
            <NavigationGlyph kind="tags" />
            <span className="nav-link-label">标签</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/concepts") ? "page" : undefined} className={location.pathname.startsWith("/concepts") ? "active" : undefined} to="/concepts">
            <NavigationGlyph kind="concepts" />
            <span className="nav-link-label">概念</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/network") ? "page" : undefined} className={location.pathname.startsWith("/network") ? "active" : undefined} to="/network">
            <NavigationGlyph kind="network" />
            <span className="nav-link-label">网络</span>
          </Link>
          <Link aria-current={location.pathname.startsWith("/insights") ? "page" : undefined} className={location.pathname.startsWith("/insights") ? "active" : undefined} to="/insights">
            <NavigationGlyph kind="insights" />
            <span className="nav-link-label">发现</span>
          </Link>
        </div>

        <div className="nav-actions">
          <AiTaskPulse />
          <button ref={newRecordButton} className="primary-button" onClick={onCreate} type="button">
            新建记录
          </button>
          <ThemeToggleButton />
          <span aria-hidden="true" className="nav-divider" />
          <Link aria-current={location.pathname.startsWith("/settings") ? "page" : undefined} className={location.pathname.startsWith("/settings") ? "settings-link active" : "settings-link"} to="/settings">
            <NavigationGlyph kind="settings" />
            <span className="nav-link-label">设置</span>
          </Link>
        </div>
      </nav>
    </header>
  );
}

function NavigationGlyph({
  kind,
}: {
    kind:
      | "concepts"
      | "home"
      | "insights"
      | "network"
      | "records"
      | "review"
      | "settings"
      | "tags";
}) {
  const common = {
    "aria-hidden": true,
    className: "nav-glyph",
    fill: "none",
    viewBox: "0 0 24 24",
  } as const;

  if (kind === "home") {
    return (
      <svg {...common}>
        <path d="M3.5 10.5 12 3l8.5 7.5v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19.5z" />
        <path d="M9 21v-6.5h6V21" />
      </svg>
    );
  }

  if (kind === "records") {
    return (
      <svg {...common}>
        <path d="M6 3.5h9l3 3V20.5H6z" />
        <path d="M15 3.5v3h3M9 11h6M9 15h6" />
      </svg>
    );
  }

  if (kind === "review") {
    return (
      <svg {...common}>
        <rect height="17" rx="1.5" width="14" x="5" y="4" />
        <path d="M9 3h6v3H9zM8.5 12l2 2 4.5-5" />
      </svg>
    );
  }

  if (kind === "tags") {
    return (
      <svg {...common}>
        <path d="M3.5 12.5 12 4h7.5v7.5L11 20z" />
        <circle cx="16" cy="7.5" r="1" />
      </svg>
    );
  }

  if (kind === "insights") {
    return (
      <svg {...common}>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5.5" cy="17.5" r="2" />
        <circle cx="18.5" cy="17.5" r="2" />
        <path d="m10.8 6.8-4.1 8.8M13.2 6.8l4.1 8.8M7.5 17.5h9" />
      </svg>
    );
  }

  if (kind === "concepts") {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3.5" />
        <circle cx="16" cy="16" r="3.5" />
        <path d="m10.5 10.5 3 3M14.5 5.5l4-2M5.5 14.5l-2 4" />
      </svg>
    );
  }

  if (kind === "network") {
    return (
      <svg {...common}>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="3" />
        <path d="m8.4 7.4 7.2-.8M7.5 9l3.2 6.4M16.5 8.3l-3.2 7.1" />
        <circle cx="12" cy="18" r="1" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5" />
    </svg>
  );
}

function RecordArchiveCard({
  index,
  leadLabel,
  onOpen,
  record,
}: {
  index: number;
  leadLabel: string | null;
  onOpen: (viewportTop: number) => void;
  record: RecordCard;
}) {
  const excerpt = recordExcerpt(record);
  const stateKind = recordStateKind(record);
  const link = useRef<HTMLAnchorElement>(null);
  const [visibility, setVisibility] = useState({
    intrinsicSize: 220,
    nearViewport: true,
  });

  useEffect(() => {
    const element = link.current;

    if (!element) {
      return;
    }

    return observeRecordCard(element, (nearViewport, intrinsicSize) => {
      setVisibility((current) => ({
        intrinsicSize: intrinsicSize > 0
          ? intrinsicSize
          : current.intrinsicSize,
        nearViewport,
      }));
    });
  }, []);

  return (
    <article
      className={leadLabel ? "record-card is-lead" : "record-card"}
      data-record-id={record.id}
      data-testid="record-card"
    >
      <Link
        aria-label={`打开记录：${record.title}`}
        className={`record-card-link${visibility.nearViewport ? " is-near-viewport" : ""}`}
        onClick={(event) =>
          onOpen(event.currentTarget.getBoundingClientRect().top)
        }
        ref={link}
        style={{
          "--record-card-intrinsic-size": `${visibility.intrinsicSize}px`,
        } as CSSProperties}
        to={`/records/${record.id}`}
      >
        <div className="record-index-row" aria-hidden="true">
          <span className="record-index-signal">
            <span className="archive-glyph">◉</span>
            {leadLabel ? (
              <span className="record-lead-label">{leadLabel}</span>
            ) : null}
          </span>
          <span>· {String(index).padStart(4, "0")}</span>
        </div>
        <h2>{record.title}</h2>
        {excerpt ? <p className="record-preview">{excerpt}</p> : null}
        <div className="record-tags">
          {record.myTags.map((tag) => <span key={tag.id}>{tag.name}</span>)}
        </div>
        <div className="record-meta">
          <span className={`record-state is-${stateKind}`}>
            <span aria-hidden="true" className="record-state-mark">
              {recordStateMark(stateKind)}
            </span>
            <span>{recordStateLabel(record)}</span>
          </span>
          <time dateTime={record.updatedAt}>{formatRelativeTime(record.updatedAt)}</time>
        </div>
      </Link>
    </article>
  );
}

const recordCardObservers = new Map<
  Element,
  (nearViewport: boolean, intrinsicSize: number) => void
>();
let recordCardObserver: IntersectionObserver | null = null;

function observeRecordCard(
  element: Element,
  onVisibilityChange: (
    nearViewport: boolean,
    intrinsicSize: number,
  ) => void,
): () => void {
  recordCardObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        recordCardObservers.get(entry.target)?.(
          entry.isIntersecting,
          entry.target.getBoundingClientRect().height,
        );
      }
    },
    { rootMargin: "400px 0px" },
  );
  recordCardObservers.set(element, onVisibilityChange);
  recordCardObserver.observe(element);

  return () => {
    recordCardObserver?.unobserve(element);
    recordCardObservers.delete(element);

    if (recordCardObservers.size === 0) {
      recordCardObserver?.disconnect();
      recordCardObserver = null;
    }
  };
}

function recordStateLabel(record: RecordCard): string {
  if (record.lifecycle === "archived") {
    return "已归档";
  }

  if (
    record.organization.activity === "queued" ||
    record.organization.activity === "running"
  ) {
    return "AI 正在处理";
  }

  if (record.organization.activity === "failed") {
    return "AI 整理失败";
  }

  return record.organization.view === "organized" ? "AI 整理完成" : "仅保存";
}

type RecordStateKind =
  | "archived"
  | "failed"
  | "organized"
  | "queued"
  | "running"
  | "saved-only";

function recordStateKind(record: RecordCard): RecordStateKind {
  if (record.lifecycle === "archived") {
    return "archived";
  }

  if (record.organization.activity !== "idle") {
    return record.organization.activity;
  }

  return record.organization.view === "organized" ? "organized" : "saved-only";
}

function recordStateMark(stateKind: RecordStateKind): string {
  if (stateKind === "organized") {
    return "✓";
  }

  if (stateKind === "queued" || stateKind === "running") {
    return "…";
  }

  if (stateKind === "failed") {
    return "!";
  }

  return stateKind === "archived" ? "—" : "•";
}

function recordExcerpt(record: RecordCard): string {
  const lines = record.preview.split(/\r\n|\n|\r/u);
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0);

  if (firstNonEmpty >= 0 && lines[firstNonEmpty]?.trim() === record.title) {
    lines.splice(firstNonEmpty, 1);
  }

  return lines.join("\n").trim();
}

function formatRelativeTime(value: string): string {
  const elapsedHours = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 3_600_000));

  if (elapsedHours < 1) {
    return "刚刚";
  }

  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`;
  }

  return `${Math.floor(elapsedHours / 24)} 天前`;
}
