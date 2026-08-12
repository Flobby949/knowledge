import {
  expect,
  test,
  type Locator,
  type Page,
} from "./fixture.js";

import type {
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
  NetworkPath,
} from "../../src/client/api.js";
import { expectBox } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

const ids = {
  conceptA: "41000000-0000-4000-8000-000000000001",
  conceptB: "41000000-0000-4000-8000-000000000002",
  conceptC: "41000000-0000-4000-8000-000000000003",
  pointA: "42000000-0000-4000-8000-000000000001",
  pointB: "42000000-0000-4000-8000-000000000002",
  pointC: "42000000-0000-4000-8000-000000000003",
  pointD: "42000000-0000-4000-8000-000000000004",
  tag: "61000000-0000-4000-8000-000000000001",
} as const;

test.describe("V3.4 home real knowledge network", () => {
  test.use({
    contextOptions: { reducedMotion: "reduce" },
    viewport: { width: 1_600, height: 1_000 },
  });

  test("switches freely between the Concept network and the Tag field", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture);
    await page.goto(appUrl("/"));

    const homeView = page.getByRole("group", { name: "首页知识视图" });
    const conceptView = homeView.getByRole("button", { name: "Concept" });
    const tagView = homeView.getByRole("button", { name: "标签" });

    await expect(tagView).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "气泡标签场" }))
      .toBeVisible();
    await conceptView.click();
    await expect(conceptView).toHaveAttribute("aria-pressed", "true");
    const conceptCanvas = page.locator(
      'canvas[aria-label="真实知识网络 3D 图幅"]',
    );

    await expect(conceptCanvas).toBeVisible();
    await conceptCanvas.press("ArrowRight");
    await conceptCanvas.press("ArrowUp");
    const cameraBeforeSwitch = await conceptCanvas.getAttribute(
      "data-camera-state",
    );

    expect(cameraBeforeSwitch).not.toBeNull();

    await tagView.click();
    await expect(tagView).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "气泡标签场" }))
      .toBeVisible();
    await expect(
      page.getByRole("list", { name: "全部标签" }).getByRole("button", {
        name: fixture.tag.name,
      }),
    ).toBeVisible();

    await homeView.getByRole("button", { name: "Concept" }).click();
    await expect(conceptCanvas).toBeVisible();
    await expect(conceptCanvas).toHaveAttribute(
      "data-camera-state",
      cameraBeforeSwitch ?? "",
    );
    await homeView.getByRole("button", { name: "标签" }).click();

    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "首页知识视图" })
        .getByRole("button", { name: "标签" }),
    ).toHaveAttribute("aria-pressed", "true");

    await page
      .getByRole("group", { name: "首页知识视图" })
      .getByRole("button", { name: "Concept" })
      .click();
    const home = page.getByRole("main", { name: "首页" });
    const networkSearch = home.getByRole("search", {
      name: "首页网络节点搜索",
    });

    await selectNetworkSearchResult(
      networkSearch,
      networkSearch.getByRole("searchbox", { name: "搜索网络节点" }),
      fixture.conceptA,
    );
    await expect(page.getByRole("region", { name: "节点详情" })).toBeVisible();
    await expectNetworkQuery(page, { node: fixture.conceptA.key });

    await page
      .getByRole("group", { name: "首页知识视图" })
      .getByRole("button", { name: "标签" })
      .click();
    await expect(page.getByRole("region", { name: "节点详情" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "气泡标签场" }))
      .toBeVisible();
    await expectNetworkQuery(page, { node: fixture.conceptA.key });

    await page
      .getByRole("group", { name: "首页知识视图" })
      .getByRole("button", { name: "Concept" })
      .click();
    await expect(
      page
        .getByRole("region", { name: "节点详情" })
        .getByRole("heading", { name: fixture.conceptA.label }),
    ).toBeVisible();

    await page
      .getByRole("group", { name: "首页知识视图" })
      .getByRole("button", { name: "标签" })
      .click();
    await page
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: fixture.tag.name })
      .click();
    await expect(page).toHaveURL(tagSearchUrl(fixture.tag.id));
  });

  test("switches to Concepts, expands real Knowledge Points, and keeps selection and path in browser history", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture);
    await page.goto(appUrl("/"));
    await selectConceptView(page);

    const home = page.getByRole("main", { name: "首页" });
    const stage = home.getByRole("region", { name: "真实 3D 知识网络" });
    const networkSearch = home.getByRole("search", {
      name: "首页网络节点搜索",
    });
    const searchbox = networkSearch.getByRole("searchbox", {
      name: "搜索网络节点",
    });

    await expect(stage).toHaveAttribute("data-renderer", "webgl2");
    await expect(stage).toHaveAttribute(
      "data-node-keys",
      fixture.concepts.map(({ key }) => key).sort().join(" "),
    );
    await expect(stage).toHaveAttribute("data-node-count", "3");
    await expect(stage).toHaveAttribute(
      "data-edge-keys",
      fixture.initialEdges.map(({ edgeKey }) => edgeKey).sort().join(" "),
    );
    await expect(stage).toHaveAttribute("data-edge-count", "1");

    const viewToggle = home.getByRole("button", {
      name: "切换到列表视图",
    });

    await viewToggle.click();
    await expect(home.getByRole("region", { name: "网络等价列表" }))
      .toBeVisible();
    await expect(
      home.getByRole("button", { name: "切换到图幅视图" }),
    ).toBeVisible();
    await home.getByRole("button", { name: "切换到图幅视图" }).click();
    await expect(stage).toHaveAttribute("data-renderer", "webgl2");

    await selectNetworkSearchResult(
      networkSearch,
      searchbox,
      fixture.conceptA,
    );

    const drawer = page.getByRole("region", { name: "节点详情" });

    await expect(drawer.getByRole("heading", { name: fixture.conceptA.label }))
      .toBeVisible();
    await expectBox(drawer, { width: 480 }, 4);
    await expectNetworkQuery(page, { node: fixture.conceptA.key });
    await expect(stage).toHaveAttribute(
      "data-node-keys",
      fixture.nodes.map(({ key }) => key).sort().join(" "),
    );
    await expect(stage).toHaveAttribute("data-renderer", "webgl2");
    await expect(stage).toHaveAttribute("data-node-count", "7");
    await expect(stage).toHaveAttribute(
      "data-edge-keys",
      fixture.edges.map(({ edgeKey }) => edgeKey).sort().join(" "),
    );
    await expect(stage).toHaveAttribute("data-edge-count", "6");

    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expectNetworkQuery(page, { node: null });
    await expect(stage).toHaveAttribute(
      "data-node-keys",
      fixture.concepts.map(({ key }) => key).sort().join(" "),
    );

    await selectNetworkSearchResult(
      networkSearch,
      searchbox,
      fixture.conceptA,
    );
    await drawer.getByRole("button", { name: "设为路径起点" }).click();
    await selectNetworkSearchResult(
      networkSearch,
      searchbox,
      fixture.conceptB,
    );
    await drawer.getByRole("button", { name: "设为路径终点" }).click();

    await expectNetworkQuery(page, {
      from: fixture.conceptA.key,
      node: fixture.conceptB.key,
      to: fixture.conceptB.key,
    });
    await expect(home.getByRole("status", { name: "路径探索结果" }))
      .toHaveText("已找到 3 步真实路径。可逐边核验方向与来源。");
    await expect(stage).toHaveAttribute(
      "data-path-edge-keys",
      fixture.path.steps.map(({ edgeKey }) => edgeKey).join(" "),
    );
    await expect(stage).toHaveAttribute("data-path-edge-count", "3");
  });

  test("keeps Tag filtering, record search, and new-record entry outside the network", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture);
    await page.goto(appUrl("/"));

    const homeSearch = page
      .getByRole("main", { name: "首页" })
      .getByRole("search", { name: "首页搜索" });
    const searchbox = homeSearch.getByRole("searchbox", {
      name: "定位标签或搜索记录",
    });

    await searchbox.fill(fixture.tag.name);
    await homeSearch
      .getByRole("button", { name: fixture.tag.name, exact: true })
      .click();
    await page
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: fixture.tag.name, exact: true })
      .click();
    await expect(page).toHaveURL(tagSearchUrl(fixture.tag.id));

    await page.goBack();
    await expect(page).toHaveURL(appUrl("/"));

    const recordQuery = "事件消费如何保持幂等";
    const restoredSearch = page
      .getByRole("search", { name: "首页搜索" })
      .getByRole("searchbox", { name: "定位标签或搜索记录" });

    await restoredSearch.fill(recordQuery);
    await restoredSearch.press("Enter");
    await expect(page).toHaveURL(recordSearchUrl(recordQuery));

    await page.goBack();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "新建记录" }))
      .toBeVisible();
  });

  test("Escape closes only the new-record dialog and preserves the selected network node", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture);
    await page.goto(appUrl("/"));
    await selectConceptView(page);

    const home = page.getByRole("main", { name: "首页" });
    const networkSearch = home.getByRole("search", {
      name: "首页网络节点搜索",
    });

    await selectNetworkSearchResult(
      networkSearch,
      networkSearch.getByRole("searchbox", { name: "搜索网络节点" }),
      fixture.conceptA,
    );

    const drawer = page.getByRole("region", { name: "节点详情" });

    await expect(drawer).toBeVisible();
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "新建记录", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "新建记录" });

    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expectNetworkQuery(page, { node: fixture.conceptA.key });

    const filters = home.locator("details.home-network-filters");

    await filters.locator("summary").click();
    await expect(filters).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(filters).not.toHaveAttribute("open", "");
    await expect(drawer).toBeVisible();

    const homeSearch = home.getByRole("search", { name: "首页搜索" });
    const homeSearchbox = homeSearch.getByRole("searchbox", {
      name: "定位标签或搜索记录",
    });

    await homeSearchbox.fill(fixture.tag.name);
    await expect(homeSearch.getByRole("region", { name: "搜索建议" }))
      .toBeVisible();
    await expect(homeSearchbox).toHaveAttribute(
      "aria-controls",
      "home-search-suggestions",
    );
    await expect(homeSearchbox).toHaveAttribute("aria-expanded", "true");
    await homeSearchbox.press("Escape");
    await expect(homeSearch.getByRole("region", { name: "搜索建议" }))
      .toHaveCount(0);
    await expect(homeSearchbox).toHaveAttribute("aria-expanded", "false");
    await expect(homeSearchbox).toHaveValue(fixture.tag.name);
    await expect(drawer).toBeVisible();
  });

  test("reports a truncated path search without claiming that no path exists", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture, { pathTruncated: true });
    await page.goto(homeStateUrl(fixture));

    await expect(page.getByRole("status", { name: "路径探索结果" }))
      .toHaveText(
        "路径探索已达到查询预算，暂时无法确认是否存在真实路径。请缩短范围后重试。",
      );
  });

  test("WebGL2 creation failure preserves node, path, filters, and drawer in the canonical 2D view", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await disableWebGl2(page);
    await installHomeNetworkRoutes(page, fixture);
    await page.goto(homeStateUrl(fixture));

    const home = page.getByRole("main", { name: "首页" });
    const stage = home.getByRole("region", { name: "真实 3D 知识网络" });

    await expect(stage).toHaveAttribute("data-renderer", "2d");
    await expect(
      home.getByRole("group", { name: "真实知识网络图幅" }),
    ).toBeVisible();
    await expectFallbackState(page, fixture);
  });

  test("keeps renderer and later network failures separately readable", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await disableWebGl2(page);
    await installHomeNetworkRoutes(page, fixture, {
      failExpandedSubgraph: true,
    });
    await page.goto(appUrl("/"));
    await selectConceptView(page);

    const home = page.getByRole("main", { name: "首页" });
    const stage = home.getByRole("region", { name: "真实 3D 知识网络" });

    await expect(stage).toHaveAttribute("data-renderer", "2d");
    await home
      .getByRole("group", { name: "真实知识网络图幅" })
      .getByRole("button", { name: `打开节点：${fixture.conceptA.label}` })
      .click();

    const rendererAlert = stage.locator(".home-renderer-alert");
    const networkError = stage.locator(".home-network-error");

    await expect(rendererAlert).toBeVisible();
    await expect(networkError).toHaveText("局部网络读取失败");
    const rendererBox = await rendererAlert.boundingBox();
    const errorBox = await networkError.boundingBox();

    expect(rendererBox).not.toBeNull();
    expect(errorBox).not.toBeNull();
    expect(errorBox!.y).toBeGreaterThanOrEqual(
      rendererBox!.y + rendererBox!.height + 4,
    );
  });

  test("context loss and a later 3D frame exception both preserve state while falling back to 2D", async ({
    context,
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await installHomeNetworkRoutes(page, fixture);
    await page.goto(homeStateUrl(fixture));

    const home = page.getByRole("main", { name: "首页" });
    const stage = home.getByRole("region", { name: "真实 3D 知识网络" });
    const canvas = stage.locator(
      'canvas[aria-label="真实知识网络 3D 图幅"]',
    );

    await expect(stage).toHaveAttribute("data-renderer", "webgl2");
    await expect(canvas).toBeVisible();
    await canvas.dispatchEvent("webglcontextlost", { cancelable: true });
    await expect(stage).toHaveAttribute("data-renderer", "2d");
    await expect(
      home.getByRole("group", { name: "真实知识网络图幅" }),
    ).toBeVisible();
    await expectFallbackState(page, fixture);

    const frameFailurePage = await context.newPage();

    await installArmedWebGlFrameFailure(frameFailurePage);
    await installHomeNetworkRoutes(frameFailurePage, fixture);
    await frameFailurePage.goto(homeStateUrl(fixture));

    const frameStage = frameFailurePage
      .getByRole("main", { name: "首页" })
      .getByRole("region", { name: "真实 3D 知识网络" });

    await expect(frameStage).toHaveAttribute("data-renderer", "webgl2");
    await frameFailurePage.evaluate(() => {
      (
        window as unknown as Window & {
          __armHome3dFrameFailure: () => void;
        }
      ).__armHome3dFrameFailure();
    });
    await frameFailurePage.setViewportSize({ width: 1_590, height: 1_000 });

    await expect(frameStage).toHaveAttribute("data-renderer", "2d");
    await expect(
      frameFailurePage.getByRole("group", { name: "真实知识网络图幅" }),
    ).toBeVisible();
    await expectFallbackState(frameFailurePage, fixture);
  });

  test("a Worker failure after the 3D-to-2D fallback keeps the same state in the keyboard list", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await disableWebGl2(page);
    await breakNetworkLayoutWorker(page);
    await installHomeNetworkRoutes(page, fixture);
    await page.goto(homeStateUrl(fixture));

    const home = page.getByRole("main", { name: "首页" });
    const stage = home.getByRole("region", { name: "真实 3D 知识网络" });
    const list = home.getByRole("region", { name: "网络等价列表" });

    await expect(stage).toHaveAttribute("data-renderer", "list");
    await expect(list).toBeVisible();
    await expect(
      list.getByRole("button", { name: `打开节点：${fixture.conceptA.label}` }),
    ).toBeEnabled();
    await expect(
      home.getByRole("button", { name: "切换到图幅视图" }),
    ).toBeDisabled();
    await expectFallbackState(page, fixture);
  });

  test("reduced motion renders on demand without a continuous idle RAF loop", async ({
    page,
  }) => {
    const fixture = homeNetworkFixture();

    await auditAnimationFrames(page);
    await installHomeNetworkRoutes(page, fixture);
    await page.goto(appUrl("/"));
    await selectConceptView(page);

    const stage = page.getByRole("region", { name: "真实 3D 知识网络" });

    await expect(stage).toHaveAttribute("data-renderer", "webgl2");
    await expect(stage).toHaveAttribute("data-motion", "reduce");
    await expect(stage).toHaveAttribute("data-node-count", "3");
    await expect
      .poll(() => readRafAudit(page))
      .toMatchObject({ pending: 0 });
    await page.waitForTimeout(120);
    const idleStart = await readRafAudit(page);

    await page.waitForTimeout(320);
    const idleEnd = await readRafAudit(page);

    expect(idleEnd.pending).toBe(0);
    expect(idleEnd.requested).toBe(idleStart.requested);
  });
});

