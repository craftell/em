# Inspect feature timelines

Status: draft, unexecuted. No browser screenshots, video, or trace establish this
feature's behavior yet. Earlier feedback evidence does not cover timelines.

## Sub-features

- One feature file contains local stories and multiple timeline presentations.
- Stories after the same predecessor have no ordering constraint between them.
- Multiple predecessors place a story after both without creating domain edges.
- Timeline selection and actor filters preserve the selected model context.
- Diff views retain all stories, including removed elements.
- Standalone export retains timeline data and controls.
- Legacy YAML and invalid version or reference diagnostics remain visible.

## How to get to it (user POV)

Use a disposable copy of this repository's Event Model.
Do not modify the operator's working model.

1. Copy `event-model/` and `.event-modeling/config.yaml` into a fresh temporary project.
2. Copy `docs/examples/customer-onboarding.feature.yaml` from the checkout to
   `event-model/features/customer-onboarding/customer-onboarding.feature.yaml`
   inside that temporary project.
3. Remove `event-model/stories/customer-onboarding.yaml` only from that copy.
   Its stories now come from the feature file. Keep the slice files.
4. Initialize a Git repository in the disposable project and commit the fixture
   if session and Git diff checks will be exercised.
5. Build the checkout with `pnpm build`.
6. Run the built CLI's `open` command with the disposable project path:
   `node packages/cli/dist/index.js open "$PROJECT"`.
7. Retain the returned viewer URL, server URL, PID, and token.
   Follow the verification skill's doctor check before browser actions.

Open the returned viewer URL. The toolbar selector has accessible name
**Timeline**. The sample provides **Onboarding overview** and **Customer view**.
Use **All stories** to return to the unrestricted overview.

## Driving it with Playwright

Use a fresh browser context with video recording.
Start a trace with screenshots and snapshots before opening the viewer.
Drive controls through their accessible labels. Do not inject internal app state.

1. Find the selector with `getByLabel("Timeline", { exact: true })`.
   Select the option whose displayed timeline name is **Onboarding overview**.
   Read its actual option value from the DOM rather than constructing an internal ID.
2. Capture the canvas and ARIA snapshot.
   Confirm **Register customer** precedes both **Send welcome email** and
   **View customer home**. The two successor story groups must not overlap.
   Confirm no layout-only edge connects those two stories.
3. Select **Customer view**. Confirm registration and home appear, while the
   welcome-email story is absent. Select **All stories** and confirm the other
   legacy story examples remain available.
4. Select **Onboarding overview** again. Use **Actors** to filter a user-screen
   actor from the fixture. Confirm the selected timeline still bounds the view.
   Clear the actor filter and confirm the timeline layout returns.
5. In the disposable feature file, add a fourth story named **Start subscription**
   with local ID `subscription`, referencing
   `event-model/features/subscription-checkout/start-subscription/start-subscription.slice.yaml`.
   Add an overview step `subscribe` with `story: subscription` and
   `after: [email, dashboard]`.
   This deliberately tests a visual join, not a business prerequisite.
6. Refresh through the UI. Select the overview again.
   Confirm the subscription story starts to the right of both predecessor groups.
   Capture the action, resulting layout, and changed YAML.
7. Change only the `after` array and compare domain connections before and after.
   Existing screen, command, event, and query edges must retain their endpoints.
   A layout change must not invent a causal edge.
8. Open **Agent**, then **Session diff**. Confirm the timeline selector is disabled
   and all stories remain available. Return to **Current** and select the overview.
9. Use the toolbar export action. Open the exported HTML in a separate page.
   Confirm both timeline options, branch placement, and actor filtering work
   without the project server. Preserve the exported HTML with the evidence.

For invalid input, make one change at a time in the disposable feature file,
refresh, and inspect the validation drawer. Restore the valid file between cases:

- Set `schema_version: 999`. Expect an F1 finding, not a silently accepted format.
- Set one `after` reference to `missing-step`. Expect an F1 finding and the
  affected timeline to be unavailable.
- Make `register` follow `email`, which already follows `register`.
  Expect a layout-cycle finding.
- Repeat a story in the same timeline. Expect an F1 finding.
- Repeat a slice through two different stories in the same timeline.
  Expect an F1 finding.
- Copy the feature file without changing its root ID. Expect a duplicate-ID finding.
- Add `kind: slice` and `schema_version: 1` to a legacy slice, then remove only
  `schema_version`. Expect an incomplete-header finding.

Finally, remove the feature file from the temporary project and restore its
original legacy story file. Reload and confirm the original story appears
without requiring new headers.

## Gotchas

The sample lives under `docs/examples/`; the parser does not discover it there.
It must be copied under the configured features directory.

The sample's slice paths are relative to the project root. Copying only the
feature file into an empty project does not produce a usable fixture.

The sidebar needs to be wide enough to expose Agent controls. A missing control,
empty fixture, or overlapping layout is a failed check, not a skipped assertion.

Timeline selection is disabled during diff views. Record that limitation rather
than claiming historical timeline selection was tested.

No ready-made executable timeline browser journey is included here.
Implement these actions in the existing Playwright setup or drive them with an
available browser tool. Record the exact commands and selectors used.
Static source inspection and unit tests cannot replace the browser evidence.

Keep screenshots for the branch, join, selected timeline, actor-filtered view,
diagnostic, diff, and exported HTML. Retain ARIA snapshots, trace, recording,
revision tested, CLI output, and before-and-after YAML outside the fixture.
Inspect artifacts for tokens before sharing them.

Follow the parent skill's stop and close procedure for the exact owned server.
Confirm the server stopped and the evidence survived before deleting the
disposable project. Do not delete the operator's checkout or existing sessions.
