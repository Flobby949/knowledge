import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record tag-only editing UI tracer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("unchanged record cannot be submitted and closes without a dirty warning", async ({
    page,
    request,
  }) => {
    const marker = `unchanged-record-${randomUUID().slice(0, 8)}`;
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: `未修改的原文 ${marker}`,
        myTags: [{ name: `未修改标签 ${marker}` }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const recordId = ((await created.json()) as { record: { id: string } })
      .record.id;

    await page.goto(appUrl(`/records/${recordId}`));
    await page
      .getByRole("toolbar", { name: "记录操作" })
      .getByRole("button", { name: "编辑记录", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "编辑记录" });
    const save = dialog.getByRole("button", {
      name: "保存修改",
      exact: true,
    });

    await expect(save).toBeDisabled();
    await dialog
      .getByRole("button", { name: "关闭编辑记录", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("user adds a tag without creating a new original-text version", async ({
    page,
    request,
  }) => {
    const marker = `edit-record-${randomUUID().slice(0, 8)}`;
    const originalText = `  只编辑标签 ${marker}\n原文尾行保持不变  `;
    const existingTagName = `既有标签 ${marker}`;
    const addedTagName = `新增标签 ${marker}`;
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: originalText,
        myTags: [{ name: existingTagName }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const createdBody = (await created.json()) as {
      record: { id: string };
    };
    const detailUrl = appUrl(`/records/${createdBody.record.id}`);

    await page.goto(detailUrl);
    await expect(page).toHaveURL(detailUrl);

    const toolbar = page.getByRole("toolbar", { name: "记录操作" });

    await toolbar.getByRole("button", { name: "编辑记录" }).click();

    const dialog = page.getByRole("dialog", { name: "编辑记录" });
    const textInput = dialog.getByRole("textbox", { name: "记录正文" });

    await expect(dialog).toBeVisible();
    await expect(textInput).toHaveValue(originalText);
    await expect(
      dialog.getByRole("button", {
        name: `移除标签 ${existingTagName}`,
      }),
    ).toBeVisible();

    await dialog
      .getByRole("combobox", { name: "我的标签" })
      .fill(addedTagName);
    await dialog.getByRole("button", { name: "创建标签" }).click();

    await expect(
      dialog.getByRole("button", { name: `移除标签 ${addedTagName}` }),
    ).toBeVisible();
    await expect(textInput).toHaveValue(originalText);

    await dialog.getByRole("button", { name: "保存修改" }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(detailUrl);

    const detail = page.getByRole("main", { name: "记录详情" });
    const tags = detail
      .getByRole("list", { name: "我的标签" })
      .getByRole("listitem");

    await expect(tags).toHaveCount(2);
    expect(await tags.allTextContents()).toEqual(
      expect.arrayContaining([existingTagName, addedTagName]),
    );
    await expect(detail).toContainText("原文 v1");
    expect(
      await detail.getByLabel("完整原文", { exact: true }).textContent(),
    ).toBe(originalText);
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
