import {
  expect,
  test,
  type CDPSession,
  type Page,
} from "@playwright/test";

import type {
  NetworkEdge,
  NetworkGraph,
  NetworkNode,
} from "../../src/client/api.js";

const appBaseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const MEBIBYTE = 1_024 * 1_024;
const TARGET_EDGE_COUNT = 1_000;
const TARGET_NODE_COUNT = 500;

test.describe("V3.4 home 3D target-scale performance", () => {
  test.use({
    contextOptions: { reducedMotion: "reduce" },
    viewport: { height: 1_000, width: 1_600 },
  });

  test("keeps 500 nodes and 1000 real edges inside the browser budgets", async ({
    page,
  }, testInfo) => {
    test.slow();
    const fixture = targetScaleHomeNetwork();
    const targetUrl = appUrl(
      `/?from=${encodeURIComponent(fixture.focus.key)}`,
    );

    await installPerformanceInstrumentation(page, {
      edges: fixture.edges.length,
      nodes: fixture.nodes.length,
    });
    await installTargetScaleRoutes(page, fixture);

    // Warm Vite, Three.js, the module Worker, and the browser shader path before
    // measuring a fresh navigation. The measured run still starts from a blank page.
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await expectTargetStage(page, fixture);
    await expect
      .poll(async () => (await readPerformanceAudit(page)).firstTargetPaintAt)
      .not.toBeNull();

    await page.goto("about:blank");
    const cdp = await createPerformanceSession(page);

    await collectGarbage(page, cdp);
    const heapBefore = await usedHeapSize(page, cdp);

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    const stage = await expectTargetStage(page, fixture);

    await expect
      .poll(async () => (await readPerformanceAudit(page)).firstTargetPaintAt, {
        timeout: 2_000,
      })
      .not.toBeNull();
    const initialAudit = await readPerformanceAudit(page);
    const targetLayout = initialAudit.layoutSamples.find(
      ({ edges, nodes }) =>
        edges === TARGET_EDGE_COUNT && nodes === TARGET_NODE_COUNT,
    );

    expect(initialAudit.firstTargetPaintAt).not.toBeNull();
    expect(initialAudit.firstTargetPaintAt!).toBeLessThanOrEqual(1_500);
    expect(targetLayout, "target-scale Worker layout sample").toBeDefined();
    expect(targetLayout!.duration).toBeLessThanOrEqual(250);

    await expect(stage).toHaveAttribute("data-node-count", "500");
    await expect(stage).toHaveAttribute("data-edge-count", "1000");
    await expect(stage).toHaveAttribute(
      "data-node-keys",
      fixture.nodes.map(({ key }) => key).sort().join(" "),
    );
    await expect(stage).toHaveAttribute(
      "data-edge-keys",
      fixture.edges.map(({ edgeKey }) => edgeKey).sort().join(" "),
    );

    // The target frame proves LOD retained both typed node meshes, all arrows,
    // and both real-edge line buffers instead of merely preserving DOM counters.
    const instancedCounts = initialAudit.targetFrameDraws
      .flatMap(({ instanceCount }) =>
        typeof instanceCount === "number" ? [instanceCount] : [],
      );
    const lineVertexCounts = initialAudit.targetFrameDraws
      .filter(({ method }) => method === "drawArrays")
      .map(({ count }) => count);

    expect(instancedCounts).toEqual(expect.arrayContaining([100, 400, 600]));
    expect(lineVertexCounts).toEqual(expect.arrayContaining([800, 1_200]));

    await sampleControlledWheelFrames(page, 24);
    const framesBeforeResize = (await readPerformanceAudit(page)).graphFrameCount;

    await page.setViewportSize({ height: 960, width: 1_536 });
    await expect
      .poll(async () => (await readPerformanceAudit(page)).graphFrameCount)
      .toBeGreaterThan(framesBeforeResize);
    await stopFrameCapture(page);
    const interactionAudit = await readPerformanceAudit(page);
    const frameDurations = [...interactionAudit.capturedFrameDurations].sort(
      (left, right) => left - right,
    );
    const p95Index = Math.max(0, Math.ceil(frameDurations.length * 0.95) - 1);
    const frameP95 = frameDurations[p95Index]!;
    const frameMax = frameDurations[frameDurations.length - 1]!;

    expect(frameDurations.length).toBeGreaterThanOrEqual(25);
    expect(frameP95).toBeLessThanOrEqual(20);
    expect(frameMax).toBeLessThanOrEqual(50);

    await collectGarbage(page, cdp);
    const heapAfter = await usedHeapSize(page, cdp);

    if (heapBefore === null || heapAfter === null) {
      testInfo.annotations.push({
        description:
          "Chromium exposed neither CDP JSHeapUsedSize nor performance.memory; only the heap assertion is unavailable.",
        type: "heap-assertion-unavailable",
      });
    } else {
      expect(heapAfter - heapBefore).toBeLessThanOrEqual(64 * MEBIBYTE);
    }

    testInfo.annotations.push({
      description: JSON.stringify({
        frameMaxMs: rounded(frameMax),
        frameP95Ms: rounded(frameP95),
        heapDeltaMiB:
          heapBefore === null || heapAfter === null
            ? null
            : rounded((heapAfter - heapBefore) / MEBIBYTE),
        layoutMs: rounded(targetLayout!.duration),
        ttiMs: rounded(initialAudit.firstTargetPaintAt!),
      }),
      type: "v3.4-performance-evidence",
    });

    await cdp?.detach();
  });
});

