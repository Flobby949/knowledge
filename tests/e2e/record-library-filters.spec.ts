import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record library query toolbar and return restoration", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("combines URL filters and restores the loaded masonry anchor after detail", async ({
    page,
    request,
  }) => {
    const marker = `library-filter-${randomUUID().slice(0, 8)}`;
    const query = `QUERY_${marker}`;
    const first = await createRecord(request, {
      tag: { name: `筛选甲 ${marker}` },
      text: `库筛选记录 01 ${marker}\n${query} 第一条。`,
    });
    const second = await createRecord(request, {
      tag: { name: `筛选乙 ${marker}` },
      text: `库筛选记录 02 ${marker}\n${query} 第二条。`,
    });
    const savedRecords = [first, second];

    for (let index = 3; index <= 26; index += 1) {
      const sequence = String(index).padStart(2, "0");
      savedRecords.push(
        await createRecord(request, {
          tag: index % 2 === 0 ? { id: second.tagId } : { id: first.tagId },
          text:
            `库筛选记录 ${sequence} ${marker}\n${query} 第 ${sequence} 条。` +
            `自然高度内容 ${sequence}。`.repeat((index % 4) + 1),
        }),
      );
    }

    await createRecord(request, {
      tag: { name: `筛选丙 ${marker}` },
      text: `只有文本命中 ${marker}\n${query} 但标签不匹配。`,
    });
    await createRecord(request, {
      tag: { id: first.tagId },
      text: `只有标签命中 ${marker}\n没有查询词。`,
    });

    await enableDeterministicFakeConfiguration(request);
    const processed = await createRecord(request, {
      tag: { id: first.tagId },
      text: `${query} 已整理记录 ${marker}\n用于验证处理状态筛选。`,
    });
    await organizeAndWait(request, processed.id);

    expect(
      (
        await request.post(
          appUrl(`/api/v1/records/${encodeURIComponent(first.id)}/archive`),
        )
      ).status(),
    ).toBe(200);

    const libraryRequests: URL[] = [];

    page.on("request", (pageRequest) => {
      const url = new URL(pageRequest.url());

      if (
        pageRequest.method() === "GET" &&
        url.pathname === "/api/v1/records"
      ) {
        libraryRequests.push(url);
      }
    });

    await page.goto(appUrl("/records"));

    const toolbar = page.getByRole("search", { name: "记录筛选" });
    const list = page.getByRole("region", { name: "记录列表" });
    const search = toolbar.getByRole("searchbox", { name: "搜索记录" });

    await search.fill(query);
    expect(new URL(page.url()).searchParams.has("q")).toBe(false);
    await search.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(query);
    await expect(list).toContainText(`只有文本命中 ${marker}`);
    await expect(list).not.toContainText(`只有标签命中 ${marker}`);

    await toolbar.getByRole("button", { name: "标签", exact: true }).click();
    const tagFilters = page.getByRole("group", {
      name: "标签筛选",
      exact: true,
    });

    const firstTagFilter = tagFilters.getByRole("checkbox", {
      name: `筛选甲 ${marker}`,
      exact: true,
    });
    const secondTagFilter = tagFilters.getByRole("checkbox", {
      name: `筛选乙 ${marker}`,
      exact: true,
    });

    await firstTagFilter.click();
    await expect(firstTagFilter).toBeChecked();
    await secondTagFilter.click();
    await expect(secondTagFilter).toBeChecked();
    await expect.poll(() => new URL(page.url()).searchParams.getAll("tag")).toEqual(
      [first.tagId, second.tagId],
    );
    await expect(list).not.toContainText(`只有文本命中 ${marker}`);

    const processing = toolbar.getByRole("combobox", {
      name: "处理状态",
      exact: true,
    });

    await processing.selectOption("saved");
    await expect.poll(() => new URL(page.url()).searchParams.get("processing")).toBe(
      "saved",
    );
    await expect(
      list.getByRole("link", { name: "打开记录：CDC 与事务日志" }),
    ).toHaveCount(0);

    await processing.selectOption("processed");
    await expect(
      list.getByRole("link", { name: "打开记录：CDC 与事务日志" }),
    ).toBeVisible();
    await expect(list.getByRole("article")).toHaveCount(1);
    await processing.selectOption("all");

    const archive = toolbar.getByRole("combobox", {
      name: "归档状态",
      exact: true,
    });

    await archive.selectOption("archived");
    await expect(
      list.getByRole("link", {
        name: `打开记录：库筛选记录 01 ${marker}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(list.getByRole("article")).toHaveCount(1);
    await archive.selectOption("active");

    const sort = toolbar.getByRole("combobox", {
      name: "排序",
      exact: true,
    });

    await sort.selectOption("updated_asc");
    await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe(
      "updated_asc",
    );
    await expect(list.getByRole("article").first()).toContainText(
      `库筛选记录 02 ${marker}`,
    );

    const activeFilters = page.getByRole("region", {
      name: "已启用筛选",
      exact: true,
    });

    await expect(
      activeFilters.getByRole("button", { name: `移除搜索：${query}` }),
    ).toBeVisible();
    await expect(
      activeFilters.getByRole("button", {
        name: `移除标签：筛选甲 ${marker}`,
      }),
    ).toBeVisible();
    await activeFilters
      .getByRole("button", { name: `移除标签：筛选甲 ${marker}` })
      .click();
    await expect.poll(() => new URL(page.url()).searchParams.getAll("tag")).toEqual([
      second.tagId,
    ]);
    await expect(
      list.getByRole("link", { name: "打开记录：CDC 与事务日志" }),
    ).toHaveCount(0);

    await toolbar.getByRole("button", { name: "标签", exact: true }).click();
    await firstTagFilter.click();
    await expect(firstTagFilter).toBeChecked();
    await expect.poll(() => new URL(page.url()).searchParams.getAll("tag")).toEqual(
      [second.tagId, first.tagId],
    );

    const sentinel = page.getByRole("status", {
      name: "继续加载记录",
      exact: true,
    });

    await expect(sentinel).toBeVisible();
    await sentinel.scrollIntoViewIfNeeded();
    await expect(list.getByRole("article")).toHaveCount(26);

    const anchor = list.getByRole("link", {
      name: `打开记录：库筛选记录 26 ${marker}`,
      exact: true,
    });

    await anchor.scrollIntoViewIfNeeded();
    const anchorTop = await anchor.evaluate(
      (element) => element.getBoundingClientRect().top,
    );
    const filteredUrl = page.url();
    const requestCountBeforeDetail = libraryRequests.length;

    await anchor.click();
    await expect(page).toHaveURL(
      appUrl(`/records/${encodeURIComponent(savedRecords[25]!.id)}`),
    );
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(list.getByRole("article")).toHaveCount(26);
    await expect.poll(() => libraryRequests.length).toBe(requestCountBeforeDetail);
    await expect
      .poll(async () =>
        anchor.evaluate(
          (element, expectedTop) =>
            Math.abs(element.getBoundingClientRect().top - expectedTop),
          anchorTop,
        ),
      )
      .toBeLessThan(2);

    await activeFilters
      .getByRole("button", { name: "清除全部", exact: true })
      .click();
    await expect(page).toHaveURL(appUrl("/records"));
    await expect(activeFilters).toHaveCount(0);
  });
});

async function createRecord(
  request: APIRequestContext,
  input: { tag: { id: string } | { name: string }; text: string },
): Promise<{ id: string; tagId: string }> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: input.text,
      myTags: [input.tag],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);
  const record = (await created.json()) as {
    record: { id: string; myTags: Array<{ id: string }> };
  };

  return { id: record.record.id, tagId: record.record.myTags[0]!.id };
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  expect(
    (
      await request.put(appUrl("/api/v1/model-config/draft"), {
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
      })
    ).status(),
  ).toBe(200);

  for (const kind of ["text", "embedding"] as const) {
    expect(
      (
        await request.post(
          appUrl(`/api/v1/model-config/draft/tests/${kind}`),
        )
      ).status(),
    ).toBe(200);
  }

  expect(
    (await request.post(appUrl("/api/v1/model-config/draft/activate"))).status(),
  ).toBe(200);
}

async function organizeAndWait(
  request: APIRequestContext,
  recordId: string,
): Promise<void> {
  const organized = await request.post(
    appUrl(`/api/v1/records/${encodeURIComponent(recordId)}/organize`),
    { data: { handling: "automatic" } },
  );

  expect(organized.status()).toBe(202);
  const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(
      appUrl(`/api/v1/ai-tasks/${encodeURIComponent(taskId)}`),
    );
    const task = (await response.json()) as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    };

    if (task.task.status === "succeeded") {
      return;
    }

    if (task.task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
