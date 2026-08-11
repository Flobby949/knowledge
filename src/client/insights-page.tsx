/*
 * THESIS: Knowledge discovery is a review desk, not an autonomous cleanup engine.
 * OWN-WORLD: A quiet evidence workspace with explicit decisions and persistent source links.
 * STORY: Scan, inspect both sides, decide, then revisit or undo without touching source history.
 * FIRST VIEWPORT: 60px navigation, a compact thesis header, three work tabs, and an evidence-first review list.
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
  const [selectedAnalysis, setSelectedAnalysis] = useState<CoverageAnalysis | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    setSourceLoading(true);
    const timer = window.setTimeout(() => {
      void listCoverageSources(query, controller.signal)
        .then(setSources)
        .catch((caught: unknown) => {
          if (!isAbortError(caught)) {
            setError(errorMessage(caught, "知识点暂时无法载入。"));
          }
        })
        .finally(() => setSourceLoading(false));
    }, 160);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    let active = true;

    void listCoverageAnalyses()
      .then((items) => {
        if (active) {
          setAnalyses(items);
          setSelectedAnalysis((current) => current ?? items[0] ?? null);
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
        knowledgePointIds: [...selectedIds],
        topic: topic.trim(),
      });
      setAnalyses((current) => [analysis, ...current]);
      setSelectedAnalysis(analysis);
      setNotice("覆盖快照已生成；结果仅作思考提示，不会补写或修改已选知识点。");
    } catch (caught) {
      setError(errorMessage(caught, "覆盖分析生成失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="coverage-workspace">
      <section aria-label="创建覆盖分析" className="coverage-builder">
        <header>
          <div>
            <span>新建分析</span>
            <h2>选择本次要检查的知识范围</h2>
          </div>
          <strong>{selectedIds.size} / 50 已选</strong>
        </header>

        <label className="coverage-topic-field">
          <span>分析主题</span>
          <input
            maxLength={120}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：分布式系统故障恢复"
            value={topic}
          />
        </label>
        <label className="coverage-search-field">
          <span className="visually-hidden">搜索当前知识点</span>
          <span aria-hidden="true" className="search-icon" />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按知识点、记录或标签筛选"
            type="search"
            value={query}
          />
        </label>

        <div aria-label="可选知识点" className="coverage-source-list">
          {sourceLoading ? <LoadingCopy /> : null}
          {!sourceLoading && sources.length === 0 ? (
            <EmptyCopy title="没有匹配知识点" body="换一个关键词，或先整理更多记录。" />
          ) : null}
          {sources.map((source) => (
            <label className="coverage-source-row" key={source.id}>
              <input
                checked={selectedIds.has(source.id)}
                onChange={() => toggleSource(source.id)}
                type="checkbox"
              />
              <span>
                <strong>{source.title}</strong>
                <small>{source.recordTitle}</small>
                <em>{source.excerpt}</em>
              </span>
            </label>
          ))}
        </div>

        <footer>
          <p>仅保存本次选择和分析快照；原知识点、证据和历史版本保持不变。</p>
          <button
            className="primary-button"
            disabled={busy || !topic.trim() || selectedIds.size === 0}
            onClick={() => void generate()}
            type="button"
          >
            {busy ? "正在生成…" : "生成建议性覆盖分析"}
          </button>
        </footer>
      </section>

      <Feedback error={error} notice={notice} />

      <div className="coverage-results-layout">
        <aside aria-label="覆盖分析历史" className="coverage-history">
          <h2>分析历史</h2>
          {historyLoading ? <p>正在载入…</p> : null}
          {!historyLoading && analyses.length === 0 ? <p>尚无分析快照。</p> : null}
          {analyses.map((analysis) => (
            <button
              aria-current={selectedAnalysis?.id === analysis.id ? "true" : undefined}
              key={analysis.id}
              onClick={() => setSelectedAnalysis(analysis)}
              type="button"
            >
              <strong>{analysis.topic}</strong>
              <span>{formatDate(analysis.createdAt)} · {analysis.inputCount} 个知识点</span>
            </button>
          ))}
        </aside>

        <section aria-label="覆盖分析结果" className="coverage-result">
          {selectedAnalysis ? (
            <CoverageResult analysis={selectedAnalysis} />
          ) : (
            <EmptyCopy
              title="选择知识点，生成第一份覆盖快照"
              body="它会指出已有覆盖和可能缺口，但不会把建议写回你的知识库。"
            />
          )}
        </section>
      </div>
    </div>
  );
}

function CoverageResult({ analysis }: { analysis: CoverageAnalysis }) {
  return (
    <article>
      <header className="coverage-result-heading">
        <div>
          <span>建议性快照</span>
          <h2>{analysis.topic}</h2>
          <p>{analysis.frameworkSummary}</p>
        </div>
        <span>{formatDate(analysis.createdAt)}</span>
      </header>

      <div className="advisory-banner">
        <strong>这是分析提示，不是事实裁决</strong>
        <p>{analysis.caveat}</p>
      </div>
      {analysis.inputChanged ? (
        <p className="stale-banner">
          部分输入知识点已变化或不再生效。这份历史快照仍保留，请重新选择当前知识生成新分析。
        </p>
      ) : null}

      <section className="coverage-section covered">
        <header>
          <span>01</span>
          <h3>已有覆盖</h3>
          <strong>{analysis.covered.length}</strong>
        </header>
        {analysis.covered.map((item) => (
          <article key={item.id}>
            <h4>{item.title}</h4>
            <p>{item.assessment}</p>
            <div className="coverage-source-links">
              {item.sources.map((source) => (
                <Link key={source.id} to={`/records/${source.recordId}`}>
                  {source.title}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </section>

      <section className="coverage-section gaps">
        <header>
          <span>02</span>
          <h3>可能缺口</h3>
          <strong>{analysis.possibleGaps.length}</strong>
        </header>
        {analysis.possibleGaps.map((item) => (
          <article key={item.id}>
            <h4>{item.title}</h4>
            <p>{item.assessment}</p>
            <span>{item.recommendation}</span>
          </article>
        ))}
      </section>
    </article>
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
