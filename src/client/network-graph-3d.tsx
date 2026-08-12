import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import * as THREE from "three";

import type { NetworkEdge, NetworkNode } from "./api.js";
import type { NetworkLayoutSnapshot } from "./network-layout.js";
import {
  NETWORK_GRAPH_3D_BUDGET,
  NETWORK_GRAPH_3D_LABEL_BUDGET,
  buildNetworkGraph3DRenderModel,
  createDemandRenderScheduler,
  createNetworkResourceRegistry,
  networkGraph3DLabelNodes,
  placeNetworkGraph3DLabels,
  resolveNetworkCameraUpdate,
  type NetworkGraph3DLabelPriority,
  type NetworkGraph3DProjectedLabel,
  type NetworkGraph3DRenderEdge,
  type NetworkGraph3DRenderModel,
  type NetworkGraph3DRenderNode,
  type NetworkResourceRegistry,
} from "./network-graph-3d-model.js";
import type { AppTheme } from "./theme.js";

export {
  NETWORK_GRAPH_3D_BUDGET,
  NETWORK_GRAPH_3D_LABEL_BUDGET,
  buildNetworkGraph3DRenderModel,
  createDemandRenderScheduler,
  createNetworkResourceRegistry,
  networkGraph3DLabelNodes,
  networkDepthV1,
  placeNetworkGraph3DLabels,
  resolveNetworkCameraUpdate,
} from "./network-graph-3d-model.js";
export type {
  BuildNetworkGraph3DRenderModelOptions,
  DemandRenderScheduler,
  DemandRenderSchedulerOptions,
  DemandRenderState,
  NetworkGraph3DPosition,
  NetworkGraph3DLabelPriority,
  NetworkGraph3DLabelViewport,
  NetworkGraph3DPlacedLabel,
  NetworkGraph3DProjectedLabel,
  NetworkGraph3DRenderEdge,
  NetworkGraph3DRenderModel,
  NetworkGraph3DRenderNode,
  NetworkCameraUpdate,
  NetworkResourceRegistry,
  NetworkResourceRegistryState,
} from "./network-graph-3d-model.js";

export type NetworkGraph3DFailureCode =
  | "context-lost"
  | "invalid-model"
  | "render-frame"
  | "renderer-initialization"
  | "resource-lifecycle"
  | "webgl2-unavailable";

export interface NetworkGraph3DFailure {
  code: NetworkGraph3DFailureCode;
  message: string;
}

export interface NetworkGraph3DHandle {
  renderNow(): void;
  resetCamera(): void;
}

export interface NetworkGraph3DCameraSnapshot {
  distance: number;
  focusedKey: string;
  pitch: number;
  target: { x: number; y: number; z: number };
  yaw: number;
}

export interface NetworkGraph3DProps {
  ariaLabel?: string;
  className?: string;
  edges: readonly NetworkEdge[];
  initialCamera: NetworkGraph3DCameraSnapshot | null;
  layout: NetworkLayoutSnapshot;
  nodes: readonly NetworkNode[];
  onFailure: (failure: NetworkGraph3DFailure) => void;
  onCameraChange: (camera: NetworkGraph3DCameraSnapshot) => void;
  onSelect: (node: NetworkNode) => void;
  pathEdgeKeys: ReadonlySet<string> | readonly string[];
  pathNodeKeys: ReadonlySet<string> | readonly string[];
  reducedMotion: boolean;
  selectedKey: string;
  style?: CSSProperties;
  theme: AppTheme;
}

const DEFAULT_CANVAS_STYLE: CSSProperties = {
  display: "block",
  height: "100%",
  touchAction: "none",
  width: "100%",
};

const LABEL_CANVAS_STYLE: CSSProperties = {
  height: "100%",
  inset: 0,
  pointerEvents: "none",
  position: "absolute",
  width: "100%",
  zIndex: 3,
};

export const NetworkGraph3D = forwardRef<
  NetworkGraph3DHandle,
  NetworkGraph3DProps
