# Send feedback and receive a reply

A user sends a message about a selected node to an agent that they started separately. The agent edits canonical YAML and replies through the CLI.

## Sub-features

- `feedback-connect` connects one stable agent ID through a foreground poll.
- `feedback-send` queues the selected node and message.
- `feedback-claim` returns the request to the external CLI.
- `feedback-reply` shows the reply and the resulting file edit.
- `feedback-busy` prevents a second active request.

## How to get to it (user POV)

- Select a current ordinary node and use **Node feedback** in **Node details**.
- Select an actual GWT scenario and use the same form.
- Start an agent with the `em-feedback` skill and its `emviz poll` loop.

## Driving it with Playwright and the CLI

Preconditions:

- Doctor passes for the owned fixture.
- No request is queued or working.
- Keep one agent ID for the whole test.

- **Connect.** Run `node packages/cli/dist/index.js poll --url "$URL" --token "$TOKEN" --agent "$AGENT_ID"` in a child process. The **Feedback session** region reports **Agent connected**.
- **Send.** Select **PlaceOrder**. Fill `page.getByRole("form", { name: "Node feedback" }).getByLabel("Feedback message", { exact: true })`. Click its exact **Send feedback** button. The CLI returns `status: "request"` with the same message, node ID, source path, and project root.
- **Claim.** Check that the session reaches **Working**. **Send feedback** is disabled while the request is active. Save the CLI result and a browser screenshot.
- **Edit.** Add `customerId: uuid` to the canonical command fields in the temporary slice. Read the file back to confirm the edit.
- **Reply.** Run `node packages/cli/dist/index.js reply "$REQUEST_ID" "$TEXT" --url "$URL" --token "$TOKEN" --agent "$AGENT_ID"`. Open the summary beginning **Feedback history (**. The list item `li[data-request-id="..."] .feedback-reply` contains the reply.
- **Repeat for GWT.** Poll again with the same ID. Select **Duplicate order** and request the description change. The claimed request identifies that GWT node. Edit its canonical description, reply, and read the file back.
- **Evidence.** Keep screenshots before Send, while Working, and after the reply. Save the actual request and reply CLI output plus before-and-after YAML.

## Gotchas

- A poll timeout is a normal result. Poll again.
- One agent must not have two polls in flight. A second active agent must not take over a working request.
- Messages are limited to 4,000 characters and replies to 8,000 characters. HTTP bodies have a 32 KiB limit.
- Editing files while a request is queued can invalidate the selection before claim. Start with a fresh selection.
- An invalid YAML edit causes reply rejection. Keep the request working, fix the file, and retry the same reply.
- Never replace the real CLI with an intercepted browser API response.
