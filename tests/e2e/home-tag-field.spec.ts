import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "./fixture.js";

import { expectBox } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

type SeededTag = {
  id: string;
  name: string;
  approval: "approved" | "candidate";
};

test.describe("home neural tag field", () => {
  test.use({
    contextOptions: { reducedMotion: "reduce" },
    viewport: { width: 1_600, height: 1_000 },
  });

  test("an empty instance offers only the real first-record actions", async ({
    page,
  }) => {
    await page.goto(appUrl("/"));

    const home = page.getByRole("main", { name: "首页" });
    const scene = home.getByRole("region", { name: "神经标签场" });
    const emptyState = scene
      .getByRole("status")
      .filter({ hasText: "记录第一条知识，让网络开始生长" });
    const firstRecordActions = emptyState.getByRole("button", {
      name: "新建第一条记录",
      exact: true,
    });

    await expect(
      scene.getByRole("list", { name: "全部标签" }).getByRole("button"),
    ).toHaveCount(0);
    await expect(emptyState).toBeVisible();
    await expect(firstRecordActions).toHaveCount(2);
    await expect(
      page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("searchbox", { name: "定位标签或搜索记录" }),
    ).toBeEnabled();

    for (let index = 0; index < 2; index += 1) {
      await firstRecordActions.nth(index).click();

      const dialog = page.getByRole("dialog", { name: "新建记录" });

      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "关闭新建记录" }).click();
      await expect(dialog).toBeHidden();
    }
  });

  test("every tag remains identifiable and operable in the motion-safe universe and its WebGL2 fallback", async ({
    context,
    page,
    request,
  }) => {
    const marker = `home-field-${randomUUID().slice(0, 8)}`;
    const seeded = await seedTagUniverse(request, marker);

    await page.goto(appUrl("/"));
    await expect(page).toHaveURL(appUrl("/"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const home = page.getByRole("main", { name: "首页" });
    const scene = home.getByRole("region", { name: "神经标签场" });
    const tagList = scene.getByRole("list", { name: "全部标签" });
    const searchHud = home.getByRole("search", { name: "首页搜索" });
    const resetView = scene.getByRole("button", {
      name: "重置视角",
      exact: true,
    });

    await expectBox(navigation, {
      x: 0,
      y: 0,
      width: 1_600,
      height: 60,
    });
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(
      page.getByRole("region", { name: "神经标签场" }),
    ).toHaveCount(1);
    await expectBox(scene, {
      x: 0,
      y: 60,
      width: 1_600,
      height: 940,
    });
    await expectNoPageScroll(page);
    await expectDataState(scene, "deep-space");
    await expectDataState(scene, "webgl2");
    await expectDataState(scene, "static-motion");
    await expectWebGlCanvasToOwnTheField(scene);

    const reducedMotionCamera = await readCameraState(scene);

    await page.waitForTimeout(240);
    await expect(scene).toHaveAttribute(
      "data-camera",
      reducedMotionCamera.signature,
    );
    await expect(resetView).toBeVisible();
    await expect(resetView).toBeEnabled();

    await expect
      .poll(() => tagList.getByRole("button").count())
      .toBeGreaterThanOrEqual(seeded.tags.length);

    for (const tag of seeded.tags) {
      const node = tagNode(tagList, tag);

      await expectTagNode(node, tag);
      await node.focus();
      await expect(node).toBeFocused();
    }

    const candidate = seeded.tags.find(
      (tag) => tag.approval === "candidate",
    );
    const approved = seeded.tags.find(
      (tag) => tag.approval === "approved" && tag.name.includes(marker),
    );
    const highUseTag = seeded.tags.find(
      (tag) => tag.name === `跨记录主题 ${marker}`,
    );

    expect(
      candidate,
      "the public fake-AI flow must create a candidate tag",
    ).toBeDefined();
    expect(
      approved,
      "the public record flow must create an approved tag",
    ).toBeDefined();
    expect(highUseTag, "the universe must include a higher-use tag").toBeDefined();

    if (!candidate || !approved || !highUseTag) {
      return;
    }

    await expectEnergyNode(tagNode(tagList, approved), "complete");
    await expectEnergyNode(tagNode(tagList, candidate), "dashed");

    const searchInput = searchHud.getByRole("searchbox", {
      name: "定位标签或搜索记录",
    });

    await expect(searchHud).toBeVisible();
    await searchInput.fill(candidate.name);
    await searchHud
      .getByRole("option", { name: candidate.name, exact: true })
      .click();

    const focusedCandidate = tagNode(tagList, candidate);

    await expectDataState(focusedCandidate, "focused");
    await expect(
      scene.getByRole("status", { name: "标签焦点信息" }),
    ).toContainText(candidate.name);
    await expect(
      scene.getByRole("status", { name: "标签焦点信息" }),
    ).toContainText("AI 候选");

    const cameraBeforeInteraction = await readCameraState(scene);
    const dragTargetY =
      cameraBeforeInteraction.pitch <= 0 ? 528 : 392;

    await dragScene(
      page,
      scene,
      { x: 46, y: 460 },
      { x: 176, y: dragTargetY },
    );

    const cameraAfterDrag = await readCameraState(scene);

    expect(cameraAfterDrag.yaw).not.toBe(cameraBeforeInteraction.yaw);
    expect(cameraAfterDrag.pitch).not.toBe(cameraBeforeInteraction.pitch);

    await scene.dispatchEvent("wheel", { deltaY: -360 });

    const cameraAfterZoom = await readCameraState(scene);

    expect(cameraAfterZoom.distance).toBeLessThan(cameraAfterDrag.distance);

    await searchInput.fill(candidate.name);
    await searchHud
      .getByRole("option", { name: candidate.name, exact: true })
      .click();
    await expect(focusedCandidate).toBeVisible();
    const cameraBeforeNavigation = await readCameraState(scene);
    await focusedCandidate.focus();
    await expect(focusedCandidate).toBeFocused();
    await focusedCandidate.press("Enter");
    await expect(page).toHaveURL(tagSearchUrl(candidate.id));
    await page.goBack();
    await expect(page).toHaveURL(appUrl("/"));

    const returnedScene = page.getByRole("region", { name: "神经标签场" });

    await expect(returnedScene).toHaveAttribute(
      "data-camera",
      cameraBeforeNavigation.signature,
    );
    await expect(
      tagNode(
        returnedScene
          .getByRole("list", { name: "全部标签" }),
        candidate,
      ),
    ).toHaveAttribute("data-tag-id", candidate.id);

    await page
      .getByRole("region", { name: "神经标签场" })
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: approved.name, exact: true })
      .click();
    await expect(page).toHaveURL(tagSearchUrl(approved.id));
    await page.goBack();
    await expect(page).toHaveURL(appUrl("/"));

    const restoredScene = page.getByRole("region", { name: "神经标签场" });

    await restoredScene
      .getByRole("button", { name: "重置视角", exact: true })
      .click();
    await expect(restoredScene).toHaveAttribute("data-camera", "0.300|-0.120|8.200");
    await expect(page).toHaveURL(appUrl("/"));

    const searchRecordsQuery = `事务日志如何保持顺序 ${marker}`;
    const restoredSearch = page
      .getByRole("main", { name: "首页" })
      .getByRole("search", { name: "首页搜索" })
      .getByRole("searchbox", { name: "定位标签或搜索记录" });

    await restoredSearch.fill(searchRecordsQuery);
    await restoredSearch.press("Enter");
    await expect(page).toHaveURL(recordSearchUrl(searchRecordsQuery));
    await page.goBack();
    await expect(page).toHaveURL(appUrl("/"));

    const lostContextScene = page.getByRole("region", {
      name: "神经标签场",
    });

    await lostContextScene.locator("canvas").dispatchEvent("webglcontextlost", {
      cancelable: true,
    });
    await expectDataState(lostContextScene, "dom-2d");
    await expect(
      lostContextScene.getByRole("status", { name: "渲染模式" }),
    ).toContainText("正在使用简化视图");

    const tagsAfterContextLoss = lostContextScene.getByRole("list", {
      name: "全部标签",
    });
    const [higherUseBox, lowerUseBox] = await Promise.all([
      tagNode(tagsAfterContextLoss, highUseTag)
        .locator("[data-energy-core]")
        .boundingBox(),
      tagNode(tagsAfterContextLoss, candidate)
        .locator("[data-energy-core]")
        .boundingBox(),
    ]);

    expect(higherUseBox?.width ?? 0).toBeGreaterThan(lowerUseBox?.width ?? 0);

    for (const tag of seeded.tags) {
      await expect(tagNode(tagsAfterContextLoss, tag)).toBeVisible();
    }

    const fallbackPage = await context.newPage();

    await disableWebGl2(fallbackPage);
    await fallbackPage.goto(appUrl("/"));
    await expect(fallbackPage).toHaveURL(appUrl("/"));

    const fallbackScene = fallbackPage.getByRole("region", {
      name: "神经标签场",
    });
    const fallbackTags = fallbackScene.getByRole("list", {
      name: "全部标签",
    });

    await expectDataState(fallbackScene, "deep-space");
    await expectDataState(fallbackScene, "dom-2d");
    await expectDataState(fallbackScene, "static-motion");
    await expectBox(fallbackScene, {
      x: 0,
      y: 60,
      width: 1_600,
      height: 940,
    });
    await expectNoPageScroll(fallbackPage);
    await expect(
      fallbackScene.getByRole("status", { name: "渲染模式" }),
    ).toContainText("正在使用简化视图");

    for (const tag of seeded.tags) {
      const node = tagNode(fallbackTags, tag);

      await expectTagNode(node, tag);
      await expect(node).toBeVisible();
    }

    await tagNode(fallbackTags, approved).focus();
    await tagNode(fallbackTags, approved).press("Enter");
    await expect(fallbackPage).toHaveURL(tagSearchUrl(approved.id));
    await expect(
      fallbackPage.getByRole("region", { name: "标签硬筛选" }),
    ).toContainText(approved.name);
  });
});

