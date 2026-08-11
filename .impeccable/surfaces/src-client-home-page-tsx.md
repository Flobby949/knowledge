---
version: 1
slug: "src-client-home-page-tsx"
primary_target: "src/client/home-page.tsx"
related_targets: ["src/client/home-page.css","src/client/network-graph-3d.tsx","src/client/network-graph-3d-model.ts","src/client/network-workspace-controller.ts","src/client/network-page.tsx"]
---

Scope and mode: V3.4 home route and its shared network fallbacks; Operate with an immersive first viewport.

Audience and job: a single knowledge worker enters through the current confirmed knowledge structure, locates a Concept or Knowledge Point, verifies its source and real neighbors, and traces a server-confirmed path without mistaking spatial depth or visual treatment for evidence.

Primary task and proof: the initial scene is Concept-first. Selection, submitted node search, path endpoints, or local expansion add the required current Knowledge Points while freezing existing positions. The stage renders only effective Concept and Knowledge Point nodes plus `concept_membership`, `knowledge_relation`, and `concept_relation` edges returned by the network API. Selection opens the same 480px source drawer and server-path docket as `/network`; URL state and browser history make the task recoverable.

Chosen direction and memorable moment: one continuous true 3D knowledge field inside the established macaron or sci-fi theme, not the retired Tag constellation and not a dashboard of cards. Concept spheres and Knowledge Point cubes occupy the deterministic V3.3 x/y map with a shallow stable z; selecting a node brings its auditable neighborhood into focus while the proof drawer pushes the field without changing topology.

Important state: `node`, `from`, `to`, submitted `q`, repeated `type`, repeated `relation`, and `view=graph|list` are shared with `/network`; camera and x/y/z are not URL facts. WebGL2 or 3D runtime failure preserves those states and reveals the functional 2D graph; 2D or layout failure preserves them again in the keyboard list. Reduced motion uses demand rendering with no continuous RAF.

Constraints: Tag location and record search remain the separate bottom search flow and never become network nodes or edges. Do not reuse Tag random positions, decorative lines, record-count sizing, approval rings, or color semantics. Preserve node-type shapes, edge direction and line grammar, keyboard access, source links, loading/error/empty/no-path states, dual-theme parity, and the 500-node/1000-edge render target without silently deleting API-returned facts through LOD.

Unresolved decisions: none for the V3.4 implementation contract; final performance, visual, browser, and deployment evidence is recorded only after the release acceptance run.
