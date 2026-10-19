# Open screen design links

DRAFT. This journey and the companion skill eval cases are authored but
unexecuted. No browser run, screenshot, trace, or agent-evaluation pass is
claimed here.

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

The authored browser entry point is:

```sh
pnpm --filter @emviz/app test:browser:links
```

Run available repository checks and skill validation in an authorized execution
environment. Record the exact revision, command, exit code, and covered steps.
A fixture test does not prove every manual step above.

Retain screenshots of the node icon, sidebar link, and keyboard focus;
matching ARIA snapshots; a trace; new-tab destination and opener assertions;
and selection and viewport assertions. Keep the exported HTML and before/after
fixture values outside the disposable project. Redact credentials and private
URLs before sharing evidence.

Keep this draft label until the corresponding browser journey has actually
run. Record partial passes and unexecuted paths separately.