interface TargetScaleHomeFixture {
  concepts: NetworkNode[];
  edges: NetworkEdge[];
  focus: NetworkNode;
  initialEdges: NetworkEdge[];
  nodes: NetworkNode[];
}

interface BrowserDrawSample {
  count: number;
  instanceCount: number | null;
  method:
    | "drawArrays"
    | "drawArraysInstanced"
    | "drawElements"
    | "drawElementsInstanced";
}

interface BrowserPerformanceAudit {
  captureFrames: boolean;
  capturedFrameDurations: number[];
  firstTargetPaintAt: number | null;
  graphFrameCount: number;
  layoutSamples: Array<{ duration: number; edges: number; nodes: number }>;
  targetFrameDraws: BrowserDrawSample[];
}

async function installPerformanceInstrumentation(
  page: Page,
  target: { edges: number; nodes: number },
): Promise<void> {
  await page.addInitScript((targetCounts) => {
    type DrawSample = {
      count: number;
      instanceCount: number | null;
      method:
        | "drawArrays"
        | "drawArraysInstanced"
        | "drawElements"
        | "drawElementsInstanced";
    };
    type Audit = {
      captureFrames: boolean;
      capturedFrameDurations: number[];
      firstTargetPaintAt: number | null;
      graphFrameCount: number;
      layoutSamples: Array<{ duration: number; edges: number; nodes: number }>;
      targetFrameDraws: DrawSample[];
    };
    type InstrumentedWindow = Window & {
      __home3dPerformanceAudit: Audit;
    };

    const audit: Audit = {
      captureFrames: false,
      capturedFrameDurations: [],
      firstTargetPaintAt: null,
      graphFrameCount: 0,
      layoutSamples: [],
      targetFrameDraws: [],
    };
    const instrumentedWindow = window as unknown as InstrumentedWindow;

    instrumentedWindow.__home3dPerformanceAudit = audit;

    const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    let activeFrame: { draws: DrawSample[] } | null = null;

    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      nativeRequestAnimationFrame((time) => {
        const parentFrame = activeFrame;
        const frame = { draws: [] as DrawSample[] };
        const startedAt = performance.now();

        activeFrame = frame;
        try {
          callback(time);
        } finally {
          const duration = performance.now() - startedAt;

          if (frame.draws.length > 0) {
            audit.graphFrameCount += 1;
            if (audit.captureFrames) {
              audit.capturedFrameDurations.push(duration);
            }

            const stage = document.querySelector<HTMLElement>(
              '[aria-label="真实 3D 知识网络"]',
            );
            const targetFrame =
              stage?.dataset.renderer === "webgl2" &&
              Number(stage.dataset.nodeCount) === targetCounts.nodes &&
              Number(stage.dataset.edgeCount) === targetCounts.edges;

            if (targetFrame && audit.firstTargetPaintAt === null) {
              audit.firstTargetPaintAt = performance.now();
              audit.targetFrameDraws = frame.draws.map((draw) => ({ ...draw }));
            }
          }
          activeFrame = parentFrame;
        }
      });

    const recordDraw = (
      context: WebGL2RenderingContext,
      method: DrawSample["method"],
      count: number,
      instanceCount: number | null,
    ) => {
      if (
        activeFrame &&
        context.canvas instanceof HTMLCanvasElement &&
        context.canvas.getAttribute("aria-label") === "真实知识网络 3D 图幅"
      ) {
        activeFrame.draws.push({ count, instanceCount, method });
      }
    };
    const prototype = WebGL2RenderingContext.prototype;
    const drawArrays = prototype.drawArrays;
    const drawElements = prototype.drawElements;
    const drawArraysInstanced = prototype.drawArraysInstanced;
    const drawElementsInstanced = prototype.drawElementsInstanced;

    prototype.drawArrays = function instrumentedDrawArrays(
      mode: number,
      first: number,
      count: number,
    ) {
      recordDraw(this, "drawArrays", count, null);
      return drawArrays.call(this, mode, first, count);
    };
    prototype.drawElements = function instrumentedDrawElements(
      mode: number,
      count: number,
      type: number,
      offset: number,
    ) {
      recordDraw(this, "drawElements", count, null);
      return drawElements.call(this, mode, count, type, offset);
    };
    prototype.drawArraysInstanced = function instrumentedDrawArraysInstanced(
      mode: number,
      first: number,
      count: number,
      instanceCount: number,
    ) {
      recordDraw(this, "drawArraysInstanced", count, instanceCount);
      return drawArraysInstanced.call(this, mode, first, count, instanceCount);
    };
    prototype.drawElementsInstanced = function instrumentedDrawElementsInstanced(
      mode: number,
      count: number,
      type: number,
      offset: number,
      instanceCount: number,
    ) {
      recordDraw(this, "drawElementsInstanced", count, instanceCount);
      return drawElementsInstanced.call(
        this,
        mode,
        count,
        type,
        offset,
        instanceCount,
      );
    };

    const postMessage = Worker.prototype.postMessage;
    const callPostMessage = postMessage as unknown as (
      this: Worker,
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) => void;

    Worker.prototype.postMessage = function instrumentedPostMessage(
      this: Worker,
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as {
        edges?: unknown[];
        nodes?: unknown[];
        type?: unknown;
      };

      if (
        (request.type === "initial" || request.type === "expand") &&
        Array.isArray(request.nodes) &&
        Array.isArray(request.edges)
      ) {
        const startedAt = performance.now();
        const nodes = request.nodes.length;
        const edges = request.edges.length;
        const onMessage = (event: MessageEvent<unknown>) => {
          const response = event.data as { type?: unknown };

          if (response?.type !== "snapshot" && response?.type !== "error") {
            return;
          }

          this.removeEventListener("message", onMessage);
          audit.layoutSamples.push({
            duration: performance.now() - startedAt,
            edges,
            nodes,
          });
        };

        this.addEventListener("message", onMessage);
      }

      return transferOrOptions === undefined
        ? callPostMessage.call(this, message)
        : callPostMessage.call(this, message, transferOrOptions);
    } as typeof Worker.prototype.postMessage;
  }, target);
}

