import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record title and summary correction", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user overlays and removes an overview correction without changing the source", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const firstLine = `CDC 获取事务日志 ${marker}。`;
    const secondLine = `事务日志保留提交顺序 ${marker}。`;
    const sourceText = `${firstLine}\n${secondLine}`;
    const correctedTitle = `用户修正的 CDC 标题 ${marker}`;
    const correctedSummary = `用户修正摘要：只发布已提交的变化 ${marker}。`;

    await enableDeterministicFakeConfiguration(request);
    const recordId = await createOrganizedRecord(request, sourceText, marker);

    await page.goto(appUrl(`/records/${recordId}`));

    const detail = page.getByRole("main", { name: "记录详情" });
    const sourcePane = detail.getByRole("region", { name: "记录与原文" });
    const original = sourcePane.getByLabel("完整原文", { exact: true });

    await expect(
      sourcePane.getByRole("heading", { name: "CDC 与事务日志", exact: true }),
    ).toBeVisible();
    await expect(sourcePane.getByText("数据库变更捕获与事务日志的整理结果。", {
      exact: true,
    })).toBeVisible();
    expect(await original.textContent()).toBe(sourceText);

    await sourcePane
      .getByRole("button", { name: "修正标题与摘要", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "修正标题与摘要" });
    const titleInput = dialog.getByRole("textbox", { name: "记录标题" });
    const summaryInput = dialog.getByRole("textbox", { name: "记录摘要" });

    await expect(dialog).toBeVisible();
    await expect(titleInput).toHaveValue("CDC 与事务日志");
    await expect(summaryInput).toHaveValue(
      "数据库变更捕获与事务日志的整理结果。",
    );

    await titleInput.fill(correctedTitle);
    await summaryInput.fill(correctedSummary);
    await dialog.getByRole("button", { name: "保存修正", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(
      sourcePane.getByRole("heading", { name: correctedTitle, exact: true }),
    ).toBeVisible();
    await expect(sourcePane.getByText(correctedSummary, { exact: true })).toBeVisible();
    await expect(sourcePane.getByText("用户修正", { exact: true })).toBeVisible();
    expect(await original.textContent()).toBe(sourceText);

    await sourcePane
      .getByRole("button", { name: "修正标题与摘要", exact: true })
      .click();
    await expect(dialog.getByLabel("AI 原值", { exact: true })).toContainText(
      "CDC 与事务日志",
    );
    await expect(dialog.getByLabel("AI 原值", { exact: true })).toContainText(
      "数据库变更捕获与事务日志的整理结果。",
    );

    await dialog.getByRole("button", { name: "撤销修正", exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(
      sourcePane.getByRole("heading", { name: "CDC 与事务日志", exact: true }),
    ).toBeVisible();
    await expect(sourcePane.getByText("用户修正", { exact: true })).toHaveCount(0);
    expect(await original.textContent()).toBe(sourceText);
    await expect(page).toHaveURL(appUrl(`/records/${recordId}`));
  });
});

async function createOrganizedRecord(
  request: APIRequestContext,
  sourceText: string,
  marker: string,
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: sourceText,
      myTags: [{ name: `整体修正 ${marker}` }],
      processing: "save_only",
    },
  });
  expect(created.status()).toBe(201);
  const recordId = ((await created.json()) as { record: { id: string } }).record.id;
  const organized = await request.post(
    appUrl(`/api/v1/records/${recordId}/organize`),
    { data: { handling: "automatic" } },
  );
  expect(organized.status()).toBe(202);
  await expectTaskSucceeded(
    request,
    (await organized.json() as { task: { id: string } }).task.id,
  );

  return recordId;
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
    expect(
      (await request.post(appUrl(`/api/v1/model-config/draft/tests/${kind}`)))
        .status(),
    ).toBe(200);
  }

  expect(
    (await request.post(appUrl("/api/v1/model-config/draft/activate"))).status(),
  ).toBe(200);
}

async function expectTaskSucceeded(
  request: APIRequestContext,
  taskId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(appUrl(`/api/v1/ai-tasks/${taskId}`));

      return ((await response.json()) as { task: { status: string } }).task.status;
    })
    .toBe("succeeded");
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
