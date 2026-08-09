import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";

import { expectBox } from "./geometry.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test.describe("tag atlas", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("user browses text-first tag cards and opens a push drawer", async ({
    page,
    request,
  }) => {
    const marker = `tag-atlas-${randomUUID().slice(0, 8)}`;
    const seeded = await seedApprovedTags(request, marker);

    await page.goto(appUrl("/tags"));
    await expect(page).toHaveURL(appUrl("/tags"));

    const navigation = page.getByRole("navigation", { name: "主导航" });
    const main = page.getByRole("main", { name: "标签图鉴" });
    const atlas = main.getByRole("list", { name: "标签图鉴" });
    const cards = atlas.getByRole("listitem");

    await expect(
      navigation.getByRole("link", { name: "标签", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expectBox(navigation, {
      x: 0,
      y: 0,
      width: 1_600,
      height: 60,
    });
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(6);
    await expectFiveEqualColumns(cards);
    await expect(atlas.locator("canvas")).toHaveCount(0);
    await expect(atlas.getByRole("img")).toHaveCount(0);

    for (const tag of seeded.tags) {
      const card = atlas.getByRole("button", { name: tag.name });

      await expect(card).toHaveCount(1);
      await expect(card).toContainText(tag.name);
      await expect(card).toContainText(`${tag.recordCount} 条记录`);
    }

    const closedMainBox = await main.boundingBox();

    expect(closedMainBox, "closed atlas must have a rendered box").not.toBeNull();

    await atlas
      .getByRole("button", { name: seeded.targetTagName })
      .click();

    const drawer = page.getByRole("region", { name: "标签详情" });

    await expect(drawer).toBeVisible();
    await expectBox(drawer, { width: 480 }, 4);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const openMainBox = await main.boundingBox();
    const drawerBox = await drawer.boundingBox();

    expect(openMainBox, "open atlas must have a rendered box").not.toBeNull();
    expect(drawerBox, "tag drawer must have a rendered box").not.toBeNull();

    if (closedMainBox && openMainBox && drawerBox) {
      expect(Math.abs(closedMainBox.x - openMainBox.x)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(closedMainBox.width - openMainBox.width - 480),
      ).toBeLessThanOrEqual(4);
      expect(openMainBox.x + openMainBox.width).toBeLessThanOrEqual(
        drawerBox.x + 2,
      );
    }

    await expect(
      drawer.getByRole("heading", {
        name: seeded.targetTagName,
        exact: true,
      }),
    ).toBeVisible();

    const relatedRecords = drawer
      .getByRole("list", { name: "关联记录" })
      .getByRole("listitem");

    await expect(relatedRecords).toHaveCount(2);
    await expect(
      drawer.getByRole("button", { name: "归档标签", exact: true }),
    ).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "删除标签", exact: true }),
    ).toHaveCount(0);
    await expect(
      drawer.getByRole("menuitem", { name: "删除标签", exact: true }),
    ).toHaveCount(0);
  });

  test("user switches to AI candidates and manages one knowledge-point relation at a time", async ({
    page,
    request,
  }) => {
    const marker = `tag-candidate-${randomUUID().slice(0, 8)}`;
    const seeded = await seedCandidateRecord(request, marker);

    await page.goto(appUrl("/tags"));

    const main = page.getByRole("main", { name: "标签图鉴" });
    const sections = main.getByRole("tablist", { name: "标签分区" });
    const approvedTab = sections.getByRole("tab", {
      name: "我的标签",
      exact: true,
    });
    const candidateTab = sections.getByRole("tab", {
      name: "AI 候选",
      exact: true,
    });
    const search = main.getByRole("searchbox", { name: "搜索标签" });
    const sort = main.getByRole("combobox", { name: "标签排序" });
    const atlas = main.getByRole("list", { name: "标签图鉴" });

    await expect(approvedTab).toHaveAttribute("aria-selected", "true");
    await candidateTab.click();
    await expect(candidateTab).toHaveAttribute("aria-selected", "true");

    await sort.selectOption("name_asc");
    await expect
      .poll(() => atlas.locator("strong").count())
      .toBeGreaterThanOrEqual(2);
    const ascendingNames = await atlas.locator("strong").allTextContents();

    expect(ascendingNames.length).toBeGreaterThanOrEqual(2);

    await sort.selectOption("name_desc");
    await expect
      .poll(() => atlas.locator("strong").allTextContents())
      .toEqual([...ascendingNames].reverse());

    await search.fill(seeded.candidateName);

    const candidateCard = atlas.getByRole("button", {
      name: seeded.candidateName,
      exact: true,
    });

    await expect(candidateCard).toHaveAttribute(
      "data-tag-id",
      seeded.candidateId,
    );
    await expect(candidateCard).toContainText("1 条记录");
    await candidateCard.click();

    const drawer = page.getByRole("region", { name: "标签详情" });
    const recordGroup = drawer.locator(
      `[data-record-id="${seeded.recordId}"]`,
    );

    await expect(drawer).toBeVisible();
    await expect(recordGroup).toHaveCount(1);
    await expect(recordGroup).toContainText("来自 2 个 AI 知识点");
    await expect(drawer.locator("[data-assignment-id]")).toHaveCount(0);
    await expect(drawer).not.toContainText(
      /Tag Assignment|assignment_id|assigned_by|ACTIVE|SUPPRESSED/u,
    );

    await recordGroup
      .getByRole("button", { name: "展开关联来源", exact: true })
      .click();

    const firstPoint = recordGroup.getByRole("group", {
      name: seeded.pointTitles[0],
      exact: true,
    });
    const secondPoint = recordGroup.getByRole("group", {
      name: seeded.pointTitles[1],
      exact: true,
    });

    await expect(firstPoint).toBeVisible();
    await expect(secondPoint).toBeVisible();
    await firstPoint
      .getByRole("button", { name: "屏蔽此标签关联", exact: true })
      .click();

    await expect(recordGroup).toContainText("1 个生效 AI 知识点");
    await expect(recordGroup).toContainText("1 个已屏蔽关联");
    await expect(candidateCard).toContainText("1 条记录");
    await expect(
      firstPoint.getByRole("button", {
        name: "恢复此标签关联",
        exact: true,
      }),
    ).toBeVisible();

    await firstPoint
      .getByRole("button", { name: "恢复此标签关联", exact: true })
      .click();
    await expect(recordGroup).toContainText("来自 2 个 AI 知识点");

    await drawer
      .getByRole("button", { name: "认可为我的标签", exact: true })
      .click();

    await approvedTab.click();
    await search.fill(seeded.candidateName);
    await expect(
      atlas.getByRole("button", {
        name: seeded.candidateName,
        exact: true,
      }),
    ).toHaveAttribute("data-tag-id", seeded.candidateId);

    await candidateTab.click();
    await expect(
      atlas.getByRole("button", {
        name: seeded.candidateName,
        exact: true,
      }),
    ).toHaveCount(0);
  });
});

