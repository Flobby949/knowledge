import { expect, test } from "@playwright/test";

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

for (const theme of visualThemes) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((selectedTheme) => {
        window.localStorage.setItem("knowledge.theme.v1", selectedTheme);
      }, theme);
    });

test("Home / 首页气泡标签场 · 1600×1000 基线与 1280×800 几何", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const field = page.getByRole("region", {
    name: theme === "scifi" ? "神经标签场" : "气泡标签场",
  });
  const focusedTag = field.getByRole("button", {
    name: visualFixture.focusedTagName,
    exact: true,
  });

  await expect(focusedTag).toBeVisible();
  await focusedTag.focus();
  await expect(field).toHaveAttribute("data-state", /webgl2/u);
  await expect(field.getByRole("status", { name: "标签焦点信息" }))
    .toContainText(`${visualFixture.focusedTagName} · AI 候选`);
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(field, { x: 0, y: 60, width: 1_600, height: 940 });
  await expect(page).toHaveScreenshot(snapshotName(theme, "home"), {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 1_200,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(field, { x: 0, y: 60, width: 1_280, height: 740 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBe(1_280);
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
