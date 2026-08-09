/*
 * THESIS: Home is a navigable signal field, not a decorative dashboard.
 * OWN-WORLD: Deep-space black, cyan orbital geometry, restrained spectral node accents, and a precise HUD.
 * STORY: Every durable tag appears as a stable point; search pulls one signal forward and activation opens its record set.
 * FIRST VIEWPORT: A dark 60px navigation over one unbroken 940px field, with the search HUD low and reset control at right.
 * FORM: Brief-pinned Experience surface; depth-first orbital field, with no concept seed required.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import * as THREE from "three";

import {
  getTagFieldRenderBudget,
  type TagFieldRenderBudget,
} from "../domain/tag-field-lod.js";
import { getTagField, type TagFieldItem } from "./api.js";
import { NewRecordDialog } from "./new-record-dialog.js";
import { AppNavigation } from "./records-page.js";
import "./home-page.css";

const DEFAULT_CAMERA: CameraState = { distance: 8.2, pitch: -0.12, yaw: 0.3 };
const CAMERA_STORAGE_KEY = "knowledge.home.camera.v1";

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tags, setTags] = useState<TagFieldItem[]>([]);
  const [tagFieldStatus, setTagFieldStatus] = useState<
    "failed" | "loading" | "ready"
  >("loading");
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renderMode, setRenderMode] = useState<"webgl2" | "dom-2d">("dom-2d");
  const [motionMode, setMotionMode] = useState<"static-motion" | "live-motion">(
    "static-motion",
  );
  const [newRecordOpen, setNewRecordOpen] = useState(false);
  const requestedTagId = searchParams.get("tag");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStatusRef = useRef<HTMLOutputElement>(null);
  const cameraRef = useRef<CameraState>(readStoredCamera());
  const fieldRef = useRef<HTMLElement>(null);
  const focusedIdRef = useRef<string | null>(null);
  const newRecordButton = useRef<HTMLButtonElement>(null);
  const pointerRef = useRef<PointerDrag | null>(null);
  const tagNodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const webGlFieldRef = useRef<WebGlTagField | null>(null);
  const renderBudget = useMemo(
    () => getTagFieldRenderBudget(tags.length),
    [tags.length],
  );

  useEffect(() => {
    let active = true;

    void getTagField()
      .then((items) => {
        if (active) {
          setTags(items);
          setTagFieldStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setTagFieldStatus("failed");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");

    function updateMotionMode() {
      setMotionMode(preference.matches ? "static-motion" : "live-motion");
    }

    updateMotionMode();
    preference.addEventListener("change", updateMotionMode);

    return () => preference.removeEventListener("change", updateMotionMode);
  }, []);

  useEffect(() => {
    let scene: WebGlTagField | null = null;

    const canvas = canvasRef.current;
    const reducedMotion = motionMode === "static-motion";

    if (canvas) {
      const context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true,
        powerPreference: "high-performance",
      });

      if (context) {
        try {
          scene = createWebGlTagField(canvas, context, tags, {
            initialCamera: cameraRef.current,
            onCameraFrame: publishCamera,
            onProjection: applyNodeProjections,
            reducedMotion,
            renderBudget,
            shouldAutoRotate: () =>
              pointerRef.current === null &&
              focusedIdRef.current === null &&
              !tagNodeRefs.current.has(
                (document.activeElement as HTMLElement | null)?.dataset.tagId ?? "",
              ),
          });
          webGlFieldRef.current = scene;
          setRenderMode("webgl2");
        } catch {
          setRenderMode("dom-2d");
        }
      } else {
        setRenderMode("dom-2d");
      }
    }

    function handleContextLost(event: Event) {
      event.preventDefault();
      if (scene) {
        cameraRef.current = scene.getCamera();
        storeCamera(cameraRef.current);
      }
      scene?.dispose();
      scene = null;
      webGlFieldRef.current = null;
      setRenderMode("dom-2d");
    }

    canvas?.addEventListener("webglcontextlost", handleContextLost);

    return () => {
      canvas?.removeEventListener("webglcontextlost", handleContextLost);
      if (scene) {
        cameraRef.current = scene.getCamera();
        storeCamera(cameraRef.current);
      }
      scene?.dispose();
      if (webGlFieldRef.current === scene) {
        webGlFieldRef.current = null;
      }
    };
  }, [motionMode, renderBudget, tags]);

  useEffect(() => {
    if (renderMode !== "dom-2d") {
      return;
    }

    for (const tag of tags) {
      const button = tagNodeRefs.current.get(tag.id);
      const item = button?.parentElement;
      const position = stablePosition(tag.id);

      if (!button || !item) {
        continue;
      }

      item.style.left = `${position.x}%`;
      item.style.top = `${position.y}%`;
      item.style.zIndex = "1";
      button.style.setProperty("--projection-scale", "1");
      button.style.setProperty("--depth-opacity", "1");
      button.removeAttribute("data-behind-camera");
    }
  }, [renderMode, tags]);

  useEffect(() => {
    const requestedTag = tags.find((tag) => tag.id === requestedTagId);

    if (!requestedTag) {
      return;
    }

    setFocusedId(requestedTag.id);
    setQuery(requestedTag.name);
    webGlFieldRef.current?.focusTag(requestedTag.id);
  }, [renderMode, requestedTagId, tags]);

  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();

    return normalized
      ? tags.filter((tag) => tag.name.toLocaleLowerCase().includes(normalized))
      : [];
  }, [query, tags]);
  const focused = tags.find((tag) => tag.id === focusedId) ?? null;

  function openTag(tag: TagFieldItem) {
    const search = new URLSearchParams({ tag: tag.id });
    void navigate(`/search?${search.toString()}`);
  }

  function publishCamera(camera: CameraState) {
    cameraRef.current = camera;
    const signature = cameraSignature(camera);

    fieldRef.current?.setAttribute("data-camera", signature);
    fieldRef.current?.setAttribute("data-camera-yaw", camera.yaw.toFixed(3));
    fieldRef.current?.setAttribute("data-camera-pitch", camera.pitch.toFixed(3));
    fieldRef.current?.setAttribute(
      "data-camera-distance",
      camera.distance.toFixed(3),
    );

    if (cameraStatusRef.current) {
      cameraStatusRef.current.value = `水平 ${camera.yaw.toFixed(2)}，俯仰 ${camera.pitch.toFixed(2)}，距离 ${camera.distance.toFixed(2)}`;
    }
  }

  function applyNodeProjections(projections: TagProjection[]) {
    for (const projection of projections) {
      const button = tagNodeRefs.current.get(projection.id);
      const item = button?.parentElement;

      if (!button || !item) {
        continue;
      }

      item.style.left = `${projection.x.toFixed(3)}%`;
      item.style.top = `${projection.y.toFixed(3)}%`;
      item.style.zIndex = String(projection.layer);
      button.style.setProperty(
        "--projection-scale",
        projection.scale.toFixed(3),
      );
      button.style.setProperty(
        "--depth-opacity",
        projection.opacity.toFixed(3),
      );
      button.toggleAttribute("data-behind-camera", !projection.visible);
    }

    const occupiedLabels: Array<{
      bottom: number;
      left: number;
      right: number;
      top: number;
    }> = [];

    for (const projection of [...projections].sort(
      (left, right) => right.scale - left.scale,
    )) {
      const button = tagNodeRefs.current.get(projection.id);

      if (!button) {
        continue;
      }

      const label = button.querySelector("strong");
      const focused = focusedIdRef.current === projection.id;

      if (!label || (!focused && button.dataset.label === "lod-hidden")) {
        button.removeAttribute("data-label-collision");
        continue;
      }

      const rect = label.getBoundingClientRect();
      const labelBounds = {
        bottom: rect.bottom + 3,
        left: rect.left - 3,
        right: rect.right + 3,
        top: rect.top - 3,
      };
      const collides = occupiedLabels.some(
        (placed) =>
          labelBounds.left < placed.right &&
          labelBounds.right > placed.left &&
          labelBounds.top < placed.bottom &&
          labelBounds.bottom > placed.top,
      );
      const hideForCollision = collides && !focused;

      button.toggleAttribute("data-label-collision", hideForCollision);

      if (!hideForCollision) {
        occupiedLabels.push(labelBounds);
      }
    }
  }

  function updateCamera(next: CameraState, persist = true) {
    const camera = clampCamera(next);

    cameraRef.current = camera;
    publishCamera(camera);
    webGlFieldRef.current?.setCamera(camera);

    if (persist) {
      storeCamera(camera);
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLElement>) {
    if (
      renderMode !== "webgl2" ||
      (event.target as HTMLElement).closest("button, input, form")
    ) {
      return;
    }

    pointerRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.interaction = "dragging";
  }

  function handlePointerMove(event: React.PointerEvent<HTMLElement>) {
    const pointer = pointerRef.current;

    if (!pointer || pointer.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - pointer.x;
    const deltaY = event.clientY - pointer.y;

    pointer.x = event.clientX;
    pointer.y = event.clientY;
    updateCamera(
      {
        ...cameraRef.current,
        pitch: cameraRef.current.pitch + deltaY * 0.004,
        yaw: cameraRef.current.yaw + deltaX * 0.005,
      },
      false,
    );
  }

  function finishPointerInteraction(event: React.PointerEvent<HTMLElement>) {
    if (pointerRef.current?.pointerId !== event.pointerId) {
      return;
    }

    pointerRef.current = null;
    event.currentTarget.dataset.interaction = "idle";
    storeCamera(cameraRef.current);
  }

  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    if (renderMode !== "webgl2") {
      return;
    }

    event.preventDefault();
    updateCamera({
      ...cameraRef.current,
      distance: cameraRef.current.distance + event.deltaY * 0.006,
    });
  }

  function handleSaved() {
    setNewRecordOpen(false);
    void getTagField()
      .then((items) => {
        setTags(items);
        setTagFieldStatus("ready");
      })
      .catch(() => setTagFieldStatus("failed"));
    window.requestAnimationFrame(() => newRecordButton.current?.focus());
  }

  return (
    <div className="home-shell">
      <AppNavigation
        newRecordButton={newRecordButton}
        onCreate={() => setNewRecordOpen(true)}
        theme="dark"
      />
      <main aria-label="首页" className="home-main">
        <section
          aria-label="神经标签场"
          className="tag-field"
          data-camera={cameraSignature(cameraRef.current)}
          data-camera-distance={cameraRef.current.distance.toFixed(3)}
          data-camera-pitch={cameraRef.current.pitch.toFixed(3)}
          data-camera-yaw={cameraRef.current.yaw.toFixed(3)}
          data-interaction="idle"
          data-lod={renderBudget.level}
          data-state={`deep-space ${renderMode} ${motionMode}`}
          onPointerCancel={finishPointerInteraction}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onWheel={handleWheel}
          ref={fieldRef}
        >
          <canvas aria-hidden="true" className="tag-field-canvas" ref={canvasRef} />
          <ul aria-label="全部标签" className="tag-node-list">
            {tags.map((tag) => {
              const position = stablePosition(tag.id);
              const focusedState = tag.id === focusedId ? " focused" : "";
              const labelHidden = shouldHideNodeLabel(
                tag.id,
                tags.length,
                renderBudget,
                tag.id === focusedId,
              );

              return (
                <li
                  key={tag.id}
                  style={{ left: `${position.x}%`, top: `${position.y}%` }}
                >
                  <button
                    aria-label={tag.name}
                    data-state={`${tag.approval} ${
                      tag.approval === "approved" ? "complete-ring" : "dashed-ring"
                    }${focusedState}`}
                    data-label={labelHidden ? "lod-hidden" : "visible"}
                    data-tag-id={tag.id}
                    onClick={() => openTag(tag)}
                    onBlur={() => {
                      setFocusedId((current) =>
                        current === tag.id ? null : current,
                      );
                    }}
                    onFocus={() => setFocusedId(tag.id)}
                    onMouseEnter={() => setFocusedId(tag.id)}
                    onMouseLeave={() => {
                      if (document.activeElement !== tagNodeRefs.current.get(tag.id)) {
                        setFocusedId((current) =>
                          current === tag.id ? null : current,
                        );
                      }
                    }}
                    ref={(node) => {
                      if (node) {
                        tagNodeRefs.current.set(tag.id, node);
                      } else {
                        tagNodeRefs.current.delete(tag.id);
                      }
                    }}
                    style={nodeStyle(tag)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="tag-node-energy"
                      data-energy-core=""
                    >
                      <span className="tag-node-shell" />
                      <span className="tag-node-core" />
                      <span
                        className="tag-node-orbit tag-node-orbit-primary"
                        data-orbit-ring=""
                        data-ring={
                          tag.approval === "approved" ? "complete" : "dashed"
                        }
                      />
                      <span className="tag-node-orbit tag-node-orbit-secondary" />
                    </span>
                    <strong>{tag.name}</strong>
                  </button>
                </li>
              );
            })}
          </ul>

          {tagFieldStatus === "ready" && tags.length === 0 ? (
            <div className="home-empty-state" role="status">
              <button
                aria-label="新建第一条记录"
                className="first-node-action"
                onClick={() => setNewRecordOpen(true)}
                type="button"
              >
                <span aria-hidden="true" className="first-node-core" />
              </button>
              <p>记录第一条知识，让网络开始生长</p>
              <button
                className="first-record-button"
                onClick={() => setNewRecordOpen(true)}
                type="button"
              >
                新建第一条记录
              </button>
            </div>
          ) : null}
          {tagFieldStatus === "failed" ? (
            <p className="home-field-error" role="alert">
              标签场暂时无法载入，请稍后刷新。
            </p>
          ) : null}

          {renderMode === "dom-2d" ? (
            <p aria-label="渲染模式" className="render-mode-status" role="status">
              WebGL2 不可用，正在使用简化视图
            </p>
          ) : null}
          <p
            aria-label="标签焦点信息"
            className="tag-focus-status"
            data-active={focused ? "true" : "false"}
            role="status"
          >
            {focused
              ? `${focused.name} · ${focused.approval === "candidate" ? "AI 候选" : "已认可"} · ${focused.recordCount} 条记录`
              : "选择一个标签以查看信号信息"}
          </p>
          <output
            aria-label="镜头状态"
            className="camera-status visually-hidden"
            ref={cameraStatusRef}
          >
            {`水平 ${cameraRef.current.yaw.toFixed(2)}，俯仰 ${cameraRef.current.pitch.toFixed(2)}，距离 ${cameraRef.current.distance.toFixed(2)}`}
          </output>
          <button
            className="reset-tag-field"
            onClick={() => {
              setFocusedId(null);
              setQuery("");
              updateCamera(DEFAULT_CAMERA);
            }}
            type="button"
          >
            重置视角
          </button>
        </section>

        <form
          aria-label="首页搜索"
          className="home-search-hud"
          onSubmit={(event) => {
            event.preventDefault();
            const normalized = query.trim();

            if (normalized) {
              const search = new URLSearchParams({ q: normalized });
              void navigate(`/search?${search.toString()}`);
            }
          }}
          role="search"
        >
          <label htmlFor="home-search-input">定位标签或搜索记录</label>
          <input
            autoComplete="off"
            id="home-search-input"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="定位标签或搜索记录"
            type="search"
            value={query}
          />
          {query.trim() ? (
            <div
              aria-label="搜索建议"
              className="home-search-suggestions"
              role="listbox"
            >
              <div aria-label="定位标签" className="suggestion-group" role="group">
                <p aria-hidden="true">定位标签</p>
                {matches.length > 0 ? matches.map((tag) => (
                  <button
                    aria-selected={focusedId === tag.id}
                    key={tag.id}
                    onClick={() => {
                      setFocusedId(tag.id);
                      setQuery(tag.name);
                      webGlFieldRef.current?.focusTag(tag.id);
                    }}
                    role="option"
                    type="button"
                  >
                    {tag.name}
                  </button>
                )) : <span className="suggestion-empty">没有匹配标签</span>}
              </div>
              <div aria-label="搜索记录" className="suggestion-group" role="group">
                <p aria-hidden="true">搜索记录</p>
                <button
                  onClick={() => {
                    const search = new URLSearchParams({ q: query.trim() });
                    void navigate(`/search?${search.toString()}`);
                  }}
                  role="option"
                  type="button"
                >
                  搜索记录“{query.trim()}”
                </button>
              </div>
            </div>
          ) : null}
        </form>
      </main>

      <NewRecordDialog
        onClose={() => {
          setNewRecordOpen(false);
          window.requestAnimationFrame(() => newRecordButton.current?.focus());
        }}
        onSaved={handleSaved}
        open={newRecordOpen}
      />
    </div>
  );
}

type CameraState = {
  distance: number;
  pitch: number;
  yaw: number;
};

type PointerDrag = {
  pointerId: number;
  x: number;
  y: number;
};

type TagProjection = {
  id: string;
  layer: number;
  opacity: number;
  scale: number;
  visible: boolean;
  x: number;
  y: number;
};

type WebGlTagField = {
  dispose: () => void;
  focusTag: (id: string) => void;
  getCamera: () => CameraState;
  setCamera: (camera: CameraState) => void;
};

type WebGlTagFieldOptions = {
  initialCamera: CameraState;
  onCameraFrame: (camera: CameraState) => void;
  onProjection: (projections: TagProjection[]) => void;
  reducedMotion: boolean;
  renderBudget: TagFieldRenderBudget;
  shouldAutoRotate: () => boolean;
};

type SignalTrace = {
  curve: THREE.QuadraticBezierCurve3;
  line: THREE.Line;
  pulse: THREE.Points;
};

function stablePosition(id: string): { x: number; y: number } {
  return {
    x: 10 + (stableHash(`${id}:fallback-x`) % 8_000) / 100,
    y: 10 + (stableHash(`${id}:fallback-y`) % 7_800) / 100,
  };
}

function cameraSignature(camera: CameraState): string {
  return `${camera.yaw.toFixed(3)}|${camera.pitch.toFixed(3)}|${camera.distance.toFixed(3)}`;
}

function clampCamera(camera: CameraState): CameraState {
  return {
    distance: THREE.MathUtils.clamp(camera.distance, 4.8, 11.2),
    pitch: THREE.MathUtils.clamp(camera.pitch, -0.68, 0.68),
    yaw: camera.yaw,
  };
}

function readStoredCamera(): CameraState {
  try {
    const stored = window.sessionStorage.getItem(CAMERA_STORAGE_KEY);

    if (!stored) {
      return { ...DEFAULT_CAMERA };
    }

    const candidate = JSON.parse(stored) as Partial<CameraState>;

    if (
      typeof candidate.distance !== "number" ||
      typeof candidate.pitch !== "number" ||
      typeof candidate.yaw !== "number" ||
      !Number.isFinite(candidate.distance) ||
      !Number.isFinite(candidate.pitch) ||
      !Number.isFinite(candidate.yaw)
    ) {
      return { ...DEFAULT_CAMERA };
    }

    return clampCamera(candidate as CameraState);
  } catch {
    return { ...DEFAULT_CAMERA };
  }
}

function storeCamera(camera: CameraState) {
  try {
    window.sessionStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(camera));
  } catch {
    // A blocked session store must not make the visual entry point unusable.
  }
}

type NodeCustomProperties = React.CSSProperties & {
  "--node-color": string;
  "--node-diameter": string;
  "--node-opacity": string;
};

function nodeStyle(tag: TagFieldItem): NodeCustomProperties {
  return {
    "--node-color": stableNodeColor(tag.id),
    "--node-diameter": `${nodeDiameter(tag.recordCount)}px`,
    "--node-opacity":
      tag.recordCount === 0 ? "0.56" : tag.approval === "candidate" ? "0.82" : "1",
  };
}

function nodeDiameter(recordCount: number): number {
  return Math.min(112, Math.round(48 + Math.log2(recordCount + 1) * 16));
}

function shouldHideNodeLabel(
  id: string,
  tagCount: number,
  renderBudget: TagFieldRenderBudget,
  focused: boolean,
): boolean {
  if (focused || tagCount <= renderBudget.labelTarget) {
    return false;
  }

  const stride = Math.max(
    2,
    Math.ceil(tagCount / renderBudget.labelTarget),
  );

  return stableHash(id) % stride !== 0;
}

function stableNodeColor(id: string): string {
  const palette = ["#39c6ff", "#28e2e8", "#7e74ff", "#aa6cff", "#21c7ad", "#ff986d"];

  return palette[stableHash(id) % palette.length] ?? palette[0]!;
}

function stableHash(value: string): number {
  let hash = 2166136261;

  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function stableWorldPosition(id: string): THREE.Vector3 {
  return new THREE.Vector3(
    (stableUnit(`${id}:world-x`) - 0.5) * 8.15,
    (stableUnit(`${id}:world-y`) - 0.5) * 5.35,
    (stableUnit(`${id}:world-z`) - 0.5) * 5.1,
  );
}

function stableUnit(value: string): number {
  let mixed = stableHash(value);

  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;

  return (mixed >>> 0) / 0xffffffff;
}

function createWebGlTagField(
  canvas: HTMLCanvasElement,
  context: WebGL2RenderingContext,
  tags: TagFieldItem[],
  options: WebGlTagFieldOptions,
): WebGlTagField {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    context,
    antialias: true,
    powerPreference: "high-performance",
  });
  let width = Math.max(1, canvas.clientWidth);
  let height = Math.max(1, canvas.clientHeight);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 40);
  const nodeGroup = new THREE.Group();
  const staticLayer = new THREE.Group();
  const projectedPosition = new THREE.Vector3();
  const worldPosition = new THREE.Vector3();
  let runtimeCamera = clampCamera(options.initialCamera);
  let animationFrame = 0;
  let disposed = false;
  let lastFrameAt = window.performance.now();
  let lastProjectionAt = Number.NEGATIVE_INFINITY;
  let focusAnimation: null | {
    duration: number;
    from: CameraState;
    startedAt: number;
    to: CameraState;
  } = null;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x00030b, 1);
  camera.position.set(0, 0, runtimeCamera.distance);
  camera.lookAt(0, 0, 0);
  nodeGroup.rotation.set(runtimeCamera.pitch, runtimeCamera.yaw, 0.02);
  scene.fog = new THREE.FogExp2(0x00030b, 0.085);
  scene.add(staticLayer, nodeGroup);

  const starField = createStarField(options.renderBudget.glowTextureSize);
  const dustField = createDustField(options.renderBudget.glowTextureSize);

  staticLayer.add(starField, dustField);

  for (const mesh of createInstancedTagEnergy(tags, options.renderBudget)) {
    nodeGroup.add(mesh);
  }

  const signalTraces = createSignalTraces(tags, options.renderBudget);

  for (const trace of signalTraces) {
    staticLayer.add(trace.line, trace.pulse);
  }

  function resizeRendererIfNeeded() {
    const nextWidth = Math.max(1, canvas.clientWidth);
    const nextHeight = Math.max(1, canvas.clientHeight);

    if (nextWidth === width && nextHeight === height) {
      return;
    }

    width = nextWidth;
    height = nextHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function projectTagNodes(now: number, force = false) {
    if (!force && now - lastProjectionAt < 32) {
      return;
    }

    lastProjectionAt = now;
    nodeGroup.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    const projections: TagProjection[] = [];

    for (const tag of tags) {
      worldPosition
        .copy(stableWorldPosition(tag.id))
        .applyMatrix4(nodeGroup.matrixWorld);
      projectedPosition.copy(worldPosition).project(camera);

      const depth = Math.max(1, camera.position.distanceTo(worldPosition));
      const scale = THREE.MathUtils.clamp(8.2 / depth, 0.64, 1.38);
      const visible =
        projectedPosition.z >= -1 &&
        projectedPosition.z <= 1;
      const x = THREE.MathUtils.clamp(
        (projectedPosition.x * 0.5 + 0.5) * 100,
        8,
        92,
      );
      const y = THREE.MathUtils.clamp(
        (-projectedPosition.y * 0.5 + 0.5) * 100,
        8,
        90,
      );

      projections.push({
        id: tag.id,
        layer: Math.round(200 - depth * 10),
        opacity: visible
          ? THREE.MathUtils.clamp(1.28 - depth / 13, 0.4, 1)
          : 0,
        scale,
        visible,
        x,
        y,
      });
    }

    options.onProjection(projections);
  }

  function applyRuntimeCamera() {
    nodeGroup.rotation.set(runtimeCamera.pitch, runtimeCamera.yaw, 0.02);
    camera.position.z = runtimeCamera.distance;
    camera.updateProjectionMatrix();
  }

  function render(now: number, scheduleNextFrame: boolean) {
    if (disposed) {
      return;
    }

    const deltaSeconds = Math.min(0.05, Math.max(0, now - lastFrameAt) / 1_000);

    lastFrameAt = now;

    if (focusAnimation) {
      const elapsed = now - focusAnimation.startedAt;
      const progress = focusAnimation.duration === 0
        ? 1
        : THREE.MathUtils.clamp(elapsed / focusAnimation.duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 4);

      runtimeCamera = {
        distance: THREE.MathUtils.lerp(
          focusAnimation.from.distance,
          focusAnimation.to.distance,
          eased,
        ),
        pitch: THREE.MathUtils.lerp(
          focusAnimation.from.pitch,
          focusAnimation.to.pitch,
          eased,
        ),
        yaw: THREE.MathUtils.lerp(
          focusAnimation.from.yaw,
          focusAnimation.to.yaw,
          eased,
        ),
      };

      if (progress === 1) {
        focusAnimation = null;
      }
    } else if (!options.reducedMotion && options.shouldAutoRotate()) {
      runtimeCamera = {
        ...runtimeCamera,
        yaw: runtimeCamera.yaw + deltaSeconds * 0.018,
      };
    }

    if (!options.reducedMotion) {
      starField.rotation.y -= deltaSeconds * 0.0025;
      dustField.rotation.y += deltaSeconds * 0.004;
      signalTraces.forEach((trace, index) => {
        const material = trace.line.material as THREE.LineBasicMaterial;
        const phase = (now / 8_000 + index * 0.27) % 1;
        const active = phase < 0.68;

        material.opacity = active
          ? Math.sin((phase / 0.68) * Math.PI) * 0.2
          : 0;
        trace.pulse.visible = active;

        if (active) {
          const point = trace.curve.getPoint(phase / 0.68);
          const position = trace.pulse.geometry.getAttribute("position");

          position.setXYZ(0, point.x, point.y, point.z);
          position.needsUpdate = true;
        }
      });
    } else {
      for (const trace of signalTraces) {
        trace.pulse.visible = false;
        (trace.line.material as THREE.LineBasicMaterial).opacity = 0.055;
      }
    }

    resizeRendererIfNeeded();
    applyRuntimeCamera();
    renderer.render(scene, camera);
    projectTagNodes(now, !scheduleNextFrame);
    options.onCameraFrame({ ...runtimeCamera });

    if (scheduleNextFrame) {
      animationFrame = window.requestAnimationFrame((time) => render(time, true));
    }
  }

  render(lastFrameAt, false);

  if (!options.reducedMotion) {
    animationFrame = window.requestAnimationFrame((time) => render(time, true));
  }

  return {
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];

          for (const material of materials) {
            if (material instanceof THREE.PointsMaterial) {
              material.map?.dispose();
            }
            material.dispose();
          }
        }
      });
      renderer.dispose();
    },
    focusTag(id) {
      const point = stableWorldPosition(id);
      const horizontal = Math.hypot(point.x, point.z);
      const target = clampCamera({
        distance: Math.min(runtimeCamera.distance, 7.2),
        pitch: Math.atan2(point.y, horizontal),
        yaw: -Math.atan2(point.x, point.z),
      });

      focusAnimation = {
        duration: options.reducedMotion ? 0 : 560,
        from: { ...runtimeCamera },
        startedAt: window.performance.now(),
        to: target,
      };

      if (options.reducedMotion) {
        render(window.performance.now(), false);
      }
    },
    getCamera() {
      return { ...runtimeCamera };
    },
    setCamera(nextCamera) {
      runtimeCamera = clampCamera(nextCamera);
      focusAnimation = null;
      render(window.performance.now(), false);
    },
  };
}

function createStarField(glowTextureSize: number): THREE.Points {
  const count = 420;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let index = 0; index < count; index += 1) {
    const seed = stableHash(`star:${index}`);
    const depth = ((seed >>> 4) % 1_000) / 1_000;
    positions[index * 3] = (((seed % 10_000) / 10_000) - 0.5) * 15;
    positions[index * 3 + 1] =
      ((((stableHash(`star-y:${index}`) % 10_000) / 10_000) - 0.5) * 9.5);
    positions[index * 3 + 2] = -2 - depth * 14;
    color.set(index % 11 === 0 ? 0x6b63ff : index % 7 === 0 ? 0x18c7d8 : 0x3f9ee8);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.052,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.74,
      map: createGlowTexture(glowTextureSize),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function createDustField(glowTextureSize: number): THREE.Points {
  const count = 96;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let index = 0; index < count; index += 1) {
    const xSeed = stableHash(`dust-x:${index}`);
    const ySeed = stableHash(`dust-y:${index}`);
    const zSeed = stableHash(`dust-z:${index}`);

    positions[index * 3] = ((xSeed % 10_000) / 10_000 - 0.5) * 13;
    positions[index * 3 + 1] = ((ySeed % 10_000) / 10_000 - 0.5) * 8;
    positions[index * 3 + 2] = -1 - ((zSeed % 10_000) / 10_000) * 10;
    color.set(index % 9 === 0 ? 0x8168ff : index % 6 === 0 ? 0x19d2d5 : 0x238ed6);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.18,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.34,
      map: createGlowTexture(glowTextureSize),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
}

function createGlowTexture(size: number): THREE.CanvasTexture {
  const textureCanvas = document.createElement("canvas");

  textureCanvas.width = size;
  textureCanvas.height = size;

  const context = textureCanvas.getContext("2d");

  if (context) {
    const center = size / 2;
    const glow = context.createRadialGradient(
      center,
      center,
      0,
      center,
      center,
      center - 1,
    );

    glow.addColorStop(0, "rgba(255, 255, 255, 1)");
    glow.addColorStop(0.14, "rgba(255, 255, 255, 0.82)");
    glow.addColorStop(0.46, "rgba(255, 255, 255, 0.2)");
    glow.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = glow;
    context.fillRect(0, 0, size, size);
  }

  const texture = new THREE.CanvasTexture(textureCanvas);

  texture.colorSpace = THREE.SRGBColorSpace;

  return texture;
}

function createInstancedTagEnergy(
  tags: TagFieldItem[],
  renderBudget: TagFieldRenderBudget,
): THREE.InstancedMesh[] {
  if (tags.length === 0) {
    return [];
  }

  const { height: heightSegments, width: widthSegments } =
    renderBudget.sphereSegments;
  const shell = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, widthSegments, heightSegments),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: renderBudget.energyOpacity.shell,
      wireframe: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    tags.length,
  );
  const core = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, widthSegments, heightSegments),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: renderBudget.energyOpacity.core,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    tags.length,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();

  tags.forEach((tag, index) => {
    const radius = 0.12 + (nodeDiameter(tag.recordCount) - 42) / 240;
    const brightness = tag.recordCount === 0
      ? 0.46
      : tag.approval === "candidate"
        ? 0.72
        : 1;

    color.set(stableNodeColor(tag.id)).multiplyScalar(brightness);
    scale.setScalar(radius);
    matrix.compose(stableWorldPosition(tag.id), quaternion, scale);
    shell.setMatrixAt(index, matrix);
    shell.setColorAt(index, color);

    scale.setScalar(radius * 0.44);
    matrix.compose(stableWorldPosition(tag.id), quaternion, scale);
    core.setMatrixAt(index, matrix);
    core.setColorAt(index, color);
  });

  shell.instanceMatrix.needsUpdate = true;
  core.instanceMatrix.needsUpdate = true;

  if (shell.instanceColor) {
    shell.instanceColor.needsUpdate = true;
  }

  if (core.instanceColor) {
    core.instanceColor.needsUpdate = true;
  }

  return [shell, core];
}

function createSignalTraces(
  tags: TagFieldItem[],
  renderBudget: TagFieldRenderBudget,
): SignalTrace[] {
  if (tags.length < 2) {
    return [];
  }

  const curveCount = Math.min(
    renderBudget.traceLimit,
    Math.max(1, Math.floor(tags.length / 3)),
  );
  const traces: SignalTrace[] = [];

  for (let index = 0; index < curveCount; index += 1) {
    const from = new THREE.Vector3(
      (stableUnit(`signal:${index}:x`) - 0.5) * 6.2,
      (stableUnit(`signal:${index}:y`) - 0.5) * 4.1,
      (stableUnit(`signal:${index}:z`) - 0.5) * 4.2,
    );
    const to = from.clone().add(
      new THREE.Vector3(
        (stableUnit(`signal:${index}:dx`) - 0.5) * 2.2,
        (stableUnit(`signal:${index}:dy`) - 0.5) * 1.5,
        (stableUnit(`signal:${index}:dz`) - 0.5) * 1.8,
      ),
    );
    const middle = from.clone().lerp(to, 0.5);

    middle.y += (stableUnit(`signal:${index}:bend`) - 0.5) * 1.1;
    const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    const geometry = new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(renderBudget.traceSegments),
    );
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color: index % 2 === 0 ? 0x268bdc : 0x765cf4,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const pulse = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([from]),
      new THREE.PointsMaterial({
        color: index % 2 === 0 ? 0x6bd8ff : 0x9b83ff,
        size: 0.11,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.8,
        map: createGlowTexture(renderBudget.glowTextureSize),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    traces.push({ curve, line, pulse });
  }

  return traces;
}
