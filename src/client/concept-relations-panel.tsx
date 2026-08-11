/*
 * THESIS: A Concept Relation is a reviewed connection between two maintained definitions, never an automatic graph edge.
 * OWN-WORLD: The existing catalog becomes a relation ledger: compact index at left, paired definition proof sheet at right, with strawberry or electric-blue signals inherited from the active theme.
 * STORY: Scan once, compare both frozen definitions, edit the proposed relation, confirm or reject it, then revisit or revoke the resulting history.
 * FIRST VIEWPORT: A slim scan/status command, relation ledger, and one side-by-side definition pair with the decision controls directly beneath it.
 * FORM: Local catalog-and-assembly extension inside the established Concept workspace; no new visual world or graph metaphor.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  confirmConceptRelationSuggestion,
  listConceptRelations,
  listConceptRelationSuggestions,
  rejectConceptRelationSuggestion,
  removeConceptRelation,
  scanConceptRelationSuggestions,
  type ConceptRelationEndpoint,
  type ConceptRelationSuggestion,
  type ConceptRelationType,
} from "./api.js";
import "./concept-relations-panel.css";

type ReviewSection = "pending" | "resolved";
type RelationEdit = { description: string; type: ConceptRelationType };

const CONCEPT_RELATION_LABELS: Record<ConceptRelationType, string> = {
  analogy: "类比",
  applies: "应用于",
  contrasts: "对照",
  extends: "扩展",
  prerequisite: "前置依赖",
  similar: "相似",
};

const SYMMETRIC_TYPES = new Set<ConceptRelationType>([
  "analogy",
  "contrasts",
  "similar",
]);

export function ConceptRelationsPanel({
  initialSuggestionId,
  onSelectSuggestion,
}: {
  initialSuggestionId: string;
  onSelectSuggestion: (id: string) => void;
}) {
  const [pending, setPending] = useState<ConceptRelationSuggestion[]>([]);
  const [resolved, setResolved] = useState<ConceptRelationSuggestion[]>([]);
  const [section, setSection] = useState<ReviewSection>("pending");
  const [selectedId, setSelectedId] = useState(initialSuggestionId);
  const [edit, setEdit] = useState<RelationEdit | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError("");
    void Promise.all([
      listConceptRelationSuggestions("pending"),
      listConceptRelationSuggestions("resolved"),
    ])
      .then(([nextPending, nextResolved]) => {
        if (!active) {
          return;
        }

        setPending(nextPending);
        setResolved(nextResolved);
        const requested =
          [...nextPending, ...nextResolved].find(
            ({ id }) => id === (initialSuggestionId || selectedId),
          ) ?? nextPending[0] ?? nextResolved[0] ?? null;

        if (requested) {
          setSelectedId(requested.id);
          setSection(
            requested.status === "pending_review" ? "pending" : "resolved",
          );
        } else {
          setSelectedId("");
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFrom(caught, "Concept 关系建议暂时无法载入。"));
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
  }, [initialSuggestionId, reload]);

  const items = section === "pending" ? pending : resolved;
  const suggestion =
    items.find(({ id }) => id === selectedId) ?? items[0] ?? null;

  useEffect(() => {
    if (!suggestion) {
      setEdit(null);
      return;
    }

    setEdit({ description: suggestion.description, type: suggestion.type });
  }, [suggestion?.id]);

  async function scan() {
    setBusy("scan");
    setError("");
    setNotice("");

    try {
      const result = await scanConceptRelationSuggestions();

      setSection("pending");
      setNotice(
        result.embeddingStatus === "building"
          ? "Embedding 仍在建立，当前未召回可判断的 Concept 对；稍后可再次扫描。"
          : `扫描完成：检查 ${result.scannedConcepts} 个 Concept，召回 ${result.recalledPairs} 对，` +
            `新增 ${result.suggestedRelations} 条建议` +
            (result.failedPairs > 0
              ? `；${result.failedPairs} 对判断失败，可再次扫描。`
              : "。"),
      );
      setReload((value) => value + 1);
    } catch (caught) {
      setError(messageFrom(caught, "Concept 关系扫描失败，请稍后重试。"));
    } finally {
      setBusy("");
    }
  }

  async function decide(decision: "confirm" | "reject" | "remove") {
    if (!suggestion) {
      return;
    }

    setBusy(suggestion.id);
    setError("");
    setNotice("");

    try {
      if (decision === "confirm" && edit) {
        await confirmConceptRelationSuggestion(suggestion.id, edit);
        setSection("resolved");
        setNotice("正式 Concept 关系已确认；两端定义与 Membership 没有被改写。");
      } else if (decision === "reject") {
        await rejectConceptRelationSuggestion(suggestion.id);
        setSection("resolved");
        setNotice("建议已忽略，两个 Concept 保持原样。");
      } else if (suggestion.relation) {
        await removeConceptRelation(suggestion.relation.id);
        setSection("resolved");
        setNotice("正式 Concept 关系已撤销，确认历史仍可回看。");
      }

      setReload((value) => value + 1);
    } catch (caught) {
      setError(messageFrom(caught, "关系操作失败，请刷新后重试。"));
    } finally {
      setBusy("");
    }
  }

  function changeSection(next: ReviewSection) {
    const nextItems = next === "pending" ? pending : resolved;
    const nextId = nextItems[0]?.id ?? "";

    setSection(next);
    setSelectedId(nextId);
    setError("");
    setNotice("");

    if (nextId) {
      onSelectSuggestion(nextId);
    }
  }

  function selectSuggestion(id: string) {
    setSelectedId(id);
    setError("");
    setNotice("");
    onSelectSuggestion(id);
  }

  return (
    <section
      aria-label="Concept Relation 审查"
      className="concept-relation-review"
      role="region"
    >
      <header className="concept-relation-toolbar">
        <div>
          <strong>
            {loading
              ? "正在整理关系台账…"
              : `${pending.length} 条待审 · ${resolved.length} 条历史`}
          </strong>
          <span>AI 只提出建议；正式关系必须由你确认。</span>
        </div>
        <div className="concept-relation-toolbar-actions">
          <div aria-label="Concept 关系审查状态" role="group">
            <button
              aria-pressed={section === "pending"}
              className="concept-relation-section-button"
              onClick={() => changeSection("pending")}
              type="button"
            >
              待审查 {pending.length}
            </button>
            <button
              aria-pressed={section === "resolved"}
              className="concept-relation-section-button"
              onClick={() => changeSection("resolved")}
              type="button"
            >
              已处理 {resolved.length}
            </button>
          </div>
          <button
            className="concept-relation-scan"
            disabled={busy === "scan"}
            onClick={() => void scan()}
            type="button"
          >
            <span aria-hidden="true">↻</span>
            {busy === "scan" ? "扫描中…" : "扫描 Concept 关系"}
          </button>
        </div>
      </header>

      <RelationFeedback error={error} notice={notice} />

      <div className="concept-relation-workbench">
        <aside
          aria-label="Concept Relation 台账"
          className="concept-relation-catalog"
        >
          <div className="concept-relation-catalog-heading">
            <strong>{section === "pending" ? "等待判断" : "决定历史"}</strong>
            <span>{items.length} 条</span>
          </div>
          <div className="concept-relation-catalog-list">
            {items.map((item, index) => (
              <button
                aria-pressed={suggestion?.id === item.id}
                className="concept-relation-catalog-entry"
                data-selected={suggestion?.id === item.id}
                key={item.id}
                onClick={() => selectSuggestion(item.id)}
                type="button"
              >
                <span className="concept-relation-code">
                  R{String(index + 1).padStart(2, "0")}
                </span>
                <span className="concept-relation-catalog-copy">
                  <strong>{item.source.name}</strong>
                  <i aria-hidden="true">
                    {relationDirectionMark(item.relation?.type ?? item.type)}
                  </i>
                  <strong>{item.target.name}</strong>
                </span>
                <small>
                  {relationStatusLabel(item)} · {Math.round(item.confidence * 100)}%
                </small>
                {item.needsReview ? <em>待复核</em> : null}
              </button>
            ))}
            {!loading && items.length === 0 ? (
              <div className="concept-relation-catalog-empty">
                <strong>
                  {section === "pending" ? "没有待审建议" : "尚无处理历史"}
                </strong>
                <p>扫描不会直接建立正式关系。</p>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="concept-relation-stage">
          {loading ? (
            <p className="concept-relation-loading" role="status">
              正在载入 Concept 关系…
            </p>
          ) : null}
          {!loading && suggestion ? (
            <RelationSheet
              busy={busy === suggestion.id}
              edit={edit ?? {
                description: suggestion.description,
                type: suggestion.type,
              }}
              onDecide={(decision) => void decide(decision)}
              onEdit={setEdit}
              suggestion={suggestion}
            />
          ) : null}
          {!loading && !suggestion ? (
            <div className="concept-relation-empty">
              <span aria-hidden="true">↔</span>
              <strong>这里会并排核对两端定义</strong>
              <p>点击上方扫描，只会生成待审建议。</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RelationSheet({
  busy,
  edit,
  onDecide,
  onEdit,
  suggestion,
}: {
  busy: boolean;
  edit: RelationEdit;
  onDecide: (decision: "confirm" | "reject" | "remove") => void;
  onEdit: (edit: RelationEdit) => void;
  suggestion: ConceptRelationSuggestion;
}) {
  const pending = suggestion.status === "pending_review";
  const displayedType = suggestion.relation?.type ?? edit.type;
  const displayedDescription =
    suggestion.relation?.description ??
    (pending ? edit.description : suggestion.description);
  const symmetric = SYMMETRIC_TYPES.has(displayedType);

  return (
    <article className="concept-relation-sheet">
      <header className="concept-relation-sheet-heading">
        <div>
          <span className={`concept-relation-status is-${suggestion.status}`}>
            {relationStatusLabel(suggestion)}
          </span>
          {suggestion.needsReview ? (
            <span className="concept-relation-stale">端点已变化 · 待复核</span>
          ) : null}
        </div>
        <span>{Math.round(suggestion.confidence * 100)}% AI 置信度</span>
      </header>

      <div
        aria-label={symmetric ? "Concept 关系定义对" : "Concept 关系方向"}
        className="concept-relation-pair"
      >
        <ConceptEndpoint
          endpoint={suggestion.source}
          side={symmetric ? "Concept A" : "起点"}
        />
        <div className="concept-relation-bridge">
          <span aria-hidden="true" />
          {pending ? (
            <label>
              <span className="visually-hidden">Concept 关系类型</span>
              <select
                aria-label="Concept 关系类型"
                disabled={!suggestion.canDecide || busy}
                onChange={(event) =>
                  onEdit({
                    ...edit,
                    type: event.currentTarget.value as ConceptRelationType,
                  })
                }
                value={edit.type}
              >
                {Object.entries(CONCEPT_RELATION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          ) : (
            <strong>{CONCEPT_RELATION_LABELS[displayedType]}</strong>
          )}
          <i aria-hidden="true">{relationDirectionMark(displayedType)}</i>
        </div>
        <ConceptEndpoint
          endpoint={suggestion.target}
          side={symmetric ? "Concept B" : "终点"}
        />
      </div>

      {pending ? (
        <label className="concept-relation-description-editor">
          <span>关系描述</span>
          <textarea
            aria-label="Concept 关系描述"
            disabled={!suggestion.canDecide || busy}
            onChange={(event) =>
              onEdit({ ...edit, description: event.currentTarget.value })
            }
            rows={3}
            value={edit.description}
          />
        </label>
      ) : (
        <div className="concept-relation-confirmed-copy">
          <span>确认描述</span>
          <p>{displayedDescription}</p>
        </div>
      )}

      <details className="concept-relation-reason">
        <summary>
          <span>AI 判断依据</span>
          <span>{suggestion.reason}</span>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div>
          <p>
            模型 {suggestion.model.name} · 配置版本 {suggestion.model.configurationVersion}
          </p>
          <p>建议冻结于 {formatDate(suggestion.createdAt)}，不会随当前定义静默改写。</p>
        </div>
      </details>

      <footer className="concept-relation-actions">
        <span className={suggestion.canDecide || !pending ? "" : "is-warning"}>
          <i aria-hidden="true">{suggestion.canDecide || !pending ? "✓" : "!"}</i>
          {pending
            ? suggestion.canDecide
              ? "确认只建立关系，不修改两端 Concept"
              : "Revision、Membership 或归档状态已变化，不能确认"
            : relationHistoryHint(suggestion)}
        </span>
        <div>
          {pending ? (
            <>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => onDecide("reject")}
                type="button"
              >
                忽略建议
              </button>
              <button
                className="primary-button"
                disabled={busy || !suggestion.canDecide || !edit.description.trim()}
                onClick={() => onDecide("confirm")}
                type="button"
              >
                确认正式关系
              </button>
            </>
          ) : null}
          {suggestion.relation && !suggestion.relation.removed ? (
            <button
              className="concept-relation-remove"
              disabled={busy}
              onClick={() => onDecide("remove")}
              type="button"
            >
              撤销正式关系
            </button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

function ConceptEndpoint({
  endpoint,
  side,
}: {
  endpoint: ConceptRelationEndpoint;
  side: "Concept A" | "Concept B" | "起点" | "终点";
}) {
  return (
    <section className="concept-relation-endpoint">
      <div>
        <span>{side} · 冻结定义</span>
        <Link
          aria-label={`打开 Concept：${endpoint.name}`}
          to={`/concepts?concept=${encodeURIComponent(endpoint.id)}`}
        >
          打开 Concept ↗
        </Link>
      </div>
      <h3>{endpoint.name}</h3>
      <p>{endpoint.description}</p>
      <footer>
        <span>{endpoint.memberCount} 个当前成员</span>
        {endpoint.changedSinceSuggestion ? <strong>输入后已变化</strong> : null}
        {endpoint.archived ? <strong>已归档</strong> : null}
      </footer>
    </section>
  );
}

export function ConceptRelationsForConcept({ conceptId }: { conceptId: string }) {
  const [items, setItems] = useState<ConceptRelationSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setNotice("");
  }, [conceptId]);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError("");
    void listConceptRelations(conceptId)
      .then((next) => {
        if (active) {
          setItems(next);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFrom(caught, "直接关系暂时无法载入。"));
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
  }, [conceptId, reload]);

  const activeItems = items.filter(
    ({ relation }) => relation && !relation.removed,
  );
  const removedItems = items.filter(({ relation }) => relation?.removed);

  async function remove(suggestion: ConceptRelationSuggestion) {
    if (!suggestion.relation) {
      return;
    }

    setBusy(suggestion.relation.id);
    setError("");
    setNotice("");

    try {
      await removeConceptRelation(suggestion.relation.id);
      setNotice("正式关系已撤销，确认历史仍可回看。");
      setReload((value) => value + 1);
    } catch (caught) {
      setError(messageFrom(caught, "正式关系撤销失败，请重试。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <section
      aria-label="Concept 直接关系"
      className="concept-direct-relations"
      role="region"
    >
      <header>
        <div>
          <h3>直接关系与邻居</h3>
          <p>只显示人工确认的关系；待复核关系保留，但不会进入默认知识网络。</p>
        </div>
        <Link to="/concepts?view=relations">打开关系审查</Link>
      </header>

      {error ? <p className="concept-direct-relation-error" role="alert">{error}</p> : null}
      {notice ? (
        <p className="concept-direct-relation-notice" role="status">{notice}</p>
      ) : null}
      {loading ? (
        <p className="concept-direct-relation-loading" role="status">
          正在读取直接关系…
        </p>
      ) : null}
      {!loading && activeItems.length === 0 ? (
        <p className="concept-direct-relation-empty">当前没有生效的直接关系。</p>
      ) : null}
      {activeItems.length > 0 ? (
        <div className="concept-direct-relation-list">
          {activeItems.map((suggestion) => (
            <DirectRelationRow
              busy={busy === suggestion.relation?.id}
              conceptId={conceptId}
              key={suggestion.id}
              onRemove={() => void remove(suggestion)}
              suggestion={suggestion}
            />
          ))}
        </div>
      ) : null}

      {removedItems.length > 0 ? (
        <details className="concept-removed-relations">
          <summary>已撤销关系（{removedItems.length}）</summary>
          {removedItems.map((suggestion) => {
            const neighbor = relationNeighbor(suggestion, conceptId);

            return (
              <div key={suggestion.id}>
                <span>已撤销</span>
                <strong>{CONCEPT_RELATION_LABELS[suggestion.relation?.type ?? suggestion.type]}</strong>
                <Link to={`/concepts?concept=${encodeURIComponent(neighbor.id)}`}>
                  {neighbor.name}
                </Link>
                <time>{formatDate(suggestion.relation?.removedAt ?? suggestion.updatedAt)}</time>
              </div>
            );
          })}
        </details>
      ) : null}
    </section>
  );
}

function DirectRelationRow({
  busy,
  conceptId,
  onRemove,
  suggestion,
}: {
  busy: boolean;
  conceptId: string;
  onRemove: () => void;
  suggestion: ConceptRelationSuggestion;
}) {
  const relation = suggestion.relation;

  if (!relation) {
    return null;
  }

  const neighbor = relationNeighbor(suggestion, conceptId);
  const relationType = relation.type;
  const outward = relation.sourceConceptId === conceptId;

  return (
    <article className="concept-direct-relation" data-review={suggestion.needsReview}>
      <div className="concept-direct-relation-path">
        <span>{CONCEPT_RELATION_LABELS[relationType]}</span>
        <i aria-hidden="true">
          {SYMMETRIC_TYPES.has(relationType) ? "↔" : outward ? "→" : "←"}
        </i>
        <Link
          aria-label={`打开邻居 Concept：${neighbor.name}`}
          to={`/concepts?concept=${encodeURIComponent(neighbor.id)}`}
        >
          {neighbor.name}
        </Link>
        {suggestion.needsReview ? <strong>待复核</strong> : null}
      </div>
      <p>{relation.description}</p>
      <button disabled={busy} onClick={onRemove} type="button">
        {busy ? "正在撤销…" : "撤销正式关系"}
      </button>
    </article>
  );
}

function relationNeighbor(
  suggestion: ConceptRelationSuggestion,
  conceptId: string,
): ConceptRelationEndpoint {
  return suggestion.source.id === conceptId
    ? suggestion.target
    : suggestion.source;
}

function relationStatusLabel(suggestion: ConceptRelationSuggestion): string {
  if (suggestion.status === "pending_review") return "待确认";
  if (suggestion.status === "rejected") return "已忽略";
  if (suggestion.status === "removed" || suggestion.relation?.removed) {
    return "已撤销";
  }

  return "已确认";
}

function relationHistoryHint(suggestion: ConceptRelationSuggestion): string {
  if (suggestion.status === "rejected") return "建议已忽略，未建立正式关系";
  if (suggestion.status === "removed" || suggestion.relation?.removed) {
    return "正式关系已撤销，确认与撤销时间仍保留";
  }
  if (suggestion.needsReview) return "正式关系保留，但端点变化后需要复核";
  return "正式关系生效中，可随时撤销";
}

function relationDirectionMark(type: ConceptRelationType): "→" | "↔" {
  return SYMMETRIC_TYPES.has(type) ? "↔" : "→";
}

function RelationFeedback({ error, notice }: { error: string; notice: string }) {
  if (error) {
    return <p className="concept-relation-feedback error" role="alert">{error}</p>;
  }

  return notice ? (
    <p className="concept-relation-feedback notice" role="status">{notice}</p>
  ) : null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
