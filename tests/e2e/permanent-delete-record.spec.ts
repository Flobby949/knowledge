import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("permanent record deletion", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("active and archived records use the same isolated destructive flow", async ({
    page,
    request,
  }) => {
    for (const lifecycle of ["active", "archived"] as const) {
      const marker = `delete-ui-${lifecycle}-${randomUUID().slice(0, 8)}`;
      const recordId = await createRecord(request, marker);

      if (lifecycle === "archived") {
        const archived = await request.post(
          appUrl(`/api/v1/records/${recordId}/archive`),
        );

        expect(archived.status()).toBe(200);
      }

      const detailUrl = appUrl(`/records/${recordId}`);

      await page.goto(detailUrl);
      await expect(page).toHaveURL(detailUrl);

      const toolbar = page.getByRole("toolbar", { name: "记录操作" });

      if (lifecycle === "archived") {
        await expect(toolbar).toContainText("已归档");
        await expect(
          toolbar.getByRole("button", { name: "恢复记录", exact: true }),
        ).toBeVisible();
      }

      const confirmation = await openPermanentDeleteDialog(page);

      await expect(confirmation).toContainText("此操作不可恢复");
      await expect(confirmation).toContainText(
        "原文及历史版本、AI 整理结果、用户修正、证据和这条记录的标签关联都会永久删除。",
      );

      const cancel = confirmation.getByRole("button", {
        name: "取消",
        exact: true,
      });
      const destructiveAction = confirmation.getByRole("button", {
        name: "永久删除",
        exact: true,
      });

      await expect(cancel).toBeFocused();
      await cancel.press("Shift+Tab");
      await expect(destructiveAction).toBeFocused();
      await destructiveAction.press("Tab");
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(confirmation).toBeHidden();
      await expect(page).toHaveURL(detailUrl);
      await expect(
        toolbar.getByRole("button", { name: "更多操作", exact: true }),
      ).toBeFocused();

      const reopenedConfirmation = await openPermanentDeleteDialog(page);
      const deleteRoute = `**/api/v1/records/${recordId}`;
      let releaseDeleteResponse: (() => void) | undefined;

      if (lifecycle === "active") {
        await page.route(deleteRoute, async (route) => {
          if (route.request().method() !== "DELETE") {
            await route.continue();
            return;
          }

          const response = await route.fetch();

          await new Promise<void>((resolve) => {
            releaseDeleteResponse = resolve;
          });
          await route.fulfill({ response });
        });
      }

      const deletedResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname === `/api/v1/records/${recordId}`,
      );

      await reopenedConfirmation
        .getByRole("button", { name: "永久删除", exact: true })
        .click();

      if (lifecycle === "active") {
        await expect(reopenedConfirmation).toBeFocused();
        await reopenedConfirmation.press("Tab");
        await expect(reopenedConfirmation).toBeFocused();
        await expect.poll(() => Boolean(releaseDeleteResponse)).toBe(true);
        releaseDeleteResponse?.();
      }

      expect((await deletedResponse).status()).toBe(204);
      await expect(page).toHaveURL(appUrl("/records"));
      await expect(
        page.getByRole("region", { name: "记录列表" }),
      ).not.toContainText(marker);

      const deletedDetail = await request.get(
        appUrl(`/api/v1/records/${recordId}`),
      );

      expect(deletedDetail.status()).toBe(404);

      if (lifecycle === "active") {
        await page.unroute(deleteRoute);
      }
    }
  });

  test("permanent deletion stays available while AI is running", async ({
    page,
    request,
  }) => {
    const gateId = randomUUID().slice(0, 8);
    const marker = `E2E_DELETE_DURING_AI ${gateId}`;

    await enableDeterministicFakeConfiguration(request);

    const recordId = await createRecord(request, marker);
    const organized = await request.post(
      appUrl(`/api/v1/records/${recordId}/organize`),
      { data: { handling: "automatic" } },
    );

    expect(organized.status()).toBe(202);
    const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

    await expectOrganizationRunning(request, recordId);
    await expect
      .poll(async () => {
        const response = await request.get(
          appUrl(`/api/v1/e2e/ai-gates/${encodeURIComponent(gateId)}`),
        );

        if (!response.ok()) {
          return false;
        }

        return ((await response.json()) as { started: boolean }).started;
      })
      .toBe(true);

    await page.goto(appUrl(`/records/${recordId}`));

    const toolbar = page.getByRole("toolbar", { name: "记录操作" });

    await expect(toolbar.getByLabel("处理状态")).toContainText("正在整理");
    await toolbar
      .getByRole("button", { name: "更多操作", exact: true })
      .click();

    const menu = page.getByRole("menu", { name: "更多操作" });

    await expect(
      menu.getByRole("menuitem", { name: "归档记录", exact: true }),
    ).toBeDisabled();
    await expect(
      menu.getByRole("menuitem", { name: "永久删除", exact: true }),
    ).toBeEnabled();

    await menu
      .getByRole("menuitem", { name: "永久删除", exact: true })
      .click();
    await page
      .getByRole("alertdialog", { name: "永久删除记录？", exact: true })
      .getByRole("button", { name: "永久删除", exact: true })
      .click();

    await expect(page).toHaveURL(appUrl("/records"));
    await expect(
      page.getByRole("region", { name: "记录列表" }),
    ).not.toContainText(marker);

    const released = await request.post(
      appUrl(`/api/v1/e2e/ai-gates/${encodeURIComponent(gateId)}/release`),
    );

    expect(released.status()).toBe(204);
    await expect
      .poll(async () => {
        const response = await request.get(
          appUrl(`/api/v1/e2e/ai-tasks/${encodeURIComponent(taskId)}/settled`),
        );

        if (!response.ok()) {
          return false;
        }

        return ((await response.json()) as { settled: boolean }).settled;
      })
      .toBe(true);

    expect(
      (await request.get(appUrl(`/api/v1/records/${recordId}`))).status(),
    ).toBe(404);
    expect(
      (await request.get(appUrl(`/api/v1/ai-tasks/${taskId}`))).status(),
    ).toBe(404);
  });
});

