import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("default AI handling preference", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test.afterEach(async ({ request }) => {
    await request.patch(appUrl("/api/v1/preferences"), {
      data: { defaultAiHandling: "automatic" },
    });
  });

  test("user makes review the default and sees it selected for a new record", async ({
    page,
    request,
  }) => {
    await enableDeterministicFakeConfiguration(request);

    const resetPreference = await request.patch(appUrl("/api/v1/preferences"), {
      data: { defaultAiHandling: "automatic" },
    });

    expect(resetPreference.status()).toBe(200);
    await page.goto(appUrl("/settings"));

    const modelPanel = page
      .getByRole("main", { name: "设置" })
      .getByRole("region", { name: "AI 模型" });
    const preference = modelPanel.getByRole("group", {
      name: "新记录默认处理",
      exact: true,
    });
    const automatic = preference.getByRole("radio", {
      name: "AI 整理并自动采用",
      exact: true,
    });
    const review = preference.getByRole("radio", {
      name: "AI 整理后由我确认",
      exact: true,
    });

    await expect(automatic).toBeChecked();
    await expect(review).not.toBeChecked();

    const updatePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === "/api/v1/preferences",
    );

    await review.click();

    const update = await updatePromise;

    expect(update.status()).toBe(200);
    await expect(review).toBeChecked();
    await expect(
      preference.getByRole("status", { name: "默认处理状态" }),
    ).toHaveText("默认值已保存");

    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "新记录默认处理", exact: true })
        .getByRole("radio", {
          name: "AI 整理后由我确认",
          exact: true,
        }),
    ).toBeChecked();

    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });

    await expect(
      dialog.getByRole("radio", {
        name: /^AI 整理后由我确认/u,
      }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("radio", {
        name: /^AI 整理并自动采用/u,
      }),
    ).not.toBeChecked();
  });
});

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

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