async function selectConceptView(page: Page): Promise<void> {
  await page
    .getByRole("group", { name: "首页知识视图" })
    .getByRole("button", { name: "Concept" })
    .click();
}

interface HomeNetworkFixture {
  conceptA: NetworkNode;
  conceptB: NetworkNode;
  concepts: NetworkNode[];
  edges: NetworkEdge[];
  initialEdges: NetworkEdge[];
  nodes: NetworkNode[];
  path: NetworkPath;
  tag: { id: string; name: string };
}

function homeNetworkFixture(): HomeNetworkFixture {
  const conceptA = networkConcept(
    ids.conceptA,
    "变更数据捕获",
    "从事务日志中稳定发布可订阅的领域变化。",
    3,
  );
  const conceptB = networkConcept(
    ids.conceptB,
    "幂等事件消费",
    "消费者用稳定键抵抗重复投递。",
    2,
  );
  const conceptC = networkConcept(
    ids.conceptC,
    "离线结果校验",
    "离线核对发布结果与源数据是否一致。",
    1,
  );
  const pointA = networkPoint(
    ids.pointA,
    "提交事务与写出日志必须保持同一原子边界",
    "业务变化与待发布事件在同一事务内落库。",
  );
  const pointB = networkPoint(
    ids.pointB,
    "消费端以事件键实现幂等",
    "重复事件使用同一事件键并只产生一次业务效果。",
  );
  const pointC = networkPoint(
    ids.pointC,
    "检查点记录连续消费位置",
    "消费位置只在业务处理成功后推进。",
  );
  const pointD = networkPoint(
    ids.pointD,
    "离线校验不替代在线投递",
    "离线核验用于发现偏差，不伪装成事件投递链路。",
  );
  const membershipA = networkMembership(
    "43000000-0000-4000-8000-000000000001",
    conceptA.key,
    pointA.key,
  );
  const membershipB = networkMembership(
    "43000000-0000-4000-8000-000000000002",
    conceptB.key,
    pointB.key,
  );
  const membershipC = networkMembership(
    "43000000-0000-4000-8000-000000000003",
    conceptB.key,
    pointC.key,
  );
  const membershipD = networkMembership(
    "43000000-0000-4000-8000-000000000004",
    conceptC.key,
    pointD.key,
  );
  const knowledgeRelation = networkRelation(
    "knowledge_relation",
    "44000000-0000-4000-8000-000000000001",
    pointA.key,
    pointB.key,
    "extends",
    true,
    "原子写出向幂等消费延伸。",
  );
  const conceptRelation = networkRelation(
    "concept_relation",
    "45000000-0000-4000-8000-000000000001",
    conceptA.key,
    conceptC.key,
    "contrasts",
    false,
    "在线传播与离线校验承担不同职责。",
  );
  const concepts = [conceptA, conceptB, conceptC];
  const nodes = [...concepts, pointA, pointB, pointC, pointD];
  const edges = [
    membershipA,
    membershipB,
    membershipC,
    membershipD,
    knowledgeRelation,
    conceptRelation,
  ];
  const path: NetworkPath = {
    nodes: [conceptA, pointA, pointB, conceptB],
    edges: [membershipA, knowledgeRelation, membershipB],
    steps: [
      { ...membershipA, traversalDirection: "undirected" },
      { ...knowledgeRelation, traversalDirection: "forward" },
      { ...membershipB, traversalDirection: "undirected" },
    ],
  };

  return {
    conceptA,
    conceptB,
    concepts,
    edges,
    initialEdges: [conceptRelation],
    nodes,
    path,
    tag: {
      id: ids.tag,
      name: "事务事件",
    },
  };
}

