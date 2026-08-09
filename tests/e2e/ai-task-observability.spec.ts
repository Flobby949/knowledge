import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("global AI task observability", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user opens a failed task from the global pulse and retries it to completion", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);
    const gateId = randomUUID().slice(0, 8);
    const recordTitle = `可观察 AI 任务 ${gateId}`;
    const recordId = await createRecord(
      request,
      `${recordTitle}\nE2E_AI_TASK_RETRY ${gateId}`,
    );
    const failedTaskId = await startOrganization(request, recordId);

    await waitForTaskStatus(request, failedTaskId, "failed");
    await page.goto(appUrl("/records"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const pulse = navigation.getByRole("button", {
      name: "AI 任务：1 项需关注",
      exact: true,
    });

    await expect(pulse).toBeVisible();
    await pulse.click();

    const popover = page.getByRole("region", { name: "AI 任务状态" });

    await expect(popover.getByRole("heading", { name: "AI 任务" })).toBeVisible();
    await expect(popover.getByText(recordTitle, { exact: true })).toBeVisible();
    await expect(popover.getByText("失败", { exact: true })).toBeVisible();
    await expect(
      popover.getByText("E2E 模拟 AI 服务暂时不可用", { exact: true }),
    ).toBeVisible();
    await expect(
      popover.getByRole("link", { name: `打开记录：${recordTitle}` }),
    ).toHaveAttribute("href", `/records/${recordId}`);

    await popover.getByRole("link", { name: "查看全部任务" }).click();

    await expect(page).toHaveURL(appUrl("/ai-tasks"));
    await expect(
      page.getByRole("heading", { name: "AI 任务", exact: true }),
    ).toBeVisible();

    const statusFilter = page.getByRole("combobox", { name: "任务状态" });

    for (const status of ["全部状态", "排队中", "运行中", "失败", "已完成"]) {
      await expect(statusFilter.getByRole("option", { name: status })).toHaveCount(1);
    }

    const list = page.getByRole("region", { name: "AI 任务列表" });
    const failedItem = list.getByRole("article").filter({
      hasText: "E2E 模拟 AI 服务暂时不可用",
    });

    await expect(failedItem).toContainText("失败");
    await expect(failedItem).toContainText("E2E 模拟 AI 服务暂时不可用");
    await failedItem
      .getByRole("button", { name: `重试 AI 整理：${recordTitle}` })
      .click();

    await expect
      .poll(async () => {
        const response = await request.get(
          appUrl(`/api/v1/e2e/ai-gates/${gateId}`),
        );

        return response.ok()
          ? ((await response.json()) as { started: boolean }).started
          : false;
      })
      .toBe(true);
    await expect(list).toContainText("运行中");

    const released = await request.post(
      appUrl(`/api/v1/e2e/ai-gates/${gateId}/release`),
    );

    expect(released.status()).toBe(204);
    await expect(list).toContainText("已完成", { timeout: 10_000 });
    await expect(failedItem).toContainText("已发起重试");
    await expect(
      failedItem.getByRole("button", { name: /重试 AI 整理/u }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: /AI 任务/u }),
    ).toHaveCount(0, { timeout: 10_000 });

    await statusFilter.selectOption("succeeded");

    await expect(page).toHaveURL(appUrl("/ai-tasks?status=succeeded"));
    await expect(list.getByRole("article")).toHaveCount(1);
    await expect(list.getByRole("article")).toContainText("CDC 与事务日志");
    await expect(list.getByRole("article")).toContainText("已完成");
    await expect(list).not.toContainText("E2E 模拟 AI 服务暂时不可用");

    await list
      .getByRole("link", { name: "打开记录：CDC 与事务日志" })
      .click();
    await expect(page).toHaveURL(appUrl(`/records/${recordId}`));
  });
});

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: "http://127.0.0.1:9/e2e-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "e2e-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/e2e-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "e2e-fake-embedding-key",
      },
    },
  });

  expect(saved.status()).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    const tested = await request.post(
      appUrl(`/api/v1/model-config/draft/tests/${kind}`),
    );

    expect(tested.status()).toBe(200);
  }

  const activated = await request.post(
    appUrl("/api/v1/model-config/draft/activate"),
  );

  expect(activated.status()).toBe(200);
}

async function createRecord(
  request: APIRequestContext,
  text: string,
): Promise<string> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: [{ name: "任务追踪" }],
      processing: "save_only",
    },
  });

  expect(response.status()).toBe(201);

  return ((await response.json()) as { record: { id: string } }).record.id;
}

async function startOrganization(
  request: APIRequestContext,
  recordId: string,
): Promise<string> {
  const response = await request.post(
    appUrl(`/api/v1/records/${recordId}/organize`),
    { data: { handling: "automatic" } },
  );

  expect(response.status()).toBe(202);

  return ((await response.json()) as { task: { id: string } }).task.id;
}

async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  expected: "failed" | "succeeded",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(appUrl(`/api/v1/ai-tasks/${taskId}`));
    const task = (await response.json()) as { task: { status: string } };

    if (task.task.status === expected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`AI task ${taskId} did not reach ${expected}`);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
