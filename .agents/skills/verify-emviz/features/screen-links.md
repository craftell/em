# Open screen design links

Executed on 2026-10-19 on top of `92bb9bb` plus the parser fix in this PR
(`https://host?x=a@b` and `https://host#@x` were wrongly rejected). The real-server
journey script passed all 13 checks, and `pnpm --filter @emviz/app test:browser:links`
passed 4 of 4 cases. The companion skill eval cases are authored only; no agent
evaluation has run. Evidence is retained outside the checkout at
`/home/kfukuyama/fm-homes/personal/data/screen-reference-links/journey-final/2026-10-19T12-25-47-160Z-14bc91ef/`.

Read the [verification skill](../SKILL.md). Use an isolated project and a
dedicated browser profile. Do not attach to an existing user session.

## Fixture

Create user screens with and without `screen.url`. Keep a system processor
without a URL. Use controlled HTTP and HTTPS pages as external destinations.
Include a Figma URL without depending on access to a private Figma file.

Do not use real private design URLs or credentials in committed fixtures or
shared screenshots and traces.

## Browser journey

1. Open the model. Record the viewport transform and selected node.
2. Confirm that the link icon appears at the top-right of screens with URLs.
   Confirm that screens without URLs and processors have no link action.
3. Select a screen through the canvas, search, and history. Confirm that
   selection does not open or fetch the external page.
4. Click the link icon normally. Confirm a new tab opens at the exact configured
   destination with opener isolation. Confirm that the selected node and
   viewport transform have not changed.
5. Tab to the link icon and activate it with Enter. Confirm the same destination
   and unchanged canvas state. Confirm a visible keyboard focus indicator.
6. Open Details for the screen. Activate its reference link with a mouse,
   then with the keyboard. Confirm this separate entry point opens a new tab
   at the same URL without camera movement.
7. Confirm that the Figma destination opens externally and the viewer creates
   no Figma iframe.
8. Repeat normal link clicks at narrow and desktop widths, including a wrapped
   toolbar and expanded Actors controls. Do not force-click.
9. Edit only `screen.url` in the isolated fixture. Inspect the diff and confirm
   that old and new screen details retain their respective URLs.
10. Export standalone HTML. Stop the owned server and open the file.
    Confirm that the URL survives and both link entry points open a new tab.
11. Make the controlled destination unavailable. Confirm that the viewer
    remains usable. Export does not bundle the linked page or remove its
    authentication requirements.

## Data and compatibility checks

- Accept legacy screens without URLs and valid user-screen HTTP or HTTPS URLs
  in project and manual-import modes.
- Reject relative paths, local files, data/javascript/file schemes, arrays,
  objects, null, empty strings, whitespace, control characters, backslashes,
  credentials, and missing absolute authorities.
- Reject `screen.url` on system screens. Check L10 findings with source paths.
- Confirm parser and validator behavior agrees in Node and browser imports.
- Confirm URLs survive graph construction, diff snapshots, and standalone
  export without introducing domain connections.
- Confirm the CLI never fetches or bundles the linked page.

## Execution and evidence

Build first (`pnpm build`), then run the real-server journey from the repository
root:

```sh
EMVIZ_EVIDENCE_DIR=/path/outside/the/checkout \
  node .agents/skills/verify-emviz/scripts/screen-links-journey.mjs
```

The script builds a disposable project under the system temp directory, starts
`emviz open` and `emviz diff` itself, and removes them and the project on exit.
It exits 0 only when every check below passes, and prints the run directory.
`verification.json` lists the passed checks.

| Step above | Script phase |
| --- | --- |
| 1-3, 7 | viewer icons and attributes; no iframe |
| 4 | mouse: new tab, `window.opener === null`, no Referer, selection and viewport unchanged |
| 5 | keyboard: Tab, focus ring, Enter |
| 6 | Details link by mouse and keyboard |
| 8 | 1280 and 680 px widths, expanded Actors, unforced clicks |
| 9 | diff: old and new URLs for changed, added, and removed screens; badge clear of the link |
| 10 | export, close the server, open the file; tampered payload renders no link |
| 11 | destination unavailable: only the new tab fails |

The script reads `L10` findings from the served project snapshot
(`l10-findings.json`) for a `javascript:` URL, a URL with credentials, a relative
path, and a URL on a system screen. It also keeps a valid URL whose fragment contains
`@` (`https://host#section@2`), which an earlier parser wrongly rejected. Other
rejected forms (backslashes, control characters, arrays, null, and so on) are covered
by the parser unit tests, not the journey.

The fixture suite is a separate entry point and does not replace the journey:

```sh
pnpm --filter @emviz/app test:browser:links
```

Retain screenshots of the node icon, sidebar link, keyboard focus, and diff;
matching ARIA snapshots; Playwright videos; `doctor.json`, `l10-findings.json`,
`terminal.json`, `verification.json`, and the exported HTML. Redact credentials
and private URLs before sharing evidence.

Not covered: a real Figma page (the destination is a local server and an
unreachable port), history navigation (step 3 covers search and canvas only),
a trace file, and physical-device input.
