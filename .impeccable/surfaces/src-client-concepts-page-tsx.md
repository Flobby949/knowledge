---
version: 1
slug: "src-client-concepts-page-tsx"
primary_target: "src/client/concepts-page.tsx"
related_targets: ["src/client/concepts-page.css","src/client/concept-candidates-panel.tsx","src/client/concept-candidates-panel.css","src/client/concept-relations-ledger.tsx","src/client/concept-relations-panel.tsx","src/client/concept-relations-panel.css","src/client/ai-task-pulse.tsx"]
---

Scope and mode: Concept workspace route; organize, maintain, and review.

Audience and job: a single user promotes trustworthy knowledge groupings into durable definitions, maintains exact Membership history, and inspects or corrects automatically maintained semantic connections between stable Concepts.

Primary task and proof: the route has three explicit, query-addressable views. The formal catalog leads with each definition, current Memberships, automatically maintained formal relations, and navigable neighbor Concepts; the user can inspect or revoke a wrong edge but is not asked to construct one. The AI Candidate inbox freezes recalled Knowledge Points for editable promotion and still requires a user decision. The Concept Relation ledger is different by design: it states that automatic linking is active, separates effective and revoked edges, compares both frozen definitions, exposes AI confidence/reason/actual model, preserves needs-review and removal history, and never asks the user to scan or confirm.

Chosen direction: an immersive reading desk. Formal Concepts begin with a compact horizontal reference index, then open into one wide, continuous definition-and-proof sheet where definition, automatically maintained neighbors, and Membership evidence read in sequence. Candidates keep the frozen assembly sheet, while Concept Relations retain the paired-definition ledger for comparison and history. Catalog, Candidate, Membership, and Relation codes are navigation coordinates, not domain identifiers.

Important state: manual Concept creation still requires a name, description, and at least two current Knowledge Points. Candidate discovery exposes queued through rejected outcomes without asking for recall scope. Automatic relation discovery is triggered by effective knowledge or Concept input change, considers at most 100 active Concepts, uses bounded semantic recall before serial AI judgment, and writes a formal edge only for an explicit related result. Legacy user-authored rows remain readable and revocable but have no creation entry in the current UI or API. All formal sources freeze endpoint Revision and effective Membership fingerprints, remain visible as needs-review history after endpoint change, and preserve source identity when revoked.

Constraints: preserve dual-theme structure, source/evidence links, stable Concept/Candidate/Membership/Relation identity, immutable snapshots and revisions, current format 8 with format-4/5/6/7 restore compatibility, keyboard access, explicit loading/error/empty/disabled states, and 1280px desktop geometry. The relation view must never use proximity or decorative edges as semantics; only current formal relations appear in Concept detail, with an explicit link to the neighbor and a reversible removal control.
