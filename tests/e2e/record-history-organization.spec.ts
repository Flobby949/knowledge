import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("AI analysis history workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user inspects an AI snapshot on the horizontal timeline and returns to the same evidence", async ({
    page,
    request,
  }) => {
    const marker = `history-analysis-${randomUUID().slice(0, 8)}`;
    const firstQuote = `CDC 读取提交日志 ${marker}。`;
    const secondQuote = `下游依据顺序消费增量 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;

    await enableDeterministicFakeConfiguration(request);
    const recordId = await createAndOrganizeRecord(request, sourceText, marker);
    const detailUrl = appUrl(`/records/${recordId}`);

    await page.goto(detailUrl);

    const detail = page.getByRole("main", { name: "记录详情" });
    const firstPoint = detail.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "CDC 如何获取数据库变更",
        exact: true,
      }),
    });
    const firstSelection = firstPoint.getByRole("button", {
      name: "选择知识点：CDC 如何获取数据库变更",
      exact: true,
    });
    const rawText = detail.getByLabel("完整原文", { exact: true });

    await firstSelection.click();
    await expect(firstSelection).toHaveAttribute("aria-pressed", "true");
    await expect(rawText.locator("mark")).toHaveText(firstQuote);

    await page
      .getByRole("toolbar", { name: "记录操作" })
      .getByRole("button", { name: "历史版本", exact: true })
      .click();

    const workspace = page.getByRole("dialog", { name: "历史版本" });
    const timeline = workspace.getByRole("tablist", { name: "版本时间轴" });
    const originalTab = timeline.getByRole("tab", {
      name: "原文 v1 当前",
      exact: true,
    });
    const analysisTab = timeline.getByRole("tab", {
      name: "AI 整理 · 生效 · 基于原文 v1",
      exact: true,
    });

    await expect(originalTab).toBeVisible();
    await expect(analysisTab).toBeVisible();

    const [originalBox, analysisBox] = await Promise.all([
      originalTab.boundingBox(),
      analysisTab.boundingBox(),
    ]);

    expect(originalBox, "original revision tab must render").not.toBeNull();
    expect(analysisBox, "analysis revision tab must render").not.toBeNull();

    if (originalBox && analysisBox) {
      expect(Math.abs(originalBox.y - analysisBox.y)).toBeLessThanOrEqual(2);
      expect(originalBox.x + originalBox.width).toBeLessThanOrEqual(
        analysisBox.x,
      );
    }

    await analysisTab.click();

    const snapshot = workspace.getByRole("region", {
      name: "AI 分析快照",
      exact: true,
    });

    await expect(analysisTab).toHaveAttribute("aria-selected", "true");
    await expect(snapshot.getByLabel("分析状态", { exact: true })).toHaveText(
      "生效版本",
    );
    await expect(snapshot.getByLabel("来源原文版本", { exact: true })).toHaveText(
      "v1",
    );
    await expect(
      snapshot.getByRole("heading", {
        name: "CDC 与事务日志",
        exact: true,
      }),
    ).toBeVisible();
    await expect(snapshot).toContainText("数据库变更捕获与事务日志的整理结果。");
    await expect(snapshot.getByRole("article")).toHaveCount(2);
    await expect(snapshot).toContainText("CDC 如何获取数据库变更");
    await expect(snapshot).toContainText(firstQuote);
    await expect(snapshot).toContainText("事务日志保留哪些信息");
    await expect(snapshot).toContainText(secondQuote);

    await workspace.getByRole("button", { name: "关闭历史版本" }).click();

    await expect(workspace).toBeHidden();
    await expect(page).toHaveURL(detailUrl);
    await expect(firstSelection).toHaveAttribute("aria-pressed", "true");
    await expect(rawText.locator("mark")).toHaveText(firstQuote);
    expect(await rawText.textContent()).toBe(sourceText);
  });

  test("user compares a superseded AI analysis with the active analysis", async ({
    page,
    request,
  }) => {
    const marker = `E2E_REANALYSIS_COMPARISON ${randomUUID().slice(0, 8)}`;
    const sourceText = [
      `数据库日志按提交顺序记录变更 ${marker}。`,
      `下游按增量边界验证消费结果 ${marker}。`,
    ].join("\n");

    await enableDeterministicFakeConfiguration(request);
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceText,
        myTags: [{ name: `历史对照 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);
    const recordId = ((await created.json()) as { record: { id: string } })
      .record.id;

    await organizeRecordAndWait(request, recordId);
    await organizeRecordAndWait(request, recordId);

    const detailResponse = await request.get(
      appUrl(`/api/v1/records/${recordId}`),
    );
    const candidateId = ((await detailResponse.json()) as {
      organization: { candidate?: { id: string } };
    }).organization.candidate?.id;

    if (!candidateId) {
      throw new Error("second deterministic analysis must be a candidate");
    }

    const adopted = await request.post(
      appUrl(
        `/api/v1/records/${recordId}/organization-candidates/${candidateId}/adopt`,
      ),
    );

    expect(adopted.status()).toBe(200);
    await page.goto(appUrl(`/records/${recordId}`));
    await page
      .getByRole("toolbar", { name: "记录操作" })
      .getByRole("button", { name: "历史版本", exact: true })
      .click();

    const workspace = page.getByRole("dialog", { name: "历史版本" });
    const timeline = workspace.getByRole("tablist", { name: "版本时间轴" });
    const historicalTab = timeline.getByRole("tab", {
      name: "AI 整理 · 历史 · 基于原文 v1",
      exact: true,
    });

    await historicalTab.click();
    await expect(
      workspace.getByRole("heading", {
        name: "重新整理基线 V1",
        exact: true,
      }),
    ).toBeVisible();

    await workspace
      .getByRole("button", { name: "与当前 AI 版本对照", exact: true })
      .click();

    const historical = workspace.getByRole("region", {
      name: "历史 AI 版本",
      exact: true,
    });
    const current = workspace.getByRole("region", {
      name: "当前 AI 版本",
      exact: true,
    });
    const [historicalBox, currentBox] = await Promise.all([
      historical.boundingBox(),
      current.boundingBox(),
    ]);

    await expect(historical).toContainText("重新整理基线 V1");
    await expect(historical).toContainText("V1 当前摘要");
    await expect(historical.getByRole("article")).toHaveCount(2);
    await expect(current).toContainText("重新整理候选 V2");
    await expect(current).toContainText("V2 候选摘要");
    await expect(current.getByRole("article")).toHaveCount(3);
    expect(historicalBox, "historical analysis pane must render").not.toBeNull();
    expect(currentBox, "current analysis pane must render").not.toBeNull();

    if (historicalBox && currentBox) {
      expect(historicalBox.x + historicalBox.width).toBeLessThanOrEqual(
        currentBox.x,
      );
      expect(Math.abs(historicalBox.y - currentBox.y)).toBeLessThanOrEqual(2);
    }
  });
});

async function createAndOrganizeRecord(
  request: APIRequestContext,
  sourceText: string,
  marker: string,
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: sourceText,
      myTags: [{ name: `历史分析 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);
  const recordId = ((await created.json()) as { record: { id: string } }).record
    .id;

  await organizeRecordAndWait(request, recordId);

  return recordId;
}

async function organizeRecordAndWait(
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
    const task = (await response.json()) as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (task.task.status === "succeeded") {
      return;
    }

    if (task.task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

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

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
