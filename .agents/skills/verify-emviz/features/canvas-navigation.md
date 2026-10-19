# Inspect connections and navigate the canvas

Status: 19 Chromium regression cases passed on 2026-10-19 at `af8f7c8`, including
all original nine cases. A separate real-server `chrome-devtools-axi` pass used
an owned disposable three-story project. Physical trackpads, real macOS/Windows
systems, and native Safari gestures were not tested. The checklist below remains
the acceptance plan, not a claim that every platform and device path passed.

## Executed coverage

- Chromium checked Auto, Intra-slice only, All, all incident edges for a selected
  slice, node-only cross edges, and canonical sidebar connection navigation.
- Story checks covered individual and all-story controls, proxies, reload,
  independent same-name legacy headers, explicit collapsed focus, stable-ID
  rename, project/timeline scope, and malformed/invalid/unavailable storage.
- Input checks covered Space-drag over a node and edge-label button, keyup,
  synthetic window blur, normal clicks afterward, wheel/Shift-wheel/two-axis
  pan, Ctrl-wheel zoom, native keyboard buttons, text input and sidebar scroll.
- Meta-wheel and Safari-style gesture events were dispatched synthetically in
  Chromium. Cursor anchoring was checked numerically, within one graph unit to
  allow the browser's subpixel viewport rounding. These are not device tests.
- Current and diff standalone exports retained modes, proxies, selection and
  two-axis wheel pan without HTTP requests. Every gesture was not repeated in
  each export or diff state.
- Toolbar/sidebar access passed at 1440, 1280, 1024 and 680px. Open Actors choices
  remained usable while normal sidebar clicks worked and the viewport transform
  stayed unchanged.
- The real-server Chrome pass confirmed canonical endpoints, selection-aware
  Auto, all three modes, collapse/reload, a chronology-only unconnected story,
  timeline preference isolation, and explicit focus on a collapsed summary.

Evidence is under
`/home/kfukuyama/fm-homes/personal/data/emviz-canvas-navigation/`.
The successful navigation run is
`final-navigation/navigation-2026-10-19T08-28-57-057Z/`, with `captures.json`,
numbered screenshots, ARIA snapshots, viewport JSON, and per-page videos.
`chrome-*.json`, `actor-popover-hit-fixed.json`, `final-real-navigation.json`,
`final-expanded.png`, `final-collapsed.png`, and `actor-popover-fixed.png` record
the separate built-CLI pass. `navigation-journey.mp4` joins the actual Chromium
recordings for selection, modes, collapse, Space-drag, and wheel gestures.
Earlier failed iterations are retained and are not passes.

The existing app suite's old same-name YAML case used forced clicks on offscreen
nodes and failed with the same symptom on clean `main` at `4e27ddd`. Its harness
now selects by source-scoped search through visible controls. The two actor cases
passed on clean main, exposed a product regression here, and were not edited.
The corrected app suite passed all 17 cases. The final checks were:

```sh
pnpm check
pnpm test
pnpm skills:validate
pnpm --filter @emviz/app test:browser:navigation
pnpm --filter @emviz/app test:browser
pnpm --filter @emviz/app test:browser:timelines
node --test packages/app/tests/feedback.browser.mjs
```

The unit run passed 300 tests. Navigation passed 19, the app suite passed 17,
and both real-server journeys passed. Twelve shared reference copies matched.
These results cover production commit `af8f7c8` plus the app-suite search
harness correction. Agent evals were not run.

Read the [verification skill](../SKILL.md) for launch, doctor, evidence, and
cleanup. Use disposable fixtures and an owned server or the browser suite's
intercepted fixtures, never an operator's live model.

## Run it

Build the final app before running browser checks:

```sh
pnpm build
EMVIZ_EVIDENCE_DIR=/path/outside/the/checkout \
  pnpm --filter @emviz/app test:browser:navigation
pnpm --filter @emviz/app test:browser
pnpm --filter @emviz/app test:browser:timelines
```

