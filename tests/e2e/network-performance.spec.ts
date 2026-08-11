import { expect, test, type Page } from "./fixture.js";

import type {
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
} from "../../src/client/api.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const MEBIBYTE = 1_024 * 1_024;

test.describe("Knowledge Network target-scale acceptance", () => {
  test.use({ viewport: { width: 1_600, height: 1_000 } });

  test("renders 300 nodes and 600 real edges within the interaction and heap budgets", async ({
    page,
  }, testInfo) => {
    const fixture = targetScaleNetwork();
    const initialBody = JSON.stringify(
      graphResponse(
        fixture.nodes.filter(({ type }) => type === "concept"),
        fixture.edges.filter(({ kind }) => kind === "concept_relation"),
        null,
      ),
    );
    const expandedBody = JSON.stringify(
      graphResponse(fixture.nodes, fixture.edges, fixture.focus.key),
    );
    let subgraphRequestCount = 0;

    await page.route("**/api/v1/network/subgraph**", async (route) => {
      subgraphRequestCount += 1;
      const root = new URL(route.request().url()).searchParams.get("root");

      await route.fulfill({
        body: root ? expandedBody : initialBody,
        contentType: "application/json",
        status: 200,
      });
    });

    const targetUrl = appUrl(`/network?node=${encodeURIComponent(fixture.focus.key)}`);

    // Warm the compiled application, Worker module, font, and browser code paths.
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await expectTargetScaleCanvas(page);

    await page.goto("about:blank");
    await collectGarbage(page);
    const heapBefore = await usedHeapSize(page);

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    const canvas = await expectTargetScaleCanvas(page);
    const interactiveMs = await page.evaluate(() => performance.now());

    expect(interactiveMs).toBeLessThanOrEqual(1_500);
    await expect(
      page.getByRole("main", { name: "知识网络" }).getByText(
        "300 节点 · 600 真实边",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(canvas.locator(".network-node").first()).toHaveAttribute(
      "tabindex",
      "0",
    );

    const requestsBeforeFocus = subgraphRequestCount;
    const focusFeedback = await page.evaluate(async () => {
      const graph = document.querySelector<SVGSVGElement>(".network-canvas");
      const focusButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "聚焦节点");

      if (!graph || !focusButton || focusButton.disabled) {
        throw new Error("The target-scale graph focus control is unavailable.");
      }

      const before = graph.getAttribute("viewBox");

      return new Promise<{ after: string | null; before: string | null; duration: number }>(
        (resolve, reject) => {
          const startedAt = performance.now();
          const timeout = window.setTimeout(() => {
            observer.disconnect();
            reject(new Error("Focus feedback did not update the graph viewBox."));
          }, 500);
          const observer = new MutationObserver(() => {
            const after = graph.getAttribute("viewBox");

            if (after === before) return;
            window.clearTimeout(timeout);
            observer.disconnect();
            resolve({ after, before, duration: performance.now() - startedAt });
          });

          observer.observe(graph, {
            attributeFilter: ["viewBox"],
            attributes: true,
          });
          focusButton.click();
        },
      );
    });

    expect(focusFeedback.after).not.toBe(focusFeedback.before);
    expect(focusFeedback.duration).toBeLessThanOrEqual(100);
    expect(subgraphRequestCount).toBe(requestsBeforeFocus);

    await collectGarbage(page);
    const heapAfter = await usedHeapSize(page);

    if (heapBefore === null || heapAfter === null) {
      testInfo.annotations.push({
        description:
          "Chromium did not expose performance.memory; only the heap assertion was skipped.",
        type: "heap-assertion-skipped",
      });
    } else {
      expect(heapAfter - heapBefore).toBeLessThanOrEqual(50 * MEBIBYTE);
    }
  });
});

async function expectTargetScaleCanvas(page: Page) {
  const canvas = page.getByRole("group", { name: "真实知识网络图幅" });

  await expect(canvas).toBeVisible();
  await expect(canvas.locator(".network-nodes > .network-node")).toHaveCount(300);
  await expect(canvas.locator(".network-edges > [role='listitem']")).toHaveCount(600);

  return canvas;
}

async function collectGarbage(page: Page): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);

    await session.send("HeapProfiler.collectGarbage");
    await session.detach();
  } catch {
    // The memory assertion below remains explicitly conditional on API support.
  }
}

