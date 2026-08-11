import { expect, test } from "./fixture.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";

test("knowledge discovery keeps every V2 decision explicit and reversible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_280, height: 800 });

  const sourceA = "00000000-0000-4000-8000-000000000101";
  const sourceB = "00000000-0000-4000-8000-000000000102";
  const recordA = "00000000-0000-4000-8000-000000000201";
  const recordB = "00000000-0000-4000-8000-000000000202";
  const duplicateId = "00000000-0000-4000-8000-000000000301";
  const relationId = "00000000-0000-4000-8000-000000000401";
  const formalRelationId = "00000000-0000-4000-8000-000000000402";
  const coverageId = "00000000-0000-4000-8000-000000000501";
  let duplicateAccepted = false;
  let relationConfirmed = false;

  await page.route("**/api/v1/duplicate-suggestions?status=*", async (route) => {
    const resolved = new URL(route.request().url()).searchParams.get("status") === "resolved";
    const visible = resolved ? duplicateAccepted : !duplicateAccepted;

    await route.fulfill({
      contentType: "application/json",
      json: {
        items: visible
          ? [duplicateSuggestion({
              duplicateId,
              recordA,
              recordB,
              sourceA,
              sourceB,
              status: duplicateAccepted ? "accepted" : "pending_review",
            })]
          : [],
      },
    });
  });
  await page.route(`**/api/v1/duplicate-suggestions/${duplicateId}/accept`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ primarySourceId: sourceA });
    duplicateAccepted = true;
    await route.fulfill({
      contentType: "application/json",
      json: {
        suggestion: duplicateSuggestion({
          duplicateId,
          recordA,
          recordB,
          sourceA,
          sourceB,
          status: "accepted",
        }),
      },
    });
  });

  await page.route("**/api/v1/relation-suggestions?status=*", async (route) => {
    const resolved = new URL(route.request().url()).searchParams.get("status") === "resolved";
    const resolvedItems = Array.from({ length: 7 }, (_, index) =>
      relationSuggestion({
        formalRelationId: `00000000-0000-4000-8000-0000000005${String(index + 1).padStart(2, "0")}`,
        recordA,
        recordB,
        relationConfirmed: true,
        relationId: `00000000-0000-4000-8000-0000000004${String(index + 1).padStart(2, "0")}`,
        sourceA,
        sourceB,
      }),
    ).map((suggestion, index) => {
      if (index === 1) {
        return {
          ...suggestion,
          relation: suggestion.relation
            ? { ...suggestion.relation, removed: true }
            : null,
          status: "removed",
        };
      }

      if (index === 2) {
        return {
          ...suggestion,
          canDecide: false,
          relation: null,
          status: "rejected",
        };
      }

      return suggestion;
    });

    await route.fulfill({
      contentType: "application/json",
      json: {
        items: resolved
          ? relationConfirmed
            ? resolvedItems
            : []
          : relationConfirmed
            ? []
            : [relationSuggestion({
              formalRelationId,
              recordA,
              recordB,
              relationConfirmed: false,
              relationId,
              sourceA,
              sourceB,
            })],
      },
    });
  });
  await page.route(`**/api/v1/relation-suggestions/${relationId}/confirm`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      description: "缓存失效策略扩展了版本化读取策略。",
      type: "extends",
    });
    relationConfirmed = true;
    await route.fulfill({
      contentType: "application/json",
      json: {
        suggestion: relationSuggestion({
          formalRelationId,
          recordA,
          recordB,
          relationConfirmed,
          relationId,
          sourceA,
          sourceB,
        }),
      },
    });
  });
  await page.route("**/api/v1/records/*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        editable: {
          myTags: [
            { id: "tag-cache", name: "缓存" },
            { id: "tag-consistency", name: "一致性" },
          ],
          text: "使用版本号避免旧缓存覆盖新值，并在写入后主动失效相关缓存。",
          textVersion: 1,
        },
        excludedItems: [],
        id: recordA,
        lifecycle: "active",
        organization: { activity: "idle", task: null, view: "organized" },
        organizedItems: [],
        presentation: {
          source: "ai",
          summary: "版本化读取与缓存失效的实践记录。",
          title: "缓存一致性笔记",
        },
        updatedAt: "2026-08-11T08:00:00.000Z",
      },
    });
  });

  await page.route("**/api/v1/coverage-sources?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        items: [
          {
            excerpt: "使用版本号避免旧缓存覆盖新值。",
            id: recordA,
            organization: "organized",
            tags: ["缓存", "一致性"],
            title: "缓存一致性笔记",
            updatedAt: "2026-08-11T08:00:00.000Z",
          },
          {
            excerpt: "写入后主动清除相关缓存键。",
            id: recordB,
            organization: "original",
            tags: ["缓存"],
            title: "缓存失效实践",
            updatedAt: "2026-08-10T08:00:00.000Z",
          },
        ],
      },
    });
  });
  await page.route("**/api/v1/coverage-analyses", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        recordIds: [recordA],
        topic: "缓存一致性",
      });
      await route.fulfill({
        contentType: "application/json",
        status: 202,
        json: { analysis: coverageAnalysis({ coverageId, recordA }) },
      });
      return;
    }

    await route.fulfill({ contentType: "application/json", json: { items: [] } });
  });

  await page.goto(appUrl("/insights"));

  const navigation = page.getByRole("navigation", { name: "主导航" });
  const main = page.getByRole("main", { name: "知识发现" });

  await expect(navigation.getByRole("link", { name: "发现" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(main).toContainText("不删除原文、知识点或历史版本");

  const duplicateCard = main.locator(".review-card");

  await expect(duplicateCard).toHaveCount(1);
  await expect(duplicateCard).toContainText("接受只会新增一条合并关系");
  await duplicateCard.getByLabel("设为主要展示来源").first().check();
  await duplicateCard.getByRole("button", { name: "建立来源保留合并" }).click();
  await expect(
    main.getByRole("status").filter({ hasText: "两份原始内容仍完整保留" }),
  ).toBeVisible();

  await main.getByRole("tab", { name: "关系审查" }).click();
  const relationCard = main.locator(".relation-card");

  await expect(relationCard).toContainText("只建立连接，不改写内容");
  const rationale = relationCard.locator(".relation-rationale");
  await expect(rationale).not.toHaveAttribute("open", "");
  await rationale.getByText("判断依据").click();
  await expect(rationale).toHaveAttribute("open", "");
  await expect(rationale).toContainText("避免旧缓存覆盖新值");
  await relationCard.getByLabel("关系类型").selectOption("extends");
  await relationCard
    .getByLabel("关系描述")
    .fill("缓存失效策略扩展了版本化读取策略。");
  await relationCard.getByRole("button", { name: "确认正式关系" }).click();
  await expect(
    main.getByRole("status").filter({ hasText: "知识点原文未改变" }),
  ).toBeVisible();

  await main.getByRole("tab", { name: "已处理" }).click();
  const relationHistory = main.locator(".relation-history");
  const relationRows = relationHistory.locator(".relation-history-row");

  await expect(relationRows).toHaveCount(6);
  await expect(
    relationHistory.locator(".relation-history-status.is-confirmed").first(),
  ).toContainText("已确认");
  await expect(
    relationHistory.locator(".relation-history-status.is-removed"),
  ).toContainText("已撤销");
  await expect(
    relationHistory.locator(".relation-history-status.is-rejected"),
  ).toContainText("已忽略");
  await expect(
    relationRows.first().getByRole("button", { name: "撤销关系" }),
  ).toBeVisible();

  await relationRows
    .first()
    .getByRole("button", { name: "预览记录：缓存一致性笔记" })
    .click();
  const recordDrawer = page.getByRole("dialog", {
    name: "记录预览：缓存一致性笔记",
  });

  await expect(recordDrawer).toContainText("版本化缓存读取");
  await expect(recordDrawer).toContainText("版本化读取与缓存失效的实践记录");
  await expect(
    recordDrawer.getByRole("link", { name: "打开完整记录" }),
  ).toHaveAttribute("href", `/records/${recordA}`);
  await recordDrawer.getByRole("button", { name: "关闭记录预览" }).click();
  await expect(recordDrawer).toBeHidden();

  await relationHistory
    .getByRole("button", { name: "下一页已处理关系" })
    .click();
  await expect(relationRows).toHaveCount(1);
  await expect(relationHistory).toContainText("第 2 / 2 页");

  await main.getByRole("tab", { name: "覆盖分析" }).click();
  await main.getByRole("button", { name: "新建覆盖分析" }).click();
  await main.getByLabel("分析主题").fill("缓存一致性");
  await main.getByRole("checkbox").first().check();
  await main.getByRole("button", { name: "创建分析任务" }).click();

  await expect(
    main.getByRole("status").filter({ hasText: "分析任务已创建" }),
  ).toBeVisible();
  await expect(main.getByRole("region", { name: "覆盖分析结果" })).toContainText(
    "这是分析提示，不是事实裁决",
  );
  await expect(main).toContainText("所有结论只用于辅助复盘");
});

function duplicateSuggestion(input: {
  duplicateId: string;
  recordA: string;
  recordB: string;
  sourceA: string;
  sourceB: string;
  status: "accepted" | "pending_review";
}) {
  return {
    canDecide: input.status === "pending_review",
    consolidationId: input.status === "accepted" ? "consolidation-1" : null,
    createdAt: "2026-08-11T08:00:00.000Z",
    id: input.duplicateId,
    kind: "semantic",
    primarySourceId: input.status === "accepted" ? input.sourceA : null,
    reason: "两项都描述了以版本号防止缓存旧值覆盖新值。",
    score: 0.96,
    status: input.status,
    sources: [
      {
        changedSinceSuggestion: false,
        current: true,
        excerpt: "使用版本号避免旧缓存覆盖新值。",
        id: input.sourceA,
        recordId: input.recordA,
        recordTitle: "缓存一致性笔记",
        title: "版本化缓存读取",
        type: "knowledge_point",
      },
      {
        changedSinceSuggestion: false,
        current: true,
        excerpt: "写入后清理旧缓存，并校验版本。",
        id: input.sourceB,
        recordId: input.recordB,
        recordTitle: "缓存失效实践",
        title: "缓存失效策略",
        type: "knowledge_point",
      },
    ],
  };
}

function relationSuggestion(input: {
  formalRelationId: string;
  recordA: string;
  recordB: string;
  relationConfirmed: boolean;
  relationId: string;
  sourceA: string;
  sourceB: string;
}) {
  const point = (side: "source" | "target") => ({
    body:
      side === "source"
        ? "使用版本号避免旧缓存覆盖新值。"
        : "写入完成后主动清除相关缓存键。",
    changedSinceSuggestion: false,
    current: true,
    evidence: [
      {
        id: side === "source" ? "evidence-a" : "evidence-b",
        quote: side === "source" ? "避免旧缓存覆盖新值" : "主动清除相关缓存键",
      },
    ],
    id: side === "source" ? input.sourceA : input.sourceB,
    recordId: side === "source" ? input.recordA : input.recordB,
    recordTitle: side === "source" ? "缓存一致性笔记" : "缓存失效实践",
    title: side === "source" ? "版本化缓存读取" : "缓存失效策略",
  });

  return {
    canDecide: !input.relationConfirmed,
    confidence: 0.91,
    description: "两种策略共同降低陈旧缓存风险。",
    id: input.relationId,
    model: { configurationVersion: 3, name: "fake-text" },
    needsReview: false,
    reason: "两端都有明确的缓存一致性证据。",
    relation: input.relationConfirmed
      ? {
          description: "缓存失效策略扩展了版本化读取策略。",
          id: input.formalRelationId,
          removed: false,
          type: "extends",
        }
      : null,
    source: point("source"),
    status: input.relationConfirmed ? "confirmed" : "pending_review",
    target: point("target"),
    type: "similar",
  };
}

function coverageAnalysis(input: {
  coverageId: string;
  recordA: string;
}) {
  const source = {
    changedSinceAnalysis: false,
    current: true,
    excerpt: "使用版本号避免旧缓存覆盖新值。",
    id: input.recordA,
    recordId: input.recordA,
    title: "缓存一致性笔记",
  };

  return {
    advisory: true,
    attemptCount: 1,
    canRetry: false,
    caveat: "所有结论只用于辅助复盘，不代表完整性或正确性的事实裁决。",
    completedAt: "2026-08-11T08:01:00.000Z",
    covered: [
      {
        assessment: "已经覆盖读取侧的版本校验。",
        id: "covered-1",
        kind: "covered",
        recommendation: null,
        sources: [source],
        title: "读取一致性",
      },
    ],
    createdAt: "2026-08-11T08:00:00.000Z",
    failure: null,
    frameworkSummary: "按读取、写入和故障恢复三个方面检查缓存一致性。",
    id: input.coverageId,
    inputChanged: false,
    inputCount: 1,
    inputKind: "records",
    model: { configurationVersion: 3, name: "fake-text" },
    possibleGaps: [
      {
        assessment: "当前材料未明确故障恢复后的缓存重建流程。",
        id: "gap-1",
        kind: "possible_gap",
        recommendation: "补充节点恢复和缓存预热策略。",
        sources: [],
        title: "故障恢复",
      },
    ],
    sources: [source],
    startedAt: "2026-08-11T08:00:01.000Z",
    status: "succeeded",
    topic: "缓存一致性",
  };
}

function appUrl(path: string): string {
  return new URL(path, appBaseUrl).toString();
}