async function installHomeNetworkRoutes(
  page: Page,
  fixture: HomeNetworkFixture,
  options: {
    failExpandedSubgraph?: boolean;
    pathTruncated?: boolean;
  } = {},
): Promise<void> {
  await page.route("**/api/v1/tag-field", async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: fixture.tag.id,
            name: fixture.tag.name,
            approval: "approved",
            recordCount: 2,
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/network/nodes/search**", async (route) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const type = url.searchParams.get("type") ?? "all";
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const matching = fixture.nodes.filter(
      (node) =>
        (type === "all" || node.type === type) &&
        (node.label.toLocaleLowerCase().includes(query) || node.key === query),
    );

    await route.fulfill({
      json: {
        items: matching.slice(0, limit),
        limit,
        truncated: matching.length > limit,
      },
    });
  });
  await page.route("**/api/v1/network/path**", async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const path =
      !options.pathTruncated &&
      from === fixture.conceptA.key && to === fixture.conceptB.key
        ? fixture.path
        : null;

    await route.fulfill({
      json: {
        path,
        maxDepth: 6,
        truncated: options.pathTruncated ?? false,
        visited: options.pathTruncated ? 1_000 : path ? 7 : 3,
      },
    });
  });
  await page.route("**/api/v1/network/subgraph**", async (route) => {
    const url = new URL(route.request().url());
    const root = url.searchParams.get("root");

    if (root && options.failExpandedSubgraph) {
      await route.fulfill({
        json: { error: { message: "局部网络读取失败" } },
        status: 503,
      });
      return;
    }

    const expanded = root !== null;
    const graph: NetworkGraph = {
      root,
      nodes: expanded ? fixture.nodes : fixture.concepts,
      edges: expanded ? fixture.edges : fixture.initialEdges,
      limits: { depth: expanded ? 1 : 0, edgeLimit: 600, nodeLimit: 300 },
      truncated: false,
      truncation: { edges: false, nodes: false },
    };

    await route.fulfill({ json: graph });
  });
}

