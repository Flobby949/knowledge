---
version: 1
slug: "src-client-network-page-tsx"
primary_target: "src/client/network-page.tsx"
related_targets: ["src/client/network-page.css","src/client/network-layout.ts","src/client/network-layout-worker.ts"]
---

Scope and mode: dedicated `/network` Knowledge Network workspace; Operate.

Audience and job: a single knowledge worker browses only current, confirmed network facts, opens either a Concept or Knowledge Point at its maintained source, and verifies how two nodes are connected without treating AI similarity or layout proximity as evidence.

Primary task and proof: the initial graph is Concept-first. Search or node selection requests a depth-1 rooted subgraph and unfolds current Knowledge Points. A server path request accepts typed `from`/`to` keys with maximum depth 6, merges the returned real nodes and edges into the existing map, and highlights every ordered step twice while retaining canonical direction and traversal direction. An explicit no-path result is a valid outcome.

Chosen direction: an immersive knowledge-map cartography desk, not a card cloud. One continuous paper-white SVG sheet carries concentric circular Concept stations, square Knowledge Point ports, dashed Memberships, dotted symmetric relations, arrowed directed relations, and a narrow path docket. A light title/search band anchors the map; compact filters float below it, while a 300px summary-first inspector overlays the right safe area without resizing or recomputing the graph. Relation details expand only on demand. The macaron and sci-fi themes share topology and interaction while inheriting strawberry or electric-blue drafting ink.

Important state: `node`, `from`, `to`, `q`, `view`, repeated `type`, and repeated `relation` are query-addressable; coordinates are not. Opening a node pushes history, switching the open node replaces it, and close/Escape returns through that history when available. Graph and equivalent list views preserve the same filters, selection and path. Worker or SVG failure automatically selects the list without discarding URL state.

Constraints: render only network API nodes and the three real edge kinds; never invent decorative adjacency. Keep source links, node keyboard operation, keyboard and button zoom, blank-field drag panning, wheel zoom, explicit loading/error/empty/disabled/no-path states, reduced motion, 1280px no-overflow geometry, current export format 8 and restore compatibility for formats 4–7. Canvas labels must never become selectable while panning; text outside the canvas keeps normal selection behavior. Viewport pan/zoom remains ephemeral and never becomes graph truth or URL state. The stable `NetworkCanvas` display contract remains reusable by V3.4, but this surface does not implement 3D.
