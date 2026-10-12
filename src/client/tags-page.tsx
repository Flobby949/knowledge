/*
 * THESIS: The atlas is a compact linguistic index, not a field of repeated decorative orbs.
 * OWN-WORLD: Equal theme-responsive paper cards, sharp typographic counts, and one 480px inspection drawer.
 * STORY: The user scans the vocabulary, selects one term, and manages its record-level footprint in place.
 * FIRST VIEWPORT: 60px navigation, five equal card columns, then a non-modal push drawer on selection.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import {
  approveCandidateTag,
  createTagAlias,
  createTag,
  deleteCandidateTag,
  deleteCandidateTags,
  deleteTagAlias,
  getTagDetail,
  listTags,
  mergeTags,
  putTagKnowledgePointVisibility,
  undoTagMerge,
  updateTag,
  type TagDetail,
  type TagListItem,
} from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import { tagAncestorLabel, tagPathLabel } from "./tag-path.js";
import "./tags-page.css";

type TagSection = "candidate" | "user_approved";
type TagSort = "name_asc" | "name_desc" | "record_count_desc";

const MAX_TAG_DEPTH = 5;

export function TagsPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedLevelId = searchParams.get("level");
  const [section, setSection] = useState<TagSection>("user_approved");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TagSort>("name_asc");
  const [tags, setTags] = useState<TagListItem[]>([]);
  const [hierarchyTags, setHierarchyTags] = useState<TagListItem[]>([]);
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
  const [selectedApprovedIds, setSelectedApprovedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchDeleteConfirming, setBatchDeleteConfirming] = useState(false);
  const [batchDeleteError, setBatchDeleteError] = useState("");
  const [batchMergeConfirming, setBatchMergeConfirming] = useState(false);
  const [batchMergeError, setBatchMergeError] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
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
  const batchMergeButton = useRef<HTMLButtonElement>(null);
  const batchMergeConfirmButton = useRef<HTMLButtonElement>(null);
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
          setSelectedApprovedIds((current) => {
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

  // The complete approved vocabulary feeds the move and approval pickers even
  // while the atlas itself shows search results or AI candidates.
  useEffect(() => {
    const controller = new AbortController();

    void listTags({
      approval: "user_approved",
      query: "",
      sort: "name_asc",
      signal: controller.signal,
    })
      .then(setHierarchyTags)
      .catch(() => undefined);

    return () => controller.abort();
  }, [reloadVersion]);

  useEffect(() => {
    setQuery("");
  }, [location.key]);

  // "我的标签" is browsed one level at a time; searching flattens every level.
  const browsingLevels = section === "user_approved" && query === "";
  const levelTag =
    browsingLevels && requestedLevelId
      ? (tags.find(({ id }) => id === requestedLevelId) ?? null)
      : null;
  const visibleTags = browsingLevels
    ? tags.filter((tag) => tag.parentId === (levelTag?.id ?? null))
    : tags;

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
    setSelectedApprovedIds(new Set());
    setBatchDeleteConfirming(false);
    setBatchDeleteError("");
    setBatchMergeConfirming(false);
    setBatchMergeError("");
    setMergeTargetId("");
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

  function toggleApprovedSelection(tagId: string) {
    setSelectedApprovedIds((current) => {
      const next = new Set(current);

      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }

      return next;
    });
    setBatchMergeConfirming(false);
    setBatchMergeError("");
    setMergeTargetId("");
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

  function beginBatchMerge() {
    if (selectedApprovedIds.size < 2) {
      return;
    }

    const defaultTarget =
      selectedTag && selectedApprovedIds.has(selectedTag.id)
        ? selectedTag.id
        : tags.find(({ id }) => selectedApprovedIds.has(id))?.id;

    setMergeTargetId(defaultTarget ?? "");
    setBatchMergeConfirming(true);
    setBatchMergeError("");
    window.requestAnimationFrame(() => batchMergeConfirmButton.current?.focus());
  }

  function cancelBatchMerge() {
    setBatchMergeConfirming(false);
    setBatchMergeError("");
    setMergeTargetId("");
    window.requestAnimationFrame(() => batchMergeButton.current?.focus());
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

  async function handleApprove(parentId: string | null) {
    if (!selectedTag) {
      return;
    }

    setActionBusy("approve");
    setActionError("");
    setActionNotice("");

    try {
      await approveCandidateTag(selectedTag.id, parentId);
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

  async function handleMove(parentId: string | null): Promise<boolean> {
    if (!selectedTag) {
      return false;
    }

    setActionBusy("move");
    setActionError("");
    setActionNotice("");

    try {
      const moved = await updateTag(selectedTag.id, { parentId });

      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice(
        moved.ancestors.length > 0
          ? `已移动到“${tagAncestorLabel(moved)}”之下。`
          : "已移到顶层。",
      );
      return true;
    } catch (error) {
      setActionError(tagActionMessage(error, "标签未能移动，请重试。"));
      return false;
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

  async function handleBatchMerge() {
    const sourceTagIds = [...selectedApprovedIds].filter(
      (id) => id !== mergeTargetId,
    );

    if (!mergeTargetId || sourceTagIds.length === 0) {
      return;
    }

    setActionBusy("batch-merge");
    setActionError("");
    setBatchMergeError("");
    setPageNotice("");

    try {
      const operation = await mergeTags(mergeTargetId, sourceTagIds);

      setTags((current) =>
        current
          .filter(({ id }) => !sourceTagIds.includes(id))
          .map((tag) =>
            tag.id === operation.targetTag.id ? operation.targetTag : tag,
          ),
      );
      resetBatchSelection();
      setReloadVersion((current) => current + 1);
      setPageNotice(
        `已将 ${operation.sourceTags.length} 个来源标签合并到“${operation.targetTag.name}”。历史标签与关联没有改写，可在详情中撤销。`,
      );
      selectTag(operation.targetTag);
    } catch (error) {
      setBatchMergeError(
        tagActionMessage(error, "标签未能合并，请刷新后重试。"),
      );
    } finally {
      setActionBusy("");
    }
  }

  async function handleCreateAlias(name: string): Promise<boolean> {
    if (!selectedTag) {
      return false;
    }

    setActionBusy("alias:add");
    setActionError("");
    setActionNotice("");

    try {
      await createTagAlias(selectedTag.id, name);
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice(`已添加别名“${name}”。`);
      return true;
    } catch (error) {
      setActionError(tagActionMessage(error, "别名未能添加，请重试。"));
      return false;
    } finally {
      setActionBusy("");
    }
  }

  async function handleDeleteAlias(aliasId: string) {
    if (!selectedTag) {
      return;
    }

    setActionBusy(`alias:${aliasId}`);
    setActionError("");
    setActionNotice("");

    try {
      await deleteTagAlias(selectedTag.id, aliasId);
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice("标签别名已移除。");
    } catch (error) {
      setActionError(tagActionMessage(error, "别名未能移除，请重试。"));
    } finally {
      setActionBusy("");
    }
  }

  async function handleUndoMerge(mergeId: string) {
    if (!selectedTag) {
      return;
    }

    setActionBusy(`merge:${mergeId}`);
    setActionError("");
    setActionNotice("");

    try {
      await undoTagMerge(mergeId);
      await refreshSelected(selectedTag.id);
      setReloadVersion((current) => current + 1);
      setActionNotice("标签合并已撤销，来源标签已恢复独立展示。");
    } catch (error) {
      setActionError(tagActionMessage(error, "标签合并未能撤销，请重试。"));
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
      const created = await createTag(name, levelTag?.id ?? null);

      setNewTagOpen(false);
      setNewTagName("");
      if (section !== "user_approved") {
        setTags([]);
        setListLoading(true);
      }
      setSection("user_approved");
      if (!levelTag) {
        setQuery(created.name);
      }
      setSort("name_asc");
      setReloadVersion((current) => current + 1);
      setPageNotice(
        levelTag
          ? `已在“${tagPathLabel(levelTag)}”下创建“我的标签”${created.name}。`
          : `已创建“我的标签”${created.name}。`,
      );
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
  const selectedApprovedTags = tags.filter(({ id }) =>
    selectedApprovedIds.has(id),
  );
  const blockedMergeSources = selectedApprovedTags.filter(
    (tag) => tag.id !== mergeTargetId && tag.childCount > 0,
  );

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
              <p>个人词汇</p>
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
                <p>
                  {levelTag
                    ? `新标签会创建在“${tagPathLabel(levelTag)}”之下，即使暂时没有关联记录也会保留。`
                    : "新标签会加入“我的标签”，即使暂时没有关联记录也会保留。"}
                </p>
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

          {section === "user_approved" ? (
            <section
              aria-label="批量治理我的标签"
              className={
                batchMergeConfirming
                  ? "tag-batch-toolbar is-confirming is-merge"
                  : "tag-batch-toolbar"
              }
            >
              {batchMergeConfirming ? (
                <div
                  aria-label="确认标签合并"
                  className="tag-merge-confirmation"
                  role="group"
                >
                  <fieldset>
                    <legend>选择合并后保留的主标签</legend>
                    <p>
                      只改变有效展示与检索；来源标签、历史身份和全部关联均会保留。
                    </p>
                    <div className="tag-merge-targets">
                      {selectedApprovedTags.map((tag) => (
                        <label key={tag.id}>
                          <input
                            checked={mergeTargetId === tag.id}
                            disabled={actionBusy === "batch-merge"}
                            name="merge-target"
                            onChange={() => setMergeTargetId(tag.id)}
                            type="radio"
                            value={tag.id}
                          />
                          <span>
                            <strong>{tag.name}</strong>
                            <small>{tag.recordCount} 条记录</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {blockedMergeSources.length > 0 ? (
                    <p className="tag-batch-error" role="alert">
                      {blockedMergeSources.map(({ name }) => `“${name}”`).join("、")}
                      有下级标签，不能作为合并来源；请把它选为主标签，或先移走它的下级标签。
                    </p>
                  ) : null}
                  <div className="tag-merge-confirm-actions">
                    <span>
                      其余 {Math.max(selectedApprovedTags.length - 1, 0)} 个标签将作为可撤销来源
                    </span>
                    <div>
                      <button
                        className="primary-button"
                        disabled={
                          !mergeTargetId ||
                          blockedMergeSources.length > 0 ||
                          actionBusy === "batch-merge"
                        }
                        onClick={() => void handleBatchMerge()}
                        ref={batchMergeConfirmButton}
                        type="button"
                      >
                        {actionBusy === "batch-merge" ? "合并中…" : "确认合并"}
                      </button>
                      <button
                        disabled={actionBusy === "batch-merge"}
                        onClick={cancelBatchMerge}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="tag-batch-row">
                  <div className="tag-batch-summary">
                    <strong>同义标签治理</strong>
                    <span role="status">
                      {selectedApprovedIds.size > 0
                        ? `已选 ${selectedApprovedIds.size} 个标签`
                        : "勾选两个或更多同义标签，再选择要保留的主标签"}
                    </span>
                  </div>
                  <div className="tag-batch-actions">
                    {selectedApprovedIds.size > 0 ? (
                      <button
                        disabled={Boolean(actionBusy)}
                        onClick={resetBatchSelection}
                        type="button"
                      >
                        清空选择
                      </button>
                    ) : null}
                    <button
                      className="secondary-button"
                      disabled={
                        selectedApprovedIds.size < 2 || Boolean(actionBusy)
                      }
                      onClick={beginBatchMerge}
                      ref={batchMergeButton}
                      type="button"
                    >
                      合并已选
                      {selectedApprovedIds.size > 1
                        ? `（${selectedApprovedIds.size}）`
                        : ""}
                    </button>
                  </div>
                </div>
              )}

              {batchMergeError ? (
                <p className="tag-batch-error" role="alert">
                  {batchMergeError}
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

            {levelTag ? (
              <nav aria-label="标签层级" className="tag-level-trail">
                <Link to="/tags">全部标签</Link>
                {levelTag.ancestors.map((ancestor) => (
                  <Fragment key={ancestor.id}>
                    <span aria-hidden="true">›</span>
                    <Link to={`/tags?level=${encodeURIComponent(ancestor.id)}`}>
                      {ancestor.name}
                    </Link>
                  </Fragment>
                ))}
                <span aria-hidden="true">›</span>
                <strong aria-current="location">{levelTag.name}</strong>
                <button
                  className="tag-level-detail"
                  onClick={() => selectTag(levelTag)}
                  type="button"
                >
                  查看“{levelTag.name}”详情
                </button>
              </nav>
            ) : null}

            <ul
              aria-busy={
                actionBusy === "batch-delete" || actionBusy === "batch-merge"
              }
              aria-label="标签图鉴"
              className="tag-atlas-grid"
            >
              {visibleTags.map((tag, index) => (
                <li
                  className={
                    selectedCandidateIds.has(tag.id) ||
                    selectedApprovedIds.has(tag.id)
                      ? "is-batch-selected"
                      : undefined
                  }
                  key={tag.id}
                >
                  {tag.approvalStatus !== "archived" ? (
                    <label className="tag-card-selection">
                      <input
                        aria-label={`选择 ${tag.name}`}
                        checked={
                          tag.approvalStatus === "candidate"
                            ? selectedCandidateIds.has(tag.id)
                            : selectedApprovedIds.has(tag.id)
                        }
                        disabled={Boolean(actionBusy)}
                        onChange={() =>
                          tag.approvalStatus === "candidate"
                            ? toggleCandidateSelection(tag.id)
                            : toggleApprovedSelection(tag.id)
                        }
                        type="checkbox"
                      />
                    </label>
                  ) : null}
                  <button
                    aria-label={tag.name}
                    aria-pressed={selectedTag?.id === tag.id}
                    className="has-selection-control"
                    data-tag-id={tag.id}
                    disabled={
                      actionBusy === "batch-delete" || actionBusy === "batch-merge"
                    }
                    onClick={() => selectTag(tag)}
                    type="button"
                  >
                    <span className="tag-atlas-index">
                      T{String(index + 1).padStart(3, "0")}
                    </span>
                    {tag.approvalStatus === "candidate" ? (
                      <span className="tag-atlas-state">AI 候选</span>
                    ) : null}
                    {!browsingLevels && tag.ancestors.length > 0 ? (
                      <span className="tag-atlas-name">
                        <small className="tag-atlas-path">
                          {tagAncestorLabel(tag)}
                        </small>
                        <strong>{tag.name}</strong>
                      </span>
                    ) : (
                      <strong>{tag.name}</strong>
                    )}
                    <span className="tag-atlas-count">
                      {tag.recordCount} 条记录{tag.childCount > 0 ? "（含下级）" : ""}
                      {tag.childCount > 0 ? (
                        <small>直接关联 {tag.directRecordCount} 条</small>
                      ) : null}
                    </span>
                  </button>
                  {tag.childCount > 0 && tag.approvalStatus === "user_approved" ? (
                    <Link
                      aria-label={`进入“${tag.name}”的 ${tag.childCount} 个下级标签`}
                      className="tag-card-children"
                      to={`/tags?level=${encodeURIComponent(tag.id)}`}
                    >
                      {tag.childCount} 个下级 <span aria-hidden="true">›</span>
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>

            {!listLoading && !loadError && visibleTags.length === 0 ? (
              <div className="tag-atlas-empty" role="status">
                <strong>
                  {query
                    ? "没有匹配的标签"
                    : levelTag
                      ? "这一层还没有下级标签"
                      : `还没有${sectionLabel}`}
                </strong>
                <span>
                  {query
                    ? "请调整搜索词。"
                    : levelTag
                      ? "可以在这里新建标签，或从其他标签详情中移动过来。"
                      : section === "candidate"
                        ? "AI 整理产生的候选会显示在这里。"
                        : "创建第一个标签，开始整理你的词表。"}
                </span>
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
            hierarchyTags={hierarchyTags}
            loading={drawerLoading}
            onAddAlias={handleCreateAlias}
            onApprove={(parentId) => void handleApprove(parentId)}
            onArchiveStatus={(status) => void handleArchiveStatus(status)}
            onClose={() => closeDrawer(true)}
            onDelete={() => void handleDeleteCandidate()}
            onDeleteAlias={(aliasId) => void handleDeleteAlias(aliasId)}
            onMove={handleMove}
            onRename={handleRename}
            onSelectTag={selectTag}
            onUndoMerge={(mergeId) => void handleUndoMerge(mergeId)}
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
  hierarchyTags,
  loading,
  onAddAlias,
  onApprove,
  onArchiveStatus,
  onClose,
  onDelete,
  onDeleteAlias,
  onMove,
  onRename,
  onSelectTag,
  onUndoMerge,
  onVisibility,
  tag,
}: {
  actionBusy: string;
  actionError: string;
  actionNotice: string;
  detail: TagDetail | null;
  error: string;
  hierarchyTags: TagListItem[];
  loading: boolean;
  onAddAlias: (name: string) => Promise<boolean>;
  onApprove: (parentId: string | null) => void;
  onArchiveStatus: (status: "archived" | "user_approved") => void;
  onClose: () => void;
  onDelete: () => void;
  onDeleteAlias: (aliasId: string) => void;
  onMove: (parentId: string | null) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onSelectTag: (tag: TagListItem) => void;
  onUndoMerge: (mergeId: string) => void;
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
  const [aliasValue, setAliasValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveTarget, setMoveTarget] = useState(tag.parentId ?? "");
  const [approveParent, setApproveParent] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const aliasInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setExpandedRecords(new Set());
    setRenaming(false);
    setRenameValue(tag.name);
    setAliasValue("");
    setConfirmDelete(false);
    setApproveParent("");
  }, [tag.id]);

  useEffect(() => {
    setMoveTarget(tag.parentId ?? "");
  }, [tag.id, tag.parentId]);

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

  async function submitAlias(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = aliasValue.trim();

    if (!name) {
      aliasInput.current?.focus();
      return;
    }

    if (await onAddAlias(name)) {
      setAliasValue("");
      aliasInput.current?.focus();
    }
  }

  const records = detail?.records ?? [];
  const children = detail?.children ?? [];
  const candidate = tag.approvalStatus === "candidate";
  const archived = tag.approvalStatus === "archived";
  const mergeGroups = groupMergedSources(detail?.mergedSources ?? []);
  const moveOptions = hierarchyDestinations(hierarchyTags, tag);
  const approveOptions = hierarchyDestinations(hierarchyTags, null);

  async function submitMove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onMove(moveTarget || null);
  }

  return (
    <aside aria-label="标签详情" className="tag-detail-drawer" role="region">
      <header>
        <div>
          <p>{candidate ? "AI 候选" : archived ? "已归档标签" : "我的标签"}</p>
          <button aria-label="关闭标签详情" onClick={onClose} type="button">×</button>
        </div>
        <h2>{tag.name}</h2>
        <span>
          {tag.childCount > 0
            ? `${tag.recordCount} 条记录（含下级）· 直接关联 ${tag.directRecordCount} 条`
            : `${tag.recordCount} 条当前有效关联记录`}
          {" · "}
          {tagOriginLabel(tag)}
        </span>
      </header>

      <div className="tag-drawer-body">
        {!candidate && !archived ? (
          <section aria-labelledby="tag-hierarchy-title" className="tag-hierarchy">
            <div className="tag-hierarchy-heading">
              <div>
                <h3 id="tag-hierarchy-title">标签层级</h3>
                <p>
                  {tag.ancestors.length > 0
                    ? `位于“${tagAncestorLabel(tag)}”之下`
                    : "位于顶层"}
                </p>
              </div>
              {tag.childCount > 0 || tag.ancestors.length + 1 < MAX_TAG_DEPTH ? (
                <Link to={`/tags?level=${encodeURIComponent(tag.id)}`}>
                  {tag.childCount > 0 ? "浏览下级" : "新增下级"}
                </Link>
              ) : null}
            </div>

            {children.length > 0 ? (
              <ul aria-label="下级标签" className="tag-child-list">
                {children.map((child) => (
                  <li key={child.id}>
                    <button onClick={() => onSelectTag(child)} type="button">
                      {child.name}
                    </button>
                    <span>{child.recordCount} 条记录</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="tag-governance-empty">没有下级标签。</p>
            )}

            <form
              aria-label="移动标签"
              className="tag-move-form"
              onSubmit={(event) => void submitMove(event)}
            >
              <label htmlFor="tag-move-parent">移动到</label>
              <select
                disabled={actionBusy === "move"}
                id="tag-move-parent"
                onChange={(event) => setMoveTarget(event.target.value)}
                value={moveTarget}
              >
                <option value="">顶层</option>
                {moveOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {tagPathLabel(option)}
                  </option>
                ))}
              </select>
              <button
                disabled={
                  Boolean(actionBusy) || moveTarget === (tag.parentId ?? "")
                }
                type="submit"
              >
                {actionBusy === "move" ? "移动中…" : "移动"}
              </button>
            </form>
          </section>
        ) : null}

        {!candidate && !archived ? (
          <section aria-labelledby="tag-governance-title" className="tag-governance">
            <div className="tag-governance-heading">
              <div>
                <h3 id="tag-governance-title">词汇治理</h3>
                <p>别名与来源都解析到当前主标签，但不会改写历史身份或关联。</p>
              </div>
              <span>可撤销</span>
            </div>

            <div className="tag-alias-editor">
              <div className="tag-governance-subheading">
                <strong>标签别名</strong>
                <span>{detail?.aliases.length ?? 0} 个</span>
              </div>
              {detail?.aliases.length ? (
                <ul aria-label="标签别名">
                  {detail.aliases.map((alias) => (
                    <li key={alias.id}>
                      <span>{alias.name}</span>
                      <button
                        aria-label={`移除别名 ${alias.name}`}
                        disabled={actionBusy === `alias:${alias.id}`}
                        onClick={() => onDeleteAlias(alias.id)}
                        type="button"
                      >
                        {actionBusy === `alias:${alias.id}` ? "移除中…" : "移除"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="tag-governance-empty">还没有别名。</p>
              )}
              <form
                aria-label="添加标签别名"
                className="tag-alias-form"
                onSubmit={(event) => void submitAlias(event)}
              >
                <label className="visually-hidden" htmlFor="tag-alias-input">
                  新别名
                </label>
                <input
                  id="tag-alias-input"
                  onChange={(event) => setAliasValue(event.target.value)}
                  placeholder="输入缩写、译名或其他常用写法"
                  ref={aliasInput}
                  type="text"
                  value={aliasValue}
                />
                <button
                  disabled={!aliasValue.trim() || actionBusy === "alias:add"}
                  type="submit"
                >
                  {actionBusy === "alias:add" ? "添加中…" : "添加别名"}
                </button>
              </form>
            </div>

            {mergeGroups.length > 0 ? (
              <div className="tag-merged-sources">
                <div className="tag-governance-subheading">
                  <strong>已合并来源</strong>
                  <span>{detail?.mergedSources.length ?? 0} 个</span>
                </div>
                <ul aria-label="已合并来源标签">
                  {mergeGroups.map((group) => (
                    <li key={group.mergeId}>
                      <div>
                        {group.sources.map((source) => (
                          <span key={source.id}>{source.name}</span>
                        ))}
                      </div>
                      <button
                        disabled={actionBusy === `merge:${group.mergeId}`}
                        onClick={() => onUndoMerge(group.mergeId)}
                        type="button"
                      >
                        {actionBusy === `merge:${group.mergeId}`
                          ? "撤销中…"
                          : "撤销这次合并"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="tag-records-title" className="tag-related-records">
        <div className="tag-related-heading">
          <h3 id="tag-records-title">关联记录</h3>
          <span>每条记录仅显示一次</span>
        </div>
        {tag.childCount > 0 ? (
          <p className="tag-related-note">
            这里只列出直接关联的记录；包含下级的全部 {tag.recordCount} 条记录可在
            <Link to={`/search?tag=${encodeURIComponent(tag.id)}`}>搜索结果</Link>
            中查看。
          </p>
        ) : null}

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
      </div>

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
            <div className="tag-drawer-actions has-parent-picker">
              <p>认可后复用同一标签身份，已有 AI 关联不会被改写为手动关联。</p>
              <label className="tag-approve-parent">
                <span>认可后放在</span>
                <select
                  disabled={Boolean(actionBusy)}
                  onChange={(event) => setApproveParent(event.target.value)}
                  value={approveParent}
                >
                  <option value="">顶层</option>
                  {approveOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {tagPathLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <button
                  className="primary-button"
                  disabled={Boolean(actionBusy)}
                  onClick={() => onApprove(approveParent || null)}
                  type="button"
                >
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

/**
 * Approved Tags that can become the parent of `tag` (or of a newly approved
 * candidate when `tag` is null) without forming a cycle or a sixth level.
 * The server enforces the same rules; this only keeps the picker honest.
 */