async function selectNetworkSearchResult(
  search: Locator,
  searchbox: Locator,
  node: NetworkNode,
): Promise<void> {
  await searchbox.fill(node.label);
  await searchbox.press("Enter");
  await search
    .getByRole("button", { name: `选择搜索结果：${node.label}` })
    .click();
}

async function expectFallbackState(
  page: Page,
  fixture: HomeNetworkFixture,
): Promise<void> {
  await expect(
    page.getByRole("alert", { name: "首页网络渲染状态" }),
  ).toContainText(/已切换/u);
  await expect(
    page
      .getByRole("region", { name: "节点详情" })
      .getByRole("heading", { name: fixture.conceptA.label }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "路径探索结果" }),
  ).toHaveText("已找到 3 步真实路径。可逐边核验方向与来源。");
  await expectNetworkQuery(page, {
    from: fixture.conceptA.key,
    node: fixture.conceptA.key,
    q: fixture.conceptA.label,
    relation: ["concept_membership", "knowledge_relation"],
    to: fixture.conceptB.key,
    type: ["concept", "knowledge_point"],
  });
}

async function expectNetworkQuery(
  page: Page,
  expected: {
    from?: string | null;
    node?: string | null;
    q?: string | null;
    relation?: string[];
    to?: string | null;
    type?: string[];
  },
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const search = new URLSearchParams(window.location.search);

        return {
          from: search.get("from"),
          node: search.get("node"),
          q: search.get("q"),
          relation: search.getAll("relation"),
          to: search.get("to"),
          type: search.getAll("type"),
        };
      }),
    )
    .toMatchObject(expected);
}

