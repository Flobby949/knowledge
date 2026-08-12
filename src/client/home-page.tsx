/*
 * THESIS: Home offers two honest entry lenses—confirmed Concepts and navigational Tags—without merging their semantics.
 * OWN-WORLD: One compact switch moves between the real knowledge network and the established dual-theme Tag field.
 * STORY: Choose the lens, explore it fully, and return without losing the other lens's recoverable state.
 * FIRST VIEWPORT: The selected immersive stage fills the page; a persistent two-option switch sits clear of search and proof controls.
 * FORM: Operate-mode view switch over two existing Experience surfaces.
 */
import { useRef, useState } from "react";

import { ConceptHomePage } from "./home-concept-page.js";
import { TagHomePage } from "./home-tag-page.js";
import type { NetworkGraph3DCameraSnapshot } from "./network-graph-3d.js";
import "./home-page.css";
import "./home-view-switch.css";

export type HomeKnowledgeView = "concept" | "tags";

export const HOME_KNOWLEDGE_VIEW_STORAGE_KEY = "knowledge.home.view.v1";

export function HomePage() {
  const [view, setView] = useState<HomeKnowledgeView>(readHomeKnowledgeView);
  const conceptCamera = useRef<NetworkGraph3DCameraSnapshot | null>(null);

  function selectView(nextView: HomeKnowledgeView) {
    setView(nextView);

    try {
      window.localStorage.setItem(HOME_KNOWLEDGE_VIEW_STORAGE_KEY, nextView);
    } catch {
      // The in-memory choice remains usable when storage is unavailable.
    }
  }

  return (
    <div className="home-view-root" data-home-view={view}>
      {view === "concept" ? (
        <ConceptHomePage
          initialCamera={conceptCamera.current}
          onCameraChange={(camera) => {
            conceptCamera.current = camera;
          }}
        />
      ) : (
        <TagHomePage />
      )}

      <div
        aria-label="首页知识视图"
        className="home-view-switch"
        role="group"
      >
        <button
          aria-pressed={view === "concept"}
          onClick={() => selectView("concept")}
          type="button"
        >
          Concept
        </button>
        <button
          aria-pressed={view === "tags"}
          onClick={() => selectView("tags")}
          type="button"
        >
          标签
        </button>
      </div>
    </div>
  );
}

function readHomeKnowledgeView(): HomeKnowledgeView {
  if (typeof window === "undefined") {
    return "concept";
  }

  const search = new URLSearchParams(window.location.search);
  const hasNetworkDeepLink = [
    "from",
    "node",
    "q",
    "relation",
    "to",
    "type",
    "view",
  ].some((key) => search.has(key));

  if (hasNetworkDeepLink) {
    return "concept";
  }

  try {
    return window.localStorage.getItem(HOME_KNOWLEDGE_VIEW_STORAGE_KEY) ===
      "tags"
      ? "tags"
      : "concept";
  } catch {
    return "concept";
  }
}
