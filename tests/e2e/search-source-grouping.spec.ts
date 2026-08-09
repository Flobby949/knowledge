import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("search result source grouping", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("shows every matching source in one record group and marks only matching knowledge points in the drawer", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);

    const marker = randomUUID().slice(0, 8);
    const query = `组内命中 ${marker}`;
    const firstLine = `E2E_TAG_ATLAS ${marker} ${query}`;
    const secondLine = `${query} 出现在第二条原文。`;
    const created = await createRecord(
      request,
      `${firstLine}\n${secondLine}`,
      `搜索来源 ${marker}`,
    );
    const organized = await request.post(
      appUrl(`/api/v1/records/${created.record.id}/organize`),
      { data: { handling: "automatic" } },
    );

    expect(organized.status()).toBe(202);
    await expectTaskSucceeded(
      request,
      ((await organized.json()) as { task: { id: string } }).task.id,
    );
    await page.goto(searchUrl(query));

    const stage = page.getByRole("region", { name: "搜索结果" });
    const results = stage.getByRole("article");

    await expect(results).toHaveCount(1);

    const result = results.first();

    await expect(
      result.getByRole("heading", {
        name: `标签图鉴候选 ${marker}`,
        exact: true,
      }),
    ).toBeVisible();
    const sources = result.getByLabel("命中来源");

    await expect(sources.getByRole("region")).toHaveCount(1);
    const disclosure = sources.getByRole("button", {
      name: /其他 2 个命中来源/u,
    });

    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(sources.getByRole("region")).toHaveCount(3);
    await expect(result.getByText("知识点命中", { exact: true })).toHaveCount(2);
    await expect(result.getByText("原文命中", { exact: true })).toHaveCount(1);
    await expect(result.getByText(firstLine, { exact: true })).toHaveCount(2);
    await expect(result.getByText(secondLine, { exact: true })).toHaveCount(2);

    await result
      .getByRole("button", {
        name: `查看搜索详情：标签图鉴候选 ${marker}`,
      })
      .click();

    const drawer = page.getByRole("region", { name: "搜索详情" });
    const points = drawer.getByRole("region", { name: "当前知识点" });
    const pointCards = points.getByRole("article");

    await expect(pointCards).toHaveCount(2);
    await expect(
      pointCards.filter({ hasText: `共享候选来源一 ${marker}` }),
    ).toContainText("本次命中");
    await expect(
      pointCards.filter({ hasText: `共享候选来源二 ${marker}` }),
    ).toContainText("本次命中");
    await expect(points.getByText("本次命中", { exact: true })).toHaveCount(2);
  });
});

interface CreatedRecord {
  record: { id: string };
}

async function createRecord(
  request: APIRequestContext,
  text: string,
  tagName: string,
): Promise<CreatedRecord> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: [{ name: tagName }],
      processing: "save_only",
    },
  });

  expect(response.status()).toBe(201);

  return (await response.json()) as CreatedRecord;
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: "http://127.0.0.1:9/search-source-grouping-text/v1",
        model: "deepseek-v4-flash",
        apiKey: "search-source-grouping-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/search-source-grouping-embedding/v1",
        model: "BAAI/bge-m3",
        apiKey: "search-source-grouping-fake-embedding-key",
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
    const task = ((await response.json()) as {
      task: { status: "queued" | "running" | "succeeded" | "failed" };
    }).task;

    if (task.status === "succeeded") {
      return;
    }

    if (task.status === "failed") {
      throw new Error(`deterministic AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`deterministic AI task ${taskId} did not succeed`);
}

function searchUrl(query: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", query);

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