async function disableWebGl2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function getContext(
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown,
    ) {
      if (contextId === "webgl2") {
        return null;
      }

      return originalGetContext.call(this, contextId, options);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

async function breakNetworkLayoutWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: class BrokenNetworkWorker {
        constructor() {
          throw new Error("E2E forced home network Worker failure");
        }
      },
    });
  });
}

async function installArmedWebGlFrameFailure(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let armed = false;
    let thrown = false;
    const maybeThrow = () => {
      if (armed && !thrown) {
        thrown = true;
        throw new Error("E2E forced home 3D frame failure");
      }
    };
    const prototype = WebGL2RenderingContext.prototype;
    const drawArrays = prototype.drawArrays;
    const drawElements = prototype.drawElements;
    const drawArraysInstanced = prototype.drawArraysInstanced;
    const drawElementsInstanced = prototype.drawElementsInstanced;

    prototype.drawArrays = function drawArraysWithFailure(
      mode: number,
      first: number,
      count: number,
    ) {
      maybeThrow();
      return drawArrays.call(this, mode, first, count);
    };
    prototype.drawElements = function drawElementsWithFailure(
      mode: number,
      count: number,
      type: number,
      offset: number,
    ) {
      maybeThrow();
      return drawElements.call(this, mode, count, type, offset);
    };
    prototype.drawArraysInstanced = function drawArraysInstancedWithFailure(
      mode: number,
      first: number,
      count: number,
      instanceCount: number,
    ) {
      maybeThrow();
      return drawArraysInstanced.call(
        this,
        mode,
        first,
        count,
        instanceCount,
      );
    };
    prototype.drawElementsInstanced = function drawElementsInstancedWithFailure(
      mode: number,
      count: number,
      type: number,
      offset: number,
      instanceCount: number,
    ) {
      maybeThrow();
      return drawElementsInstanced.call(
        this,
        mode,
        count,
        type,
        offset,
        instanceCount,
      );
    };
    Object.defineProperty(window, "__armHome3dFrameFailure", {
      configurable: true,
      value: () => {
        armed = true;
      },
    });
  });
}

