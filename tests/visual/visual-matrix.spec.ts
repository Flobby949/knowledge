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

test("Home / 首页气泡标签场 · 1600×1000 基线与 1280×800 几何", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const field = page.getByRole("region", { name: "气泡标签场" });
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
  await expect(page).toHaveScreenshot("home.png", {
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

test("Records / 记录库 · 1600×1000 基线与 1280×800 真瀑布流", async ({
  page,
}) => {
  await page.goto(`${appBaseUrl}/records`);

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const toolbar = page.getByRole("search", { name: "记录筛选" });
  const cards = page.getByRole("region", { name: "记录列表" })
    .getByRole("article");

  await expect(cards).toHaveCount(12);
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(toolbar, { x: 32, y: 92, width: 1_536, height: 44 });
  await expectMasonryColumns(cards, {
    columnLefts: [32, 422, 812, 1_202],
    columnWidth: 366,
    top: 160,
    verticalGap: 16,
    minimumDistinctHeights: 3,
  });
  await expect(page).toHaveScreenshot("records.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(toolbar, { x: 24, y: 92, width: 1_232, height: 44 });
  await expectMasonryColumns(cards, {
    columnLefts: [24, 338, 652, 966],
    columnWidth: 290,
    top: 160,
    verticalGap: 16,
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
  await expect(page).toHaveScreenshot("new-record-modal.png", {
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

test("Detail / 记录详情 · 1600×1000 基线与 1280×800 的 58/42 双滚动区", async ({
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
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(toolbar, { x: 0, y: 60, width: 1_600, height: 64 });
  await expectBox(main, { x: 0, y: 124, width: 1_600, height: 876 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.58,
    gap: 0,
    ratioTolerance: 0.005,
    pixelTolerance: 1,
  });
  await expect(page).toHaveScreenshot("record-detail.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(toolbar, { x: 0, y: 60, width: 1_280, height: 64 });
  await expectBox(main, { x: 0, y: 124, width: 1_280, height: 676 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.58,
    gap: 0,
    ratioTolerance: 0.005,
    pixelTolerance: 1,
  });
});

test("Review / 待审查 · 1600×1000 基线与 1280×800 的队列、58/42 工作台及流转栏", async ({
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
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(queue, { x: 30, y: 90, width: 1_540, height: 72 });
  await expectBox(workspace, { x: 30, y: 183, width: 1_540, height: 717 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.58,
    gap: 20,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
  await expectBox(flow, { x: 30, y: 919, width: 1_540, height: 68 });
  await expect(page).toHaveScreenshot("review.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(queue, { x: 30, y: 90, width: 1_220, height: 72 });
  await expectBox(workspace, { x: 30, y: 183, width: 1_220, height: 517 });
  await expectHorizontalSplit(sourcePane, pointsPane, {
    leftRatio: 0.58,
    gap: 20,
    ratioTolerance: 0.01,
    pixelTolerance: 2,
  });
  await expectBox(flow, { x: 30, y: 719, width: 1_220, height: 68 });
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
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(stage, { x: 0, y: 60, width: 1_120, height: 940 });
  await expectBox(drawer, { x: 1_120, y: 60, width: 480, height: 940 });
  await expect(page).toHaveScreenshot("search-drawer.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(stage, { x: 0, y: 60, width: 800, height: 740 });
  await expectBox(drawer, { x: 800, y: 60, width: 480, height: 740 });
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
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(main, { x: 0, y: 60, width: 1_120, height: 940 });
  await expectBox(drawer, { x: 1_120, y: 60, width: 480, height: 940 });
  await expectBox(cards.first(), { x: 32, width: 341.33, height: 142 }, 3);
  await expectBox(cards.nth(1), { x: 389.33, width: 341.33, height: 142 }, 3);
  await expectBox(cards.nth(2), { x: 746.67, width: 341.33, height: 142 }, 3);
  await expect(page).toHaveScreenshot("tags-drawer.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.waitForTimeout(220);
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(main, { x: 0, y: 60, width: 800, height: 740 });
  await expectBox(drawer, { x: 800, y: 60, width: 480, height: 740 });
  await expectBox(cards.first(), { x: 24, width: 368, height: 142 }, 3);
  await expectBox(cards.nth(1), { x: 408, width: 368, height: 142 }, 3);
  await expectBox(cards.nth(2), { x: 24, width: 368, height: 142 }, 3);
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
  await expectBox(navigation, { x: 0, y: 0, width: 1_600, height: 60 });
  await expectBox(main, { x: 32, y: 60, width: 1_536 });
  await expectBox(preference, { x: 32, width: 1_536 });
  await expectBox(analysisPrompt, { x: 32, width: 1_536 });
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
  await expect(page).toHaveScreenshot("settings.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: false,
    maxDiffPixels: 500,
  });

  await page.setViewportSize({ width: 1_280, height: 800 });
  await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
  await expectBox(main, { x: 24, y: 60, width: 1_232 });
  await expectBox(preference, { x: 24, width: 1_232 });
  await expectBox(analysisPrompt, { x: 24, width: 1_232 });
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
