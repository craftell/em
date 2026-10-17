---
name: verify-emviz
description: >-
  Drive the emviz browser and external-agent CLI against an isolated Event
  Modeling project. Use to verify feedback, current and diff views, session
  lifecycle, and read-only exports with durable browser and file evidence.
---

# Verify emviz

DRAFT. This skill and its feedback script have not been executed during this change. No screenshot, video, trace, or runtime pass is claimed. Remove this label only after a real run completes every section below and its evidence survives cleanup.

Read the [feature map](features/README.md) before choosing a journey. Use a checkout containing the feedback implementation.

## Launch

Run from the repository root with Node 20.19 or later and pnpm 10.30.0. Install dependencies and Chromium only when the operator permits installation.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
node --test packages/app/tests/feedback.browser.mjs
```

If dependencies and Chromium already exist, skip their installation commands.

The script creates a fresh temporary Event Modeling project with one story, one slice, one command, one query, one event, and one GWT scenario. It creates a Git commit only in that disposable fixture. It then runs the built CLI's `open` command in a child process.

The detached server binds to an available loopback port. The script verifies the returned PID, session token, project root, populated graph, and fixed baseline SHA before browser actions. The first external CLI poll must make the agent connected.

The script does not start an LLM. Its test agent uses real `poll` and `reply` child processes and edits only the temporary canonical YAML. It does not intercept browser requests or inject application state.

Set `EMVIZ_HEADED=1` to watch Chromium. Set `EMVIZ_EVIDENCE_DIR` to an absolute evidence parent directory when the default repository `artifacts/feedback/` is unsuitable. Each run creates a unique subdirectory.

The script closes its browser and owned server after success or failure. If close fails, it reports the owned PID and leaves the scratch project for recovery. Treat that run as failed until cleanup succeeds.

## Doctor

The script runs a read-only doctor check before driving the browser. For an instance you opened manually, keep its returned URL, token, PID, and disposable project path. Run:

```sh
EMVIZ_TOKEN="$TOKEN" node .agents/skills/verify-emviz/scripts/doctor.mjs "$URL" "$PROJECT" "$PID"
```

The helper checks process liveness, loopback URL, matching token, exact project root, non-stale state, and a populated graph. It prints identity and baseline metadata without the token.

Run doctor whenever the UI looks wrong. Do not drive a server merely because port 5173 answers. Never attach to a user's existing modeling session.

## Drive

Run the complete feedback journey:

```sh
node --test packages/app/tests/feedback.browser.mjs
```

The journey selects **PlaceOrder** and **OrderStatus** through **Search event model**. It opens **Agent**, uses **Add to Queue** for each node, and proves that queueing and Refresh do not send. **Send to Agent** releases one real CLI poll with both items. The test agent edits both targets in canonical YAML and replies once. The browser then checks **Session diff** with **Old version** and **New version**.

A second batch targets **Duplicate order**, a GWT scenario. After that reply, the script checks **Turn diff**, makes a later manual file edit, and proves that the completed turn remains frozen. It also exercises browser stop and resume, CLI stop, server close, and a standalone export after shutdown.

Use the exact selectors in the feature files when extending the journey. Treat unreachable controls, missing fixture data, and unexpected disabled states as failures. Do not replace a user action with an internal state setter.

For the existing GWT and standalone regressions, run:

```sh
pnpm --filter @emviz/app test:browser
```

The [actor journey](features/actors.md) adds registry tags, multi-selection, bounded system context, and historical metadata checks. Its browser recording and screenshots remain unexecuted for the actor change.

That older suite uses intercepted API fixtures for many checks. Its pass does not replace the new real-server feedback journey.

## Evidence

The script prints its run directory. The default is `artifacts/feedback/<run-id>/`, outside the disposable project.

Each successful run must retain:

- Screenshots before feedback submission, while working, after replies, in diff views, after stop, and in the standalone export.
- Matching ARIA snapshots and a Chromium video under `video/`.
- `trace.zip` with user actions and resulting browser state.
- `terminal.json` with commands, standard output, standard error, and exit codes. Token strings are redacted.
- Canonical slice YAML before edits, after each reply, and after the later manual edit.
- `doctor.json`, `diffs.json`, the exported HTML, and `verification.json`.

Inspect both the browser result and files. A reply alone does not prove that YAML changed. A screenshot alone does not prove that a request reached the external CLI.

Open the trace with:

```sh
pnpm exec playwright show-trace artifacts/feedback/<run-id>/trace.zip
```

Replace `<run-id>` with the actual directory printed by the run. Keep traces private while the server is alive because traces can include its temporary session token. Close the server before sharing artifacts, and inspect them for secrets first.

Report the exact command, revision tested, outcome, artifact directory, and any untested feature-map entry. Never substitute generated images for captured browser screenshots.

## Cleanup

The test uses `emviz stop` to release waiting polls and `emviz close` to stop only the server that its own `open` command created. It closes Playwright before checking that video and trace files exist. It removes the disposable project only after server shutdown.

For a manually opened verification instance:

```sh
node packages/cli/dist/index.js stop --url "$URL" --token "$TOKEN"
node packages/cli/dist/index.js close --url "$URL" --token "$TOKEN"
```

Confirm that the owned URL no longer answers. Remove only the fixture directory you created. Do not kill processes by name, reset the repository, or delete the evidence directory.

If the test reports a cleanup error, retain the project path and owned PID from `doctor.json`. Resolve that exact instance before rerunning. A failed cleanup remains a failed verification.

## Helpers

- `packages/app/tests/feedback.browser.mjs` runs the real-server journey through Node's test runner.
- `scripts/doctor.mjs` checks an already opened verification instance without mutation.

Both scripts have executable entry points. Use the explicit `node` commands above for consistent behavior.

After the first successful real run, update this draft with the tested revision and evidence location. Use `/maintain-verification-skill` when that skill is available to keep the feature map aligned with future UI changes.
