import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("search snapshot workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("submits explicitly, reports semantic degradation, and automatically continues one stable snapshot", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const originalTitles = Array.from(
      { length: 14 },
      (_, index) => `自动续页记录 ${String(index + 1).padStart(2, "0")} ${marker}`,
    );

    let sharedTagId = "";

    for (const title of originalTitles) {
      const created = await createRecord(
        request,
        `${title}\n${marker} 用于稳定快照与自动续页验证。`,
        sharedTagId
          ? { id: sharedTagId }
          : { name: `自动续页 ${marker}` },
      );

      sharedTagId ||= created.myTags[0]?.id ?? "";
    }

    if (!sharedTagId) {
      throw new Error("search fixtures must return their shared tag");
    }

    await page.goto(appUrl("/"));

    const searchRequests: string[] = [];

    page.on("request", (requestEvent) => {
      const url = new URL(requestEvent.url());

      if (url.pathname === "/api/v1/search") {
        searchRequests.push(url.toString());
      }
    });

    const searchInput = page
      .getByRole("main", { name: "首页" })
      .getByRole("search", { name: "首页搜索" })
      .getByRole("searchbox", { name: "定位标签或搜索记录" });

    await searchInput.fill(marker);
    await page.waitForTimeout(180);
    expect(searchRequests).toHaveLength(0);
    await expect(page).toHaveURL(appUrl("/"));

    await searchInput.press("Enter");
    await expect(page).toHaveURL(searchUrl({ query: marker }));

    const stage = page.getByRole("region", { name: "搜索结果" });
    const results = stage.getByRole("article");

    await expect(stage.getByText("关键词检索可用", { exact: true })).toBeVisible();
    await expect(
      stage.getByText("语义检索暂不可用", { exact: true }),
    ).toBeVisible();
    await expect(results).toHaveCount(12);
    expect(searchRequests).toHaveLength(1);

    const laterTitle = `提交后插队记录 ${marker}`;

    await createRecord(
      request,
      `${laterTitle}\n${marker} 不应插入已经提交的搜索快照。`,
      { id: sharedTagId },
    );
    await page.getByTestId("search-load-sentinel").scrollIntoViewIfNeeded();

    await expect(results).toHaveCount(14);
    await expect(stage.getByText(laterTitle, { exact: true })).toHaveCount(0);
    expect(searchRequests).toHaveLength(2);
    await expect(page.getByText("加载更多", { exact: true })).toHaveCount(0);

    const lastTitle = originalTitles.at(-1);

    if (!lastTitle) {
      throw new Error("search fixture must include a final title");
    }

    const lastResult = results.filter({ hasText: lastTitle });

    await lastResult.scrollIntoViewIfNeeded();
    const scrollTopBeforeDetail = await stage.evaluate((element) => element.scrollTop);

    await lastResult
      .getByRole("button", { name: `查看搜索详情：${lastTitle}` })
      .click();
    await page
      .getByRole("region", { name: "搜索详情" })
      .getByRole("link", { name: "打开完整详情" })
      .click();
    await expect(page).toHaveURL(/\/records\/[0-9a-f-]+$/u);

    await page.goBack();

    await expect(results).toHaveCount(14);
    await expect(page.getByRole("region", { name: "搜索详情" })).toBeVisible();
    await expect
      .poll(() => stage.evaluate((element) => element.scrollTop))
      .toBeGreaterThanOrEqual(scrollTopBeforeDetail - 2);
    expect(searchRequests).toHaveLength(2);
  });

  test("uses repeated tags as OR and combines them with the submitted text as a hard filter", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const keyword = `硬筛选-${marker}`;
    const first = await createRecord(
      request,
      `标签甲命中 ${marker}\n${keyword}`,
      { name: `搜索标签甲 ${marker}` },
    );
    const second = await createRecord(
      request,
      `标签乙命中 ${marker}\n${keyword}`,
      { name: `搜索标签乙 ${marker}` },
    );
    const firstTag = first.myTags[0];
    const secondTag = second.myTags[0];

    if (!firstTag || !secondTag) {
      throw new Error("search fixtures must return their tags");
    }

    const tagOnly = await createRecord(
      request,
      `只有标签命中 ${marker}\n正文没有硬筛选词。`,
      { id: firstTag.id },
    );

    await page.goto(
      searchUrl({
        query: keyword,
        tagIds: [firstTag.id, secondTag.id],
      }),
    );

    const stage = page.getByRole("region", { name: "搜索结果" });
    const results = stage.getByRole("article");

    await expect(stage.getByText("匹配任一标签", { exact: true })).toBeVisible();
    await expect(stage.getByText(firstTag.name, { exact: true })).toBeVisible();
    await expect(stage.getByText(secondTag.name, { exact: true })).toBeVisible();
    await expect(results).toHaveCount(2);
    await expect(stage.getByText(first.record.title, { exact: true })).toBeVisible();
    await expect(stage.getByText(second.record.title, { exact: true })).toBeVisible();
    await expect(stage.getByText(tagOnly.record.title, { exact: true })).toHaveCount(0);
  });

  test("keeps pending AI knowledge hidden until the user includes review content", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);

    const marker = randomUUID().slice(0, 8);
    const sourceText =
      `CDC 从数据库事务日志捕获变更 ${marker}。\n` +
      `事务日志记录每次修改 ${marker}。`;
    const created = await createRecord(
      request,
      sourceText,
      { name: `审查检索 ${marker}` },
    );
    const organized = await request.post(
      appUrl(`/api/v1/records/${created.record.id}/organize`),
      { data: { handling: "review" } },
    );

    expect(organized.status()).toBe(202);

    const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

    await expectTaskSucceeded(request, taskId);
    await page.goto(searchUrl({ query: "CDC 如何获取数据库变更" }));

    const stage = page.getByRole("region", { name: "搜索结果" });
    const reviewScope = stage.getByRole("checkbox", {
      name: "包含待审查内容",
    });

    await expect(stage.getByRole("article")).toHaveCount(0);
    await expect(reviewScope).not.toBeChecked();

    await reviewScope.check();

    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBe(
      "include_review",
    );
    await expect(stage.getByRole("article")).toHaveCount(1);
    await expect(stage.getByText("待审查内容", { exact: true })).toBeVisible();
    await expect(stage.getByText("AI 整理命中", { exact: true })).toBeVisible();

    await reviewScope.uncheck();
    await expect.poll(() => new URL(page.url()).searchParams.get("scope")).toBeNull();
    await expect(stage.getByRole("article")).toHaveCount(0);
  });

  test("shows the effective record, exact knowledge-point hit, current points, and original text in the drawer", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);

    const marker = randomUUID().slice(0, 8);
    const firstLine = `E2E_TAG_ATLAS ${marker} CDC 读取事务日志。`;
    const secondLine = `事务日志保留增量顺序 ${marker}。`;
    const created = await createRecord(
      request,
      `${firstLine}\n${secondLine}`,
      { name: `抽屉核验 ${marker}` },
    );
    const organized = await request.post(
      appUrl(`/api/v1/records/${created.record.id}/organize`),
      { data: { handling: "automatic" } },
    );

    expect(organized.status()).toBe(202);

    const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

    await expectTaskSucceeded(request, taskId);
    await page.goto(searchUrl({ query: `共享候选来源一 ${marker}` }));

    const result = page
      .getByRole("region", { name: "搜索结果" })
      .getByRole("article")
      .filter({ hasText: `标签图鉴候选 ${marker}` });

    await expect(result).toHaveCount(1);
    await result
      .getByRole("button", { name: `查看搜索详情：标签图鉴候选 ${marker}` })
      .click();

    const drawer = page.getByRole("region", { name: "搜索详情" });
    const effectiveRecord = drawer.getByRole("region", {
      name: "当前有效记录",
    });
    const matchedPoint = drawer.getByRole("region", { name: "命中知识点" });
    const currentPoints = drawer.getByRole("region", { name: "当前知识点" });
    const originalText = drawer.getByRole("region", { name: "原文片段" });

    await expect(
      drawer.getByRole("heading", { name: `标签图鉴候选 ${marker}` }),
    ).toBeVisible();
    await expect(effectiveRecord).toContainText(
      "用于验证候选标签按记录聚合和逐条管理的确定性结果。",
    );
    await expect(matchedPoint).toContainText(`共享候选来源一 ${marker}`);
    await expect(matchedPoint).toContainText("本次命中");
    await expect(currentPoints.getByRole("article")).toHaveCount(2);
    await expect(currentPoints).toContainText(`共享候选来源一 ${marker}`);
    await expect(currentPoints).toContainText(`共享候选来源二 ${marker}`);
    await expect(
      currentPoints
        .getByRole("article")
        .filter({ hasText: `共享候选来源二 ${marker}` }),
    ).not.toContainText("本次命中");
    await expect(originalText).toContainText(firstLine);
    await expect(originalText).toContainText(secondLine);
  });
});

interface CreatedRecord {
  record: { id: string; title: string };
  myTags: Array<{ id: string; name: string }>;
}

async function createRecord(
  request: APIRequestContext,
  text: string,
  tag: { id: string } | { name: string },
): Promise<CreatedRecord> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: [tag],
      processing: "save_only",
    },
  });

  expect(response.status()).toBe(201);

  const body = (await response.json()) as {
    record: { id: string; title: string; myTags: Array<{ id: string; name: string }> };
  };

  return { record: body.record, myTags: body.record.myTags };
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: "http://127.0.0.1:9/search-workspace-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "search-workspace-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/search-workspace-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "search-workspace-fake-embedding-key",
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

function searchUrl(options: { query: string; tagIds?: string[] }): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", options.query);

  for (const tagId of options.tagIds ?? []) {
    url.searchParams.append("tag", tagId);
  }

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
