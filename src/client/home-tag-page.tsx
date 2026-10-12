/*
 * THESIS: Home is one navigable tag atlas with two complete visual worlds, not a card dashboard or a skin-deep recolor.
 * OWN-WORLD: Macaron bubbles and cloud-white paper can switch to the original deep-space neural signal field.
 * STORY: Every durable tag keeps its place and behavior while the user changes the visual language around it.
 * FIRST VIEWPORT: One unbroken 940px field below the shared navigation, with search low-left and reset low-right.
 * FORM: User-approved dual-theme Experience surface; both WebGL renderers preserve the same graph-ready interaction model.
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
import { createTagBubbleField } from "./tag-bubble-field.js";
import { createTagMembraneField } from "./tag-membrane-field.js";
import { tagPathLabel } from "./tag-path.js";
import { useTheme, type AppTheme } from "./theme.js";
import "./home-page.css";
import "./home-tag-page.css";

const DEFAULT_CAMERA: CameraState = { distance: 8.8, pitch: -0.28, yaw: 0.42 };
const CAMERA_STORAGE_KEY = "knowledge.home.camera.v1";

export function TagHomePage() {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [searchParams] = useSearchParams();
  const [tags, setTags] = useState<TagFieldItem[]>([]);
  const [tagFieldStatus, setTagFieldStatus] = useState<
    "failed" | "loading" | "ready"
  >("loading");
  const [query, setQuery] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
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
  const cameraFrameRef = useRef<number | null>(null);
  const pendingCameraRef = useRef<CameraState | null>(null);
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
    webGlFieldRef.current?.setFocusedTag(focusedId);
  }, [focusedId]);

  useEffect(() => () => {
    if (cameraFrameRef.current !== null) {
      window.cancelAnimationFrame(cameraFrameRef.current);
    }
  }, []);

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
            theme,
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
  }, [motionMode, renderBudget, tags, theme]);

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
      item.style.transform = "translate(-50%, -50%)";
      item.style.zIndex = "1";
      button.style.setProperty("--projection-scale", "1");
      button.style.setProperty("--depth-opacity", "1");
      button.style.setProperty("--depth-blur", "0px");
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
      ? tags.filter((tag) =>
          tagPathLabel(tag).toLocaleLowerCase().includes(normalized),
        )
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

      item.style.left = "0";
      item.style.top = "0";
      item.style.transform = `translate3d(${projection.x.toFixed(2)}px, ${projection.y.toFixed(2)}px, 0) translate(-50%, -50%)`;
      item.style.zIndex = String(projection.layer);
      button.style.setProperty(
        "--projection-scale",
        projection.scale.toFixed(3),
      );
      button.style.setProperty(
        "--depth-opacity",
        projection.opacity.toFixed(3),
      );
      button.style.setProperty(
        "--depth-blur",
        `${Math.max(0, (1 - projection.opacity) * 0.82).toFixed(2)}px`,
      );
      button.toggleAttribute("data-behind-camera", !projection.visible);
    }

    if (pointerRef.current) {
      return;
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

  function updateCamera(
    next: CameraState,
    persist = true,
    deferUntilFrame = true,
  ) {
    const camera = clampCamera(next);

    cameraRef.current = camera;
    pendingCameraRef.current = camera;

    if (!deferUntilFrame) {
      if (cameraFrameRef.current !== null) {
        window.cancelAnimationFrame(cameraFrameRef.current);
        cameraFrameRef.current = null;
      }

      pendingCameraRef.current = null;
      publishCamera(camera);
      webGlFieldRef.current?.setCamera(camera);
    } else if (cameraFrameRef.current === null) {
      cameraFrameRef.current = window.requestAnimationFrame(() => {
        cameraFrameRef.current = null;

        const pendingCamera = pendingCameraRef.current;

        if (!pendingCamera) {
          return;
        }

        pendingCameraRef.current = null;
        publishCamera(pendingCamera);
        webGlFieldRef.current?.setCamera(pendingCamera);
      });
    }

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
    event.preventDefault();
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
    }, true, false);
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
      />
      <main aria-label="首页" className="home-main">
        <section
          aria-label={theme === "scifi" ? "神经标签场" : "气泡标签场"}
          className="tag-field"
          data-camera={cameraSignature(cameraRef.current)}
          data-camera-distance={cameraRef.current.distance.toFixed(3)}
          data-camera-pitch={cameraRef.current.pitch.toFixed(3)}
          data-camera-yaw={cameraRef.current.yaw.toFixed(3)}
          data-interaction="idle"
          data-lod={renderBudget.level}
          data-state={`${theme === "scifi" ? "deep-space" : "pastel-space"} ${renderMode} ${motionMode}`}
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
                    aria-label={tagPathLabel(tag)}
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
                    style={nodeStyle(tag, theme)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="tag-node-energy"
                      {...(theme === "scifi"
                        ? { "data-energy-core": "" }
                        : { "data-bubble-core": "" })}
                    >
                      {theme === "scifi" ? (
                        <>
                          <span className="tag-node-branch tag-node-branch-primary" />
                          <span className="tag-node-branch tag-node-branch-secondary" />
                          <span className="tag-node-branch tag-node-branch-tertiary" />
                        </>
                      ) : null}
                      <span
                        className="tag-node-shell"
                        {...(theme === "scifi"
                          ? { "data-node-ring": "" }
                          : { "data-bubble-ring": "" })}
                        data-ring={
                          tag.approval === "approved" ? "complete" : "dashed"
                        }
                      />
                      <span className="tag-node-core" />
                    </span>
                    <strong>{tag.name}</strong>
                  </button>
                </li>
              );
            })}
          </ul>

          {tagFieldStatus === "loading" ? (
            <div className="home-tag-state" role="status">
              <span aria-hidden="true" />
              <strong>正在读取标签场…</strong>
              <p>正在装载已认可标签与 AI 候选。</p>
            </div>
          ) : null}
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
              ? `${tagPathLabel(focused)} · ${focused.approval === "candidate" ? "AI 候选" : "已认可"} · ${focused.recordCount} 条记录（含下级）· 直接关联 ${focused.directRecordCount} 条`
              : theme === "scifi"
                ? "选择一个标签以查看信号信息"
                : "选择一个标签查看记录信息"}
          </p>
          <p className="tag-field-legend">
            {theme === "scifi"
              ? "WebGL 空间场 · 拖拽旋转 · 动态连线不表示标签关系"
              : "WebGL 气泡场 · 拖拽旋转 · 节点位置不表示标签关系"}
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
              updateCamera(DEFAULT_CAMERA, true, false);
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
            aria-controls={
              suggestionsOpen && query.trim()
                ? "home-tag-search-suggestions"
                : undefined
            }
            aria-expanded={Boolean(suggestionsOpen && query.trim())}
            autoComplete="off"
            id="home-search-input"
            onChange={(event) => {
              setQuery(event.target.value);
              setSuggestionsOpen(Boolean(event.target.value.trim()));
            }}
            onFocus={() => {
              if (query.trim()) setSuggestionsOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && suggestionsOpen) {
                event.preventDefault();
                event.stopPropagation();
                setSuggestionsOpen(false);
              }
            }}
            placeholder="定位标签或搜索记录"
            type="search"
            value={query}
          />
          {suggestionsOpen && query.trim() ? (
            <div
              aria-label="搜索建议"
              className="home-search-suggestions"
              id="home-tag-search-suggestions"
              role="region"
            >
              <div aria-label="定位标签" className="suggestion-group" role="group">
                <p aria-hidden="true">定位标签</p>
                {matches.length > 0 ? matches.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      setFocusedId(tag.id);
                      setQuery(tag.name);
                      setSuggestionsOpen(false);
                      webGlFieldRef.current?.focusTag(tag.id);
                    }}
                    type="button"
                  >
                    {tagPathLabel(tag)}
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
  setFocusedTag: (id: string | null) => void;
};

type WebGlTagFieldOptions = {
  initialCamera: CameraState;
  onCameraFrame: (camera: CameraState) => void;
  onProjection: (projections: TagProjection[]) => void;
  reducedMotion: boolean;
  renderBudget: TagFieldRenderBudget;
  shouldAutoRotate: () => boolean;
  theme: AppTheme;
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
    distance: THREE.MathUtils.clamp(camera.distance, 6.2, 12.8),
    pitch: THREE.MathUtils.clamp(camera.pitch, -0.72, 0.72),
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

function nodeStyle(tag: TagFieldItem, theme: AppTheme): NodeCustomProperties {
  return {
    "--node-color": stableNodeColor(tag.id, theme),
    "--node-diameter": `${nodeDiameter(tag.recordCount)}px`,
    "--node-opacity":
      tag.recordCount === 0 ? "0.56" : tag.approval === "candidate" ? "0.82" : "1",
  };
}

function nodeDiameter(recordCount: number): number {
  return Math.min(90, Math.round(44 + Math.log2(recordCount + 1) * 12));
}

function bubbleDiameter(
  recordCount: number,
  renderBudget: TagFieldRenderBudget,
): number {
  const scale = {
    balanced: 0.86,
    compact: 0.72,
    dense: 0.58,
    full: 1,
  }[renderBudget.level];

  return Math.round((nodeDiameter(recordCount) + 18) * scale);
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

function stableNodeColor(id: string, theme: AppTheme): string {
  const palette = theme === "scifi"
    ? ["#39c6ff", "#28e2e8", "#7e74ff", "#aa6cff", "#21c7ad", "#ff986d"]
    : ["#f39bb4", "#c6b5f3", "#b8ddbd", "#ffe29b", "#b8d8f3"];
  const hashKey = theme === "scifi" ? id : `${id}:color`;

  return palette[stableHash(hashKey) % palette.length] ?? palette[0]!;
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
  const sciFi = options.theme === "scifi";
  const fieldBackground = sciFi ? 0x00030b : 0xfff8fb;

  renderer.setClearColor(fieldBackground, 1);
  camera.position.set(0, 0, runtimeCamera.distance);
  camera.lookAt(0, 0, 0);
  nodeGroup.rotation.set(runtimeCamera.pitch, runtimeCamera.yaw, 0.02);
  scene.fog = new THREE.FogExp2(fieldBackground, 0.085);
  scene.add(staticLayer, nodeGroup);

  const ambientDots = createAmbientDotField(
    options.renderBudget.glowTextureSize,
    options.theme,
  );
  const ambientDepth = createAmbientDepthField(
    options.renderBudget.glowTextureSize,
    options.theme,
  );
  const nodeField = sciFi
    ? createTagMembraneField(
        tags.map((tag) => ({
          candidate: tag.approval === "candidate",
          color: stableNodeColor(tag.id, options.theme),
          diameter: bubbleDiameter(tag.recordCount, options.renderBudget),
          id: tag.id,
          opacity:
            tag.recordCount === 0
              ? 0.5
              : tag.approval === "candidate"
                ? 0.82
                : 1,
          phase: stableUnit(`${tag.id}:membrane-phase`) * Math.PI * 2,
          position: stableWorldPosition(tag.id),
        })),
        runtimeCamera.distance,
        Math.min(window.devicePixelRatio || 1, 2),
      )
    : createTagBubbleField(
        tags.map((tag) => ({
          candidate: tag.approval === "candidate",
          color: stableNodeColor(tag.id, options.theme),
          diameter: bubbleDiameter(tag.recordCount, options.renderBudget),
          id: tag.id,
          opacity:
            tag.recordCount === 0
              ? 0.5
              : tag.approval === "candidate"
                ? 0.82
                : 1,
          position: stableWorldPosition(tag.id),
        })),
        runtimeCamera.distance,
        Math.min(window.devicePixelRatio || 1, 2),
      );

  staticLayer.add(ambientDots, ambientDepth);
  nodeGroup.add(nodeField.points);

  const signalTraces = sciFi
    ? createSignalTraces(tags, options.renderBudget)
    : [];

  for (const trace of signalTraces) {
    nodeGroup.add(trace.line, trace.pulse);
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
    nodeField.setViewport(
      runtimeCamera.distance,
      Math.min(window.devicePixelRatio || 1, 2),
    );
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
        (projectedPosition.x * 0.5 + 0.5) * width,
        width * 0.08,
        width * 0.92,
      );
      const y = THREE.MathUtils.clamp(
        (-projectedPosition.y * 0.5 + 0.5) * height,
        height * 0.08,
        height * 0.9,
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
    nodeField.setViewport(
      runtimeCamera.distance,
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  function render(now: number, scheduleNextFrame: boolean) {
    if (disposed) {
      return;
    }

    const deltaSeconds = Math.min(0.05, Math.max(0, now - lastFrameAt) / 1_000);

    lastFrameAt = now;

    const shouldAnimateField = !options.reducedMotion && options.shouldAutoRotate();

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
    } else if (shouldAnimateField) {
      runtimeCamera = {
        ...runtimeCamera,
        yaw: runtimeCamera.yaw + deltaSeconds * 0.018,
      };
    }

    if (!options.reducedMotion) {
      ambientDots.rotation.y -= deltaSeconds * (sciFi ? 0.0025 : 0.0018);
      ambientDepth.rotation.y += deltaSeconds * (sciFi ? 0.004 : 0.0028);

      if (sciFi && shouldAnimateField) {
        signalTraces.forEach((trace, index) => {
          const material = trace.line.material as THREE.LineBasicMaterial;
          const phase = (now / 8_000 + index * 0.27) % 1;
          const active = phase < 0.68;

          material.opacity = active
            ? 0.12 + Math.sin((phase / 0.68) * Math.PI) * 0.3
            : 0.08;
          trace.pulse.visible = active;

          if (active) {
            const point = trace.curve.getPoint(phase / 0.68);
            const position = trace.pulse.geometry.getAttribute("position");

            position.setXYZ(0, point.x, point.y, point.z);
            position.needsUpdate = true;
          }
        });
      } else if (sciFi) {
        for (const trace of signalTraces) {
          trace.pulse.visible = false;
          (trace.line.material as THREE.LineBasicMaterial).opacity = 0.22;
        }
      }
    } else if (sciFi) {
      for (const trace of signalTraces) {
        trace.pulse.visible = false;
        (trace.line.material as THREE.LineBasicMaterial).opacity = 0.22;
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
      nodeField.setFocusedTag(id);
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

      if (options.reducedMotion) {
        render(window.performance.now(), false);
      }
    },
    setFocusedTag(id) {
      nodeField.setFocusedTag(id);
    },
  };
}

function createAmbientDotField(
  glowTextureSize: number,
  theme: AppTheme,
): THREE.Points {
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
    color.set(
      theme === "scifi"
        ? index % 11 === 0
          ? 0x6b63ff
          : index % 7 === 0
            ? 0x18c7d8
            : 0x3f9ee8
        : index % 11 === 0
          ? 0xc6b5f3
          : index % 7 === 0
            ? 0xb8ddbd
            : 0xf39bb4,
    );
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
      size: theme === "scifi" ? 0.052 : 0.045,
      sizeAttenuation: true,
      transparent: true,
      opacity: theme === "scifi" ? 0.74 : 0.42,
      map: createGlowTexture(glowTextureSize),
      vertexColors: true,
      blending: theme === "scifi"
        ? THREE.AdditiveBlending
        : THREE.NormalBlending,
      depthWrite: false,
    }),
  );
}

function createAmbientDepthField(
  glowTextureSize: number,
  theme: AppTheme,
): THREE.Points {
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
    color.set(
      theme === "scifi"
        ? index % 9 === 0
          ? 0x8168ff
          : index % 6 === 0
            ? 0x19d2d5
            : 0x238ed6
        : index % 9 === 0
          ? 0xffe29b
          : index % 6 === 0
            ? 0xb8d8f3
            : 0xc6b5f3,
    );
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
      opacity: theme === "scifi" ? 0.34 : 0.18,
      map: createGlowTexture(glowTextureSize),
      vertexColors: true,
      blending: theme === "scifi"
        ? THREE.AdditiveBlending
        : THREE.NormalBlending,
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

function createSignalTraces(
  tags: TagFieldItem[],
  renderBudget: TagFieldRenderBudget,
): SignalTrace[] {
  if (tags.length < 2) {
    return [];
  }

  const orderedTags = [...tags].sort(
    (left, right) => stableHash(left.id) - stableHash(right.id),
  );
  const curveCount = tags.length === 2
    ? 1
    : Math.min(renderBudget.traceLimit, tags.length * 2);
  const traces: SignalTrace[] = [];
  const pulseTexture = createGlowTexture(renderBudget.glowTextureSize);

  for (let index = 0; index < curveCount; index += 1) {
    const fromTag = orderedTags[index % orderedTags.length]!;
    const offset = index < orderedTags.length
      ? 1
      : 2 + stableHash(`${fromTag.id}:neural-edge:${index}`) % Math.max(1, orderedTags.length - 2);
    const toTag = orderedTags[(index + offset) % orderedTags.length]!;
    const from = stableWorldPosition(fromTag.id);
    const to = stableWorldPosition(toTag.id);
    const middle = from.clone().lerp(to, 0.5);

    middle.y += (stableUnit(`signal:${index}:bend`) - 0.5) * 0.48;
    middle.z += (stableUnit(`signal:${index}:depth`) - 0.5) * 0.36;
    const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    const geometry = new THREE.BufferGeometry().setFromPoints(
      curve.getPoints(renderBudget.traceSegments),
    );
    const line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({
        color: index % 3 === 0 ? 0x5b6cff : 0x1da9d8,
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const pulse = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([from]),
      new THREE.PointsMaterial({
        color: index % 3 === 0 ? 0x9b8cff : 0x75e6ff,
        size: 0.085,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.8,
        map: pulseTexture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    line.renderOrder = 2;
    pulse.renderOrder = 3;
    traces.push({ curve, line, pulse });
  }

  return traces;
}
