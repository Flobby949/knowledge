import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  listAiTasks,
  retryAiTask,
  type AiTaskListItem,
} from "./ai-task-api.js";
import {
  listConceptCandidateScans,
  type ConceptCandidateScan,
} from "./api.js";
import "./ai-task-pulse.css";

const REFRESH_INTERVAL_MS = 1_000;

export function AiTaskPulse() {
  const [tasks, setTasks] = useState<AiTaskListItem[]>([]);
  const [candidateScans, setCandidateScans] = useState<ConceptCandidateScan[]>([]);
  const [open, setOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState("");
  const [actionError, setActionError] = useState("");
  const pulse = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [items, scans] = await Promise.all([
      listAiTasks("attention", signal),
      listConceptCandidateScans("attention", signal),
    ]);

    setTasks(items);
    setCandidateScans(scans);
    if (items.length + scans.length === 0) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;

    async function poll() {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;
      try {
        await refresh(controller.signal);
      } catch (error) {
        if (!isAbortError(error)) {
          // A transient pulse failure must not block the global navigation.
        }
      } finally {
        requestInFlight = false;
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), REFRESH_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeAndRestoreFocus() {
      setOpen(false);
      window.requestAnimationFrame(() => pulse.current?.focus());
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  async function retry(task: AiTaskListItem) {
    setBusyTaskId(task.id);
    setActionError("");

    try {
      await retryAiTask(task.id);
      await refresh();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "AI 任务暂时无法重试，请稍后再试。",
      );
    } finally {
      setBusyTaskId("");
    }
  }

  const attentionCount = tasks.length + candidateScans.length;

  if (attentionCount === 0) {
    return null;
  }

  const visibleTasks = tasks.slice(0, 4);
  const visibleCandidateScans = candidateScans.slice(0, 5 - visibleTasks.length);

  return (
    <div className="ai-task-pulse" ref={root}>
      <button
        aria-controls="ai-task-status-popover"
        aria-expanded={open}
        aria-label={`AI 任务：${attentionCount} 项需关注`}
        className="ai-task-pulse-button"
        onClick={() => {
          setActionError("");
          setOpen((current) => !current);
        }}
        ref={pulse}
        type="button"
      >
        <span aria-hidden="true" className="ai-task-pulse-signal" />
        <span>AI</span>
        <strong>{attentionCount}</strong>
      </button>

      {open ? (
        <section
          aria-label="AI 任务状态"
          className="ai-task-popover"
          id="ai-task-status-popover"
          role="region"
        >
          <header>
            <div>
              <h2>AI 任务</h2>
              <p>{attentionCount} 项正在处理、待确认或需要恢复</p>
            </div>
            <span aria-hidden="true" className="ai-task-popover-index">
              LIVE
            </span>
          </header>

          <ol>
            {visibleTasks.map((task) => (
              <li key={task.id}>
                <div className="ai-task-popover-row">
                  <span
                    aria-hidden="true"
                    className={`ai-task-state-mark is-${task.status}`}
                  />
                  <Link
                    aria-label={`打开记录：${task.record.title}`}
                    className="ai-task-record-link"
                    title={task.record.title}
                    to={`/records/${task.record.id}`}
                  >
                    {task.record.title}
                  </Link>
                  <span className={`ai-task-status is-${task.status}`}>
                    {statusLabel(task.status)}
                  </span>
                </div>
                {task.failure ? (
                  <p className="ai-task-failure">
                    {task.failure.message ?? "AI 服务未返回具体失败原因。"}
                  </p>
                ) : (
                  <p className="ai-task-progress-copy">
                    原文 v{task.sourceTextVersion} · {handlingLabel(task.handling)}
                  </p>
                )}
                {task.canRetry ? (
                  <button
                    aria-label={`重试 AI 整理：${task.record.title}`}
                    className="ai-task-retry"
                    disabled={busyTaskId === task.id}
                    onClick={() => void retry(task)}
                    type="button"
                  >
                    {busyTaskId === task.id ? "正在重试…" : "重试"}
                  </button>
                ) : null}
              </li>
            ))}
            {visibleCandidateScans.map((scan) => {
              const status = candidateStatus(scan);

              return (
                <li key={`candidate-${scan.id}`}>
                  <div className="ai-task-popover-row">
                    <span
                      aria-hidden="true"
                      className={`ai-task-state-mark is-${status}`}
                    />
                    <Link
                      aria-label={`打开 Concept Candidate：${candidateTitle(scan)}`}
                      className="ai-task-record-link"
                      title={candidateTitle(scan)}
                      to={`/concepts?view=candidates&scan=${scan.id}`}
                    >
                      {candidateTitle(scan)}
                    </Link>
                    <span className={`ai-task-status is-${status}`}>
                      {candidateStatusLabel(scan)}
                    </span>
                  </div>
                  <p className={scan.failure ? "ai-task-failure" : "ai-task-progress-copy"}>
                    {scan.failure?.message ??
                      `${scan.inputs.length} 个知识点 · Concept 候选扫描`}
                  </p>
                </li>
              );
            })}
          </ol>

          {actionError ? (
            <p className="ai-task-popover-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <footer>
            <Link to="/ai-tasks">查看全部任务</Link>
            <Link to="/concepts?view=candidates">Concept 候选</Link>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

function candidateStatus(
  scan: ConceptCandidateScan,
): "failed" | "queued" | "review" | "running" {
  if (scan.candidate?.reviewStatus === "pending") {
    return "review";
  }

  return scan.status === "succeeded" ? "review" : scan.status;
}

function candidateStatusLabel(scan: ConceptCandidateScan): string {
  if (scan.candidate?.reviewStatus === "pending") {
    return "待确认";
  }

  return statusLabel(scan.status);
}

function candidateTitle(scan: ConceptCandidateScan): string {
  return (
    scan.candidate?.name ??
    scan.inputs.slice(0, 2).map((input) => input.title).join(" · ") ??
    "Concept Candidate"
  );
}

function statusLabel(status: AiTaskListItem["status"]): string {
  if (status === "queued") {
    return "排队中";
  }

  if (status === "running") {
    return "运行中";
  }

  return status === "failed" ? "失败" : "已完成";
}

function handlingLabel(handling: AiTaskListItem["handling"]): string {
  return handling === "automatic" ? "自动采用" : "人工确认";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
