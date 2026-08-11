import { expect, test, type Page } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("complete visual theme switching", () => {
  test.use({
    contextOptions: { reducedMotion: "reduce" },
    viewport: { width: 1_600, height: 1_000 },
  });

  test("switches from both controls and persists across routes and reloads", async ({
    page,
  }) => {
    await page.goto(appUrl("/settings"));

    const root = page.locator("html");
    const appearance = page.getByRole("region", { name: "外观主题" });
    const macaronChoice = appearance.getByRole("radio", {
      name: /马卡龙气泡/u,
    });
    const sciFiChoice = appearance.getByRole("radio", {
      name: /科幻信号场/u,
    });

    await expect(root).toHaveAttribute("data-theme", "macaron");
    await expect(macaronChoice).toBeChecked();
    await sciFiChoice.check();
    await expect(root).toHaveAttribute("data-theme", "scifi");
    await expect(sciFiChoice).toBeChecked();
    await expect(page.getByRole("button", { name: "切换到马卡龙主题" }))
      .toBeVisible();

    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "scifi");
    await expect(sciFiChoice).toBeChecked();

    await page.goto(appUrl("/"));
    const neuralField = page.getByRole("region", { name: "神经标签场" });

    await expect(neuralField).toHaveAttribute("data-state", /deep-space/u);
    await expect(neuralField).toHaveAttribute("data-state", /webgl2/u);
    await expect(page.locator("style[data-knowledge-scifi-theme]"))
      .toHaveCount(1);

    await page.getByRole("button", { name: "切换到马卡龙主题" }).click();
    const bubbleField = page.getByRole("region", { name: "气泡标签场" });

    await expect(root).toHaveAttribute("data-theme", "macaron");
    await expect(bubbleField).toHaveAttribute("data-state", /pastel-space/u);
    await expect(bubbleField).toHaveAttribute("data-state", /webgl2/u);
    await expect(page.locator("style[data-knowledge-scifi-theme]"))
      .toHaveCount(0);

    await page.goto(appUrl("/records"));
    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "macaron");
    await expect(page.getByRole("button", { name: "切换到科幻主题" }))
      .toBeVisible();
  });

  test("keeps the original sci-fi DOM fallback operable without WebGL2", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("knowledge.theme.v1", "scifi");
    });
    await disableWebGl2(page);
    await page.goto(appUrl("/"));

    const field = page.getByRole("region", { name: "神经标签场" });

    await expect(field).toHaveAttribute("data-state", /deep-space/u);
    await expect(field).toHaveAttribute("data-state", /dom-2d/u);
    await expect(
      field.getByRole("status", { name: "渲染模式" }),
    ).toContainText("正在使用简化视图");
    await expect(page.getByRole("search", { name: "首页搜索" }))
      .toBeVisible();
    await expect(field.getByRole("button", { name: "重置视角" }))
      .toBeEnabled();
  });
});

async function disableWebGl2(page: Page) {
  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ) {
        if (contextId === "webgl2") {
          return null;
        }

        return nativeGetContext.call(this, contextId, options);
      },
    });
  });
}

function appUrl(path: string) {
  return new URL(path, appBaseUrl).toString();
}
