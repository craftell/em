# emviz

Interactive visualizer for Event Modeling YAML projects.

## Viewer commands

```sh
npx emviz
npx emviz .
npx emviz sync .
npx emviz diff HEAD~1
npx emviz diff --from ../old-model --to .
pnpm dlx emviz
```

`emviz [project-dir]` starts the local viewer in the foreground. With no directory, the browser offers manual import. Project mode creates `.event-modeling/graph.json` when the sidecar is missing. `emviz sync` creates or updates the sidecar explicitly.

## Host and security

`--host <IP>` and `--host=<IP>` select the listening address for foreground,
`serve`, `open`, and `diff` commands. The default is `127.0.0.1`.

```sh
emviz . --host "$TAILSCALE_IP"
emviz open . --host "$TAILSCALE_IP"
emviz diff HEAD~1 --host "$TAILSCALE_IP"
emviz . --host ::1
```

Use a specific IP assigned to the server machine. IPv4 and IPv6 literals are
supported. IPv6 viewer URLs use brackets. Wildcards such as `0.0.0.0` and `::`,
DNS names, URLs, and scoped IPv6 addresses are rejected. The server does not
discover an address, enable Tailscale, or change firewall rules.

For remote listeners, every API request requires the session capability,
including model reads and session snapshots. The server accepts only the
configured IP and actual listening port in the Host header. An Origin header
must match that exact HTTP origin. This does not authorize other hosts or CORS
origins.

For remote project sessions, the printed `viewerUrl` contains the capability in
a URL fragment. Remote manual-import and diff modes print the complete viewer
link without feedback connection JSON. The browser
removes the fragment and keeps the capability in tab-scoped session storage so
reloads work. Static app files do not contain the capability. Anyone with the
private viewer link can read the model and control its feedback session.
Never post the link or token in shared logs, tickets, screenshots, or public chat.

Use an encrypted private network such as Tailscale with appropriate access rules.
emviz uses plain HTTP. On an ordinary LAN or the public Internet, model data and
capabilities are visible in transit. Do not expose this server through a public
proxy. Close the owned server when finished to invalidate its capability.

Browsers can block clipboard APIs on non-loopback HTTP origins. If a copy button
does not work, select and copy the displayed text manually. Some existing copy
controls do not show a failure message.

CLI `poll`, `reply`, `stop`, and `close` accept a clean HTTP origin using a
concrete IP or the legacy `localhost` alias. They reject credentials, paths,
queries, fragments, DNS destinations, and redirects. Use exactly the returned
`url`; `viewerUrl` is for the browser.

`pnpm dev` starts Vite's manual-import development app. It is separate from the
project server and this CLI option.

## External-agent commands

These commands connect an agent that the user starts separately. The server does not invoke an LLM, call a model provider, or edit canonical YAML on the agent's behalf.

### open

```sh
emviz open <project-dir>
```

Starts a detached server and exits after startup. The default host is `127.0.0.1`.
Standard output contains a JSON object with `url`, `viewerUrl`, `token`, `pid`, and
`next_step`. Open `viewerUrl` in the browser. Use the clean `url` for CLI commands.
The token authorizes feedback operations. The PID identifies the server owned by
this open command.

Keep the token private. Each server has its own in-memory session and history.

### poll

```sh
emviz poll --url "$URL" --token "$TOKEN" --agent "$AGENT_ID"
```

Waits for up to 25 seconds and exits with one JSON result.

- `status: "request"` includes `request` and `next_step`. The request includes its ID, feedback message, selected node reference, source path, source YAML, connected context, and project root. A batch adds `clientBatchId` and an ordered `items` array. Each item includes its captured ID, node ID, reference, revision, message, source path, YAML, and context. The top-level node identifies the first item. The top-level message and context include every item for older agents.
- `status: "timeout"` means no request arrived during this poll. The agent can poll again.
- `status: "stopped"` ends the agent's loop.

An agent uses a stable, unique ID and one foreground poll at a time. It processes each request serially and replies before polling again. A competing agent or a second in-flight poll receives an error.

