import { expect, test, type Locator, type Page } from "@playwright/test";

import { DEFAULT_ANALYSIS_PROMPT } from "../../src/domain/analysis-prompt.js";
import {
  expectBox,
  expectHorizontalSplit,
  expectMasonryColumns,
} from "../e2e/geometry.js";
import { ensureVisualFixture, visualFixture } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5279";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await ensureVisualFixture(request, appBaseUrl);
});

const visualThemes = ["macaron", "scifi"] as const;

function snapshotName(theme: (typeof visualThemes)[number], name: string) {
  return theme === "macaron" ? `${name}.png` : `scifi-${name}.png`;
}

async function expectHomeTopology(stage: Locator): Promise<void> {
  const topology = await stage.evaluate((element) => ({
    edges: (element.getAttribute("data-edge-keys") ?? "")
      .split(" ")
      .filter(Boolean),
    nodes: (element.getAttribute("data-node-keys") ?? "")
      .split(" ")
      .filter(Boolean),
  }));

  expect(topology.nodes.filter((key) => key.startsWith("concept:")))
    .toHaveLength(1);
  expect(
    topology.nodes.filter((key) => key.startsWith("knowledge_point:")),
  ).toHaveLength(3);
  expect(topology.nodes.some((key) => key.startsWith("tag:"))).toBe(false);
  expect(topology.edges).toHaveLength(3);
  expect(
    topology.edges.every((key) => key.startsWith("concept_membership:")),
  ).toBe(true);
}

