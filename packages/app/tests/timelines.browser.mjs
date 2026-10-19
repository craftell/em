#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execute = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repo, "packages/cli/dist/index.js");
const featurePath = "event-model/features/customer-onboarding/customer-onboarding.feature.yaml";
const legacyStoryPath = "event-model/stories/customer-onboarding.yaml";
const subscriptionSlice = "event-model/features/subscription-checkout/start-subscription/start-subscription.slice.yaml";
const ids = {
  register: "story_customer_onboarding_registration",
  welcome: "story_customer_onboarding_welcome",
  home: "story_customer_onboarding_home",
  subscription: "story_customer_onboarding_subscription",
  legacy: "story_event_model_stories_subscription_checkout_yaml",
  stress: "story_event_model_stories_layout_stress_test_yaml"
};
const subscriptionStory = `  - id: subscription
    name: Start subscription
    slices:
      - ${subscriptionSlice}
`;
const subscriptionStep = (after) => `      - id: subscribe
        story: subscription
        after: [${after}]
`;

test("a user selects, reviews, exports and validates feature timelines", { timeout: 300_000 }, async () => {
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const evidenceRoot = resolve(process.env.EMVIZ_EVIDENCE_DIR ?? join(repo, "artifacts/timelines"));
  const evidence = join(evidenceRoot, runId);
  const projectRoot = await mkdtemp(join(tmpdir(), "emviz-timelines-"));
  const agent = "verify-" + randomUUID();
  const transcript = [];
  const checks = [];
  const secrets = new Set();
  const pageErrors = [];
  const cleanupErrors = [];
  let session;
  let browser;
  let context;
  let page;
  let passed = false;
  let failure;
  let traceStarted = false;
  let serverClosed = false;

  const redact = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  };
  const record = (name, detail) => checks.push({ name, detail });

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
  const cli = async (...args) => JSON.parse(await run(process.execPath, [cliPath, ...args]));
  const credentials = () => ["--url", session.url, "--token", session.token];
  const apiUrl = (pathname) => new URL(pathname, session.url).href;
  async function api(pathname) {
    const response = await fetch(apiUrl(pathname), { headers: { "X-Emviz-Token": session.token }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, pathname + " must answer");
    return response.json();
  }
  const snapshot = (view = "current") => api("/api/session?view=" + view);

  async function waitFor(check, description, timeout = 12_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.fail(description);
  }

  const file = (relative) => join(projectRoot, relative);
  const read = (relative) => readFile(file(relative), "utf8");
  async function edit(relative, change) {
    const before = await read(relative);
    const after = change(before);
    assert.notEqual(after, before, "the edit must change " + relative);
    await writeFile(file(relative), after);
    return { before, after };
  }

  async function capture(name) {
    await page.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
    await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
  }

  const node = (id) => page.locator('.react-flow__node[data-id="' + id + '"]');
  async function box(id) {
    const found = await node(id).boundingBox();
    assert.ok(found, id + " must be rendered");
    return found;
  }
  async function present(id) {
    return (await node(id).count()) > 0;
  }
  async function edgeLabels() {
    return (await page.locator(".react-flow__edge").evaluateAll((edges) => edges.map((edge) => edge.getAttribute("aria-label")))).sort();
  }
  async function settle() {
    await page.waitForTimeout(700);
  }
  const timelineSelect = () => page.getByLabel("Timeline", { exact: true });
  async function timelineOption(name) {
    const options = await timelineSelect().locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent })));
    const match = options.find((option) => option.text.startsWith(name + " · "));
    assert.ok(match, "the Timeline selector must offer " + name + ", saw " + JSON.stringify(options));
    return match.value;
  }
  async function chooseTimeline(name) {
    await timelineSelect().selectOption(name === "All stories" ? "" : await timelineOption(name));
    await settle();
  }
  async function agentTab() {
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
  }
  async function refresh() {
    await agentTab();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Refreshing the model..." }).waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    await settle();
  }
  async function changeView(name) {
    await agentTab();
    await page.getByRole("group", { name: "Model view" }).getByRole("button", { name, exact: true }).click();
    await settle();
  }
  async function searchSelect(name, type) {
    await page.getByLabel("Search event model", { exact: true }).fill(name);
    await page.locator(".search-results").getByRole("button", { name: name + " " + type, exact: true }).click();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await page.getByRole("complementary", { name: "Node details" }).waitFor();
  }
  async function findingsFromDrawer(captureName) {
    await page.getByRole("button", { name: /validation findings|Open validation/ }).first().click();
    const drawer = page.locator("#validation-panel");
    await drawer.waitFor();
    const text = await drawer.innerText();
    if (captureName) await capture(captureName);
    await page.getByRole("button", { name: "Close validation", exact: true }).click();
    return text;
  }
  async function inViewport(id) {
    const found = await box(id);
    const viewport = page.viewportSize();
    return found.x >= 0 && found.y >= 0 && found.x + found.width <= viewport.width && found.y + found.height <= viewport.height;
  }

  await mkdir(evidence, { recursive: true });
  try {
    // Fixture: copy this checkout's model, move the onboarding story into the feature file.
    await cp(join(repo, "event-model"), file("event-model"), { recursive: true });
    await mkdir(file(".event-modeling"), { recursive: true });
    await cp(join(repo, ".event-modeling/config.yaml"), file(".event-modeling/config.yaml"));
    await mkdir(dirname(file(featurePath)), { recursive: true });
    await cp(join(repo, "docs/examples/customer-onboarding.feature.yaml"), file(featurePath));
    const legacyStory = await read(legacyStoryPath);
    await rm(file(legacyStoryPath));
    await mkdir(file(".verify-hooks"));
    const seedFeature = await read(featurePath);
    await writeFile(join(evidence, "00-seed.feature.yaml"), seedFeature);
    await run("git", ["init", "--quiet"]);
    await run("git", ["add", "."]);
    await run("git", ["-c", "user.name=emviz verification", "-c", "user.email=verification@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + file(".verify-hooks"),
      "commit", "--quiet", "-m", "Seed disposable timeline fixture"]);
    const baselineSha = (await run("git", ["rev-parse", "HEAD"])).trim();

    session = await cli("open", projectRoot);
    assert.ok(session.token.length > 0);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(session.url).hostname));
    process.kill(session.pid, 0);
    const initial = await snapshot();
    assert.equal(resolve(initial.project.root), projectRoot);
    assert.equal(initial.baseline.label, baselineSha);
    assert.equal(initial.project.timelines.length, 2, "the feature file must supply both timelines");
    assert.equal(initial.project.stories.find((story) => story.path === featurePath && story.name === "Register customer")?.id, '["customer-onboarding","registration"]');
    assert.equal((await api("/api/validation")).findings.filter((finding) => finding.check === "F1").length, 0, "the seed has no F1 finding");
    await writeFile(join(evidence, "doctor.json"), JSON.stringify({ url: session.url, pid: session.pid, projectRoot, baselineSha, nodeVersion: process.version, cliPath }, null, 2));

    browser = await chromium.launch({ headless: process.env.EMVIZ_HEADED !== "1" });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: join(evidence, "video"), size: { width: 1440, height: 1000 } },
      acceptDownloads: true
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(session.url);
    await page.locator(".react-flow__node").first().waitFor();
    assert.equal(await timelineSelect().inputValue(), "", "the viewer opens on All stories");
    assert.ok(await present(ids.stress) && await present(ids.legacy), "All stories keeps legacy stories");
    await capture("01-all-stories");
    record("all-stories-default", "Timeline selector starts at All stories with legacy stories visible");

    // 1. Select Onboarding overview: sibling stacking and successor placement.
    await chooseTimeline("Onboarding overview");
    assert.equal(await present(ids.stress), false, "stories outside the timeline must leave the canvas");
    const register = await box(ids.register);
    const welcome = await box(ids.welcome);
    const home = await box(ids.home);
    assert.ok(register.x + register.width <= welcome.x && register.x + register.width <= home.x, "successors must start right of registration");
    assert.ok(Math.abs(welcome.x - home.x) < 1, "siblings must share one horizontal stage");
    assert.ok(welcome.y + welcome.height <= home.y || home.y + home.height <= welcome.y, "sibling groups must not overlap");
    for (const id of [ids.register, ids.welcome, ids.home]) assert.ok(await inViewport(id), id + " must be fitted into the viewport");
    const overviewEdges = await edgeLabels();
    const canonicalIds = new Set((await snapshot()).project.nodes.map((item) => item.id));
    for (const label of overviewEdges) {
      const [, source, target] = label.match(/^Edge from (.+) to (.+)$/);
      assert.ok(canonicalIds.has(source) && canonicalIds.has(target), "every edge keeps canonical endpoints: " + label);
      assert.ok(!source.startsWith("story_") && !target.startsWith("story_"), "no layout-only edge connects stories: " + label);
    }
    await capture("02-overview-siblings-stacked");
    record("overview-layout", JSON.stringify({ register, welcome, home }));

    // 2. Customer view and back.
    await chooseTimeline("Customer view");
    assert.equal(await present(ids.welcome), false, "Customer view omits the welcome story");
    assert.ok(await present(ids.register) && await present(ids.home));
    assert.ok((await box(ids.home)).x > (await box(ids.register)).x + (await box(ids.register)).width - 1);
    await capture("03-customer-view");
    await chooseTimeline("All stories");
    assert.ok(await present(ids.legacy) && await present(ids.stress) && await present(ids.welcome), "All stories restores every story");
    record("customer-view-and-all", "Customer view omits welcome; All stories restores all five stories");

    // 2b. Rapid switching: the last choice wins and the viewport fits it.
    await timelineSelect().selectOption(await timelineOption("Onboarding overview"));
    await timelineSelect().selectOption(await timelineOption("Customer view"));
    await timelineSelect().selectOption("");
    await timelineSelect().selectOption(await timelineOption("Customer view"));
    await page.waitForTimeout(1200);
    assert.equal(await timelineSelect().inputValue(), await timelineOption("Customer view"));
    assert.equal(await present(ids.welcome), false);
    for (const id of [ids.register, ids.home]) assert.ok(await inViewport(id), id + " must be fitted after rapid switching");
    await capture("03b-rapid-switch-customer-view");
    await chooseTimeline("All stories");
    for (const id of [ids.register, ids.stress, ids.legacy]) assert.ok(await inViewport(id), id + " must fit in All stories");
    record("rapid-switching", "Four immediate selector changes settled on the last choice with every story fitted");

    // 3. Selection inside and outside the timeline.
    await chooseTimeline("Onboarding overview");
    await searchSelect("SendWelcomeEmail", "command");
    assert.ok((await page.getByRole("complementary", { name: "Node details" }).innerText()).includes("SendWelcomeEmail"));
    await chooseTimeline("Customer view");
    assert.match(await page.getByRole("complementary", { name: "Node details" }).innerText(), /Select a node to inspect/, "a selection outside the new timeline must clear");
    await page.getByLabel("Search event model", { exact: true }).fill("SendWelcomeEmail");
    assert.equal(await page.locator(".search-results").getByRole("button", { name: "SendWelcomeEmail command", exact: true }).count(), 0, "search must exclude nodes outside the timeline");
    await page.getByLabel("Search event model", { exact: true }).fill("");
    await capture("04-selection-cleared-outside-timeline");
    record("selection", "Selection clears when its node leaves the timeline; search is bounded by it");

    // 3b. Navigating to a node outside the timeline leaves the timeline and centers the node.
    await chooseTimeline("Onboarding overview");
    await searchSelect("SubscriptionStarted", "event");
    assert.equal(await present("cmd_start_subscription"), false, "the producer lies outside the timeline");
    await page.getByRole("complementary", { name: "Node details" }).getByRole("button", { name: "StartSubscription", exact: true }).click();
    assert.equal(await timelineSelect().inputValue(), "", "navigating outside the timeline returns to All stories");
    await page.waitForTimeout(1200);
    assert.ok(await present("cmd_start_subscription"));
    assert.match(await page.getByRole("complementary", { name: "Node details" }).locator("h2").innerText(), /StartSubscription/);
    const target = await box("cmd_start_subscription");
    const canvas = await page.getByRole("main", { name: "Event model diagram" }).boundingBox();
    assert.ok(Math.abs(target.x + target.width / 2 - (canvas.x + canvas.width / 2)) < 80 && Math.abs(target.y + target.height / 2 - (canvas.y + canvas.height / 2)) < 80,
      "the target must be centered after the timeline changes: " + JSON.stringify({ target, canvas }));
    await capture("04b-navigate-outside-timeline");
    record("leave-timeline-navigation", "A connection outside the selected timeline reset the selector to All stories and centered " + JSON.stringify(target));

    // 4. Actor filter inside the selected timeline.
    await chooseTimeline("Onboarding overview");
    const before = { register: await box(ids.register), welcome: await box(ids.welcome), home: await box(ids.home) };
    await page.locator(".actor-filter summary").click();
    await page.getByRole("group", { name: "Filter by actor" }).getByLabel("Customer", { exact: true }).check();
    await settle();
    assert.equal(await present(ids.stress), false, "the timeline still bounds the actor-filtered view");
    assert.equal(await present(ids.legacy), false);
    await capture("05-overview-actor-filtered");
    await page.getByRole("button", { name: "Clear actors", exact: true }).click();
    await page.locator(".actor-filter summary").click();
    await settle();
    const restored = { register: await box(ids.register), welcome: await box(ids.welcome), home: await box(ids.home) };
    for (const key of Object.keys(before)) assert.ok(Math.abs(before[key].x - restored[key].x) < 1 && Math.abs(before[key].y - restored[key].y) < 1, key + " layout returns after clearing actors");
    record("actor-filter", "Customer filter stays inside Onboarding overview; clearing restores story positions");

    // 5. Add a joined step through the feature file and refresh through the UI.
    const joined = await edit(featurePath, (text) => text.replace("timelines:\n", subscriptionStory + "timelines:\n")
      .replace("  - id: customer-view", subscriptionStep("email, dashboard") + "  - id: customer-view"));
    assert.ok(joined.after.includes("id: subscribe"));
    await writeFile(join(evidence, "06-joined.feature.yaml"), joined.after);
    await refresh();
    assert.equal((await api("/api/validation")).findings.filter((finding) => finding.check === "F1").length, 0, "the joined fixture must stay valid");
    assert.equal((await snapshot()).project.timelines.find((timeline) => timeline.name === "Onboarding overview").steps.length, 4);
    assert.equal(await timelineSelect().inputValue(), await timelineOption("Onboarding overview"), "refresh keeps the selected timeline");
    await settle();
    const joinedBoxes = { welcome: await box(ids.welcome), home: await box(ids.home), subscription: await box(ids.subscription) };
    assert.ok(joinedBoxes.subscription.x >= joinedBoxes.welcome.x + joinedBoxes.welcome.width, "the join starts right of the email group");
    assert.ok(joinedBoxes.subscription.x >= joinedBoxes.home.x + joinedBoxes.home.width, "the join starts right of the full home group");
    for (const id of [ids.register, ids.welcome, ids.home, ids.subscription]) assert.ok(await inViewport(id), id + " must remain fitted after refresh");
    await capture("06-join-subscription");
    await chooseTimeline("All stories");
    await capture("06b-all-stories-after-join");
    await chooseTimeline("Onboarding overview");
    const joinedEdges = await edgeLabels();
    const joinedCanonical = (await snapshot()).project.edges.map((edge) => [edge.source, edge.target, edge.kind]).sort();
    record("join-layout", JSON.stringify(joinedBoxes));

    // 6. Layout-only edit: change only `after`, domain edges keep their endpoints.
    const sibling = await edit(featurePath, (text) => text.replace("after: [email, dashboard]", "after: [register]"));
    await writeFile(join(evidence, "07-sibling.feature.yaml"), sibling.after);
    await refresh();
    const siblingBoxes = { welcome: await box(ids.welcome), subscription: await box(ids.subscription) };
    assert.ok(Math.abs(siblingBoxes.subscription.x - siblingBoxes.welcome.x) < 1, "a layout-only change moves the story to the sibling stage");
    assert.deepEqual((await snapshot()).project.edges.map((edge) => [edge.source, edge.target, edge.kind]).sort(), joinedCanonical, "after must not change canonical edges");
    assert.deepEqual(await edgeLabels(), joinedEdges, "after must not change rendered domain edges");
    await capture("07-after-changed-layout-only");
    record("after-is-layout-only", "Editing only the after array moved the story and left canonical and rendered edges identical");
    await edit(featurePath, (text) => text.replace("after: [register]\n  - id: customer-view", "after: [email, dashboard]\n  - id: customer-view"));
    await refresh();

    // 7. Export the current timeline now; reopen after the server closes.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    const exportPath = join(evidence, "timelines-model.emviz.html");
    await (await downloadPromise).saveAs(exportPath);
    const exportedGeometry = { register: await box(ids.register), subscription: await box(ids.subscription) };

    // 8. Diff view: all stories, selector disabled, metadata notice.
    await changeView("Session diff");
    assert.equal(await timelineSelect().isDisabled(), true, "the timeline selector is disabled in a diff");
    assert.ok(await present(ids.stress) && await present(ids.legacy), "a diff shows all stories");
    await page.getByRole("status").filter({ hasText: "Timeline layout changed" }).waitFor();
    assert.ok((await page.locator(".diff-panel").innerText()).includes("All stories are shown in diff views"));
    await capture("08-session-diff-selector-disabled");
    const diffDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    const diffExportPath = join(evidence, "timelines-diff.emviz.html");
    await (await diffDownload).saveAs(diffExportPath);
    await changeView("Current");
    assert.equal(await timelineSelect().isDisabled(), false);
    assert.equal(await timelineSelect().inputValue(), await timelineOption("Onboarding overview"), "Current restores the selected timeline");
    assert.equal(await present(ids.stress), false);
    await capture("09-current-after-diff");
    record("diff", "Session diff disables the selector, shows all stories and the timeline-change notice; Current restores the timeline");

    // 9. Feedback discovers the feature file as the story's source.
    await searchSelect("Register customer", "story");
    await agentTab();
    const feedback = page.getByRole("form", { name: "Node feedback" });
    await feedback.getByLabel("Feedback message", { exact: true }).fill("Rename the overview timeline to Onboarding flow.");
    await feedback.getByRole("button", { name: "Add to Queue", exact: true }).click();
    const poll = (async () => {
      for (;;) {
        const result = await cli("poll", ...credentials(), "--agent", agent);
        if (result.status !== "timeout") return result;
      }
    })();
    poll.catch(() => {});
    await waitFor(async () => (await snapshot()).feedback.agent.connected, "the external CLI poll must connect");
    await page.getByRole("button", { name: "Send to Agent", exact: true }).click();
    const request = await poll;
    assert.equal(request.status, "request");
    assert.equal(request.request.items[0].sourcePath, featurePath, "story feedback targets the feature file");
    assert.ok(request.request.yaml.includes("kind: feature") && request.request.yaml.includes("timelines:"), "the request carries the feature YAML");
    const renamed = await edit(featurePath, (text) => text.replace("name: Onboarding overview", "name: Onboarding flow"));
    await cli("reply", request.request.id, "Renamed the overview timeline.", ...credentials(), "--agent", agent);
    await waitFor(async () => (await snapshot()).feedback.status === "completed", "the reply must complete the request");
    const turn = await snapshot("turn");
    assert.equal(turn.diff.timelinesChanged, true, "the frozen turn includes the feature timeline edit");
    assert.ok((await snapshot()).project.timelines.some((timeline) => timeline.name === "Onboarding flow"));
    await refresh();
    assert.ok((await timelineSelect().locator("option").allTextContents()).some((text) => text.startsWith("Onboarding flow · ")));
    await writeFile(join(evidence, "10-after-reply.feature.yaml"), renamed.after);
    await capture("10-feedback-feature-source");
    record("feedback", "Story feedback delivered " + featurePath + "; the reply's feature edit appears in Current and Turn diff");
    await edit(featurePath, (text) => text.replace("name: Onboarding flow", "name: Onboarding overview"));
    await refresh();

    // 10. Invalid input, one change at a time.
    const valid = await read(featurePath);
    const invalid = [
      ["schema-version", (text) => text.replace("schema_version: 1", "schema_version: 999"), /schema_version|version/i],
      ["missing-step", (text) => text.replace("story: welcome\n        after: [register]", "story: welcome\n        after: [missing-step]"), /missing-step/],
      ["cycle", (text) => text.replace("      - id: register\n        story: registration\n      - id: email", "      - id: register\n        story: registration\n        after: [email]\n      - id: email"), /cycle/i],
      ["repeated-story", (text) => text.replace("  - id: customer-view", "      - id: again\n        story: registration\n  - id: customer-view"), /(story|more than once|repeat|duplicate)/i]
    ];
    for (const [name, change, expected] of invalid) {
      const changed = change(valid);
      assert.notEqual(changed, valid, name + " must edit the fixture");
      await writeFile(file(featurePath), changed);
      await refresh();
      const text = await findingsFromDrawer("11-invalid-" + name);
      assert.match(text, /F1/, name + " must produce an F1 finding");
      assert.match(text, expected, name + " finding must explain the cause");
      record("invalid-" + name, text.replace(/\s+/g, " ").slice(0, 400));
      await writeFile(file(featurePath), valid);
      await refresh();
    }

    const sliceFile = "event-model/features/layout-stress-test/dense-slice/dense-slice.slice.yaml";
    const copyPath = "event-model/features/customer-onboarding/copy.feature.yaml";
    const repeatedSlice = valid.replace("timelines:\n", "  - id: twin\n    name: Registration twin\n    slices:\n      - event-model/features/customer-onboarding/register-customer/register-customer.slice.yaml\ntimelines:\n")
      .replace("  - id: customer-view", "      - id: twin\n        story: twin\n  - id: customer-view");
    assert.notEqual(repeatedSlice, valid);
    await writeFile(file(featurePath), repeatedSlice);
    await refresh();
    let text = await findingsFromDrawer("11-invalid-repeated-slice");
    assert.match(text, /F1[\s\S]*repeats slice/);
    record("invalid-repeated-slice", text.replace(/\s+/g, " ").slice(0, 300));
    await writeFile(file(featurePath), valid);
    await writeFile(file(copyPath), valid);
    await refresh();
    text = await findingsFromDrawer("11-invalid-duplicate-feature-id");
    assert.match(text, /F1[\s\S]*(duplicate|Duplicate)/);
    record("invalid-duplicate-feature-id", text.replace(/\s+/g, " ").slice(0, 300));
    await rm(file(copyPath));
    const denseBefore = await read(sliceFile);
    await writeFile(file(sliceFile), "kind: slice\n" + denseBefore);
    await refresh();
    text = await findingsFromDrawer("11-invalid-incomplete-header");
    assert.match(text, /F1[\s\S]*(schema_version|header)/i);
    record("invalid-incomplete-header", text.replace(/\s+/g, " ").slice(0, 300));
    await writeFile(file(sliceFile), denseBefore);
    await refresh();
    assert.equal((await api("/api/validation")).findings.filter((finding) => finding.check === "F1").length, 0, "restoring the files clears every F1 finding");

    // 11. Restore the legacy story and remove the feature file.
    await rm(file(featurePath));
    await writeFile(file(legacyStoryPath), legacyStory);
    await refresh();
    await waitFor(async () => (await timelineSelect().count()) === 0, "without a feature file the timeline selector disappears");
    assert.ok(await present("story_customer_onboarding_yaml") || (await snapshot()).project.stories.some((story) => story.path === legacyStoryPath), "the legacy story loads without headers");
    assert.ok(await present(ids.stress));
    await capture("12-legacy-restored");
    record("legacy-compat", "Removing the feature file and restoring the legacy story drops the selector and keeps All stories");

    // 12. The standalone export reopens without the server.
    await page.close();
    await cli("stop", ...credentials());
    await cli("close", ...credentials());
    await waitFor(async () => {
      try { await fetch(apiUrl("/api/session"), { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
    }, "close must stop the owned server", 7000);
    serverClosed = true;
    page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const networkRequests = [];
    page.on("request", (request) => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
    await page.goto(pathToFileURL(exportPath).href);
    await page.locator(".react-flow__node").first().waitFor();
    await settle();
    assert.equal((await timelineSelect().locator("option").count()), 3, "the export offers All stories and both timelines");
    assert.equal(await timelineSelect().inputValue(), await timelineOption("Onboarding overview"), "the export reopens on the exported timeline");
    assert.equal(await present(ids.stress), false);
    const reopened = { register: await box(ids.register), subscription: await box(ids.subscription) };
    const stageRatio = ({ register, subscription }) => (subscription.x - register.x) / register.width;
    assert.ok(Math.abs(stageRatio(reopened) - stageRatio(exportedGeometry)) < 0.05, "the export keeps the live timeline layout at its own zoom");
    await capture("13-export-reopened-overview");
    await chooseTimeline("Customer view");
    assert.equal(await present(ids.welcome), false);
    await capture("14-export-customer-view");
    await chooseTimeline("Onboarding overview");
    await page.locator(".actor-filter summary").click();
    await page.getByRole("group", { name: "Filter by actor" }).getByLabel("Customer", { exact: true }).check();
    await settle();
    assert.equal(await present(ids.legacy), false);
    await capture("15-export-actor-filtered");
    await chooseTimeline("All stories");
    assert.ok(await present(ids.legacy));
    await page.goto(pathToFileURL(diffExportPath).href);
    await page.locator(".react-flow__node").first().waitFor();
    await settle();
    assert.equal(await timelineSelect().isDisabled(), true, "a diff export keeps the selector disabled");
    assert.ok(await present(ids.stress) && await present(ids.legacy), "a diff export shows all stories");
    await page.getByRole("status").filter({ hasText: "Timeline layout changed" }).waitFor();
    await capture("16-export-diff-reopened");
    await page.waitForTimeout(500);
    assert.deepEqual(networkRequests, [], "the export must not contact the closed server");
    record("export", "Export reopened offline with Onboarding overview selected, three selector options, actor filtering, a diff export with the selector disabled, and no HTTP requests");
    assert.deepEqual(pageErrors, []);
    passed = true;
  } catch (error) {
    failure = error;
    if (page && !page.isClosed()) {
      try { await capture("failure"); } catch (captureError) { cleanupErrors.push(String(captureError)); }
    }
  } finally {
    if (session && !serverClosed) {
      try { await cli("stop", ...credentials()); } catch {}
    }
    if (traceStarted) {
      try { await context.tracing.stop({ path: join(evidence, "trace.zip") }); }
      catch (error) { cleanupErrors.push(redact(error)); }
    }
    try { await context?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
    try { await browser?.close(); } catch (error) { cleanupErrors.push(redact(error)); }
    if (session && !serverClosed) {
      try {
        await cli("close", ...credentials());
        serverClosed = true;
      } catch (error) { cleanupErrors.push(redact(error)); }
    }
    if (session && !serverClosed) cleanupErrors.push("The owned server may still be running. PID " + session.pid + ".");
    if (!session || serverClosed) await rm(projectRoot, { recursive: true, force: true });
    await writeFile(join(evidence, "terminal.json"), JSON.stringify(transcript, null, 2));
    await writeFile(join(evidence, "checks.json"), JSON.stringify(checks, null, 2));
    const artifacts = [];
    for (const entry of await readdir(evidence, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      artifacts.push({ path: path.slice(evidence.length + 1), bytes: (await stat(path)).size });
    }
    await writeFile(join(evidence, "verification.json"), JSON.stringify({
      status: passed && cleanupErrors.length === 0 ? "passed" : "failed",
      failure: failure ? redact(failure.stack ?? failure) : undefined,
      cleanupErrors,
      pageErrors,
      checks: checks.length,
      artifacts
    }, null, 2));
    console.log("Timeline evidence: " + evidence);
  }
  if (failure) throw failure;
  assert.deepEqual(cleanupErrors, []);
});
