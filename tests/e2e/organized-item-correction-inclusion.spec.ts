import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("published knowledge correction and reversible exclusion", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user corrects, excludes, and restores one published knowledge point", async ({
    page,
    request,
  }) => {
    const marker = `correction-ui-${randomUUID().slice(0, 8)}`;
    const firstQuote = `CDC 读取数据库事务日志 ${marker}。`;
    const secondQuote = `事务日志记录增量变更并保留提交顺序 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;
    const aiTitle = "CDC 如何获取数据库变更";
    const correctedTitle = `CDC 变更捕获的用户修正 ${marker}`;
    const correctionOnlyTerm = `用户观察项-${marker}`;
    const correctedBody = [
      `这是用户补充判断：${correctionOnlyTerm}。`,
      `<b>这仍是纯文本 ${marker}</b>`,
    ].join("\n");

    await enableDeterministicFakeConfiguration(request);

    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceText,
        myTags: [{ name: `数据工程 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const recordId = ((await created.json()) as { record: { id: string } })
      .record.id;
    const organized = await request.post(
      appUrl(`/api/v1/records/${recordId}/organize`),
      { data: { handling: "automatic" } },
    );

    expect(organized.status()).toBe(202);

    const taskId = ((await organized.json()) as { task: { id: string } }).task
      .id;

    await expectTaskSucceeded(request, taskId);
    await page.goto(appUrl(`/records/${recordId}`));

    const detailUrl = page.url();
    const detail = page.getByRole("main", { name: "记录详情" });
    const recordPane = detail.getByRole("region", { name: "记录与原文" });
    const knowledgePane = detail.getByRole("region", { name: "知识点" });
    const currentKnowledge = knowledgePane.getByRole("group", {
      name: "当前采用的知识点",
    });
    const currentArticles = currentKnowledge.getByRole("article");
    const rawText = recordPane.getByLabel("完整原文", { exact: true });

    await expectHorizontalSplit(recordPane, knowledgePane, {
      leftRatio: 0.58,
      gap: 0,
      ratioTolerance: 0.02,
    });
    await expect(currentArticles).toHaveCount(2);

    for (const article of await currentArticles.all()) {
      await expect(
        article.getByRole("button", { name: "修正", exact: true }),
      ).toBeVisible();
      await expect(
        article.getByRole("button", { name: "暂不采用", exact: true }),
      ).toBeVisible();
    }

    let firstArticle = currentArticles.filter({ hasText: aiTitle });
    const selectFirst = firstArticle.getByRole("button", {
      name: `选择知识点：${aiTitle}`,
      exact: true,
    });

    await selectFirst.click();
    await expect(rawText.locator("mark")).toHaveText(firstQuote);
    await firstArticle
      .getByRole("button", { name: "修正", exact: true })
      .click();

    const correctionDialog = page.getByRole("dialog", { name: "修正知识点" });
    const titleInput = correctionDialog.getByRole("textbox", {
      name: "知识点标题",
    });
    const bodyInput = correctionDialog.getByRole("textbox", {
      name: "知识点正文",
    });
    const aiOriginal = correctionDialog.getByRole("region", {
      name: "AI 原值",
    });

    await expectBox(correctionDialog, {
      x: 360,
      y: 190,
      width: 880,
      height: 620,
    });
    await expect(titleInput).toHaveValue(aiTitle);
    await expect(bodyInput).toHaveValue(firstQuote);
    await expect(
      aiOriginal.getByRole("heading", { name: aiTitle, exact: true }),
    ).toBeVisible();
    await expect(aiOriginal).toContainText(firstQuote);

    await titleInput.fill(correctedTitle);
    await bodyInput.fill(correctedBody);
    await correctionDialog.press("Escape");

    let discardDialog = page.getByRole("alertdialog", {
      name: "放弃未保存的修正？",
    });

    await expect(discardDialog).toBeVisible();
    await discardDialog
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    await expect(titleInput).toHaveValue(correctedTitle);
    await expect(bodyInput).toHaveValue(correctedBody);

    await correctionDialog
      .getByRole("button", { name: "关闭修正知识点", exact: true })
      .click();
    discardDialog = page.getByRole("alertdialog", {
      name: "放弃未保存的修正？",
    });
    await expect(discardDialog).toBeVisible();
    await discardDialog
      .getByRole("button", { name: "继续编辑", exact: true })
      .click();
    await expect(bodyInput).toHaveValue(correctedBody);

    await correctionDialog
      .getByRole("button", { name: "保存修正", exact: true })
      .click();

    await expect(correctionDialog).toBeHidden();
    await expect(page).toHaveURL(detailUrl);
    firstArticle = currentArticles.filter({ hasText: correctedTitle });
    await expect(firstArticle).toHaveCount(1);
    await expect(firstArticle.getByLabel("发布状态", { exact: true })).toHaveText(
      "已确认",
    );
    await expect(firstArticle.getByText("用户修正", { exact: true })).toBeVisible();
    await expect(firstArticle.getByLabel("知识点正文", { exact: true })).toHaveText(
      correctedBody,
    );
    await expect(firstArticle.locator("b")).toHaveCount(0);
    await expect(
      firstArticle.getByRole("button", { name: "查看 AI 原值", exact: true }),
    ).toBeVisible();
    await expect(
      firstArticle.getByRole("button", {
        name: /AI 原始内容的证据/u,
      }),
    ).toBeVisible();
    await expect(
      firstArticle.getByRole("button", {
        name: `选择知识点：${correctedTitle}`,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(rawText.locator("mark")).toHaveText(firstQuote);
    await expectSearchRecordIds(request, correctionOnlyTerm, [recordId]);

    await firstArticle
      .getByRole("button", { name: "暂不采用", exact: true })
      .click();

    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(currentArticles).toHaveCount(1);

    const excludedToggle = knowledgePane.getByRole("button", {
      name: "已不采用 (1)",
      exact: true,
    });
    const inclusionNotice = page.getByRole("status", {
      name: "知识点采用状态",
    });

    await expect(excludedToggle).toHaveAttribute("aria-expanded", "false");
    await expect(inclusionNotice).toContainText("已暂不采用");
    await expect(
      inclusionNotice.getByRole("button", { name: "撤销", exact: true }),
    ).toBeVisible();
    await expect(rawText.locator("mark")).toHaveText(firstQuote);
    await expectSearchRecordIds(request, correctionOnlyTerm, []);

    await excludedToggle.click();

    const excludedRegion = knowledgePane.getByRole("group", {
      name: "已不采用的知识点",
    });
    const excludedArticle = excludedRegion.getByRole("article").filter({
      hasText: correctedTitle,
    });

    await expect(excludedToggle).toHaveAttribute("aria-expanded", "true");
    await expect(excludedArticle).toBeVisible();
    await excludedArticle
      .getByRole("button", { name: "恢复采用", exact: true })
      .click();

    await expect(currentArticles).toHaveCount(2);
    await expect(
      currentArticles
        .filter({ hasText: correctedTitle })
        .getByLabel("发布状态", { exact: true }),
    ).toHaveText("已确认");
    await expect(inclusionNotice).toContainText("已恢复采用");
    await expectSearchRecordIds(request, correctionOnlyTerm, [recordId]);

    const finalDetail = await request.get(appUrl(`/api/v1/records/${recordId}`));

    expect(finalDetail.status()).toBe(200);
    const finalBody = (await finalDetail.json()) as {
      organizedItems: Array<{
        publicationStatus: string;
        usageStatus: string;
        correction: null | { title: string; body: string };
      }>;
      excludedItems: unknown[];
    };

    expect(finalBody.excludedItems).toEqual([]);
    expect(
      finalBody.organizedItems.find(
        (item) => item.correction?.title === correctedTitle,
      ),
    ).toMatchObject({
      publicationStatus: "CONFIRMED",
      usageStatus: "INCLUDED",
      correction: {
        title: correctedTitle,
        body: correctedBody,
      },
    });
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

async function expectTaskSucceeded(
  request: APIRequestContext,
  taskId: string,
): Promise<void> {
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

async function expectSearchRecordIds(
  request: APIRequestContext,
  query: string,
  expected: string[],
): Promise<void> {
  await expect.poll(async () => {
    const search = new URLSearchParams({ q: query });
    const response = await request.get(appUrl(`/api/v1/search?${search}`));

    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      items: Array<{ record: { id: string } }>;
    };

    return body.items.map((item) => item.record.id);
  }).toEqual(expected);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