async function installTargetScaleRoutes(
  page: Page,
  fixture: TargetScaleHomeFixture,
): Promise<void> {
  await page.route("**/api/v1/tag-field", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/ai-tasks?**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/concept-candidate-scans?**", async (route) => {
    await route.fulfill({ json: { items: [] } });
  });
  await page.route("**/api/v1/network/subgraph**", async (route) => {
    const root = new URL(route.request().url()).searchParams.get("root");
    const graph: NetworkGraph = {
      edges: root ? fixture.edges : fixture.initialEdges,
      limits: {
        depth: root ? 1 : 0,
        edgeLimit: TARGET_EDGE_COUNT,
        nodeLimit: TARGET_NODE_COUNT,
      },
      nodes: root ? fixture.nodes : fixture.concepts,
      root,
      truncated: false,
      truncation: { edges: false, nodes: false },
    };

    await route.fulfill({ json: graph });
  });
}

async function expectTargetStage(
  page: Page,
  fixture: TargetScaleHomeFixture,
) {
  const stage = page.getByRole("region", { name: "真实 3D 知识网络" });

  await expect(stage).toHaveAttribute("data-renderer", "webgl2");
  await expect(stage).toHaveAttribute(
    "data-node-count",
    String(fixture.nodes.length),
  );
  await expect(stage).toHaveAttribute(
    "data-edge-count",
    String(fixture.edges.length),
  );
  await expect(
    stage.locator('canvas[aria-label="真实知识网络 3D 图幅"]'),
  ).toBeVisible();

  return stage;
}