async function auditAnimationFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set<number>();
    let requested = 0;
    let completed = 0;

    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      requested += 1;
      const id = request((time) => {
        pending.delete(id);
        completed += 1;
        callback(time);
      });

      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      pending.delete(id);
      cancel(id);
    };
    Object.defineProperty(window, "__readHomeRafAudit", {
      configurable: true,
      value: () => ({ completed, pending: pending.size, requested }),
    });
  });
}

async function readRafAudit(page: Page): Promise<{
  completed: number;
  pending: number;
  requested: number;
}> {
  return page.evaluate(() =>
    (
      window as unknown as Window & {
        __readHomeRafAudit: () => {
          completed: number;
          pending: number;
          requested: number;
        };
      }
    ).__readHomeRafAudit(),
  );
}

function networkConcept(
  id: string,
  label: string,
  description: string,
  revisionNumber: number,
): NetworkNode {
  return {
    id,
    key: `concept:${id}`,
    type: "concept",
    label,
    description,
    source: {
      kind: "concept_revision",
      revisionId: id.replace("41000000", "41100000"),
      revisionNumber,
    },
  };
}

function networkPoint(
  id: string,
  label: string,
  description: string,
): NetworkNode {
  return {
    id,
    key: `knowledge_point:${id}`,
    type: "knowledge_point",
    label,
    description,
    source: {
      kind: "knowledge_point",
      recordId: "46000000-0000-4000-8000-000000000001",
      recordTitle: "事件驱动系统的可靠发布与消费",
      fragmentRevisionId: "47000000-0000-4000-8000-000000000001",
      analysisRevisionId: "48000000-0000-4000-8000-000000000001",
    },
  };
}