test.describe("home neural tag field live motion", () => {
  test.use({
    contextOptions: { reducedMotion: "no-preference" },
    viewport: { width: 1_600, height: 1_000 },
  });

  test("the universe auto-rotates only while the user is not inspecting a tag", async ({
    page,
    request,
  }) => {
    const tagName = `运动信号 ${randomUUID().slice(0, 8)}`;

    await seedSaveOnlyTag(request, tagName);
    await page.goto(appUrl("/"));

    const scene = page.getByRole("region", { name: "神经标签场" });
    const node = scene
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: tagName, exact: true });

    await expectDataState(scene, "webgl2");
    await expectDataState(scene, "live-motion");

    const initialYaw = await scene.getAttribute("data-camera-yaw");

    await expect
      .poll(() => scene.getAttribute("data-camera-yaw"))
      .not.toBe(initialYaw);

    await node.hover();
    await page.waitForTimeout(100);

    const pausedYaw = await scene.getAttribute("data-camera-yaw");

    await page.waitForTimeout(240);
    await expect(scene).toHaveAttribute("data-camera-yaw", pausedYaw ?? "");

    await node.focus();
    await page.waitForTimeout(240);
    await expect(scene).toHaveAttribute("data-camera-yaw", pausedYaw ?? "");
  });
});