async function sampleControlledWheelFrames(
  page: Page,
  sampleCount: number,
): Promise<void> {
  await page.evaluate(async (count) => {
    type Audit = {
      captureFrames: boolean;
      capturedFrameDurations: number[];
      graphFrameCount: number;
    };
    const audit = (
      window as unknown as Window & { __home3dPerformanceAudit: Audit }
    ).__home3dPerformanceAudit;
    const canvas = document.querySelector<HTMLCanvasElement>(
      'canvas[aria-label="真实知识网络 3D 图幅"]',
    );

    if (!canvas) {
      throw new Error("The target-scale 3D canvas is unavailable.");
    }

    audit.capturedFrameDurations.length = 0;
    audit.captureFrames = true;

    for (let index = 0; index < count; index += 1) {
      const before = audit.graphFrameCount;

      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: index % 2 === 0 ? 18 : -18,
        }),
      );
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 1_000;
        const poll = () => {
          if (audit.graphFrameCount > before) {
            resolve();
          } else if (performance.now() >= deadline) {
            reject(new Error("A controlled 3D interaction frame did not render."));
          } else {
            window.setTimeout(poll, 4);
          }
        };

        poll();
      });
    }
  }, sampleCount);
}

async function stopFrameCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as Window & {
        __home3dPerformanceAudit: { captureFrames: boolean };
      }
    ).__home3dPerformanceAudit.captureFrames = false;
  });
}

async function readPerformanceAudit(
  page: Page,
): Promise<BrowserPerformanceAudit> {
  return page.evaluate(() => {
    const audit = (
      window as unknown as Window & {
        __home3dPerformanceAudit: BrowserPerformanceAudit;
      }
    ).__home3dPerformanceAudit;

    return {
      ...audit,
      capturedFrameDurations: [...audit.capturedFrameDurations],
      layoutSamples: audit.layoutSamples.map((sample) => ({ ...sample })),
      targetFrameDraws: audit.targetFrameDraws.map((draw) => ({ ...draw })),
    };
  });
}

async function createPerformanceSession(page: Page): Promise<CDPSession | null> {
  try {
    const session = await page.context().newCDPSession(page);

    await session.send("Performance.enable");
    return session;
  } catch {
    return null;
  }
}

async function collectGarbage(
  page: Page,
  session: CDPSession | null,
): Promise<void> {
  if (session) {
    try {
      await session.send("HeapProfiler.collectGarbage");
      return;
    } catch {
      // Fall through to the optional page-level collector.
    }
  }

  await page.evaluate(() => {
    const collect = (window as Window & { gc?: () => void }).gc;

    collect?.();
  });
}

