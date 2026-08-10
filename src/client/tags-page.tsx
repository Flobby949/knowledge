/*
 * THESIS: The atlas is a compact linguistic index, not a field of repeated decorative orbs.
 * OWN-WORLD: Equal paper cards, sharp typographic counts, and one 480px inspection drawer.
 * STORY: The user scans the vocabulary, selects one term, and manages its record-level footprint in place.
 * FIRST VIEWPORT: 60px navigation, five equal card columns, then a non-modal push drawer on selection.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  approveCandidateTag,
  createTag,
  deleteCandidateTag,
  deleteCandidateTags,
  getTagDetail,
  listTags,
  putTagKnowledgePointVisibility,
  updateTag,
  type TagDetail,
  type TagListItem,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./tags-page.css";

type TagSection = "candidate" | "user_approved";
type TagSort = "name_asc" | "name_desc" | "record_count_desc";

export function TagsPage() {
  const [section, setSection] = useState<TagSection>("user_approved");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TagSort>("name_asc");
  const [tags, setTags] = useState<TagListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [selectedTag, setSelectedTag] = useState<TagListItem | null>(null);
  const [detail, setDetail] = useState<TagDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [pageNotice, setPageNotice] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchDeleteConfirming, setBatchDeleteConfirming] = useState(false);
  const [batchDeleteError, setBatchDeleteError] = useState("");
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagError, setNewTagError] = useState("");
  const [newTagBusy, setNewTagBusy] = useState(false);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const newTagButton = useRef<HTMLButtonElement>(null);
  const newTagInput = useRef<HTMLInputElement>(null);
  const approvedTab = useRef<HTMLButtonElement>(null);
  const candidateTab = useRef<HTMLButtonElement>(null);
  const batchDeleteButton = useRef<HTMLButtonElement>(null);
  const batchConfirmButton = useRef<HTMLButtonElement>(null);
  const detailRequest = useRef(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    setListLoading(true);
    setLoadError("");
    void listTags({
      approval: section,
      query,
      sort,
      signal: controller.signal,
    })
      .then((items) => {
        if (active) {
          setTags(items);
          setSelectedCandidateIds((current) => {
            const availableIds = new Set(items.map(({ id }) => id));
            const next = new Set(
              [...current].filter((id) => availableIds.has(id)),
            );

            return next.size === current.size ? current : next;
          });
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setLoadError("标签图鉴暂时无法载入，请重试。");
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
  }, [query, reloadVersion, section, sort]);

  useEffect(() => {
    if (!selectedTag) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedTag]);

  function changeSection(next: TagSection) {
    if (next === section) {
      return;
    }

    detailRequest.current += 1;
    setSection(next);
    setTags([]);
    setListLoading(true);
    setSelectedTag(null);
    setDetail(null);
    setDrawerError("");
    setActionError("");
    setActionNotice("");
    setPageNotice("");
    resetBatchSelection();
  }

  function resetBatchSelection() {
    setSelectedCandidateIds(new Set());
    setBatchDeleteConfirming(false);
    setBatchDeleteError("");
  }

  function changeQuery(next: string) {
    resetBatchSelection();
    setQuery(next);
  }

  function changeSort(next: TagSort) {
    resetBatchSelection();
    setSort(next);
  }

  function toggleCandidateSelection(tagId: string) {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);

      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }

      return next;
    });
    setBatchDeleteConfirming(false);
    setBatchDeleteError("");
    setPageNotice("");
  }

  function selectZeroAssociationCandidates() {
    setSelectedCandidateIds(
      new Set(tags.filter(({ recordCount }) => recordCount === 0).map(({ id }) => id)),
    );
    setBatchDeleteConfirming(false);
    setBatchDeleteError("");
    setPageNotice("");
  }

  function beginBatchDelete() {
    if (selectedCandidateIds.size === 0) {
      return;
    }

    setBatchDeleteConfirming(true);
    setBatchDeleteError("");
    window.requestAnimationFrame(() => batchConfirmButton.current?.focus());
  }

  function cancelBatchDelete() {
    setBatchDeleteConfirming(false);
    setBatchDeleteError("");
    window.requestAnimationFrame(() => batchDeleteButton.current?.focus());
  }

  function selectTag(tag: TagListItem) {
    const requestId = detailRequest.current + 1;

    detailRequest.current = requestId;
    setSelectedTag(tag);
    setDetail(null);
    setDrawerLoading(true);
    setDrawerError("");
    setActionError("");
    setActionNotice("");

    void getTagDetail(tag.id)
      .then((nextDetail) => {
        if (detailRequest.current === requestId) {
          setDetail(nextDetail);
          setSelectedTag(nextDetail.tag);
        }
      })
      .catch(() => {
        if (detailRequest.current === requestId) {
          setDrawerError("标签详情暂时无法载入，请重新选择。");
        }
      })
      .finally(() => {
        if (detailRequest.current === requestId) {
          setDrawerLoading(false);
        }
      });
  }

  function closeDrawer(returnFocus: boolean) {
    const previousTagId = selectedTag?.id;

    detailRequest.current += 1;
    setSelectedTag(null);
    setDetail(null);
    setDrawerLoading(false);
    setDrawerError("");
    setActionError("");
    setActionNotice("");

    if (returnFocus) {
      window.requestAnimationFrame(() => {
        const card = previousTagId
          ? document.querySelector<HTMLElement>(
              `[data-tag-id="${previousTagId}"]`,
            )
          : null;

        (card ?? (section === "candidate" ? candidateTab.current : approvedTab.current))
          ?.focus();
      });
    }
  }

  async function refreshSelected(tagId: string): Promise<TagDetail> {
    const nextDetail = await getTagDetail(tagId);

    if (selectedTag?.id === tagId) {
      setDetail(nextDetail);
      setSelectedTag(nextDetail.tag);
    }

    return nextDetail;
  }

  async function handleVisibility(
    recordId: string,
    itemId: string,
    status: "active" | "suppressed",
  ) {
    if (!selectedTag) {
      return;
    }

    setActionBusy(`item:${itemId}`);
    setActionError("");
    setActionNotice("");

    try {
      await putTagKnowledgePointVisibility(
        selectedTag.id,
        recordId,
        itemId,
        status,
      );
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice(
        status === "active" ? "标签关联已恢复。" : "标签关联已屏蔽。",
      );
    } catch (error) {
      setActionError(tagActionMessage(error, "标签关联未能更新，请重试。"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleApprove() {
    if (!selectedTag) {
      return;
    }

    setActionBusy("approve");
    setActionError("");
    setActionNotice("");

    try {
      await approveCandidateTag(selectedTag.id);
      const nextDetail = await refreshSelected(selectedTag.id);

      setSelectedTag(nextDetail.tag);
      setDetail(nextDetail);
      setTags([]);
      setListLoading(true);
      setSection("user_approved");
      resetBatchSelection();
      setReloadVersion((current) => current + 1);
      setActionNotice("已认可为“我的标签”，历史关联保持不变。");
    } catch (error) {
      setActionError(tagActionMessage(error, "候选标签未能认可，请重试。"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleRename(name: string): Promise<boolean> {
    if (!selectedTag) {
      return false;
    }

    setActionBusy("rename");
    setActionError("");
    setActionNotice("");

    try {
      await updateTag(selectedTag.id, { name });
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice("标签名称已更新。");
      return true;
    } catch (error) {
      setActionError(tagActionMessage(error, "标签未能改名，请重试。"));
      return false;
    } finally {
      setActionBusy("");
    }
  }

  async function handleArchiveStatus(
    approvalStatus: "archived" | "user_approved",
  ) {
    if (!selectedTag) {
      return;
    }

    setActionBusy("archive");
    setActionError("");
    setActionNotice("");

    try {
      await updateTag(selectedTag.id, { approvalStatus });
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice(
        approvalStatus === "archived"
          ? "标签已归档；历史关联仍然保留，可在此立即恢复。"
          : "标签已恢复到“我的标签”。",
      );
    } catch (error) {
      setActionError(
        tagActionMessage(
          error,
          approvalStatus === "archived"
            ? "标签未能归档，请重试。"
            : "标签未能恢复，请重试。",
        ),
      );
    } finally {
      setActionBusy("");
    }
  }

  async function handleDeleteCandidate() {
    if (!selectedTag) {
      return;
    }

    const deletedName = selectedTag.name;

    setActionBusy("delete");
    setActionError("");
    setActionNotice("");

    try {
      await deleteCandidateTag(selectedTag.id);
      setSelectedCandidateIds((current) => {
        const next = new Set(current);

        next.delete(selectedTag.id);
        return next;
      });
      setBatchDeleteConfirming(false);
      setBatchDeleteError("");
      closeDrawer(false);
      setReloadVersion((current) => current + 1);
      setPageNotice(`AI 候选“${deletedName}”及其候选关联已删除。`);
      window.requestAnimationFrame(() => candidateTab.current?.focus());
    } catch (error) {
      setActionError(tagActionMessage(error, "AI 候选未能删除，请重试。"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleBatchDeleteCandidates() {
    const tagIds = [...selectedCandidateIds];

    if (tagIds.length === 0) {
      return;
    }

    setActionBusy("batch-delete");
    setActionError("");
    setBatchDeleteError("");
    setPageNotice("");

    try {
      const deletedCount = await deleteCandidateTags(tagIds);

      if (selectedTag && selectedCandidateIds.has(selectedTag.id)) {
        closeDrawer(false);
      }

      setTags((current) => current.filter(({ id }) => !selectedCandidateIds.has(id)));
      resetBatchSelection();
      setReloadVersion((current) => current + 1);
      setPageNotice(
        `已清理 ${deletedCount} 个 AI 候选标签及其候选关联。`,
      );
      window.requestAnimationFrame(() => candidateTab.current?.focus());
    } catch (error) {
      setBatchDeleteError(
        tagActionMessage(error, "AI 候选未能批量清理，请刷新后重试。"),
      );
    } finally {
      setActionBusy("");
    }
  }

  async function handleCreateTag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newTagName.trim();

    if (!name) {
      setNewTagError("请输入标签名称。");
      newTagInput.current?.focus();
      return;
    }

    setNewTagBusy(true);
    setNewTagError("");
    setPageNotice("");

    try {
      const created = await createTag(name);

      setNewTagOpen(false);
      setNewTagName("");
      if (section !== "user_approved") {
        setTags([]);
        setListLoading(true);
      }
      setSection("user_approved");
      setQuery(created.name);
      setSort("name_asc");
      setReloadVersion((current) => current + 1);
      setPageNotice(`已创建“我的标签”${created.name}。`);
      selectTag(created);
    } catch (error) {
      setNewTagError(tagActionMessage(error, "标签未能创建，请重试。"));
    } finally {
      setNewTagBusy(false);
    }
  }

  function closeNewTagForm() {
    setNewTagOpen(false);
    setNewTagName("");
    setNewTagError("");
    window.requestAnimationFrame(() => newTagButton.current?.focus());
  }

  function handleSaved() {
    setNewRecordOpen(false);
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  const sectionLabel = section === "user_approved" ? "我的标签" : "AI 候选";
  const zeroAssociationCandidates = tags.filter(
    ({ recordCount }) => recordCount === 0,
  );
  const selectedCandidates = tags.filter(({ id }) =>
    selectedCandidateIds.has(id),
  );
  const selectedLinkedCount = selectedCandidates.filter(
    ({ recordCount }) => recordCount > 0,
  ).length;

  return (
    <div className="tags-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <div className={selectedTag ? "tags-layout drawer-open" : "tags-layout"}>
        <main aria-label="标签图鉴" className="tag-atlas-main">
          <header className="tag-atlas-heading">
            <div>
              <p>VOCABULARY INDEX</p>
              <h1>标签图鉴</h1>
            </div>
            <div className="tag-atlas-heading-actions">
              <span>{tags.length} 个{sectionLabel}</span>
              <button
                className="secondary-button"
                onClick={() => {
                  setNewTagOpen(true);
                  setNewTagError("");
                  window.requestAnimationFrame(() => newTagInput.current?.focus());
                }}
                ref={newTagButton}
                type="button"
              >
                新建标签
              </button>
            </div>
          </header>

          <section aria-label="标签浏览工具" className="tag-atlas-toolbar">
            <div aria-label="标签分区" className="tag-section-tabs" role="tablist">
              <button
                aria-controls="tag-atlas-panel"
                aria-selected={section === "user_approved"}
                id="approved-tags-tab"
                onClick={() => changeSection("user_approved")}
                ref={approvedTab}
                role="tab"
                type="button"
              >
                我的标签
              </button>
              <button
                aria-controls="tag-atlas-panel"
                aria-selected={section === "candidate"}
                id="candidate-tags-tab"
                onClick={() => changeSection("candidate")}
                ref={candidateTab}
                role="tab"
                type="button"
              >
                AI 候选
              </button>
            </div>

            <label className="tag-search-control">
              <span className="visually-hidden">搜索标签</span>
              <span aria-hidden="true" className="search-icon" />
              <input
                aria-label="搜索标签"
                onChange={(event) => changeQuery(event.target.value)}
                placeholder={`搜索${sectionLabel}`}
                type="search"
                value={query}
              />
            </label>

            <label className="tag-sort-control">
              <span>排序</span>
              <select
                aria-label="标签排序"
                onChange={(event) => changeSort(event.target.value as TagSort)}
                value={sort}
              >
                <option value="name_asc">名称 A–Z</option>
                <option value="name_desc">名称 Z–A</option>
                <option value="record_count_desc">关联记录最多</option>
              </select>
            </label>
          </section>

          {newTagOpen ? (
            <form
              aria-label="新建标签"
              className="new-tag-form"
              onSubmit={(event) => void handleCreateTag(event)}
            >
              <div>
                <label htmlFor="new-tag-name">标签名称</label>
                <p>新标签会加入“我的标签”，即使暂时没有关联记录也会保留。</p>
              </div>
              <input
                aria-describedby={newTagError ? "new-tag-error" : undefined}
                id="new-tag-name"
                onChange={(event) => setNewTagName(event.target.value)}
                ref={newTagInput}
                type="text"
                value={newTagName}
              />
              <button disabled={newTagBusy} className="primary-button" type="submit">
                {newTagBusy ? "创建中…" : "创建标签"}
              </button>
              <button
                disabled={newTagBusy}
                onClick={closeNewTagForm}
                type="button"
              >
                取消
              </button>
              {newTagError ? (
                <p id="new-tag-error" role="alert">{newTagError}</p>
              ) : null}
            </form>
          ) : null}

          {pageNotice ? (
            <p aria-label="标签操作结果" className="tag-page-notice" role="status">
              {pageNotice}
            </p>
          ) : null}

          {section === "candidate" ? (
            <section
              aria-label="批量清理 AI 候选"
              className={
                batchDeleteConfirming
                  ? "tag-batch-toolbar is-confirming"
                  : "tag-batch-toolbar"
              }
            >
              {batchDeleteConfirming ? (
                <div
                  aria-label="确认批量清理"
                  className="tag-batch-confirmation"
                  role="group"
                >
                  <div>
                    <strong>
                      确认清理 {selectedCandidateIds.size} 个 AI 候选？
                    </strong>
                    <span>
                      {selectedLinkedCount > 0
                        ? `其中 ${selectedLinkedCount} 个仍有有效记录关联，相关 AI 标签关联也会一并移除。此操作无法撤销。`
                        : "这些标签当前均无有效记录关联。此操作无法撤销。"}
                    </span>
                  </div>
                  <div>
                    <button
                      className="danger-button"
                      disabled={actionBusy === "batch-delete"}
                      onClick={() => void handleBatchDeleteCandidates()}
                      ref={batchConfirmButton}
                      type="button"
                    >
                      {actionBusy === "batch-delete" ? "清理中…" : "确认清理"}
                    </button>
                    <button
                      disabled={actionBusy === "batch-delete"}
                      onClick={cancelBatchDelete}
                      type="button"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tag-batch-row">
                  <div className="tag-batch-summary">
                    <strong>批量清理</strong>
                    <span role="status">
                      {selectedCandidateIds.size > 0
                        ? `已选 ${selectedCandidateIds.size} 个候选`
                        : "勾选候选，或快速选择无关联标签"}
                    </span>
                  </div>
                  <div className="tag-batch-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        listLoading ||
                        Boolean(loadError) ||
                        Boolean(actionBusy) ||
                        zeroAssociationCandidates.length === 0
                      }
                      onClick={selectZeroAssociationCandidates}
                      type="button"
                    >
                      {query ? "选中当前结果的" : "选中全部"} 0 关联（
                      {zeroAssociationCandidates.length}）
                    </button>
                    {selectedCandidateIds.size > 0 ? (
                      <button
                        disabled={Boolean(actionBusy)}
                        onClick={resetBatchSelection}
                        type="button"
                      >
                        清空选择
                      </button>
                    ) : null}
                    <button
                      className="danger-link"
                      disabled={
                        selectedCandidateIds.size === 0 || Boolean(actionBusy)
                      }
                      onClick={beginBatchDelete}
                      ref={batchDeleteButton}
                      type="button"
                    >
                      清理已选
                      {selectedCandidateIds.size > 0
                        ? `（${selectedCandidateIds.size}）`
                        : ""}
                    </button>
                  </div>
                </div>
              )}

              {batchDeleteError ? (
                <p className="tag-batch-error" role="alert">
                  {batchDeleteError}
                </p>
              ) : null}
            </section>
          ) : null}

          <div
            aria-labelledby={
              section === "user_approved" ? "approved-tags-tab" : "candidate-tags-tab"
            }
            id="tag-atlas-panel"
            role="tabpanel"
          >
            {loadError ? (
              <div className="tag-atlas-error" role="alert">
                <span>{loadError}</span>
                <button
                  onClick={() => setReloadVersion((current) => current + 1)}
                  type="button"
                >
                  重试
                </button>
              </div>
            ) : null}

            {listLoading ? <p className="tag-atlas-feedback" role="status">正在载入{sectionLabel}…</p> : null}

            <ul
              aria-busy={actionBusy === "batch-delete"}
              aria-label="标签图鉴"
              className="tag-atlas-grid"
            >
              {tags.map((tag, index) => (
                <li
                  className={
                    selectedCandidateIds.has(tag.id) ? "is-batch-selected" : undefined
                  }
                  key={tag.id}
                >
                  {tag.approvalStatus === "candidate" ? (
                    <label className="tag-card-selection">
                      <input
                        aria-label={`选择 ${tag.name}`}
                        checked={selectedCandidateIds.has(tag.id)}
                        disabled={Boolean(actionBusy)}
                        onChange={() => toggleCandidateSelection(tag.id)}
                        type="checkbox"
                      />
                    </label>
                  ) : null}
                  <button
                    aria-label={tag.name}
                    aria-pressed={selectedTag?.id === tag.id}
                    className={
                      tag.approvalStatus === "candidate"
                        ? "has-selection-control"
                        : undefined
                    }
                    data-tag-id={tag.id}
                    disabled={actionBusy === "batch-delete"}
                    onClick={() => selectTag(tag)}
                    type="button"
                  >
                    <span className="tag-atlas-index">
                      T{String(index + 1).padStart(3, "0")}
                    </span>
                    {tag.approvalStatus === "candidate" ? (
                      <span className="tag-atlas-state">AI 候选</span>
                    ) : null}
                    <strong>{tag.name}</strong>
                    <span className="tag-atlas-count">{tag.recordCount} 条记录</span>
                  </button>
                </li>
              ))}
            </ul>

            {!listLoading && !loadError && tags.length === 0 ? (
              <div className="tag-atlas-empty" role="status">
                <strong>{query ? "没有匹配的标签" : `还没有${sectionLabel}`}</strong>
                <span>{query ? "请调整搜索词。" : section === "candidate" ? "AI 整理产生的候选会显示在这里。" : "创建第一个标签，开始整理你的词表。"}</span>
              </div>
            ) : null}
          </div>
        </main>

        {selectedTag ? (
          <TagDetailDrawer
            actionBusy={actionBusy}
            actionError={actionError}
            actionNotice={actionNotice}
            detail={detail}
            error={drawerError}
            loading={drawerLoading}
            onApprove={() => void handleApprove()}
            onArchiveStatus={(status) => void handleArchiveStatus(status)}
            onClose={() => closeDrawer(true)}
            onDelete={() => void handleDeleteCandidate()}
            onRename={handleRename}
            onVisibility={(recordId, itemId, status) =>
              void handleVisibility(recordId, itemId, status)
            }
            tag={selectedTag}
          />
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

function TagDetailDrawer({
  actionBusy,
  actionError,
  actionNotice,
  detail,
  error,
  loading,
  onApprove,
  onArchiveStatus,
  onClose,
  onDelete,
  onRename,
  onVisibility,
  tag,
}: {
  actionBusy: string;
  actionError: string;
  actionNotice: string;
  detail: TagDetail | null;
  error: string;
  loading: boolean;
  onApprove: () => void;
  onArchiveStatus: (status: "archived" | "user_approved") => void;
  onClose: () => void;
  onDelete: () => void;
  onRename: (name: string) => Promise<boolean>;
  onVisibility: (
    recordId: string,
    itemId: string,
    status: "active" | "suppressed",
  ) => void;
  tag: TagListItem;
}) {
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(tag.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpandedRecords(new Set());
    setRenaming(false);
    setRenameValue(tag.name);
    setConfirmDelete(false);
  }, [tag.id]);

  function toggleRecord(recordId: string) {
    setExpandedRecords((current) => {
      const next = new Set(current);

      if (next.has(recordId)) {
        next.delete(recordId);
      } else {
        next.add(recordId);
      }

      return next;
    });
  }

  async function submitRename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameValue.trim();

    if (!name) {
      renameInput.current?.focus();
      return;
    }

    if (await onRename(name)) {
      setRenaming(false);
    }
  }

  const records = detail?.records ?? [];
  const candidate = tag.approvalStatus === "candidate";
  const archived = tag.approvalStatus === "archived";

  return (
    <aside aria-label="标签详情" className="tag-detail-drawer" role="region">
      <header>
        <div>
          <p>{candidate ? "AI 候选" : archived ? "已归档标签" : "我的标签"}</p>
          <button aria-label="关闭标签详情" onClick={onClose} type="button">×</button>
        </div>
        <h2>{tag.name}</h2>
        <span>{tag.recordCount} 条当前有效关联记录 · {tagOriginLabel(tag)}</span>
      </header>

      <section aria-labelledby="tag-records-title" className="tag-related-records">
        <div className="tag-related-heading">
          <h3 id="tag-records-title">关联记录</h3>
          <span>每条记录仅显示一次</span>
        </div>

        {loading ? <p className="tag-drawer-feedback" role="status">正在载入关联来源…</p> : null}
        {error ? <p className="tag-drawer-feedback is-error" role="alert">{error}</p> : null}
        {!loading && !error && records.length === 0 ? (
          <p className="tag-drawer-feedback" role="status">当前没有可管理的记录关联。</p>
        ) : null}

        <ul aria-label="关联记录">
          {records.map((item) => {
            const expanded = expandedRecords.has(item.record.id);
            const suppressedCount = item.knowledgePoints.filter(
              (point) => point.suppressed,
            ).length;

            return (
              <li data-record-id={item.record.id} key={item.record.id}>
                <div className="tag-record-summary">
                  <div>
                    <Link to={`/records/${item.record.id}`}>
                      <strong>{item.record.title}</strong>
                    </Link>
                    <p>{sourceSummary(item.sourceSummary, suppressedCount)}</p>
                  </div>
                  {item.knowledgePoints.length > 0 ? (
                    <button
                      aria-expanded={expanded}
                      onClick={() => toggleRecord(item.record.id)}
                      type="button"
                    >
                      {expanded ? "收起关联来源" : "展开关联来源"}
                    </button>
                  ) : null}
                </div>

                {expanded ? (
                  <div aria-label={`${item.record.title}的知识点关联`} className="tag-point-list">
                    {item.knowledgePoints.map((point) => {
                      const busy = actionBusy === `item:${point.id}`;

                      return (
                        <div aria-label={point.title} key={point.id} role="group">
                          <div>
                            <strong>{point.title}</strong>
                            <span>{point.suppressed ? "已屏蔽" : "当前生效"}</span>
                          </div>
                          <button
                            disabled={busy}
                            onClick={() =>
                              onVisibility(
                                item.record.id,
                                point.id,
                                point.suppressed ? "active" : "suppressed",
                              )
                            }
                            type="button"
                          >
                            {busy
                              ? "更新中…"
                              : point.suppressed
                                ? "恢复此标签关联"
                                : "屏蔽此标签关联"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <footer>
        {actionError ? <p className="tag-action-message is-error" role="alert">{actionError}</p> : null}
        {actionNotice ? <p className="tag-action-message" role="status">{actionNotice}</p> : null}

        {renaming ? (
          <form aria-label="改名标签" className="tag-rename-form" onSubmit={(event) => void submitRename(event)}>
            <label htmlFor="rename-tag-input">标签名称</label>
            <input
              id="rename-tag-input"
              onChange={(event) => setRenameValue(event.target.value)}
              ref={renameInput}
              type="text"
              value={renameValue}
            />
            <div>
              <button className="primary-button" disabled={actionBusy === "rename"} type="submit">
                {actionBusy === "rename" ? "保存中…" : "保存名称"}
              </button>
              <button disabled={actionBusy === "rename"} onClick={() => setRenaming(false)} type="button">取消</button>
            </div>
          </form>
        ) : candidate ? (
          confirmDelete ? (
            <div className="tag-delete-confirmation" role="group" aria-label="确认删除候选">
              <p>删除会移除这个候选及其 AI 标签关联，无法撤销。</p>
              <div>
                <button className="danger-button" disabled={actionBusy === "delete"} onClick={onDelete} type="button">
                  {actionBusy === "delete" ? "删除中…" : "确认删除候选"}
                </button>
                <button disabled={actionBusy === "delete"} onClick={() => setConfirmDelete(false)} type="button">取消</button>
              </div>
            </div>
          ) : (
            <div className="tag-drawer-actions">
              <p>认可后复用同一标签身份，已有 AI 关联不会被改写为手动关联。</p>
              <div>
                <button className="primary-button" disabled={Boolean(actionBusy)} onClick={onApprove} type="button">
                  {actionBusy === "approve" ? "认可中…" : "认可为我的标签"}
                </button>
                <button className="danger-link" disabled={Boolean(actionBusy)} onClick={() => setConfirmDelete(true)} type="button">删除候选</button>
              </div>
            </div>
          )
        ) : (
          <div className="tag-drawer-actions">
            <p>{archived ? "恢复后标签会重新出现在日常选择中，历史关联保持不变。" : "归档后从日常选择中隐藏，历史关联仍会保留。"}</p>
            <div>
              {!archived ? (
                <button disabled={Boolean(actionBusy)} onClick={() => {
                  setRenaming(true);
                  setRenameValue(tag.name);
                  window.requestAnimationFrame(() => renameInput.current?.focus());
                }} type="button">改名</button>
              ) : null}
              <button
                className="secondary-button"
                disabled={Boolean(actionBusy)}
                onClick={() => onArchiveStatus(archived ? "user_approved" : "archived")}
                type="button"
              >
                {actionBusy === "archive" ? "更新中…" : archived ? "恢复标签" : "归档标签"}
              </button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  );
}

function sourceSummary(
  summary: { fromMyTags: boolean; activeKnowledgePointCount: number },
  suppressedCount: number,
): string {
  const sources: string[] = [];

  if (summary.fromMyTags) {
    sources.push("“我的标签”");
  }

  if (summary.activeKnowledgePointCount > 0) {
    sources.push(
      suppressedCount > 0
        ? `${summary.activeKnowledgePointCount} 个生效 AI 知识点`
        : `${summary.activeKnowledgePointCount} 个 AI 知识点`,
    );
  }

  if (suppressedCount > 0) {
    sources.push(`${suppressedCount} 个已屏蔽关联`);
  }

  return sources.length > 0 ? `来自 ${sources.join(" · ")}` : "当前没有生效来源";
}

function tagOriginLabel(tag: TagListItem): string {
  return tag.origin === "user_created" ? "由你创建" : "由 AI 推荐";
}

function tagActionMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
