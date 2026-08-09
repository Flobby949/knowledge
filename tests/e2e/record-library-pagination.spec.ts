import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("record library effective cards and cursor browsing", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user filters archive scope in the URL while more cards load on scroll", async ({
    page,
    request,
  }) => {
    const marker = `library-ui-${randomUUID().slice(0, 8)}`;

    await enableDeterministicFakeConfiguration(request);

    const archivedTitle = `归档记录 ${marker}`;
    const archivedId = await createRecord(request, {
      tag: `归档标签 ${marker}`,
      text: `${archivedTitle}\n这条记录只在归档范围出现。`,
    });
    expect(
      (
        await request.post(appUrl(`/api/v1/records/${archivedId}/archive`))
      ).status(),
    ).toBe(200);

    await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        const sequence = String(index + 1).padStart(2, "0");

        await createRecord(request, {
          tag: `分页标签 ${sequence} ${marker}`,
          text:
            `分页记录 ${sequence} ${marker}\n` +
            `用于验证无按钮自动续页的自然高度内容 ${sequence}。`.repeat(6),
        });
      }),
    );

    const originalOnlyTitle = `不得出现在有效卡片上的旧原文标题 ${marker}`;
    const organizedId = await createRecord(request, {
      tag: `已整理标签 ${marker}`,
      text: `${originalOnlyTitle}。\n下游按事务边界消费变更 ${marker}。`,
    });
    await organizeAndWait(request, organizedId);

    const recordRequests: URL[] = [];

    page.on("request", (pageRequest) => {
      const url = new URL(pageRequest.url());

      if (
        pageRequest.method() === "GET" &&
        url.pathname === "/api/v1/records"
      ) {
        recordRequests.push(url);
      }
    });

    const filteredRecordsUrl = appUrl(
      `/records?q=${encodeURIComponent(marker)}`,
    );

    await page.goto(filteredRecordsUrl);

    const list = page.getByRole("region", { name: "记录列表" });
    const effectiveCard = list.getByRole("link", {
      name: "打开记录：CDC 与事务日志",
      exact: true,
    });

    await expect(effectiveCard).toContainText(
      "数据库变更捕获与事务日志的整理结果。",
    );
    await expect(effectiveCard).not.toContainText(originalOnlyTitle);

    const archiveFilter = page.getByRole("combobox", {
      name: "归档状态",
      exact: true,
    });

    await expect(archiveFilter).toHaveValue("active");
    await expect(
      page.getByRole("button", { name: /(?:加载更多|第 \d+ 页)/u }),
    ).toHaveCount(0);

    const activeSentinel = page.getByRole("status", {
      name: "继续加载记录",
      exact: true,
    });

    await expect(activeSentinel).toBeVisible();
    await activeSentinel.scrollIntoViewIfNeeded();
    await expect(list.getByRole("article")).toHaveCount(26);
    await expect
      .poll(() =>
        list
          .getByRole("article")
          .first()
          .getByRole("link")
          .evaluate((link) => getComputedStyle(link).contentVisibility),
      )
      .toBe("auto");
    await expect
      .poll(() =>
        list
          .getByRole("article")
          .last()
          .getByRole("link")
          .evaluate((link) => getComputedStyle(link).contentVisibility),
      )
      .toBe("visible");

    const activeRequests = recordRequests.filter(
      (url) => (url.searchParams.get("archive") ?? "active") === "active",
    );
    const continuedRequest = activeRequests.find((url) =>
      url.searchParams.has("cursor"),
    );

    expect(continuedRequest).toBeDefined();
    expect(continuedRequest?.searchParams.get("cursor")).not.toMatch(/^\d+$/u);

    await archiveFilter.selectOption("archived");
    await expect(page).toHaveURL(
      appUrl(
        `/records?q=${encodeURIComponent(marker)}&archive=archived`,
      ),
    );
    await expect(
      list.getByRole("link", {
        name: `打开记录：${archivedTitle}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(list.getByRole("article")).toHaveCount(1);
    await expect(effectiveCard).toHaveCount(0);

    await archiveFilter.selectOption("all");
    await expect(page).toHaveURL(
      appUrl(`/records?q=${encodeURIComponent(marker)}&archive=all`),
    );

    const allSentinel = page.getByRole("status", {
      name: "继续加载记录",
      exact: true,
    });

    await expect(allSentinel).toBeVisible();
    await allSentinel.scrollIntoViewIfNeeded();
    await expect(list.getByRole("article")).toHaveCount(27);
    await expect(effectiveCard).toBeVisible();
    await expect(
      list.getByRole("link", {
        name: `打开记录：${archivedTitle}`,
        exact: true,
      }),
    ).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(
      appUrl(
        `/records?q=${encodeURIComponent(marker)}&archive=archived`,
      ),
    );
    await expect(archiveFilter).toHaveValue("archived");
    await expect(list.getByRole("article")).toHaveCount(1);
  });
});

async function createRecord(
  request: APIRequestContext,
  input: { tag: string; text: string },
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: input.text,
      myTags: [{ name: input.tag }],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);

  return ((await created.json()) as { record: { id: string } }).record.id;
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
    appUrl(`/api/v1/records/${recordId}/organize`),
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