function networkMembership(
  id: string,
  source: string,
  target: string,
): NetworkEdge {
  return {
    edgeKey: `concept_membership:${id}`,
    kind: "concept_membership",
    relationType: "membership",
    source,
    target,
    directed: false,
    description: null,
    confirmation: null,
    sourceRecord: {
      kind: "concept_membership",
      id,
      origin: "manual",
      createdAt: "2099-08-11T08:00:00.000Z",
    },
  };
}

function networkRelation(
  kind: "concept_relation" | "knowledge_relation",
  id: string,
  source: string,
  target: string,
  relationType: string,
  directed: boolean,
  description: string,
): NetworkEdge {
  const confirmationKind =
    kind === "concept_relation"
      ? "concept_relation_confirmation"
      : "knowledge_relation_confirmation";

  return {
    edgeKey: `${kind}:${id}`,
    kind,
    relationType,
    source,
    target,
    directed,
    description,
    confirmation: {
      id: id.replace(/^4/u, "5"),
      relationId: id,
      confirmedAt: "2099-08-11T08:00:00.000Z",
    },
    sourceRecord: {
      kind: confirmationKind,
      id: id.replace(/^4/u, "5"),
      relationId: id,
      confirmedAt: "2099-08-11T08:00:00.000Z",
      reason: "E2E 合同中的人工确认来源。",
      confidence: 0.91,
    },
  };
}

function homeStateUrl(fixture: HomeNetworkFixture): string {
  const search = new URLSearchParams({
    node: fixture.conceptA.key,
    from: fixture.conceptA.key,
    to: fixture.conceptB.key,
    q: fixture.conceptA.label,
  });

  search.append("type", "concept");
  search.append("type", "knowledge_point");
  search.append("relation", "concept_membership");
  search.append("relation", "knowledge_relation");
  return appUrl(`/?${search.toString()}`);
}

function tagSearchUrl(tagId: string): string {
  const search = new URLSearchParams({ tag: tagId });

  return appUrl(`/search?${search.toString()}`);
}

function recordSearchUrl(query: string): string {
  const search = new URLSearchParams({ q: query });

  return appUrl(`/search?${search.toString()}`);
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
