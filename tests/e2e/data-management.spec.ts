import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Download,
  type Page,
} from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("settings data management", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("downloads a complete export, explains blocked restore, and keeps keyword search healthy during rebuild", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const title = `Unicode 数据管理 🧠 ${marker}`;
    const keyword = `即时关键词-${marker}`;
    const text =
      `${title}\n组合字符 e\u0301 与家庭表情 👨‍👩‍👧‍👦 保持原样。\n` +
      `索引重建期间仍可检索 ${keyword}。`;

    await createRecord(request, text, `数据管理标签 ${marker}`);
    await installDeterministicSearchHealth(page);
    await page.goto(appUrl("/settings"));

    const main = page.getByRole("main", { name: "设置" });
    const dataPanel = main.getByRole("region", { name: "数据管理" });
    const operations = dataPanel
      .getByRole("list", { name: "数据管理操作" })
      .getByRole("listitem");
    const exportOperation = operations.filter({
      has: page.getByRole("heading", { name: "导出全部数据" }),
    });
    const restoreOperation = operations.filter({
      has: page.getByRole("heading", { name: "恢复到空实例" }),
    });
    const rebuildOperation = operations.filter({
      has: page.getByRole("heading", { name: "重建搜索索引" }),
    });

    await expect(page).toHaveURL(appUrl("/settings"));

    const exportStarted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/exports",
    );
    const exportCompleted = page.waitForResponse(async (response) => {
      const url = new URL(response.url());

      if (
        response.request().method() !== "GET" ||
        !/^\/api\/v1\/exports\/[^/]+$/u.test(url.pathname) ||
        response.status() !== 200
      ) {
        return false;
      }

      const body = (await response.json()) as {
        export?: { status?: string };
      };

      return body.export?.status === "succeeded";
    });

    await exportOperation
      .getByRole("button", { name: "生成导出包", exact: true })
      .click();
    expect((await exportStarted).status()).toBe(202);
    await exportCompleted;

    await expect(
      exportOperation.getByRole("status", { name: "导出状态" }),
    ).toContainText("导出完成");
    await expect(exportOperation.getByLabel("导出完成时间")).not.toHaveText("");

    const downloadPromise = page.waitForEvent("download");

    await exportOperation
      .getByRole("link", { name: "下载完整 ZIP", exact: true })
      .click();

    const download = await downloadPromise;
    const archive = await downloadToBuffer(download);

    expect(download.suggestedFilename()).toMatch(/\.zip$/iu);
    expect(archive.subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );

    await restoreOperation
      .getByLabel("选择完整导出 ZIP", { exact: true })
      .setInputFiles({
        name: download.suggestedFilename(),
        mimeType: "application/zip",
        buffer: archive,
      });

    const inspectedPackage = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/restores/inspect",
    );

    await restoreOperation
      .getByRole("button", { name: "检查恢复包", exact: true })
      .click();

    const inspectionResponse = await inspectedPackage;

    expect(inspectionResponse.status()).toBe(200);
    expect(await inspectionResponse.json()).toMatchObject({
      inspection: {
        status: "valid",
        formatVersion: 10,
        canRestore: false,
        blockingReason: "INSTANCE_NOT_EMPTY",
      },
    });
    await expect(
      restoreOperation.getByRole("status", { name: "恢复检查状态" }),
    ).toContainText("INSTANCE_NOT_EMPTY");
    await expect(
      restoreOperation.getByRole("status", { name: "恢复检查状态" }),
    ).toContainText("当前实例已有领域数据");
    await expect(
      restoreOperation.getByRole("button", { name: "执行恢复", exact: true }),
    ).toBeDisabled();

    const rebuildRequested = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/search-index/rebuild",
    );

    await rebuildOperation
      .getByRole("button", { name: "开始重建", exact: true })
      .click();
    expect((await rebuildRequested).status()).toBe(202);

    await expect(
      rebuildOperation.getByRole("status", { name: "关键词搜索状态" }),
    ).toHaveText("可用");
    await expect(
      rebuildOperation.getByRole("status", { name: "语义索引状态" }),
    ).toContainText("健康");
    await expect(page).toHaveURL(appUrl("/settings"));

    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("link", { name: "首页", exact: true })
      .click();

    const searchInput = page
      .getByRole("main", { name: "首页" })
      .getByRole("search", { name: "首页搜索" })
      .getByRole("searchbox", { name: "定位标签或搜索记录" });

    await searchInput.fill(keyword);
    await searchInput.press("Enter");

    await expect(page).toHaveURL(searchUrl(keyword));

    const results = page.getByRole("region", { name: "搜索结果" });

    await expect(results.getByRole("article")).toHaveCount(1);
    await expect(
      results.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  });
});

async function createRecord(
  request: APIRequestContext,
  text: string,
  tagName: string,
): Promise<void> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });

  expect(response.status()).toBe(201);
}

async function installDeterministicSearchHealth(page: Page): Promise<void> {
  let rebuilt = false;

  await page.route("**/api/v1/search-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        keyword: { status: "ready" },
        semantic: {
          status: rebuilt ? "ready" : "paused",
          model: "e2e-fake-embedding",
          configurationVersion: 1,
          readyDocuments: rebuilt ? 1 : 0,
          totalDocuments: 1,
        },
      }),
    });
  });
  await page.route("**/api/v1/search-index/rebuild", async (route) => {
    rebuilt = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        rebuild: {
          status: "queued",
          model: "e2e-fake-embedding",
          configurationVersion: 1,
        },
      }),
    });
  });
}

async function downloadToBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function searchUrl(query: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", query);

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
