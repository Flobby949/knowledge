---
version: 1
slug: "src-client-concepts-page-tsx"
primary_target: "src/client/concepts-page.tsx"
related_targets: ["src/client/concepts-page.css", "src/client/concept-candidates-panel.tsx", "src/client/concept-candidates-panel.css", "src/client/ai-task-pulse.tsx"]
---

Scope and mode: Concept workspace route; organize and maintain.

Audience and job: a single user reviewing automatically discovered knowledge groupings and promoting only trustworthy ones into durable, self-contained definitions while preserving exact sources and change history.

Primary task and proof: the route has two explicit views. The formal catalog leads with the definition and current Memberships. The AI Candidate view is an automatic discovery inbox: newly effective Knowledge Points seed global recall, one frozen candidate opens for editable promotion, and the user only accepts, modifies, rejects, or defers. Seed knowledge and globally recalled knowledge are visibly distinct; every member names its source record and evidence.

Chosen direction: a compact concept catalog beside one assembly sheet, borrowing the density and direct addressability of a printed catalog while staying inside the established dual-theme knowledge workbench. Catalog codes and Membership codes are navigation coordinates, not domain identifiers.

Important state: manual Concept creation still requires a name, description, and at least two current knowledge points. Automatic discovery begins only when an AI organization becomes active: Save Only records and pending review knowledge never enter Concept recall. A scan freezes 1–12 seed/recalled points and exposes queued, running, failed/retryable, no-recall, no-suggestion, duplicate, pending, stale, accepted, and rejected states. AI suggestions stay outside the formal catalog until a user confirms edited promotion fields and at least two frozen members.

Constraints: preserve theme switching, source and evidence links, stable Concept, Candidate, and Membership identity, immutable suggestions and revisions, reversible removal and archive actions, format-4/5/6 restore compatibility, query-addressable formal and Candidate views, keyboard access, and 1280px desktop geometry. The Candidate view must not ask users to choose a recall scope; the global AI pulse may surface active, failed, or pending scans but must return users to this route for decisions.