Build before starting the browser suites, not concurrently with them.
The navigation entry point creates isolated intercepted fixtures. The feedback
and timeline entry points use their own real-server disposable projects.

Run the applicable unit, type, and skill checks too. Record the exact revision,
commands, outcomes, and remaining gaps. A browser suite pass does not prove real
trackpad or both operating-system behaviors unless those paths were exercised.

## Fixture requirements

Use at least three stories and several slices. Include a slice with incoming
and outgoing cross-slice edges on more than one child node, a cross-story
domain connection, and a timeline `after` relation between stories with no
domain connection. Include two timelines sharing stable story IDs and a second
project for persistence isolation. Duplicate display names help prove that
identity does not depend on labels. Preserve source paths and actual node IDs.

Read canonical graph edges before testing. Record the canvas viewport transform
(pan and zoom) before each selection or accordion action. Use real UI controls
for actions; do not set internal application state to manufacture a result.

## Edge visibility and canonical connections

The global selector has accessible name **Edge visibility**.

1. Start with all stories expanded, no selection, and **Auto** selected.
   Confirm intra-slice edges are visible and cross-slice edges are hidden.
2. Select a slice by its real canvas ID. Confirm every eligible incoming and
   outgoing cross-slice edge incident to that slice is visible, including edges
   on children other than the first one. Unrelated cross-slice edges stay hidden.
3. Select an ordinary child node. Confirm Auto reveals only that node's incident
   cross-slice edges, in addition to intra-slice edges.
4. Choose **Intra-slice only**. Repeat node and slice selection; cross-slice edges
   stay hidden. Choose **All** and verify all eligible domain edges appear.
   Timeline, actor, and diff filters still bound the visible graph.
5. Inspect **Details** in each mode. Incoming/outgoing connection identity,
   source paths, and copied connection context must remain canonical even when
   the corresponding canvas edge is hidden. Hidden edges are not missing YAML.
6. Hover a connection and select nodes from the canvas, search, and Back/Forward
   history. Assert that the viewport transform does not change. A selected
   off-screen node must still appear in Details.
7. Activate **Focus selected node**. This explicit action may center the target.
   Do not count a selection-only action as a successful focus action.

For a full rendered-edge comparison after a YAML edit, choose **All** and expand
stories first. Otherwise Auto and collapsed summaries intentionally change the
visible edge set without changing the canonical graph.

## Story accordions and proxy edges

Story toggles have accessible names **Collapse {story name}** and
**Expand {story name}**; scope duplicate names by their actual story ID.
The toolbar provides **Expand all stories** and **Collapse all stories**.

1. Check each header's slice count against the fixture. Collapse one story using
   its header control, verify its summary and hidden contents, and expand it.
   Repeat with the keyboard and confirm the toggle's expanded state is accurate.
2. Use both toolbar controls. Check all stories in the current view, including
   a story not initially inside the viewport.
3. Record pan and zoom before each toggle. Individual collapse, expansion,
   Collapse all stories, and Expand all stories must not move the camera.
4. In **All**, collapse endpoints of a real cross-story connection. Verify
   visible proxy connections map to actual canonical domain edges, without
   dangling endpoints or invented self-loops. Expand and verify the original
   endpoint identities return.
5. Verify that a pair connected only by timeline `after` has no proxy edge.
   Change only `after` in the disposable fixture and repeat. Neither canonical
   edge identity nor proxy connectivity may acquire a chronology-only edge.
6. Repeat with Auto and Intra-slice only to ensure collapsing a story does not
   bypass the selected edge mode.
7. Select a node, collapse its story, and activate **Focus selected node**.
   The explicit focus should center the collapsed story summary; unrelated
   collapsed stories must remain collapsed. Verify Details still identifies
   the canonical selected node.

## Preference persistence and isolation

Collapse preferences are browser-local, scoped by project plus selected
timeline (including **All stories**) and stored using stable IDs.

