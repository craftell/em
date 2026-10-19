# Select model context

Select a graph node to inspect its current reference, source file, and connected nodes before sending feedback.

## Sub-features

- `select-command` opens an ordinary command.
- `select-gwt` opens the actual GWT scenario rather than its summary card.
- `select-source` shows the source path and canonical slice YAML.
- `select-copy` copies a captured node reference.
- `select-without-moving` preserves the viewport across canvas, search, history,
  and connection selection; explicit **Focus selected node** centers the target.

## How to get to it (user POV)

- Click a node on the canvas.
- Search by node name in **Search event model** and select its result.
- Click a GWT scenario in its summary.
- Open **All scenarios** from GWT details and choose a scenario.

## Driving it with Playwright

Preconditions:

- Doctor confirms the owned Orders fixture.
- **Current** is selected.
- The initial model snapshot contains command and GWT node IDs.

- **Search.** Fill `page.getByLabel("Search event model", { exact: true })` with `PlaceOrder`. Click `page.locator(".search-results").getByRole("button", { name: "PlaceOrder command", exact: true })`. The complementary region named **Node details** contains `event-model/features/orders/place-order.slice.yaml`.
- **Canvas.** Click `page.locator('.react-flow__node[data-id="' + command.id + '"]')`. The same source and reference appear. Use the ID read from the real model, not an assumed slug.
- **GWT.** Search `Duplicate order` and click the exact result `Duplicate order gwt`. Details show the description and Given, When, and Then. Open **All scenarios**, then click the exact scenario button in `page.getByRole("complementary", { name: "GWT scenarios" })`.
- **Viewport (new, unexecuted).** Record the canvas pan/zoom transform before selecting by canvas, search, Back/Forward history, and incoming/outgoing connection. Assert each selection changes Details without moving the camera. Hovering a connection must also preserve the transform. Use **Focus selected node** for deliberate centering; if its story is collapsed, focus the story summary without expanding unrelated stories. An outside-timeline connection may switch to All stories without automatically fitting. See the [canvas navigation journey](canvas-navigation.md) for edge modes, collapse persistence, and gestures.
- **Copy.** In **Node details**, open the summary containing **Copy for LLM**. Click the button named **Reference Stable em:// node handle**. Read the clipboard through an approved browser clipboard capability and compare it with the visible reference.
- **Evidence.** Capture the action in a trace, then save the details screenshot and ARIA snapshot. Compare the displayed source YAML with the fixture file.

## Gotchas

- The seeded fixture has one GWT scenario. A **+ more** control requires a larger fixture and is not covered by this fixture.
- Ordinary node labels can repeat across slices. Use IDs from the same snapshot together with source paths to verify identity. IDs can change when names collide.
- A diff can contain removed nodes. Select **Current** before checking editable feedback context.
- Clipboard access may need browser permission. Report that path as unverified if the permission is unavailable.

The new viewport checks above are authored requirements, not covered by the
historical feedback run. Record them separately when actually executed.
