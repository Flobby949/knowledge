/*
 * THESIS: Review is a calm verification bench: source evidence stays fixed while decisions happen point by point.
 * OWN-WORLD: Cold paper planes, graphite reading type, hairline rules, and electric blue reserved for confirmation.
 * STORY: The queue names the record, the left pane preserves its exact source, and the right pane records explicit human decisions.
 * FIRST VIEWPORT: 60px navigation, a 72px queue strip, then a 58/42 two-pane workspace with a persistent completion action.
 */
import { useEffect, useRef, useState } from "react";

import {
  decideReviewItem,
  getOrganizedItemEvidence,
  getRecordDetail,
  getReviewQueue,
  putOrganizedItemCorrection,
  type EvidenceSpan,
  type OrganizedItem,
  type RecordDetail,
  type ReviewQueueItem,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./review-page.css";

export function ReviewPage() {
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [items, setItems] = useState<OrganizedItem[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [bulkDecisionBusy, setBulkDecisionBusy] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceSpan | null>(
    null,
  );
  const [selectedEvidenceItemId, setSelectedEvidenceItemId] = useState<
    string | null
  >(null);
  const [evidenceBusyId, setEvidenceBusyId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<OrganizedItem | null>(null);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const correctionButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let active = true;

    void loadFirstQueueRecord().then((loaded) => {
      if (!active) {
        return;
      }

      setQueue(loaded.queue);
      setQueueIndex(0);
      setRecord(loaded.record);
      setItems(loaded.record?.organizedItems ?? []);
      setPendingCount(loaded.queue[0]?.pendingCount ?? 0);
      setLoading(false);
    }).catch(() => {
      if (active) {
        setLoadError("审查队列暂时无法载入，请稍后重试。");
        setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  async function makeDecision(
    item: OrganizedItem,
    decision: "confirm" | "reject",
  ) {
    if (!record || item.publicationStatus !== "PENDING_REVIEW") {
      return;
    }

    setDecidingId(item.id);

    try {
      const decided = await decideReviewItem(record.id, item.id, decision);
      setItems((current) =>
        current.map((candidate) =>
          candidate.id === item.id
            ? { ...candidate, publicationStatus: decided.publicationStatus }
            : candidate,
        ),
      );
      setPendingCount((current) => Math.max(0, current - 1));
      setQueue((current) =>
        current.map((candidate, index) =>
          index === queueIndex
            ? {
                ...candidate,
                pendingCount: Math.max(0, candidate.pendingCount - 1),
              }
            : candidate,
        ),
      );
    } finally {
      setDecidingId(null);
    }
  }

  async function confirmAllPending() {
    const pendingItems = items.filter(
      (item) => item.publicationStatus === "PENDING_REVIEW",
    );

    if (!record || pendingItems.length === 0 || bulkDecisionBusy) {
      return;
    }

    setBulkDecisionBusy(true);

    try {
      for (const item of pendingItems) {
        await makeDecision(item, "confirm");
      }
    } finally {
      setBulkDecisionBusy(false);
    }
  }

  async function finishCurrent() {
    if (pendingCount !== 0 || !record) {
      return;
    }

    const preferredNextIds = [
      ...queue.slice(queueIndex + 1),
      ...queue.slice(0, queueIndex),
    ].map((item) => item.record.id);

    setLoading(true);
    setLoadError("");

    try {
      const nextQueue = await getReviewQueue();
      const preferredId = preferredNextIds.find((id) =>
        nextQueue.some((item) => item.record.id === id),
      );
      const nextIndex = preferredId
        ? nextQueue.findIndex((item) => item.record.id === preferredId)
        : 0;
      const next = nextQueue[nextIndex];
      const nextRecord = next ? await getRecordDetail(next.record.id) : null;

      setQueue(nextQueue);
      setQueueIndex(next ? nextIndex : 0);
      setRecord(nextRecord);
      setItems(nextRecord?.organizedItems ?? []);
      setPendingCount(next?.pendingCount ?? 0);
      setSelectedEvidence(null);
      setSelectedEvidenceItemId(null);
    } catch {
      setLoadError("下一条审查记录暂时无法载入，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function moveToQueueIndex(nextIndex: number) {
    const next = queue[nextIndex];

    if (!next || loading || decidingId || bulkDecisionBusy) {
      return;
    }

    setLoading(true);
    setLoadError("");

    try {
      const nextRecord = await getRecordDetail(next.record.id);

      setQueueIndex(nextIndex);
      setRecord(nextRecord);
      setItems(nextRecord.organizedItems);
      setPendingCount(next.pendingCount);
      setSelectedEvidence(null);
      setSelectedEvidenceItemId(null);
    } catch {
      setLoadError("这条审查记录暂时无法载入，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function selectEvidence(item: OrganizedItem) {
    if (!record || evidenceBusyId) {
      return;
    }

    setEvidenceBusyId(item.id);

    try {
      const evidence = await getOrganizedItemEvidence(record.id, item.id);

      setSelectedEvidence(evidence[0] ?? null);
      setSelectedEvidenceItemId(item.id);
    } finally {
      setEvidenceBusyId(null);
    }
  }

  function closeCorrection(itemId: string) {
    setEditingItem(null);
    window.requestAnimationFrame(() =>
      correctionButtons.current.get(itemId)?.focus(),
    );
  }

  async function saveCorrection(
    item: OrganizedItem,
    correction: { title: string; body: string },
  ) {
    if (!record || item.publicationStatus !== "PENDING_REVIEW") {
      return;
    }

    const updated = await putOrganizedItemCorrection(
      record.id,
      item.id,
      correction,
    );

    setItems((current) =>
      current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    );
    setPendingCount((current) => Math.max(0, current - 1));
    setQueue((current) =>
      current.map((candidate, index) =>
        index === queueIndex
          ? {
              ...candidate,
              pendingCount: Math.max(0, candidate.pendingCount - 1),
            }
          : candidate,
      ),
    );
    closeCorrection(item.id);
  }

  function handleSaved() {
    setNewRecordOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  const hasRecord = record !== null;

  return (
    <div className="review-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <section aria-label="审查队列" className="review-queue-bar">
        <div className="review-queue-progress">
          <div>
            <span>审查队列</span>
            <strong aria-label="队列位置">
              {queue.length ? `${queueIndex + 1} / ${queue.length}` : "0 / 0"}
            </strong>
          </div>
          <span aria-hidden="true" className="review-queue-track">
            <span
              style={{
                width: queue.length
                  ? `${((queueIndex + 1) / queue.length) * 100}%`
                  : "0%",
              }}
            />
          </span>
        </div>
        <div className="review-queue-current">
          <button
            disabled={
              queueIndex === 0 ||
              loading ||
              decidingId !== null ||
              bulkDecisionBusy
            }
            onClick={() => void moveToQueueIndex(queueIndex - 1)}
            type="button"
          >
            <span aria-hidden="true">‹</span> 上一条
          </button>
          <strong>{record?.presentation.title ?? "等待下一条记录"}</strong>
          <button
            disabled={
              queue.length === 0 ||
              queueIndex >= queue.length - 1 ||
              loading ||
              decidingId !== null ||
              bulkDecisionBusy
            }
            onClick={() => void moveToQueueIndex(queueIndex + 1)}
            type="button"
          >
            下一条 <span aria-hidden="true">›</span>
          </button>
        </div>
        <div className="review-queue-status">
          <span><i aria-hidden="true" />待审查</span>
          <span className="review-pending-label">
            待处理 <strong aria-label="待处理知识点">{pendingCount}</strong>
          </span>
        </div>
      </section>

      <main aria-label="待审查" className="review-workspace">
        {loadError ? <p className="review-feedback" role="alert">{loadError}</p> : null}
        {loading && !hasRecord ? <p className="review-feedback" role="status">正在载入审查队列…</p> : null}
        {!loading && !loadError && !hasRecord ? (
          <div aria-label="审查队列为空" className="review-empty" role="status">
            <span aria-hidden="true" />
            <h1>暂无待审查记录</h1>
            <p>新的逐点审查任务会出现在这里。</p>
          </div>
        ) : null}
        {record ? (
          <>
            <section aria-label="记录与原文" className="review-source-pane">
              <p className="review-eyebrow">原文 v{record.editable.textVersion}</p>
              <div className="review-generated-title">
                <h1>{record.presentation.title}</h1>
                <span aria-label="内容来源">AI 生成</span>
              </div>
              <div className="review-record-tags">
                <span>我的标签</span>
                <ul aria-label="我的标签">
                  {record.editable.myTags.map((tag) => (
                    <li key={tag.id}>{tag.name}</li>
                  ))}
                </ul>
              </div>
              {record.presentation.summary ? (
                <section aria-label="AI 生成摘要" className="review-summary">
                  <span>AI 摘要</span>
                  <p>{record.presentation.summary}</p>
                </section>
              ) : null}
              <div className="review-source-copy">
                <h2>完整原文</h2>
                <pre aria-label="完整原文">
                  <HighlightedSource
                    evidence={selectedEvidence}
                    sourceText={record.editable.text}
                  />
                </pre>
              </div>
            </section>

            <section aria-label="知识点" className="review-points-pane">
              <header>
                <h2>本次生成 <span>· {items.length} 个知识点</span></h2>
                <div className="review-points-tools">
                  <button
                    disabled={
                      pendingCount === 0 ||
                      decidingId !== null ||
                      bulkDecisionBusy
                    }
                    onClick={() => void confirmAllPending()}
                    type="button"
                  >
                    {bulkDecisionBusy ? "确认中…" : "全部确认"}
                  </button>
                </div>
              </header>
              <div className="review-point-list">
                {items.map((item) => (
                  <ReviewPoint
                    busy={decidingId === item.id}
                    correctionButton={(element) => {
                      if (element) {
                        correctionButtons.current.set(item.id, element);
                      } else {
                        correctionButtons.current.delete(item.id);
                      }
                    }}
                    evidenceBusy={evidenceBusyId === item.id}
                    evidenceSelected={selectedEvidenceItemId === item.id}
                    item={item}
                    key={item.id}
                    onDecision={makeDecision}
                    onEdit={() => setEditingItem(item)}
                    onEvidence={() => void selectEvidence(item)}
                  />
                ))}
              </div>
            </section>
          </>
        ) : null}
      </main>

      {record ? (
        <section aria-label="审查流转" className="review-finish-bar">
          <span>
            <i aria-hidden="true">i</i>
            {pendingCount === 0
              ? "本条知识点均已处理，可完成并进入下一条记录。"
              : `请处理全部知识点后完成；当前还有 ${pendingCount} 点待处理。`}
          </span>
          <div>
            <button
              className="secondary-button"
              disabled={
                queueIndex >= queue.length - 1 ||
                loading ||
                decidingId !== null ||
                bulkDecisionBusy
              }
              onClick={() => void moveToQueueIndex(queueIndex + 1)}
              type="button"
            >
              保留未处理并下一条
            </button>
            <button
              className="primary-button"
              disabled={
                pendingCount !== 0 ||
                decidingId !== null ||
                bulkDecisionBusy
              }
              onClick={() => void finishCurrent()}
              type="button"
            >
              完成并下一条
            </button>
          </div>
        </section>
      ) : null}

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          window.requestAnimationFrame(() => newRecordButton.current?.focus());
        }}
        onSaved={handleSaved}
        open={newRecordOpen}
      />
      {editingItem ? (
        <ReviewCorrectionDialog
          item={editingItem}
          onClose={() => closeCorrection(editingItem.id)}
          onSave={(correction) => saveCorrection(editingItem, correction)}
        />
      ) : null}
    </div>
  );
}

function ReviewPoint({
  busy,
  correctionButton,
  evidenceBusy,
  evidenceSelected,
  item,
  onDecision,
  onEdit,
  onEvidence,
}: {
  busy: boolean;
  correctionButton: (element: HTMLButtonElement | null) => void;
  evidenceBusy: boolean;
  evidenceSelected: boolean;
  item: OrganizedItem;
  onDecision: (
    item: OrganizedItem,
    decision: "confirm" | "reject",
  ) => Promise<void>;
  onEdit: () => void;
  onEvidence: () => void;
}) {
  const pending = item.publicationStatus === "PENDING_REVIEW";

  return (
    <article
      className={[
        "review-point",
        pending ? "" : "decided",
        evidenceSelected ? "selected" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="review-point-heading">
        <span>
          <span aria-label="审查状态">{reviewStatus(item.publicationStatus)}</span>
          {item.correction ? <span className="review-correction-state">用户修正</span> : null}
        </span>
      </div>
      <h3>{item.title}</h3>
      <p aria-label="知识点正文">{item.body}</p>
      <div className="review-point-evidence-row">
        <ul aria-label="AI 标签">
          {item.tags.map((tag) => <li key={tag.id}>{tag.name}</li>)}
        </ul>
        <button
          aria-pressed={evidenceSelected}
          disabled={evidenceBusy}
          onClick={onEvidence}
          type="button"
        >
          {evidenceBusy ? "正在定位证据…" : `证据 ${item.evidenceCount} 处`}
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      <div className="review-point-actions">
        <button
          disabled={!pending || busy}
          onClick={() => void onDecision(item, "confirm")}
          type="button"
        >
          确认
        </button>
        <button
          disabled={!pending || busy}
          onClick={onEdit}
          ref={correctionButton}
          type="button"
        >
          修正后确认
        </button>
        <button
          className="reject"
          disabled={!pending || busy}
          onClick={() => void onDecision(item, "reject")}
          type="button"
        >
          拒绝
        </button>
      </div>
    </article>
  );
}

function ReviewCorrectionDialog({
  item,
  onClose,
  onSave,
}: {
  item: OrganizedItem;
  onClose: () => void;
  onSave: (correction: { title: string; body: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const canSave =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (title !== item.title || body !== item.body) &&
    !saving;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleInput.current?.focus());

    return () => window.cancelAnimationFrame(frame);
  }, []);

  async function save() {
    if (!canSave) {
      return;
    }

    setSaving(true);
    setSaveError("");

    try {
      await onSave({ title, body });
    } catch {
      setSaveError("修正暂时无法保存，输入仍保留在这里，请重试。");
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    ) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);

    if (!first || !last) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="review-correction-overlay">
      <div
        aria-labelledby="review-correction-title"
        aria-modal="true"
        className="review-correction-dialog"
        onKeyDown={handleKeyDown}
        ref={dialog}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="review-correction-title">修正知识点</h2>
            <p>保存后作为用户修正确认；AI 原值与原文证据仍会保留。</p>
          </div>
          <button aria-label="关闭修正知识点" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="review-correction-body">
          <fieldset>
            <legend className="visually-hidden">用户修正</legend>
            <label htmlFor="review-correction-heading">知识点标题</label>
            <input
              id="review-correction-heading"
              onChange={(event) => setTitle(event.target.value)}
              ref={titleInput}
              value={title}
            />
            <label htmlFor="review-correction-copy">知识点正文</label>
            <textarea
              id="review-correction-copy"
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />
          </fieldset>
          <aside aria-label="AI 原值" role="region">
            <span>AI 原值</span>
            <h3>{item.aiOriginal.title}</h3>
            <p>{item.aiOriginal.body}</p>
            <small>证据只核验这份 AI 原始内容，不为用户补充背书。</small>
          </aside>
        </div>
        <footer>
          <p>{saveError ? <span role="alert">{saveError}</span> : "标题与正文按纯文本保存。"}</p>
          <div>
            <button className="secondary-button" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="primary-button"
              disabled={!canSave}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "保存中…" : "保存修正并确认"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function HighlightedSource({
  evidence,
  sourceText,
}: {
  evidence: EvidenceSpan | null;
  sourceText: string;
}) {
  if (
    !evidence ||
    sourceText.slice(evidence.start, evidence.end) !== evidence.quote
  ) {
    return sourceText;
  }

  return (
    <>
      {sourceText.slice(0, evidence.start)}
      <mark>{evidence.quote}</mark>
      {sourceText.slice(evidence.end)}
    </>
  );
}

async function loadFirstQueueRecord(): Promise<{
  queue: ReviewQueueItem[];
  record: RecordDetail | null;
}> {
  const queue = await getReviewQueue();
  const first = queue[0];

  return {
    queue,
    record: first ? await getRecordDetail(first.record.id) : null,
  };
}

function reviewStatus(status: OrganizedItem["publicationStatus"]): string {
  if (status === "CONFIRMED") {
    return "已确认";
  }

  if (status === "REJECTED") {
    return "已拒绝";
  }

  return "待审查";
}
