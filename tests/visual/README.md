# Visual validation matrix

This suite treats the written product documents as the source of truth. When a
direction image and the documents disagree, `DESIGN.md` and
`docs/FRONTEND-BRIEF.md` win; the image is only visual direction.

| Slice | 1600 × 1000, DPR 1 Chrome baseline | 1280 × 800 geometry smoke |
| --- | --- | --- |
| Home | neural tag field, focused candidate HUD | fixed 60 px navigation and viewport fill |
| Records | 12 deterministic cards and true four-column masonry | responsive four-column masonry |
| New modal | filled editor, selected tag and review handling | centered 1120 × 700 dialog with 64/36 panes |
| Detail | selected knowledge point and exact evidence highlight | 58/42 independently scrollable panes |
| Review | queue, evidence highlight, workspace and flow bar | 58/42 workspace plus queue/flow geometry |
| Search | deterministic result with push drawer open | 480 px drawer that pushes the result stage |
| Tags | equal-size atlas cards with aggregate record drawer | responsive atlas and 480 px push drawer |
| Settings | single-page model/data console, review default and analysis Prompt | full-width console with equal model columns |

The fixture enters through the public restore and settings APIs and stubs only
the external model boundary with `E2E_FAKE_AI=1`. It never reads or writes a
paid model key. The visual server truncates and reseeds the isolated
`knowledge_e2e_visual` database before every run.

Run the matrix with:

```sh
node_modules/.bin/playwright test --config playwright.visual.config.ts --project=chrome
```

Only update a baseline after its semantic and geometry assertions pass and the
new screenshot has been compared with the written design contract. Snapshot
updates are intentionally explicit:

```sh
node_modules/.bin/playwright test --config playwright.visual.config.ts --project=chrome --update-snapshots
```