async function openPermanentDeleteDialog(page: Page) {
  const toolbar = page.getByRole("toolbar", { name: "记录操作" });

  await toolbar
    .getByRole("button", { name: "更多操作", exact: true })
    .click();

  const menu = page.getByRole("menu", { name: "更多操作" });
  const dangerGroup = menu.getByRole("group", {
    name: "危险操作",
    exact: true,
  });

  await expect(dangerGroup).toBeVisible();
  await expect(dangerGroup.getByRole("menuitem")).toHaveCount(1);
  await dangerGroup
    .getByRole("menuitem", { name: "永久删除", exact: true })
    .click();

  const confirmation = page.getByRole("alertdialog", {
    name: "永久删除记录？",
    exact: true,
  });

  await expect(confirmation).toBeVisible();

  return confirmation;
}

async function createRecord(
  request: APIRequestContext,
  marker: string,
): Promise<string> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: `待永久删除记录 ${marker}。\n迟到的 AI 结果也不能恢复这条记录。`,
      myTags: [{ name: `永久删除标签 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);

  return ((await created.json()) as { record: { id: string } }).record.id;
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

async function expectOrganizationRunning(
  request: APIRequestContext,
  recordId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request.get(appUrl(`/api/v1/records/${recordId}`));
    const detail = (await response.json()) as {
      organization: { activity: "idle" | "queued" | "running" | "failed" };
    };

    if (detail.organization.activity === "running") {
      return;
    }

    if (
      detail.organization.activity === "idle" ||
      detail.organization.activity === "failed"
    ) {
      throw new Error("deterministic AI task ended before deletion was exercised");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("deterministic AI task did not enter running state");
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