async function seedApprovedTags(
  request: APIRequestContext,
  marker: string,
): Promise<{
  tags: Array<{ name: string; recordCount: number }>;
  targetTagName: string;
}> {
  const tags = Array.from({ length: 6 }, (_, index) => ({
    name: `图鉴标签 ${String(index + 1).padStart(2, "0")} ${marker}`,
    recordCount: index === 0 ? 2 : 1,
  }));
  let targetTagId = "";

  for (const [index, tag] of tags.entries()) {
    const response = await request.post(appUrl("/api/v1/records"), {
      data: {
        text: `图鉴记录 ${index + 1} ${marker}`,
        myTags: [{ name: tag.name }],
        processing: "save_only",
      },
    });

    expect(response.status()).toBe(201);

    if (index === 0) {
      const body = (await response.json()) as {
        record: { myTags: Array<{ id: string }> };
      };

      targetTagId = body.record.myTags[0]?.id ?? "";
    }
  }

  expect(targetTagId).not.toBe("");

  const secondTargetRecord = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: `图鉴记录 7 ${marker}`,
      myTags: [{ id: targetTagId }],
      processing: "save_only",
    },
  });

  expect(secondTargetRecord.status()).toBe(201);

  return {
    tags,
    targetTagName: tags[0]!.name,
  };
}