async function usedHeapSize(
  page: Page,
  session: CDPSession | null,
): Promise<number | null> {
  if (session) {
    try {
      const result = await session.send("Performance.getMetrics");
      const used = result.metrics.find(({ name }) => name === "JSHeapUsedSize")
        ?.value;

      if (typeof used === "number") {
        return used;
      }
    } catch {
      // Fall through to performance.memory when CDP metrics are unavailable.
    }
  }

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

function targetScaleHomeNetwork(): TargetScaleHomeFixture {
  const concepts = Array.from({ length: 100 }, (_, index) =>
    conceptNode(index),
  );
  const points = Array.from({ length: 400 }, (_, index) =>
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
  const knowledgeRelations = Array.from({ length: 500 }, (_, index) => {
    const sourceIndex = index % points.length;
    const hop = index < points.length ? 1 : 23;

    return relationEdge(
      "knowledge_relation",
      index,
      points[sourceIndex]!.key,
      points[(sourceIndex + hop) % points.length]!.key,
    );
  });

  return {
    concepts,
    edges: [...memberships, ...conceptRelations, ...knowledgeRelations],
    focus: concepts[0]!,
    initialEdges: conceptRelations,
    nodes: [...concepts, ...points],
  };
}

function conceptNode(index: number): NetworkNode {
  const id = fixtureId("71000000", index);

  return {
    description: `V3.4 性能验收 Concept ${index}`,
    id,
    key: `concept:${id}`,
    label: `性能概念 ${String(index).padStart(3, "0")}`,
    source: {
      kind: "concept_revision",
      revisionId: fixtureId("71100000", index),
      revisionNumber: 1,
    },
    type: "concept",
  };
}

function knowledgePointNode(index: number): NetworkNode {
  const id = fixtureId("72000000", index);

  return {
    description: `V3.4 性能验收 Knowledge Point ${index}`,
    id,
    key: `knowledge_point:${id}`,
    label: `性能知识点 ${String(index).padStart(3, "0")}`,
    source: {
      analysisRevisionId: fixtureId("72400000", index),
      fragmentRevisionId: fixtureId("72300000", index),
      kind: "knowledge_point",
      recordId: fixtureId("72200000", index),
      recordTitle: `性能来源记录 ${String(index).padStart(3, "0")}`,
    },
    type: "knowledge_point",
  };
}

function membershipEdge(
  index: number,
  source: string,
  target: string,
): NetworkEdge {
  const id = fixtureId("73000000", index);

  return {
    confirmation: null,
    description: null,
    directed: false,
    edgeKey: `concept_membership:${id}`,
    kind: "concept_membership",
    relationType: "membership",
    source,
    sourceRecord: {
      createdAt: "2099-08-12T08:00:00.000Z",
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
  const relationNamespace = kind === "concept_relation" ? "74000000" : "75000000";
  const confirmationNamespace = kind === "concept_relation" ? "74100000" : "75100000";
  const id = fixtureId(relationNamespace, index);
  const confirmationId = fixtureId(confirmationNamespace, index);
  const confirmedAt = "2099-08-12T08:00:00.000Z";

  return {
    confirmation: { confirmedAt, id: confirmationId, relationId: id },
    description: "V3.4 目标规模验收使用的已确认真实关系。",
    directed: true,
    edgeKey: `${kind}:${id}`,
    kind,
    relationType: "extends",
    source,
    sourceRecord: {
      confidence: 0.92,
      confirmedAt,
      id: confirmationId,
      kind:
        kind === "concept_relation"
          ? "concept_relation_confirmation"
          : "knowledge_relation_confirmation",
      reason: "V3.4 目标规模性能 fixture。",
      relationId: id,
    },
    target,
  };
}

function fixtureId(namespace: string, index: number): string {
  return `${namespace}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function appUrl(pathname: string): string {
  return new URL(pathname, appBaseUrl).toString();
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