async function installHomeVisualNetworkRoutes(page: Page): Promise<void> {
  const concept = networkConcept(
    "41000000-0000-4000-8000-000000000001",
    "变更数据捕获",
    "通过读取事务日志识别增量变化，并以有序事件向下游传播，避免周期轮询造成的负载与延迟。",
    1,
  );
  const points = [
    networkPoint(
      "42000000-0000-4000-8000-000000000001",
      "CDC 捕获增量变化",
      "CDC 读取数据库事务日志获取增量变化，避免对业务库进行周期轮询。",
    ),
    networkPoint(
      "42000000-0000-4000-8000-000000000002",
      "轮询带来的性能问题",
      "传统轮询增加数据库负载，并会放大同步延迟和一致性风险。",
    ),
    networkPoint(
      "42000000-0000-4000-8000-000000000003",
      "事务日志保留提交顺序",
      "事务日志保留变更顺序，使下游可以按提交顺序消费事件。",
    ),
  ];
  const memberships = points.map((point, index) =>
    networkMembership(
      `43000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      concept.key,
      point.key,
    ),
  );
  const expandedNodes = [concept, ...points];

  await page.route("**/api/v1/network/nodes/search**", async (route) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const type = url.searchParams.get("type") ?? "all";
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const matches = expandedNodes.filter(
      (node) =>
        (type === "all" || node.type === type) &&
        node.label.toLocaleLowerCase().includes(query),
    );

    await route.fulfill({
      json: {
        items: matches.slice(0, limit),
        limit,
        truncated: matches.length > limit,
      },
    });
  });
  await page.route("**/api/v1/network/subgraph**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root");

    await route.fulfill({
      json: {
        root,
        nodes: root ? expandedNodes : [concept],
        edges: root ? memberships : [],
        limits: {
          depth: root ? 1 : 0,
          edgeLimit: 600,
          nodeLimit: 300,
        },
        truncated: false,
        truncation: { edges: false, nodes: false },
      },
    });
  });
}

for (const theme of visualThemes) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((selectedTheme) => {
        window.localStorage.setItem("knowledge.theme.v1", selectedTheme);
      }, theme);
    });

test("Home / 首页真实 3D 知识网络 · 双主题、2D 降级与 1280×800 几何", async ({
  context,
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installHomeVisualNetworkRoutes(page);
  await page.goto(`${appBaseUrl}/`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "首页" });
  const stage = main.getByRole("region", {
    name: "真实 3D 知识网络",
  });
  const canvas3d = stage.locator(
    'canvas[aria-label="真实知识网络 3D 图幅"]',
  );
  const networkSearch = main.getByRole("search", {
    name: "首页网络节点搜索",
  });
  const networkSearchbox = networkSearch.getByRole("searchbox", {
    name: "搜索网络节点",
  });

  await expect(stage).toHaveAttribute("data-renderer", "webgl2");
  await expect(stage).toHaveAttribute("data-motion", "reduce");
  await expect(stage).toHaveAttribute("data-node-count", "1");
  await expect(stage).toHaveAttribute("data-edge-count", "0");
  await expect(canvas3d).toBeVisible();
  await expect(canvas3d).toHaveAttribute("data-render-mode", "demand");
  await expect(canvas3d).toHaveAttribute("data-reduced-motion", "true");

  await networkSearchbox.fill("变更数据捕获");
  await networkSearchbox.press("Enter");
  await networkSearch
    .getByRole("button", { name: "选择搜索结果：变更数据捕获" })
    .click();

  const drawer = page.getByRole("region", { name: "节点详情" });

  await expect(drawer.getByRole("heading", { name: "变更数据捕获" }))
    .toBeVisible();
  await expect(stage).toHaveAttribute("data-node-count", "4");
  await expect(stage).toHaveAttribute("data-edge-count", "3");
  await expectHomeTopology(stage);
  await expect(stage).toHaveAttribute("data-renderer", "webgl2");
  await expect(canvas3d).toBeVisible();
  const resetCamera = main.getByRole("button", { name: "重置镜头" });

  await expect(resetCamera).toBeEnabled();
  await resetCamera.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => resolve()),
      ),
  );
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(main, { x: 0, y: 60, width: 1_600, height: 940 });
  await expectBox(stage, { x: 0, y: 60, width: 1_120, height: 940 });
  await expectBox(canvas3d, { x: 0, y: 60, width: 1_120, height: 940 });
  await expectBox(drawer, { x: 1_120, y: 60, width: 480, height: 940 });

  await expect(page).toHaveScreenshot(snapshotName(theme, "home"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 1_200,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(main, { x: 0, y: 60, width: 1_280, height: 740 });
  await expectBox(stage, { x: 0, y: 60, width: 800, height: 740 });
  await expectBox(canvas3d, { x: 0, y: 60, width: 800, height: 740 });
  await expectBox(drawer, { x: 800, y: 60, width: 480, height: 740 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);

  if (theme === "macaron") {
    await context.addInitScript(() => {
      window.localStorage.setItem("knowledge.theme.v1", "macaron");
      const getContext = HTMLCanvasElement.prototype.getContext;

      HTMLCanvasElement.prototype.getContext = function disabledWebGl2(
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ) {
        if (contextId === "webgl2") {
          return null;
        }

        return getContext.call(this, contextId, options);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    const fallbackPage = await context.newPage();

    await fallbackPage.emulateMedia({ reducedMotion: "reduce" });
    await installHomeVisualNetworkRoutes(fallbackPage);
    await fallbackPage.goto(`${appBaseUrl}/`);

    const fallbackMain = fallbackPage.getByRole("main", { name: "首页" });
    const fallbackStage = fallbackMain.getByRole("region", {
      name: "真实 3D 知识网络",
    });
    const fallbackSearch = fallbackMain.getByRole("search", {
      name: "首页网络节点搜索",
    });
    const fallbackSearchbox = fallbackSearch.getByRole("searchbox", {
      name: "搜索网络节点",
    });

    await expect(fallbackStage).toHaveAttribute("data-renderer", "2d");
    await expect(fallbackStage).toHaveAttribute("data-motion", "reduce");
    await fallbackSearchbox.fill("变更数据捕获");
    await fallbackSearchbox.press("Enter");
    await fallbackSearch
      .getByRole("button", { name: "选择搜索结果：变更数据捕获" })
      .click();

    const fallbackCanvas = fallbackMain.getByRole("group", {
      name: "真实知识网络图幅",
    });
    const fallbackDrawer = fallbackPage.getByRole("region", {
      name: "节点详情",
    });

    await expect(fallbackStage).toHaveAttribute("data-node-count", "4");
    await expect(fallbackStage).toHaveAttribute("data-edge-count", "3");
    await expectHomeTopology(fallbackStage);
    await expect(fallbackCanvas.getByRole("button")).toHaveCount(4);
    await expect(
      fallbackCanvas.locator(".network-edges > [role='listitem']"),
    ).toHaveCount(3);
    await expect(
      fallbackDrawer.getByRole("heading", { name: "变更数据捕获" }),
    ).toBeVisible();
    await expectBox(fallbackStage, {
      x: 0,
      y: 60,
      width: 1_120,
      height: 940,
    });
    await expectBox(fallbackDrawer, {
      x: 1_120,
      y: 60,
      width: 480,
      height: 940,
    });
    await expect(fallbackPage).toHaveScreenshot("home-2d-fallback.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: false,
      maxDiffPixels: 1_200,
    });
    await fallbackPage.close();
  }
});

test("Records / 记录库 · 1600×1000 基线与 1280×800 错落摘录流", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/records`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const heading = page.locator(".records-library-heading");
  const toolbar = page.getByRole("search", { name: "记录筛选" });
  const library = page.getByRole("region", { name: "记录列表" });
  const cards = library.getByRole("article");
  const leadCard = library.locator(".record-card.is-lead");
  const flowCards = library.locator(".record-card:not(.is-lead)");

  await expect(cards).toHaveCount(12);
  const organizedState = library.locator(".record-state.is-organized");
  const savedOnlyStates = library.locator(".record-state.is-saved-only");

  await expect(organizedState).toHaveCount(1);
  await expect(organizedState.locator(".record-state-mark")).toHaveText("✓");
  await expect(savedOnlyStates).toHaveCount(11);
  await expect(savedOnlyStates.first().locator(".record-state-mark"))
    .toHaveText("•");
  await expect(organizedState).toHaveCSS(
    "color",
    theme === "scifi" ? "rgb(6, 118, 71)" : "rgb(63, 127, 93)",
  );
  await expect(savedOnlyStates.first()).toHaveCSS(
    "color",
    theme === "scifi" ? "rgb(92, 107, 135)" : "rgb(125, 99, 113)",
  );
  await expect(savedOnlyStates.first().locator(".record-state-mark"))
    .toHaveCSS(
      "background-color",
      theme === "scifi" ? "rgb(248, 250, 255)" : "rgb(255, 253, 253)",
    );
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(heading, { x: 108, y: 90, width: 1_460, height: 106 });
  await expectBox(toolbar, { x: 108, y: 198, width: 1_460, height: 74 });
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
  expect(
    await library.evaluate((element) => getComputedStyle(element).columnRuleStyle),
  ).toBe("none");
  await expect(page).toHaveScreenshot(snapshotName(theme, "records"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(heading, { x: 100, y: 90, width: 1_156, height: 106 });
  await expectBox(toolbar, { x: 100, y: 198, width: 1_156, height: 74 });
  await expectBox(leadCard, { x: 100, y: 294, width: 1_156 });
  const narrowLeadBox = await leadCard.boundingBox();

  expect(narrowLeadBox).not.toBeNull();
  await expectMasonryColumns(flowCards, {
    columnLefts: [100, 496.67, 893.33],
    columnWidth: 362.67,
    top: (narrowLeadBox?.y ?? 0) + (narrowLeadBox?.height ?? 0) + 38,
    verticalGap: 26,
    minimumDistinctHeights: 3,
  });
});

test("New modal / 新建记录 · 1600×1000 基线与 1280×800 的 64/36 弹窗", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/records`);
  await page.getByRole("button", { name: "新建记录", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新建记录" });
  const editor = dialog.getByRole("group", { name: "记录内容" });
  const options = dialog.getByRole("group", { name: "标签与处理方式" });
  const sourceText = [
    "今天梳理 Redis CDC 的落地方案，记录关键设计要点：",
    "1. 监听变更日志捕获事件；",
    "2. 按分区键投递到 Kafka；",
    "3. 下游消费者保持幂等。",
  ].join("\n");

  await dialog.getByRole("textbox", { name: "记录正文" }).fill(sourceText);
  const tagInput = dialog.getByRole("combobox", { name: "我的标签" });

  await tagInput.fill(visualFixture.primaryTagName);
  await dialog.getByRole("option", {
    name: new RegExp(`^${visualFixture.primaryTagName}`),
  }).click();
  await dialog.getByRole("radio", {
    name: /AI 整理后由我确认/u,
  }).check();

  await expect(dialog.getByLabel("正文字符计数")).toHaveText("77 / 1000");
  await expect(dialog.getByLabel("已选标签")).toContainText(
    visualFixture.primaryTagName,
  );
  await expect(dialog.getByRole("button", { name: "保存记录" }))
    .toBeEnabled();
  await expect(dialog.getByRole("link", { name: "前往模型设置" }))
    .toHaveAttribute("href", "/settings#model-settings");
  await expectBox(dialog, { x: 240, y: 150, width: 1_120, height: 700 });
  await expectHorizontalSplit(editor, options, {
    leftRatio: 0.64,
    gap: 32,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
  await expect(page).toHaveScreenshot(snapshotName(theme, "new-record-modal"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(dialog, { x: 80, y: 50, width: 1_120, height: 700 });
  await expectHorizontalSplit(editor, options, {
    leftRatio: 0.64,
    gap: 32,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
});

test("Detail / 记录详情 · 1600×1000 基线与 1280×800 的 60/40 双滚动区", async ({
  page,
}) => {
  await page.goto(
    `${appBaseUrl}/records/${encodeURIComponent(visualFixture.detailRecordId)}`,
  );

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const toolbar = page.getByRole("toolbar", { name: "记录操作" });
  const main = page.getByRole("main", { name: "记录详情" });
  const sourcePane = main.getByRole("region", { name: "记录与原文" });
  const pointsPane = main.getByRole("region", { name: "知识点" });
  const firstPoint = pointsPane.getByRole("button", {
    name: "选择知识点：CDC 捕获增量变化",
    exact: true,
  });

  await expect(pointsPane.getByRole("article")).toHaveCount(3);
  await firstPoint.click();
  await expect(sourcePane.getByLabel("完整原文").locator("mark"))
    .toHaveText("CDC 通过读取数据库事务日志捕获增量变更，并以事件驱动方式实时推送。");
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(toolbar, { x: 76, y: 72, width: 1_524, height: 64 });
  await expectBox(main, { x: 76, y: 136, width: 1_524, height: 864 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.6,
    gap: 0,
    ratioTolerance: 0.005,
    pixelTolerance: 1,
  });
  await expect(page).toHaveScreenshot(snapshotName(theme, "record-detail"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(toolbar, { x: 76, y: 72, width: 1_204, height: 64 });
  await expectBox(main, { x: 76, y: 136, width: 1_204, height: 664 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.6,
    gap: 0,
    ratioTolerance: 0.005,
    pixelTolerance: 1,
  });
});

test("Review / 待审查 · 1600×1000 基线与 1280×800 的队列、60/40 工作台及流转栏", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/review`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const queue = page.getByRole("region", { name: "审查队列" });
  const workspace = page.getByRole("main", { name: "待审查" });
  const sourcePane = workspace.getByRole("region", { name: "记录与原文" });
  const pointsPane = workspace.getByRole("region", { name: "知识点" });
  const flow = page.getByRole("region", { name: "审查流转" });

  await expect(queue.getByLabel("队列位置")).toHaveText("1 / 1");
  await expect(pointsPane.getByRole("article")).toHaveCount(3);
  await pointsPane.getByRole("article").first()
    .getByRole("button", { name: "证据 1 处", exact: true })
    .click();
  await expect(sourcePane.getByLabel("完整原文").locator("mark"))
    .toHaveText("Redis CDC 通过监听写操作日志捕获数据变更事件。");
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(queue, { x: 76, y: 72, width: 1_524, height: 64 });
  await expectBox(workspace, { x: 76, y: 136, width: 1_524, height: 794 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.6,
    gap: 0,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
  await expectBox(flow, { x: 76, y: 930, width: 1_524, height: 70 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "review"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(queue, { x: 76, y: 72, width: 1_204, height: 64 });
  await expectBox(workspace, { x: 76, y: 136, width: 1_204, height: 594 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.6,
    gap: 0,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
  await expectBox(flow, { x: 76, y: 730, width: 1_204, height: 70 });
});

test("Search / 搜索 · 1600×1000 基线与 1280×800 的 480px 推挤抽屉", async ({
  page,
}) => {
  const search = new URLSearchParams({ q: visualFixture.searchQuery });

  await page.goto(`${appBaseUrl}/search?${search.toString()}`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const stage = page.getByRole("main");
  const workspace = page.getByRole("search", { name: "搜索工作台" });
  const readiness = page.getByRole("status", { name: "检索能力状态" });
  const results = page.getByRole("region", { name: "搜索结果" });
  const detailResult = results.getByRole("article").filter({
    hasText: "CDC 如何避免数据库轮询",
  });

  await expect(workspace.getByRole("searchbox", {
    name: "搜索关键词或自然语言",
  })).toHaveValue(visualFixture.searchQuery);
  await expect(workspace.getByRole("button", { name: "搜索记录" }))
    .toBeEnabled();
  await expect(workspace.getByRole("checkbox", { name: "包含待审查内容" }))
    .not.toBeChecked();
  await expect(readiness).toContainText("关键词检索可用");
  await expect(results.getByRole("article")).toHaveCount(2);
  await expect(detailResult).toHaveCount(1);
  await expect(
    detailResult.getByRole("region", {
      name: "AI 概览命中 · 最相关",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    detailResult.getByRole("button", {
      name: /查看其他 \d+ 个命中来源/u,
    }),
  ).toBeVisible();
  await expect(detailResult).toContainText(visualFixture.primaryTagName);
  await expect(page.getByRole("button", { name: /加载更多/u })).toHaveCount(0);
  await detailResult.getByRole("button", {
    name: "查看搜索详情：CDC 如何避免数据库轮询",
    exact: true,
  }).click();

  const drawer = page.getByRole("region", { name: "搜索详情" });
  const effectiveRecord = drawer.getByRole("region", {
    name: "当前有效记录",
  });
  const currentPoints = drawer.getByRole("region", {
    name: "当前知识点",
  });
  const originalExcerpt = drawer.getByRole("region", {
    name: "原文片段",
  });

  await expect(drawer).toBeVisible();
  await expect(effectiveRecord).toContainText(
    "CDC 通过读取数据库事务日志捕获增量变更，并以事件驱动方式向下游实时推送",
  );
  await expect(currentPoints.getByRole("article")).toHaveCount(3);
  await expect(currentPoints).toContainText("CDC 捕获增量变化");
  await expect(originalExcerpt).toContainText("传统轮询会增加数据库负载");
  await expect(drawer.getByLabel("概览匹配片段")).toContainText("CDC");
  await expect(drawer.getByRole("link", { name: "打开完整详情" }))
    .toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(stage, { x: 76, y: 72, width: 1_044, height: 928 });
  await expectBox(drawer, { x: 1_120, y: 72, width: 480, height: 928 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "search-drawer"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(stage, { x: 76, y: 72, width: 724, height: 728 });
  await expectBox(drawer, { x: 800, y: 72, width: 480, height: 728 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);
});

test("Tags / 标签 · 1600×1000 基线与 1280×800 的等尺寸图鉴及 480px 推挤抽屉", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/tags`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "标签图鉴" });
  const atlas = page.getByRole("list", { name: "标签图鉴" });
  const cards = atlas.getByRole("button");

  await expect(cards).toHaveCount(10);
  await expect(atlas.locator("[data-bubble-core], .tag-node-energy"))
    .toHaveCount(0);
  await atlas.getByRole("button", {
    name: visualFixture.primaryTagName,
    exact: true,
  }).click();

  const drawer = page.getByRole("region", { name: "标签详情" });

  await expect(drawer.getByRole("heading", {
    name: visualFixture.primaryTagName,
    exact: true,
  })).toBeVisible();
  await expect(drawer.getByRole("list", { name: "关联记录" })
    .getByRole("listitem")).toHaveCount(2);
  await page.waitForTimeout(220);
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(main, { x: 76, y: 72, width: 1_044, height: 928 });
  await expectBox(drawer, { x: 1_120, y: 72, width: 480, height: 928 });
  await expectBox(cards.first(), { x: 111, width: 325, height: 128 }, 3);
  await expectBox(cards.nth(1), { x: 436, width: 325, height: 128 }, 3);
  await expectBox(cards.nth(2), { x: 761, width: 325, height: 128 }, 3);
  await expect(page).toHaveScreenshot(snapshotName(theme, "tags-drawer"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.waitForTimeout(220);
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(main, { x: 76, y: 72, width: 724, height: 728 });
  await expectBox(drawer, { x: 800, y: 72, width: 480, height: 728 });
  await expectBox(cards.first(), { x: 111, width: 218.33, height: 128 }, 3);
  await expectBox(cards.nth(1), { x: 329.33, width: 218.33, height: 128 }, 3);
  await expectBox(cards.nth(2), { x: 547.67, width: 218.33, height: 128 }, 3);
});

test("Concepts / 概念 · 1600×1000 图册组装台与 1280×800 几何", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/concepts`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "知识概念" });
  const workbench = page.locator(".concept-workbench");
  const catalog = page.getByRole("complementary", {
    name: "Concept 图册索引",
  });
  const stage = page.locator(".concept-stage");
  const detail = page.getByRole("region", { name: "Concept 详情" });

  await expect(
    detail.getByRole("heading", { name: "变更数据捕获", exact: true }),
  ).toBeVisible();
  await expect(detail.getByRole("article", { name: /Membership/u })).toHaveCount(
    3,
  );
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_444 });
  await expectBox(workbench, { x: 116, width: 1_444 });
  await expectBox(catalog, { x: 117, width: 324 });
  await expectBox(stage, { x: 441, width: 1_118 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "concepts"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    mask: [page.locator(".concept-definition-plate dl")],
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_124 });
  await expectBox(workbench, { x: 116, width: 1_124 });
  await expectBox(catalog, { x: 117, width: 292 });
  await expectBox(stage, { x: 409, width: 830 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);
});

test("Concept Candidates / AI 候选 · 1600×1000 审查台与 1280×800 几何", async ({
  page,
  request,
}) => {
  const knowledgePointIds =
    theme === "macaron"
      ? visualFixture.candidatePointIds.slice(0, 2)
      : visualFixture.candidatePointIds.slice(1, 3);
  const created = await request.post(
    `${appBaseUrl}/api/v1/concept-candidate-scans`,
    { data: { knowledgePointIds } },
  );

  expect(created.status()).toBe(202);
  const scanId = ((await created.json()) as { scan: { id: string } }).scan.id;
  let candidateId = "";

  try {
    await expect
      .poll(async () => {
        const response = await request.get(
          `${appBaseUrl}/api/v1/concept-candidate-scans/${scanId}`,
        );
        const body = (await response.json()) as {
          scan: { status: string };
        };

        return body.scan.status;
      })
      .toBe("succeeded");

    const scanResponse = await request.get(
      `${appBaseUrl}/api/v1/concept-candidate-scans/${scanId}`,
    );
    const scan = (await scanResponse.json()) as {
      scan: { candidate: { id: string } };
    };

    candidateId = scan.scan.candidate.id;
    await page.goto(
      `${appBaseUrl}/concepts?view=candidates&scan=${encodeURIComponent(scanId)}`,
    );

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const main = page.getByRole("main", { name: "知识概念" });
    const workbench = page.locator(".candidate-workbench");
    const catalog = page.getByRole("complementary", {
      name: "Concept Candidate 扫描记录",
    });
    const stage = page.locator(".candidate-stage");

    await expect(
      navigation.getByRole("link", { name: "网络", exact: true }),
    ).toBeVisible();
    await expect(
      main
        .getByRole("navigation", { name: "Concept 工作区视图" })
        .getByRole("button", { name: /Concept 关系/u }),
    ).toBeVisible();
    await expect(main.getByRole("heading", { name: /共同机制/u })).toBeVisible();
    await expect(main.getByText("等待人工确认", { exact: true })).toBeVisible();
    await expect(main.locator(".candidate-input-grid article")).toHaveCount(2);
    await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
    await expectBox(main, { x: 116, y: 72, width: 1_444 });
    await expectBox(workbench, { x: 116, width: 1_444 });
    await expectBox(catalog, { x: 117, width: 324 });
    await expectBox(stage, { x: 441, width: 1_118 });
    await expect(page).toHaveScreenshot(
      snapshotName(theme, "concept-candidates"),
      {
        animations: "disabled",
        caret: "hide",
        fullPage: false,
        mask: [
          page.locator(".candidate-catalog-entry small"),
          page.locator(".candidate-detail > header time"),
        ],
        maxDiffPixels: 500,
      },
    );

    await page.setViewportSize({ width: 1_280, height: 800 });
    await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
    await expectBox(main, { x: 116, y: 72, width: 1_124 });
    await expectBox(workbench, { x: 116, width: 1_124 });
    await expectBox(catalog, { x: 117, width: 292 });
    await expectBox(stage, { x: 409, width: 830 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(1_280);
  } finally {
    if (candidateId) {
      expect(
        (
          await request.post(
            `${appBaseUrl}/api/v1/concept-candidates/${candidateId}/reject`,
          )
        ).status(),
      ).toBe(200);
    }
  }
});

test("Concept Relations / 概念关系 · 1600×1000 双定义审查台与 1280×800 几何", async ({
  page,
}) => {
  const suggestion = {
    canDecide: true,
    confidence: 0.87,
    createdAt: "2099-08-09T08:00:00.000Z",
    decidedAt: null,
    description: "变更数据捕获为事件协作提供可靠的增量事实来源。",
    id: "30000000-0000-4000-8000-000000000001",
    model: { configurationVersion: 1, name: "deepseek-v4-flash" },
    needsReview: false,
    reason: "两个 Concept 都围绕增量变化的发布与消费，但各自保留独立职责。",
    relation: null,
    source: {
      archived: false,
      changedSinceSuggestion: false,
      current: true,
      currentMembershipFingerprint: "a".repeat(64),
      currentRevisionId: "31000000-0000-4000-8000-000000000001",
      description:
        "通过读取事务日志识别增量变化，并以有序事件向下游传播，避免周期轮询造成的负载与延迟。",
      id: "32000000-0000-4000-8000-000000000001",
      memberCount: 3,
      membershipFingerprint: "a".repeat(64),
      name: "变更数据捕获",
      revisionId: "31000000-0000-4000-8000-000000000001",
    },
    status: "pending_review",
    target: {
      archived: false,
      changedSinceSuggestion: false,
      current: true,
      currentMembershipFingerprint: "b".repeat(64),
      currentRevisionId: "31000000-0000-4000-8000-000000000002",
      description:
        "生产者发布领域事件，消费者按稳定契约订阅并幂等处理，形成松耦合的异步协作边界。",
      id: "32000000-0000-4000-8000-000000000002",
      memberCount: 4,
      membershipFingerprint: "b".repeat(64),
      name: "事件驱动协作",
      revisionId: "31000000-0000-4000-8000-000000000002",
    },
    type: "extends",
    updatedAt: "2099-08-09T08:00:00.000Z",
  };

  await page.route(
    "**/api/v1/concept-relation-suggestions?*",
    async (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");

      await route.fulfill({
        json: { items: status === "pending" ? [suggestion] : [] },
      });
    },
  );
  await page.goto(
    `${appBaseUrl}/concepts?view=relations&relation=${encodeURIComponent(suggestion.id)}`,
  );

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "知识概念" });
  const review = main.getByRole("region", { name: "Concept Relation 审查" });
  const workbench = review.locator(".concept-relation-workbench");
  const catalog = review.getByRole("complementary", {
    name: "Concept Relation 台账",
  });
  const stage = review.locator(".concept-relation-stage");

  await expect(review.getByRole("heading", { name: "变更数据捕获" }))
    .toBeVisible();
  await expect(review.getByRole("heading", { name: "事件驱动协作" }))
    .toBeVisible();
  await expect(review.getByLabel("Concept 关系类型")).toHaveValue("extends");
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_444 });
  await expectBox(workbench, { x: 116, width: 1_444 });
  await expectBox(catalog, { x: 117, width: 324 });
  await expectBox(stage, { x: 441, width: 1_118 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "concept-relations"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_124 });
  await expectBox(workbench, { x: 116, width: 1_124 });
  await expectBox(catalog, { x: 117, width: 292 });
  await expectBox(stage, { x: 409, width: 830 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);
});

test("Network / 知识网络 · 1600×1000 制图台与 1280×800 开合抽屉几何", async ({
  page,
}) => {
  const conceptA = networkConcept(
    "41000000-0000-4000-8000-000000000001",
    "变更数据捕获",
    "读取事务日志获得增量变化，并以有序事件向下游传播。",
    1,
  );
  const conceptB = networkConcept(
    "41000000-0000-4000-8000-000000000002",
    "事件驱动协作",
    "生产者发布领域事件，消费者按稳定契约订阅并幂等处理。",
    2,
  );
  const conceptC = networkConcept(
    "41000000-0000-4000-8000-000000000003",
    "一致性校验",
    "使用在线与离线校验核对增量链路的最终结果。",
    3,
  );
  const pointA = networkPoint(
    "42000000-0000-4000-8000-000000000001",
    "CDC 捕获增量变化",
    "CDC 读取数据库事务日志获取增量变化。",
  );
  const pointB = networkPoint(
    "42000000-0000-4000-8000-000000000002",
    "幂等消费处理重复事件",
    "幂等处理避免重复投递破坏最终结果。",
  );
  const pointC = networkPoint(
    "42000000-0000-4000-8000-000000000003",
    "校验结果必须可追溯",
    "校验记录保留输入、规则与异常处置历史。",
  );
  const pointD = networkPoint(
    "42000000-0000-4000-8000-000000000004",
    "轮询带来的性能问题",
    "传统轮询会增加数据库负载并放大同步延迟。",
  );
  const membershipA = networkMembership(
    "43000000-0000-4000-8000-000000000001",
    conceptA.key,
    pointA.key,
  );
  const membershipB = networkMembership(
    "43000000-0000-4000-8000-000000000002",
    conceptB.key,
    pointB.key,
  );
  const membershipC = networkMembership(
    "43000000-0000-4000-8000-000000000003",
    conceptC.key,
    pointC.key,
  );
  const membershipD = networkMembership(
    "43000000-0000-4000-8000-000000000004",
    conceptA.key,
    pointD.key,
  );
  const knowledgeRelation = networkRelation(
    "knowledge_relation",
    "44000000-0000-4000-8000-000000000001",
    pointA.key,
    pointB.key,
    "extends",
    true,
    "增量事实沿事件链路延伸为可消费变化。",
  );
  const conceptRelation = networkRelation(
    "concept_relation",
    "45000000-0000-4000-8000-000000000001",
    conceptA.key,
    conceptC.key,
    "contrasts",
    false,
    "增量传播与结果校验承担不同但互补的职责。",
  );
  const conceptNodes = [conceptA, conceptB, conceptC];
  const allNodes = [...conceptNodes, pointA, pointB, pointC, pointD];
  const allEdges = [
    membershipA,
    membershipB,
    membershipC,
    membershipD,
    knowledgeRelation,
    conceptRelation,
  ];
  const path = {
    nodes: [conceptA, pointA, pointB, conceptB],
    edges: [membershipA, knowledgeRelation, membershipB],
    steps: [
      { ...membershipA, traversalDirection: "undirected" },
      { ...knowledgeRelation, traversalDirection: "forward" },
      { ...membershipB, traversalDirection: "undirected" },
    ],
  };

  await page.route("**/api/v1/network/subgraph**", async (route) => {
    const local = new URL(route.request().url()).searchParams.has("root");

    await route.fulfill({
      json: {
        root: local ? conceptA.key : null,
        nodes: local ? allNodes : conceptNodes,
        edges: local ? allEdges : [conceptRelation],
        limits: { depth: 1, edgeLimit: 200, nodeLimit: 100 },
        truncated: false,
        truncation: { nodes: false, edges: false },
      },
    });
  });
  await page.route("**/api/v1/network/path**", async (route) => {
    await route.fulfill({
      json: { path, maxDepth: 6, truncated: false, visited: 6 },
    });
  });
  const params = new URLSearchParams({
    from: conceptA.key,
    node: conceptA.key,
    to: conceptB.key,
  });

  await page.goto(`${appBaseUrl}/network?${params}`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "知识网络" });
  const stage = main.locator(".network-stage");
  const canvas = main.getByRole("group", { name: "真实知识网络图幅" });
  const drawer = page.getByRole("region", { name: "节点详情" });

  await expect(drawer.getByRole("heading", { name: "变更数据捕获" }))
    .toBeVisible();
  await expect(main.getByRole("status", { name: "路径探索结果" }))
    .toHaveText("已找到 3 步真实路径。可逐边核验方向与来源。");
  await expect(main.locator('[data-path-edge="true"]')).toHaveCount(3);
  await expect(canvas.getByRole("button")).toHaveCount(7);
  expect(
    (await canvas.locator(".network-node-label").first().boundingBox())?.height ?? 0,
  ).toBeGreaterThanOrEqual(11);
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(main, { x: 76, y: 72, width: 1_524, height: 928 });
  await expectBox(stage, { x: 76, y: 72, width: 1_044, height: 928 });
  await expectBox(drawer, { x: 1_120, y: 72, width: 480, height: 928 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "network"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await main.getByRole("button", { name: "列表视图" }).click();
  const relationList = main
    .getByRole("region", { name: "网络等价列表" })
    .getByRole("list");

  await expect(relationList.getByText("路径 1", { exact: true })).toBeVisible();
  await expect(relationList.getByText("路径 2", { exact: true })).toBeVisible();
  await expect(relationList.getByText("路径 3", { exact: true })).toBeVisible();
  await expect(relationList.getByText("路径 6", { exact: true })).toHaveCount(0);
  await main.getByRole("button", { name: "图幅视图" }).click();
  await expect(canvas).toBeVisible();

  await page.setViewportSize({ width: 1_280, height: 800 });
  await drawer.getByRole("button", { name: "关闭节点详情" }).click();
  await expect(drawer).toHaveCount(0);
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(main, { x: 76, y: 72, width: 1_204, height: 728 });
  await expectBox(stage, { x: 76, y: 72, width: 1_204, height: 728 });

  await canvas.getByRole("button", { name: "打开节点：变更数据捕获" }).click();
  const reopenedDrawer = page.getByRole("region", { name: "节点详情" });

  await expectBox(stage, { x: 76, y: 72, width: 724, height: 728 });
  await expectBox(reopenedDrawer, { x: 800, y: 72, width: 480, height: 728 });
  expect(
    (await canvas.locator(".network-node-label").first().boundingBox())?.height ?? 0,
  ).toBeGreaterThanOrEqual(11);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);
});

test("Settings / 设置 · 1600×1000 基线与 1280×800 的单页双端控制台", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/settings`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "设置" });
  const modelPanel = main.getByRole("region", { name: "AI 模型" });
  const dataPanel = main.getByRole("region", { name: "数据管理" });
  const preference = modelPanel.getByRole("group", {
    name: "新记录默认处理",
    exact: true,
  });
  const analysisPrompt = modelPanel.getByRole("form", {
    name: "AI 整理提示词",
    exact: true,
  });
  const current = modelPanel.getByRole("group", {
    name: "当前配置",
    exact: true,
  });
  const candidate = modelPanel.getByRole("group", {
    name: "候选配置",
    exact: true,
  });

  await expect(preference.getByRole("radio", {
    name: "AI 整理后由我确认",
    exact: true,
  })).toBeChecked();
  await expect(preference.getByRole("status", {
    name: "默认处理状态",
  })).toHaveText("当前默认：由我确认");
  await expect(analysisPrompt.getByRole("textbox", {
    name: /可编辑 Prompt/u,
  })).toHaveValue(DEFAULT_ANALYSIS_PROMPT);
  await expect(analysisPrompt).toContainText("固定 JSON 输出结构由系统自动追加");
  await expect(current.getByRole("status", { name: "配置状态" }))
    .toContainText("已启用");
  await expect(candidate.getByRole("button", { name: "启用候选配置" }))
    .toBeEnabled();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expectBox(navigation, { x: 76, y: 0, width: 1_524, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_444 });
  await expectBox(preference, { x: 116, width: 1_444 });
  await expectBox(analysisPrompt, { x: 116, width: 1_444 });
  await expectHorizontalSplit(
    current.getByRole("group", { name: "文本推理模型" }),
    current.getByRole("group", { name: "嵌入模型" }),
    {
      leftRatio: 0.5,
      gap: 20,
      ratioTolerance: 0.005,
      pixelTolerance: 2,
    },
  );
  await expectHorizontalSplit(
    candidate.getByRole("group", { name: "文本推理模型" }),
    candidate.getByRole("group", { name: "嵌入模型" }),
    {
      leftRatio: 0.5,
      gap: 20,
      ratioTolerance: 0.005,
      pixelTolerance: 2,
    },
  );
  await expect(dataPanel).toBeVisible();
  await expect(page).toHaveScreenshot(snapshotName(theme, "settings"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 76, y: 0, width: 1_204, height: 72 });
  await expectBox(main, { x: 116, y: 72, width: 1_124 });
  await expectBox(preference, { x: 116, width: 1_124 });
  await expectBox(analysisPrompt, { x: 116, width: 1_124 });
  await expectHorizontalSplit(
    current.getByRole("group", { name: "文本推理模型" }),
    current.getByRole("group", { name: "嵌入模型" }),
    {
      leftRatio: 0.5,
      gap: 20,
      ratioTolerance: 0.005,
      pixelTolerance: 2,
    },
  );
});
  });
}

function networkConcept(
  id: string,
  label: string,
  description: string,
  revisionNumber: number,
) {
  return {
    id,
    key: `concept:${id}`,
    type: "concept" as const,
    label,
    description,
    source: {
      kind: "concept_revision" as const,
      revisionId: id.replace("41000000", "41100000"),
      revisionNumber,
    },
  };
}

function networkPoint(id: string, label: string, description: string) {
  return {
    id,
    key: `knowledge_point:${id}`,
    type: "knowledge_point" as const,
    label,
    description,
    source: {
      kind: "knowledge_point" as const,
      recordId: visualFixture.detailRecordId,
      recordTitle: "CDC 如何避免数据库轮询",
      fragmentRevisionId: "46000000-0000-4000-8000-000000000001",
      analysisRevisionId: "47000000-0000-4000-8000-000000000001",
    },
  };
}

function networkMembership(id: string, source: string, target: string) {
  return {
    edgeKey: `concept_membership:${id}`,
    kind: "concept_membership" as const,
    relationType: "membership",
    source,
    target,
    directed: false,
    description: null,
    confirmation: null,
    sourceRecord: {
      kind: "concept_membership" as const,
      id,
      origin: "manual",
      createdAt: "2099-08-09T08:00:00.000Z",
    },
  };
}

function networkRelation(
  kind: "concept_relation" | "knowledge_relation",
  id: string,
  source: string,
  target: string,
  relationType: string,
  directed: boolean,
  description: string,
) {
  const confirmationKind =
    kind === "concept_relation"
      ? "concept_relation_confirmation"
      : "knowledge_relation_confirmation";

  return {
    edgeKey: `${kind}:${id}`,
    kind,
    relationType,
    source,
    target,
    directed,
    description,
    confirmation: {
      id: id.replace(/^4/u, "5"),
      relationId: id,
      confirmedAt: "2099-08-09T08:00:00.000Z",
    },
    sourceRecord: {
      kind: confirmationKind,
      id: id.replace(/^4/u, "5"),
      relationId: id,
      confirmedAt: "2099-08-09T08:00:00.000Z",
      reason: "视觉基线中的真实确认来源。",
      confidence: 0.88,
    },
  };
}