async function seedCandidateRecord(
  request: APIRequestContext,
  marker: string,
): Promise<{
  candidateId: string;
  candidateName: string;
  pointTitles: [string, string];
  recordId: string;
}> {
  await enableDeterministicFakeConfiguration(request);

  const created = await request.post(appUrl("/api/v1/records"), {
    data: {
      text: `E2E_TAG_ATLAS ${marker.slice(-8)} CDC 读取事务日志。\n事务日志保留增量顺序 ${marker}。`,
      myTags: [{ name: `候选图鉴入口 ${marker}` }],
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

  const detailResponse = await request.get(
    appUrl(`/api/v1/records/${recordId}`),
  );

  expect(detailResponse.status()).toBe(200);

  const detail = (await detailResponse.json()) as {
    organizedItems: Array<{
      id: string;
      title: string;
      tags: Array<{ id: string; name: string }>;
    }>;
  };
  const firstPointTagIds = new Set(
    detail.organizedItems[0]?.tags.map((tag) => tag.id) ?? [],
  );
  const sharedCandidate = detail.organizedItems[1]?.tags.find((tag) =>
    firstPointTagIds.has(tag.id),
  );

  if (!sharedCandidate || detail.organizedItems.length !== 2) {
    throw new Error("The deterministic E2E analysis must expose the shared candidate");
  }

  return {
    candidateId: sharedCandidate.id,
    candidateName: sharedCandidate.name,
    pointTitles: [
      detail.organizedItems[0]!.title,
      detail.organizedItems[1]!.title,
    ],
    recordId,
  };
}

async function enableDeterministicFakeConfiguration(
  request: APIRequestContext,
): Promise<void> {
  // Port 9 is loopback-only and intentionally unused. E2E_FAKE_AI=1 must
  // intercept endpoint checks and generation before any network request.
  const saved = await request.put(appUrl("/api/v1/model-config/draft"), {
    data: {
      text: {
        baseUrl: "http://127.0.0.1:9/tag-atlas-text/v1",
        model: "tag-atlas-fake-text",
        apiKey: "tag-atlas-fake-text-key",
      },
      embedding: {
        baseUrl: "http://127.0.0.1:9/tag-atlas-embedding/v1",
        model: "tag-atlas-fake-embedding",
        apiKey: "tag-atlas-fake-embedding-key",
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

    expect(response.status()).toBe(200);

    const status = (
      (await response.json()) as {
        task: { status: "queued" | "running" | "succeeded" | "failed" };
      }
    ).task.status;

    if (status === "succeeded") {
      return;
    }

    if (status === "failed") {
      throw new Error(`AI task ${taskId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`AI task ${taskId} did not finish in time`);
}

async function expectFiveEqualColumns(cards: Locator): Promise<void> {
  const boxes = await Promise.all(
    Array.from({ length: await cards.count() }, (_, index) =>
      cards.nth(index).boundingBox(),
    ),
  );

  expect(boxes.every((box) => box !== null)).toBe(true);

  const rendered = boxes.filter((box) => box !== null);
  const top = Math.min(...rendered.map((box) => box.y));
  const firstRow = rendered
    .filter((box) => Math.abs(box.y - top) <= 2)
    .sort((left, right) => left.x - right.x);
  const reference = rendered[0]!;

  expect(firstRow).toHaveLength(5);

  for (const box of rendered) {
    expect(Math.abs(box.width - reference.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - reference.height)).toBeLessThanOrEqual(2);
  }

  for (let index = 1; index < firstRow.length; index += 1) {
    expect(firstRow[index]!.x).toBeGreaterThan(
      firstRow[index - 1]!.x + firstRow[index - 1]!.width,
    );
  }
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
