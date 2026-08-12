---
version: 1
slug: "src-client-home-page-tsx"
primary_target: "src/client/home-page.tsx"
related_targets: ["src/client/home-page.css","src/client/network-graph-3d.tsx","src/client/network-graph-3d-model.ts","src/client/network-workspace-controller.ts","src/client/network-page.tsx"]
---

Scope and mode: Home Concept／Tag dual-view route and its shared network fallbacks; Operate with an immersive first viewport.

Audience and job: a single knowledge worker chooses either confirmed knowledge structure or the familiar Tag index, then locates a Concept, Knowledge Point, or Tag without mistaking one lens for the other.

Primary task and proof: first visit is Concept-first, while a persistent `Concept`／`标签` switch restores the user's last lens unless a network deep link requires Concept. Concept selection, submitted node search, path endpoints, or local expansion add current Knowledge Points and only API-returned real edges; Tag view shows all current Tags and opens the existing hard-filtered record search. Switching away never rewrites network URL state, so returning restores the drawer and path.

Chosen direction and memorable moment: two honest immersive lenses inside the established macaron or sci-fi theme, joined by one compact bottom switch rather than merged into one graph. Concept spheres and Knowledge Point cubes occupy the deterministic real network; Tag bubbles or membranes retain their separate navigational field and explicitly non-semantic decoration.

Important state: `node`, `from`, `to`, submitted `q`, repeated `type`, repeated `relation`, and `view=graph|list` are shared with `/network`; the home lens and both cameras are local preferences, not URL facts. WebGL2 or Concept 3D runtime failure preserves network state and reveals functional 2D, then the keyboard list; Tag view keeps its established 2D fallback. Reduced motion disables continuous idle animation.

Constraints: Tag view and bottom Tag/record search never create network nodes or edges. Tag random positions, decorative lines, record-count sizing, approval rings, and stable colors are permitted only inside the explicitly labelled Tag view and must never leak into Concept rendering. Preserve keyboard switching, node-type shapes, edge direction and line grammar, source links, loading/error/empty/no-path states, dual-theme parity, and the 500-node/1000-edge Concept render target without silently deleting API-returned facts through LOD.

Unresolved decisions: none.
