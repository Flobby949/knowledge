import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
} from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("Concept workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("builds, revises, reshapes, archives, and restores a Concept", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const pointIds = await seedTwoKnowledgePoints(request, marker);

    await page.goto(appUrl("/concepts"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const main = page.getByRole("main", { name: "知识概念" });

    await expect(navigation.getByRole("link", { name: "概念" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(main.getByRole("heading", { name: "Concept 图册" })).toBeVisible();
    await main.getByRole("button", { name: "新建 Concept" }).click();

    const creator = main.getByRole("form", { name: "创建 Concept" });

    await creator.getByLabel("Concept 名称").fill(`事件系统 ${marker}`);
    await creator
      .getByLabel("Concept 描述")
      .fill("生产者与消费者通过事件异步协作，并保留各自职责边界。");

    for (const pointId of pointIds) {
      await creator.getByRole("checkbox", { name: pointId }).check();
    }

    await creator.getByRole("button", { name: "创建 Concept" }).click();

    const detail = main.getByRole("region", { name: "Concept 详情" });

    await expect(
      detail.getByRole("heading", { name: `事件系统 ${marker}` }),
    ).toBeVisible();
    await expect(detail.getByRole("article", { name: /Membership/u })).toHaveCount(
      2,
    );
    await expect(detail.getByText("版本 1", { exact: true })).toBeVisible();

    await detail.getByRole("button", { name: "编辑定义" }).click();
    const editor = detail.getByRole("form", { name: "编辑 Concept" });

    await editor.getByLabel("Concept 名称").fill(`事件协作 ${marker}`);
    await editor
      .getByLabel("Concept 描述")
      .fill("事件沿生产、传递与消费链路流动，参与者保持松耦合。");
    await editor.getByRole("button", { name: "保存新版本" }).click();

    await expect(
      detail.getByRole("heading", { name: `事件协作 ${marker}` }),
    ).toBeVisible();
    await expect(detail.getByText("版本 2", { exact: true })).toBeVisible();

    const memberships = detail.getByRole("article", { name: /Membership/u });

    await memberships
      .first()
      .getByRole("button", { name: "移除 Membership" })
      .click();
    await expect(detail.getByText("1 个当前成员", { exact: true })).toBeVisible();

    await detail.getByRole("button", { name: "归档 Concept" }).click();
    await expect(detail.getByText("已归档", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "恢复 Concept" }).click();
    await expect(detail.getByText("生效中", { exact: true })).toBeVisible();
  });
});

async function seedTwoKnowledgePoints(
  request: APIRequestContext,
  marker: string,
): Promise<[string, string]> {
  await enableDeterministicFakeConfiguration(request, marker);
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text:
        `E2E_CONCEPT ${marker} 事件生产者发布事件。\n` +
        `事件消费者订阅并处理事件 ${marker}。`,
      myTags: [{ name: `Concept 入口 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(created.status()).toBe(201);
  const recordId = ((await created.json()) as { record: { id: string } }).record
    .id;
  const organized = await request.post(
    appUrl(`/api/v1/records/${recordId}/organize`),
    { data: { handling: "automatic" } },
  );

  expect(organized.status()).toBe(202);
  const taskId = ((await organized.json()) as { task: { id: string } }).task.id;

  await expectTaskSucceeded(request, taskId);
  const detail = await request.get(appUrl(`/api/v1/records/${recordId}`));
  const points = (await detail.json()) as { organizedItems: Array<{ id: string }> };

  if (!points.organizedItems[0] || !points.organizedItems[1]) {
    throw new Error("The deterministic E2E analysis must expose two points");
  }

  return [points.organizedItems[0].id, points.organizedItems[1].id];
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
  marker: string,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: `http://127.0.0.1:9/concept-${marker}/v1`,
        model: "concept-e2e-text",
        apiKey: "concept-e2e-key",
      },
      embedding: {
        baseUrl: `http://127.0.0.1:9/concept-${marker}/v1`,
        model: "concept-e2e-embedding",
        apiKey: "concept-e2e-key",
      },
    },
  });

  expect(saved.status()).toBe(200);
  expect(
    (
      await request.post(appUrl("/api/v1/model-config/draft/tests/text"))
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.post(appUrl("/api/v1/model-config/draft/tests/embedding"))
    ).status(),
  ).toBe(200);
  expect(
    (await request.post(appUrl("/api/v1/model-config/draft/activate"))).status(),
  ).toBe(200);
}

async function expectTaskSucceeded(
  request: APIRequestContext,
  taskId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(appUrl(`/api/v1/ai-tasks/${taskId}`));
      const body = (await response.json()) as { task: { status: string } };

      return body.task.status;
    })
    .toBe("succeeded");
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
