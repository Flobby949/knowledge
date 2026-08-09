import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

import { expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("same-source reanalysis whole-version comparison", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user adopts one candidate and discards the next without point-level publishing", async ({
    page,
    request,
  }) => {
    const marker = `E2E_REANALYSIS_COMPARISON ${randomUUID().slice(0, 8)}`;
    const firstQuote = `数据库日志按提交顺序记录变更 ${marker}。`;
    const secondQuote = `下游按增量边界验证消费结果 ${marker}。`;
    const sourceText = `${firstQuote}\n${secondQuote}`;

    await enableDeterministicFakeConfiguration(request);

    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: sourceText,
        myTags: [{ name: `重新整理 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const recordId = ((await created.json()) as { record: { id: string } })
      .record.id;

    await organizeAndWait(request, recordId);

    const detailUrl = appUrl(`/records/${recordId}`);

    await page.goto(detailUrl);

    const toolbar = page.getByRole("toolbar", { name: "记录操作" });
    const reanalyze = toolbar.getByRole("button", {
      name: "重新整理",
      exact: true,
    });
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

    await expectHorizontalSplit(recordPane, knowledgePane, {
      leftRatio: 0.58,
      gap: 0,
      ratioTolerance: 0.02,
    });
    expect(await rawText.textContent()).toBe(sourceText);
    await expect(
      recordPane.getByRole("heading", {
        name: "重新整理基线 V1",
        exact: true,
      }),
    ).toBeVisible();
    await expect(reanalyze).toBeVisible();

    await reanalyze.click();

    const comparison = knowledgePane.getByRole("region", {
      name: "版本对照",
      exact: true,
    });
    const currentVersion = comparison.getByRole("region", {
      name: "当前生效版本",
      exact: true,
    });
    const candidateVersion = comparison.getByRole("region", {
      name: "候选版本",
      exact: true,
    });
    const decisions = comparison.getByRole("group", {
      name: "候选版本决策",
      exact: true,
    });

    await expect(comparison).toBeVisible();
    await expect(page).toHaveURL(detailUrl);
    expect(await rawText.textContent()).toBe(sourceText);
    await expect(currentVersion).toContainText("重新整理基线 V1");
    await expect(currentVersion).toContainText("V1 当前摘要");
    await expect(currentVersion.getByRole("article")).toHaveCount(2);
    await expect(candidateVersion).toContainText("重新整理候选 V2");
    await expect(candidateVersion).toContainText("V2 候选摘要");
    await expect(candidateVersion.getByRole("article")).toHaveCount(3);
    await expect(
      candidateVersion
        .getByRole("list", { name: "候选版本标签" })
        .getByText("候选新增标签", { exact: true }),
    ).toBeVisible();
    await expect(comparison.getByText("修改", { exact: true }).first()).toBeVisible();
    await expect(comparison.getByText("新增", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/拆分或新增/u)).toBeVisible();
    await expect(comparison.getByText("标签变化", { exact: true }).first()).toBeVisible();
    await expect(decisions.getByRole("button")).toHaveCount(2);
    await expect(
      decisions.getByRole("button", {
        name: "采用整个新版本",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      decisions.getByRole("button", {
        name: "丢弃新版本",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      comparison.getByRole("button", {
        name: /^(?:确认|拒绝|修正|暂不采用)$/u,
      }),
    ).toHaveCount(0);

    await candidateVersion
      .getByRole("button", {
        name: "选择候选版本知识点：候选 V2：读取事务日志",
        exact: true,
      })
      .click();
    await expect(rawText.locator("mark")).toHaveText(firstQuote);

    await decisions
      .getByRole("button", {
        name: "采用整个新版本",
        exact: true,
      })
      .click();

    await expect(comparison).toBeHidden();
    await expect(page).toHaveURL(detailUrl);
    await expect(
      recordPane.getByRole("heading", {
        name: "重新整理候选 V2",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      knowledgePane.getByRole("heading", {
        name: "候选 V2：验证增量边界",
        exact: true,
      }),
    ).toBeVisible();
    await expect(reanalyze).toBeFocused();

    await reanalyze.click();
    await expect(comparison).toBeVisible();

    await expect(currentVersion).toContainText("重新整理候选 V2");
    await expect(currentVersion.getByRole("article")).toHaveCount(3);
    await expect(candidateVersion).toContainText("应丢弃候选 V3");
    await expect(candidateVersion.getByRole("article")).toHaveCount(2);
    await expect(comparison.getByText("删除", { exact: true })).toBeVisible();
    await expect(comparison.getByText(/合并或删除/u)).toBeVisible();
    await expect(
      comparison.getByRole("button", {
        name: /^(?:确认|拒绝|修正|暂不采用)$/u,
      }),
    ).toHaveCount(0);

    await decisions
      .getByRole("button", { name: "丢弃新版本", exact: true })
      .click();

    await expect(comparison).toBeHidden();
    await expect(page).toHaveURL(detailUrl);
    await expect(
      recordPane.getByRole("heading", {
        name: "重新整理候选 V2",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      knowledgePane.getByRole("heading", {
        name: "候选 V2：验证增量边界",
        exact: true,
      }),
    ).toBeVisible();
    await expect(knowledgePane.getByText("应丢弃候选 V3")).toHaveCount(0);
    await expect(reanalyze).toBeFocused();
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
