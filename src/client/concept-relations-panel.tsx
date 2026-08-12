/*
 * THESIS: A Concept detail exposes automatically maintained formal neighbors without asking the user to construct relationships.
 * OWN-WORLD: Relations extend the existing definition sheet with compact rows inherited from the active theme.
 * STORY: Inspect an AI-established neighbor, navigate to it, or revoke an incorrect edge while the automatic pipeline owns creation.
 * FIRST VIEWPORT: Current formal neighbors and provenance appear below the definition and Membership proof.
 * FORM: Local catalog-and-assembly extension inside the established Concept workspace; no new visual world or graph metaphor.
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

export function ConceptRelationsForConcept({
  conceptId,
}: {
  conceptId: string;
}) {
  const [items, setItems] = useState<ConceptRelation[]>([]);
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

  const activeItems = items.filter(({ removed }) => !removed);
  const removedItems = items.filter(({ removed }) => removed);

  async function remove(relation: ConceptRelation) {
    setBusy(relation.id);
    setError("");
    setNotice("");

    try {
      await removeConceptRelation(relation.id);
      setNotice("正式关系已撤销，建立与撤销历史仍可回看。");
      setReload((value) => value + 1);
    } catch (caught) {
      setError(messageFrom(caught, "正式关系撤销失败，请重试。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <section
      aria-label="Concept 自动关系"
      className="concept-direct-relations"
      role="region"
    >
      <header>
        <div>
          <h3>AI 自动关系与邻居</h3>
          <p>新增知识生效并完成召回后，AI 会自动判断并维护 Concept 之间的正式关系。</p>
        </div>
        <div className="concept-direct-relation-header-actions">
          <Link to="/concepts?view=relations">查看自动关系台账</Link>
        </div>
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
          {activeItems.map((relation) => (
            <DirectRelationRow
              busy={busy === relation.id}
              conceptId={conceptId}
              key={relation.id}
              onRemove={() => void remove(relation)}
              relation={relation}
            />
          ))}
        </div>
      ) : null}

      {removedItems.length > 0 ? (
        <details className="concept-removed-relations">
          <summary>已撤销关系（{removedItems.length}）</summary>
          {removedItems.map((relation) => {
            const neighbor = relationNeighbor(relation, conceptId);

            return (
              <div key={relation.id}>
                <span>已撤销</span>
                <strong>{CONCEPT_RELATION_LABELS[relation.type]}</strong>
                <Link to={`/concepts?concept=${encodeURIComponent(neighbor.id)}`}>
                  {neighbor.name}
                </Link>
                <time>{formatDate(relation.removedAt ?? relation.confirmedAt)}</time>
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
  relation,
}: {
  busy: boolean;
  conceptId: string;
  onRemove: () => void;
  relation: ConceptRelation;
}) {
  const neighbor = relationNeighbor(relation, conceptId);
  const relationType = relation.type;
  const outward = relation.sourceConceptId === conceptId;

  return (
    <article className="concept-direct-relation" data-review={relation.needsReview}>
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
        {relation.needsReview ? <strong>待复核</strong> : null}
      </div>
      <p>
        {relation.description}
        <small>
          {relation.confirmationSource.type === "user"
            ? "用户直接建立"
            : relation.confirmationSource.type === "ai_automatic"
              ? "AI 自动建立"
              : "早期 AI 建议后确认"}
        </small>
      </p>
      <button disabled={busy} onClick={onRemove} type="button">
        {busy ? "正在撤销…" : "撤销正式关系"}
      </button>
    </article>
  );
}

function relationNeighbor(
  relation: ConceptRelation,
  conceptId: string,
): ConceptRelationEndpoint {
  return relation.source.id === conceptId ? relation.target : relation.source;
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
