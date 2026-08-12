/*
 * THESIS: Concept Relations are automatically maintained graph edges with visible AI provenance, never an inbox the user must clear.
 * OWN-WORLD: A compact relation ledger opens onto a paired definition proof sheet and stays inside the established Concept workbench.
 * STORY: Effective knowledge triggers recall and automatic relation judgment; this view explains the resulting edge, its frozen inputs, and its model provenance, with revocation available as correction.
 * FIRST VIEWPORT: Automation status, active/history counts, and one side-by-side relation proof sheet without review controls.
 * FORM: Catalog-and-assembly staging; no new visual world or graph metaphor.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  listConceptRelations,
  removeConceptRelation,
  type ConceptRelation,
  type ConceptRelationEndpoint,
  type ConceptRelationType,
} from "./api.js";
import "./concept-relations-panel.css";

type RelationSection = "active" | "history";

const RELATION_LABELS: Record<ConceptRelationType, string> = {
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

export function ConceptRelationsLedger({
  initialRelationId,
  onSelectRelation,
}: {
  initialRelationId: string;
  onSelectRelation: (id: string) => void;
}) {
  const [relations, setRelations] = useState<ConceptRelation[]>([]);
  const [section, setSection] = useState<RelationSection>("active");
  const [selectedId, setSelectedId] = useState(initialRelationId);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError("");
    void listConceptRelations()
      .then((nextRelations) => {
        if (!active) {
          return;
        }

        setRelations(nextRelations);
        const requested =
          nextRelations.find(({ id }) => id === (initialRelationId || selectedId)) ??
          nextRelations.find(({ removed }) => !removed) ??
          nextRelations[0] ??
          null;

        if (requested) {
          setSelectedId(requested.id);
          setSection(requested.removed ? "history" : "active");
        } else {
          setSelectedId("");
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFrom(caught, "Concept 自动关系暂时无法载入。"));
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
  }, [initialRelationId, reload]);

  const activeRelations = relations.filter(({ removed }) => !removed);
  const removedRelations = relations.filter(({ removed }) => removed);
  const items = section === "active" ? activeRelations : removedRelations;
  const relation = items.find(({ id }) => id === selectedId) ?? items[0] ?? null;

  async function remove() {
    if (!relation || relation.removed) {
      return;
    }

    setBusy(relation.id);
    setError("");
    setNotice("");

    try {
      await removeConceptRelation(relation.id);
      setSection("history");
      setNotice("正式关系已撤销；AI 判断、模型与输入历史仍完整保留。");
      setReload((value) => value + 1);
    } catch (caught) {
      setError(messageFrom(caught, "正式关系撤销失败，请重试。"));
    } finally {
      setBusy("");
    }
  }

  function changeSection(next: RelationSection) {
    const nextItems = next === "active" ? activeRelations : removedRelations;
    const nextId = nextItems[0]?.id ?? "";

    setSection(next);
    setSelectedId(nextId);
    setError("");
    setNotice("");
    if (nextId) {
      onSelectRelation(nextId);
    }
  }

  function selectRelation(id: string) {
    setSelectedId(id);
    setError("");
    setNotice("");
    onSelectRelation(id);
  }

  return (
    <section
      aria-label="Concept 自动关系台账"
      className="concept-relation-review"
      role="region"
    >
      <header className="concept-relation-toolbar">
        <div>
          <strong>
            {loading
              ? "正在整理关系台账…"
              : `${activeRelations.length} 条生效中 · ${removedRelations.length} 条已撤销`}
          </strong>
          <span>新增有效知识完成全局召回后，AI 会自动判断并建立正式 Concept 连线。</span>
        </div>
        <div className="concept-relation-toolbar-actions">
          <span className="concept-relation-auto-state">
            <i aria-hidden="true" />
            自动关联已启用
          </span>
          <div aria-label="Concept 关系状态" role="group">
            <button
              aria-pressed={section === "active"}
              className="concept-relation-section-button"
              onClick={() => changeSection("active")}
              type="button"
            >
              生效中 {activeRelations.length}
            </button>
            <button
              aria-pressed={section === "history"}
              className="concept-relation-section-button"
              onClick={() => changeSection("history")}
              type="button"
            >
              已撤销 {removedRelations.length}
            </button>
          </div>
        </div>
      </header>

      <RelationFeedback error={error} notice={notice} />

      <div className="concept-relation-workbench">
        <aside aria-label="Concept Relation 台账" className="concept-relation-catalog">
          <div className="concept-relation-catalog-heading">
            <strong>{section === "active" ? "自动关系" : "撤销历史"}</strong>
            <span>{items.length} 条</span>
          </div>
          <div className="concept-relation-catalog-list">
            {items.map((item, index) => (
              <button
                aria-pressed={relation?.id === item.id}
                className="concept-relation-catalog-entry"
                data-selected={relation?.id === item.id}
                key={item.id}
                onClick={() => selectRelation(item.id)}
                type="button"
              >
                <span className="concept-relation-code">
                  R{String(index + 1).padStart(2, "0")}
                </span>
                <span className="concept-relation-catalog-copy">
                  <strong>{item.source.name}</strong>
                  <i aria-hidden="true">{directionMark(item.type)}</i>
                  <strong>{item.target.name}</strong>
                </span>
                <small>{RELATION_LABELS[item.type]} · {sourceLabel(item)}</small>
                {item.needsReview ? <em>输入更新中</em> : null}
              </button>
            ))}
            {!loading && items.length === 0 ? (
              <div className="concept-relation-catalog-empty">
                <strong>{section === "active" ? "尚无自动关系" : "尚无撤销历史"}</strong>
                <p>
                  {section === "active"
                    ? "新增有效知识后会自动召回并判断，无需人工扫描或确认。"
                    : "被撤销的正式关系会保留在这里。"}
                </p>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="concept-relation-stage">
          {loading ? (
            <p className="concept-relation-loading" role="status">
              正在载入 Concept 自动关系…
            </p>
          ) : null}
          {!loading && relation ? (
            <AutomaticRelationSheet
              busy={busy === relation.id}
              onRemove={() => void remove()}
              relation={relation}
            />
          ) : null}
          {!loading && !relation ? (
            <div className="concept-relation-empty">
              <span aria-hidden="true">↔</span>
              <strong>AI 会在这里留下正式关系与判断依据</strong>
              <p>触发点是新增有效知识后的自动召回，不需要人工发起。</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AutomaticRelationSheet({
  busy,
  onRemove,
  relation,
}: {
  busy: boolean;
  onRemove: () => void;
  relation: ConceptRelation;
}) {
  const symmetric = SYMMETRIC_TYPES.has(relation.type);

  return (
    <article className="concept-relation-sheet">
      <header className="concept-relation-sheet-heading">
        <div>
          <span
            className={`concept-relation-status is-${relation.removed ? "removed" : "confirmed"}`}
          >
            {relation.removed ? "已撤销" : "正式关系"}
          </span>
          {relation.needsReview ? (
            <span className="concept-relation-stale">端点输入已变化 · 自动更新中</span>
          ) : null}
        </div>
        <span className="concept-relation-provenance">
          <strong>{sourceLabel(relation)}</strong>
          {relation.ai ? `${Math.round(relation.ai.confidence * 100)}% AI 置信度` : null}
        </span>
      </header>

      <div
        aria-label={symmetric ? "Concept 关系定义对" : "Concept 关系方向"}
        className="concept-relation-pair"
      >
        <ConceptEndpoint endpoint={relation.source} side={symmetric ? "Concept A" : "起点"} />
        <div className="concept-relation-bridge">
          <span aria-hidden="true" />
          <strong>{RELATION_LABELS[relation.type]}</strong>
          <i aria-hidden="true">{directionMark(relation.type)}</i>
        </div>
        <ConceptEndpoint endpoint={relation.target} side={symmetric ? "Concept B" : "终点"} />
      </div>

      <div className="concept-relation-confirmed-copy">
        <span>关系描述</span>
        <p>{relation.description}</p>
      </div>

      <details className="concept-relation-reason">
        <summary>
          <span>{relation.ai ? "AI 判断依据" : "建立方式"}</span>
          <span>
            {relation.ai?.reason ??
              (relation.confirmationSource.type === "user"
                ? "用户直接补充这条正式关系"
                : "由早期 AI 建议流程确认")}
          </span>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div>
          {relation.ai ? (
            <p>
              执行模型 {relation.ai.model.name} · 当时生效配置版本 {relation.ai.model.configurationVersion}
            </p>
          ) : null}
          <p>
            正式关系建立于 {formatDate(relation.confirmedAt)}；两端 Revision 与 Membership 输入均可追溯。
          </p>
        </div>
      </details>

      <footer className="concept-relation-actions">
        <span className={relation.needsReview ? "is-warning" : ""}>
          <i aria-hidden="true">{relation.needsReview ? "!" : "✓"}</i>
          {relation.removed
            ? `已于 ${formatDate(relation.removedAt ?? relation.confirmedAt)} 撤销，审计历史保留`
            : relation.needsReview
              ? "端点变化已触发新的自动判断；此边暂不进入默认网络"
              : "AI 已自动建立正式边，不需要人工确认"}
        </span>
        {!relation.removed ? (
          <button
            className="concept-relation-remove"
            disabled={busy}
            onClick={onRemove}
            type="button"
          >
            {busy ? "正在撤销…" : "撤销正式关系"}
          </button>
        ) : null}
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

function sourceLabel(relation: ConceptRelation): string {
  if (relation.confirmationSource.type === "ai_automatic") {
    return "AI 自动建立";
  }
  if (relation.confirmationSource.type === "concept_relation_suggestion") {
    return "早期 AI 建议后确认";
  }

  return "用户直接建立";
}

function directionMark(type: ConceptRelationType): "→" | "↔" {
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
