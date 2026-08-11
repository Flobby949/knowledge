---
version: 1
slug: "src-client-concepts-page-tsx"
primary_target: "src/client/concepts-page.tsx"
related_targets: ["src/client/concepts-page.css","src/client/concept-candidates-panel.tsx","src/client/concept-candidates-panel.css","src/client/concept-relations-panel.tsx","src/client/concept-relations-panel.css","src/client/ai-task-pulse.tsx"]
---

Scope and mode: Concept workspace route; organize, maintain, and review.

Audience and job: a single user promotes trustworthy knowledge groupings into durable definitions, maintains exact Membership history, and confirms only useful semantic connections between stable Concepts.

Primary task and proof: the route has three explicit, query-addressable views. The formal catalog leads with each definition, current Memberships, directly confirmed relations, and navigable neighbor Concepts. The AI Candidate inbox freezes recalled Knowledge Points for editable promotion. The Concept Relation ledger offers one global scan, separate pending/resolved sections, a side-by-side comparison of both frozen definitions, editable six-type/description confirmation, rejection, needs-review state, revocation, and removed history. Neither AI flow writes a formal Concept or Concept Relation without a user decision.

Chosen direction: one compact catalog-and-assembly workbench. Formal Concepts use the definition plate and Membership sheet; Candidates use the frozen assembly sheet; Concept Relations extend the same printed-catalog grammar into a narrow relation ledger beside one paired definition proof sheet. Catalog, Candidate, Membership, and Relation codes are navigation coordinates, not domain identifiers.

Important state: manual Concept creation still requires a name, description, and at least two current Knowledge Points. Candidate discovery exposes queued through rejected outcomes without asking for recall scope. Relation scanning considers at most 100 active Concepts and returns only suggestions; pending confirmation is disabled when either archived state, current Concept Revision, or effective Membership fingerprint differs from the frozen input. Confirmed relations remain visible as needs-review history after endpoint change, and revocation preserves confirmation/source identity.

Constraints: preserve dual-theme structure, source/evidence links, stable Concept/Candidate/Membership/Relation identity, immutable snapshots and revisions, current format 8 with format-4/5/6/7 restore compatibility, keyboard access, explicit loading/error/empty/disabled states, and 1280px desktop geometry. The relation view must never use proximity or decorative edges as semantics; only confirmed direct relations appear in Concept detail, with an explicit link to the neighbor and a reversible removal control.
