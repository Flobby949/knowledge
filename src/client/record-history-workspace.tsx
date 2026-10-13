import { useEffect, useRef, useState } from "react";

import {
  getRecordHistory,
  getRecordHistoryEntry,
  type RecordDetail,
  type RecordHistoryEntry,
  type RecordHistorySnapshot,
} from "./api.js";
import { HighlightableText } from "./text-highlights.js";
import "./record-history-workspace.css";

interface RecordHistoryWorkspaceProps {
  open: boolean;
  record: RecordDetail;
  onClose: () => void;
}

export function RecordHistoryWorkspace({
  open,
  record,
  onClose,
}: RecordHistoryWorkspaceProps) {
  const [entries, setEntries] = useState<RecordHistoryEntry[]>([]);
  const [selected, setSelected] = useState<RecordHistorySnapshot | null>(null);
  const [comparisonAnalysis, setComparisonAnalysis] =
    useState<Extract<RecordHistorySnapshot, { type: "organization" }> | null>(
      null,
    );
  const [compare, setCompare] = useState(false);
  const [loadError, setLoadError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let active = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    setEntries([]);
    setSelected(null);
    setComparisonAnalysis(null);
    setCompare(false);
    setLoadError("");

    void getRecordHistory(record.id)
      .then((historyEntries) => {
        if (!active) {
          return;
        }

        const ordered = [...historyEntries].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt),
        );
        const current = ordered.find(
          (
            entry,
          ): entry is Extract<RecordHistoryEntry, { type: "original" }> =>
            entry.type === "original" && entry.isCurrent,
        );

        setEntries(ordered);
        if (current) {
          setSelected(currentSnapshot(record, current));
        }
      })
      .catch(() => {
        if (active) {
          setLoadError("历史版本暂时无法载入，请稍后重试。");
        }
      });

    return () => {
      active = false;
      document.body.style.overflow = previousOverflow;
    };
  }, [open, record]);

  if (!open) {
    return null;
  }

  async function selectEntry(entry: RecordHistoryEntry) {
    setCompare(false);
    setComparisonAnalysis(null);
    setLoadError("");

    if (entry.type === "original" && entry.isCurrent) {
      setSelected(currentSnapshot(record, entry));
      return;
    }

    setSelected(null);

    try {
      setSelected(await getRecordHistoryEntry(record.id, entry.id));
    } catch {
      setLoadError("这个历史版本暂时无法载入，请稍后重试。");
    }
  }

  async function toggleAnalysisComparison() {
    if (compare) {
      setCompare(false);
      return;
    }

    const activeAnalysis = entries.find(
      (
        entry,
      ): entry is Extract<RecordHistoryEntry, { type: "organization" }> =>
        entry.type === "organization" && entry.isCurrent,
    );

    if (!activeAnalysis) {
      return;
    }

    setLoadError("");

    try {
      const snapshot = await getRecordHistoryEntry(record.id, activeAnalysis.id);

      if (snapshot.type !== "organization") {
        throw new Error("active history entry is not an analysis");
      }

      setComparisonAnalysis(snapshot);
      setCompare(true);
    } catch {
      setLoadError("当前 AI 版本暂时无法载入，请稍后重试。");
    }
  }

  return (
    <div
      aria-label="历史版本"
      aria-modal="true"
      className="history-workspace"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
      role="dialog"
    >
      <header className="history-workspace-header">
        <div>
          <p>记录校验工作台</p>
          <h2>历史版本</h2>
        </div>
        <button
          aria-label="关闭历史版本"
          className="history-close-button"
          onClick={onClose}
          ref={closeButton}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="history-workspace-body">
        <aside className="history-timeline-panel">
          <div className="history-timeline-heading">
            <span>版本时间轴</span>
            <span>{entries.length}</span>
          </div>
          <div
            aria-label="版本时间轴"
            className="history-tabs"
            onKeyDown={(event) => {
              if (
                event.key !== "ArrowLeft" &&
                event.key !== "ArrowRight" &&
                event.key !== "Home" &&
                event.key !== "End"
              ) {
                return;
              }

              const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              )];
              const currentIndex = tabs.indexOf(
                event.target as HTMLButtonElement,
              );

              if (currentIndex < 0 || tabs.length === 0) {
                return;
              }

              event.preventDefault();
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (currentIndex + 1) % tabs.length
                      : (currentIndex - 1 + tabs.length) % tabs.length;
              const nextTab = tabs[nextIndex];
              const nextEntry = entries[nextIndex];

              nextTab?.focus();

              if (nextEntry) {
                void selectEntry(nextEntry);
              }
            }}
            role="tablist"
          >
            {entries.map((entry) => {
              const isSelected = selected?.id === entry.id;

              return (
                <button
                  aria-label={historyEntryLabel(entry)}
                  aria-selected={isSelected}
                  className="history-tab"
                  key={entry.id}
                  onClick={() => void selectEntry(entry)}
                  role="tab"
                  tabIndex={isSelected ? 0 : -1}
                  type="button"
                >
                  <span className="history-tab-version">
                    {entry.type === "original"
                      ? `原文 v${entry.version}${entry.isCurrent ? " 当前" : ""}`
                      : "AI 整理"}
                  </span>
                  <span className="history-tab-meta">
                    {entry.type === "original"
                      ? "知识碎片版本"
                      : `${analysisStatusLabel(entry.status)} · 基于原文 v${entry.sourceTextVersion}`}
                  </span>
                  <time dateTime={entry.createdAt}>
                    {formatHistoryTime(entry.createdAt)}
                  </time>
                </button>
              );
            })}
          </div>
        </aside>

        <section aria-label="版本内容" className="history-content-panel">
          {loadError ? <p role="alert">{loadError}</p> : null}
          {!selected && !loadError ? <p role="status">正在载入版本…</p> : null}
          {selected?.type === "original" ? (
            <>
              <div className="history-content-toolbar">
                <div>
                  <p>{selected.version === selected.currentVersion ? "当前版本" : "历史快照"}</p>
                  <h3>原文 v{selected.version}</h3>
                </div>
                {selected.version !== selected.currentVersion ? (
                  <button
                    className="history-compare-button"
                    onClick={() => setCompare((visible) => !visible)}
                    type="button"
                  >
                    {compare ? "退出对照" : "与当前版本对照"}
                  </button>
                ) : null}
              </div>

              {compare ? (
                <div className="history-compare-grid">
                  <HistoryPane
                    recordId={record.id}
                    label={`历史版本 v${selected.version}`}
                    text={selected.snapshot.text}
                    version={selected.version}
                  />
                  <HistoryPane
                    recordId={record.id}
                    label={`当前版本 v${record.editable.textVersion}`}
                    text={record.editable.text}
                    version={record.editable.textVersion}
                  />
                </div>
              ) : (
                <pre
                  aria-label={`版本 v${selected.version} 原文`}
                  className="history-selected-text"
                >
                  <HighlightableText
                    recordId={record.id}
                    target={`source:${selected.version}`}
                    text={selected.snapshot.text}
                    readOnly
                  />
                </pre>
              )}
            </>
          ) : null}
          {selected?.type === "organization" ? (
            <>
              <div className="history-content-toolbar">
                <div>
                  <p>{analysisSnapshotStatusLabel(selected.status)}</p>
                  <h3>AI 分析版本</h3>
                </div>
                {entries.some(
                  (entry) =>
                    entry.type === "organization" &&
                    entry.isCurrent &&
                    entry.id !== selected.id,
                ) ? (
                  <button
                    className="history-compare-button"
                    onClick={() => void toggleAnalysisComparison()}
                    type="button"
                  >
                    {compare ? "退出 AI 版本对照" : "与当前 AI 版本对照"}
                  </button>
                ) : null}
              </div>
              {compare && comparisonAnalysis ? (
                <div className="history-compare-grid">
                  <AnalysisComparisonPane
                    label="历史 AI 版本"
                    snapshot={selected}
                  />
                  <AnalysisComparisonPane
                    label="当前 AI 版本"
                    snapshot={comparisonAnalysis}
                  />
                </div>
              ) : (
                <AnalysisHistorySnapshot snapshot={selected} />
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function HistoryPane({
  recordId,
  label,
  text,
  version,
}: {
  recordId: string;
  label: string;
  text: string;
  version: number;
}) {
  return (
    <section aria-label={label} className="history-compare-pane">
      <header>
        <span>{label}</span>
        <span>原文 v{version}</span>
      </header>
      <pre aria-label="完整原文">
        <HighlightableText
          recordId={recordId}
          target={`source:${version}`}
          text={text}
          readOnly
        />
      </pre>
    </section>
  );
}

function currentSnapshot(
  record: RecordDetail,
  entry: Extract<RecordHistoryEntry, { type: "original" }>,
): RecordHistorySnapshot {
  return {
    id: entry.id,
    type: "original",
    version: entry.version,
    createdAt: entry.createdAt,
    snapshot: { text: record.editable.text },
    currentVersion: record.editable.textVersion,
  };
}

function AnalysisHistorySnapshot({
  snapshot,
}: {
  snapshot: Extract<RecordHistorySnapshot, { type: "organization" }>;
}) {
  return (
    <section
      aria-label="AI 分析快照"
      className="history-analysis-snapshot"
    >
      <div className="history-analysis-meta">
        <span aria-label="分析状态">
          {analysisSnapshotStatusLabel(snapshot.status)}
        </span>
        <span>
          来源原文 <strong aria-label="来源原文版本">v{snapshot.sourceTextVersion}</strong>
        </span>
        {snapshot.sourceTextVersion !== snapshot.currentTextVersion ? (
          <span>
            当前原文 v{snapshot.currentTextVersion}
          </span>
        ) : null}
      </div>
      <h3>{snapshot.snapshot.title}</h3>
      <p className="history-analysis-summary">{snapshot.snapshot.summary}</p>
      <div className="history-analysis-points">
        {snapshot.snapshot.organizedItems.map((item, index) => (
          <article className="history-analysis-point" key={`${index}-${item.title}`}>
            <h4>{item.title}</h4>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function AnalysisComparisonPane({
  label,
  snapshot,
}: {
  label: string;
  snapshot: Extract<RecordHistorySnapshot, { type: "organization" }>;
}) {
  return (
    <section
      aria-label={label}
      className="history-compare-pane history-analysis-compare-pane"
    >
      <header>
        <span>{label}</span>
        <span>基于原文 v{snapshot.sourceTextVersion}</span>
      </header>
      <div className="history-analysis-compare-overview">
        <h3>{snapshot.snapshot.title}</h3>
        <p>{snapshot.snapshot.summary}</p>
      </div>
      <div className="history-analysis-points">
        {snapshot.snapshot.organizedItems.map((item, index) => (
          <article className="history-analysis-point" key={`${index}-${item.title}`}>
            <h4>{item.title}</h4>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function historyEntryLabel(entry: RecordHistoryEntry): string {
  if (entry.type === "original") {
    return `原文 v${entry.version}${entry.isCurrent ? " 当前" : ""}`;
  }

  return `AI 整理 · ${analysisStatusLabel(entry.status)} · 基于原文 v${entry.sourceTextVersion}`;
}

function analysisStatusLabel(
  status: Extract<RecordHistoryEntry, { type: "organization" }>["status"],
): string {
  if (status === "ACTIVE") {
    return "生效";
  }

  if (status === "GENERATED") {
    return "候选";
  }

  if (status === "SUPERSEDED") {
    return "历史";
  }

  if (status === "DISCARDED") {
    return "已丢弃";
  }

  return "迟到";
}

function analysisSnapshotStatusLabel(
  status: Extract<RecordHistorySnapshot, { type: "organization" }>["status"],
): string {
  return status === "ACTIVE" ? "生效版本" : `${analysisStatusLabel(status)}版本`;
}

function formatHistoryTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
