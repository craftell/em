# Review session and turn changes

The viewer separates the current model, changes since the fixed session baseline, and changes captured for the latest completed feedback request.

## Sub-features

- `diff-current` shows current canonical files.
- `diff-session` compares against the startup Git SHA or labeled snapshot fallback.
- `diff-turn` compares claim-time and reply-time snapshots.
- `diff-versions` exposes old and new node content.
- `diff-frozen` keeps a completed turn unchanged by later file edits.

## How to get to it (user POV)

- Choose **Current**, **Session diff**, or **Turn diff** in **Model view**.
- Select a changed node and choose **Old version** or **New version**.
- Use added, removed, or changed filters in the diff panel.

## Driving it with Playwright and the CLI

Preconditions:

- Complete both feedback requests in [Send feedback and receive a reply](feedback.md).
- The first request changes command fields. The second changes the GWT description.
- The fixture has an initial Git commit.

- **Session.** Click `page.getByRole("group", { name: "Model view" }).getByRole("button", { name: "Session diff", exact: true })`. Both edited nodes appear changed. The baseline label equals the fixture's initial 40-character commit SHA.
- **Versions.** Select **PlaceOrder**. Click the exact **Old version** button in **Node details**. Its fields and source YAML lack `customerId`. Click **New version**. Both include `customerId`.
- **Turn.** Click the exact **Turn diff** button and select **Duplicate order**. Old and New versions show the respective GWT descriptions. The second turn changes the GWT node and leaves the command unchanged.
- **Freeze.** Add `manualNote: string` to the command after the second reply. **Current** and **Session diff** show it. **Turn diff** stays unchanged and contains no `manualNote`.
- **Filter.** In `page.locator(".diff-counts")`, click the button whose name includes `changed`. The remaining graph contains changed nodes. Use the exact **Show full graph** button to clear the filter.
- **Evidence.** Save each visible comparison and the read-only session and turn diff responses. Keep the YAML before and after the manual edit.

## Gotchas

- Turn diffs contain all changes between claim and reply, including simultaneous manual edits. They do not establish agent authorship.
- The main script verifies a Git baseline. To verify fallback, seed a separate project without Git and require `baseline.kind` to be `startup` with an explicit fallback label.
- Feedback is disabled in **Turn diff** and for removed or stale nodes.
- A new queued request can temporarily have no turn comparison. Wait for claim and successful reply before asserting a completed turn.
- A later commit must not move the session baseline. Record the initial SHA before making that separate regression case.
