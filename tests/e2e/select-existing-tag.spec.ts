import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("existing user-approved tag selection UI tracer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user searches for and reuses an existing tag when saving a record", async ({
    page,
    request,
  }) => {
    const marker = `existing-tag-${randomUUID().slice(0, 8)}`;
    const tagName = `已认可标签 ${marker}`;
    const seeded = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: `已有记录 ${marker}`,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(seeded.status()).toBe(201);

    const seededBody = (await seeded.json()) as {
      record: {
        myTags: Array<{ id: string; name: string }>;
      };
    };
    const seededTag = seededBody.record.myTags[0]!;

    expect(seededTag).toEqual({
      id: expect.any(String),
      name: tagName,
    });

    await page.goto(appUrl("/records"));
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录" })
      .click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });
    const title = `复用已有标签 ${marker}`;

    await dialog.getByRole("textbox", { name: "记录正文" }).fill(
      `${title}\n这条新记录应复用已有标签身份。`,
    );
    await dialog.getByRole("combobox", { name: "我的标签" }).fill(marker);

    const existingTagOption = dialog
      .getByRole("option")
      .filter({ hasText: tagName })
      .filter({ hasText: "1 条记录" });

    await expect(existingTagOption).toHaveCount(1);
    await expect(existingTagOption).toBeVisible();
    await existingTagOption.click();

    await expect(
      dialog.getByRole("button", { name: `移除标签 ${tagName}` }),
    ).toBeVisible();

    const saveOnly = dialog.getByRole("radio", { name: "仅保存" });
    const saveButton = dialog.getByRole("button", { name: "保存记录" });

    await saveOnly.check();
    await expect(saveOnly).toBeChecked();
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    const status = page.getByRole("status");
    const detailLink = status.getByRole("link", { name: "查看记录" });

    await expect(status).toContainText("已保存");
    await expect(detailLink).toBeVisible();

    const library = page.getByRole("region", { name: "记录列表" });
    const createdCard = library.getByRole("article").filter({ hasText: title });

    await expect(createdCard).toHaveCount(1);
    await expect(createdCard.getByText(tagName, { exact: true })).toBeVisible();

    const detailHref = await detailLink.getAttribute("href");

    expect(detailHref).toMatch(/^\/records\/[^/]+$/u);

    const recordId = new URL(detailHref!, appBaseUrl).pathname.split("/").at(-1)!;
    const detail = await request.get(
      appUrl(`/api/v1/records/${encodeURIComponent(recordId)}`),
    );

    expect(detail.status()).toBe(200);

    const detailBody = (await detail.json()) as {
      editable: {
        myTags: Array<{ id: string; name: string }>;
      };
    };

    expect(detailBody.editable.myTags).toEqual([seededTag]);
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
