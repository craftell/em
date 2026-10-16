#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repo, "packages/cli/dist/index.js");
const sourcePath = "event-model/features/orders/place-order.slice.yaml";
const requestText = "Add customerId: uuid to the PlaceOrder command fields.";
const replyText = "Added customerId to PlaceOrder in the canonical slice YAML.";
const gwtRequestText = "Clarify that a duplicate order does not produce another event.";
const gwtReplyText = "Clarified the duplicate-order scenario in the canonical slice YAML.";
const seedSlice = `slice: Place an order
screen:
  type: user
  name: Order form
  actors: [Customer]
  reads: [OrderStatus]
  executes: [PlaceOrder]
commands:
  - name: PlaceOrder
    fields: |
      orderId: uuid
    produces: [OrderPlaced]
queries:
  - name: OrderStatus
    fields: |
      orderId: uuid
    from_events: [OrderPlaced]
gwt:
  - name: Duplicate order
    description: A duplicate request is rejected.
    given:
      - type: event
        name: OrderPlaced
    when:
      - type: command
        name: PlaceOrder
    then:
      - type: error
        name: DuplicateOrderError
`;

test("a user sends feedback to an external agent and reviews persistent file edits", { timeout: 180_000 }, async () => {
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const evidenceRoot = resolve(process.env.EMVIZ_EVIDENCE_DIR ?? join(repo, "artifacts/feedback"));
  const evidence = join(evidenceRoot, runId);
  const projectRoot = await mkdtemp(join(tmpdir(), "emviz-feedback-"));
  const agent = "verify-" + randomUUID();
  const transcript = [];
  const secrets = new Set();
  const pageErrors = [];
  const cleanupErrors = [];
  let session;
  let browser;
  let context;
  let page;
  let pendingPoll;
  let passed = false;
  let failure;
  let traceStarted = false;
  let serverClosed = false;
  let keepPolling = true;

  const redact = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  };

  async function run(command, args, timeout = 35_000) {
    const startedAt = new Date().toISOString();
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const result = await execute(command, args, { cwd: projectRoot, timeout, maxBuffer: 2 * 1024 * 1024 });
      stdout = result.stdout;
      stderr = result.stderr;
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed.token === "string") secrets.add(parsed.token);
      } catch {}
      return stdout;
    } catch (error) {
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
      code = error.code ?? 1;
      throw error;
    } finally {
      transcript.push({ startedAt, command, args: args.map(redact), stdout: redact(stdout), stderr: redact(stderr), code });
    }
  }

  async function cli(...args) {
    return JSON.parse(await run(process.execPath, [cliPath, ...args]));
  }

  const credentials = () => ["--url", session.url, "--token", session.token];
  const apiUrl = (pathname) => new URL(pathname, session.url).href;

  async function snapshot(view = "current") {
    const response = await fetch(apiUrl("/api/session?view=" + view), {
      headers: { "X-Emviz-Token": session.token },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200, "the owned session must answer its read-only doctor request");
    return response.json();
  }

  async function waitFor(check, description, timeout = 12_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.fail(description);
  }

  async function capture(name) {
    await page.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
    await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
  }

  async function select(name, type) {
    await page.getByLabel("Search event model", { exact: true }).fill(name);
    await page.locator(".search-results").getByRole("button", { name: name + " " + type, exact: true }).click();
    await page.getByRole("complementary", { name: "Node details" }).waitFor();
  }

  async function pollUntilRequest() {
    for (;;) {
      const result = await cli("poll", ...credentials(), "--agent", agent);
      assert.equal(typeof result.next_step, "string");
      if (result.status === "timeout" && keepPolling) continue;
      return result;
    }
  }

  async function startPoll() {
    pendingPoll = pollUntilRequest();
    pendingPoll.catch(() => {});
    await waitFor(async () => (await snapshot()).feedback.agent.connected, "the external CLI poll must connect its agent");
  }

  async function claim(message, nodeId) {
    const feedback = page.getByRole("form", { name: "Node feedback" });
    await feedback.getByLabel("Feedback message", { exact: true }).fill(message);
    await capture(message === requestText ? "01-command-before-send" : "04-gwt-before-send");
    await feedback.getByRole("button", { name: "Send feedback", exact: true }).click();
    const result = await pendingPoll;
    pendingPoll = undefined;
    assert.equal(result.status, "request");
    assert.equal(result.request.nodeId, nodeId);
    assert.equal(result.request.message, message);
    assert.equal(result.request.sourcePath, sourcePath);
    assert.equal(resolve(result.request.projectRoot), projectRoot);
    assert.ok(result.request.reference.endsWith("/" + nodeId));
    assert.ok(result.request.yaml.includes("slice: Place an order"));
    assert.equal(typeof result.request.context, "string");
    await waitFor(async () => (await snapshot()).feedback.status === "working", "the browser request must be claimed");
    assert.equal(await feedback.getByRole("button", { name: "Send feedback", exact: true }).isDisabled(), true);
    return result.request;
  }

  async function complete(request, text) {
    await cli("reply", request.id, text, ...credentials(), "--agent", agent);
    await waitFor(async () => (await snapshot()).feedback.status === "completed", "the reply must complete the request");
    const history = page.getByRole("region", { name: "Feedback session" }).locator("details");
    if (await history.getAttribute("open") === null) await history.locator("summary").click();
    const reply = history.locator('li[data-request-id="' + request.id + '"] .feedback-reply');
    await reply.waitFor();
    assert.equal(await reply.textContent(), text);
  }

  async function closeServer() {
    if (!session || serverClosed) return;
    await cli("close", ...credentials());
    await waitFor(async () => {
      try {
        await fetch(apiUrl("/api/session"), { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    }, "close must stop the owned server", 7000);
    serverClosed = true;
  }

  await mkdir(evidence, { recursive: true });
  try {
    await access(cliPath);
    await mkdir(join(projectRoot, ".event-modeling"), { recursive: true });
    await mkdir(join(projectRoot, "event-model/stories"), { recursive: true });
    await mkdir(dirname(join(projectRoot, sourcePath)), { recursive: true });
    await mkdir(join(projectRoot, ".verify-hooks"));
    await writeFile(join(projectRoot, ".event-modeling/config.yaml"), "language: en\npaths:\n  features_dir: event-model/features\n");
    await writeFile(join(projectRoot, "event-model/events.yaml"), "events:\n  OrderPlaced:\n    fields: |\n      orderId: uuid\n");
    await writeFile(join(projectRoot, "event-model/stories/orders.yaml"), "name: Orders\nslices:\n  - " + sourcePath + "\n");
    await writeFile(join(projectRoot, sourcePath), seedSlice);
    await writeFile(join(evidence, "00-before.slice.yaml"), seedSlice);
    await run("git", ["init", "--quiet"]);
    await run("git", ["add", "."]);
    await run("git", ["-c", "user.name=emviz verification", "-c", "user.email=verification@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + join(projectRoot, ".verify-hooks"),
      "commit", "--quiet", "-m", "Seed disposable feedback fixture"]);
    const baselineSha = (await run("git", ["rev-parse", "HEAD"])).trim();

    session = await cli("open", projectRoot);
    assert.equal(typeof session.url, "string");
    assert.equal(typeof session.token, "string");
    assert.ok(session.token.length > 0);
    assert.ok(Number.isInteger(session.pid) && session.pid > 0);
    assert.equal(typeof session.next_step, "string");
    const url = new URL(session.url);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    process.kill(session.pid, 0);
    const initial = await snapshot();
    assert.equal(resolve(initial.project.root), projectRoot);
    assert.equal(initial.token, session.token);
    assert.equal(initial.stale, false);
    assert.equal(initial.baseline.kind, "git");
    assert.equal(initial.baseline.label, baselineSha);
    assert.equal(initial.feedback.status, "idle");
    const command = initial.project.nodes.find((node) => node.type === "command" && node.label === "PlaceOrder");
    const gwt = initial.project.nodes.find((node) => node.type === "gwt" && node.label === "Duplicate order");
    assert.ok(command && gwt, "the seeded project must contain both selectable nodes");
    await writeFile(join(evidence, "doctor.json"), JSON.stringify({
      url: session.url, pid: session.pid, projectRoot, baselineSha, baseline: initial.baseline,
      nodeVersion: process.version, cliPath
    }, null, 2));

    browser = await chromium.launch({ headless: process.env.EMVIZ_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: join(evidence, "video"), size: { width: 1440, height: 1000 } }
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(session.url);
    await page.locator(".react-flow__node").first().waitFor();
    await page.getByRole("region", { name: "Feedback session" }).waitFor();
    await select("PlaceOrder", "command");
    assert.equal(await page.getByRole("button", { name: "Send feedback", exact: true }).isDisabled(), true);
    await startPoll();
    const first = await claim(requestText, command.id);
    await capture("02-command-working");
    const firstEdit = seedSlice.replace("      orderId: uuid\n    produces:", "      orderId: uuid\n      customerId: uuid\n    produces:");
    assert.notEqual(firstEdit, seedSlice);
    await writeFile(join(projectRoot, sourcePath), firstEdit);
    await complete(first, replyText);
    assert.equal(await readFile(join(projectRoot, sourcePath), "utf8"), firstEdit);
    await copyFile(join(projectRoot, sourcePath), join(evidence, "03-after-command.slice.yaml"));
    await waitFor(async () => (await snapshot()).project.nodes.find((node) => node.id === command.id)?.fields.includes("customerId: uuid"),
      "Current must show the agent's canonical file edit");
    const views = page.getByRole("group", { name: "Model view" });
    await views.getByRole("button", { name: "Session diff", exact: true }).click();
    await select("PlaceOrder", "command");
    const details = page.getByRole("complementary", { name: "Node details" });
    await details.getByRole("button", { name: "Old version", exact: true }).click();
    assert.equal((await details.textContent()).includes("customerId: uuid"), false);
    await details.getByRole("button", { name: "New version", exact: true }).click();
    assert.ok((await details.textContent()).includes("customerId: uuid"));
    await capture("03-command-session-diff");

    await views.getByRole("button", { name: "Current", exact: true }).click();
    await startPoll();
    await select("Duplicate order", "gwt");
    const second = await claim(gwtRequestText, gwt.id);
    const secondEdit = firstEdit.replace("A duplicate request is rejected.", "A duplicate request is rejected without another event.");
    await writeFile(join(projectRoot, sourcePath), secondEdit);
    await complete(second, gwtReplyText);
    await copyFile(join(projectRoot, sourcePath), join(evidence, "05-after-gwt.slice.yaml"));
    await views.getByRole("button", { name: "Turn diff", exact: true }).click();
    await select("Duplicate order", "gwt");
    await details.getByRole("button", { name: "Old version", exact: true }).click();
    assert.ok((await details.textContent()).includes("A duplicate request is rejected."));
    assert.equal((await details.textContent()).includes("rejected without another event."), false);
    await details.getByRole("button", { name: "New version", exact: true }).click();
    assert.ok((await details.textContent()).includes("A duplicate request is rejected without another event."));
    assert.equal(await details.getByRole("button", { name: "Send feedback", exact: true }).isDisabled(), true);
    await capture("05-gwt-turn-diff");
    const turnBeforeManual = await snapshot("turn");
    assert.equal(turnBeforeManual.diff.nodeStatus[gwt.id], "changed");
    assert.equal(turnBeforeManual.diff.nodeStatus[command.id], "unchanged");

    const manualEdit = secondEdit.replace("      customerId: uuid", "      customerId: uuid\n      manualNote: string");
    await writeFile(join(projectRoot, sourcePath), manualEdit);
    await waitFor(async () => (await snapshot()).project.nodes.find((node) => node.id === command.id)?.fields.includes("manualNote: string"),
      "Current must observe a later manual edit");
    const turnAfterManual = await snapshot("turn");
    assert.deepEqual(turnAfterManual.diff, turnBeforeManual.diff, "a completed turn must stay frozen after later edits");
    assert.equal(turnAfterManual.project.nodes.find((node) => node.id === command.id).fields.includes("manualNote"), false);
    const sessionDiff = await snapshot("session");
    assert.equal(sessionDiff.diff.nodeStatus[command.id], "changed");
    assert.equal(sessionDiff.diff.nodeStatus[gwt.id], "changed");
    assert.deepEqual(sessionDiff.baseline, initial.baseline, "the session baseline must remain fixed");
    await copyFile(join(projectRoot, sourcePath), join(evidence, "06-after-manual.slice.yaml"));
    await writeFile(join(evidence, "diffs.json"), JSON.stringify({
      turnBeforeManual: turnBeforeManual.diff, turnAfterManual: turnAfterManual.diff,
      session: sessionDiff.diff, baseline: sessionDiff.baseline
    }, null, 2));
    await views.getByRole("button", { name: "Current", exact: true }).click();
    await select("PlaceOrder", "command");
    await waitFor(async () => (await details.textContent()).includes("manualNote: string"), "the browser must render the later canonical value");
    await capture("06-current-after-manual");

    await startPoll();
    await page.getByRole("button", { name: "Stop session", exact: true }).click();
    assert.equal((await pendingPoll).status, "stopped");
    pendingPoll = undefined;
    await page.getByRole("button", { name: "Resume session", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send feedback", exact: true }).isDisabled(), true);
    assert.equal(await readFile(join(projectRoot, sourcePath), "utf8"), manualEdit);
    await capture("07-stopped");
    await page.getByRole("button", { name: "Resume session", exact: true }).click();
    await waitFor(async () => (await snapshot()).feedback.status !== "stopped", "Resume session must reopen feedback");
    await startPoll();
    await cli("stop", ...credentials());
    assert.equal((await pendingPoll).status, "stopped");
    pendingPoll = undefined;

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    const download = await downloadPromise;
    const exportPath = join(evidence, "feedback-model.emviz.html");
    await download.saveAs(exportPath);
    await page.close();
    await closeServer();
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const networkRequests = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) networkRequests.push(request.url());
    });
    await page.goto(pathToFileURL(exportPath).href);
    await page.locator(".react-flow__node").first().waitFor();
    await select("PlaceOrder", "command");
    assert.ok((await page.getByRole("complementary", { name: "Node details" }).textContent()).includes("manualNote: string"));
    assert.equal(await page.getByRole("form", { name: "Node feedback" }).count(), 0);
    await capture("08-standalone-read-only");
    await page.waitForTimeout(500);
    assert.deepEqual(networkRequests, [], "the standalone export must not contact the closed feedback server");
    assert.deepEqual(pageErrors, []);
    passed = true;
  } catch (error) {
    failure = error;
    if (page && !page.isClosed()) {
      try { await capture("failure"); } catch (captureError) { cleanupErrors.push(String(captureError)); }
    }
  } finally {
    keepPolling = false;
    if (session && !serverClosed) {
      try { await cli("stop", ...credentials()); } catch {}
    }
    if (pendingPoll) {
      try { await pendingPoll; } catch (error) { cleanupErrors.push(redact(error)); }
    }
    if (traceStarted) {
      try { await context.tracing.stop({ path: join(evidence, "trace.zip") }); }
      catch (error) { cleanupErrors.push(redact(error)); }
    }
    try { await context?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
    try { await browser?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
    try { await closeServer(); } catch (error) { cleanupErrors.push(redact(error)); }
    if (session && !serverClosed) {
      cleanupErrors.push("The owned server may still be running. PID " + session.pid + ". Close that session manually.");
    }
    if (!session || serverClosed) {
      await rm(projectRoot, { recursive: true, force: true });
    }
    await writeFile(join(evidence, "terminal.json"), JSON.stringify(transcript, null, 2));
    if (passed) {
      try {
        for (const name of ["01-command-before-send.png", "03-command-session-diff.png", "05-gwt-turn-diff.png",
          "08-standalone-read-only.png", "trace.zip", "00-before.slice.yaml", "06-after-manual.slice.yaml", "terminal.json"]) {
          assert.ok((await stat(join(evidence, name))).size > 0, name + " must survive cleanup");
        }
        const videos = await readdir(join(evidence, "video"));
        assert.ok(videos.some((name) => name.endsWith(".webm")), "recorded video must survive cleanup");
      } catch (error) { cleanupErrors.push(redact(error)); }
    }
    const artifacts = [];
    for (const entry of await readdir(evidence, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parent = entry.parentPath ?? entry.path;
      const path = join(parent, entry.name);
      artifacts.push({ path: path.slice(evidence.length + 1), bytes: (await stat(path)).size });
    }
    await writeFile(join(evidence, "verification.json"), JSON.stringify({
      status: passed && cleanupErrors.length === 0 ? "passed" : "failed",
      failure: failure ? redact(failure.stack ?? failure) : undefined,
      cleanupErrors, projectRemoved: !session || serverClosed, serverClosed, pageErrors, artifacts
    }, null, 2));
    process.stdout.write("Feedback evidence: " + evidence + "\n");
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, [], "cleanup must close the owned session and preserve evidence");
});
