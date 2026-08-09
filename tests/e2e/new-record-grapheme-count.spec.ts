import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("new record Unicode character count", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("counts a family emoji as one character and blocks the 1001st character without truncating it", async ({
    page,
  }) => {
    const familyEmoji = "👨‍👩‍👧‍👦";
    const maximumText = familyEmoji.repeat(1_000);
    const overLimitText = `${maximumText}${familyEmoji}`;

    await page.goto(appUrl("/records"));
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录" })
      .click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });
    const textInput = dialog.getByRole("textbox", { name: "记录正文" });
    const characterCount = dialog.getByLabel("正文字符计数", {
      exact: true,
    });
    const saveButton = dialog.getByRole("button", { name: "保存记录" });

    await textInput.fill(familyEmoji);

    await expect(characterCount).toHaveText("1 / 1000");

    await textInput.fill(maximumText);

    expect(await textInput.inputValue()).toBe(maximumText);
    await expect(characterCount).toHaveText("1000 / 1000");

    const tagName = `字素测试 ${randomUUID().slice(0, 8)}`;

    await dialog.getByRole("combobox", { name: "我的标签" }).fill(tagName);
    await dialog.getByRole("button", { name: "创建标签" }).click();

    await expect(saveButton).toBeEnabled();

    await textInput.fill(overLimitText);

    expect(await textInput.inputValue()).toBe(overLimitText);
    await expect(characterCount).toHaveText("1001 / 1000");
    await expect(dialog.getByRole("alert")).toContainText(
      "正文不能超过 1000 个字符",
    );
    await expect(saveButton).toBeDisabled();
  });
});

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
