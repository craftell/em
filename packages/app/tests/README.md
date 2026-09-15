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
