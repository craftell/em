# emviz verification map

The core feedback journey and all 17 app browser cases passed on 2026-10-18 at `d8cb291`. See the [verification skill](../SKILL.md) for retained evidence. Real-server actor and two-machine remote-access journeys remain unexecuted.

The [verification skill](../SKILL.md) owns launch, doctor, evidence, and cleanup. Read it before driving a feature.

## Preconditions

Use the disposable Orders fixture created by `packages/app/tests/feedback.browser.mjs`. It contains **PlaceOrder**, **OrderStatus**, **OrderPlaced**, and **Duplicate order**. Use the URL, token, PID, project path, and current node IDs returned by that run.

Never share a fixture, agent ID, port, or browser profile between verification runs. A run must not attach to an existing user session.

## Features

- [Select model context](select-context.md) covers ordinary nodes, GWT details, and stable source identity.
- [Send feedback and receive a reply](feedback.md) covers Details and Agent tabs, an unsent per-node Queue, explicit batch Send, and the external CLI loop.
- [Review session and turn changes](review-diffs.md) covers current files, fixed baselines, and frozen turn snapshots.
- [Stop, resume, close, and export](session-lifecycle.md) covers lifecycle controls and read-only standalone files.

- [Inspect actor tags and filtered flows](actors.md) covers registry metadata, OR selection, bounded system context, and frozen diff/export values. This journey is unexecuted.

- [Access from another private-network machine](remote-access.md) covers explicit IP binding, authenticated browser bootstrap, Host and Origin rejection, and remote cleanup. This journey is unexecuted.

- [Inspect feature timelines](feature-timelines.md) covers branch and join layout,
  timeline selection, actor filtering, legacy compatibility, validation, diff,
  and offline export. It was executed on 2026-10-19 on top of `ec87e4a` and passed, and passed
  again at `0c746e7` for the emviz 0.6.0 release candidate; run it with `pnpm --filter @emviz/app test:browser:timelines`.

- [Inspect connections and navigate the canvas](canvas-navigation.md) covers
  Auto/Intra-slice only/All edge visibility, canonical sidebar connections, story
  accordions and project/timeline-scoped persistence, domain-only proxy edges,
  explicit focus, stable selection viewports, and mouse/trackpad input. This
  journey passed 19 Chromium cases on 2026-10-19 at `af8f7c8`, including the
  original nine cases and toolbar/sidebar reachability checks. A separate
  built-CLI Chrome pass confirmed core controls against a disposable project.
  Run `pnpm --filter @emviz/app test:browser:navigation` with
  `EMVIZ_EVIDENCE_DIR` set to retain fresh captures. Physical-device and native
  Safari paths remain unexecuted; see the journey's coverage and gap lists.

## Proof reporting

Record each entry point you exercised. The real-server script covers search selection, an unsent queue across reload, a two-node batch and a GWT turn without `crypto.randomUUID`, diff review, stop, resume, close, and export. The fixture-driven suite also checks Edit, Remove, and exact retry after a failed response and reload. The existing GWT browser suite covers additional list, keyboard, and canvas paths with fixtures.

A pass through one entry point does not verify all entry points. Report missing preconditions and skipped paths. Keep screenshots, video, trace, CLI output, and file contents outside the disposable project.
