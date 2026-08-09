import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("source revision lag evidence", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user verifies evidence against its real historical source and can organize the current source", async ({
    page,
    request,
  }) => {
    const marker = `old-evidence-${randomUUID().slice(0, 8)}`;
    const firstQuote = `CDC 从事务日志读取数据库变更 ${marker}。`;
    const secondQuote = `消费者按提交顺序处理增量 ${marker}。`;
    const sourceV1 = `${firstQuote}\n${secondQuote}`;
    const sourceV2 = [
      `当前版本改写了开头，不得把旧 offset 迁移到这里 ${marker}。`,
      `当前版本保留新的核验语境 ${marker}。`,
    ].join("\n");
    const tagName = `来源核验 ${marker}`;

    await enableDeterministicFakeConfiguration(request);

    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceV1,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const createdBody = (await created.json()) as {
      record: {
        id: string;
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const recordId = createdBody.record.id;
    const tag = createdBody.record.myTags[0];

    if (!tag) {
      throw new Error("created record must expose its required user tag");
    }

    await organizeAndWait(request, recordId);

    const edited = await request.put(appUrl(`/api/v1/records/${recordId}`), {
      data: {
        text: sourceV2,
        myTags: [{ id: tag.id }],
        processing: "save_only",
      },
    });

    expect(edited.status()).toBe(200);
    await page.goto(appUrl(`/records/${recordId}`));

    const detail = page.getByRole("main", { name: "记录详情" });
    const recordPane = detail.getByRole("region", {
      name: "记录与原文",
      exact: true,
    });
    const knowledgePane = detail.getByRole("region", {
      name: "知识点",
      exact: true,
    });
    const rawText = recordPane.getByLabel("完整原文", { exact: true });
    const firstPoint = knowledgePane.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "CDC 如何获取数据库变更",
        exact: true,
      }),
    });
    const selectFirstPoint = firstPoint.getByRole("button", {
      name: "选择知识点：CDC 如何获取数据库变更",
      exact: true,
    });

    await expect(
      recordPane.getByRole("heading", {
        name: "CDC 与事务日志",
        exact: true,
      }),
    ).toBeVisible();
    await expect(recordPane.getByText("数据库变更捕获与事务日志的整理结果。", {
      exact: true,
    })).toBeVisible();
    await expect(
      recordPane.getByRole("list", { name: "我的标签" }).getByText(tagName, {
        exact: true,
      }),
    ).toBeVisible();
    expect(await rawText.textContent()).toBe(sourceV2);

    await selectFirstPoint.click();

    const lagStatus = recordPane.getByRole("region", {
      name: "来源版本提示",
      exact: true,
    });

    await expect(lagStatus).toContainText("此知识点基于 v1，当前原文为 v2");
    await expect(
      recordPane.getByLabel("当前显示原文版本", { exact: true }),
    ).toHaveText("v1");
    expect(await rawText.textContent()).toBe(sourceV1);
    await expect(rawText.locator("mark")).toHaveCount(1);
    await expect(rawText.locator("mark")).toHaveText(firstQuote);
    await expect(selectFirstPoint).toHaveAttribute("aria-pressed", "true");

    // Only the source block travels back. The effective record context stays current.
    await expect(
      recordPane.getByRole("heading", {
        name: "CDC 与事务日志",
        exact: true,
      }),
    ).toBeVisible();
    await expect(recordPane.getByText("数据库变更捕获与事务日志的整理结果。", {
      exact: true,
    })).toBeVisible();
    await expect(
      recordPane.getByRole("list", { name: "我的标签" }).getByText(tagName, {
        exact: true,
      }),
    ).toBeVisible();

    await lagStatus
      .getByRole("button", { name: "返回当前原文", exact: true })
      .click();

    await expect(lagStatus).toBeHidden();
    await expect(
      recordPane.getByLabel("当前显示原文版本", { exact: true }),
    ).toHaveText("v2");
    expect(await rawText.textContent()).toBe(sourceV2);
    await expect(rawText.locator("mark")).toHaveCount(0);
    await expect(selectFirstPoint).toHaveAttribute("aria-pressed", "true");

    await selectFirstPoint.click();
    await expect(lagStatus).toBeVisible();

    const organizeResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/records/${recordId}/organize`,
    );

    await lagStatus
      .getByRole("button", { name: "整理最新原文", exact: true })
      .click();

    const organizeResponse = await organizeResponsePromise;

    expect(organizeResponse.status()).toBe(202);
    expect(await organizeResponse.json()).toMatchObject({
      task: { sourceTextVersion: 2 },
    });
    await expect(lagStatus).toBeHidden();
    expect(await rawText.textContent()).toBe(sourceV2);
    await expect(
      page.getByRole("toolbar", { name: "记录操作" }).getByLabel("处理状态"),
    ).toHaveText("AI 整理完成", { timeout: 10_000 });
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

async function organizeAndWait(
  request: APIRequestContext,
  recordId: string,
): Promise<void> {
  const organized = await request.post(
    appUrl(`/api/v1/records/${recordId}/organize`),
    { data: { handling: "automatic" } },
  );

  expect(organized.status()).toBe(202);
  const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(
      appUrl(`/api/v1/ai-tasks/${encodeURIComponent(taskId)}`),
    );
    const body = (await response.json()) as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (body.task.status === "succeeded") {
      return;
    }

    if (body.task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
