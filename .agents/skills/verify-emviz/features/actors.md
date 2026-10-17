# Inspect actor tags and filtered flows

DRAFT. The actor browser journey, screenshots, video, and trace have not been run or captured for this change.

Read the [verification skill](../SKILL.md). Use an isolated fixture. Do not attach to an existing user session.

## Fixture

Create an actors registry with Visitor and Support, distinct quoted hex colors, and display names. Give one user screen both actors and another only Support. Keep a third screen unassigned.

Connect the first screen's slice through an event to a system slice, then through another event to a second system slice. Add GWT cases to the first slice. Leave both processors without actors.

## Browser journey

1. Open **Actors** in the toolbar. Confirm that both actor names and their color markers appear.
2. Select Visitor. Confirm that the matching user slice, its GWT cases, and its event endpoints remain visible.
3. Confirm that the first system slice has a **Related** label and no actor chip. Confirm that the second system slice stays hidden.
4. Add Support. Confirm OR selection includes the Support screen.
5. Select **Unassigned screens** and verify that it matches only unassigned user screens.
6. Clear the selection. Confirm that the full graph returns and node positions match the initial positions.
7. Combine actor selection with a diff filter. Confirm that existing hidden nodes stay hidden and no line has a hidden endpoint.
8. Change an actor ID on a screen. In the diff view, select either the old or new actor and find the changed screen.
9. Change the registry's display name and color. Confirm that **Old version** retains old values and **New version** shows the new values.
10. Export a standalone HTML file. Stop the owned server, open the file, and repeat actor selection.

## Data checks

- Run the parser, validator, graph, and CLI unit suites. Check registry absence, empty registry, custom path, invalid references, and system actor rejection.
- Confirm that a registry-only edit changes the live snapshot revision.
- Complete a feedback turn after a registry edit. Make another registry edit and confirm that **Turn diff** stays frozen.
- Import a legacy project without a registry and confirm that existing actor IDs still appear.

## Evidence

Run the actor regression in `packages/app/tests/gwt.browser.mjs` through the app browser suite. The fixture-driven suite does not replace a real-server feedback journey.

Capture the initial graph, Visitor selection with its related processor, old and new tags, and the standalone export. Save matching ARIA snapshots, video, trace, commands, and exit codes outside the fixture directory. Mark any unexecuted path explicitly. Do not remove this draft label until the real journey and evidence checks pass.
