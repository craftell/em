# Stop, resume, close, and export

Stop suspends feedback while preserving the viewer and files. Resume accepts feedback again. Close stops the owned server. Standalone exports stay readable without that server.

## Sub-features

- `session-stop-ui` stops an agent's waiting poll from the browser.
- `session-stop-cli` stops feedback from the terminal.
- `session-resume` reopens feedback and allows a new poll.
- `session-close` terminates the owned HTTP server.
- `session-export` preserves a read-only model without feedback access.

## How to get to it (user POV)

- Use **Stop session** or **Resume session** in **Feedback session** on the **Agent** tab.
- Run `emviz stop` or `emviz close` with the opened session's URL and token.
- Open the toolbar menu and choose **Export**.

## Driving it with Playwright and the CLI

Preconditions:

- Doctor passes for this run's session.
- A completed canonical file edit exists.
- A foreground agent poll is waiting.

- **Browser stop.** Click `page.getByRole("button", { name: "Stop session", exact: true })`. The waiting CLI returns `status: "stopped"`. The browser offers **Resume session**, and **Send to Agent** is disabled. Unsent drafts and queue items remain recoverable.
- **Preserve files.** Read the canonical slice after stopping. Its contents equal the file saved before stop.
- **Resume.** Click the exact **Resume session** button. Start a new poll with the same agent ID. Confirm the session accepts the connection.
- **CLI stop.** Run `node packages/cli/dist/index.js stop --url "$URL" --token "$TOKEN"`. The waiting poll returns `stopped`, while the viewer remains available.
- **Export.** Click the exact **Open menu** button, then the **Export** menu item. Save the browser download outside the temporary project.
- **Close.** Run `node packages/cli/dist/index.js close --url "$URL" --token "$TOKEN"`. The owned URL stops answering. Close the live page.
- **Offline read.** Open the downloaded HTML in a new page. Select **PlaceOrder** and confirm its edited fields. No **Node feedback** form or **Feedback session** region appears. Record requests and require zero HTTP requests.
- **Evidence.** Save stop and export screenshots, CLI exit results, a video, a trace, the HTML, and unchanged canonical files. Confirm the artifacts still exist after fixture cleanup.

## Gotchas

- Stop does not shut down the viewer or undo edits.
- Resume does not restart the external agent's exited poll loop.
- Restarting the server loses in-memory request history and creates a new token.
- Never close or kill an instance that this verification run did not start.
- A failed close is a failed verification. Preserve its PID and fixture details for cleanup.
