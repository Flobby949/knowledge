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
    const networkStage = page.getByRole("region", {
      name: "真实 3D 知识网络",
    });

    await expect(root).toHaveAttribute("data-theme", "scifi");
    await expect(networkStage).toHaveAttribute("data-renderer", "webgl2");
    await expect(page.locator("style[data-knowledge-scifi-theme]"))
      .toHaveCount(1);

    await page.getByRole("button", { name: "切换到马卡龙主题" }).click();

    await expect(root).toHaveAttribute("data-theme", "macaron");
    await expect(networkStage).toHaveAttribute("data-renderer", "webgl2");
    await expect(page.locator("style[data-knowledge-scifi-theme]"))
      .toHaveCount(0);

    await page.goto(appUrl("/records"));
    await page.reload();
    await expect(root).toHaveAttribute("data-theme", "macaron");
    await expect(page.getByRole("button", { name: "切换到科幻主题" }))
      .toBeVisible();
  });

  test("keeps the sci-fi 2D network fallback operable without WebGL2", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("knowledge.theme.v1", "scifi");
    });
    await disableWebGl2(page);
    await installMinimalNetwork(page);
    await page.goto(appUrl("/"));

    const root = page.locator("html");
    const stage = page.getByRole("region", { name: "真实 3D 知识网络" });

    await expect(root).toHaveAttribute("data-theme", "scifi");
    await expect(stage).toHaveAttribute("data-renderer", "2d");
    await expect(
      page.getByRole("alert", { name: "首页网络渲染状态" }),
    ).toContainText("已切换到功能性 2D 视图");
    await expect(page.getByRole("group", { name: "真实知识网络图幅" }))
      .toBeVisible();
    await expect(page.getByRole("search", { name: "首页搜索" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: "重置镜头" }))
      .toBeDisabled();
  });
});

async function installMinimalNetwork(page: Page) {
  const conceptId = "71000000-0000-4000-8000-000000000001";

  await page.route("**/api/v1/network/subgraph**", async (route) => {
    await route.fulfill({
      json: {
        edges: [],
        limits: { depth: 0, edgeLimit: 600, nodeLimit: 300 },
        nodes: [
          {
            description: "用于验证主题切换后的真实网络降级。",
            id: conceptId,
            key: `concept:${conceptId}`,
            label: "主题降级验证",
            source: {
              kind: "concept_revision",
              revisionId: "72000000-0000-4000-8000-000000000001",
              revisionNumber: 1,
            },
            type: "concept",
          },
        ],
        root: null,
        truncated: false,
        truncation: { edges: false, nodes: false },
      },
    });
  });
}

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
