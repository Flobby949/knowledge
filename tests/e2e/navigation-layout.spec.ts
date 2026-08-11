import { expect, test } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

for (const theme of ["macaron", "scifi"] as const) {
  test(`${theme} home navigation keeps every tab clear at 1280px`, async ({
    page,
  }) => {
    await page.addInitScript((selectedTheme) => {
      window.localStorage.setItem("knowledge.theme.v1", selectedTheme);
    }, theme);
    await page.setViewportSize({ width: 1_280, height: 800 });
    await page.goto(appUrl("/"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const primary = navigation.locator(".nav-primary");
    const actions = navigation.locator(".nav-actions");

    await expect(navigation.getByRole("search")).toHaveCount(0);
    await expect(
      page
        .getByRole("main", { name: "首页" })
        .getByRole("search", { name: "首页搜索" }),
    ).toBeVisible();

    for (const label of [
      "首页",
      "记录",
      "待审查",
      "标签",
      "概念",
      "网络",
      "发现",
    ]) {
      await expect(
        navigation.getByRole("link", { name: label, exact: true }),
      ).toBeVisible();
    }

    const primaryBox = await primary.boundingBox();
    const actionsBox = await actions.boundingBox();

    expect(primaryBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect((primaryBox?.x ?? 0) + (primaryBox?.width ?? 0))
      .toBeLessThanOrEqual(actionsBox?.x ?? 0);
    expect((actionsBox?.x ?? 0) + (actionsBox?.width ?? 0))
      .toBeLessThanOrEqual(1_280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(1_280);
  });
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
