# App browser checks

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @emviz/app^... build
pnpm exec playwright install chromium
pnpm --filter @emviz/app test:browser
```

The suite starts Vite on an available loopback port and drives the full app in Chromium. Model, validation and diff requests are intercepted with local fixtures. Clipboard writes are captured in the page. No project server or cloud service is needed.

Coverage includes compact counts (0, 1, 3, 4, 100), stable diagram geometry and zoom, direct details, all-scenario lists, same-named scenarios and slices, keyboard access, focus restoration, source/reference/context copying, global search and history, long content, narrow screens, panel scrolling, and normal node inspection.

The separate unit suite remains `pnpm test`. Name-filter coverage includes trimmed case-insensitive substrings, name-only and slice-only matching, empty results and clearing, definition order, duplicate selection, keyboard round trips, scroll restoration, and reset on slice switches. Standalone HTML and diff-specific checks belong to ticket 03.
