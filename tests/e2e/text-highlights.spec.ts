import {
  expect,
  test,
  type Locator,
  type APIRequestContext,
} from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const appUrl = (path: string) => `${appBaseUrl}${path}`;

test("highlights source and knowledge, persists colors, handles overlap and failed saves", async ({
  page,
  request,
}) => {
  await enableDeterministicFakeConfiguration(request);
  const text =
    "CDC 读取数据库事务日志🧠。\n事务日志记录增量变更并保留提交顺序。";
  const created = await request.post("/api/v1/records", {
    data: { text, myTags: [{ name: "重点测试" }], processing: "save_only" },
  });
  const id = (await created.json()).record.id;
  const organized = await request.post(`/api/v1/records/${id}/organize`, {
    data: { handling: "automatic" },
  });
  await expectTaskSucceeded(request, (await organized.json()).task.id);
  await page.goto(`/records/${id}`);
  const source = page.locator('[data-highlight-text="source:1"]');
  const knowledge = page.locator('[data-highlight-text^="knowledge:"]').first();
  await expect(source).toHaveText(text);
  const drag = await source.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.setEnd(element.firstChild!, 12);
    const rect = range.getBoundingClientRect();
    return {
      start: rect.left + 1,
      end: rect.right - 1,
      y: rect.top + rect.height / 2,
    };
  });
  await page.mouse.move(drag.start, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.end, drag.y, { steps: 12 });
  await page.mouse.up();
  const palette = page.getByRole("dialog", { name: "标记重点" });
  await expect(palette).toBeVisible();
  await source.click({ position: { x: 2, y: 2 } });
  await expect(palette).not.toBeVisible();
  await selectText(source, 0, 12);
  await page.getByRole("button", { name: "黄色高亮" }).click();
  await expect(
    source.locator('.user-text-highlight[data-color="yellow"]'),
  ).toHaveText(text.slice(0, 12));
  await selectText(knowledge, 0, 6);
  await page.getByRole("button", { name: "粉色高亮" }).click();
  await expect(
    knowledge.locator('.user-text-highlight[data-color="pink"]'),
  ).toHaveText(text.slice(0, 6));
  await page.reload();
  await expect(
    source.locator('.user-text-highlight[data-color="yellow"]'),
  ).toHaveText(text.slice(0, 12));
  await expect(
    knowledge.locator('.user-text-highlight[data-color="pink"]'),
  ).toHaveText(text.slice(0, 6));

  await page
    .getByRole("button", {
      name: "选择知识点：CDC 如何获取数据库变更",
      exact: true,
    })
    .click();
  await expect(source.locator(".source-evidence-highlight")).toHaveCount(1);
  await expect(source.locator(".user-text-highlight")).toHaveText(
    text.slice(0, 12),
  );
  await selectText(source, 4, 8);
  await page.getByRole("button", { name: "蓝色高亮" }).click();
  await expect(source.locator(".user-text-highlight")).toHaveCount(3);
  await source.locator('.user-text-highlight[data-color="blue"]').click();
  await page.getByRole("button", { name: "绿色高亮" }).click();
  await expect(
    source.locator('.user-text-highlight[data-color="green"]'),
  ).toHaveText(text.slice(4, 8));

  await page.getByRole("button", { name: "历史版本", exact: true }).click();
  const history = page.getByRole("dialog", { name: "历史版本", exact: true });
  await expect(
    history.locator('.user-text-highlight[data-color="green"]'),
  ).toHaveText(text.slice(4, 8));
  await history.getByRole("button", { name: "关闭历史版本" }).click();

  await source.locator('.user-text-highlight[data-color="green"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "绿色高亮" })).toBeFocused();
  await page.screenshot({
    path: "test-results/text-highlights-palette.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "取消重点" }).click();
  await expect(source.locator(".user-text-highlight")).toHaveCount(2);

  await page.route("**/highlights/**", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({ status: 503, json: {} });
    else await route.continue();
  });
  await selectText(knowledge, 7, 12);
  await page.getByRole("button", { name: "紫色高亮" }).click();
  await expect(palette.getByRole("alert")).toHaveText("标记未保存，请重试。");
  await expect(
    knowledge.locator('.user-text-highlight[data-color="purple"]'),
  ).toHaveCount(0);
  await page.unroute("**/highlights/**");
  await page.getByRole("button", { name: "紫色高亮" }).click();
  await expect(
    knowledge.locator('.user-text-highlight[data-color="purple"]'),
  ).toHaveCount(1);

  const article = knowledge.locator("xpath=ancestor::article");
  await article.getByRole("button", { name: "修正", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修正知识点", exact: true });
  const body = dialog.getByRole("textbox", { name: "知识点正文" });
  await body.fill(`补充：${await body.inputValue()}`);
  await dialog.getByRole("button", { name: "保存修正" }).click();
  await expect(
    knowledge.locator('.user-text-highlight[data-color="pink"]'),
  ).toHaveText(text.slice(0, 6));
  await page.reload();
  await expect(
    knowledge.locator('.user-text-highlight[data-color="purple"]'),
  ).toHaveText(text.slice(7, 12));
  await expect(source).toHaveText(text);
  await selectText(source, 12, text.length);
  await page.getByRole("button", { name: "蓝色高亮" }).click();
  await expect(
    source.locator('.user-text-highlight[data-color="blue"]'),
  ).toHaveText(text.slice(12), { useInnerText: false });
  await page.getByRole("button", { name: "切换到科幻主题" }).click();
  await source.locator('.user-text-highlight[data-color="blue"]').click();
  await expect(palette).toBeVisible();
  await page.screenshot({
    path: "test-results/text-highlights-scifi.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible();
  await page.reload();
  await expect(
    source.locator('.user-text-highlight[data-color="blue"]'),
  ).toHaveText(text.slice(12), { useInnerText: false });
});

async function selectText(locator: Locator, start: number, end: number) {
  await locator.evaluate(
    (element, offsets) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let started = false;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const length = node.textContent?.length ?? 0;
        if (!started && offsets.start < offset + length) {
          range.setStart(node, offsets.start - offset);
          started = true;
        }
        if (started && offsets.end <= offset + length) {
          range.setEnd(node, offsets.end - offset);
          break;
        }
        offset += length;
      }
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    },
    { start, end },
  );
  await locator.dispatchEvent("pointerup");
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: "http://127.0.0.1:9/e2e-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "e2e-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/e2e-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "e2e-fake-embedding-key",
      },
    },
  });

  expect(saved.status()).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    const tested = await request.post(
      appUrl(`/api/v1/model-config/draft/tests/${kind}`),
    );

    expect(tested.status()).toBe(200);
  }

  const activated = await request.post(
    appUrl("/api/v1/model-config/draft/activate"),
  );

  expect(activated.status()).toBe(200);
}

async function expectTaskSucceeded(
  request: APIRequestContext,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(
      appUrl(`/api/v1/ai-tasks/${encodeURIComponent(taskId)}`),
    );
    const body = (await response.json()) as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (body.task.status === "succeeded") {
      return;
    }

    if (body.task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}
