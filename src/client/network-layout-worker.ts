import {
  expandNetworkLayout,
  layoutNetwork,
  type NetworkLayoutEdge,
  type NetworkLayoutNode,
  type NetworkLayoutSnapshot,
} from "./network-layout.js";

export type NetworkLayoutWorkerRequest =
  | {
      type: "initial";
      edges: NetworkLayoutEdge[];
      nodes: NetworkLayoutNode[];
    }
  | {
      type: "expand";
      edges: NetworkLayoutEdge[];
      focusKey: string;
      nodes: NetworkLayoutNode[];
      previous: NetworkLayoutSnapshot;
    };

export type NetworkLayoutWorkerResponse =
  | { type: "snapshot"; snapshot: NetworkLayoutSnapshot }
  | { type: "error"; error: string };

interface NetworkLayoutWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: NetworkLayoutWorkerResponse): void;
}

const workerScope = globalThis as unknown as Partial<NetworkLayoutWorkerScope>;

if (
  typeof document === "undefined" &&
  typeof workerScope.postMessage === "function"
) {
  workerScope.onmessage = (event) => {
    try {
      const request = parseRequest(event.data);
      const snapshot =
        request.type === "initial"
          ? layoutNetwork(request.nodes, request.edges)
          : expandNetworkLayout(
              request.previous,
              request.nodes,
              request.edges,
              request.focusKey,
            );

      workerScope.postMessage!({ type: "snapshot", snapshot });
    } catch (error) {
      workerScope.postMessage!({
        type: "error",
        error:
          error instanceof Error
            ? error.message
            : "Network layout worker failed.",
      });
    }
  };
}

function parseRequest(value: unknown): NetworkLayoutWorkerRequest {
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("Invalid network layout worker request.");
  }

  if (value.type === "initial") {
    return value as NetworkLayoutWorkerRequest;
  }

  if (
    value.type === "expand" &&
    typeof value.focusKey === "string" &&
    isObject(value.previous) &&
    value.previous.version === 1
  ) {
    return value as NetworkLayoutWorkerRequest;
  }

  throw new Error("Invalid network layout worker request.");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
