---
version: 1
slug: "src-client-record-detail-page-tsx"
primary_target: "src/client/record-detail-page.tsx"
related_targets: ["src/client/record-detail.css"]
---

Scope and mode: record detail route; read and verify.

Audience and job: a single user revisiting saved material to understand the extracted knowledge, verify it against the preserved source, and decide whether to correct, exclude, or reorganize it.

Primary task and proof: knowledge points lead; selecting one reveals its exact evidence in the source with a matching index. Editing, history, and reorganization remain available in a sticky top action strip. The original text and evidence version are the trust proof.

Chosen direction: knowledge-first verification canvas with a narrow workspace rail and top command bar. The memorable moment is the selected point and source evidence sharing one numbered signal.

Important state: when no knowledge exists, remove the knowledge column and use a unified reading canvas with a compact “仅保存原文” module explaining searchability, non-destructive AI organization, and the next action.

Constraints: preserve all current behaviors, theme switching, history, corrections, archive/delete, candidate comparison, accessibility, and the unchanged home graph behavior.
