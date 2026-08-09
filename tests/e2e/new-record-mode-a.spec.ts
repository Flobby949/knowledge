import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("new record with automatic AI organization", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user stays in the library after saving and can follow the background organization", async ({
    page,
    request,
  }) => {
    const marker = `new-mode-a-${randomUUID().slice(0, 8)}`;
    const firstQuote = `CDC 读取数据库事务日志 ${marker}。`;
    const secondQuote = `事务日志记录增量变更并保留提交顺序 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;
    const tagName = `自动整理 ${marker}`;
    const expectedPoints = [
      { title: "CDC 如何获取数据库变更", body: firstQuote },
      { title: "事务日志保留哪些信息", body: secondQuote },
    ];

    await enableDeterministicFakeConfiguration(request);
    await page.goto(appUrl("/records"));

    const navigation = page.getByRole("navigation", { name: "主导航" });

    await navigation.getByRole("button", { name: "新建记录" }).click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });
    const contentPane = dialog.getByRole("group", { name: "记录内容" });
    const optionsPane = dialog.getByRole("group", {
      name: "标签与处理方式",
    });
    const textInput = dialog.getByRole("textbox", { name: "记录正文" });
    const saveOnly = dialog.getByRole("radio", { name: /^仅保存/u });
    const automatic = dialog.getByRole("radio", {
      name: /^AI 整理并自动采用/u,
    });
    const review = dialog.getByRole("radio", {
      name: /^AI 整理后由我确认/u,
    });
    const saveButton = dialog.getByRole("button", {
      name: "保存记录",
      exact: true,
    });

    await expectBox(dialog, {
      x: 240,
      y: 150,
      width: 1_120,
      height: 700,
    });
    await expectHorizontalSplit(contentPane, optionsPane, {
      leftRatio: 0.64,
      gap: 32,
    });
    await expect(textInput).toBeFocused();
    await expect(saveOnly).toBeEnabled();
    await expect(automatic).toBeEnabled();
    await expect(review).toBeEnabled();
    await expect(automatic).toBeChecked();

    await saveOnly.check();
    await expect(saveOnly).toBeChecked();
    await review.check();
    await expect(review).toBeChecked();
    await automatic.check();
    await expect(automatic).toBeChecked();

    await textInput.fill(sourceText);
    await dialog.getByRole("combobox", { name: "我的标签" }).fill(tagName);
    await dialog
      .getByRole("button", { name: "创建标签", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", {
        name: `移除标签 ${tagName}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(saveButton).toBeEnabled();

    await saveButton.click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(appUrl("/records"));

    const saveNotice = page.getByRole("status", {
      name: "记录保存结果",
    });

    await expect(saveNotice).toContainText("已保存，AI 正在处理");
    const recordLink = saveNotice.getByRole("link", {
      name: "查看记录",
      exact: true,
    });
    await expect(recordLink).toBeVisible();
    await recordLink.click();
    await expect(page).toHaveURL(/\/records\/[^/?#]+$/u);

    const detailUrl = page.url();
    const toolbar = page.getByRole("toolbar", { name: "记录操作" });
    const processingStatus = toolbar.getByLabel("处理状态", {
      exact: true,
    });

    await expect(processingStatus).toHaveText(
      /原文已保存 · (?:等待整理|正在整理)/u,
    );
    await toolbar
      .getByRole("link", { name: "返回记录库", exact: true })
      .click();
    await expect(page).toHaveURL(appUrl("/records"));

    await page.goBack();
    await expect(page).toHaveURL(detailUrl);

    const restoredToolbar = page.getByRole("toolbar", { name: "记录操作" });
    const completedStatus = restoredToolbar.getByLabel("处理状态", {
      exact: true,
    });

    await expect(completedStatus).toHaveText("AI 整理完成");
    await expect(page).toHaveURL(detailUrl);

    const detail = page.getByRole("main", { name: "记录详情" });
    const recordPane = detail.getByRole("region", { name: "记录与原文" });
    const knowledgePane = detail.getByRole("region", { name: "知识点" });
    const articles = knowledgePane.getByRole("article");

    await expect(
      recordPane.getByRole("heading", {
        name: "CDC 与事务日志",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await recordPane.getByLabel("完整原文", { exact: true }).textContent(),
    ).toBe(sourceText);
    await expect(articles).toHaveCount(expectedPoints.length);

    for (const [index, point] of expectedPoints.entries()) {
      const article = articles.nth(index);

      await expect(
        article.getByRole("heading", { name: point.title, exact: true }),
      ).toBeVisible();
      await expect(
        article.getByLabel("知识点正文", { exact: true }),
      ).toHaveText(point.body);
      await expect(
        article.getByLabel("发布状态", { exact: true }),
      ).toHaveText("AI 自动发布");
    }
  });

  test("an organization start failure still acknowledges the saved source", async ({
    page,
    request,
  }) => {
    const marker = `new-mode-a-failure-${randomUUID().slice(0, 8)}`;
    const sourceText = `组织任务暂不可用时仍保留原文 ${marker}`;
    const tagName = `失败保护 ${marker}`;

    await enableDeterministicFakeConfiguration(request);
    await page.route(/\/api\/v1\/records\/[^/]+\/organize$/u, async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          error: { code: "ORGANIZATION_UNAVAILABLE", message: "E2E failure" },
        }),
        contentType: "application/json",
        status: 503,
      });
    });
    await page.goto(appUrl("/records"));
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录" })
      .click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });

    await dialog.getByRole("textbox", { name: "记录正文" }).fill(sourceText);
    await dialog.getByRole("combobox", { name: "我的标签" }).fill(tagName);
    await dialog.getByRole("button", { name: "创建标签" }).click();
    await dialog.getByRole("button", { name: "保存记录" }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(appUrl("/records"));

    const saveNotice = page.getByRole("status", {
      name: "记录保存结果",
    });

    await expect(saveNotice).toContainText("已保存，但 AI 整理未启动");
    await expect(
      saveNotice.getByRole("link", { name: "查看记录", exact: true }),
    ).toBeVisible();
  });
});

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  // Port 9 is loopback-only and intentionally unused. E2E_FAKE_AI=1 must
  // intercept endpoint checks and generation before any network request.
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
    expect(await tested.json()).toMatchObject({ kind, status: "passed" });
  }

  const activated = await request.post(
    appUrl("/api/v1/model-config/draft/activate"),
  );

  expect(activated.status()).toBe(200);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
