import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  listAiTasks,
  retryAiTask,
  type AiTaskListItem,
} from "./ai-task-api.js";
import "./ai-task-pulse.css";

const REFRESH_INTERVAL_MS = 1_000;

export function AiTaskPulse() {
  const [tasks, setTasks] = useState<AiTaskListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState("");
  const [actionError, setActionError] = useState("");
  const pulse = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const items = await listAiTasks("attention", signal);

    setTasks(items);
    if (items.length === 0) {
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

  if (tasks.length === 0) {
    return null;
  }

  const visibleTasks = tasks.slice(0, 5);

  return (
    <div className="ai-task-pulse" ref={root}>
      <button
        aria-controls="ai-task-status-popover"
        aria-expanded={open}
        aria-label={`AI 任务：${tasks.length} 项需关注`}
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
        <strong>{tasks.length}</strong>
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
              <p>{tasks.length} 项正在处理或需要恢复</p>
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
          </ol>

          {actionError ? (
            <p className="ai-task-popover-error" role="alert">
              {actionError}
            </p>
          ) : null}

          <footer>
            <Link to="/ai-tasks">查看全部任务</Link>
          </footer>
        </section>
      ) : null}
    </div>
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
