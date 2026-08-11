import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
} from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("Knowledge Network workspace", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("searches, expands, opens history-backed detail, and verifies path outcomes", async ({
    page,
    request,
  }) => {
    const graph = await seedNetwork(request, randomUUID().slice(0, 8));

    await page.goto(appUrl("/network"));
    const main = page.getByRole("main", { name: "知识网络" });
    const search = main.getByRole("searchbox", { name: "搜索网络节点" });

    await search.fill(graph.source.label);
    await search.press("Enter");
    await main
      .getByRole("button", { name: `选择搜索结果：${graph.source.label}` })
      .click();

    const drawer = page.getByRole("region", { name: "节点详情" });

    await expect(drawer.getByRole("heading", { name: graph.source.label }))
      .toBeVisible();
    await expect(page).toHaveURL(new RegExp(`node=${encodeURIComponent(graph.source.key)}`));
    await expect(main.getByText("2 个 Knowledge Point", { exact: true }))
      .toBeVisible();

    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(page).not.toHaveURL(/(?:\?|&)node=/u);

    await main
      .getByRole("button", { name: `打开节点：${graph.source.label}` })
      .click();
    await drawer.getByRole("button", { name: "设为路径起点" }).click();

    await search.fill(graph.connected.label);
    await search.press("Enter");
    await main
      .getByRole("button", { name: `选择搜索结果：${graph.connected.label}` })
      .click();
    await drawer.getByRole("button", { name: "设为路径终点" }).click();

    const pathStatus = main.getByRole("status", { name: "路径探索结果" });

    await expect(pathStatus).toHaveText("已找到 2 步真实路径。可逐边核验方向与来源。");
    await expect(main.locator('[data-path-edge="true"]')).toHaveCount(2);

    await search.fill(graph.isolated.label);
    await search.press("Enter");
    await main
      .getByRole("button", { name: `选择搜索结果：${graph.isolated.label}` })
      .click();
    await drawer.getByRole("button", { name: "设为路径终点" }).click();

    await expect(pathStatus).toHaveText("没有找到由当前真实边构成的路径。");
    await drawer.getByRole("button", { name: "关闭节点详情" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).not.toHaveURL(/(?:\?|&)node=/u);
    await expect(page).toHaveURL(/(?:\?|&)from=/u);
    await expect(page).toHaveURL(/(?:\?|&)to=/u);
    await expect(pathStatus).toHaveText("没有找到由当前真实边构成的路径。");
  });

  test("keeps core browsing keyboard-operable in the equivalent list", async ({
    page,
    request,
  }) => {
    const graph = await seedNetwork(request, randomUUID().slice(0, 8));

    await page.goto(appUrl("/network?view=list"));
    const main = page.getByRole("main", { name: "知识网络" });
    const list = main.getByRole("region", { name: "网络等价列表" });
    const source = list.getByRole("button", {
      name: `打开节点：${graph.source.label}`,
    });

    await expect(main.getByRole("button", { name: "列表视图" }))
      .toHaveAttribute("aria-pressed", "true");
    const conceptFilter = main.getByRole("checkbox", {
      exact: true,
      name: "Concept",
    });

    await conceptFilter.focus();
    await page.keyboard.press("Space");
    await expect(main.getByText("当前筛选没有可见节点", { exact: true }))
      .toBeVisible();
    await conceptFilter.focus();
    await page.keyboard.press("Space");
    await source.focus();
    await page.keyboard.press("Enter");

    const drawer = page.getByRole("region", { name: "节点详情" });
    const closeDrawer = drawer.getByRole("button", { name: "关闭节点详情" });

    await expect(drawer.getByRole("heading", { name: graph.source.label }))
      .toBeVisible();
    await expect(closeDrawer).toBeFocused();
    await expect(drawer.getByRole("link", { name: "打开 Concept" }))
      .toHaveAttribute("href", `/concepts?concept=${graph.source.id}`);
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("link", { name: "打开 Concept" }))
      .toBeFocused();
    await page.keyboard.press("Tab");
    const startButton = drawer.getByRole("button", { name: "设为路径起点" });

    await expect(startButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(drawer.getByRole("button", { name: "已设为起点" }))
      .toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(source).toBeFocused();
    await expect(page).not.toHaveURL(/(?:\?|&)node=/u);
  });

  test("falls back to the list without discarding URL state when the renderer fails", async ({
    page,
    request,
  }) => {
    const graph = await seedNetwork(request, randomUUID().slice(0, 8));

    await page.addInitScript(() => {
      Object.defineProperty(window, "Worker", {
        configurable: true,
        value: class BrokenNetworkWorker {
          constructor() {
            throw new Error("E2E forced network renderer failure");
          }
        },
      });
    });
    const params = new URLSearchParams({
      node: graph.source.key,
      q: graph.source.label,
      relation: "concept_membership",
      type: "concept",
    });

    await page.goto(appUrl(`/network?${params.toString()}`));

    await expect(
      page.getByRole("alert", { name: "网络渲染状态" }),
    ).toHaveText("图形渲染不可用，已切换到等价列表。所有查询状态均已保留。");
    await expect(page.getByRole("button", { name: "列表视图" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/view=list/u);
    await expect(page).toHaveURL(new RegExp(`node=${encodeURIComponent(graph.source.key)}`));
    await expect(page).toHaveURL(/relation=concept_membership/u);
    await expect(page).toHaveURL(/type=concept/u);
  });
});

async function seedNetwork(request: APIRequestContext, marker: string) {
  await enableDeterministicFakeConfiguration(request, marker);
  const connectedPoints = await createKnowledgePoints(request, `${marker}-a`);
  const isolatedPoints = await createKnowledgePoints(request, `${marker}-b`);
  const source = await createConcept(
    request,
    `事件发布 ${marker}`,
    "生产者把领域变化发布为可订阅事件。",
    connectedPoints,
  );
  const connected = await createConcept(
    request,
    `事件消费 ${marker}`,
    "消费者订阅事件并以幂等方式处理变化。",
    connectedPoints,
  );
  const isolated = await createConcept(
    request,
    `独立校验 ${marker}`,
    "离线校验独立核对数据质量，不与事件链路建立关系。",
    isolatedPoints,
  );

  return { source, connected, isolated };
}

async function createKnowledgePoints(
  request: APIRequestContext,
  marker: string,
): Promise<[string, string]> {
  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text:
        `E2E_NETWORK ${marker} 生产者发布领域事件。\n` +
        `消费者订阅并幂等处理事件 ${marker}。`,
      myTags: [{ name: `网络入口 ${marker}` }],
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

  await expect
    .poll(async () => {
      const response = await request.get(appUrl(`/api/v1/ai-tasks/${taskId}`));
      const body = (await response.json()) as { task: { status: string } };

      return body.task.status;
    })
    .toBe("succeeded");
  const detail = await request.get(appUrl(`/api/v1/records/${recordId}`));
  const body = (await detail.json()) as {
    organizedItems: Array<{ id: string }>;
  };

  if (!body.organizedItems[0] || !body.organizedItems[1]) {
    throw new Error("The deterministic E2E analysis must expose two points");
  }

  return [body.organizedItems[0].id, body.organizedItems[1].id];
}

async function createConcept(
  request: APIRequestContext,
  label: string,
  description: string,
  knowledgePointIds: [string, string],
) {
  const response = await request.post(appUrl("/api/v1/concepts"), {
    data: { name: label, description, knowledgePointIds },
  });

  expect(response.status()).toBe(201);
  const body = (await response.json()) as { detail: { concept: { id: string } } };
  const id = body.detail.concept.id;

  return { id, key: `concept:${id}`, label };
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
  marker: string,
): Promise<void> {
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: `http://127.0.0.1:9/network-${marker}/v1`,
        model: "network-e2e-text",
        apiKey: "network-e2e-key",
      },
      embedding: {
        baseUrl: `http://127.0.0.1:9/network-${marker}/v1`,
        model: "network-e2e-embedding",
        apiKey: "network-e2e-key",
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

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
