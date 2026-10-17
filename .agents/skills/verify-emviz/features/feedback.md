# Queue feedback and receive a batch reply

A user collects messages about selected nodes in the Agent sidebar. The browser sends them together only after the user chooses Send to Agent.

## Sub-features

- `feedback-tabs` keeps Details inspection separate from Agent controls.
- `feedback-connect` reports the external agent's poll activity.
- `feedback-queue` captures each node, reference, revision, and message without sending.
- `feedback-edit` edits message text or removes an unsent item without changing its target.
- `feedback-send` submits one ordered batch.
- `feedback-retry` preserves the exact batch ID and contents through an uncertain response.
- `feedback-reply` records one reply and frozen turn for the batch.

## How to get to it

Select a current node, then open the **Agent** tab in the right sidebar. **Details** remains the default tab and retains source, connections, fields, findings, and GWT inspection.

## Drive with Playwright and the CLI

Use the owned fixture after Doctor passes. Keep one agent ID and one foreground poll.

1. Open `page.getByRole("tab", { name: "Agent", exact: true })`. Before starting the CLI poll, verify **Agent disconnected** even though the viewer refreshes.
2. Run `emviz poll` with the owned URL, token, and agent ID. Verify **Agent connected**.
3. Select **PlaceOrder**. Fill the **Feedback message** textarea in the **Node feedback** form. Click **Add to Queue**.
4. Read the real session snapshot. It must still be idle. Queueing must not release the waiting agent poll.
5. Select **OrderStatus**, open **Agent**, and queue its message. Choose **Refresh**. The **Feedback Queue** region must retain both items.
6. Click **Send to Agent**. The real CLI poll must return one request whose ordered `items` preserve both node IDs, messages, references, and revisions.
7. Verify **Working**. Edit both canonical targets, validate the files, and reply once with the returned request ID.
8. Open **Feedback history**. Verify the reply text and read both file edits back.
9. Complete another turn for **Duplicate order**. Confirm the first batch did not silently include any later draft.

Extend fixture checks with Edit, Remove, selection changes, a full page reload, stale revisions, stopped sessions, and a failed Send. Require unchanged request identity when retrying an uncertain result. A stale item must stay visible and must not be silently rebased.

## Evidence

Keep screenshots before Send, while Working, and after the reply. Save the actual CLI request and reply plus before-and-after YAML. Record Details and Agent at desktop and narrow widths. Verify no floating session panel covers the sidebar.

## Limits and failure cases

A batch accepts 1 to 20 items, at most 4,000 characters per message, and 16,000 message characters in total. The batch HTTP body limit is 128 KiB. Other routes retain 32 KiB. Replies accept 8,000 characters.

The server rejects the whole batch if any captured revision or reference changed. A model edit before claim cancels the whole submitted turn. Stop cancels submitted work and preserves browser-local drafts and queue items. It cannot stop an external process or undo its edits.

A poll timeout means poll again. An invalid YAML edit causes reply rejection. Fix the file and retry the same reply without repeating edits. Never replace the real CLI journey with intercepted responses.
