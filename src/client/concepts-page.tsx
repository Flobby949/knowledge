/*
 * THESIS: A Concept is a maintained definition with traceable membership, not a decorative cluster.
 * OWN-WORLD: A compact concept catalog opens onto one assembly sheet, like a marked reference index beside its working plate.
 * STORY: Find or create a definition, inspect its exact knowledge-point membership, revise without erasing history, then archive or restore deliberately.
 * FIRST VIEWPORT: A searchable catalog column, one definition plate, and a dense membership proof sheet with review warnings visible before secondary history.
 * FORM: Catalog-and-assembly staging, ranked fourth and carried in the established knowledge workbench identity; direction seed b4e0c450.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  addConceptMembership,
  createConcept,
  getConceptDetail,
  listConcepts,
  listConceptSources,
  removeConceptMembership,
  restoreConceptMembership,
  setConceptArchived,
  updateConcept,
  type ConceptDetail,
  type ConceptSource,
  type ConceptSummary,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./concepts-page.css";

type ArchiveScope = "active" | "all" | "archived";
type WorkspaceMode = "add" | "create" | "edit" | "view";

export function ConceptsPage() {
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [archive, setArchive] = useState<ArchiveScope>("active");
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ConceptDetail | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("view");
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    setListLoading(true);
    void listConcepts({ archive, q: query, signal: controller.signal })
      .then((items) => {
        if (!active) {
          return;
        }

        setConcepts(items);
        setSelectedId((current) => current || items[0]?.id || "");
      })
      .catch((caught: unknown) => {
        if (active && !isAbortError(caught)) {
          setError(messageFrom(caught, "Concept 图册暂时无法载入。"));
        }
      })
      .finally(() => {
        if (active) {
          setListLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [archive, query, reload]);

  useEffect(() => {
    if (!selectedId || mode === "create") {
      return;
    }

    let active = true;

    setDetailLoading(true);
    void getConceptDetail(selectedId)
      .then((next) => {
        if (active) {
          setDetail(next);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFrom(caught, "Concept 详情暂时无法载入。"));
        }
      })
      .finally(() => {
        if (active) {
          setDetailLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [mode, selectedId]);

  function selectConcept(id: string) {
    setSelectedId(id);
    setMode("view");
    setError("");
    setNotice("");
  }

  function startCreate() {
    setMode("create");
    setError("");
    setNotice("");
  }

  function applyMutation(next: ConceptDetail, message: string) {
    setDetail(next);
    setSelectedId(next.concept.id);
    setMode("view");
    setNotice(message);
    setReload((value) => value + 1);
  }

  async function changeArchiveState(nextArchived: boolean) {
    if (!detail) {
      return;
    }

    setBusy("lifecycle");
    setError("");

    try {
      const next = await setConceptArchived(detail.concept.id, nextArchived);

      applyMutation(
        next,
        nextArchived
          ? "Concept 已归档；定义、版本和 Membership 均完整保留。"
          : "Concept 已恢复，可以继续维护定义和 Membership。",
      );
    } catch (caught) {
      setError(messageFrom(caught, "Concept 状态更新失败，请重试。"));
    } finally {
      setBusy("");
    }
  }

  async function changeMembership(
    membership: ConceptDetail["memberships"][number],
  ) {
    if (!detail) {
      return;
    }

    setBusy(membership.id);
    setError("");

    try {
      const next =
        membership.status === "active"
          ? await removeConceptMembership(detail.concept.id, membership.id)
          : await restoreConceptMembership(detail.concept.id, membership.id);

      applyMutation(
        next,
        membership.status === "active"
          ? "Membership 已移除；历史关联仍可回看和恢复。"
          : "Membership 已恢复。",
      );
    } catch (caught) {
      setError(messageFrom(caught, "Membership 更新失败，请重试。"));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="concepts-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main aria-label="知识概念" className="concepts-main">
        <header className="concepts-heading">
          <div>
            <span className="concepts-kicker">可维护的知识定义</span>
            <h1>Concept 图册</h1>
          </div>
          <p>
            用稳定定义组织多个知识点。名称、描述和成员变化都留下历史，原始记录与知识点不会被改写。
          </p>
          <button className="primary-button" onClick={startCreate} type="button">
            新建 Concept
          </button>
        </header>

        <Feedback error={error} notice={notice} />

        <div className="concept-workbench">
          <aside aria-label="Concept 图册索引" className="concept-catalog">
            <form
              aria-label="筛选 Concept"
              className="concept-catalog-tools"
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(queryDraft.trim());
              }}
              role="search"
            >
              <label>
                <span className="visually-hidden">搜索 Concept</span>
                <span aria-hidden="true" className="search-icon" />
                <input
                  aria-label="搜索 Concept"
                  onChange={(event) => setQueryDraft(event.currentTarget.value)}
                  placeholder="名称或描述"
                  type="search"
                  value={queryDraft}
                />
              </label>
              <select
                aria-label="Concept 归档状态"
                onChange={(event) => setArchive(event.currentTarget.value as ArchiveScope)}
                value={archive}
              >
                <option value="active">生效中</option>
                <option value="archived">已归档</option>
                <option value="all">全部</option>
              </select>
            </form>

            <div aria-live="polite" className="concept-catalog-count">
              {listLoading ? "正在翻阅图册…" : `${concepts.length} 个 Concept`}
            </div>

            <div className="concept-catalog-list">
              {concepts.map((concept, index) => (
                <button
                  aria-pressed={selectedId === concept.id && mode !== "create"}
                  className="concept-catalog-entry"
                  data-selected={selectedId === concept.id && mode !== "create"}
                  key={concept.id}
                  onClick={() => selectConcept(concept.id)}
                  type="button"
                >
                  <span className="concept-catalog-code">
                    C{String(index + 1).padStart(3, "0")}
                  </span>
                  <strong>{concept.name}</strong>
                  <small>
                    {concept.activeMembershipCount} 个成员 · 版本 {concept.revisionNumber}
                  </small>
                  {concept.reviewMembershipCount > 0 ? (
                    <span className="concept-review-flag">
                      {concept.reviewMembershipCount} 项待核对
                    </span>
                  ) : null}
                </button>
              ))}
              {!listLoading && concepts.length === 0 ? (
                <div className="concept-catalog-empty">
                  <strong>当前图册没有条目</strong>
                  <p>{query ? "换个关键词试试。" : "从两个知识点建立第一个 Concept。"}</p>
                </div>
              ) : null}
            </div>
          </aside>

          <section className="concept-stage">
            {mode === "create" ? (
              <ConceptBuilder
                onCancel={() => setMode("view")}
                onCreated={(next) =>
                  applyMutation(next, "Concept 已创建，首个定义版本与 Membership 历史已记录。")
                }
              />
            ) : null}
            {mode !== "create" && detailLoading ? (
              <p className="concept-stage-loading">正在展开 Concept…</p>
            ) : null}
            {mode !== "create" && !detailLoading && detail ? (
              <ConceptDetailWorkspace
                busy={busy}
                detail={detail}
                mode={mode}
                onArchive={() => void changeArchiveState(true)}
                onCancelMode={() => setMode("view")}
                onDetail={(next, message) => applyMutation(next, message)}
                onEdit={() => setMode("edit")}
                onMembership={(membership) => void changeMembership(membership)}
                onMode={setMode}
                onRestore={() => void changeArchiveState(false)}
                setBusy={setBusy}
                setError={setError}
              />
            ) : null}
            {mode !== "create" && !detailLoading && !detail ? (
              <div className="concept-stage-empty">
                <span aria-hidden="true">◎</span>
                <strong>选择一个 Concept 查看定义</strong>
                <p>也可以从图册顶部建立一个新条目。</p>
              </div>
            ) : null}
          </section>
        </div>
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

function ConceptBuilder({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (detail: ConceptDetail) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!name.trim() || !description.trim() || selected.length < 2) {
      setError("请填写名称和描述，并选择至少两个知识点。");
      return;
    }

    setBusy(true);
    setError("");

    try {
      onCreated(
        await createConcept({
          name,
          description,
          knowledgePointIds: selected,
        }),
      );
    } catch (caught) {
      setError(messageFrom(caught, "Concept 创建失败，请检查名称和知识点。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="创建 Concept"
      className="concept-builder"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header>
        <div>
          <span>新图册条目</span>
          <h2>先写清定义，再选择依据</h2>
        </div>
        <button className="secondary-button" onClick={onCancel} type="button">
          取消
        </button>
      </header>

      <div className="concept-definition-fields">
        <label>
          <span>Concept 名称</span>
          <input
            autoFocus
            maxLength={120}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="例如：事件驱动架构"
            value={name}
          />
        </label>
        <label>
          <span>Concept 描述</span>
          <textarea
            maxLength={2_000}
            onChange={(event) => setDescription(event.currentTarget.value)}
            placeholder="写出这个概念自包含、可复用的含义。"
            rows={4}
            value={description}
          />
        </label>
      </div>

      <SourcePicker
        selected={selected}
        setSelected={setSelected}
      />

      {error ? <p className="concept-inline-error" role="alert">{error}</p> : null}

      <footer>
        <span>{selected.length} 个知识点已圈选，至少需要 2 个</span>
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "正在创建…" : "创建 Concept"}
        </button>
      </footer>
    </form>
  );
}

function ConceptDetailWorkspace({
  busy,
  detail,
  mode,
  onArchive,
  onCancelMode,
  onDetail,
  onEdit,
  onMembership,
  onMode,
  onRestore,
  setBusy,
  setError,
}: {
  busy: string;
  detail: ConceptDetail;
  mode: WorkspaceMode;
  onArchive: () => void;
  onCancelMode: () => void;
  onDetail: (detail: ConceptDetail, message: string) => void;
  onEdit: () => void;
  onMembership: (membership: ConceptDetail["memberships"][number]) => void;
  onMode: (mode: WorkspaceMode) => void;
  onRestore: () => void;
  setBusy: (value: string) => void;
  setError: (value: string) => void;
}) {
  const concept = detail.concept;
  const activeMemberships = detail.memberships.filter(
    (membership) => membership.status === "active",
  );
  const reviewCount = activeMemberships.filter(
    (membership) => membership.needsReview,
  ).length;

  return (
    <div aria-label="Concept 详情" className="concept-detail" role="region">
      <header className="concept-detail-heading">
        <div>
          <div className="concept-state-line">
            <span className={`concept-state ${concept.lifecycle}`}>
              {concept.lifecycle === "active" ? "生效中" : "已归档"}
            </span>
            <span>版本 {concept.revisionNumber}</span>
            <span>{activeMemberships.length} 个当前成员</span>
            {reviewCount > 0 ? <span>{reviewCount} 项待核对</span> : null}
          </div>
          <h2>{concept.name}</h2>
        </div>
        <div className="concept-heading-actions">
          {concept.lifecycle === "active" ? (
            <>
              <button className="secondary-button" onClick={onEdit} type="button">
                编辑定义
              </button>
              <button className="secondary-button" onClick={() => onMode("add")} type="button">
                添加成员
              </button>
              <button
                className="concept-archive-button"
                disabled={busy === "lifecycle"}
                onClick={onArchive}
                type="button"
              >
                归档 Concept
              </button>
            </>
          ) : (
            <button
              className="primary-button"
              disabled={busy === "lifecycle"}
              onClick={onRestore}
              type="button"
            >
              恢复 Concept
            </button>
          )}
        </div>
      </header>

      {mode === "edit" ? (
        <ConceptEditor
          detail={detail}
          onCancel={onCancelMode}
          onSaved={(next) => onDetail(next, "已保存新定义版本；旧版本仍可在历史中回看。")}
        />
      ) : (
        <section aria-label="Concept 定义" className="concept-definition-plate">
          <p>{concept.description}</p>
          <dl>
            <div>
              <dt>稳定 ID</dt>
              <dd>{concept.id}</dd>
            </div>
            <div>
              <dt>最近维护</dt>
              <dd>{formatDate(concept.updatedAt)}</dd>
            </div>
          </dl>
        </section>
      )}

      {mode === "add" ? (
        <MembershipAdder
          conceptId={concept.id}
          excludedIds={detail.memberships.map((membership) => membership.point.id)}
          onCancel={onCancelMode}
          onDetail={(next) => onDetail(next, "新 Membership 已加入 Concept。")}
          setBusy={setBusy}
          setError={setError}
        />
      ) : null}

      <section aria-label="Concept Membership" className="concept-membership-section">
        <header>
          <div>
            <h3>Membership 组装表</h3>
            <p>成员固定指向原知识点；来源过期时只提示核对，不自动迁移。</p>
          </div>
          <span>{detail.memberships.length} 条历史关联</span>
        </header>

        <div className="concept-membership-grid">
          {detail.memberships.map((membership, index) => (
            <article
              aria-label={`Membership：${membership.point.title}`}
              className="concept-membership"
              data-removed={membership.status === "removed"}
              key={membership.id}
            >
              <header>
                <span>M{String(index + 1).padStart(2, "0")}</span>
                <div>
                  {membership.status === "removed" ? "已移除" : "当前成员"}
                  {membership.needsReview ? " · 待核对" : ""}
                </div>
              </header>
              <h4>{membership.point.title}</h4>
              <p>{membership.point.body}</p>
              <Link to={`/records/${membership.point.recordId}`}>
                来源：{membership.point.recordTitle}
              </Link>
              {concept.lifecycle === "active" ? (
                <button
                  disabled={busy === membership.id || (membership.status === "removed" && membership.needsReview)}
                  onClick={() => onMembership(membership)}
                  type="button"
                >
                  {membership.status === "active" ? "移除 Membership" : "恢复 Membership"}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <ConceptHistory detail={detail} />
    </div>
  );
}

function ConceptEditor({
  detail,
  onCancel,
  onSaved,
}: {
  detail: ConceptDetail;
  onCancel: () => void;
  onSaved: (detail: ConceptDetail) => void;
}) {
  const [name, setName] = useState(detail.concept.name);
  const [description, setDescription] = useState(detail.concept.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <form
      aria-label="编辑 Concept"
      className="concept-editor"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        void updateConcept(detail.concept.id, { name, description })
          .then(onSaved)
          .catch((caught: unknown) =>
            setError(messageFrom(caught, "新版本保存失败，请检查名称和描述。")),
          )
          .finally(() => setBusy(false));
      }}
    >
      <label>
        <span>Concept 名称</span>
        <input onChange={(event) => setName(event.currentTarget.value)} value={name} />
      </label>
      <label>
        <span>Concept 描述</span>
        <textarea
          onChange={(event) => setDescription(event.currentTarget.value)}
          rows={4}
          value={description}
        />
      </label>
      {error ? <p className="concept-inline-error" role="alert">{error}</p> : null}
      <footer>
        <span>保存后生成版本 {detail.concept.revisionNumber + 1}</span>
        <button className="secondary-button" onClick={onCancel} type="button">取消</button>
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "正在保存…" : "保存新版本"}
        </button>
      </footer>
    </form>
  );
}

function SourcePicker({
  selected,
  setSelected,
}: {
  selected: string[];
  setSelected: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<ConceptSource[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    setLoading(true);
    void listConceptSources(query, controller.signal)
      .then((items) => {
        if (active) {
          setSources(items);
        }
      })
      .catch((caught: unknown) => {
        if (active && !isAbortError(caught)) {
          setSources([]);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [query]);

  return (
    <section aria-label="选择知识点" className="concept-source-picker">
      <header>
        <div>
          <h3>知识点目录</h3>
          <p>只显示当前生效、已纳入且已发布的知识点。</p>
        </div>
        <label>
          <span className="visually-hidden">搜索知识点</span>
          <input
            aria-label="搜索知识点"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="筛选标题、正文或来源"
            type="search"
            value={query}
          />
        </label>
      </header>
      <div className="concept-source-list">
        {sources.map((source) => {
          const checked = selected.includes(source.id);

          return (
            <label className="concept-source-row" data-selected={checked} key={source.id}>
              <input
                aria-label={source.id}
                checked={checked}
                onChange={(event) =>
                  setSelected(
                    event.currentTarget.checked
                      ? [...selected, source.id]
                      : selected.filter((id) => id !== source.id),
                  )
                }
                type="checkbox"
              />
              <span>
                <strong>{source.title}</strong>
                <small>{source.recordTitle}</small>
              </span>
              <p>{source.body}</p>
            </label>
          );
        })}
        {loading ? <p className="concept-source-status">正在检索知识点…</p> : null}
        {!loading && sources.length === 0 ? (
          <p className="concept-source-status">没有匹配的当前知识点。</p>
        ) : null}
      </div>
    </section>
  );
}

function MembershipAdder({
  conceptId,
  excludedIds,
  onCancel,
  onDetail,
  setBusy,
  setError,
}: {
  conceptId: string;
  excludedIds: string[];
  onCancel: () => void;
  onDetail: (detail: ConceptDetail) => void;
  setBusy: (value: string) => void;
  setError: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<ConceptSource[]>([]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    void listConceptSources(query, controller.signal)
      .then((items) => {
        if (active) {
          setSources(items.filter((item) => !excludedIds.includes(item.id)));
        }
      })
      .catch((caught: unknown) => {
        if (active && !isAbortError(caught)) {
          setSources([]);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [excludedIds, query]);

  return (
    <section aria-label="添加 Membership" className="membership-adder">
      <header>
        <div>
          <h3>添加当前知识点</h3>
          <p>已关联过的知识点不会重复出现；被移除的 Membership 请在组装表中恢复。</p>
        </div>
        <button className="secondary-button" onClick={onCancel} type="button">收起</button>
      </header>
      <input
        aria-label="筛选可添加知识点"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="筛选可添加知识点"
        type="search"
        value={query}
      />
      <div className="membership-adder-list">
        {sources.map((source) => (
          <div key={source.id}>
            <span><strong>{source.title}</strong><small>{source.recordTitle}</small></span>
            <button
              onClick={() => {
                setBusy(source.id);
                setError("");
                void addConceptMembership(conceptId, source.id)
                  .then(onDetail)
                  .catch((caught: unknown) =>
                    setError(messageFrom(caught, "Membership 添加失败。")),
                  )
                  .finally(() => setBusy(""));
              }}
              type="button"
            >
              添加
            </button>
          </div>
        ))}
        {sources.length === 0 ? <p>没有可添加的当前知识点。</p> : null}
      </div>
    </section>
  );
}

function ConceptHistory({ detail }: { detail: ConceptDetail }) {
  return (
    <details className="concept-history">
      <summary>版本与活动历史（{detail.activity.length}）</summary>
      <div className="concept-history-columns">
        <section aria-label="定义版本">
          <h3>定义版本</h3>
          {detail.revisions.toReversed().map((revision) => (
            <div key={revision.id}>
              <span>v{revision.revisionNumber}</span>
              <strong>{revision.name}</strong>
              <p>{revision.description}</p>
              <time>{formatDate(revision.createdAt)}</time>
            </div>
          ))}
        </section>
        <section aria-label="Concept 活动">
          <h3>活动</h3>
          {detail.activity.toReversed().map((activity) => (
            <div key={activity.sequenceNumber}>
              <span>#{activity.sequenceNumber}</span>
              <strong>{activityLabel(activity.kind)}</strong>
              <time>{formatDate(activity.occurredAt)}</time>
            </div>
          ))}
        </section>
      </div>
    </details>
  );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (error) {
    return <p className="concept-feedback error" role="alert">{error}</p>;
  }

  return notice ? <p className="concept-feedback notice" role="status">{notice}</p> : null;
}

function activityLabel(kind: ConceptDetail["activity"][number]["kind"]): string {
  return {
    archived: "归档 Concept",
    created: "创建定义",
    member_added: "加入 Membership",
    member_removed: "移除 Membership",
    member_restored: "恢复 Membership",
    restored: "恢复 Concept",
    updated: "保存定义版本",
  }[kind];
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
