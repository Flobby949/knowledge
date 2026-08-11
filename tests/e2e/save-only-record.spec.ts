import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
} from "./fixture.js";

import {
  expectBox,
  expectHorizontalSplit,
  expectMasonryColumns,
} from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("save-only record UI tracer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user saves original text without AI and sees the new record in the masonry library", async ({
    page,
    request,
  }) => {
    const marker = `e2e-${randomUUID().slice(0, 8)}`;

    await seedRecords(request, marker);
    await page.goto(appUrl("/records"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const recordsLink = navigation.getByRole("link", {
      name: "记录",
      exact: true,
    });
    const toolbar = page.getByRole("search", { name: "记录筛选" });
    const library = page.getByRole("region", { name: "记录列表" });
    const cards = library.getByRole("article");
    const leadCard = library.locator(".record-card.is-lead");
    const flowCards = library.locator(".record-card:not(.is-lead)");

    await expect(recordsLink).toHaveAttribute("aria-current", "page");
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(8);
    await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
    await expectBox(toolbar, { x: 108, y: 198, width: 1_460, height: 74 });
    await expectBox(library, { x: 108, y: 290, width: 1_460 });
    await expectBox(leadCard, { x: 108, y: 294, width: 1_460 });
    const leadBox = await leadCard.boundingBox();

    expect(leadBox).not.toBeNull();
    await expectMasonryColumns(flowCards, {
      columnLefts: [108, 606, 1_104],
      columnWidth: 464,
      top: (leadBox?.y ?? 0) + (leadBox?.height ?? 0) + 38,
      verticalGap: 26,
      minimumDistinctHeights: 3,
    });

    for (let index = 0; index < 8; index += 1) {
      const card = cards.nth(index);

      await expect(card.getByRole("link")).toHaveCount(1);
      await expect(card.getByRole("button")).toHaveCount(0);
    }

    await navigation.getByRole("button", { name: "新建记录" }).click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });
    const contentPane = dialog.getByRole("group", { name: "记录内容" });
    const optionsPane = dialog.getByRole("group", {
      name: "标签与处理方式",
    });
    const textInput = dialog.getByRole("textbox", { name: "记录正文" });
    const saveButton = dialog.getByRole("button", { name: "保存记录" });

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
    await expect(saveButton).toBeDisabled();
    await expect(
      dialog.getByRole("link", { name: "前往模型设置", exact: true }),
    ).toHaveAttribute("href", "/settings#model-settings");

    const title = `Save Only 保留原文 ${marker}`;
    const preview = "第二行保留换行与上下文，不请求 AI 整理。";
    const text = `${title}\n${preview}`;
    const tagName = `我的标签 ${marker}`;

    await textInput.fill(text);
    await dialog.getByRole("combobox", { name: "我的标签" }).fill(tagName);
    await dialog.getByRole("button", { name: "创建标签" }).click();
    await dialog.getByRole("radio", { name: "仅保存" }).check();

    await expect(dialog.getByText(tagName, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "仅保存" })).toBeChecked();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    await expect(page).toHaveURL(/\/records(?:\?.*)?$/u);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status")).toContainText("已保存");
    await expect(
      page.getByRole("status").getByRole("link", { name: "查看记录" }),
    ).toBeVisible();

    const createdCard = library.getByRole("article").filter({ hasText: title });

    await expect(createdCard).toHaveCount(1);
    await expect(
      createdCard.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(createdCard.getByText(preview, { exact: true })).toBeVisible();
    await expect(createdCard.getByText(tagName, { exact: true })).toBeVisible();
    await expect(createdCard.getByText("仅保存", { exact: true })).toBeVisible();
    const savedState = createdCard.locator(".record-state");

    await expect(savedState).toHaveClass(/\bis-saved-only\b/u);
    await expect(savedState.locator(".record-state-mark")).toHaveText("•");
    await expect(
      navigation.getByRole("button", { name: /AI 任务/u }),
    ).toHaveCount(0);
  });
});

async function seedRecords(
  request: APIRequestContext,
  marker: string,
): Promise<void> {
  const contents = [
    `短记录 ${marker}\n一句即可完整表达。`,
    `CDC 如何避免数据库轮询 ${marker}\n通过读取变更日志捕获增量数据。\n保留原始上下文便于核验。`,
    `事件驱动架构的边界与治理 ${marker}\n事件契约需要明确版本、幂等和补偿策略。\n消费者应能独立重试。\n监控必须覆盖积压与失败。`,
    `Exactly Once 的适用边界 ${marker}\n端到端恰好一次依赖多个组件共同保证。`,
    `Redis 数据同步实践 ${marker}\n主从复制用于高可用。\n消息通知用于增量处理。\n故障演练需要覆盖延迟、丢失和重复。\n每项结论都应回到原文核验。`,
    `Schema Evolution 最佳实践 ${marker}\n向前兼容与向后兼容需要分别验证。\n迁移过程必须可回滚。`,
    `日志体系建设指南 ${marker}\n结构化日志提升检索效率。\n采样控制成本。\n关联标识串联调用链。`,
    `分布式锁的正确使用姿势 ${marker}\n锁必须有过期时间。\n业务需要处理续租失败和重复执行。\n监控应覆盖等待时长与超时。`,
  ];

  for (const [index, text] of contents.entries()) {
    const response = await request.post(appUrl("/api/v1/records"), {
      data: {
        text,
        myTags: Array.from({ length: (index % 3) + 1 }, (_, tagIndex) => ({
          name: `预置标签 ${marker} ${index + 1}-${tagIndex + 1}`,
        })),
        processing: "save_only",
      },
    });

    expect(response.status()).toBe(201);
  }
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
