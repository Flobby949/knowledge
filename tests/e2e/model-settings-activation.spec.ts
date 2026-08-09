import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("model settings candidate activation", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user independently tests both endpoints before activating a credential-safe configuration", async ({
    page,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const textEndpoint = {
      baseUrl: "http://127.0.0.1:9/text/v1",
      model: `deepseek-v4-flash-${marker}`,
      apiKey: `e2e-text-secret-${marker}`,
    };
    const embeddingEndpoint = {
      baseUrl: "http://127.0.0.1:9/embedding/v1",
      model: `BAAI/bge-m3-${marker}`,
      apiKey: `e2e-embedding-secret-${marker}`,
    };

    await page.goto(appUrl("/settings"));

    const main = page.getByRole("main", { name: "设置" });
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
    const textApiKey = candidateText.getByLabel("API Key", { exact: true });
    const embeddingApiKey = candidateEmbedding.getByLabel("API Key", {
      exact: true,
    });
    const activateButton = candidateConfiguration.getByRole("button", {
      name: "启用候选配置",
      exact: true,
    });

    await expect(page).toHaveURL(appUrl("/settings"));
    await expect(textApiKey).toHaveValue("");
    await expect(embeddingApiKey).toHaveValue("");
    await expect(
      candidateText.getByRole("status", { name: "凭据状态" }),
    ).toHaveText("已保存凭据");
    await expect(
      candidateEmbedding.getByRole("status", { name: "凭据状态" }),
    ).toHaveText("已保存凭据");
    await expect(currentConfiguration.getByLabel("API Key")).toHaveCount(0);

    await candidateText
      .getByLabel("Base URL", { exact: true })
      .fill(textEndpoint.baseUrl);
    await candidateText
      .getByLabel("模型标识", { exact: true })
      .fill(textEndpoint.model);
    await textApiKey.fill(textEndpoint.apiKey);
    await candidateEmbedding
      .getByLabel("Base URL", { exact: true })
      .fill(embeddingEndpoint.baseUrl);
    await candidateEmbedding
      .getByLabel("模型标识", { exact: true })
      .fill(embeddingEndpoint.model);
    await embeddingApiKey.fill(embeddingEndpoint.apiKey);

    await candidateConfiguration
      .getByRole("button", { name: "保存候选配置", exact: true })
      .click();

    await expect(textApiKey).toHaveValue("");
    await expect(embeddingApiKey).toHaveValue("");
    await expect(textApiKey).not.toHaveAttribute("value", textEndpoint.apiKey);
    await expect(embeddingApiKey).not.toHaveAttribute(
      "value",
      embeddingEndpoint.apiKey,
    );
    expect(await main.textContent()).not.toContain(textEndpoint.apiKey);
    expect(await main.textContent()).not.toContain(embeddingEndpoint.apiKey);
    await expect(activateButton).toBeDisabled();

    await candidateText
      .getByRole("button", { name: "测试连接", exact: true })
      .click();

    await expect(
      candidateText.getByRole("status", { name: "连接测试状态" }),
    ).toHaveText("测试通过");
    await expect(
      candidateEmbedding.getByRole("status", { name: "连接测试状态" }),
    ).toHaveText("尚未测试");
    await expect(activateButton).toBeDisabled();

    await candidateEmbedding
      .getByRole("button", { name: "测试连接", exact: true })
      .click();

    await expect(
      candidateEmbedding.getByRole("status", { name: "连接测试状态" }),
    ).toHaveText("测试通过");
    await expect(activateButton).toBeEnabled();
    await activateButton.click();

    await expect(
      currentConfiguration.getByRole("status", { name: "配置状态" }),
    ).toContainText("已启用");
    await expect(
      currentText.getByLabel("Base URL", { exact: true }),
    ).toHaveText(textEndpoint.baseUrl);
    await expect(
      currentText.getByLabel("模型标识", { exact: true }),
    ).toHaveText(textEndpoint.model);
    await expect(
      currentEmbedding.getByLabel("Base URL", { exact: true }),
    ).toHaveText(embeddingEndpoint.baseUrl);
    await expect(
      currentEmbedding.getByLabel("模型标识", { exact: true }),
    ).toHaveText(embeddingEndpoint.model);
    await expect(currentConfiguration.getByLabel("API Key")).toHaveCount(0);
    await expect(textApiKey).toHaveValue("");
    await expect(embeddingApiKey).toHaveValue("");
    expect(await main.textContent()).not.toContain(textEndpoint.apiKey);
    expect(await main.textContent()).not.toContain(embeddingEndpoint.apiKey);
    await expect(page).toHaveURL(appUrl("/settings"));
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