>(function NetworkGraph3D(
  {
    ariaLabel = "真实知识网络 3D 图幅",
    className,
    edges,
    initialCamera,
    layout,
    nodes,
    onFailure,
    onCameraChange,
    onSelect,
    pathEdgeKeys,
    pathNodeKeys,
    reducedMotion,
    selectedKey,
    style,
    theme,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<NetworkGraph3DSession | null>(null);
  const callbacksRef = useRef({ onCameraChange, onFailure, onSelect });
  const nodesByKeyRef = useRef(new Map(nodes.map((node) => [node.key, node])));
  const failureReportedRef = useRef(false);

  callbacksRef.current = { onCameraChange, onFailure, onSelect };
  nodesByKeyRef.current = new Map(nodes.map((node) => [node.key, node]));

  useImperativeHandle(
    ref,
    () => ({
      renderNow() {
        sessionRef.current?.renderNow();
      },
      resetCamera() {
        sessionRef.current?.resetCamera();
      },
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelCanvas = labelCanvasRef.current;

    if (!canvas || !labelCanvas) {
      return;
    }

    const reportFailure = (failure: NetworkGraph3DFailure) => {
      if (failureReportedRef.current) {
        return;
      }

      failureReportedRef.current = true;
      callbacksRef.current.onFailure(failure);
    };
    let context: WebGL2RenderingContext | null = null;

    try {
      context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: true,
        depth: true,
        powerPreference: "high-performance",
      });
    } catch (error) {
      reportFailure({
        code: "renderer-initialization",
        message: failureMessage(error, "WebGL2 初始化失败。"),
      });
      return;
    }

    if (!context) {
      reportFailure({
        code: "webgl2-unavailable",
        message: "当前环境不支持 WebGL2。",
      });
      return;
    }

    try {
      sessionRef.current = new NetworkGraph3DSession(
        canvas,
        labelCanvas,
        context,
        {
          onFailure: reportFailure,
          onSelectKey(key) {
            const node = nodesByKeyRef.current.get(key);

            if (node) {
              callbacksRef.current.onSelect(node);
            }
          },
        },
        initialCamera,
      );
    } catch (error) {
      reportFailure({
        code: "renderer-initialization",
        message: failureMessage(error, "三维网络渲染器初始化失败。"),
      });
    }

    return () => {
      const camera = sessionRef.current?.getCameraSnapshot();

      if (camera) {
        callbacksRef.current.onCameraChange(camera);
      }
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const session = sessionRef.current;

    if (!session || failureReportedRef.current) {
      return;
    }

    try {
      const model = buildNetworkGraph3DRenderModel({
        edges,
        layout,
        nodes,
        pathEdgeKeys,
        pathNodeKeys,
        selectedKey,
      });

      session.setModel(model, theme);
    } catch (error) {
      session.fail({
        code: "invalid-model",
        message: failureMessage(error, "三维网络数据无法建立渲染模型。"),
      });
    }
  }, [edges, layout, nodes, pathEdgeKeys, pathNodeKeys, selectedKey, theme]);

  useEffect(() => {
    if (selectedKey) {
      sessionRef.current?.focusNode(selectedKey);
    }
  }, [selectedKey]);

  return (
    <>
      <canvas
        aria-label={ariaLabel}
        className={className}
        data-render-mode="demand"
        data-reduced-motion={reducedMotion ? "true" : "false"}
        ref={canvasRef}
        role="application"
        style={{ ...DEFAULT_CANVAS_STYLE, ...style }}
        tabIndex={0}
      />
      <canvas
        aria-hidden="true"
        data-network-label-overlay="true"
        ref={labelCanvasRef}
        style={LABEL_CANVAS_STYLE}
      />
    </>
  );
});

interface NetworkGraph3DSessionCallbacks {
  onFailure: (failure: NetworkGraph3DFailure) => void;
  onSelectKey: (key: string) => void;
}

interface PointerDragState {
  lastX: number;
  lastY: number;
  moved: boolean;
  pointerId: number;
  startX: number;
  startY: number;
}

interface NetworkGraph3DPalette {
  background: number;
  concept: string;
  directedEdge: string;
  knowledgePoint: string;
  labelBackground: string;
  labelBorder: string;
  labelPathBorder: string;
  labelSelectedBorder: string;
  labelText: string;
  membershipEdge: string;
  path: string;
  selected: string;
  symmetricEdge: string;
}

class NetworkGraph3DSession {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: NetworkGraph3DSessionCallbacks;
  private readonly contextLostListener: (event: Event) => void;
  private readonly focusListener: () => void;
  private readonly keyDownListener: (event: KeyboardEvent) => void;
  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelContext: CanvasRenderingContext2D;
  private readonly pointerCancelListener: (event: PointerEvent) => void;
  private readonly pointerDownListener: (event: PointerEvent) => void;
  private readonly pointerMoveListener: (event: PointerEvent) => void;
  private readonly pointerUpListener: (event: PointerEvent) => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly resizeListener: () => void;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly scene: THREE.Scene;
  private readonly scheduler;
  private readonly target = new THREE.Vector3();
  private readonly wheelListener: (event: WheelEvent) => void;
  private distance = 560;
  private disposed = false;
  private failed = false;
  private focusedKey = "";
  private graphGroup: THREE.Group | null = null;
  private graphResources: NetworkResourceRegistry = createNetworkResourceRegistry();
  private hasCameraFrame = false;
  private height = 0;
  private readonly initialCamera: NetworkGraph3DCameraSnapshot | null;
  private model: NetworkGraph3DRenderModel | null = null;
  private nodeKeysByObject = new Map<THREE.Object3D, readonly string[]>();
  private pickMeshes: THREE.InstancedMesh[] = [];
  private pitch = 0.42;
  private pixelRatio = 1;
  private pointerDrag: PointerDragState | null = null;
  private width = 0;
  private yaw = 0.18;
  private palette = graphPalette("macaron");

  constructor(
    canvas: HTMLCanvasElement,
    labelCanvas: HTMLCanvasElement,
    context: WebGL2RenderingContext,
    callbacks: NetworkGraph3DSessionCallbacks,
    initialCamera: NetworkGraph3DCameraSnapshot | null,
  ) {
    this.canvas = canvas;
    this.labelCanvas = labelCanvas;
    this.callbacks = callbacks;
    this.initialCamera = initialCamera;
    const labelContext = labelCanvas.getContext("2d");

    if (!labelContext) {
      throw new Error("2D label canvas is unavailable.");
    }
    this.labelContext = labelContext;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas,
      context,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20_000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x263040, 1.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);

    keyLight.position.set(-240, 320, 420);
    this.scene.add(keyLight);

    this.scheduler = createDemandRenderScheduler({
      cancelFrame: (handle) => window.cancelAnimationFrame(handle),
      now: () => window.performance.now(),
      onError: (error) => {
        this.fail({
          code: "render-frame",
          message: failureMessage(error, "三维网络帧渲染失败。"),
        });
      },
      render: () => this.renderFrame(),
      requestFrame: (callback) => window.requestAnimationFrame(callback),
    });

    this.contextLostListener = (event) => {
      event.preventDefault();
      this.fail({
        code: "context-lost",
        message: "WebGL 上下文已丢失，三维视图已停止。",
      });
    };
    this.focusListener = () => this.scheduler.invalidate();
    this.keyDownListener = (event) => this.handleKeyDown(event);
    this.pointerCancelListener = (event) => this.endPointer(event, false);
    this.pointerDownListener = (event) => this.startPointer(event);
    this.pointerMoveListener = (event) => this.movePointer(event);
    this.pointerUpListener = (event) => this.endPointer(event, true);
    this.resizeListener = () => this.scheduler.invalidate();
    this.wheelListener = (event) => this.handleWheel(event);

    canvas.addEventListener("webglcontextlost", this.contextLostListener);
    canvas.addEventListener("focus", this.focusListener);
    canvas.addEventListener("keydown", this.keyDownListener);
    canvas.addEventListener("pointercancel", this.pointerCancelListener);
    canvas.addEventListener("pointerdown", this.pointerDownListener);
    canvas.addEventListener("pointermove", this.pointerMoveListener);
    canvas.addEventListener("pointerup", this.pointerUpListener);
    canvas.addEventListener("wheel", this.wheelListener, { passive: false });

    if (typeof ResizeObserver === "undefined") {
      this.resizeObserver = null;
      window.addEventListener("resize", this.resizeListener);
    } else {
      this.resizeObserver = new ResizeObserver(this.resizeListener);
      this.resizeObserver.observe(canvas);
    }

    this.scheduler.invalidate();
  }

  dispose() {
    this.disposeInternal();
  }

  fail(failure: NetworkGraph3DFailure) {
    if (this.failed || this.disposed) {
      return;
    }

    this.failed = true;
    this.disposeInternal();
    this.callbacks.onFailure(failure);
  }

  focusNode(key: string) {
    const node = this.model?.nodes.find((candidate) => candidate.key === key);

    if (!node || this.disposed) {
      return;
    }

    this.target.set(node.position.x, node.position.y, node.position.z);
    this.distance = Math.min(this.distance, 620);
    this.focusedKey = key;
    this.applyCamera();
    this.scheduler.invalidate();
  }

  getCameraSnapshot(): NetworkGraph3DCameraSnapshot {
    return {
      distance: this.distance,
      focusedKey: this.focusedKey,
      pitch: this.pitch,
      target: {
        x: this.target.x,
        y: this.target.y,
        z: this.target.z,
      },
      yaw: this.yaw,
    };
  }

  renderNow() {
    this.scheduler.renderNow();
  }

  resetCamera() {
    if (this.disposed) {
      return;
    }

    this.frameModel();
    this.scheduler.invalidate();
  }

  setModel(model: NetworkGraph3DRenderModel, theme: AppTheme) {
    if (this.disposed) {
      return;
    }

    let nextResources = createNetworkResourceRegistry();
    const nextGroup = new THREE.Group();

    try {
      const palette = graphPalette(theme);

      this.pickMeshes = [];
      this.nodeKeysByObject.clear();
      this.palette = palette;
      this.renderer.setClearColor(palette.background, 1);
      this.buildNodeMeshes(nextGroup, nextResources, model, palette);
      this.buildEdgeMeshes(nextGroup, nextResources, model, palette);
      safeDispose(this.graphResources);
      if (this.graphGroup) {
        this.scene.remove(this.graphGroup);
      }
      this.graphResources = nextResources;
      this.graphGroup = nextGroup;
      this.model = model;
      this.scene.add(nextGroup);
      nextResources = createNetworkResourceRegistry();

      if (!this.hasCameraFrame) {
        if (this.initialCamera) {
          this.restoreCamera(this.initialCamera);
        } else {
          this.frameModel();
        }
        this.hasCameraFrame = true;
      }
      const selected = model.nodes.find(({ selected }) => selected);
      const cameraUpdate = resolveNetworkCameraUpdate({
        focusedKey: this.focusedKey,
        modelNodeKeys: model.nodes.map(({ key }) => key),
        selectedKey: selected?.key ?? "",
      });

      if (cameraUpdate.kind === "focus") {
        this.focusNode(cameraUpdate.key);
      } else if (cameraUpdate.kind === "frame") {
        this.focusedKey = "";
        this.frameModel();
      }
      this.scheduler.invalidate();
    } catch (error) {
      safeDispose(nextResources);
      this.fail({
        code: "resource-lifecycle",
        message: failureMessage(error, "三维网络场景资源建立失败。"),
      });
    }
  }

  private applyCamera() {
    const horizontal = Math.cos(this.pitch) * this.distance;

    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontal,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
    this.canvas.dataset.cameraState = JSON.stringify(this.getCameraSnapshot());
  }

  private restoreCamera(snapshot: NetworkGraph3DCameraSnapshot) {
    this.yaw = snapshot.yaw;
    this.pitch = THREE.MathUtils.clamp(snapshot.pitch, -1.34, 1.34);
    this.distance = THREE.MathUtils.clamp(snapshot.distance, 90, 16_000);
    this.focusedKey = snapshot.focusedKey;
    this.target.set(snapshot.target.x, snapshot.target.y, snapshot.target.z);
    this.applyCamera();
  }

  private buildEdgeMeshes(
    group: THREE.Group,
    resources: NetworkResourceRegistry,
    model: NetworkGraph3DRenderModel,
    palette: NetworkGraph3DPalette,
  ) {
    const membership = model.edges.filter(
      ({ kind }) => kind === "concept_membership",
    );
    const symmetric = model.edges.filter(
      ({ directed, kind }) => !directed && kind !== "concept_membership",
    );
    const directed = model.edges.filter(
      ({ directed, kind }) => directed && kind !== "concept_membership",
    );

    this.buildEdgeLineMesh(
      group,
      resources,
      membership,
      palette.membershipEdge,
      palette.path,
      { dashSize: 8, gapSize: 7, opacity: 0.72, renderOrder: 0 },
    );
    this.buildEdgeLineMesh(
      group,
      resources,
      symmetric,
      palette.symmetricEdge,
      palette.path,
      { dashSize: 2, gapSize: 6, opacity: 0.76, renderOrder: 1 },
    );

    if (directed.length > 0) {
      this.buildEdgeLineMesh(
        group,
        resources,
        directed,
        palette.directedEdge,
        palette.path,
        { dashSize: 11, gapSize: 5, opacity: 0.9, renderOrder: 2 },
      );
      this.buildArrowMesh(group, resources, directed, model, palette);
    }
  }

  private buildEdgeLineMesh(
    group: THREE.Group,
    resources: NetworkResourceRegistry,
    edges: readonly NetworkGraph3DRenderEdge[],
    baseColor: string,
    pathColor: string,
    style: {
      dashSize: number;
      gapSize: number;
      opacity: number;
      renderOrder: number;
    },
  ) {
    if (edges.length === 0) {
      return;
    }

    const geometry = resources.track(
      edgeGeometry(edges, baseColor, pathColor),
    );
    const material = resources.track(
      new THREE.LineDashedMaterial({
        dashSize: style.dashSize,
        gapSize: style.gapSize,
        opacity: style.opacity,
        transparent: true,
        vertexColors: true,
      }),
    );
    const lines = new THREE.LineSegments(geometry, material);

    lines.computeLineDistances();
    lines.renderOrder = style.renderOrder;
    group.add(lines);
  }

  private buildArrowMesh(
    group: THREE.Group,
    resources: NetworkResourceRegistry,
    edges: readonly NetworkGraph3DRenderEdge[],
    model: NetworkGraph3DRenderModel,
    palette: NetworkGraph3DPalette,
  ) {
    const geometry = resources.track(
      new THREE.ConeGeometry(3.8, 11, model.lod.arrowRadialSegments),
    );
    const material = resources.track(
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    const arrows = new THREE.InstancedMesh(geometry, material, edges.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);

    edges.forEach((edge, index) => {
      direction.set(
        edge.targetPosition.x - edge.sourcePosition.x,
        edge.targetPosition.y - edge.sourcePosition.y,
        edge.targetPosition.z - edge.sourcePosition.z,
      );
      if (direction.lengthSq() < 0.0001) {
        direction.copy(up);
      } else {
        direction.normalize();
      }
      quaternion.setFromUnitVectors(up, direction);
      position.set(
        THREE.MathUtils.lerp(edge.sourcePosition.x, edge.targetPosition.x, 0.78),
        THREE.MathUtils.lerp(edge.sourcePosition.y, edge.targetPosition.y, 0.78),
        THREE.MathUtils.lerp(edge.sourcePosition.z, edge.targetPosition.z, 0.78),
      );
      matrix.compose(position, quaternion, scale);
      arrows.setMatrixAt(index, matrix);
      arrows.setColorAt(index, new THREE.Color(edge.onPath ? palette.path : palette.directedEdge));
    });
    arrows.instanceMatrix.needsUpdate = true;
    if (arrows.instanceColor) {
      arrows.instanceColor.needsUpdate = true;
    }
    arrows.frustumCulled = false;
    arrows.renderOrder = 2;
    group.add(arrows);
  }

  private buildNodeMeshes(
    group: THREE.Group,
    resources: NetworkResourceRegistry,
    model: NetworkGraph3DRenderModel,
    palette: NetworkGraph3DPalette,
  ) {
    const concepts = model.nodes.filter((node) => node.type === "concept");
    const knowledgePoints = model.nodes.filter(
      (node) => node.type === "knowledge_point",
    );
    const material = resources.track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.04,
        roughness: 0.76,
      }),
    );

    if (concepts.length > 0) {
      const geometry = resources.track(
        new THREE.SphereGeometry(
          14,
          model.lod.conceptWidthSegments,
          model.lod.conceptHeightSegments,
        ),
      );
      const mesh = this.createNodeMesh(geometry, material, concepts, palette);

      group.add(mesh);
    }

    if (knowledgePoints.length > 0) {
      const geometry = resources.track(new THREE.BoxGeometry(19, 19, 19));
      const mesh = this.createNodeMesh(
        geometry,
        material,
        knowledgePoints,
        palette,
      );

      group.add(mesh);
    }
  }

  private createNodeMesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    nodes: readonly NetworkGraph3DRenderNode[],
    palette: NetworkGraph3DPalette,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();

    nodes.forEach((node, index) => {
      const nodeScale = node.selected ? 1.34 : node.onPath ? 1.17 : 1;

      position.set(node.position.x, node.position.y, node.position.z);
      scale.setScalar(nodeScale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(
        index,
        new THREE.Color(
          node.selected
            ? palette.selected
            : node.onPath
              ? palette.path
              : node.type === "concept"
                ? palette.concept
                : palette.knowledgePoint,
        ),
      );
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.pickMeshes.push(mesh);
    this.nodeKeysByObject.set(mesh, nodes.map(({ key }) => key));

    return mesh;
  }

  private disposeInternal() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.scheduler.dispose();
    this.resizeObserver?.disconnect();
    if (!this.resizeObserver) {
      window.removeEventListener("resize", this.resizeListener);
    }
    this.canvas.removeEventListener("webglcontextlost", this.contextLostListener);
    this.canvas.removeEventListener("focus", this.focusListener);
    this.canvas.removeEventListener("keydown", this.keyDownListener);
    this.canvas.removeEventListener("pointercancel", this.pointerCancelListener);
    this.canvas.removeEventListener("pointerdown", this.pointerDownListener);
    this.canvas.removeEventListener("pointermove", this.pointerMoveListener);
    this.canvas.removeEventListener("pointerup", this.pointerUpListener);
    this.canvas.removeEventListener("wheel", this.wheelListener);
    safeDispose(this.graphResources);
    this.labelContext.setTransform(1, 0, 0, 1, 0, 0);
    this.labelContext.clearRect(
      0,
      0,
      this.labelCanvas.width,
      this.labelCanvas.height,
    );
    this.scene.clear();
    this.renderer.dispose();
    this.pickMeshes = [];
    this.nodeKeysByObject.clear();
  }

  private endPointer(event: PointerEvent, pick: boolean) {
    const drag = this.pointerDrag;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    this.pointerDrag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (pick && !drag.moved) {
      this.pickNode(event.clientX, event.clientY);
    }
  }

  private frameModel() {
    const nodes = this.model?.nodes ?? [];

    this.yaw = 0.18;
    this.pitch = 0.42;
    if (nodes.length === 0) {
      this.target.set(0, 0, 0);
      this.distance = 560;
      this.applyCamera();
      return;
    }

    const bounds = new THREE.Box3();

    for (const node of nodes) {
      bounds.expandByPoint(
        new THREE.Vector3(node.position.x, node.position.y, node.position.z),
      );
    }
    bounds.getCenter(this.target);
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 180) / 2;
    const fovRadians = THREE.MathUtils.degToRad(this.camera.fov);

    this.distance = THREE.MathUtils.clamp(
      (radius / Math.tan(fovRadians / 2)) * 1.36,
      320,
      12_000,
    );
    this.camera.far = Math.max(20_000, this.distance + radius * 6);
    this.camera.updateProjectionMatrix();
    this.applyCamera();
  }

  private handleKeyDown(event: KeyboardEvent) {
    const angleStep = 0.12;

    switch (event.key) {
      case "ArrowLeft":
        this.yaw -= angleStep;
        break;
      case "ArrowRight":
        this.yaw += angleStep;
        break;
      case "ArrowUp":
        this.pitch = THREE.MathUtils.clamp(this.pitch + angleStep, -1.34, 1.34);
        break;
      case "ArrowDown":
        this.pitch = THREE.MathUtils.clamp(this.pitch - angleStep, -1.34, 1.34);
        break;
      case "+":
      case "=":
        this.distance = Math.max(90, this.distance * 0.84);
        break;
      case "-":
      case "_":
        this.distance = Math.min(16_000, this.distance * 1.18);
        break;
      case "Home":
      case "0":
        this.resetCamera();
        event.preventDefault();
        return;
      case "Enter": {
        const selected = this.model?.nodes.find(({ selected }) => selected);

        if (selected) {
          this.callbacks.onSelectKey(selected.key);
        }
        return;
      }
      default:
        return;
    }

    event.preventDefault();
    this.applyCamera();
    this.scheduler.invalidate();
  }

  private handleWheel(event: WheelEvent) {
    event.preventDefault();
    this.distance = THREE.MathUtils.clamp(
      this.distance * Math.exp(event.deltaY * 0.0012),
      90,
      16_000,
    );
    this.applyCamera();
    this.scheduler.invalidate();
  }

  private movePointer(event: PointerEvent) {
    const drag = this.pointerDrag;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved ||=
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
    if (!drag.moved) {
      return;
    }

    this.yaw -= deltaX * 0.006;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + deltaY * 0.006,
      -1.34,
      1.34,
    );
    this.applyCamera();
    this.scheduler.invalidate();
  }

  private pickNode(clientX: number, clientY: number) {
    if (this.pickMeshes.length === 0) {
      return;
    }

    const bounds = this.canvas.getBoundingClientRect();

    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const pointer = new THREE.Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();

    raycaster.setFromCamera(pointer, this.camera);
    const intersections = raycaster.intersectObjects(this.pickMeshes, false);

    for (const intersection of intersections) {
      if (intersection.instanceId === undefined) {
        continue;
      }

      const keys = this.nodeKeysByObject.get(intersection.object);
      const key = keys?.[intersection.instanceId];

      if (key) {
        this.callbacks.onSelectKey(key);
        return;
      }
    }
  }

  private renderFrame() {
    if (this.disposed) {
      return;
    }

    this.resizeRenderer();
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.renderLabels();
  }

  private renderLabels() {
    const context = this.labelContext;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.labelCanvas.width, this.labelCanvas.height);
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);

    if (!this.model || this.width <= 0 || this.height <= 0) {
      return;
    }

    const dense =
      this.model.nodes.length >
      NETWORK_GRAPH_3D_LABEL_BUDGET.denseNodeThreshold;
    const projectedPosition = new THREE.Vector3();
    const linesByKey = new Map<string, string[]>();
    const candidates: NetworkGraph3DProjectedLabel[] = [];

    for (const node of networkGraph3DLabelNodes(this.model.nodes)) {
      const priority = labelPriority(node);
      const important = priority === "selected" || priority === "path";

      projectedPosition
        .set(node.position.x, node.position.y, node.position.z)
        .project(this.camera);
      if (
        !Number.isFinite(projectedPosition.x) ||
        !Number.isFinite(projectedPosition.y) ||
        !Number.isFinite(projectedPosition.z)
      ) {
        continue;
      }
      if (
        !important &&
        (projectedPosition.z < -1 ||
          projectedPosition.z > 1 ||
          Math.abs(projectedPosition.x) > 1.08 ||
          Math.abs(projectedPosition.y) > 1.08)
      ) {
        continue;
      }

      context.font = labelFont(priority);
      const maximumTextWidth = Math.max(
        88,
        Math.min(important ? 280 : 180, this.width - 28),
      );
      const lines = wrapCanvasLabel(context, node.label, maximumTextWidth);
      const measuredWidth = Math.max(
        ...lines.map((line) => context.measureText(line).width),
      );
      const lineHeight = labelLineHeight(priority);

      linesByKey.set(node.key, lines);
      candidates.push({
        height: lines.length * lineHeight + 10,
        key: node.key,
        label: node.label,
        priority,
        width: Math.min(maximumTextWidth, measuredWidth) + 12,
        x: (projectedPosition.x * 0.5 + 0.5) * this.width,
        y: (-projectedPosition.y * 0.5 + 0.5) * this.height,
      });
    }

    const labels = placeNetworkGraph3DLabels(
      candidates,
      { height: this.height, width: this.width },
      dense,
    );

    for (const label of labels) {
      const lines = linesByKey.get(label.key) ?? [label.label];
      const lineHeight = labelLineHeight(label.priority);

      context.fillStyle = this.palette.labelBackground;
      context.fillRect(label.left, label.top, label.width, label.height);
      context.strokeStyle =
        label.priority === "selected"
          ? this.palette.labelSelectedBorder
          : label.priority === "path"
            ? this.palette.labelPathBorder
            : this.palette.labelBorder;
      context.lineWidth =
        label.priority === "selected" || label.priority === "path" ? 1.5 : 1;
      context.strokeRect(
        label.left + 0.5,
        label.top + 0.5,
        Math.max(0, label.width - 1),
        Math.max(0, label.height - 1),
      );
      context.fillStyle = this.palette.labelText;
      context.font = labelFont(label.priority);
      context.textBaseline = "top";
      lines.forEach((line, index) => {
        context.fillText(
          line,
          label.left + 6,
          label.top + 5 + index * lineHeight,
        );
      });
    }
  }

  private resizeRenderer() {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || this.canvas.clientWidth));
    const height = Math.max(1, Math.round(bounds.height || this.canvas.clientHeight));

    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      NETWORK_GRAPH_3D_BUDGET.maxPixelRatio,
    );

    if (
      width === this.width &&
      height === this.height &&
      pixelRatio === this.pixelRatio
    ) {
      return;
    }

    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.labelCanvas.width = Math.max(1, Math.round(width * pixelRatio));
    this.labelCanvas.height = Math.max(1, Math.round(height * pixelRatio));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private startPointer(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }

    this.canvas.focus({ preventScroll: true });
    this.pointerDrag = {
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    this.canvas.setPointerCapture(event.pointerId);
  }
}

