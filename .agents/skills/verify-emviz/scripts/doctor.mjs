#!/usr/bin/env node
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

const [rawUrl, expectedRoot, rawPid] = process.argv.slice(2);
assert.ok(rawUrl && expectedRoot && rawPid, "Usage: EMVIZ_TOKEN=... node doctor.mjs URL PROJECT_DIR PID");
const url = new URL(rawUrl);
assert.equal(url.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only drive an owned loopback instance");
const pid = Number(rawPid);
assert.ok(Number.isInteger(pid) && pid > 0, "Use the PID returned by your open command");
assert.ok(process.env.EMVIZ_TOKEN, "Set EMVIZ_TOKEN to the token returned by your open command");
process.kill(pid, 0);
const response = await fetch(new URL("/api/session?view=current", url), {
  headers: { "X-Emviz-Token": process.env.EMVIZ_TOKEN },
  signal: AbortSignal.timeout(5000)
});
assert.equal(response.status, 200, "The owned session must answer");
const snapshot = await response.json();
assert.equal(snapshot.token, process.env.EMVIZ_TOKEN, "The URL must belong to the session you opened");
assert.equal(await realpath(snapshot.project.root), await realpath(expectedRoot), "The server must use your disposable fixture");
assert.equal(snapshot.stale, false, "Fix the fixture before driving a stale graph");
assert.ok(snapshot.project.nodes.length > 0, "A listening server without a seeded graph is not ready");
console.log(JSON.stringify({
  url: url.origin, pid, projectRoot: snapshot.project.root,
  sessionId: snapshot.sessionId, revision: snapshot.revision,
  baseline: snapshot.baseline, status: snapshot.feedback.status
}, null, 2));
