import { expect, test, type Locator } from "./fixture.js";

import { expectBox, expectHorizontalSplit } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("model settings initial workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user sees independent model endpoints without exposed credentials", async ({
    page,
  }) => {
    await page.goto(appUrl("/settings"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const main = page.getByRole("main", { name: "设置" });
    const anchors = main.getByRole("navigation", { name: "设置分区" });
    const modelPanel = main.getByRole("region", { name: "AI 模型" });
    const currentConfiguration = modelPanel.getByRole("group", {
      name: "当前配置",
    });
    const candidateConfiguration = modelPanel.getByRole("group", {
      name: "候选配置",
    });
    const currentText = currentConfiguration.getByRole("group", {
      name: "文本推理模型",
    });
    const currentEmbedding = currentConfiguration.getByRole("group", {
      name: "嵌入模型",
    });
    const candidateText = candidateConfiguration.getByRole("group", {
      name: "文本推理模型",
    });
    const candidateEmbedding = candidateConfiguration.getByRole("group", {
      name: "嵌入模型",
    });

    await expect(page).toHaveURL(appUrl("/settings"));
    await expect(
      navigation.getByRole("link", { name: "设置", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expectBox(navigation, {
      x: 76,
      y: 0,
      width: 1_524,
      height: 72,
    });
    await expectBox(main, { x: 116, width: 1_444 });

    const modelAnchor = anchors.getByRole("link", {
      name: "AI 模型",
      exact: true,
    });
    const dataAnchor = anchors.getByRole("link", {
      name: "数据管理",
      exact: true,
    });

    await expect(modelAnchor).toBeVisible();
    await expect(dataAnchor).toBeVisible();
    await expectSameRow(modelAnchor, dataAnchor);

    await expectHorizontalSplit(currentText, currentEmbedding, {
      leftRatio: 0.5,
      gap: 20,
      pixelTolerance: 4,
    });
    await expectHorizontalSplit(candidateText, candidateEmbedding, {
      leftRatio: 0.5,
      gap: 20,
      pixelTolerance: 4,
    });

    await expect(
      candidateText.getByLabel("模型标识", { exact: true }),
    ).toHaveValue("deepseek-v4-flash");
    await expect(
      candidateEmbedding.getByLabel("模型标识", { exact: true }),
    ).toHaveValue("BAAI/bge-m3");
    await expect(
      candidateText.getByLabel("Base URL", { exact: true }),
    ).toHaveCount(1);
    await expect(
      candidateEmbedding.getByLabel("Base URL", { exact: true }),
    ).toHaveCount(1);

    const textApiKey = candidateText.getByLabel("API Key", { exact: true });
    const embeddingApiKey = candidateEmbedding.getByLabel("API Key", {
      exact: true,
    });

    await expect(textApiKey).toHaveAttribute("type", "password");
    await expect(embeddingApiKey).toHaveAttribute("type", "password");
    await expect(textApiKey).toHaveValue("");
    await expect(embeddingApiKey).toHaveValue("");
    await expect(
      candidateText.getByRole("status").filter({
        hasText: "已保存凭据",
      }),
    ).toHaveCount(1);
    await expect(
      candidateEmbedding.getByRole("status").filter({
        hasText: "已保存凭据",
      }),
    ).toHaveCount(1);
    await expect(
      currentConfiguration.getByLabel("API Key", { exact: true }),
    ).toHaveCount(0);

    await expect(
      candidateText.getByRole("button", {
        name: "测试连接",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      candidateEmbedding.getByRole("button", {
        name: "测试连接",
        exact: true,
      }),
    ).toBeVisible();

    const activate = candidateConfiguration.getByRole("button", {
      name: "启用候选配置",
      exact: true,
    });

    await expect(activate).toBeDisabled();

    const dataPanel = main.getByRole("region", { name: "数据管理" });
    const operations = dataPanel
      .getByRole("list", { name: "数据管理操作" })
      .getByRole("listitem");

    await expect(operations).toHaveCount(3);
    await expect(
      dataPanel.getByRole("heading", { name: "导出全部数据" }),
    ).toBeVisible();
    await expect(
      dataPanel.getByRole("heading", { name: "恢复到空实例" }),
    ).toBeVisible();
    await expect(
      dataPanel.getByRole("heading", { name: "重建搜索索引" }),
    ).toBeVisible();
  });

  test("user can open settings and sees credentials that can no longer be decrypted", async ({
    page,
  }) => {
    await page.route("**/api/v1/model-config/draft", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          active: {
            version: 2,
            text: {
              baseUrl: "https://old-text-provider.invalid/v1",
              model: "old-text-model",
              credential: "invalid",
            },
            embedding: {
              baseUrl: "https://old-embedding-provider.invalid/v1",
              model: "old-embedding-model",
              credential: "invalid",
            },
          },
          draft: null,
          canActivate: false,
        },
        status: 200,
      });
    });

    await page.goto(appUrl("/settings"));

    const modelPanel = page.getByRole("region", { name: "AI 模型" });
    const currentConfiguration = modelPanel.getByRole("group", {
      name: "当前配置",
    });
    const candidateConfiguration = modelPanel.getByRole("group", {
      name: "候选配置",
    });

    await expect(modelPanel.getByRole("alert")).toContainText(
      "保存的模型凭据已失效",
    );
    await expect(
      currentConfiguration.getByRole("status", { name: "凭据状态" }),
    ).toHaveText(["凭据已失效", "凭据已失效"]);
    await expect(
      candidateConfiguration.getByRole("status", { name: "凭据状态" }),
    ).toHaveText(["凭据已失效，请重新输入", "凭据已失效，请重新输入"]);
    await expect(
      candidateConfiguration.getByRole("button", {
        name: "启用候选配置",
      }),
    ).toBeDisabled();
  });
});

async function expectSameRow(left: Locator, right: Locator): Promise<void> {
  const [leftBox, rightBox] = await Promise.all([
    left.boundingBox(),
    right.boundingBox(),
  ]);

  expect(leftBox, "left anchor must have a rendered box").not.toBeNull();
  expect(rightBox, "right anchor must have a rendered box").not.toBeNull();

  if (!leftBox || !rightBox) {
    return;
  }

  expect(Math.abs(leftBox.y - rightBox.y)).toBeLessThanOrEqual(2);
  expect(leftBox.x + leftBox.width).toBeLessThan(rightBox.x);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
