/*
 * THESIS: Knowledge discovery is a review desk, not an autonomous cleanup engine.
 * OWN-WORLD: A quiet evidence workspace with explicit decisions and persistent source links.
 * STORY: Scan, inspect both sides, decide, then revisit or undo without touching source history.
 * FIRST VIEWPORT: A 76px signal rail, 72px command bar, compact thesis header, three work tabs, and an evidence-first review list.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  acceptDuplicateSuggestion,
  confirmRelationSuggestion,
  createCoverageAnalysis,
  listCoverageAnalyses,
  listCoverageSources,
  listDuplicateSuggestions,
  listRelationSuggestions,
  rejectDuplicateSuggestion,
  rejectRelationSuggestion,
  removeKnowledgeRelation,
  retryCoverageAnalysis,
  scanDuplicateSuggestions,
  scanRelationSuggestions,
  undoDuplicateConsolidation,
  type CoverageAnalysis,
  type CoverageSource,
  type DuplicateSuggestion,
  type KnowledgeRelationType,
  type RelationSuggestion,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./insights-page.css";

type InsightTab = "coverage" | "duplicates" | "relations";
type ReviewSection = "pending" | "resolved";

const RELATION_LABELS: Record<KnowledgeRelationType, string> = {
  analogy: "类比",
  applies: "应用于",
  contrasts: "对照",
  extends: "扩展",
  prerequisite: "前置依赖",
  similar: "相似",
};

export function InsightsPage() {
  const [tab, setTab] = useState<InsightTab>("duplicates");
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);

  return (
    <div className="insights-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main aria-label="知识发现" className="insights-main">
        <header className="insights-heading">
          <div>
            <p>V2 · 人工治理</p>
            <h1>知识发现</h1>
          </div>
          <p className="insights-thesis">
            AI 负责召回和解释，你负责最后决定。这里的操作只新增可撤销的治理关系，
            不删除原文、知识点或历史版本。
          </p>
        </header>

        <div aria-label="知识发现分区" className="insight-tabs" role="tablist">
          <button
            aria-controls="insight-panel"
            aria-selected={tab === "duplicates"}
            onClick={() => setTab("duplicates")}
            role="tab"
            type="button"
          >
            重复建议
          </button>
          <button
            aria-controls="insight-panel"
            aria-selected={tab === "relations"}
            onClick={() => setTab("relations")}
            role="tab"
            type="button"
          >
            关系审查
          </button>
          <button
            aria-controls="insight-panel"
            aria-selected={tab === "coverage"}
            onClick={() => setTab("coverage")}
            role="tab"
            type="button"
          >
            覆盖分析
          </button>
        </div>

        <section id="insight-panel" role="tabpanel">
          {tab === "duplicates" ? <DuplicatePanel /> : null}
          {tab === "relations" ? <RelationPanel /> : null}
          {tab === "coverage" ? <CoveragePanel /> : null}
        </section>
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

function DuplicatePanel() {
  const [section, setSection] = useState<ReviewSection>("pending");
  const [items, setItems] = useState<DuplicateSuggestion[]>([]);
  const [selectedPrimary, setSelectedPrimary] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError("");
    void listDuplicateSuggestions(section)
      .then((next) => {
        if (active) {
          setItems(next);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(errorMessage(caught, "重复建议暂时无法载入。"));
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
  }, [reload, section]);

  async function scan() {
    setBusy("scan");
    setError("");
    setNotice("");

    try {
      const result = await scanDuplicateSuggestions();
      const semanticNote =
        result.semanticStatus === "ready"
          ? `，语义候选 ${result.semanticCandidates} 组`
          : "；向量未就绪，本次仍已完成标准化精确扫描";
      setNotice(
        `扫描完成：精确候选 ${result.exactCandidates} 组${semanticNote}，待审 ${result.pendingSuggestions} 组。`,
      );
      setSection("pending");
      setReload((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught, "扫描失败，请稍后重试。"));
    } finally {
      setBusy("");
    }
  }

  async function decide(
    suggestion: DuplicateSuggestion,
    decision: "accept" | "reject" | "undo",
  ) {
    setBusy(suggestion.id);
    setError("");
    setNotice("");

    try {
      if (decision === "accept") {
        const primarySourceId = selectedPrimary[suggestion.id];

        if (!primarySourceId) {
          setError("请先选择一项作为主要展示来源。");
          return;
        }

        await acceptDuplicateSuggestion(suggestion.id, primarySourceId);
        setNotice("已建立来源保留合并；两份原始内容仍完整保留，可随时撤销。");
      } else if (decision === "reject") {
        await rejectDuplicateSuggestion(suggestion.id);
        setNotice("已忽略这条建议，内容没有发生变化。");
      } else {
        await undoDuplicateConsolidation(suggestion.id);
        setNotice("合并关系已撤销，两项内容仍保持原样。");
      }

      setReload((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught, "操作失败，请刷新后重试。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="insight-workspace">
      <WorkspaceToolbar
        actionBusy={busy === "scan"}
        actionLabel="扫描重复项"
        description="先做标准化精确匹配；向量就绪时，再补充高相似语义召回。所有结果都要人工决定。"
        onAction={() => void scan()}
        onSectionChange={setSection}
        section={section}
      />
      <Feedback error={error} notice={notice} />

      {loading ? <LoadingCopy /> : null}
      {!loading && items.length === 0 ? (
        <EmptyCopy
          title={section === "pending" ? "目前没有待审重复项" : "还没有已处理记录"}
          body={
            section === "pending"
              ? "运行扫描后，候选会出现在这里；系统不会自动合并。"
              : "接受或忽略重复建议后，可在这里回看和撤销。"
          }
        />
      ) : null}

      <div className="review-card-list">
        {items.map((suggestion) => (
          <article className="review-card" key={suggestion.id}>
            <header className="review-card-heading">
              <div>
                <span className={`signal-badge ${suggestion.kind}`}>
                  {suggestion.kind === "exact" ? "标准化精确" : "语义相似"}
                </span>
                <strong>{Math.round(suggestion.score * 100)}% 匹配</strong>
              </div>
              <span>{duplicateStatusLabel(suggestion.status)}</span>
            </header>

            <p className="review-reason">{suggestion.reason}</p>
            <div className="comparison-grid">
              {suggestion.sources.map((source, index) => {
                const checked = selectedPrimary[suggestion.id] === source.id;
                const isPrimary = suggestion.primarySourceId === source.id;

                return (
                  <section className="evidence-pane" key={`${source.type}:${source.id}`}>
                    <div className="evidence-pane-meta">
                      <span>{source.type === "original" ? "原始记录" : "知识点"}</span>
                      <span>来源 {index + 1}</span>
                    </div>
                    <h3>{source.title}</h3>
                    <Link to={`/records/${source.recordId}`}>{source.recordTitle}</Link>
                    <p>{source.excerpt}</p>
                    {section === "pending" ? (
                      <label className="primary-source-choice">
                        <input
                          checked={checked}
                          disabled={!suggestion.canDecide || busy === suggestion.id}
                          name={`primary-${suggestion.id}`}
                          onChange={() =>
                            setSelectedPrimary((current) => ({
                              ...current,
                              [suggestion.id]: source.id,
                            }))
                          }
                          type="radio"
                        />
                        设为主要展示来源
                      </label>
                    ) : isPrimary ? (
                      <span className="selected-source-label">主要展示来源</span>
                    ) : null}
                  </section>
                );
              })}
            </div>

            {section === "pending" ? (
              <footer className="review-actions">
                <p>接受只会新增一条合并关系，不删除、不覆盖任一来源。</p>
                <div>
                  <button
                    className="secondary-button"
                    disabled={busy === suggestion.id}
                    onClick={() => void decide(suggestion, "reject")}
                    type="button"
                  >
                    不是重复项
                  </button>
                  <button
                    className="primary-button"
                    disabled={
                      busy === suggestion.id ||
                      !suggestion.canDecide ||
                      !selectedPrimary[suggestion.id]
                    }
                    onClick={() => void decide(suggestion, "accept")}
                    type="button"
                  >
                    建立来源保留合并
                  </button>
                </div>
              </footer>
            ) : suggestion.status === "accepted" ? (
              <footer className="review-actions">
                <p>当前仅统一展示入口，来源对象和历史仍独立存在。</p>
                <button
                  className="secondary-button"
                  disabled={busy === suggestion.id}
                  onClick={() => void decide(suggestion, "undo")}
                  type="button"
                >
                  撤销合并关系
                </button>
              </footer>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function RelationPanel() {
  const [section, setSection] = useState<ReviewSection>("pending");
  const [items, setItems] = useState<RelationSuggestion[]>([]);
  const [edits, setEdits] = useState<
    Record<string, { description: string; type: KnowledgeRelationType }>
  >({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError("");
    void listRelationSuggestions(section)
      .then((next) => {
        if (active) {
          setItems(next);
          setEdits((current) => {
            const updated = { ...current };

            for (const item of next) {
              updated[item.id] ??= {
                description: item.description,
                type: item.type,
              };
            }

            return updated;
          });
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(errorMessage(caught, "关系建议暂时无法载入。"));
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
  }, [reload, section]);

  async function scan() {
    setBusy("scan");
    setError("");
    setNotice("");

    try {
      const result = await scanRelationSuggestions();
      setNotice(
        `扫描完成：召回 ${result.recalledPairs} 组，新增 ${result.suggestedRelations} 条建议，待审 ${result.pendingSuggestions} 条。`,
      );
      setSection("pending");
      setReload((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught, "关系扫描失败，请稍后重试。"));
    } finally {
      setBusy("");
    }
  }

  async function decide(
    suggestion: RelationSuggestion,
    decision: "confirm" | "reject" | "undo",
  ) {
    setBusy(suggestion.id);
    setError("");
    setNotice("");

    try {
      if (decision === "confirm") {
        const edit = edits[suggestion.id] ?? {
          description: suggestion.description,
          type: suggestion.type,
        };
        await confirmRelationSuggestion(suggestion.id, edit);
        setNotice("关系已确认；知识点原文未改变，后续重分析会提示复核。 ");
      } else if (decision === "reject") {
        await rejectRelationSuggestion(suggestion.id);
        setNotice("已忽略这条建议，知识点内容没有发生变化。");
      } else if (suggestion.relation) {
        await removeKnowledgeRelation(suggestion.relation.id);
        setNotice("正式关系已撤销，两个知识点仍保持原样。");
      }

      setReload((value) => value + 1);
    } catch (caught) {
      setError(errorMessage(caught, "操作失败，请刷新后重试。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="insight-workspace">
      <WorkspaceToolbar
        actionBusy={busy === "scan"}
        actionLabel="扫描知识关系"
        description="向量只负责召回候选，模型给出有证据的解释；关系类型、方向和描述最终由你确认。"
        onAction={() => void scan()}
        onSectionChange={setSection}
        section={section}
      />
      <Feedback error={error} notice={notice} />

      {loading ? <LoadingCopy /> : null}
      {!loading && items.length === 0 ? (
        <EmptyCopy
          title={section === "pending" ? "目前没有待审关系" : "还没有已处理关系"}
          body="扫描不会自动建立正式关系；只有人工确认后，关系才会进入知识网络。"
        />
      ) : null}

      <div className="review-card-list">
        {items.map((suggestion) => {
          const edit = edits[suggestion.id] ?? {
            description: suggestion.description,
            type: suggestion.type,
          };

          return (
            <article className="review-card relation-card" key={suggestion.id}>
              <header className="review-card-heading">
                <div>
                  <span className="signal-badge semantic">
                    {Math.round(suggestion.confidence * 100)}% 置信度
                  </span>
                  <strong>{RELATION_LABELS[suggestion.type]}</strong>
                </div>
                <span>
                  {suggestion.needsReview ? "来源已变化 · 需复核" : relationStatusLabel(suggestion.status)}
                </span>
              </header>

              <p className="review-reason">{suggestion.reason}</p>
              <div className="relation-flow" aria-label="关系方向">
                <RelationPoint point={suggestion.source} side="起点" />
                <span aria-hidden="true" className="relation-arrow">→</span>
                <RelationPoint point={suggestion.target} side="终点" />
              </div>

              {section === "pending" ? (
                <div className="relation-editor">
                  <label>
                    <span>关系类型</span>
                    <select
                      disabled={!suggestion.canDecide || busy === suggestion.id}
                      onChange={(event) =>
                        setEdits((current) => ({
                          ...current,
                          [suggestion.id]: {
                            ...edit,
                            type: event.target.value as KnowledgeRelationType,
                          },
                        }))
                      }
                      value={edit.type}
                    >
                      {Object.entries(RELATION_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>关系描述</span>
                    <textarea
                      disabled={!suggestion.canDecide || busy === suggestion.id}
                      onChange={(event) =>
                        setEdits((current) => ({
                          ...current,
                          [suggestion.id]: {
                            ...edit,
                            description: event.target.value,
                          },
                        }))
                      }
                      rows={3}
                      value={edit.description}
                    />
                  </label>
                </div>
              ) : (
                <p className="formal-relation-copy">
                  <strong>
                    {RELATION_LABELS[suggestion.relation?.type ?? suggestion.type]}
                  </strong>
                  {suggestion.relation?.description ?? suggestion.description}
                </p>
              )}

              {section === "pending" ? (
                <footer className="review-actions">
                  <p>确认只新增关系，不拼接或改写两端知识点。</p>
                  <div>
                    <button
                      className="secondary-button"
                      disabled={busy === suggestion.id}
                      onClick={() => void decide(suggestion, "reject")}
                      type="button"
                    >
                      忽略建议
                    </button>
                    <button
                      className="primary-button"
                      disabled={
                        busy === suggestion.id ||
                        !suggestion.canDecide ||
                        !edit.description.trim()
                      }
                      onClick={() => void decide(suggestion, "confirm")}
                      type="button"
                    >
                      确认正式关系
                    </button>
                  </div>
                </footer>
              ) : suggestion.status === "confirmed" && suggestion.relation && !suggestion.relation.removed ? (
                <footer className="review-actions">
                  <p>撤销关系不会影响任何知识点或证据片段。</p>
                  <button
                    className="secondary-button"
                    disabled={busy === suggestion.id}
                    onClick={() => void decide(suggestion, "undo")}
                    type="button"
                  >
                    撤销正式关系
                  </button>
                </footer>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function RelationPoint({
  point,
  side,
}: {
  point: RelationSuggestion["source"];
  side: string;
}) {
  return (
    <section className="evidence-pane relation-point">
      <div className="evidence-pane-meta">
        <span>{side}</span>
        {point.changedSinceSuggestion || !point.current ? <span>内容已变化</span> : null}
      </div>
      <h3>{point.title}</h3>
      <Link to={`/records/${point.recordId}`}>{point.recordTitle}</Link>
      <p>{point.body}</p>
      {point.evidence.length > 0 ? (
        <div className="evidence-quotes">
          <span>依据</span>
          {point.evidence.map((evidence) => (
            <blockquote key={evidence.id}>“{evidence.quote}”</blockquote>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CoveragePanel() {
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<CoverageSource[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [analyses, setAnalyses] = useState<CoverageAnalysis[]>([]);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const createButton = useRef<HTMLButtonElement>(null);
  const topicInput = useRef<HTMLInputElement>(null);
  const selectedAnalysis =
    analyses.find(({ id }) => id === selectedAnalysisId) ?? null;
  const hasActiveTasks = analyses.some(
    ({ status }) => status === "queued" || status === "running",
  );

  useEffect(() => {
    if (!builderOpen) {
      return;
    }

    const controller = new AbortController();

    setSourceLoading(true);
    const timer = window.setTimeout(() => {
      void listCoverageSources(query, controller.signal)
        .then(setSources)
        .catch((caught: unknown) => {
          if (!isAbortError(caught)) {
            setError(errorMessage(caught, "记录暂时无法载入。"));
          }
        })
        .finally(() => setSourceLoading(false));
    }, 160);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [builderOpen, query]);

  useEffect(() => {
    let active = true;

    void listCoverageAnalyses()
      .then((items) => {
        if (active) {
          setAnalyses(items);
          setSelectedAnalysisId((current) => current ?? items[0]?.id ?? null);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(errorMessage(caught, "覆盖分析历史暂时无法载入。"));
        }
      })
      .finally(() => {
        if (active) {
          setHistoryLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hasActiveTasks) {
      return;
    }

    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) {
        return;
      }

      refreshing = true;

      try {
        const items = await listCoverageAnalyses();

        if (active) {
          setAnalyses(items);
        }
      } catch (caught) {
        if (active) {
          setError(errorMessage(caught, "分析状态暂时无法刷新。"));
        }
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 1_500);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasActiveTasks]);

  useEffect(() => {
    if (!builderOpen) {
      return;
    }

    topicInput.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        setBuilderOpen(false);
        window.setTimeout(() => createButton.current?.focus());
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [builderOpen, busy]);

  function toggleSource(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 50) {
        next.add(id);
      }

      return next;
    });
  }

  async function generate() {
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const analysis = await createCoverageAnalysis({
        recordIds: [...selectedIds],
        topic: topic.trim(),
      });
      setAnalyses((current) => upsertCoverageAnalysis(current, analysis));
      setSelectedAnalysisId(analysis.id);
      setBuilderOpen(false);
      setTopic("");
      setQuery("");
      setSelectedIds(new Set());
      setNotice("分析任务已创建并出现在历史中；你可以离开此页，完成后报告会自动更新。");
    } catch (caught) {
      setError(errorMessage(caught, "分析任务创建失败，请检查选择后重试。"));
    } finally {
      setBusy(false);
    }
  }

  async function retry(analysisId: string) {
    setRetryingId(analysisId);
    setError("");
    setNotice("");

    try {
      const analysis = await retryCoverageAnalysis(analysisId);

      setAnalyses((current) => upsertCoverageAnalysis(current, analysis));
      setSelectedAnalysisId(analysis.id);
      setNotice("已使用原输入快照重新排队，不会读取记录的最新版本。");
    } catch (caught) {
      setError(errorMessage(caught, "重试未能创建，请稍后再试。"));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="coverage-workspace">
      <section aria-label="创建覆盖分析" className="coverage-command">
        <span aria-hidden="true" className="coverage-command-mark" />
        <div>
          <strong>从你的记录出发，检查一个主题的覆盖情况</strong>
          <span>任务创建后立即进入历史；报告只提供参考，不会改写记录。</span>
        </div>
        <button
          className="primary-button"
          onClick={() => setBuilderOpen(true)}
          ref={createButton}
          type="button"
        >
          新建覆盖分析
        </button>
      </section>

      <Feedback error={error} notice={notice} />

      <div className="coverage-results-layout">
        <aside aria-label="覆盖分析历史" className="coverage-history">
          <header>
            <h2>分析历史</h2>
            <span>{analyses.length}</span>
          </header>
          {historyLoading ? <p>正在载入…</p> : null}
          {!historyLoading && analyses.length === 0 ? (
            <p>创建任务后会立即显示在这里。</p>
          ) : null}
          {analyses.map((analysis) => (
            <div className={`coverage-history-entry ${analysis.status}`} key={analysis.id}>
              <button
                aria-current={selectedAnalysis?.id === analysis.id ? "true" : undefined}
                onClick={() => setSelectedAnalysisId(analysis.id)}
                type="button"
              >
                <span className="coverage-history-title">
                  <i aria-hidden="true" />
                  <strong>{analysis.topic}</strong>
                  <em>{coverageStatusLabel(analysis.status)}</em>
                </span>
                <span>
                  {formatDate(analysis.createdAt)} · {analysis.inputCount} 条
                  {analysis.inputKind === "records" ? "记录" : "知识点"}
                </span>
              </button>
              {analysis.canRetry ? (
                <button
                  className="coverage-history-retry"
                  disabled={retryingId === analysis.id}
                  onClick={() => void retry(analysis.id)}
                  type="button"
                >
                  {retryingId === analysis.id ? "重试中…" : "重试"}
                </button>
              ) : null}
            </div>
          ))}
          {selectedAnalysis?.status === "succeeded" ? (
            <nav aria-label="报告目录" className="coverage-report-nav">
              <span>本报告</span>
              <a href="#coverage-overview">分析概览</a>
              <a href="#coverage-covered">已有覆盖</a>
              <a href="#coverage-gaps">可能缺口</a>
              <a href="#coverage-scope">输入范围</a>
            </nav>
          ) : null}
        </aside>

        <section aria-label="覆盖分析结果" className="coverage-result">
          {selectedAnalysis ? (
            selectedAnalysis.status === "succeeded" ? (
              <CoverageResult analysis={selectedAnalysis} />
            ) : selectedAnalysis.status === "failed" ? (
              <CoverageFailed
                analysis={selectedAnalysis}
                busy={retryingId === selectedAnalysis.id}
                onRetry={() => void retry(selectedAnalysis.id)}
              />
            ) : (
              <CoverageProgress analysis={selectedAnalysis} />
            )
          ) : (
            <EmptyCopy
              title="还没有覆盖分析"
              body="新建任务并选择记录后，这里会显示进度、失败原因或完整报告。"
            />
          )}
        </section>
      </div>

      {builderOpen ? (
        <div
          className="coverage-builder-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target && !busy) {
              setBuilderOpen(false);
            }
          }}
        >
          <section
            aria-labelledby="coverage-builder-title"
            aria-modal="true"
            className="coverage-builder"
            role="dialog"
          >
            <header>
              <div>
                <h2 id="coverage-builder-title">新建覆盖分析</h2>
                <p>先确定主题，再从你的输入记录中选择本次范围。</p>
              </div>
              <button
                aria-label="关闭新建分析"
                className="coverage-builder-close"
                disabled={busy}
                onClick={() => setBuilderOpen(false)}
                type="button"
              >
                ×
              </button>
            </header>

            <div className="coverage-builder-body">
              <section className="coverage-builder-brief">
                <label className="coverage-topic-field">
                  <span>分析主题</span>
                  <input
                    maxLength={120}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="例如：分布式系统故障恢复"
                    ref={topicInput}
                    value={topic}
                  />
                </label>
                <p>
                  系统会冻结每条记录的当前文本版本；记录以后发生变化时，历史报告仍保留并提示差异。
                </p>
              </section>

              <section className="coverage-picker">
                <header>
                  <strong>选择记录</strong>
                  <span>{selectedIds.size} / 50 已选</span>
                </header>
                <label className="coverage-search-field">
                  <span className="visually-hidden">搜索记录</span>
                  <span aria-hidden="true" className="search-icon" />
                  <input
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="按记录标题、原文或我的标签筛选"
                    type="search"
                    value={query}
                  />
                </label>
                <div aria-label="可选记录" className="coverage-source-list">
                  {sourceLoading ? <LoadingCopy /> : null}
                  {!sourceLoading && sources.length === 0 ? (
                    <EmptyCopy title="没有匹配记录" body="换一个关键词，或先新增记录。" />
                  ) : null}
                  {sources.map((source) => (
                    <label className="coverage-source-row" key={source.id}>
                      <input
                        checked={selectedIds.has(source.id)}
                        onChange={() => toggleSource(source.id)}
                        type="checkbox"
                      />
                      <span className="coverage-record-copy">
                        <span className="coverage-record-top">
                          <strong>{source.title}</strong>
                          <em>
                            {source.organization === "organized" ? "已整理" : "仅原文"}
                          </em>
                        </span>
                        <span className="coverage-record-preview">{source.excerpt}</span>
                        <span className="coverage-record-foot">
                          <span className="coverage-record-tags">
                            {source.tags.slice(0, 3).map((tag) => (
                              <span className="coverage-record-tag" key={tag}>{tag}</span>
                            ))}
                            {source.tags.length > 3 ? (
                              <span className="coverage-record-tag">+{source.tags.length - 3}</span>
                            ) : null}
                          </span>
                          <span>{formatDate(source.updatedAt)}</span>
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <footer>
              <p>创建后任务立即进入分析历史；原记录和所有历史版本保持不变。</p>
              <div>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setBuilderOpen(false)}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  disabled={busy || !topic.trim() || selectedIds.size === 0}
                  onClick={() => void generate()}
                  type="button"
                >
                  {busy ? "正在创建…" : "创建分析任务"}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function CoverageResult({ analysis }: { analysis: CoverageAnalysis }) {
  return (
    <article className="coverage-report">
      <header className="coverage-result-heading" id="coverage-overview">
        <div>
          <span className="coverage-result-status">分析完成</span>
          <h2>{analysis.topic}</h2>
          <p>{analysis.frameworkSummary ?? "本次分析未返回参考框架。"}</p>
        </div>
        <div className="coverage-result-meta">
          <span>{analysis.inputCount} 条记录</span>
          <span>{formatDate(analysis.completedAt ?? analysis.createdAt)}</span>
        </div>
      </header>

      <div className="advisory-banner">
        <strong>这是分析提示，不是事实裁决</strong>
        <p>{analysis.caveat ?? "请结合实际目标判断模型给出的参考框架。"}</p>
      </div>
      {analysis.inputChanged ? (
        <p className="stale-banner">
          部分输入记录已变化或归档。这份报告仍基于创建时的快照；如需最新判断，请新建分析。
        </p>
      ) : null}

      <section className="coverage-section covered" id="coverage-covered">
        <header>
          <div>
            <h3>已有覆盖</h3>
            <p>下列判断都有本次输入记录作为依据。</p>
          </div>
          <strong>{analysis.covered.length}</strong>
        </header>
        {analysis.covered.map((item, index) => (
          <details className="coverage-report-item" key={item.id} open={index < 2}>
            <summary>
              <span>
                <strong>{item.title}</strong>
                <small>{item.sources.length} 条记录支撑</small>
              </span>
              <i aria-hidden="true">⌄</i>
            </summary>
            <div>
              <p>{item.assessment}</p>
              <div className="coverage-source-links">
                {item.sources.map((source) => (
                  <Link key={source.id} to={`/records/${source.recordId}`}>
                    {source.title}
                  </Link>
                ))}
              </div>
            </div>
          </details>
        ))}
      </section>

      <section className="coverage-section gaps" id="coverage-gaps">
        <header>
          <div>
            <h3>可能缺口</h3>
            <p>来自模型参考框架的探索方向，不代表客观缺失。</p>
          </div>
          <strong>{analysis.possibleGaps.length}</strong>
        </header>
        {analysis.possibleGaps.map((item, index) => (
          <details className="coverage-report-item" key={item.id} open={index < 2}>
            <summary>
              <span>
                <strong>{item.title}</strong>
                <small>建议继续核验</small>
              </span>
              <i aria-hidden="true">⌄</i>
            </summary>
            <div>
              <p>{item.assessment}</p>
              <p className="coverage-recommendation">
                <strong>下一步</strong>{item.recommendation}
              </p>
            </div>
          </details>
        ))}
      </section>

      <details className="coverage-input-scope" id="coverage-scope">
        <summary>
          <strong>本次输入范围</strong>
          <span>{analysis.inputCount} 条记录 · 展开核对</span>
        </summary>
        <div>
          {analysis.sources.map((source) => (
            <Link key={source.id} to={`/records/${source.recordId}`}>
              <span>{source.title}</span>
              {source.changedSinceAnalysis || !source.current ? <em>当前内容已变化</em> : null}
            </Link>
          ))}
        </div>
      </details>
    </article>
  );
}

function CoverageProgress({ analysis }: { analysis: CoverageAnalysis }) {
  return (
    <article className="coverage-task-state" aria-live="polite">
      <span aria-hidden="true" className="coverage-task-spinner" />
      <p>{analysis.status === "queued" ? "正在等待分析" : "AI 正在阅读记录"}</p>
      <h2>{analysis.topic}</h2>
      <p>
        已冻结 {analysis.inputCount} 条记录。根据内容长度，本次最长可能需要 10–30 分钟；离开页面不会中断任务。
      </p>
      <CoverageTaskSources analysis={analysis} />
    </article>
  );
}

function CoverageFailed({
  analysis,
  busy,
  onRetry,
}: {
  analysis: CoverageAnalysis;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <article className="coverage-task-state failed">
      <span aria-hidden="true" className="coverage-task-failed-mark">!</span>
      <p>分析失败</p>
      <h2>{analysis.topic}</h2>
      <p>{analysis.failure?.message ?? "模型未能返回可用结果。"}</p>
      <button className="primary-button" disabled={busy} onClick={onRetry} type="button">
        {busy ? "正在重新排队…" : "使用原输入重试"}
      </button>
      <small>第 {analysis.attemptCount} 次尝试 · 重试不会改用记录的最新内容</small>
      <CoverageTaskSources analysis={analysis} />
    </article>
  );
}

function CoverageTaskSources({ analysis }: { analysis: CoverageAnalysis }) {
  return (
    <details className="coverage-task-sources">
      <summary>查看本次冻结的 {analysis.inputCount} 条记录</summary>
      <div>
        {analysis.sources.map((source) => (
          <Link key={source.id} to={`/records/${source.recordId}`}>{source.title}</Link>
        ))}
      </div>
    </details>
  );
}

function coverageStatusLabel(status: CoverageAnalysis["status"]): string {
  if (status === "queued") return "等待中";
  if (status === "running") return "分析中";
  if (status === "failed") return "失败";
  return "已完成";
}

function upsertCoverageAnalysis(
  analyses: CoverageAnalysis[],
  next: CoverageAnalysis,
): CoverageAnalysis[] {
  return [next, ...analyses.filter(({ id }) => id !== next.id)].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function WorkspaceToolbar({
  actionBusy,
  actionLabel,
  description,
  onAction,
  onSectionChange,
  section,
}: {
  actionBusy: boolean;
  actionLabel: string;
  description: string;
  onAction: () => void;
  onSectionChange: (section: ReviewSection) => void;
  section: ReviewSection;
}) {
  return (
    <header className="workspace-toolbar">
      <p>{description}</p>
      <div>
        <div aria-label="审查状态" className="review-section-tabs" role="tablist">
          <button
            aria-selected={section === "pending"}
            onClick={() => onSectionChange("pending")}
            role="tab"
            type="button"
          >
            待审查
          </button>
          <button
            aria-selected={section === "resolved"}
            onClick={() => onSectionChange("resolved")}
            role="tab"
            type="button"
          >
            已处理
          </button>
        </div>
        <button
          className="primary-button"
          disabled={actionBusy}
          onClick={onAction}
          type="button"
        >
          {actionBusy ? "正在扫描…" : actionLabel}
        </button>
      </div>
    </header>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error ? <p className="insight-feedback error" role="alert">{error}</p> : null}
      {notice ? <p className="insight-feedback notice" role="status">{notice}</p> : null}
    </>
  );
}

function LoadingCopy() {
  return <p className="insight-loading" role="status">正在载入工作区…</p>;
}

function EmptyCopy({ title, body }: { body: string; title: string }) {
  return (
    <div className="insight-empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function duplicateStatusLabel(status: DuplicateSuggestion["status"]): string {
  if (status === "pending_review") return "待决定";
  if (status === "accepted") return "已建立合并关系";
  if (status === "rejected") return "已忽略";
  return "合并关系已撤销";
}

function relationStatusLabel(status: RelationSuggestion["status"]): string {
  if (status === "pending_review") return "待确认";
  if (status === "confirmed") return "已确认";
  if (status === "rejected") return "已忽略";
  return "关系已撤销";
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}

function isAbortError(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === "AbortError";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
