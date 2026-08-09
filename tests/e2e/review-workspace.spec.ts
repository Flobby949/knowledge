import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "./fixture.js";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("Mode B review workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user verifies evidence, corrects one point, rejects one point, and stays until explicit completion", async ({
    page,
    request,
  }) => {
    const marker = "review-visual-primary";
    const firstQuote = `CDC 读取数据库事务日志 ${marker}。`;
    const secondQuote = `事务日志记录增量变更并保留提交顺序 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;
    const myTag = `审查标签 ${marker}`;
    const confirmedTitle = "CDC 如何获取数据库变更";
    const correctedTitle = `CDC 变更捕获的人工结论 ${marker}`;
    const correctedBody = `用户确认：CDC 以事务日志为变更来源 ${marker}。`;
    const rejectedTitle = "事务日志保留哪些信息";

    await enableDeterministicFakeConfiguration(request);

    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceText,
        myTags: [{ name: myTag }],
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
      { data: { handling: "review" } },
    );

    expect(organized.status()).toBe(202);

    const organizedBody = (await organized.json()) as {
      task: { id: string };
    };

    await expectTaskSucceeded(request, organizedBody.task.id);

    await page.goto(appUrl("/records"));

    const navigation = page.getByRole("navigation", { name: "主导航" });

    await expectBox(navigation, {
      x: 0,
      y: 0,
      width: 1_600,
      height: 60,
    });
    await navigation
      .getByRole("link", { name: "待审查", exact: true })
      .click();

    await expect(page).toHaveURL(appUrl("/review"));

    const queueBar = page.getByRole("region", { name: "审查队列" });
    const workspace = page.getByRole("main", { name: "待审查" });
    const sourcePane = workspace.getByRole("region", { name: "记录与原文" });
    const pointsPane = workspace.getByRole("region", { name: "知识点" });
    const flowBar = page.getByRole("region", { name: "审查流转" });
    const points = pointsPane.getByRole("article");
    const pendingCount = queueBar.getByLabel("待处理知识点", {
      exact: true,
    });
    const finishButton = page.getByRole("button", {
      name: "完成并下一条",
      exact: true,
    });

    await expectBox(queueBar, {
      x: 30,
      y: 90,
      width: 1_540,
      height: 72,
    }, 4);
    await expectBox(workspace, {
      x: 30,
      y: 183,
      width: 1_540,
    }, 4);
    await expectHorizontalSplit(sourcePane, pointsPane, {
      leftRatio: 0.58,
      gap: 20,
      ratioTolerance: 0.02,
      pixelTolerance: 4,
    });
    await expectBox(flowBar, {
      x: 30,
      width: 1_540,
      height: 68,
    }, 4);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(sourcePane.getByLabel("内容来源", { exact: true }))
      .toHaveText("AI 生成");
    await expect(sourcePane.getByRole("region", { name: "AI 生成摘要" }))
      .toBeVisible();
    await expect(sourcePane.getByRole("list", { name: "我的标签" }))
      .toContainText(myTag);
    await expect(page).toHaveScreenshot("review-workspace.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      maxDiffPixels: 400,
    });

    await expect(
      queueBar.getByLabel("队列位置", { exact: true }),
    ).toHaveText("1 / 1");
    await expect(
      queueBar.getByRole("button", { name: "上一条", exact: true }),
    ).toBeVisible();
    await expect(
      queueBar.getByRole("button", { name: "下一条", exact: true }),
    ).toBeVisible();
    await expect(pendingCount).toHaveText("2");
    await expect(finishButton).toBeDisabled();
    expect(
      await sourcePane.getByLabel("完整原文", { exact: true }).textContent(),
    ).toBe(sourceText);

    await expect(points).toHaveCount(2);
    await expect(pointsPane.getByRole("tablist")).toHaveCount(0);
    await expect(pointsPane.getByRole("tab")).toHaveCount(0);

    const confirmedPoint = pointByTitle(points, confirmedTitle);
    const rejectedPoint = pointByTitle(points, rejectedTitle);

    await expectPointPending(confirmedPoint, confirmedTitle, firstQuote);
    await expectPointPending(rejectedPoint, rejectedTitle, secondQuote);

    await confirmedPoint
      .getByRole("button", { name: "证据 1 处", exact: true })
      .click();

    const highlightedSource = sourcePane
      .getByLabel("完整原文", { exact: true })
      .locator("mark");

    await expect(highlightedSource).toHaveCount(1);
    await expect(highlightedSource).toHaveText(firstQuote);

    await confirmedPoint
      .getByRole("button", { name: "修正后确认", exact: true })
      .click();

    const correctionDialog = page.getByRole("dialog", { name: "修正知识点" });
    const titleInput = correctionDialog.getByRole("textbox", {
      name: "知识点标题",
      exact: true,
    });
    const bodyInput = correctionDialog.getByRole("textbox", {
      name: "知识点正文",
      exact: true,
    });

    await expect(titleInput).toHaveValue(confirmedTitle);
    await expect(bodyInput).toHaveValue(firstQuote);
    await titleInput.fill(correctedTitle);
    await bodyInput.fill(correctedBody);
    await correctionDialog.getByRole("button", {
      name: "保存修正并确认",
      exact: true,
    }).click();

    await expect(pendingCount).toHaveText("1");
    await expect(correctionDialog).toBeHidden();
    const correctedPoint = pointByTitle(points, correctedTitle);

    await expect(correctedPoint).toHaveCount(1);
    await expect(correctedPoint.getByLabel("审查状态", { exact: true }))
      .toHaveText("已确认");
    await expect(correctedPoint.getByText("用户修正", { exact: true }))
      .toBeVisible();
    await expect(correctedPoint.getByLabel("知识点正文", { exact: true }))
      .toHaveText(correctedBody);
    await expect(rejectedPoint).toBeVisible();
    await expect(finishButton).toBeDisabled();

    await rejectedPoint
      .getByRole("button", { name: "拒绝", exact: true })
      .click();

    await expect(pendingCount).toHaveText("0");
    await expect(
      rejectedPoint.getByLabel("审查状态", { exact: true }),
    ).toHaveText("已拒绝");
    await expect(points).toHaveCount(2);
    await expect(correctedPoint).toBeVisible();
    await expect(rejectedPoint).toBeVisible();
    await expect(finishButton).toBeEnabled();
    await expect(page).toHaveURL(appUrl("/review"));
    await expect(highlightedSource).toHaveCount(1);
    await expect(highlightedSource).toHaveText(firstQuote);

    await expectSearchMembership(request, correctedTitle, recordId, true);
    await expectSearchMembership(request, rejectedTitle, recordId, false);

    await finishButton.click();

    const emptyState = page.getByRole("status", { name: "审查队列为空" });

    await expect(emptyState).toContainText("暂无待审查记录");
    await expect(workspace.getByRole("article")).toHaveCount(0);

    await submitGlobalSearch(page, correctedTitle);

    const resultStage = page.getByRole("region", { name: "搜索结果" });
    const confirmedResult = resultStage.getByText(myTag, { exact: true });

    await expect(confirmedResult).toBeVisible();

    await submitGlobalSearch(page, rejectedTitle);

    await expect(
      page
        .getByRole("region", { name: "搜索结果" })
        .getByText(myTag, { exact: true }),
    ).toHaveCount(0);
  });

  test("user moves through the real review queue one record at a time", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);

    const firstMarker = `review-queue-first-${randomUUID().slice(0, 8)}`;
    const firstSource = [
      `第一条记录读取数据库日志 ${firstMarker}。`,
      `第一条记录保留提交顺序 ${firstMarker}。`,
    ].join("\n");
    const secondMarker = `review-queue-second-${randomUUID().slice(0, 8)}`;
    const secondSource = [
      `第二条记录读取数据库日志 ${secondMarker}。`,
      `第二条记录保留提交顺序 ${secondMarker}。`,
    ].join("\n");
    const thirdMarker = `review-queue-third-${randomUUID().slice(0, 8)}`;
    const thirdSource = [
      `第三条记录读取数据库日志 ${thirdMarker}。`,
      `第三条记录保留提交顺序 ${thirdMarker}。`,
    ].join("\n");
    const firstRecordId = await createPendingReviewRecord(
      request,
      firstSource,
      `第一条审查标签 ${firstMarker}`,
    );
    const secondRecordId = await createPendingReviewRecord(
      request,
      secondSource,
      `第二条审查标签 ${secondMarker}`,
    );
    const thirdRecordId = await createPendingReviewRecord(
      request,
      thirdSource,
      `第三条审查标签 ${thirdMarker}`,
    );

    await page.goto(appUrl("/review"));

    const queueBar = page.getByRole("region", { name: "审查队列" });
    const source = page.getByRole("region", { name: "记录与原文" })
      .getByLabel("完整原文", { exact: true });
    const position = queueBar.getByLabel("队列位置", { exact: true });
    const previous = queueBar.getByRole("button", {
      name: "上一条",
      exact: true,
    });
    const next = queueBar.getByRole("button", {
      name: "下一条",
      exact: true,
    });

    await expect(position).toHaveText("1 / 3");
    await expect(source).toHaveText(firstSource);
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();

    await next.click();
    await expect(position).toHaveText("2 / 3");
    await expect(source).toHaveText(secondSource);
    await expect(previous).toBeEnabled();
    await expect(next).toBeEnabled();

    await previous.click();
    await expect(position).toHaveText("1 / 3");
    await expect(source).toHaveText(firstSource);

    const keepPendingAndNext = page.getByRole("button", {
      name: "保留未处理并下一条",
      exact: true,
    });

    await keepPendingAndNext.click();
    await expect(position).toHaveText("2 / 3");
    await expect(source).toHaveText(secondSource);
    await expectReviewQueuePendingCounts(request, [
      { recordId: firstRecordId, pendingCount: 2 },
      { recordId: secondRecordId, pendingCount: 2 },
      { recordId: thirdRecordId, pendingCount: 2 },
    ]);

    const points = page.getByRole("region", { name: "知识点" })
      .getByRole("article");
    const confirmAll = page.getByRole("button", {
      name: "全部确认",
      exact: true,
    });

    await confirmAll.click();
    await expect(queueBar.getByLabel("待处理知识点", { exact: true }))
      .toHaveText("0");
    await expect(points).toHaveCount(2);

    for (const point of await points.all()) {
      await expect(point.getByLabel("审查状态", { exact: true }))
        .toHaveText("已确认");
    }

    await expectReviewQueuePendingCounts(request, [
      { recordId: firstRecordId, pendingCount: 2 },
      { recordId: thirdRecordId, pendingCount: 2 },
    ]);

    await page.getByRole("button", {
      name: "完成并下一条",
      exact: true,
    }).click();
    await expect(position).toHaveText("2 / 2");
    await expect(source).toHaveText(thirdSource);

    expect((await request.delete(appUrl(`/api/v1/records/${firstRecordId}`))).status()).toBe(204);
    expect((await request.delete(appUrl(`/api/v1/records/${secondRecordId}`))).status()).toBe(204);
    expect((await request.delete(appUrl(`/api/v1/records/${thirdRecordId}`))).status()).toBe(204);
  });
});

async function createPendingReviewRecord(
  request: APIRequestContext,
  text: string,
  tag: string,
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: { text, myTags: [{ name: tag }], processing: "save_only" },
  });

  expect(created.status()).toBe(201);

  const recordId = ((await created.json()) as { record: { id: string } }).record
    .id;
  const organized = await request.post(
    appUrl(`/api/v1/records/${recordId}/organize`),
    { data: { handling: "review" } },
  );

  expect(organized.status()).toBe(202);
  await expectTaskSucceeded(
    request,
    ((await organized.json()) as { task: { id: string } }).task.id,
  );

  return recordId;
}

async function expectReviewQueuePendingCounts(
  request: APIRequestContext,
  expected: Array<{ recordId: string; pendingCount: number }>,
): Promise<void> {
  const response = await request.get(appUrl("/api/v1/review-queue"));

  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    items: Array<{ record: { id: string }; pendingCount: number }>;
  };

  expect(
    body.items.map((item) => ({
      recordId: item.record.id,
      pendingCount: item.pendingCount,
    })),
  ).toEqual(expected);
}

function pointByTitle(points: Locator, title: string): Locator {
  return points.filter({
    has: points.page().getByRole("heading", { name: title, exact: true }),
  });
}

async function expectPointPending(
  point: Locator,
  title: string,
  body: string,
): Promise<void> {
  await expect(point).toHaveCount(1);
  await expect(
    point.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(point.getByLabel("知识点正文", { exact: true })).toHaveText(
    body,
  );
  await expect(point.getByLabel("审查状态", { exact: true })).toHaveText(
    "待审查",
  );
  await expect(
    point.getByRole("button", { name: "确认", exact: true }),
  ).toBeVisible();
  await expect(
    point.getByRole("button", { name: "修正后确认", exact: true }),
  ).toBeVisible();
  await expect(
    point.getByRole("button", { name: "拒绝", exact: true }),
  ).toBeVisible();
}

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

async function expectSearchMembership(
  request: APIRequestContext,
  query: string,
  recordId: string,
  expected: boolean,
): Promise<void> {
  const search = new URLSearchParams({ q: query });
  const response = await request.get(appUrl(`/api/v1/search?${search}`));

  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    items: Array<{ record: { id: string } }>;
  };
  const includesRecord = body.items.some((item) => item.record.id === recordId);

  expect(includesRecord).toBe(expected);
}

async function submitGlobalSearch(page: Page, query: string): Promise<void> {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());

    return (
      candidate.request().method() === "GET" &&
      url.pathname === "/api/v1/search" &&
      url.searchParams.get("q") === query
    );
  });
  const search = page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("search", { name: "全局搜索" });
  const input = search.getByRole("searchbox", {
    name: "定位标签或搜索记录",
  });

  await input.fill(query);
  await input.press("Enter");
  await response;
  await expect(page).toHaveURL(searchUrl(query));
}

function searchUrl(query: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", query);

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
