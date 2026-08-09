import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("save-only record detail UI tracer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user reads the exact original text without fabricated knowledge", async ({
    page,
    request,
  }) => {
    const marker = `detail-${randomUUID().slice(0, 8)}`;
    const title = `纯文本记录详情 ${marker}`;
    const tagName = `原文标签 ${marker}`;
    const text = [
      `  ${title}  `,
      "",
      "<b>原样</b>",
      "```ts",
      'const markdown = "**只是字符**";',
      "```",
      "# Markdown 也只是字符",
      "尾行保留空白  ",
    ].join("\n");
    const originalText = `\t${text}`;

    const response = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: originalText,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(response.status()).toBe(201);

    const body = (await response.json()) as { record: { id: string } };

    await page.goto(appUrl(`/records/${body.record.id}`));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const recordsLink = navigation.getByRole("link", {
      name: "记录",
      exact: true,
    });
    const toolbar = page.getByRole("toolbar", { name: "记录操作" });
    const detail = page.getByRole("main", { name: "记录详情" });
    const recordPane = detail.getByRole("region", { name: "记录与原文" });
    const knowledgePane = detail.getByRole("region", { name: "知识点" });
    const rawText = recordPane.getByLabel("完整原文", { exact: true });

    await expect(navigation).toBeVisible();
    await expect(recordsLink).toHaveAttribute("aria-current", "page");
    await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
    await expectBox(toolbar, { x: 0, y: 60, width: 1_600, height: 64 });
    await expect(toolbar.getByText("仅保存", { exact: true })).toBeVisible();

    await expectBox(detail, { x: 0, y: 124, width: 1_600 });
    await expectBox(recordPane, { x: 0, y: 124 });
    await expectBox(knowledgePane, { y: 124 });
    await expectHorizontalSplit(recordPane, knowledgePane, {
      leftRatio: 0.58,
      gap: 0,
      ratioTolerance: 0.02,
    });

    await expect(
      recordPane.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      recordPane
        .getByRole("list", { name: "我的标签" })
        .getByText(tagName, { exact: true }),
    ).toBeVisible();
    await expect(rawText).toBeVisible();
    expect(await rawText.textContent()).toBe(originalText);
    await expect(
      rawText.locator("b, strong, em, code, h1, h2, h3, blockquote"),
    ).toHaveCount(0);

    await expect(
      knowledgePane.getByText("尚未整理知识点", { exact: true }),
    ).toBeVisible();
    await expect(knowledgePane.getByRole("article")).toHaveCount(0);

    await toolbar.getByRole("link", { name: "返回记录库" }).click();
    await expect(page).toHaveURL(/\/records(?:\?.*)?$/u);
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