test.describe("home neural tag field at the minimum supported viewport", () => {
  test.use({
    contextOptions: { reducedMotion: "reduce" },
    viewport: { width: 1_280, height: 800 },
  });

  test("keeps the complete field and both HUD controls inside 1280px", async ({
    page,
    request,
  }) => {
    const tagName = `最小视口 ${randomUUID().slice(0, 8)}`;

    await seedSaveOnlyTag(request, tagName);
    await page.goto(appUrl("/"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const scene = page.getByRole("region", { name: "神经标签场" });
    const search = page.getByRole("search", { name: "首页搜索" });

    await expectBox(navigation, { x: 0, y: 0, width: 1_280, height: 60 });
    await expectBox(scene, { x: 0, y: 60, width: 1_280, height: 740 });
    await expectNoPageScroll(page, { height: 800, width: 1_280 });
    await expect(search).toBeVisible();
    await expect(
      scene.getByRole("button", { name: "重置视角", exact: true }),
    ).toBeVisible();
    await expect(
      scene
        .getByRole("list", { name: "全部标签" })
        .getByRole("button", { name: tagName, exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() => visibleLabelOverlaps(scene))
      .toEqual([]);

    const focusedNode = scene
      .getByRole("list", { name: "全部标签" })
      .getByRole("button", { name: tagName, exact: true });

    await focusedNode.focus();
    await expect(focusedNode.locator("strong")).toHaveCSS("opacity", "1");
    await expect(focusedNode.locator("strong")).toHaveText(tagName);
  });
});

function tagNode(list: Locator, tag: SeededTag): Locator {
  return list.getByRole("button", { name: tag.name, exact: true });
}

async function expectTagNode(node: Locator, tag: SeededTag): Promise<void> {
  await expect(node).toHaveCount(1);
  await expect(node).toBeEnabled();
  await expect(node).toHaveAttribute("data-tag-id", tag.id);
  await expectDataState(node, tag.approval);
  await expectDataState(
    node,
    tag.approval === "approved" ? "complete-ring" : "dashed-ring",
  );
}

async function expectDataState(locator: Locator, token: string): Promise<void> {
  await expect(locator).toHaveAttribute(
    "data-state",
    new RegExp(`(?:^|\\s)${token}(?:\\s|$)`, "u"),
  );
}

async function expectNoPageScroll(
  page: Page,
  expected = { height: 1_000, width: 1_600 },
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scrollingElement = document.scrollingElement;

        return {
          height: scrollingElement?.scrollHeight ?? 0,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          width: scrollingElement?.scrollWidth ?? 0,
        };
      }),
    )
    .toEqual({
      height: expected.height,
      scrollX: 0,
      scrollY: 0,
      width: expected.width,
    });
}

async function expectWebGlCanvasToOwnTheField(scene: Locator): Promise<void> {
  const canvas = scene.locator("canvas");

  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return {
          height: Math.round(rect.height),
          opacity: Number(style.opacity),
          width: Math.round(rect.width),
        };
      }),
    )
    .toEqual({ height: 940, opacity: 1, width: 1_600 });
}