async function usedHeapSize(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;

    return typeof memory?.usedJSHeapSize === "number"
      ? memory.usedJSHeapSize
      : null;
  });
}

function targetScaleNetwork(): {
  edges: NetworkEdge[];
  focus: NetworkNode;
  nodes: NetworkNode[];
} {
  const concepts = Array.from({ length: 60 }, (_, index) =>
    conceptNode(index),
  );
  const points = Array.from({ length: 240 }, (_, index) =>
    knowledgePointNode(index),
  );
  const memberships = points.map((point, index) =>
    membershipEdge(index, concepts[index % concepts.length]!.key, point.key),
  );
  const conceptRelations = concepts.map((concept, index) =>
    relationEdge(
      "concept_relation",
      index,
      concept.key,
      concepts[(index + 1) % concepts.length]!.key,
    ),
  );
  const knowledgeRelations = Array.from({ length: 300 }, (_, index) => {
    const sourceIndex = index % points.length;
    const hop = index < points.length ? 1 : 17;

    return relationEdge(
      "knowledge_relation",
      index,
      points[sourceIndex]!.key,
      points[(sourceIndex + hop) % points.length]!.key,
    );
  });

  return {
    edges: [...memberships, ...conceptRelations, ...knowledgeRelations],
    focus: concepts[0]!,
    nodes: [...concepts, ...points],
  };
}

function conceptNode(index: number): NetworkNode {
  const id = fixtureId("61000000", index);

  return {
    description: `目标规模验收 Concept ${index}`,
    id,
    key: `concept:${id}`,
    label: `验收概念 ${String(index).padStart(2, "0")}`,
    source: {
      kind: "concept_revision",
      revisionId: fixtureId("61100000", index),
      revisionNumber: 1,
    },
    type: "concept",
  };
}

function knowledgePointNode(index: number): NetworkNode {
  const id = fixtureId("62000000", index);

  return {
    description: `目标规模验收 Knowledge Point ${index}`,
    id,
    key: `knowledge_point:${id}`,
    label: `验收知识点 ${String(index).padStart(3, "0")}`,
    source: {
      analysisRevisionId: fixtureId("62400000", index),
      fragmentRevisionId: fixtureId("62300000", index),
      kind: "knowledge_point",
      recordId: fixtureId("62200000", index),
      recordTitle: `验收来源记录 ${String(index).padStart(3, "0")}`,
    },
    type: "knowledge_point",
  };
}

function membershipEdge(
  index: number,
  source: string,
  target: string,
): NetworkEdge {
  const id = fixtureId("63000000", index);

  return {
    confirmation: null,
    description: null,
    directed: false,
    edgeKey: `concept_membership:${id}`,
    kind: "concept_membership",
    relationType: "membership",
    source,
    sourceRecord: {
      createdAt: "2099-08-09T08:00:00.000Z",
      id,
      kind: "concept_membership",
      origin: "manual",
    },
    target,
  };
}

function relationEdge(
  kind: "concept_relation" | "knowledge_relation",
  index: number,
  source: string,
  target: string,
): NetworkEdge {
  const relationNamespace = kind === "concept_relation" ? "64000000" : "65000000";
  const confirmationNamespace = kind === "concept_relation" ? "64100000" : "65100000";
  const id = fixtureId(relationNamespace, index);
  const confirmationId = fixtureId(confirmationNamespace, index);
  const confirmedAt = "2099-08-09T08:00:00.000Z";

  return {
    confirmation: { confirmedAt, id: confirmationId, relationId: id },
    description: "目标规模验收使用的已确认真实关系。",
    directed: true,
    edgeKey: `${kind}:${id}`,
    kind,
    relationType: "extends",
    source,
    sourceRecord: {
      confidence: 0.9,
      confirmedAt,
      id: confirmationId,
      kind:
        kind === "concept_relation"
          ? "concept_relation_confirmation"
          : "knowledge_relation_confirmation",
      reason: "目标规模验收 fixture。",
      relationId: id,
    },
    target,
  };
}

function graphResponse(
  nodes: NetworkNode[],
  edges: NetworkEdge[],
  root: string | null,
): NetworkGraph {
  return {
    edges,
    limits: { depth: root ? 1 : 0, edgeLimit: 600, nodeLimit: 300 },
    nodes,
    root,
    truncated: false,
    truncation: { edges: false, nodes: false },
  };
}

function fixtureId(namespace: string, index: number): string {
  return `${namespace}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}
