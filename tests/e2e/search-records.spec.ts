import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

import { expectBox } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("keyword search and record detail drawer", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user submits a keyword and verifies its original-text match without leaving search", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const keyword = `精确检索-${marker}`;
    const hitTitle = `搜索命中记录 ${marker}`;
    const hitSnippet = `匹配片段：${keyword} 用于抽屉核验。`;
    const missTitle = `搜索未命中记录 ${marker}`;

    const hitRecordId = await createRecord(
      request,
      `${hitTitle}\n${hitSnippet}`,
      `命中标签 ${marker}`,
    );
    await createRecord(
      request,
      `${missTitle}\n这条记录使用完全不同的检索词。`,
      `未命中标签 ${marker}`,
    );
    await page.goto(appUrl("/"));

    const searchInput = page
      .getByRole("main", { name: "首页" })
      .getByRole("search", { name: "首页搜索" })
      .getByRole("searchbox", { name: "定位标签或搜索记录" });

    await searchInput.fill(keyword);
    await searchInput.press("Enter");

    await expect(page).toHaveURL(searchUrl(keyword));

    const resultStage = page.getByRole("region", { name: "搜索结果" });
    const resultGroups = resultStage.getByRole("article");
    const hitResult = resultGroups.filter({ hasText: hitTitle });

    await expect(resultGroups).toHaveCount(1);
    await expect(hitResult).toHaveCount(1);
    await expect(
      hitResult.getByRole("heading", { name: hitTitle, exact: true }),
    ).toBeVisible();
    await expect(resultStage.getByText(missTitle, { exact: true })).toHaveCount(0);
    await expect(
      hitResult.getByText("命中原文", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("加载更多", { exact: true })).toHaveCount(0);

    await hitResult
      .getByRole("button", { name: `查看搜索详情：${hitTitle}` })
      .click();

    const drawer = page.getByRole("region", { name: "搜索详情" });
    const matchedText = drawer.getByLabel("原文匹配片段", { exact: true });

    await expect(drawer).toBeVisible();
    await expectBox(resultStage, { x: 76, width: 1_044 }, 8);
    await expectBox(drawer, { x: 1_120, width: 480 }, 8);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await matchedText.textContent()).toBe(hitSnippet);
    await expect(page.getByText("加载更多", { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("q")).toBe(keyword);
    expect(new URL(page.url()).searchParams.get("record")).toBe(hitRecordId);

    await expect(
      drawer.getByRole("link", { name: "打开完整详情" }),
    ).toHaveAttribute("href", `/records/${hitRecordId}`);

    await drawer.getByRole("button", { name: "关闭搜索详情" }).click();
    await expect(drawer).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("record")).toBeNull();
    await expect(
      hitResult.getByRole("button", { name: `查看搜索详情：${hitTitle}` }),
    ).toBeFocused();

    await hitResult
      .getByRole("button", { name: `查看搜索详情：${hitTitle}` })
      .click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("record")).toBeNull();
    await expect(
      hitResult.getByRole("button", { name: `查看搜索详情：${hitTitle}` }),
    ).toBeFocused();

    await hitResult
      .getByRole("button", { name: `查看搜索详情：${hitTitle}` })
      .click();
    await expect(drawer).toBeVisible();
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(searchUrl(keyword));

    await hitResult
      .getByRole("button", { name: `查看搜索详情：${hitTitle}` })
      .click();
    await drawer.getByRole("link", { name: "打开完整详情" }).click();
    await expect(page).toHaveURL(appUrl(`/records/${hitRecordId}`));
  });
});

async function createRecord(
  request: APIRequestContext,
  text: string,
  tagName: string,
): Promise<string> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });

  expect(response.status()).toBe(201);

  return ((await response.json()) as { record: { id: string } }).record.id;
}

function searchUrl(query: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", query);

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
