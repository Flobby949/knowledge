import { randomUUID } from "node:crypto";

import { expect, test } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record archiving UI tracer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user archives a record while its detail remains readable", async ({
    page,
    request,
  }) => {
    const marker = `archive-ui-${randomUUID().slice(0, 8)}`;
    const originalText = `  待归档记录 ${marker}\n归档后原文仍逐字可读。  `;
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: originalText,
        myTags: [{ name: `归档标签 ${marker}` }],
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

    await toolbar.getByRole("button", { name: "更多操作" }).click();

    const menu = page.getByRole("menu", { name: "更多操作" });

    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "归档记录" }).click();

    const confirmation = page.getByRole("alertdialog", {
      name: "归档记录？",
      exact: true,
    });

    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "确认归档", exact: true })
      .click();

    await expect(confirmation).toBeHidden();
    await expect(page).toHaveURL(detailUrl);

    const detail = page.getByRole("main", { name: "记录详情" });

    await expect(detail).toBeVisible();
    await expect(toolbar).toContainText("已归档");
    await expect(
      toolbar.getByRole("button", { name: "恢复记录" }),
    ).toBeVisible();
    expect(
      await detail.getByLabel("完整原文", { exact: true }).textContent(),
    ).toBe(originalText);

    const activeListResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());

      return (
        response.request().method() === "GET" &&
        url.pathname === "/api/v1/records"
      );
    });

    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "记录", exact: true })
      .click();
    await activeListResponse;

    await expect(page).toHaveURL(appUrl("/records"));
    await expect(
      page.getByRole("region", { name: "记录列表" }),
    ).not.toContainText(marker);
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
