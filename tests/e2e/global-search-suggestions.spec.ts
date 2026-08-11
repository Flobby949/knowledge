import { randomUUID } from "node:crypto";

import { expect, test } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("global search suggestions", () => {
  test.use({ viewport: { width: 1_280, height: 800 } });

  test("typing only matches tags locally until the user chooses a search action", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const tagName = `即时定位标签 ${marker}`;
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: `全局搜索建议夹具 ${marker}`,
        myTags: [{ name: tagName }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const tagId = ((await created.json()) as {
      record: { myTags: Array<{ id: string; name: string }> };
    }).record.myTags[0]?.id;

    expect(tagId).toBeDefined();

    let submittedSearches = 0;

    page.on("request", (outgoing) => {
      if (new URL(outgoing.url()).pathname === "/api/v1/search") {
        submittedSearches += 1;
      }
    });

    await page.goto(appUrl("/records"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const search = navigation.getByRole("search", { name: "全局搜索" });
    const input = search.getByRole("searchbox", {
      name: "定位标签或搜索记录",
    });

    await input.fill(marker);

    await expect(
      search
        .getByRole("group", { name: "定位标签" })
        .getByRole("option", { name: tagName, exact: true }),
    ).toBeVisible();
    await expect(
      search
        .getByRole("group", { name: "搜索记录" })
        .getByRole("option", { name: `搜索记录“${marker}”`, exact: true }),
    ).toBeVisible();
    const suggestionsBox = await search
      .locator(".global-search-suggestions")
      .boundingBox();

    expect(suggestionsBox).not.toBeNull();
    expect(suggestionsBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      (suggestionsBox?.x ?? 0) + (suggestionsBox?.width ?? 0),
    ).toBeLessThanOrEqual(1_280);
    expect(submittedSearches).toBe(0);

    await search
      .getByRole("option", { name: tagName, exact: true })
      .click();
    await expect(page).toHaveURL((url) =>
      url.pathname === "/" && url.searchParams.get("tag") === tagId,
    );

    const tagField = page.getByRole("region", { name: "气泡标签场" });
    const focusedTag = tagField
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: tagName, exact: true });

    await expect(focusedTag).toHaveAttribute(
      "data-state",
      /(?:^|\s)focused(?:\s|$)/u,
    );
    await expect(
      tagField.getByRole("status", { name: "标签焦点信息" }),
    ).toContainText(`${tagName} · 已认可 · 1 条记录`);
    await expect
      .poll(async () =>
        Number(await tagField.getAttribute("data-camera-distance")),
      )
      .toBeLessThanOrEqual(7.2);
    expect(submittedSearches).toBe(0);

    await page.goBack();
    await input.fill(`自然语言问题 ${marker}`);
    await input.press("Enter");

    await expect(page).toHaveURL((url) =>
      url.pathname === "/search" &&
      url.searchParams.get("q") === `自然语言问题 ${marker}`,
    );
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
