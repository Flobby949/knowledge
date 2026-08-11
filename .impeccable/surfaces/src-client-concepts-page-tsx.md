---
version: 1
slug: "src-client-concepts-page-tsx"
primary_target: "src/client/concepts-page.tsx"
related_targets: ["src/client/concepts-page.css", "src/client/concept-candidates-panel.tsx", "src/client/concept-candidates-panel.css", "src/client/ai-task-pulse.tsx"]
---

Scope and mode: Concept workspace route; organize and maintain.

Audience and job: a single user turning several verified knowledge points into one durable, self-contained definition while preserving exact sources and change history.

Primary task and proof: the route has two explicit views. The formal catalog leads with the definition and current Memberships. The AI Candidate view leads with one user-scoped scan, its frozen inputs and evidence, editable promotion fields, and the final human decision. Every member names its source record and state; revision, activity, suggestion, and decision history remain available without displacing the working set.

Chosen direction: a compact concept catalog beside one assembly sheet, borrowing the density and direct addressability of a printed catalog while staying inside the established dual-theme knowledge workbench. Catalog codes and Membership codes are navigation coordinates, not domain identifiers.

Important state: manual creation requires a name, description, and at least two current knowledge points. Candidate scans require 2–12 current knowledge points and expose queued, running, failed/retryable, no-suggestion, duplicate, pending, stale, accepted, and rejected states. AI suggestions stay outside the formal catalog until a user confirms edited promotion fields and at least two frozen members. Archived Concepts remain readable; stale Memberships stay attached and visibly require review rather than silently migrating.

Constraints: preserve theme switching, source and evidence links, stable Concept, Candidate, and Membership identity, immutable suggestions and revisions, reversible removal and archive actions, format-4/5 restore compatibility, query-addressable formal and Candidate views, keyboard access, and 1280px desktop geometry. The global AI pulse may surface active, failed, or pending Candidate scans but must return users to this route for decisions.