async function expectEnergyNode(
  node: Locator,
  ring: "complete" | "dashed",
): Promise<void> {
  const energy = node.locator("[data-energy-core]");
  const orbit = node.locator("[data-orbit-ring]");

  await expect(energy).toBeVisible();
  await expect(orbit).toBeVisible();
  await expect(energy).toHaveCSS("border-radius", "50%");
  await expect(orbit).toHaveAttribute("data-ring", ring);

  const energyBox = await energy.boundingBox();
  const buttonBox = await node.boundingBox();

  expect(energyBox?.width ?? 0).toBeGreaterThanOrEqual(38);
  expect(energyBox?.height).toBeCloseTo(energyBox?.width ?? 0, 0);
  expect(buttonBox?.width ?? 0).toBeLessThan(220);
}

async function readCameraState(scene: Locator): Promise<{
  distance: number;
  pitch: number;
  signature: string;
  yaw: number;
}> {
  const signature = await scene.getAttribute("data-camera");

  expect(signature).toMatch(/^-?\d+\.\d{3}\|-?\d+\.\d{3}\|\d+\.\d{3}$/u);

  const [yaw, pitch, distance] = (signature ?? "").split("|").map(Number);

  return {
    distance: distance ?? Number.NaN,
    pitch: pitch ?? Number.NaN,
    signature: signature ?? "",
    yaw: yaw ?? Number.NaN,
  };
}

async function dragScene(
  page: Page,
  scene: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = await scene.boundingBox();

  expect(box).not.toBeNull();

  if (!box) {
    return;
  }

  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

async function visibleLabelOverlaps(scene: Locator): Promise<string[]> {
  return scene.locator(".tag-node-list strong").evaluateAll((labels) => {
    const visible = labels
      .map((label) => ({
        name: label.textContent?.trim() ?? "",
        opacity: Number(getComputedStyle(label).opacity),
        rect: label.getBoundingClientRect(),
      }))
      .filter(
        (label) =>
          label.opacity > 0.05 &&
          label.rect.width > 0 &&
          label.rect.height > 0,
      );
    const overlaps: string[] = [];

    for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < visible.length;
        rightIndex += 1
      ) {
        const left = visible[leftIndex];
        const right = visible[rightIndex];

        if (!left || !right) {
          continue;
        }

        const intersects =
          left.rect.left < right.rect.right + 2 &&
          left.rect.right + 2 > right.rect.left &&
          left.rect.top < right.rect.bottom + 2 &&
          left.rect.bottom + 2 > right.rect.top;

        if (intersects) {
          overlaps.push(`${left.name} / ${right.name}`);
        }
      }
    }

    return overlaps;
  });
}

