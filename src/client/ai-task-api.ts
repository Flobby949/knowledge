export type AiTaskStatus = "queued" | "running" | "failed" | "succeeded";

export interface AiTaskAttempt {
  id: string;
  recordId: string;
  handling: "automatic" | "review";
  status: AiTaskStatus;
  sourceTextVersion: number;
  modelConfigurationVersion: number;
  retryOfTaskId: string | null;
  failure?: { code: string; message: string | null };
}

export interface AiTaskListItem extends AiTaskAttempt {
  record: { id: string; title: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  retryTaskId: string | null;
  canRetry: boolean;
}

export async function listAiTasks(
  scope: "all" | "attention",
  signal?: AbortSignal,
): Promise<AiTaskListItem[]> {
  const search = new URLSearchParams({ scope });
  const response = await fetch(`/api/v1/ai-tasks?${search.toString()}`, {
    ...(signal ? { signal } : {}),
  });
  const body = await parseResponse<{ items: AiTaskListItem[] }>(response);

  return body.items;
}

export async function retryAiTask(taskId: string): Promise<AiTaskAttempt> {
  const response = await fetch(
    `/api/v1/ai-tasks/${encodeURIComponent(taskId)}/retry`,
    { method: "POST" },
  );
  const body = await parseResponse<{ task: AiTaskAttempt }>(response);

  return body.task;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: unknown };
    };

    if (
      body.error &&
      typeof body.error === "object" &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }
  } catch {
    // The HTTP status is sufficient when no structured message is available.
  }

  return `请求失败（${response.status}）`;
}
