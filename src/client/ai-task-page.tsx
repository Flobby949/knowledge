import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  listAiTasks,
  retryAiTask,
  type AiTaskListItem,
  type AiTaskStatus,
} from "./ai-task-api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./ai-task-page.css";

type TaskStatusFilter = "all" | AiTaskStatus;

const REFRESH_INTERVAL_MS = 1_000;

export function AiTaskPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = parseStatusFilter(searchParams.get("status"));
  const [tasks, setTasks] = useState<AiTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyTaskId, setBusyTaskId] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const newRecordButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;

    async function refresh() {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;
      try {
        const items = await listAiTasks("all", controller.signal);

        setTasks(items);
        setLoadError("");
      } catch (error) {
        if (!isAbortError(error)) {
          setLoadError("AI 任务列表暂时无法载入，请稍后重试。");
        }
      } finally {
        requestInFlight = false;
        setLoading(false);
      }
    }

    setLoading(true);
    void refresh();
    const interval = window.setInterval(
      () => void refresh(),
      REFRESH_INTERVAL_MS,
    );

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [reloadVersion]);

  async function retry(task: AiTaskListItem) {
    setBusyTaskId(task.id);
    setActionError("");

    try {
      await retryAiTask(task.id);
      setReloadVersion((version) => version + 1);
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

  function changeStatus(nextStatus: TaskStatusFilter) {
    const next = new URLSearchParams(searchParams);

    if (nextStatus === "all") {
      next.delete("status");
    } else {
      next.set("status", nextStatus);
    }

    setSearchParams(next);
  }

  const visibleTasks =
    status === "all" ? tasks : tasks.filter((task) => task.status === status);

  return (
    <div className="ai-task-page-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
      />

      <main className="ai-task-page-main">
        <header className="ai-task-page-heading">
          <div>
            <p>后台整理进度与恢复</p>
            <h1>AI 任务</h1>
            <span>查看每次整理的状态；失败不会影响已经保存的原文。</span>
          </div>

          <label className="ai-task-status-filter">
            <span>任务状态</span>
            <select
              aria-label="任务状态"
              onChange={(event) =>
                changeStatus(event.target.value as TaskStatusFilter)
              }
              value={status}
            >
              <option value="all">全部状态</option>
              <option value="queued">排队中</option>
              <option value="running">运行中</option>
              <option value="failed">失败</option>
              <option value="succeeded">已完成</option>
            </select>
          </label>
        </header>

        <div className="ai-task-list-heading">
          <span>{status === "all" ? "最近任务" : statusLabel(status)}</span>
          <output>{loading ? "正在同步" : `${visibleTasks.length} 项`}</output>
        </div>

        {loadError ? (
          <p className="ai-task-page-error" role="alert">
            {loadError}
          </p>
        ) : null}
        {actionError ? (
          <p className="ai-task-page-error" role="alert">
            {actionError}
          </p>
        ) : null}

        <section aria-label="AI 任务列表" className="ai-task-list" role="region">
          {loading && tasks.length === 0 ? (
            <p className="ai-task-page-feedback" role="status">
              正在载入 AI 任务…
            </p>
          ) : null}

          {!loading && !loadError && visibleTasks.length === 0 ? (
            <div className="ai-task-empty" role="status">
              <span aria-hidden="true" className="ai-task-empty-signal">
                <i />
              </span>
              <div>
                <h2>{emptyStateTitle(status)}</h2>
                <p>{emptyStateCopy(status)}</p>
              </div>
            </div>
          ) : null}

          {visibleTasks.map((task) => (
            <AiTaskRow
              busy={busyTaskId === task.id}
              key={task.id}
              onRetry={() => void retry(task)}
              task={task}
            />
          ))}
        </section>
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

function AiTaskRow({
  busy,
  onRetry,
  task,
}: {
  busy: boolean;
  onRetry: () => void;
  task: AiTaskListItem;
}) {
  return (
    <article className="ai-task-row">
      <div className="ai-task-row-state">
        <span
          aria-hidden="true"
          className={`ai-task-row-mark is-${task.status}`}
        />
        <strong className={`is-${task.status}`}>{statusLabel(task.status)}</strong>
        <time dateTime={task.createdAt}>{formatDate(task.createdAt)}</time>
      </div>

      <div className="ai-task-row-content">
        <h2>{task.record.title}</h2>
        <p>
          原文 v{task.sourceTextVersion}
          <span aria-hidden="true"> · </span>
          {task.handling === "automatic" ? "自动采用" : "人工确认"}
        </p>
        {task.failure ? (
          <div className="ai-task-row-failure">
            <span>失败详情</span>
            <p>{task.failure.message ?? "AI 服务未返回具体失败原因。"}</p>
            <code>{task.failure.code}</code>
          </div>
        ) : null}
      </div>

      <div className="ai-task-row-actions">
        <Link
          aria-label={`打开记录：${task.record.title}`}
          to={`/records/${task.record.id}`}
        >
          打开记录
        </Link>
        {task.canRetry ? (
          <button
            aria-label={`重试 AI 整理：${task.record.title}`}
            disabled={busy}
            onClick={onRetry}
            type="button"
          >
            {busy ? "正在重试…" : "重试 AI 整理"}
          </button>
        ) : task.retryTaskId ? (
          <span>已发起重试</span>
        ) : null}
      </div>
    </article>
  );
}

function statusLabel(status: TaskStatusFilter): string {
  if (status === "all") {
    return "全部状态";
  }

  if (status === "queued") {
    return "排队中";
  }

  if (status === "running") {
    return "运行中";
  }

  return status === "failed" ? "失败" : "已完成";
}

function parseStatusFilter(value: string | null): TaskStatusFilter {
  return value === "queued" ||
    value === "running" ||
    value === "failed" ||
    value === "succeeded"
    ? value
    : "all";
}

function emptyStateTitle(status: TaskStatusFilter): string {
  return status === "all" ? "还没有 AI 整理任务" : `没有${statusLabel(status)}的任务`;
}

function emptyStateCopy(status: TaskStatusFilter): string {
  return status === "all"
    ? "保存记录时选择 AI 整理，任务进度会出现在这里。"
    : "切换到其他状态，查看最近的整理进度。";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