### reply

```sh
emviz reply "$REQUEST_ID" "$REPLY_TEXT" --url "$URL" --token "$TOKEN" --agent "$AGENT_ID"
```

Completes a claimed request with a reply from the same agent. The agent edits the project's canonical YAML directly before replying. A successful reply freezes the completed turn's after snapshot.

The agent must describe its actual edits and checks. A failed reply does not imply that file edits were rolled back.

### stop

```sh
emviz stop --url "$URL" --token "$TOKEN"
```

Stops feedback and releases waiting polls. The viewer stays open, and files remain unchanged by the stop operation. **Resume session** in the browser reopens feedback. An agent whose poll loop exited must start polling again.

### close

```sh
emviz close --url "$URL" --token "$TOKEN"
```

Closes the owned local server. Its in-memory request history ends with the process. This is the cleanup command for a server started by `open`.

## Feedback limits

The browser's **Add to Queue** holds unsent items. **Send to Agent** submits the entire queue as one request. A session accepts one queued or working request at a time. Another request receives a busy error. A batch accepts 1 to 20 items, at most 4,000 characters per message, and at most 16,000 message characters in total. Replies accept at most 8,000 characters. The batch endpoint has a 128 KiB body limit. Other HTTP request bodies retain the 32 KiB limit. The session retains the latest 20 request records. Legacy single-node retries are recognized while their records remain in visible history. Batch receipts last for the server session, up to 1,000 distinct accepted batches. At capacity, new batches fail until the server restarts. An exact retry remains valid after its visible history row expires, but the old reply is no longer available.

Project feedback reads at most 512 model files and 8 MiB per snapshot. Discovery stops after 10,000 directory entries. Configured sources and symlink targets must stay inside the selected project root. A selected source is limited to 64,000 characters, and connected context to 128,000 characters. Captured context across a batch is limited to 1 MiB.

The additive `POST /api/feedback/batch` accepts `{ clientBatchId, items: [{ id, nodeId, reference, revision, message }] }`. All items must refer to the same current snapshot. Invalid or stale items reject the whole batch before any agent receives it. Reusing an ID with different ordered contents fails. Existing `POST /api/feedback/request` clients remain supported.

Feedback operations require the session token. Loopback viewers obtain the token
from their same-origin session snapshot. Remote viewers use the private
`viewerUrl` described below. The agent passes the token through `--token`.

## Review views

**Current** shows the current model on disk.

**Session diff** compares the current model with a fixed Git baseline captured at startup. If Git cannot provide a usable baseline, the viewer labels the startup snapshot fallback. Later commits do not move the session baseline.

**Turn diff** compares the snapshot at request claim with the snapshot after a successful reply. A batch has one claim, one reply, and one turn diff for all of its items. It remains frozen after completion. Changes made manually during that interval also appear in the turn diff. The diff does not establish authorship.

Feedback is unavailable for removed, stale, or ambiguous selections, for disconnected sessions, and in **Turn diff**. Manual imports and standalone exports remain read-only.

## Agent workflow

The [emviz skill](../../skills/emviz/SKILL.md) gives the full agent procedure.
The existing [em-feedback skill](../../skills/em-feedback/SKILL.md) delegates to it. The agent opens the project, gives the user the URL, polls, handles one request, replies, and polls again.

Idle poll timeouts continue the loop. The agent must stay active or use a supported
continuation mechanism. A detached server does not wake an idle LLM, and a skill
file alone cannot provide background execution.

The agent preserves unrelated file edits and does not commit, reset, or stash automatically. Restarting the server discards history, so an interrupted agent must re-read the project before continuing.

## Verification

The [verify-emviz guide](../../.agents/skills/verify-emviz/SKILL.md) records the executed local real-server feedback journey and the 17 fixture browser cases. The real-server actor journey, two-machine remote-access journey, and the full startup-baseline fallback browser journey remain unexecuted. Those local checks do not start a real LLM. Its browser script starts an isolated project and real CLI processes. It records screenshots, video, a Playwright trace, CLI output, and canonical file contents outside the disposable project.