1. Collapse one story, reload, and confirm the same story is collapsed.
2. Change only story and timeline display names in the disposable fixture,
   refresh, and confirm the preference remains tied to the same IDs.
3. Switch to another timeline, change its collapsed set, and switch back.
   Verify each scope restores its own set. Repeat with All stories.
4. Open a second project with overlapping story/timeline IDs. Verify preferences
   do not leak between projects. Refresh each project and recheck.
5. Use a storage fixture to supply malformed JSON or an invalid saved value,
   then reload. The viewer must render with safe defaults and usable toggles.
   Also test storage reads and writes throwing or being unavailable. Storage
   fault injection is permitted; injecting successful app state is not.
6. Remove a saved story from the disposable model and refresh. Stale IDs must
   not prevent the remaining stories from rendering or toggling.
7. Repeat meaningful controls in diff views and offline exports. Do not assume
   browser storage works for `file://`; storage failure must remain harmless.

These checks do not authorize modifying the operator's browser preferences.
Use isolated browser contexts and restore or discard only the fixture storage.

## Pan, zoom, and input boundaries

Check viewport changes numerically as well as visually. For cursor-centered
zoom, compare the graph coordinate beneath the pointer before and after zoom.

1. Hold Space and drag from the canvas, a node, and an edge. Each pans the
   viewport without dragging model nodes or turning the gesture into selection.
   Release Space and verify ordinary node selection works again.
2. Release Space outside the canvas, then repeat after the window loses focus.
   Pan mode must clear on keyup or blur; it must not remain stuck after returning.
3. Focus search, the feedback textarea, an input/select, and editable content.
   Space must retain its normal editing/control behavior, not activate canvas
   panning. Verify ordinary feedback typing and keyboard actions still work.
4. Over the canvas, plain mouse-wheel input pans vertically. Shift + wheel pans
   horizontally. Check both directions and ensure zoom remains unchanged.
5. On macOS, Cmd + wheel zooms around the cursor. On Windows, Ctrl + wheel does
   the same. Check zoom limits and repeated alternating zoom/pan gestures.
6. Verify two-axis trackpad scrolling preserves horizontal and vertical deltas.
   Verify pinch zoom is cursor-centered. Synthetic wheel-event checks must be
   labeled as synthetic; record real-device testing separately.
7. Scroll a long right sidebar and its nested lists. Only the intended panel
   should scroll; canvas pan and zoom must stay unchanged. Recheck after focus,
   mouse movement between panel and canvas, and repeated gestures.
8. Repeat the core path in standalone HTML without network requests. Confirm
   the exported viewer retains edge modes, story controls, and input boundaries.

## Remaining gaps

The browser run did not separately prove every checklist permutation. Untested
paths include real window-focus loss, pointer-release outside the browser,
physical pinch/two-finger hardware, Safari's native event stream, removing and
re-adding saved story IDs, persistence on every file-origin/browser combination,
and every gesture under each timeline/actor/diff filter. The full real-server
actor-registry and two-machine journeys keep their draft labels. Agent evals
are authored expectations only; no documented cheap runner was found or run.

## Evidence and reporting

Retain before/after screenshots, ARIA snapshots, trace or action log, measured
viewport transforms, actual graph endpoint IDs, and the tested storage scopes.
Include canonical YAML for domain-versus-`after` assertions. Keep artifacts
outside the disposable model, inspect them for credentials before sharing, and
follow the parent skill's cleanup procedure.

Report authored expectations, automated checks actually run, manual checks
actually run, and skipped platform/device paths separately. Do not reuse the
2026-10-18 or 2026-10-19 release evidence as proof of this new interaction model.

Browser imports without an explicit model ID receive a new preference scope on each import, even when filenames match. Exported HTML retains that import identity and its reload preferences when browser storage is available. Supply a stable model ID in the graph sidecar to retain the scope across reimports.