function edgeGeometry(
  edges: readonly NetworkGraph3DRenderEdge[],
  baseColor: string,
  pathColor: string,
): THREE.BufferGeometry {
  const positions = new Float32Array(edges.length * 6);
  const colors = new Float32Array(edges.length * 6);
  const color = new THREE.Color();

  edges.forEach((edge, index) => {
    const offset = index * 6;

    positions.set(
      [
        edge.sourcePosition.x,
        edge.sourcePosition.y,
        edge.sourcePosition.z,
        edge.targetPosition.x,
        edge.targetPosition.y,
        edge.targetPosition.z,
      ],
      offset,
    );
    color.set(edge.onPath ? pathColor : baseColor);
    colors.set([color.r, color.g, color.b, color.r, color.g, color.b], offset);
  });

  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  return geometry;
}

function graphPalette(theme: AppTheme): NetworkGraph3DPalette {
  return theme === "scifi"
    ? {
        background: 0x00030b,
        concept: "#28e2e8",
        directedEdge: "#7285bd",
        knowledgePoint: "#8d7dff",
        labelBackground: "rgb(2 10 20 / 88%)",
        labelBorder: "rgb(93 164 184 / 58%)",
        labelPathBorder: "#ffac6e",
        labelSelectedBorder: "#f3fcff",
        labelText: "#e8faff",
        membershipEdge: "#3aa6a8",
        path: "#ffac6e",
        selected: "#f3fcff",
        symmetricEdge: "#8b80c8",
      }
    : {
        background: 0xfff8fb,
        concept: "#d84f79",
        directedEdge: "#8f7891",
        knowledgePoint: "#637e98",
        labelBackground: "rgb(255 248 251 / 90%)",
        labelBorder: "rgb(122 49 80 / 38%)",
        labelPathBorder: "#b36e17",
        labelSelectedBorder: "#7a3150",
        labelText: "#4a2738",
        membershipEdge: "#6b9e67",
        path: "#d68a27",
        selected: "#7a3150",
        symmetricEdge: "#9a7fa0",
      };
}

function labelFont(priority: NetworkGraph3DLabelPriority): string {
  const important = priority === "selected" || priority === "path";

  return `${important ? 700 : 600} ${important ? 13 : 12}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function labelLineHeight(priority: NetworkGraph3DLabelPriority): number {
  return priority === "selected" || priority === "path" ? 17 : 16;
}

function labelPriority(
  node: NetworkGraph3DRenderNode,
): NetworkGraph3DLabelPriority {
  if (node.selected) {
    return "selected";
  }

  if (node.onPath) {
    return "path";
  }

  return node.type;
}

function wrapCanvasLabel(
  context: CanvasRenderingContext2D,
  label: string,
  maximumWidth: number,
): string[] {
  const characters = Array.from(label || " ");
  const lines: string[] = [];
  let line = "";

  for (const character of characters) {
    const candidate = `${line}${character}`;

    if (line && context.measureText(candidate).width > maximumWidth) {
      lines.push(line);
      line = character;
    } else {
      line = candidate;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.length > 0 ? lines : [" "];
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function safeDispose(resources: NetworkResourceRegistry) {
  try {
    resources.dispose();
  } catch {
    // Every registered resource is attempted even if an individual dispose fails.
  }
}