async function disableWebGl2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value(this: HTMLCanvasElement, contextId: string, ...options: unknown[]) {
        if (contextId === "webgl2") {
          return null;
        }

        return Reflect.apply(nativeGetContext, this, [contextId, ...options]);
      },
    });
  });
}

async function seedTagUniverse(
  request: APIRequestContext,
  marker: string,
): Promise<{ tags: SeededTag[] }> {
  await enableDeterministicFakeConfiguration(request);

  const sharedTagName = `跨记录主题 ${marker}`;
  let sharedTag: { id: string; name: string } | null = null;

  for (const [index, tagName] of [
    `分布式系统 ${marker}`,
    `数据库变更 ${marker}`,
  ].entries()) {
    const created = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: `首页标签场记录 ${index + 1} ${marker}`,
        myTags: [{ name: tagName }, sharedTag ?? { name: sharedTagName }],
        processing: "save_only",
      },
    });

    expect(created.status()).toBe(201);

    const body = (await created.json()) as {
      record: { myTags: Array<{ id: string; name: string }> };
    };

    sharedTag =
      body.record.myTags.find((tag) => tag.name === sharedTagName) ?? null;
    expect(sharedTag).not.toBeNull();
  }

  const source = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: `CDC 读取数据库事务日志 ${marker}。\n事务日志保留增量变更顺序 ${marker}。`,
      myTags: [{ name: `AI 整理来源 ${marker}` }],
      processing: "save_only",
    },
  });

  expect(source.status()).toBe(201);

  const sourceBody = (await source.json()) as { record: { id: string } };
  const organized = await request.post(
    appUrl(`/api/v1/records/${sourceBody.record.id}/organize`),
    { data: { handling: "automatic" } },
  );

  expect(organized.status()).toBe(202);

  const organizedBody = (await organized.json()) as { task: { id: string } };

  await expectTaskSucceeded(request, organizedBody.task.id);

  const [detailResponse, approvedResponse] = await Promise.all([
    request.get(appUrl(`/api/v1/records/${sourceBody.record.id}`)),
    request.get(appUrl("/api/v1/tags")),
  ]);

  expect(detailResponse.status()).toBe(200);
  expect(approvedResponse.status()).toBe(200);

  const detail = (await detailResponse.json()) as {
    organizedItems: Array<{ tags: Array<{ id: string; name: string }> }>;
  };
  const approvedBody = (await approvedResponse.json()) as {
    items: Array<{ id: string; name: string }>;
  };
  const approvedIds = new Set(approvedBody.items.map((tag) => tag.id));
  const candidates = new Map<string, SeededTag>();

  for (const tag of detail.organizedItems.flatMap((item) => item.tags)) {
    if (!approvedIds.has(tag.id)) {
      candidates.set(tag.id, {
        id: tag.id,
        name: tag.name,
        approval: "candidate",
      });
    }
  }

  expect(candidates.size).toBeGreaterThan(0);

  return {
    tags: [
      ...approvedBody.items.map((tag) => ({
        ...tag,
        approval: "approved" as const,
      })),
      ...candidates.values(),
    ],
  };
}

async function seedSaveOnlyTag(
  request: APIRequestContext,
  tagName: string,
): Promise<void> {
  const response = await request.post(appUrl("/api/v1/records"), {
    data: {
      myTags: [{ name: tagName }],
      processing: "save_only",
      text: `首页神经标签场 ${tagName}`,
    },
  });

  expect(response.status()).toBe(201);
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  // These loopback-only endpoints cannot reach a paid service. E2E_FAKE_AI=1
  // intercepts both endpoint checks and organization before fetch.
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
    expect(await tested.json()).toMatchObject({ kind, status: "passed" });
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

    expect(response.status()).toBe(200);

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

function tagSearchUrl(tagId: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("tag", tagId);

  return url.toString();
}

function recordSearchUrl(query: string): string {
  const url = new URL("/search", appBaseUrl);

  url.searchParams.set("q", query);

  return url.toString();
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
