/*
 * THESIS: The detail surface is a verification desk, not a dashboard.
 * OWN-WORLD: Cold paper-white planes, graphite reading type, hairline blue-gray rules, and rare electric-blue signals.
 * STORY: The user returns from the archive, confirms the exact saved source, and sees plainly that no knowledge was invented.
 * FIRST VIEWPORT: A 60px global navigation, 64px action strip, then a full-height 58/42 source-and-knowledge split.
 * FORM: Established-world precision archive; the product brief fixes this two-pane staging, so no concept seed applies.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  adoptOrganizationCandidate,
  archiveRecord,
  deleteRecord,
  deleteOrganizedItemCorrection,
  deleteRecordOverviewCorrection,
  discardOrganizationCandidate,
  getOrganizedItemEvidence,
  getRecordDetail,
  getRecordHistory,
  getRecordHistoryEntry,
  organizeRecord,
  putOrganizedItemCorrection,
  putOrganizedItemInclusion,
  putRecordOverviewCorrection,
  restoreRecord,
  type EvidenceSpan,
  type OrganizationCandidate,
  type OrganizedItem,
  type RecordDetail,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import { RecordHistoryWorkspace } from "./record-history-workspace.js";
import "./record-detail.css";

export function RecordDetailPage() {
  const { recordId = "" } = useParams();
  const navigate = useNavigate();
  const [record, setRecord] = useState<RecordDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [overviewCorrectionOpen, setOverviewCorrectionOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [organizationRefresh, setOrganizationRefresh] = useState(0);
  const [reanalysisBusy, setReanalysisBusy] = useState(false);
  const [candidateDecision, setCandidateDecision] = useState<
    "adopt" | "discard" | null
  >(null);
  const [organizationActionError, setOrganizationActionError] = useState("");
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const reanalysisButton = useRef<HTMLButtonElement>(null);
  const overviewCorrectionButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const deleteCancelButton = useRef<HTMLButtonElement>(null);
  const restoreReanalysisFocus = useRef(false);
  const loadedRecordId = useRef("");

  useEffect(() => {
    let active = true;
    let pollTimer: number | undefined;

    if (loadedRecordId.current !== recordId) {
      loadedRecordId.current = recordId;
      setRecord(null);
    }
    setLoadError("");

    async function loadRecord() {
      try {
        const item = await getRecordDetail(recordId);

        if (!active) {
          return;
        }

        setRecord(item);
        setLoadError("");

        if (
          item.organization.activity === "queued" ||
          item.organization.activity === "running"
        ) {
          pollTimer = window.setTimeout(() => void loadRecord(), 80);
        }
      } catch {
        if (active) {
          setLoadError("记录暂时无法载入，请返回记录库后重试。");
        }
      }
    }

    void loadRecord();

    return () => {
      active = false;
      window.clearTimeout(pollTimer);
    };
  }, [organizationRefresh, recordId]);

  useEffect(() => {
    if (
      !record ||
      record.organization.candidate ||
      !restoreReanalysisFocus.current
    ) {
      return;
    }

    restoreReanalysisFocus.current = false;
    const frame = window.requestAnimationFrame(() =>
      reanalysisButton.current?.focus(),
    );

    return () => window.cancelAnimationFrame(frame);
  }, [record]);

  useEffect(() => {
    if (!deleteConfirmation) {
      return;
    }

    const frame = window.requestAnimationFrame(() =>
      deleteCancelButton.current?.focus(),
    );

    return () => window.cancelAnimationFrame(frame);
  }, [deleteConfirmation]);

  useEffect(() => {
    if (!deleteBusy) {
      return;
    }

    const frame = window.requestAnimationFrame(() => deleteDialog.current?.focus());

    return () => window.cancelAnimationFrame(frame);
  }, [deleteBusy]);

  function closeDialog() {
    setDialogOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  function handleSaved() {
    closeDialog();
  }

  function handleEdited() {
    setEditOpen(false);
    void getRecordDetail(recordId).then(setRecord).catch(() => {
      setLoadError("修改已保存，但记录暂时无法重新载入，请稍后重试。");
    });
  }

  function closeOverviewCorrection() {
    setOverviewCorrectionOpen(false);
    window.requestAnimationFrame(() => overviewCorrectionButton.current?.focus());
  }

  async function handleOverviewCorrection(correction: {
    title: string;
    summary: string;
  }) {
    if (!record) {
      return;
    }

    const presentation = await putRecordOverviewCorrection(record.id, correction);

    setRecord((current) =>
      current ? { ...current, presentation } : current,
    );
    closeOverviewCorrection();
  }

  async function handleRemoveOverviewCorrection() {
    if (!record?.presentation.aiOriginal) {
      return;
    }

    const aiOriginal = record.presentation.aiOriginal;

    await deleteRecordOverviewCorrection(record.id);
    setRecord((current) =>
      current
        ? {
            ...current,
            presentation: {
              title: aiOriginal.title,
              summary: aiOriginal.summary,
              source: "ai",
            },
          }
        : current,
    );
    closeOverviewCorrection();
  }

  async function handleArchive() {
    if (!record || lifecycleBusy) {
      return;
    }

    setLifecycleBusy(true);

    try {
      await archiveRecord(record.id);
      setRecord(await getRecordDetail(record.id));
      setArchiveConfirmation(false);
      setMoreOpen(false);
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleRestore() {
    if (!record || lifecycleBusy) {
      return;
    }

    setLifecycleBusy(true);

    try {
      await restoreRecord(record.id);
      setRecord(await getRecordDetail(record.id));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function handleReanalysis() {
    if (
      !record ||
      record.lifecycle === "archived" ||
      record.organization.candidate ||
      record.organization.activity === "queued" ||
      record.organization.activity === "running" ||
      reanalysisBusy
    ) {
      return;
    }

    setOrganizationActionError("");
    setReanalysisBusy(true);

    try {
      await organizeRecord(record.id, "automatic");
      setOrganizationRefresh((version) => version + 1);
    } catch {
      setOrganizationActionError("重新整理暂时无法启动，请稍后重试。");
    } finally {
      setReanalysisBusy(false);
    }
  }

  async function handleCandidateDecision(decision: "adopt" | "discard") {
    const candidate = record?.organization.candidate;

    if (!record || !candidate || candidateDecision) {
      return;
    }

    setCandidateDecision(decision);
    setOrganizationActionError("");

    try {
      if (decision === "adopt") {
        await adoptOrganizationCandidate(record.id, candidate.id);
      } else {
        await discardOrganizationCandidate(record.id, candidate.id);
      }

      restoreReanalysisFocus.current = true;
      setRecord(await getRecordDetail(record.id));
    } catch {
      setOrganizationActionError(
        decision === "adopt"
          ? "候选版本暂时无法采用，请保留此页并重试。"
          : "候选版本暂时无法丢弃，请保留此页并重试。",
      );
    } finally {
      setCandidateDecision(null);
    }
  }

  function closeDeleteConfirmation() {
    if (deleteBusy) {
      return;
    }

    setDeleteConfirmation(false);
    setDeleteError("");
    window.requestAnimationFrame(() => moreButton.current?.focus());
  }

  function handleDeleteDialogKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeleteConfirmation();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = [
      ...(deleteDialog.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) ?? []),
    ];
    const first = focusable[0];
    const last = focusable.at(-1);

    if (!first || !last) {
      event.preventDefault();
      deleteDialog.current?.focus();
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

  async function handlePermanentDelete() {
    if (!record || deleteBusy) {
      return;
    }

    setDeleteBusy(true);
    setDeleteError("");

    try {
      await deleteRecord(record.id);
      navigate("/records", { replace: true });
    } catch {
      setDeleteError("永久删除暂时失败，记录仍然保留。请稍后重试。");
      setDeleteBusy(false);
    }
  }

  return (
    <div className="record-detail-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setDialogOpen(true)}
      />

      <div aria-label="记录操作" className="record-detail-toolbar" role="toolbar">
        <Link className="detail-back-link" to="/records">
          <span aria-hidden="true">←</span>
          <span>返回记录库</span>
        </Link>
        <span aria-label="处理状态" className="save-only-state">
          <span aria-hidden="true" className="save-only-mark" />
          {recordProcessingLabel(record)}
        </span>
        {organizationActionError && !record?.organization.candidate ? (
          <span className="detail-toolbar-error" role="alert">
            {organizationActionError}
          </span>
        ) : null}
        <div className="detail-toolbar-actions">
          <button
            className="detail-action-button"
            disabled={!record}
            onClick={() => setEditOpen(true)}
            ref={editButton}
            type="button"
          >
            编辑记录
          </button>
          <button
            className="detail-action-button"
            disabled={!record}
            onClick={() => setHistoryOpen(true)}
            ref={historyButton}
            type="button"
          >
            历史版本
          </button>
          <button
            className="detail-action-button"
            disabled={
              !record ||
              record.lifecycle === "archived" ||
              Boolean(record.organization.candidate) ||
              record.organization.activity === "queued" ||
              record.organization.activity === "running" ||
              reanalysisBusy
            }
            onClick={() => void handleReanalysis()}
            ref={reanalysisButton}
            type="button"
          >
            {reanalysisBusy ? "重新整理中…" : "重新整理"}
          </button>
          {record?.lifecycle === "archived" ? (
            <button
              className="detail-action-button"
              disabled={lifecycleBusy}
              onClick={() => void handleRestore()}
              type="button"
            >
              {lifecycleBusy ? "恢复中…" : "恢复记录"}
            </button>
          ) : null}
          <div className="detail-more-actions">
            <button
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className="detail-action-button"
              disabled={!record}
              onClick={() => setMoreOpen((visible) => !visible)}
              ref={moreButton}
              type="button"
            >
              更多操作
            </button>
            {moreOpen ? (
              <div aria-label="更多操作" className="detail-actions-menu" role="menu">
                {record?.lifecycle === "active" ? (
                  <div aria-label="记录状态" role="group">
                    <button
                      disabled={
                        lifecycleBusy ||
                        record.organization.activity === "queued" ||
                        record.organization.activity === "running"
                      }
                      onClick={() => {
                        setMoreOpen(false);
                        setArchiveConfirmation(true);
                      }}
                      role="menuitem"
                      type="button"
                    >
                      归档记录
                    </button>
                  </div>
                ) : null}
                <div
                  aria-label="危险操作"
                  className="detail-danger-actions"
                  role="group"
                >
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      setDeleteError("");
                      setDeleteConfirmation(true);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    永久删除
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {record ? (
        <RecordDetailContent
          candidateDecision={candidateDecision}
          candidateError={organizationActionError}
          onCandidateDecision={handleCandidateDecision}
          onOrganizeLatest={handleReanalysis}
          onOpenOverviewCorrection={() => setOverviewCorrectionOpen(true)}
          organizeLatestBusy={reanalysisBusy}
          overviewCorrectionButton={overviewCorrectionButton}
          record={record}
        />
      ) : null}
      {!record && !loadError ? (
        <main aria-label="记录详情" className="record-detail-feedback">
          <p role="status">正在载入记录…</p>
        </main>
      ) : null}
      {loadError ? (
        <main aria-label="记录详情" className="record-detail-feedback">
          <p role="alert">{loadError}</p>
          <Link to="/records">返回记录库</Link>
        </main>
      ) : null}

      <NewRecordDialog
        open={dialogOpen}
        onClose={closeDialog}
        onSaved={handleSaved}
      />
      {record ? (
        <NewRecordDialog
          editingRecord={record}
          onClose={() => {
            setEditOpen(false);
            window.requestAnimationFrame(() => editButton.current?.focus());
          }}
          onSaved={handleEdited}
          open={editOpen}
        />
      ) : null}
      {archiveConfirmation ? (
        <div className="detail-confirm-overlay">
          <div
            aria-labelledby="archive-confirm-title"
            aria-modal="true"
            className="detail-confirm-dialog"
            role="alertdialog"
          >
            <h2 id="archive-confirm-title">归档记录？</h2>
            <p>归档后会从默认记录库隐藏，原文与历史版本仍会完整保留。</p>
            <div>
              <button
                className="secondary-button"
                disabled={lifecycleBusy}
                onClick={() => setArchiveConfirmation(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={lifecycleBusy}
                onClick={() => void handleArchive()}
                type="button"
              >
                {lifecycleBusy ? "归档中…" : "确认归档"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deleteConfirmation ? (
        <div className="detail-confirm-overlay">
          <div
            aria-labelledby="delete-confirm-title"
            aria-modal="true"
            className="detail-confirm-dialog is-destructive"
            onKeyDown={handleDeleteDialogKeyDown}
            ref={deleteDialog}
            role="alertdialog"
            tabIndex={-1}
          >
            <h2 id="delete-confirm-title">永久删除记录？</h2>
            <p>
              <strong>此操作不可恢复。</strong>
              原文及历史版本、AI 整理结果、用户修正、证据和这条记录的标签关联都会永久删除。
            </p>
            {deleteError ? (
              <p className="detail-delete-error" role="alert">
                {deleteError}
              </p>
            ) : null}
            <div>
              <button
                className="secondary-button"
                disabled={deleteBusy}
                onClick={closeDeleteConfirmation}
                ref={deleteCancelButton}
                type="button"
              >
                取消
              </button>
              <button
                className="danger-button"
                disabled={deleteBusy}
                onClick={() => void handlePermanentDelete()}
                type="button"
              >
                {deleteBusy ? "永久删除中…" : "永久删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {record ? (
        <RecordHistoryWorkspace
          onClose={() => {
            setHistoryOpen(false);
            window.requestAnimationFrame(() => historyButton.current?.focus());
          }}
          open={historyOpen}
          record={record}
        />
      ) : null}
      {record && overviewCorrectionOpen ? (
        <OverviewCorrectionDialog
          onClose={closeOverviewCorrection}
          onRemove={handleRemoveOverviewCorrection}
          onSave={handleOverviewCorrection}
          presentation={record.presentation}
        />
      ) : null}
    </div>
  );
}

function recordProcessingLabel(record: RecordDetail | null): string {
  if (!record) {
    return "正在载入";
  }

  if (record.lifecycle === "archived") {
    return "已归档";
  }

  if (record.organization.activity === "queued") {
    return "原文已保存 · 等待整理";
  }

  if (record.organization.activity === "running") {
    return "原文已保存 · 正在整理";
  }

  if (record.organization.activity === "failed") {
    return "原文已保存 · 整理失败";
  }

  return record.organization.view === "organized" ? "AI 整理完成" : "仅保存";
}

function RecordDetailContent({
  candidateDecision,
  candidateError,
  onCandidateDecision,
  onOrganizeLatest,
  onOpenOverviewCorrection,
  organizeLatestBusy,
  overviewCorrectionButton,
  record,
}: {
  candidateDecision: "adopt" | "discard" | null;
  candidateError: string;
  onCandidateDecision: (decision: "adopt" | "discard") => Promise<void>;
  onOrganizeLatest: () => Promise<void>;
  onOpenOverviewCorrection: () => void;
  organizeLatestBusy: boolean;
  overviewCorrectionButton: React.RefObject<HTMLButtonElement | null>;
  record: RecordDetail;
}) {
  const [organizedItems, setOrganizedItems] = useState(record.organizedItems);
  const [excludedItems, setExcludedItems] = useState(record.excludedItems);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceSpan | null>(
    null,
  );
  const [historicalSource, setHistoricalSource] = useState<null | {
    text: string;
    version: number;
  }>(null);
  const [evidenceLoadingVersion, setEvidenceLoadingVersion] = useState<
    number | null
  >(null);
  const [evidenceLoadError, setEvidenceLoadError] = useState("");
  const [editingItem, setEditingItem] = useState<OrganizedItem | null>(null);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [visibleAiOriginals, setVisibleAiOriginals] = useState<string[]>([]);
  const [inclusionBusyId, setInclusionBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [inclusionNotice, setInclusionNotice] = useState<null | {
    item: OrganizedItem;
    message: string;
    canUndo: boolean;
  }>(null);
  const correctionButtons = useRef(new Map<string, HTMLButtonElement>());
  const excludedToggle = useRef<HTMLButtonElement>(null);
  const evidenceRequest = useRef(0);

  useEffect(() => {
    setOrganizedItems(record.organizedItems);
    setExcludedItems(record.excludedItems);
    setSelectedItemId(null);
    setSelectedEvidence(null);
    setHistoricalSource(null);
    setEvidenceLoadingVersion(null);
    setEvidenceLoadError("");
    evidenceRequest.current += 1;

    if (record.organization.candidate) {
      setEditingItem(null);
    }
  }, [record]);

  async function selectItem(itemId: string) {
    const requestId = evidenceRequest.current + 1;

    evidenceRequest.current = requestId;
    setSelectedItemId(itemId);
    setSelectedEvidence(null);
    setHistoricalSource(null);
    setEvidenceLoadingVersion(null);
    setEvidenceLoadError("");

    try {
      const evidence = await getOrganizedItemEvidence(record.id, itemId);
      const selected = evidence[0] ?? null;

      if (evidenceRequest.current !== requestId || !selected) {
        return;
      }

      if (selected.sourceTextVersion === record.editable.textVersion) {
        setSelectedEvidence(selected);
        return;
      }

      setEvidenceLoadingVersion(selected.sourceTextVersion);

      const history = await getRecordHistory(record.id);
      const sourceEntry = history.find(
        (entry) =>
          entry.type === "original" &&
          entry.version === selected.sourceTextVersion,
      );

      if (!sourceEntry) {
        throw new Error("Referenced source revision is missing");
      }

      const snapshot = await getRecordHistoryEntry(record.id, sourceEntry.id);

      if (
        snapshot.type !== "original" ||
        snapshot.version !== selected.sourceTextVersion ||
        snapshot.snapshot.text.slice(selected.start, selected.end) !==
          selected.quote
      ) {
        throw new Error("Referenced evidence does not match its source revision");
      }

      if (evidenceRequest.current !== requestId) {
        return;
      }

      setHistoricalSource({
        text: snapshot.snapshot.text,
        version: snapshot.version,
      });
      setSelectedEvidence(selected);
      setEvidenceLoadingVersion(null);
    } catch {
      if (evidenceRequest.current !== requestId) {
        return;
      }

      setHistoricalSource(null);
      setSelectedEvidence(null);
      setEvidenceLoadingVersion(null);
      setEvidenceLoadError(
        "暂时无法载入这条知识点所依据的历史原文，请稍后重新选择。",
      );
    }
  }

  function showCurrentSource() {
    evidenceRequest.current += 1;
    setHistoricalSource(null);
    setSelectedEvidence(null);
    setEvidenceLoadingVersion(null);
    setEvidenceLoadError("");
  }

  async function organizeLatestSource() {
    showCurrentSource();
    await onOrganizeLatest();
  }

  function replaceItem(updated: OrganizedItem) {
    setOrganizedItems((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    setExcludedItems((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  function closeCorrection(itemId: string) {
    setEditingItem(null);
    window.requestAnimationFrame(() => correctionButtons.current.get(itemId)?.focus());
  }

  async function saveCorrection(
    item: OrganizedItem,
    correction: { title: string; body: string },
  ) {
    const updated = await putOrganizedItemCorrection(
      record.id,
      item.id,
      correction,
    );

    replaceItem(updated);
    closeCorrection(item.id);
  }

  async function removeCorrection(item: OrganizedItem) {
    setActionError("");

    try {
      await deleteOrganizedItemCorrection(record.id, item.id);
      replaceItem({
        ...item,
        title: item.aiOriginal.title,
        body: item.aiOriginal.body,
        correction: null,
      });
      setVisibleAiOriginals((current) =>
        current.filter((itemId) => itemId !== item.id),
      );
    } catch {
      setActionError("暂时无法撤销这条修正，请稍后重试。");
    }
  }

  async function changeInclusion(
    item: OrganizedItem,
    status: "included" | "excluded",
  ) {
    if (inclusionBusyId) {
      return;
    }

    setActionError("");
    setInclusionBusyId(item.id);

    try {
      const updated = await putOrganizedItemInclusion(record.id, item.id, status);

      if (status === "excluded") {
        setOrganizedItems((current) =>
          current.filter((candidate) => candidate.id !== item.id),
        );
        setExcludedItems((current) => [
          ...current.filter((candidate) => candidate.id !== item.id),
          updated,
        ]);
        setInclusionNotice({
          item: updated,
          message: `已暂不采用“${updated.title}”`,
          canUndo: true,
        });
        window.requestAnimationFrame(() => excludedToggle.current?.focus());
      } else {
        const originalOrder = record.organizedItems.map((candidate) => candidate.id);

        setExcludedItems((current) =>
          current.filter((candidate) => candidate.id !== item.id),
        );
        setOrganizedItems((current) =>
          [...current.filter((candidate) => candidate.id !== item.id), updated]
            .sort(
              (left, right) =>
                originalOrder.indexOf(left.id) - originalOrder.indexOf(right.id),
            ),
        );
        setInclusionNotice({
          item: updated,
          message: `已恢复采用“${updated.title}”`,
          canUndo: false,
        });
        window.requestAnimationFrame(() =>
          correctionButtons.current.get(updated.id)?.focus(),
        );
      }
    } catch {
      setActionError(
        status === "excluded"
          ? "暂时无法将这条知识点设为不采用，请稍后重试。"
          : "暂时无法恢复这条知识点，请稍后重试。",
      );
    } finally {
      setInclusionBusyId(null);
    }
  }

  return (
    <main aria-label="记录详情" className="record-detail-main">
      <section aria-label="记录与原文" className="record-source-pane">
        <div className="record-heading-block">
          <p className="record-detail-index">记录 · 原文 v{record.editable.textVersion}</p>
          <h1>{record.presentation.title}</h1>
          {record.presentation.source !== "original" ? (
            <div className="record-presentation-meta">
              <span
                className={
                  record.presentation.source === "user_correction"
                    ? "is-user-correction"
                    : undefined
                }
              >
                {record.presentation.source === "user_correction"
                  ? "用户修正"
                  : "AI 生成"}
              </span>
              <button
                onClick={onOpenOverviewCorrection}
                ref={overviewCorrectionButton}
                type="button"
              >
                修正标题与摘要
              </button>
            </div>
          ) : null}
          <ul aria-label="我的标签" className="record-detail-tags">
            {record.editable.myTags.map((tag) => (
              <li key={tag.id}>{tag.name}</li>
            ))}
          </ul>
        </div>

        {record.presentation.summary ? (
          <section aria-labelledby="record-summary-title" className="record-summary">
            <h2 id="record-summary-title">摘要</h2>
            <p>{record.presentation.summary}</p>
          </section>
        ) : null}

        <div className="record-original">
          <div className="record-section-heading">
            <h2 id="record-original-title">完整原文</h2>
            <span aria-label="当前显示原文版本">
              v{historicalSource?.version ?? record.editable.textVersion}
            </span>
          </div>
          {historicalSource ? (
            <div
              aria-label="来源版本提示"
              className="record-source-lag"
              role="region"
            >
              <div>
                <strong role="status">
                  此知识点基于 v{historicalSource.version}，当前原文为 v
                  {record.editable.textVersion}
                </strong>
                <span>当前标题、摘要与标签保持不变。</span>
              </div>
              <div className="record-source-lag-actions">
                <button onClick={showCurrentSource} type="button">
                  返回当前原文
                </button>
                <button
                  disabled={
                    organizeLatestBusy ||
                    record.lifecycle === "archived" ||
                    Boolean(record.organization.candidate) ||
                    record.organization.activity === "queued" ||
                    record.organization.activity === "running"
                  }
                  onClick={() => void organizeLatestSource()}
                  type="button"
                >
                  {organizeLatestBusy ? "正在整理最新原文…" : "整理最新原文"}
                </button>
              </div>
            </div>
          ) : null}
          {evidenceLoadingVersion ? (
            <p className="record-source-loading" role="status">
              正在载入此知识点依据的原文 v{evidenceLoadingVersion}…
            </p>
          ) : null}
          {evidenceLoadError ? (
            <p className="record-source-error" role="alert">
              {evidenceLoadError}
            </p>
          ) : null}
          <pre aria-label="完整原文">
            <HighlightedSource
              evidence={selectedEvidence}
              sourceText={historicalSource?.text ?? record.editable.text}
            />
          </pre>
        </div>
      </section>

      <section aria-label="知识点" className="record-knowledge-pane">
        {record.organization.candidate ? (
          <VersionComparison
            busyDecision={candidateDecision}
            candidate={record.organization.candidate}
            currentItems={[...record.organizedItems, ...record.excludedItems]}
            currentPresentation={record.presentation}
            error={candidateError}
            onDecision={onCandidateDecision}
            onSelectItem={selectItem}
            selectedItemId={selectedItemId}
          />
        ) : (
          <>
            <header className="knowledge-pane-heading">
              <h2>知识点</h2>
              <span>{organizedItems.length}</span>
            </header>
            {actionError ? (
              <p className="knowledge-action-error" role="alert">
                {actionError}
              </p>
            ) : null}
            {organizedItems.length === 0 && excludedItems.length === 0 ? (
              <div className="knowledge-empty-state">
                <span aria-hidden="true" className="empty-signal">
                  <span />
                </span>
                <h3>尚未整理知识点</h3>
                <p>这条记录仅保存了完整原文，尚未产生 AI 整理结果。</p>
              </div>
            ) : null}
            <div
              aria-label="当前采用的知识点"
              className="knowledge-point-list"
              role="group"
            >
          {organizedItems.length === 0 && excludedItems.length > 0 ? (
            <p className="knowledge-current-empty">当前没有采用的知识点，可从下方恢复。</p>
          ) : null}
          {organizedItems.map((item) => {
              const selected = item.id === selectedItemId;
              const aiOriginalVisible = visibleAiOriginals.includes(item.id);

              return (
                <article
                  className={selected ? "knowledge-point is-selected" : "knowledge-point"}
                  key={item.id}
                >
                  <button
                    aria-label={`选择知识点：${item.title}`}
                    aria-pressed={selected}
                    className="knowledge-point-select"
                    onClick={() => void selectItem(item.id)}
                    type="button"
                  >
                    <span aria-hidden="true" />
                  </button>
                  <div className="knowledge-point-copy">
                    <div className="knowledge-point-meta">
                      <span>
                        <span aria-label="发布状态">
                          {publicationLabel(item.publicationStatus)}
                        </span>
                        {item.correction ? (
                          <span className="user-correction-label">用户修正</span>
                        ) : null}
                      </span>
                      <span aria-label="证据数量">
                        {item.evidenceCount} 条证据
                      </span>
                    </div>
                    <h3>{item.title}</h3>
                    <p aria-label="知识点正文">{item.body}</p>
                    <ul aria-label="AI 标签" className="knowledge-point-tags">
                      {item.tags.map((tag) => (
                        <li key={tag.id}>{tag.name}</li>
                      ))}
                    </ul>
                    {item.correction ? (
                      <div className="knowledge-point-ai-original">
                        <button
                          aria-expanded={aiOriginalVisible}
                          onClick={() =>
                            setVisibleAiOriginals((current) =>
                              aiOriginalVisible
                                ? current.filter((itemId) => itemId !== item.id)
                                : [...current, item.id],
                            )
                          }
                          type="button"
                        >
                          {aiOriginalVisible ? "收起 AI 原值" : "查看 AI 原值"}
                        </button>
                        {aiOriginalVisible ? (
                          <div aria-label="AI 原值" role="region">
                            <strong>{item.aiOriginal.title}</strong>
                            <p>{item.aiOriginal.body}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="knowledge-point-actions">
                      <button
                        onClick={() => void selectItem(item.id)}
                        type="button"
                      >
                        AI 原始内容的证据 · {item.evidenceCount} 条
                      </button>
                      <span aria-hidden="true" />
                      <button
                        onClick={() => setEditingItem(item)}
                        ref={(element) => {
                          if (element) {
                            correctionButtons.current.set(item.id, element);
                          } else {
                            correctionButtons.current.delete(item.id);
                          }
                        }}
                        type="button"
                      >
                        修正
                      </button>
                      {item.correction ? (
                        <button
                          onClick={() => void removeCorrection(item)}
                          type="button"
                        >
                          撤销修正
                        </button>
                      ) : null}
                      <button
                        disabled={inclusionBusyId === item.id}
                        onClick={() => void changeInclusion(item, "excluded")}
                        type="button"
                      >
                        暂不采用
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            </div>

            {excludedItems.length > 0 ? (
              <section className="excluded-knowledge">
            <button
              aria-expanded={excludedOpen}
              className="excluded-knowledge-toggle"
              onClick={() => setExcludedOpen((current) => !current)}
              ref={excludedToggle}
              type="button"
            >
              <span>已不采用 ({excludedItems.length})</span>
              <span aria-hidden="true">{excludedOpen ? "−" : "+"}</span>
            </button>
            {excludedOpen ? (
              <div
                aria-label="已不采用的知识点"
                className="excluded-knowledge-list"
                role="group"
              >
                {excludedItems.map((item) => (
                  <article className="knowledge-point is-excluded" key={item.id}>
                    <div className="knowledge-point-copy">
                      <div className="knowledge-point-meta">
                        <span aria-label="发布状态">
                          {publicationLabel(item.publicationStatus)}
                        </span>
                        <span>已不采用</span>
                      </div>
                      <h3>{item.title}</h3>
                      <p aria-label="知识点正文">{item.body}</p>
                      <div className="knowledge-point-actions">
                        <button
                          disabled={inclusionBusyId === item.id}
                          onClick={() => void changeInclusion(item, "included")}
                          type="button"
                        >
                          恢复采用
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
              </section>
            ) : null}
          </>
        )}
      </section>

      {editingItem ? (
        <KnowledgeCorrectionDialog
          item={editingItem}
          onClose={() => closeCorrection(editingItem.id)}
          onSave={(correction) => saveCorrection(editingItem, correction)}
        />
      ) : null}

      {inclusionNotice ? (
        <div
          aria-label="知识点采用状态"
          className="knowledge-inclusion-notice"
          role="status"
        >
          <span>{inclusionNotice.message}</span>
          {inclusionNotice.canUndo ? (
            <button
              disabled={inclusionBusyId === inclusionNotice.item.id}
              onClick={() =>
                void changeInclusion(inclusionNotice.item, "included")
              }
              type="button"
            >
              撤销
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function VersionComparison({
  busyDecision,
  candidate,
  currentItems,
  currentPresentation,
  error,
  onDecision,
  onSelectItem,
  selectedItemId,
}: {
  busyDecision: "adopt" | "discard" | null;
  candidate: OrganizationCandidate;
  currentItems: OrganizedItem[];
  currentPresentation: RecordDetail["presentation"];
  error: string;
  onDecision: (decision: "adopt" | "discard") => Promise<void>;
  onSelectItem: (itemId: string) => Promise<void>;
  selectedItemId: string | null;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const comparisons = compareOrganizationItems(
    currentItems,
    candidate.organizedItems,
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => heading.current?.focus());

    return () => window.cancelAnimationFrame(frame);
  }, [candidate.id]);

  return (
    <div aria-label="版本对照" className="version-comparison" role="region">
      <header className="version-comparison-heading">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            版本对照
          </h2>
          <p>
            {candidate.reason === "reanalysis"
              ? "同一份原文产生了新的整理候选，当前版本在采用前保持生效。"
              : `原文 v${candidate.sourceTextVersion} 产生了新的整理候选，当前版本在采用前保持生效。`}
          </p>
        </div>
        <span>整版决策</span>
      </header>

      <p className="version-comparison-summary" role="status">
        {organizationCountSummary(
          currentItems.length,
          candidate.organizedItems.length,
        )}
      </p>

      <div className="version-comparison-columns">
        <OrganizationVersion
          comparisons={comparisons}
          items={currentItems}
          label="当前生效版本"
          onSelectItem={onSelectItem}
          presentation={currentPresentation}
          selectedItemId={selectedItemId}
          version="current"
        />
        <OrganizationVersion
          comparisons={comparisons}
          items={candidate.organizedItems}
          label="候选版本"
          onSelectItem={onSelectItem}
          presentation={candidate.presentation}
          selectedItemId={selectedItemId}
          version="candidate"
        />
      </div>

      {error ? (
        <p className="version-comparison-error" role="alert">
          {error}
        </p>
      ) : null}

      <div
        aria-label="候选版本决策"
        className="version-comparison-decisions"
        role="group"
      >
        <p>决定会作用于完整候选版本，不会逐条混合发布。</p>
        <button
          className="secondary-button"
          disabled={Boolean(busyDecision)}
          onClick={() => void onDecision("discard")}
          type="button"
        >
          {busyDecision === "discard" ? "丢弃中…" : "丢弃新版本"}
        </button>
        <button
          className="primary-button"
          disabled={Boolean(busyDecision)}
          onClick={() => void onDecision("adopt")}
          type="button"
        >
          {busyDecision === "adopt" ? "采用中…" : "采用整个新版本"}
        </button>
      </div>
    </div>
  );
}

type OrganizationItemComparison = {
  current: OrganizedItem | undefined;
  candidate: OrganizedItem | undefined;
  kind: "unchanged" | "modified" | "added" | "removed";
  tagsChanged: boolean;
};

function compareOrganizationItems(
  currentItems: OrganizedItem[],
  candidateItems: OrganizedItem[],
): OrganizationItemComparison[] {
  return Array.from(
    { length: Math.max(currentItems.length, candidateItems.length) },
    (_, index) => {
      const current = currentItems[index];
      const candidate = candidateItems[index];

      if (!current) {
        return { current, candidate, kind: "added", tagsChanged: false };
      }

      if (!candidate) {
        return { current, candidate, kind: "removed", tagsChanged: false };
      }

      const tagsChanged = tagNames(current.tags) !== tagNames(candidate.tags);
      const contentChanged =
        current.title !== candidate.title || current.body !== candidate.body;

      return {
        current,
        candidate,
        kind: contentChanged || tagsChanged ? "modified" : "unchanged",
        tagsChanged,
      };
    },
  );
}

function tagNames(tags: OrganizedItem["tags"]): string {
  return tags
    .map((tag) => tag.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .join("\u0000");
}

function organizationCountSummary(currentCount: number, candidateCount: number): string {
  if (candidateCount > currentCount) {
    return `候选知识点由 ${currentCount} 条增至 ${candidateCount} 条，可能是拆分或新增，请结合两版内容核对。`;
  }

  if (candidateCount < currentCount) {
    return `候选知识点由 ${currentCount} 条减至 ${candidateCount} 条，可能是合并或删除，请结合两版内容核对。`;
  }

  return `两版均为 ${currentCount} 条知识点；“修改”只表示同一位置的内容或标签不同。`;
}

function OrganizationVersion({
  comparisons,
  items,
  label,
  onSelectItem,
  presentation,
  selectedItemId,
  version,
}: {
  comparisons: OrganizationItemComparison[];
  items: OrganizedItem[];
  label: "当前生效版本" | "候选版本";
  onSelectItem: (itemId: string) => Promise<void>;
  presentation: { title: string; summary: string | null };
  selectedItemId: string | null;
  version: "current" | "candidate";
}) {
  return (
    <section aria-label={label} className="organization-version" role="region">
      <header>
        <p>{label}</p>
        <h3>{presentation.title}</h3>
        <p className="organization-version-summary">
          {presentation.summary ?? "这一版没有摘要。"}
        </p>
      </header>

      <div className="organization-version-items">
        {items.map((item, index) => {
          const comparison = comparisons[index];
          const selected = selectedItemId === item.id;
          const kind = comparison?.kind ?? "unchanged";

          return (
            <article
              className={
                selected
                  ? "organization-version-item is-selected"
                  : "organization-version-item"
              }
              key={item.id}
            >
              <div className="organization-version-item-meta">
                <span>{index + 1}</span>
                {kind !== "unchanged" ? (
                  <span className={`version-change-label is-${kind}`}>
                    {versionChangeLabel(kind)}
                  </span>
                ) : (
                  <span className="version-change-label is-unchanged">未变化</span>
                )}
                {comparison?.tagsChanged ? (
                  <span className="version-tag-change">标签变化</span>
                ) : null}
                <span>{item.evidenceCount} 条证据</span>
              </div>
              <div className="organization-version-item-title">
                <h4>{item.title}</h4>
                <button
                  aria-label={`选择${label}知识点：${item.title}`}
                  aria-pressed={selected}
                  onClick={() => void onSelectItem(item.id)}
                  type="button"
                >
                  <span aria-hidden="true" />
                </button>
              </div>
              <p>{item.body}</p>
              <ul
                aria-label={`${version === "current" ? "当前" : "候选"}版本标签`}
                className="organization-version-tags"
              >
                {item.tags.map((tag) => (
                  <li key={tag.id}>{tag.name}</li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function versionChangeLabel(
  kind: OrganizationItemComparison["kind"],
): "未变化" | "修改" | "新增" | "删除" {
  if (kind === "modified") {
    return "修改";
  }

  if (kind === "added") {
    return "新增";
  }

  if (kind === "removed") {
    return "删除";
  }

  return "未变化";
}

function OverviewCorrectionDialog({
  onClose,
  onRemove,
  onSave,
  presentation,
}: {
  onClose: () => void;
  onRemove: () => Promise<void>;
  onSave: (correction: { title: string; summary: string }) => Promise<void>;
  presentation: RecordDetail["presentation"];
}) {
  const initialTitle = presentation.title;
  const initialSummary = presentation.summary ?? "";
  const aiOriginal = presentation.aiOriginal ?? {
    title: initialTitle,
    summary: initialSummary,
  };
  const [title, setTitle] = useState(initialTitle);
  const [summary, setSummary] = useState(initialSummary);
  const [operation, setOperation] = useState<"saving" | "removing" | null>(
    null,
  );
  const [actionError, setActionError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = title !== initialTitle || summary !== initialSummary;
  const canSave =
    title.trim().length > 0 &&
    summary.trim().length > 0 &&
    dirty &&
    operation === null;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (confirmDiscard) {
        discardDialogRef.current?.querySelector<HTMLElement>("button")?.focus();
      } else if (discardReturnFocus.current) {
        discardReturnFocus.current.focus();
        discardReturnFocus.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [confirmDiscard]);

  function requestClose() {
    if (operation) {
      return;
    }

    if (dirty) {
      discardReturnFocus.current = document.activeElement as HTMLElement | null;
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  async function save() {
    if (!canSave) {
      return;
    }

    setOperation("saving");
    setActionError("");

    try {
      await onSave({ title, summary });
    } catch {
      setActionError("修正暂时无法保存，输入内容仍保留在此处，请重试。");
      setOperation(null);
    }
  }

  async function remove() {
    if (operation) {
      return;
    }

    setOperation("removing");
    setActionError("");

    try {
      await onRemove();
    } catch {
      setActionError("暂时无法撤销修正，当前标题与摘要仍然保留。");
      setOperation(null);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();

      if (confirmDiscard) {
        setConfirmDiscard(false);
      } else {
        requestClose();
      }

      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusScope = confirmDiscard
      ? discardDialogRef.current
      : dialogRef.current;
    const focusable = [
      ...(focusScope?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].filter((element) => !element.hidden);
    const first = focusable[0];
    const last = focusable.at(-1);

    if (!first || !last) {
      event.preventDefault();
      focusScope?.focus();
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
    <div
      className="knowledge-correction-overlay overview-correction-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          requestClose();
        }
      }}
    >
      <div
        aria-labelledby="overview-correction-title"
        aria-modal="true"
        className="knowledge-correction-dialog overview-correction-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="overview-correction-title">修正标题与摘要</h2>
            <p>修正会作为用户认知叠加保存，不会改写 AI 原值或完整原文。</p>
          </div>
          <button
            aria-label="关闭标题与摘要修正"
            className="knowledge-correction-close"
            disabled={operation !== null}
            onClick={requestClose}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="knowledge-correction-body overview-correction-body">
          <fieldset>
            <legend className="visually-hidden">用户修正</legend>
            <label htmlFor="overview-correction-heading">记录标题</label>
            <input
              id="overview-correction-heading"
              onChange={(event) => setTitle(event.target.value)}
              ref={titleRef}
              value={title}
            />
            <label htmlFor="overview-correction-summary">记录摘要</label>
            <textarea
              id="overview-correction-summary"
              onChange={(event) => setSummary(event.target.value)}
              value={summary}
            />
          </fieldset>

          <aside aria-label="AI 原值" role="region">
            <p className="knowledge-correction-kicker">AI 原值</p>
            <h3>{aiOriginal.title}</h3>
            <p>{aiOriginal.summary}</p>
            <small>AI 原值保持不变；完整原文也不会因这次修正产生新版本。</small>
          </aside>
        </div>

        <footer>
          <p>
            {actionError ? (
              <span role="alert">{actionError}</span>
            ) : (
              "标题与摘要均按纯文本保存。"
            )}
          </p>
          <div>
            {presentation.source === "user_correction" ? (
              <button
                className="secondary-button overview-correction-remove"
                disabled={operation !== null}
                onClick={() => void remove()}
                type="button"
              >
                {operation === "removing" ? "撤销中…" : "撤销修正"}
              </button>
            ) : null}
            <button
              className="secondary-button"
              disabled={operation !== null}
              onClick={requestClose}
              type="button"
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={!canSave}
              onClick={() => void save()}
              type="button"
            >
              {operation === "saving" ? "保存中…" : "保存修正"}
            </button>
          </div>
        </footer>

        {confirmDiscard ? (
          <div
            aria-labelledby="overview-correction-discard-title"
            aria-modal="true"
            className="correction-discard-dialog"
            ref={discardDialogRef}
            role="alertdialog"
            tabIndex={-1}
          >
            <h3 id="overview-correction-discard-title">放弃未保存的修正？</h3>
            <p>关闭后，本次标题与摘要修改不会保留。</p>
            <div>
              <button onClick={() => setConfirmDiscard(false)} type="button">
                继续编辑
              </button>
              <button className="danger-button" onClick={onClose} type="button">
                放弃修正
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KnowledgeCorrectionDialog({
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  const discardReturnFocus = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = title !== item.title || body !== item.body;
  const canSave = title.trim().length > 0 && body.trim().length > 0 && dirty && !saving;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => titleRef.current?.focus());

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (confirmDiscard) {
        discardDialogRef.current?.querySelector<HTMLElement>("button")?.focus();
      } else if (discardReturnFocus.current) {
        discardReturnFocus.current.focus();
        discardReturnFocus.current = null;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [confirmDiscard]);

  function requestClose() {
    if (dirty) {
      discardReturnFocus.current = document.activeElement as HTMLElement | null;
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  async function save() {
    if (!canSave) {
      return;
    }

    setSaving(true);
    setSaveError("");

    try {
      await onSave({ title, body });
    } catch {
      setSaveError("修正暂时无法保存，输入内容仍保留在此处，请重试。");
      setSaving(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();

      if (confirmDiscard) {
        setConfirmDiscard(false);
      } else {
        requestClose();
      }

      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusScope = confirmDiscard ? discardDialogRef.current : dialogRef.current;
    const focusable = [...(focusScope?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hidden);
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
    <div
      className="knowledge-correction-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          requestClose();
        }
      }}
    >
      <div
        aria-labelledby="knowledge-correction-title"
        aria-modal="true"
        className="knowledge-correction-dialog"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="knowledge-correction-title">修正知识点</h2>
            <p>修正内容作为用户认知保存，不会改写 AI 原值或原文。</p>
          </div>
          <button
            aria-label="关闭修正知识点"
            className="knowledge-correction-close"
            onClick={requestClose}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="knowledge-correction-body">
          <fieldset>
            <legend className="visually-hidden">用户修正</legend>
            <label htmlFor="knowledge-correction-heading">知识点标题</label>
            <input
              id="knowledge-correction-heading"
              onChange={(event) => setTitle(event.target.value)}
              ref={titleRef}
              value={title}
            />
            <label htmlFor="knowledge-correction-copy">知识点正文</label>
            <textarea
              id="knowledge-correction-copy"
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />
          </fieldset>

          <aside aria-label="AI 原值" role="region">
            <p className="knowledge-correction-kicker">AI 原值</p>
            <h3>{item.aiOriginal.title}</h3>
            <p>{item.aiOriginal.body}</p>
            <small>Evidence Span 只核验这份 AI 原始内容，不为用户补充背书。</small>
          </aside>
        </div>

        <footer>
          <p>{saveError ? <span role="alert">{saveError}</span> : "标题与正文均按纯文本保存。"}</p>
          <div>
            <button className="secondary-button" onClick={requestClose} type="button">
              取消
            </button>
            <button
              className="primary-button"
              disabled={!canSave}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "保存中…" : "保存修正"}
            </button>
          </div>
        </footer>

        {confirmDiscard ? (
          <div
            aria-labelledby="correction-discard-title"
            aria-modal="true"
            className="correction-discard-dialog"
            ref={discardDialogRef}
            role="alertdialog"
          >
            <h3 id="correction-discard-title">放弃未保存的修正？</h3>
            <p>关闭后，本次标题和正文修改不会保留。</p>
            <div>
              <button onClick={() => setConfirmDiscard(false)} type="button">
                继续编辑
              </button>
              <button className="danger-button" onClick={onClose} type="button">
                放弃修正
              </button>
            </div>
          </div>
        ) : null}
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

function publicationLabel(status: string): string {
  if (status === "AUTO_PUBLISHED") {
    return "AI 自动发布";
  }

  if (status === "CONFIRMED") {
    return "已确认";
  }

  if (status === "PENDING_REVIEW") {
    return "待审查";
  }

  return "未采用";
}