function hierarchyDestinations(
  tags: TagListItem[],
  tag: TagListItem | null,
): TagListItem[] {
  const childrenByParent = new Map<string, TagListItem[]>();

  for (const candidate of tags) {
    if (candidate.parentId) {
      const siblings = childrenByParent.get(candidate.parentId) ?? [];

      siblings.push(candidate);
      childrenByParent.set(candidate.parentId, siblings);
    }
  }

  const subtree = new Set<string>();
  let height = 1;

  if (tag) {
    const pending = [{ depth: 1, id: tag.id }];

    while (pending.length > 0) {
      const current = pending.pop()!;

      subtree.add(current.id);
      height = Math.max(height, current.depth);

      for (const child of childrenByParent.get(current.id) ?? []) {
        if (!subtree.has(child.id)) {
          pending.push({ depth: current.depth + 1, id: child.id });
        }
      }
    }
  }

  return tags
    .filter(
      (candidate) =>
        !subtree.has(candidate.id) &&
        candidate.ancestors.length + 1 + height <= MAX_TAG_DEPTH,
    )
    .sort((left, right) =>
      tagPathLabel(left).localeCompare(tagPathLabel(right), "zh-Hans-CN"),
    );
}

function groupMergedSources(sources: TagDetail["mergedSources"]) {
  const groups = new Map<
    string,
    { mergeId: string; sources: TagDetail["mergedSources"] }
  >();

  for (const source of sources) {
    const group = groups.get(source.mergeId) ?? {
      mergeId: source.mergeId,
      sources: [],
    };

    group.sources.push(source);
    groups.set(source.mergeId, group);
  }

  return [...groups.values()];
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
