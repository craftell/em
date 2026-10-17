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

## External-agent commands

These commands connect an agent that the user starts separately. The server does not invoke an LLM, call a model provider, or edit canonical YAML on the agent's behalf.

### open

```sh
emviz open <project-dir>
```

Starts a detached server on loopback and exits after startup. Standard output contains a JSON object with `url`, `token`, `pid`, and `next_step`. The URL opens the viewer. The token authorizes feedback operations. The PID identifies the server owned by this open command.

Keep the token private. Each server has its own in-memory session and history.

### poll

```sh
emviz poll --url "$URL" --token "$TOKEN" --agent "$AGENT_ID"
```

Waits for up to 25 seconds and exits with one JSON result.

- `status: "request"` includes `request` and `next_step`. The request includes its ID, feedback message, selected node reference, source path, source YAML, connected context, and project root.
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

A session accepts one queued or working request at a time. Another request receives a busy error. Messages accept at most 4,000 characters. Replies accept at most 8,000 characters. HTTP request bodies have a separate 32 KiB limit. The session retains the latest 20 request records. Idempotent retries are recognized while their records remain in memory.

Project feedback reads at most 512 model files and 8 MiB per snapshot. Discovery stops after 10,000 directory entries. Configured sources and symlink targets must stay inside the selected project root. A selected source is limited to 64,000 characters, and connected context to 128,000 characters.

Feedback operations require the session token. The browser obtains its token from the same-origin session snapshot. The agent passes the token through `--token`. Do not expose the server through a network proxy or share its token.

## Review views

**Current** shows the current model on disk.

**Session diff** compares the current model with a fixed Git baseline captured at startup. If Git cannot provide a usable baseline, the viewer labels the startup snapshot fallback. Later commits do not move the session baseline.

**Turn diff** compares the snapshot at request claim with the snapshot after a successful reply. It remains frozen after completion. Changes made manually during that interval also appear in the turn diff. The diff does not establish authorship.

Feedback is unavailable for removed, stale, or ambiguous selections, for disconnected sessions, and in **Turn diff**. Manual imports and standalone exports remain read-only.

## Agent workflow

The [emviz skill](../../skills/emviz/SKILL.md) gives the full agent procedure.
The existing [em-feedback skill](../../skills/em-feedback/SKILL.md) delegates to it. The agent opens the project, gives the user the URL, polls, handles one request, replies, and polls again.

Idle poll timeouts continue the loop. The agent must stay active or use a supported
continuation mechanism. A detached server does not wake an idle LLM, and a skill
file alone cannot provide background execution.

The agent preserves unrelated file edits and does not commit, reset, or stash automatically. Restarting the server discards history, so an interrupted agent must re-read the project before continuing.

## Verification

The [verify-emviz guide](../../.agents/skills/verify-emviz/SKILL.md) is DRAFT and unexecuted for this change. Its browser script starts an isolated project and real CLI processes. It records screenshots, video, a Playwright trace, CLI output, and canonical file contents outside the disposable project.
