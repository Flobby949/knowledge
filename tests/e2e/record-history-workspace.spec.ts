import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

import { expectBox } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record history workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user opens an earlier version and compares it with the current text", async ({
    page,
    request,
  }) => {
    const marker = `history-${randomUUID().slice(0, 8)}`;
    const v1Text = `  第一版原文 ${marker}\n<b>第一版保持原样</b>\n尾行空白  `;
    const v2Text = `第二版当前原文 ${marker}\n# Markdown 仍是普通字符`;
    const recordId = await createTwoVersionRecord(
      request,
      marker,
      v1Text,
      v2Text,
    );
    const detailUrl = appUrl(`/records/${recordId}`);

    await page.goto(detailUrl);

    const detail = page.getByRole("main", { name: "记录详情" });
    const toolbar = page.getByRole("toolbar", { name: "记录操作" });

    await expect(detail).toBeVisible();
    await toolbar.getByRole("button", { name: "历史版本" }).click();

    const workspace = page.getByRole("dialog", { name: "历史版本" });
    const timeline = workspace.getByRole("tablist", { name: "版本时间轴" });
    const currentTab = timeline.getByRole("tab", { name: "原文 v2 当前" });
    const v1Tab = timeline.getByRole("tab", {
      name: "原文 v1",
      exact: true,
    });

    await expect(workspace).toBeVisible();
    await expectBox(workspace, { x: 0, y: 0, width: 1_600, height: 1_000 });
    await expect(page).toHaveURL(detailUrl);
    await expect(currentTab).toHaveAttribute("aria-selected", "true");
    await expect(v1Tab).toBeVisible();

    await v1Tab.click();

    const selectedText = workspace.getByLabel("版本 v1 原文", {
      exact: true,
    });

    await expect(v1Tab).toHaveAttribute("aria-selected", "true");
    expect(await selectedText.textContent()).toBe(v1Text);

    await workspace
      .getByRole("button", { name: "与当前版本对照" })
      .click();

    const historicalPane = workspace.getByRole("region", {
      name: "历史版本 v1",
    });
    const currentPane = workspace.getByRole("region", {
      name: "当前版本 v2",
    });
    const [historicalBox, currentBox] = await Promise.all([
      historicalPane.boundingBox(),
      currentPane.boundingBox(),
    ]);

    await expect(historicalPane).toBeVisible();
    await expect(currentPane).toBeVisible();
    expect(await historicalPane.getByLabel("完整原文").textContent()).toBe(
      v1Text,
    );
    expect(await currentPane.getByLabel("完整原文").textContent()).toBe(v2Text);
    expect(historicalBox, "historical version must be rendered").not.toBeNull();
    expect(currentBox, "current version must be rendered").not.toBeNull();

    if (historicalBox && currentBox) {
      expect(historicalBox.x + historicalBox.width).toBeLessThanOrEqual(
        currentBox.x,
      );
      expect(Math.abs(historicalBox.y - currentBox.y)).toBeLessThanOrEqual(2);
    }

    await workspace.getByRole("button", { name: "关闭历史版本" }).click();

    await expect(workspace).toBeHidden();
    await expect(page).toHaveURL(detailUrl);
    await expect(detail).toBeVisible();
  });
});

async function createTwoVersionRecord(
  request: APIRequestContext,
  marker: string,
  v1Text: string,
  v2Text: string,
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: v1Text,
      myTags: [{ name: `历史标签 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);

  const createdBody = (await created.json()) as {
    record: {
      id: string;
      myTags: Array<{ id: string }>;
    };
  };
  const tag = createdBody.record.myTags[0];

  if (!tag) {
    throw new Error("created record must return its selected tag");
  }

  const updated = await request.put(
    appUrl(`/api/v1/records/${createdBody.record.id}`),
    {
      data: {
        text: v2Text,
        myTags: [{ id: tag.id }],
        processing: "save_only",
      },
    },
  );

  expect(updated.status()).toBe(200);

  return createdBody.record.id;
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
