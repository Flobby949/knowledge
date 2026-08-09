import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
} from "./fixture.js";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("automatically organized record detail", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user reads every published knowledge point and selects grounded evidence", async ({
    page,
    request,
  }) => {
    const marker = `organized-detail-${randomUUID().slice(0, 8)}`;
    const firstQuote = `CDC 读取数据库事务日志 ${marker}。`;
    const secondQuote = `事务日志记录增量变更并保留提交顺序 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;
    const expectedPoints = [
      {
        title: "CDC 如何获取数据库变更",
        body: firstQuote,
        tags: ["CDC", "事务日志"],
        evidence: firstQuote,
      },
      {
        title: "事务日志保留哪些信息",
        body: secondQuote,
        tags: ["事务日志", "增量变更"],
        evidence: secondQuote,
      },
    ];

    await enableDeterministicFakeConfiguration(request);

    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceText,
        myTags: [{ name: `数据工程 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const createdBody = (await created.json()) as {
      record: { id: string };
    };
    const recordId = createdBody.record.id;
    const organized = await request.post(
      appUrl(`/api/v1/records/${recordId}/organize`),
      { data: { handling: "automatic" } },
    );

    expect(organized.status()).toBe(202);

    const organizedBody = (await organized.json()) as {
      task: { id: string };
    };

    await expectTaskSucceeded(request, organizedBody.task.id);
    await page.goto(appUrl(`/records/${recordId}`));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const toolbar = page.getByRole("toolbar", { name: "记录操作" });
    const detail = page.getByRole("main", { name: "记录详情" });
    const recordPane = detail.getByRole("region", { name: "记录与原文" });
    const knowledgePane = detail.getByRole("region", { name: "知识点" });
    const rawText = recordPane.getByLabel("完整原文", { exact: true });
    const articles = knowledgePane.getByRole("article");

    await expectBox(navigation, {
      x: 0,
      y: 0,
      width: 1_600,
      height: 60,
    });
    await expectBox(toolbar, { x: 0, y: 60, width: 1_600, height: 64 });
    await expectBox(detail, { x: 0, y: 124, width: 1_600 });
    await expectHorizontalSplit(recordPane, knowledgePane, {
      leftRatio: 0.58,
      gap: 0,
      ratioTolerance: 0.02,
    });

    await expect(articles).toHaveCount(expectedPoints.length);
    await expect(knowledgePane.getByRole("tablist")).toHaveCount(0);
    await expect(knowledgePane.getByRole("tab")).toHaveCount(0);
    expect(await rawText.textContent()).toBe(sourceText);

    for (const [index, point] of expectedPoints.entries()) {
      const article = articles.nth(index);
      const body = article.getByLabel("知识点正文", { exact: true });
      const tags = article
        .getByRole("list", { name: "AI 标签" })
        .getByRole("listitem");

      await expect(article).toBeVisible();
      await expect(
        article.getByRole("heading", {
          name: point.title,
          exact: true,
        }),
      ).toBeVisible();
      await expect(body).toBeVisible();
      expect(await body.textContent()).toBe(point.body);
      await expect(
        article.getByLabel("发布状态", { exact: true }),
      ).toHaveText("AI 自动发布");
      await expect(tags).toHaveCount(point.tags.length);
      expect(await tags.allTextContents()).toEqual(
        expect.arrayContaining(point.tags),
      );
      await expect(
        article.getByLabel("证据数量", { exact: true }),
      ).toHaveText("1 条证据");
    }

    const firstSelection = articles.nth(0).getByRole("button", {
      name: `选择知识点：${expectedPoints[0]!.title}`,
      exact: true,
    });

    await firstSelection.focus();
    await expect(firstSelection).toBeFocused();
    await firstSelection.press("Enter");
    await expect(firstSelection).toHaveAttribute("aria-pressed", "true");
    await expect(rawText.locator("mark")).toHaveCount(1);
    await expect(rawText.locator("mark")).toHaveText(
      expectedPoints[0]!.evidence,
    );
    expect(await rawText.textContent()).toBe(sourceText);

    const secondSelection = articles.nth(1).getByRole("button", {
      name: `选择知识点：${expectedPoints[1]!.title}`,
      exact: true,
    });

    await secondSelection.click();
    await expect(secondSelection).toHaveAttribute("aria-pressed", "true");
    await expect(firstSelection).toHaveAttribute("aria-pressed", "false");
    await expect(rawText.locator("mark")).toHaveCount(1);
    await expect(rawText.locator("mark")).toHaveText(
      expectedPoints[1]!.evidence,
    );
    expect(await rawText.textContent()).toBe(sourceText);
  });
});

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  // Port 9 is loopback-only and intentionally unused. With E2E_FAKE_AI=1 the
  // API server must intercept both endpoint tests and generation before fetch.
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

async function expectTaskSucceeded(
  request: APIRequestContext,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(
      appUrl(`/api/v1/ai-tasks/${encodeURIComponent(taskId)}`),
    );

    expect(response.status()).toBe(200);

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
