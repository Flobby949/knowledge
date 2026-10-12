import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

interface CreatedTag {
  id: string;
  name: string;
}

test.describe("multi-level tags", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user creates the first child of a new tag entirely through the UI", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const rootName = `开发 ${marker}`;
    const childName = `工具 ${marker}`;

    await page.goto(appUrl("/tags"));

    const main = page.getByRole("main", { name: "标签图鉴" });
    const form = main.getByRole("form", { name: "新建标签" });
    const drawer = page.getByRole("region", { name: "标签详情" });

    await main.getByRole("button", { name: "新建标签", exact: true }).click();
    await form.getByLabel("标签名称").fill(rootName);
    await form.getByRole("button", { name: "创建标签", exact: true }).click();
    await expect(drawer.getByRole("heading", { name: rootName, exact: true }))
      .toBeVisible();
    await drawer.getByRole("link", { name: "新增下级" }).click();
    await expect(main.getByRole("navigation", { name: "标签层级" }))
      .toContainText(rootName);
    await expect(main).toContainText("这一层还没有下级标签");

    await main.getByRole("button", { name: "新建标签", exact: true }).click();
    await form.getByLabel("标签名称").fill(childName);
    await form.getByRole("button", { name: "创建标签", exact: true }).click();
    await expect(drawer.getByRole("heading", { name: childName, exact: true }))
      .toBeVisible();
    await expect(drawer).toContainText(`位于“${rootName}”之下`);

    const listed = await request.get(appUrl("/api/v1/tags?approval=user_approved"));
    const { items } = await listed.json() as {
      items: Array<{ id: string; name: string; parentId: string | null }>;
    };

    expect(items.find(({ name }) => name === childName)?.parentId).toBe(
      items.find(({ name }) => name === rootName)?.id,
    );
  });

  test("user browses levels, moves a tag, and filters records through its descendants", async ({
    page,
    request,
  }) => {
    const marker = randomUUID().slice(0, 8);
    const root = await createTag(request, `编程 ${marker}`);
    const frontend = await createTag(request, `前端 ${marker}`, root.id);
    const react = await createTag(request, `React ${marker}`, frontend.id);
    const tooling = await createTag(request, `构建工具 ${marker}`);
    const reactRecord = `React 组件拆分 ${marker}`;
    const toolingRecord = `打包配置记录 ${marker}`;

    await createRecord(request, reactRecord, [react.id]);
    await createRecord(request, toolingRecord, [tooling.id]);

    await page.goto(appUrl("/tags"));

    const main = page.getByRole("main", { name: "标签图鉴" });
    const atlas = main.getByRole("list", { name: "标签图鉴" });
    const drawer = page.getByRole("region", { name: "标签详情" });

    await expect(atlas.getByRole("button", { name: root.name })).toContainText(
      "1 条记录",
    );
    await expect(atlas.getByRole("button", { name: root.name })).toContainText(
      "直接关联 0 条",
    );
    await expect(atlas.getByRole("button", { name: frontend.name })).toHaveCount(0);

    await atlas
      .getByRole("link", { name: `进入“${root.name}”的 1 个下级标签` })
      .click();
    await expect(page).toHaveURL(appUrl(`/tags?level=${root.id}`));

    const trail = main.getByRole("navigation", { name: "标签层级" });

    await expect(trail.getByRole("link", { name: "全部标签" })).toBeVisible();
    await expect(trail).toContainText(root.name);
    await expect(atlas.getByRole("button", { name: frontend.name })).toBeVisible();

    await main.getByRole("searchbox", { name: "搜索标签" }).fill(root.name);
    await atlas.getByRole("button", { name: root.name, exact: true }).click();
    await drawer.getByRole("link", { name: "浏览下级" }).click();
    await expect(main.getByRole("searchbox", { name: "搜索标签" }))
      .toHaveValue("");
    await expect(trail).toContainText(root.name);
    await expect(atlas.getByRole("button", { name: frontend.name })).toBeVisible();

    await atlas
      .getByRole("link", { name: `进入“${frontend.name}”的 1 个下级标签` })
      .click();
    await expect(atlas.getByRole("button", { name: react.name })).toBeVisible();
    await expect(trail.getByRole("link", { name: root.name })).toBeVisible();

    await trail.getByRole("link", { name: "全部标签" }).click();
    await expect(page).toHaveURL(appUrl("/tags"));
    await atlas.getByRole("button", { name: tooling.name }).click();

    await expect(drawer).toContainText("位于顶层");
    await drawer
      .getByLabel("移动到")
      .selectOption({ label: `${root.name} › ${frontend.name}` });
    await drawer.getByRole("button", { name: "移动", exact: true }).click();
    await expect(drawer).toContainText(
      `已移动到“${root.name} › ${frontend.name}”之下。`,
    );
    await expect(atlas.getByRole("button", { name: tooling.name })).toHaveCount(0);
    await expect(atlas.getByRole("button", { name: root.name })).toContainText(
      "2 条记录",
    );
    await expect(atlas.getByRole("button", { name: root.name })).toContainText(
      "直接关联 0 条",
    );

    await main.getByRole("searchbox", { name: "搜索标签" }).fill(tooling.name);
    await expect(atlas.getByRole("button", { name: tooling.name })).toContainText(
      `${root.name} › ${frontend.name}`,
    );

    await page.goto(appUrl(`/search?tag=${root.id}`));

    const results = page.getByRole("region", { name: "搜索结果" });

    await expect(
      results.getByRole("heading", { name: reactRecord, exact: true }),
    ).toBeVisible();
    await expect(
      results.getByRole("heading", { name: toolingRecord, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "标签硬筛选" }),
    ).toContainText(`${root.name}（含下级）`);

    await page.goto(appUrl("/"));
    await page.getByRole("group", { name: "首页知识视图" })
      .getByRole("button", { name: "标签", exact: true }).click();
    await page.getByRole("button", { name: root.name, exact: true }).focus();
    await expect(page.getByRole("status", { name: "标签焦点信息" }))
      .toContainText("2 条记录（含下级）· 直接关联 0 条");
  });
});

function appUrl(path: string): string {
  return new URL(path, appBaseUrl).toString();
}

async function createTag(
  request: APIRequestContext,
  name: string,
  parentId?: string,
): Promise<CreatedTag> {
  const response = await request.post(appUrl("/api/v1/tags"), {
    data: parentId ? { name, parentId } : { name },
  });

  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { tag: CreatedTag }).tag;
}

async function createRecord(
  request: APIRequestContext,
  text: string,
  tagIds: string[],
): Promise<void> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      text,
      myTags: tagIds.map((id) => ({ id })),
      processing: "save_only",
    },
  });

  expect(response.status(), await response.text()).toBe(201);
}
