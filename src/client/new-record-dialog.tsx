import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { countGraphemes, hasNonWhitespace } from "../domain/fragment-text.js";
import { normalizeTagName } from "../domain/tag-name.js";
import {
  createRecord,
  getModelConfiguration,
  listUserTags,
  organizeRecord,
  updateRecord,
  type RecordCard,
  type RecordDetail,
  type RecordTagSelection,
  type UserTagListItem,
} from "./api.js";
import { getPreferences } from "./preferences-api.js";
import "./new-record-dialog.css";

export interface NewRecordDialogProps {
  editingRecord?: RecordDetail;
  open: boolean;
  onClose: () => void;
  onSaved: (record: RecordCard) => void;
}

type TagLookup = {
  query: string;
  items: UserTagListItem[];
  status: "idle" | "loading" | "ready";
};

type Processing = "save_only" | "automatic" | "review";

type CreateNotice = {
  recordId: string;
  state: "saved" | "organizing" | "organize_failed";
};

export function NewRecordDialog({
  editingRecord,
  open,
  onClose,
  onSaved,
}: NewRecordDialogProps) {
  const [text, setText] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [selectedTags, setSelectedTags] = useState<RecordTagSelection[]>([]);
  const [tagLookup, setTagLookup] = useState<TagLookup>({
    query: "",
    items: [],
    status: "idle",
  });
  const [processing, setProcessing] = useState<Processing>("save_only");
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiAvailabilityResolved, setAiAvailabilityResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [createNotice, setCreateNotice] = useState<CreateNotice | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialText = editingRecord?.editable.text ?? "";
  const initialTags = editingRecord?.editable.myTags;
  const textChanged = text !== initialText;
  const textGraphemeCount = countGraphemes(text);
  const textTooLong = textGraphemeCount > 1_000;
  const persistedFieldsChanged =
    text !== initialText ||
    selectedTags.map(tagSelectionKey).join("|") !==
      (initialTags ?? []).map(tagSelectionKey).join("|");
  const dirty = persistedFieldsChanged || tagDraft.length > 0;

  useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;

    setText(initialText);
    setTagDraft("");
    setSelectedTags(initialTags ?? []);
    setTagLookup({ query: "", items: [], status: "idle" });
    setProcessing("save_only");
    setAiAvailable(false);
    setAiAvailabilityResolved(false);
    setSubmitting(false);
    setSubmitError("");
    setConfirmDiscard(false);

    if (!editingRecord) {
      setCreateNotice(null);
    }

    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());

    void Promise.all([
      getModelConfiguration(),
      editingRecord
        ? Promise.resolve({ defaultAiHandling: "automatic" as const })
        : getPreferences().catch(() => ({
          defaultAiHandling: "automatic" as const,
        })),
    ])
      .then(([configuration, preferences]) => {
        if (!active) {
          return;
        }

        const available =
          configuration.active?.text.credential === "configured" &&
          configuration.active.embedding.credential === "configured";

        setAiAvailable(available);
        setAiAvailabilityResolved(true);
        setProcessing(
          available && !editingRecord
            ? preferences.defaultAiHandling
            : "save_only",
        );
      })
      .catch(() => {
        if (active) {
          setAiAvailable(false);
          setAiAvailabilityResolved(true);
          setProcessing("save_only");
        }
      });

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
    };
  }, [editingRecord, open]);

  useEffect(() => {
    if (!open || !editingRecord) {
      return;
    }

    if (!textChanged) {
      setProcessing("save_only");
    } else if (aiAvailable) {
      setProcessing("automatic");
    }
  }, [aiAvailable, editingRecord, open, textChanged]);

  useEffect(() => {
    const query = cleanTagName(tagDraft);

    if (!open || !query) {
      setTagLookup({ query: "", items: [], status: "idle" });
      return;
    }

    const controller = new AbortController();

    setTagLookup({ query, items: [], status: "loading" });
    void listUserTags(query, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) {
          setTagLookup({ query, items, status: "ready" });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setTagLookup({ query, items: [], status: "ready" });
        }
      });

    return () => controller.abort();
  }, [open, tagDraft]);

  if (!open) {
    return !editingRecord && createNotice ? (
      <div aria-label="记录保存结果" className="save-notice" role="status">
        <span aria-hidden="true" className="save-notice-mark">✓</span>
        <span>
          {createNotice.state === "saved"
            ? "已保存"
            : createNotice.state === "organizing"
              ? "已保存，AI 正在处理"
              : "已保存，但 AI 整理未启动"}
        </span>
        <Link to={`/records/${createNotice.recordId}`}>查看记录</Link>
      </div>
    ) : null;
  }

  const tagQuery = cleanTagName(tagDraft);
  const lookupIsCurrent =
    tagLookup.query === tagQuery && tagLookup.status === "ready";
  const exactMatch = lookupIsCurrent
    ? tagLookup.items.find(
      (tag) => normalizeTagName(tag.name) === normalizeTagName(tagQuery),
    )
    : undefined;
  const tagOptions = lookupIsCurrent
    ? tagLookup.items.filter((tag) => !hasSelectedTag(selectedTags, tag))
    : [];
  const showTagOptions = tagOptions.length > 0;
  const canCreateTag = Boolean(tagQuery && lookupIsCurrent && !exactMatch);
  const canSubmit =
    hasNonWhitespace(text) &&
    !textTooLong &&
    selectedTags.length > 0 &&
    (!editingRecord || persistedFieldsChanged) &&
    !submitting;

  function requestClose() {
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  }

  function addTag() {
    const name = cleanTagName(tagDraft);

    if (!canCreateTag || hasSelectedTag(selectedTags, name)) {
      return;
    }

    setSelectedTags((current) => [...current, name]);
    setTagDraft("");
  }

  function selectExistingTag(tag: UserTagListItem) {
    setSelectedTags((current) =>
      hasSelectedTag(current, tag)
        ? current
        : [...current, { id: tag.id, name: tag.name }],
    );
    setTagDraft("");
  }

  function removeTag(tag: RecordTagSelection) {
    const key = tagSelectionKey(tag);

    setSelectedTags((items) =>
      items.filter((item) => tagSelectionKey(item) !== key),
    );
  }

  async function saveRecord() {
    if (!canSubmit) {
      return;
    }

    setSubmitting(true);
    setSubmitError("");

    const input = { text, tags: selectedTags };

    if (editingRecord) {
      let record: RecordCard;

      try {
        record = await updateRecord(editingRecord.id, input);
      } catch {
        setSubmitError("保存修改失败，原文仍在此处，请重试。");
        setSubmitting(false);
        return;
      }

      if (textChanged && processing !== "save_only") {
        try {
          await organizeRecord(record.id, processing);
        } catch {
          onSaved(record);
          return;
        }
      }

      onSaved(record);
      return;
    }

    let record: RecordCard;

    try {
      record = await createRecord(input);
    } catch {
      setSubmitError(
        "保存失败，原文仍在此处，请重试。",
      );
      setSubmitting(false);
      return;
    }

    const noticeState = processing === "save_only" ? "saved" : "organizing";

    setCreateNotice({ recordId: record.id, state: noticeState });
    onSaved(record);

    if (processing !== "save_only") {
      try {
        await organizeRecord(record.id, processing);
      } catch {
        setCreateNotice((current) =>
          current?.recordId === record.id
            ? { recordId: record.id, state: "organize_failed" }
            : current,
        );
      }
    }
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
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
    <div className="dialog-overlay" onMouseDown={(event) => {
      if (event.currentTarget === event.target) requestClose();
    }}>
      <div
        aria-labelledby="new-record-title"
        aria-modal="true"
        className="new-record-dialog"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="dialog-header">
          <span aria-hidden="true" className="dialog-orbit" />
          <h2 id="new-record-title">{editingRecord ? "编辑记录" : "新建记录"}</h2>
          <p>{editingRecord ? "更新标签或原文，旧版本仍可核验" : "保存原文，AI 不会覆盖它"}</p>
          <button aria-label={editingRecord ? "关闭编辑记录" : "关闭新建记录"} className="icon-button" onClick={requestClose} type="button">×</button>
        </header>

        <div className="dialog-body">
          <fieldset aria-label="记录内容" className="record-editor-pane">
            <legend className="visually-hidden">记录内容</legend>
            <label className="visually-hidden" htmlFor="record-text">记录正文</label>
            <textarea
              aria-describedby="record-count"
              aria-invalid={textTooLong}
              id="record-text"
              onChange={(event) => setText(event.target.value)}
              placeholder="粘贴或输入要保存的原文…"
              ref={textareaRef}
              value={text}
            />
            <div className="record-count" id="record-count">
              {textTooLong ? (
                <span className="record-limit-error" role="alert">
                  正文不能超过 1000 个字符，请拆分后再保存。
                </span>
              ) : (
                <span>请输入 1–1000 个字符</span>
              )}
              <span aria-label="正文字符计数">{textGraphemeCount} / 1000</span>
            </div>
          </fieldset>

          <fieldset aria-label="标签与处理方式" className="record-options-pane">
            <legend className="visually-hidden">标签与处理方式</legend>
            <label className="field-label" htmlFor="tag-input">我的标签 <span aria-hidden="true">*</span></label>
            <div className="tag-entry">
              <input
                aria-autocomplete="list"
                aria-busy={
                  tagLookup.query === tagQuery && tagLookup.status === "loading"
                }
                aria-controls="tag-options"
                aria-expanded={showTagOptions}
                aria-label="我的标签"
                id="tag-input"
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();

                    if (exactMatch) {
                      selectExistingTag(exactMatch);
                    } else {
                      addTag();
                    }
                  }
                }}
                placeholder="搜索或创建标签"
                role="combobox"
                value={tagDraft}
              />
              {canCreateTag ? (
                <button onClick={addTag} type="button">创建标签</button>
              ) : null}
              {showTagOptions ? (
                <div
                  aria-label="已认可标签"
                  className="tag-options"
                  id="tag-options"
                  role="listbox"
                >
                  {tagOptions.map((tag) => (
                    <button
                      aria-selected="false"
                      className="tag-option"
                      key={tag.id}
                      onClick={() => selectExistingTag(tag)}
                      role="option"
                      type="button"
                    >
                      <span>{tag.name}</span>
                      <small>{tag.recordCount} 条记录</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div aria-label="已选标签" className="selected-tags">
              {selectedTags.map((tag) => {
                const name = selectedTagName(tag);

                return (
                  <span key={tagSelectionKey(tag)}>
                    <span>{name}</span>
                    <button
                      aria-label={`移除标签 ${name}`}
                      onClick={() => removeTag(tag)}
                      type="button"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
            <p className="tag-help">至少选择一个已认可标签</p>

            <div className="processing-options">
              <h3>保存后如何处理？</h3>
              <label className={processing === "save_only" ? "selected" : ""}>
                <input checked={processing === "save_only"} name="processing" onChange={() => setProcessing("save_only")} type="radio" />
                <span><strong>仅保存</strong><small>仅保存记录，不进行任何处理。</small></span>
              </label>
              <label className={`${processing === "automatic" ? "selected" : ""}${aiAvailable && (!editingRecord || textChanged) ? "" : " disabled-option"}`}>
                <input checked={processing === "automatic"} disabled={!aiAvailable || Boolean(editingRecord && !textChanged)} name="processing" onChange={() => setProcessing("automatic")} type="radio" />
                <span><strong>AI 整理并自动采用</strong><small>{processingOptionHelp("automatic", { aiAvailable, aiAvailabilityResolved, editingRecord: Boolean(editingRecord), textChanged })}</small></span>
              </label>
              <label className={`${processing === "review" ? "selected" : ""}${aiAvailable && (!editingRecord || textChanged) ? "" : " disabled-option"}`}>
                <input checked={processing === "review"} disabled={!aiAvailable || Boolean(editingRecord && !textChanged)} name="processing" onChange={() => setProcessing("review")} type="radio" />
                <span><strong>AI 整理后由我确认</strong><small>{processingOptionHelp("review", { aiAvailable, aiAvailabilityResolved, editingRecord: Boolean(editingRecord), textChanged })}</small></span>
              </label>
              {aiAvailabilityResolved && (!editingRecord || !aiAvailable) ? (
                <p className="model-settings-hint">
                  <span>{aiAvailable ? "可在设置中管理本实例模型。" : "启用完整模型配置后即可使用 AI 整理。"}</span>
                  <Link to="/settings#model-settings">前往模型设置</Link>
                </p>
              ) : editingRecord && !textChanged ? (
                <p className="model-settings-hint">
                  <span>原文未变化；如需重新分析，请关闭后使用详情页“重新整理”。</span>
                </p>
              ) : null}
            </div>
          </fieldset>
        </div>

        <footer className="dialog-footer">
          <p><span aria-hidden="true">▣</span> 您的原始内容将完整保存，系统不会修改或覆盖。</p>
          <div>
            <button className="secondary-button" onClick={requestClose} type="button">取消</button>
            <button className="primary-button" disabled={!canSubmit} onClick={() => void saveRecord()} type="button">{submitting ? "保存中…" : editingRecord ? "保存修改" : "保存记录"}</button>
          </div>
        </footer>

        {submitError ? <p className="dialog-error" role="alert">{submitError}</p> : null}

        {confirmDiscard ? (
          <div aria-labelledby="discard-title" aria-modal="true" className="discard-confirm" role="alertdialog">
            <h3 id="discard-title">放弃未保存的修改？</h3>
            <p>关闭后，本次输入不会保留。</p>
            <div>
              <button onClick={() => setConfirmDiscard(false)} type="button">继续编辑</button>
              <button className="danger-button" onClick={onClose} type="button">放弃修改</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function processingOptionHelp(
  processing: "automatic" | "review",
  state: {
    aiAvailable: boolean;
    aiAvailabilityResolved: boolean;
    editingRecord: boolean;
    textChanged: boolean;
  },
): string {
  if (!state.aiAvailabilityResolved) {
    return "正在检查模型配置…";
  }

  if (!state.aiAvailable) {
    return "配置模型后可用。";
  }

  if (state.editingRecord && !state.textChanged) {
    return "修改原文后可选。";
  }

  return processing === "automatic"
    ? "整理完成后自动采用 AI 结果。"
    : "整理完成后逐项确认 AI 结果。";
}

function cleanTagName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function selectedTagName(tag: RecordTagSelection): string {
  return typeof tag === "string" ? tag : tag.name;
}

function tagSelectionKey(tag: RecordTagSelection): string {
  return typeof tag === "string"
    ? `name:${normalizeTagName(tag)}`
    : `id:${tag.id}`;
}

function hasSelectedTag(
  selectedTags: RecordTagSelection[],
  candidate: RecordTagSelection,
): boolean {
  const candidateName = normalizeTagName(selectedTagName(candidate));

  return selectedTags.some((tag) => {
    if (typeof tag !== "string" && typeof candidate !== "string") {
      return tag.id === candidate.id;
    }

    return normalizeTagName(selectedTagName(tag)) === candidateName;
  });
}
