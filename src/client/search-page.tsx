/*
 * THESIS: Search is a verification table with a fixed reading drawer, never a modal interruption.
 * OWN-WORLD: Paper-white result groups, graphite text, hairline rules, and electric-blue match signals.
 * STORY: A submitted query narrows the archive, then one record opens beside the stable result context.
 * FIRST VIEWPORT: 60px global navigation, full result stage, and an optional 480px push drawer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import {
  getTagField,
  searchRecords,
  type SearchResult,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./search-page.css";

export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const tagId = searchParams.get("tag") ?? "";
  const selectedId = searchParams.get("record") ?? "";
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastSelectedId = useRef("");
  const drawerOpenedHere = useRef(false);
  const selected =
    results.find((result) => result.record.id === selectedId) ?? null;

  useEffect(() => {
    let active = true;

    setLoading(true);
    setLoadError("");
    void searchRecords(query, tagId || undefined)
      .then((items) => {
        if (active) {
          setResults(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("搜索暂时不可用，请稍后重试。");
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [query, tagId]);

  useEffect(() => {
    let active = true;

    if (!tagId) {
      setTagName("");
      return () => {
        active = false;
      };
    }

    void getTagField().then((tags) => {
      if (active) {
        setTagName(tags.find((tag) => tag.id === tagId)?.name ?? "未知标签");
      }
    });

    return () => {
      active = false;
    };
  }, [tagId]);

  useEffect(() => {
    if (selectedId) {
      lastSelectedId.current = selectedId;
      return;
    }

    drawerOpenedHere.current = false;
    const resultId = lastSelectedId.current;

    if (resultId) {
      window.requestAnimationFrame(() => resultButtons.current.get(resultId)?.focus());
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

  function openDrawer(result: SearchResult) {
    const next = new URLSearchParams(searchParams);
    next.set("record", result.record.id);
    drawerOpenedHere.current = true;
    setSearchParams(next);
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
          <section aria-label="搜索结果" className="search-result-region">
          <header className="search-stage-header">
            <div>
              <p>全库关键词检索</p>
              <h1>搜索结果</h1>
            </div>
            <span>{loading ? "检索中" : `${results.length} 条记录`}</span>
          </header>

          <div className="search-query-line">
            <span>查询</span>
            <strong>{query || "全部相关记录"}</strong>
          </div>

          {tagId ? (
            <p aria-label="当前标签筛选" className="search-tag-filter" role="status">
              当前标签筛选 · {tagName || "正在载入"}
            </p>
          ) : null}

          {loadError ? <p className="search-feedback" role="alert">{loadError}</p> : null}
          {loading ? <p className="search-feedback" role="status">正在检索记录…</p> : null}
          {!loading && !loadError && results.length === 0 ? (
            <div className="search-empty">
              <h2>没有找到匹配记录</h2>
              <p>尝试使用原文中更明确的关键词。</p>
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
          </section>
        </main>

        {selected ? (
          <SearchDetailDrawer onClose={closeDrawer} result={selected} />
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
  const snippet = result.match.snippets[0]?.text ?? result.record.preview;

  return (
    <article className={selected ? "search-result-group selected" : "search-result-group"}>
      <div className="search-result-copy">
        <p>命中原文</p>
        <h2>{result.record.title}</h2>
        <p className="search-result-snippet">{snippet}</p>
        <div className="search-result-tags">
          {result.record.myTags.map((tag) => <span key={tag.id}>{tag.name}</span>)}
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
  result,
}: {
  onClose: () => void;
  result: SearchResult;
}) {
  const snippet = result.match.snippets[0]?.text ?? "";

  return (
    <aside aria-label="搜索详情" className="search-detail-drawer" role="region">
      <header className="search-drawer-heading">
        <div>
          <p>记录命中核验</p>
          <h2>{result.record.title}</h2>
        </div>
        <button aria-label="关闭搜索详情" onClick={onClose} type="button">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <section aria-labelledby="matched-original-title" className="matched-original">
        <div>
          <h3 id="matched-original-title">命中原文</h3>
          <span>关键词</span>
        </div>
        <p aria-label="原文匹配片段">{snippet}</p>
      </section>
      <section aria-labelledby="drawer-tags-title" className="search-drawer-tags">
        <h3 id="drawer-tags-title">我的标签</h3>
        <div>
          {result.record.myTags.map((tag) => <span key={tag.id}>{tag.name}</span>)}
        </div>
      </section>
      <Link
        className="search-open-record"
        to={`/records/${encodeURIComponent(result.record.id)}`}
      >
        打开完整详情
        <span aria-hidden="true">→</span>
      </Link>
    </aside>
  );
}
