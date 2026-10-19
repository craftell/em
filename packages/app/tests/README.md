# App browser checks

With workspace dependencies and Chromium already available, run offline checks from the repository root:

```sh
pnpm --filter @emviz/app^... build
pnpm --filter @emviz/app build
pnpm --filter @emviz/app test:browser
```

The suite starts Vite on an available loopback port and drives the full app in Chromium. Model, validation and diff requests are intercepted with local fixtures. Clipboard writes are captured in the page. No project server or cloud service is needed.

Coverage includes compact counts (0, 1, 3, 4, 100), stable diagram geometry and zoom, direct details, all-scenario lists, same-named scenarios and slices, keyboard access, focus restoration, source/reference/context copying, global search and history, long content, narrow screens, panel scrolling, and normal node inspection.

The separate unit suite remains `pnpm test`. Name-filter coverage includes trimmed case-insensitive substrings, name-only and slice-only matching, empty results and clearing, definition order, duplicate selection, keyboard round trips, scroll restoration, and reset on slice switches. Standalone checks use the existing Export menu on the built app, stop that server, and open the saved file with 4 and 100 scenarios while checking that no HTTP requests occur. Real graph diffs are exercised in both the live app and saved HTML: filtered counts and order, hidden added/removed/changed cases, old/new content, panel-only search and stable geometry. Build the app again after changing production code before running browser checks.

The saved HTML (4/100 cases) and both live/saved diff inputs also run the same keyboard round trip: Enter opens the overview list, Tab reaches search and a hidden result, Enter returns to the list, and Escape restores the opener. Assertions check visible focus outlines, actual list/detail scroll offsets at a 600px viewport, and unchanged summary text, node coordinates, pan and zoom after each step. The four-case list does not require scrolling; the 100-case and diff lists do. This exercises AC06/AC08.

Diff checks also compare the merged order with explicit input-derived IDs, assert remaining counts for every filter, and verify structured When content and reference/source identity while switching versions. Each selection checks that the summary and diagram geometry remain unchanged.

## Feature timeline journey

`tests/timelines.browser.mjs` runs the feature timeline journey against a disposable project. It copies this repository's `event-model/` into a temporary Git repository, installs the sample feature file from `docs/examples/`, starts the built CLI (`emviz open`) and drives Chromium with Playwright. It needs the built CLI and app, so build everything first.

```sh
pnpm build
pnpm --filter @emviz/app test:browser:timelines
```

Set `EMVIZ_EVIDENCE_DIR` to keep evidence outside the worktree. The default is `artifacts/timelines` (ignored by Git). Each run writes a video, a trace, numbered screenshots, ARIA snapshots, `checks.json`, `verification.json`, `terminal.json` and `doctor.json`. The trace holds the session token, so do not share it.

Covered: timeline selection, sibling stacking, successor placement, a join step after two predecessors, rapid selector changes, selection and search limits, Details navigation outside the timeline, actor filtering, `after`-only edits (canonical and rendered edges unchanged), session diff (selector disabled, all stories, layout notice), feedback on a feature-file slice, invalid files (schema version, missing step, cycle, repeated story, repeated slice, duplicate feature ID, incomplete header), removal of the feature file, and standalone export reopened from `file://` (live and diff) with no HTTP requests.

## Canvas navigation regression

`tests/navigation.browser.mjs` is the new regression entry point:

```sh
pnpm build
pnpm --filter @emviz/app test:browser:navigation
```

Status for this change: authored, not executed. The historical results below
do not establish a pass for these interactions. See the
[canvas navigation verification journey](../../../.agents/skills/verify-emviz/features/canvas-navigation.md)
for the full acceptance checklist and report the actual automated coverage
separately from manual, operating-system, and physical-trackpad checks.

Required checks include:

- Auto (default) intra-slice edges, every incident cross-slice edge for a selected
  slice, and only incident cross-slice edges for a selected ordinary node;
  Intra-slice only and All overrides.
- Canonical incoming/outgoing sidebar connections in every display mode.
- Per-story counts and accordion controls, Expand all stories / Collapse all
  stories, project-and-timeline-scoped stable-ID persistence, and safe fallback
  for malformed or unavailable localStorage.
- Collapsed-story proxy edges derived from actual domain edges, never timeline
  `after` chronology.
- Unchanged viewport after selection, search/history, connection clicks/hover,
  and story toggles; explicit Focus selected node centers a selected target or
  its collapsed story summary.
- Space-drag over nodes/edges with editable exclusions and keyup/blur cleanup;
  vertical wheel pan, Shift horizontal pan, cursor-centered macOS Cmd+wheel and
  Windows Ctrl+wheel zoom, two-axis trackpad pan and pinch, and unaffected sidebar
  scrolling.
- Meaningful regression paths in Current, diff views, and offline exports.

When a browser assertion compares all rendered domain edges, first choose
**All** in **Edge visibility** and expand stories. The default Auto mode and
collapsed summaries intentionally change rendered edges without changing the
canonical graph. The existing timeline `after`-only checks must keep comparing
canonical endpoints too, rather than passing because those edges are hidden.

After implementation changes, rerun the existing browser and timeline suites
against a fresh build. Never present this checklist, a synthetic event test,
or a prior-release pass as a real-device verification.

## Connection identity regression

The live and saved-HTML suite now parses actual YAML with 12 slices sharing command, query, and scenario names. It verifies direct incoming/outgoing neighbors, navigation to the correct source file, copied connection context, unique canvas IDs, deduplicated references, and disconnected GWT nodes. Hand-built graph fixtures alone cannot catch parser-generated ID collisions.

The parser suite checks both disk and browser loading with 40 same-named definitions, colliding slugs and paths, duplicate references, repeated GWT names, missing event references, and legitimate cross-slice event consumption. The graph suite also verifies that diff views keep removed edges attached to the correct source file when slice titles and command names repeat.

## Local implementation check (2026-09-14)

Existing production edits were retained. This pass strengthened input-derived diff ordering, remaining counts, structured old/new content, source identity, and duplicate/removed-ID collision checks in both live and exported views.

- `rtk proxy pnpm --filter '@emviz/app^...' build` and `rtk proxy pnpm --filter @emviz/app build`: passed. Vite reported the existing >500 kB bundle advisory.
- `rtk proxy pnpm --filter @emviz/parser --filter @emviz/graph --filter @emviz/validator --filter @emviz/app check`: passed.
- `rtk proxy pnpm --filter @emviz/parser --filter @emviz/graph --filter @emviz/validator --filter @emviz/app test`: 25 tests passed (parser 4, graph 5, validator 2, app 14).
- `rtk proxy pnpm --filter @emviz/app test:browser`: all 7 tests present at that point passed, including the strengthened export/diff assertions.
- After adding the collision scenario, `rtk proxy node --test --test-name-pattern='diff duplicate names' tests/gwt.browser.mjs` from `packages/app`: the additional test passed in live and saved modes.
- `rtk git diff --check`: passed. The Git index remained empty.

These are implementation checks, not independent verification or review approval. No dependencies were installed and no external service was accessed.
