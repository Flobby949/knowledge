/* Reading annotation controls inherit the record workspace palette and typography.
 * Selection opens a compact color palette beside the text; saved marks remain inline.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  highlightColors,
  type HighlightColor,
  type TextHighlight,
} from "../domain/text-highlights.js";
import "./text-highlights.css";

const colorNames: Record<HighlightColor, string> = {
  yellow: "黄色",
  green: "绿色",
  blue: "蓝色",
  pink: "粉色",
  purple: "紫色",
};
interface HighlightState {
  content: string;
  revision: number;
  highlights: TextHighlight[];
}
interface SelectionRange {
  start: number;
  end: number;
  left: number;
  top: number;
  existing: boolean;
}

export function HighlightableText({
  recordId,
  target,
  text,
  evidence,
  marker,
  readOnly = false,
}: {
  recordId: string;
  target: string;
  text: string;
  evidence?: { start: number; end: number; quote: string } | null;
  marker?: number | undefined;
  readOnly?: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<HighlightState | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const url = `/api/v1/records/${encodeURIComponent(recordId)}/highlights/${encodeURIComponent(target)}`;

  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setSelection(null);
    setError("");
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("重点标记暂时无法载入，请重试。");
        const value = (await response.json()) as HighlightState;
        if (value.content !== text)
          throw new Error("内容已更新，请刷新页面后重新选择。");
        if (!controller.signal.aborted) setSaved(value);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [url, text, retry]);

  useEffect(() => {
    if (!selection) return;
    function dismiss(event: Event) {
      if (
        event.type === "pointerdown" &&
        (root.current?.contains(event.target as Node) ||
          palette.current?.contains(event.target as Node))
      )
        return;
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape")
        return;
      if (
        event.type === "scroll" &&
        palette.current?.contains(event.target as Node)
      )
        return;
      setSelection(null);
      if (event.type === "keydown")
        root.current?.focus({ preventScroll: true });
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    function selectionChanged() {
      if (!selection?.existing && window.getSelection()?.isCollapsed) {
        setSelection(null);
      }
    }
    document.addEventListener("selectionchange", selectionChanged);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("selectionchange", selectionChanged);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [selection]);

  function open(start: number, end: number, rect: DOMRect, existing: boolean) {
    setNotice("");
    setSelection({
      start,
      end,
      existing,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 352)),
      top: Math.max(
        12,
        rect.bottom + 128 > window.innerHeight
          ? rect.top - 120
          : rect.bottom + 8,
      ),
    });
  }

  function captureSelection() {
    if (busy || readOnly) return;
    const browserSelection = window.getSelection();
    if (
      !root.current ||
      !browserSelection?.rangeCount ||
      browserSelection.isCollapsed
    ) {
      setSelection(null);
      return;
    }
    const range = browserSelection.getRangeAt(0);
    if (
      !root.current.contains(range.startContainer) ||
      !root.current.contains(range.endContainer)
    ) {
      setSelection(null);
      return;
    }
    const before = range.cloneRange();
    before.selectNodeContents(root.current);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const end = start + range.toString().length;
    if (text.slice(start, end).trim())
      open(start, end, range.getBoundingClientRect(), false);
  }

  async function paint(color: HighlightColor | null) {
    if (!selection || !saved || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: text,
          revision: saved.revision,
          start: selection.start,
          end: selection.end,
          color,
        }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "内容或标记已更新，请刷新后重新选择。"
            : "标记未保存，请重试。",
        );
      }
      setSaved((await response.json()) as HighlightState);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      setNotice(color ? "重点已保存" : "重点已取消");
      root.current?.focus({ preventScroll: true });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "标记未保存，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  const highlights = saved?.content === text ? saved.highlights : [];
  const selectedColor = selection
    ? highlights.find(
        (item) => item.start <= selection.start && item.end >= selection.end,
      )?.color
    : undefined;
  const validEvidence =
    evidence && text.slice(evidence.start, evidence.end) === evidence.quote
      ? evidence
      : null;
  function renderText(from: number, to: number) {
    const boundaries = [
      ...new Set([
        from,
        to,
        ...highlights
          .flatMap(({ start, end }) => [start, end])
          .filter((offset) => offset > from && offset < to),
      ]),
    ].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1]!;
      const highlight = highlights.find(
        (item) => item.start <= start && item.end >= end,
      );
      const content = text.slice(start, end);
      return highlight ? (
        <mark
          key={start}
          className="user-text-highlight"
          data-color={highlight.color}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : 0}
          aria-label={`${colorNames[highlight.color]}重点：${content}${readOnly ? "" : "，点击修改"}`}
          onClick={(event) => {
            if (!window.getSelection()?.isCollapsed || busy || readOnly) return;
            open(
              highlight.start,
              highlight.end,
              event.currentTarget.getBoundingClientRect(),
              true,
            );
          }}
          onKeyDown={(event) => {
            if (readOnly) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open(
                highlight.start,
                highlight.end,
                event.currentTarget.getBoundingClientRect(),
                true,
              );
              window.requestAnimationFrame(() =>
                palette.current
                  ?.querySelector<HTMLButtonElement>(
                    `button[data-color="${highlight.color}"]`,
                  )
                  ?.focus(),
              );
            }
          }}
        >
          {content}
        </mark>
      ) : (
        <Fragment key={start}>{content}</Fragment>
      );
    });
  }

  return (
    <>
      <span
        className="highlightable-text"
        data-highlight-text={target}
        onPointerUp={captureSelection}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow") || event.key === "Shift")
            captureSelection();
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab" && selection && !event.shiftKey) {
            const button = palette.current?.querySelector<HTMLButtonElement>(
              "button:not(:disabled)",
            );
            if (button) {
              event.preventDefault();
              button.focus();
            }
          }
        }}
        ref={root}
        tabIndex={readOnly ? undefined : 0}
        title={
          readOnly ? undefined : "选中文字标记重点；点击已有重点可换色或取消"
        }
      >
        {validEvidence ? (
          <>
            {renderText(0, validEvidence.start)}
            <mark data-marker={marker} className="source-evidence-highlight">
              {renderText(validEvidence.start, validEvidence.end)}
            </mark>
            {renderText(validEvidence.end, text.length)}
          </>
        ) : (
          renderText(0, text.length)
        )}
      </span>
      {error && !selection ? (
        <span className="highlight-load-error" role="alert">
          {error}
          {!saved ? (
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              重试
            </button>
          ) : null}
        </span>
      ) : null}
      <span className="visually-hidden" role="status">
        {notice}
      </span>
      {selection
        ? createPortal(
            <div
              className="text-highlight-palette"
              aria-label="标记重点"
              role="dialog"
              ref={palette}
              style={{ left: selection.left, top: selection.top }}
            >
              <div className="text-highlight-palette-heading">
                <strong>{selection.existing ? "修改重点" : "标记重点"}</strong>
                <span>
                  {busy ? "保存中…" : saved ? "选择颜色 · 自动保存" : "载入中…"}
                </span>
              </div>
              <div className="text-highlight-colors">
                {highlightColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    data-color={color}
                    aria-label={`${colorNames[color]}高亮`}
                    aria-pressed={selectedColor === color}
                    title={colorNames[color]}
                    disabled={busy || !saved}
                    onClick={() => void paint(color)}
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <span aria-hidden="true">
                      {selectedColor === color ? "✓" : ""}
                    </span>
                  </button>
                ))}
                {highlights.some(
                  (item) =>
                    item.start < selection.end && item.end > selection.start,
                ) ? (
                  <button
                    type="button"
                    className="text-highlight-remove"
                    disabled={busy || !saved}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void paint(null)}
                  >
                    取消重点
                  </button>
                ) : null}
              </div>
              {error ? (
                <span role="alert" className="text-highlight-error">
                  {error}
                  {!saved ? (
                    <button
                      type="button"
                      onClick={() => setRetry((value) => value + 1)}
                    >
                      重试
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
