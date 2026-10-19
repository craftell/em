#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const cli = join(repo, "packages/cli/dist/index.js");
const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const evidence = join(resolve(process.env.EMVIZ_EVIDENCE_DIR ?? join(repo, "artifacts/screen-links")), runId);
const headless = process.env.EMVIZ_HEADED !== "1";

const figmaOld = "https://www.figma.com/design/example/register-old";
const figmaNew = "https://www.figma.com/design/example/register-new";
const checks = [];
const transcript = [];
const pageErrors = [];
const secrets = new Set();
const redact = (value) => [...secrets].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
const pass = (name) => { checks.push(name); console.log("ok - " + name); };

async function run(command, args, cwd) {
  const startedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    ({ stdout, stderr } = await execute(command, args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }));
    return stdout;
  } catch (error) {
    ({ stdout = "", stderr = "", code = 1 } = error);
    throw error;
  } finally {
    transcript.push({ startedAt, command, args: args.map(redact), stdout: redact(stdout), stderr: redact(stderr), code });
  }
}

const destinationRequests = [];
const destination = createServer((request, response) => {
  destinationRequests.push({ url: request.url, referer: request.headers.referer });
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Controlled reference</title><p>DESTINATION-PAGE-MARKER " + request.url + "</p>");
});
await new Promise((ready) => destination.listen(0, "127.0.0.1", ready));
const origin = "http://127.0.0.1:" + destination.address().port;

const screens = {
  Register: figmaOld,
  Checkout: origin + "/checkout",
  Profile: undefined,
  Retired: origin + "/retired",
  Hash: origin + "#section@2",
  Javascript: "javascript:alert(1)",
  Credentials: "https://user:secret@example.com/design",
  Relative: "/prototype"
};
const invalid = ["Javascript", "Credentials", "Relative"];
const finalUrls = { ...screens, Register: figmaNew, Profile: origin + "/profile", Retired: undefined };
const validAfter = Object.keys(finalUrls).filter((name) => finalUrls[name] && !invalid.includes(name));

const projectRoot = await mkdtemp(join(tmpdir(), "emviz-screen-links-"));
const slicePath = (name) => "event-model/features/" + name + ".slice.yaml";
const sliceYaml = (name, url, type = "user") => "slice: " + name + "\nscreen:\n  type: " + type + "\n  name: " + name + "\n" + (type === "user" ? "  actors: [Visitor]\n" : "") +
  (url === undefined ? "" : "  url: " + JSON.stringify(url) + "\n");
const systemSlice = (url) => sliceYaml("System", url, "system");
const writeSlices = async (urls, systemUrl) => {
  for (const [name, url] of Object.entries(urls)) await writeFile(join(projectRoot, slicePath(name)), sliceYaml(name, url));
  await writeFile(join(projectRoot, slicePath("System")), systemSlice(systemUrl));
};

let session;
let diffServer;
let browser;
let passed = false;
let failure;

async function waitFor(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((next) => setTimeout(next, 100));
  }
  assert.fail(description);
}

const state = (page) => page.evaluate(() => ({
  transform: document.querySelector(".react-flow__viewport")?.style.transform,
  selected: [...document.querySelectorAll(".react-flow__node .em-node.selected .node-label")].map((element) => element.textContent),
  heading: document.querySelector("#inspector-details h2")?.textContent
}));

async function capture(page, name) {
  await page.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
  await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
}

const node = (page, label) => page.locator(".react-flow__node").filter({ has: page.locator(".node-label", { hasText: new RegExp("^" + label + "$") }) });

async function newViewer(url, name, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, recordVideo: { dir: join(evidence, "video", name), size: viewport } });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(name + ": " + error.message));
  await page.goto(url);
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(600);
  return { context, page };
}

async function popupFrom(page, action) {
  const settled = page.waitForEvent("popup", { timeout: 10_000 }).then((value) => ({ value }), (error) => ({ error }));
  try { await action(); } catch (error) { await settled; throw error; }
  const result = await settled;
  if (result.error) throw result.error;
  const opened = result.value;
  await opened.waitForLoadState("domcontentloaded").catch(() => {});
  return opened;
}

async function assertOpensExternally(page, action, expected, label) {
  const before = await state(page);
  const popup = await popupFrom(page, action);
  assert.equal(popup.url(), expected, label + ": new tab destination");
  assert.equal(await popup.evaluate(() => window.opener), null, label + ": opener isolation");
  assert.deepEqual(await state(page), before, label + ": selection and viewport unchanged");
  await popup.close();
  return popup;
}

async function focusByTab(page, selector, limit = 80) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((query) => document.activeElement?.matches(query) ?? false, selector)) return index + 1;
  }
  assert.fail("Tab never reached " + selector);
}

async function search(page, label, type) {
  await page.getByLabel("Search event model", { exact: true }).fill(label);
  await page.locator(".search-results").getByRole("button", { name: label + " " + type, exact: true }).click();
  const details = page.getByRole("tab", { name: "Details", exact: true });
  if (await details.count()) await details.click();
  await page.getByRole("complementary", { name: "Node details" }).waitFor();
}

async function closeSession() {
  if (!session) return;
  const { url, token } = session;
  session = undefined;
  await run(process.execPath, [cli, "close", "--url", url, "--token", token], projectRoot);
  await waitFor(async () => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), "the owned server must stop");
}

async function startDiff() {
  const child = spawn(process.execPath, [cli, "diff", "HEAD", projectRoot], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitFor(() => /Local:\s+http\S+/.test(output) && /Diff:/.test(output), "the diff server must report its URL");
  return { child, url: output.match(/Local:\s+(http\S+)/)[1], output: () => output };
}

await mkdir(evidence, { recursive: true });
try {
  await run(process.execPath, ["--version"], repo);
  await mkdir(join(projectRoot, ".event-modeling"), { recursive: true });
  await mkdir(join(projectRoot, "event-model/features"), { recursive: true });
  await mkdir(join(projectRoot, "event-model/stories"), { recursive: true });
  await mkdir(join(projectRoot, ".verify-hooks"));
  await writeFile(join(projectRoot, ".event-modeling/config.yaml"), "language: en\npaths:\n  features_dir: event-model/features\n");
  await writeFile(join(projectRoot, "event-model/events.yaml"), "events: {}\n");
  await writeFile(join(projectRoot, "event-model/actors.yaml"), "actors:\n  Visitor:\n    name: Visitor\n    color: \"#2563EB\"\n");
  const story = (title, members) => "name: " + title + "\nslices:\n" + members.map((name) => "  - " + slicePath(name) + "\n").join("");
  await writeFile(join(projectRoot, "event-model/stories/valid.yaml"), story("Valid links", ["Register", "Checkout", "Profile", "Retired", "Hash"]));
  await writeFile(join(projectRoot, "event-model/stories/rejected.yaml"), story("Rejected links", [...invalid, "System"]));
  await writeSlices(screens, "https://example.com/system");
  await run("git", ["init", "--quiet"], projectRoot);
  await run("git", ["add", "."], projectRoot);
  await run("git", ["-c", "user.name=emviz verification", "-c", "user.email=verification@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=" + join(projectRoot, ".verify-hooks"), "commit", "--quiet", "-m", "Seed disposable screen link fixture"], projectRoot);
  await writeSlices(finalUrls, "https://example.com/system");
  await mkdir(join(evidence, "fixture"), { recursive: true });
  for (const name of ["Register", "Profile", "Retired", "Javascript", "System"]) await copyFile(join(projectRoot, slicePath(name)), join(evidence, "fixture", name + ".slice.yaml"));

  session = JSON.parse(await run(process.execPath, [cli, "open", projectRoot], projectRoot));
  secrets.add(session.token);
  const doctor = await execute(process.execPath, [join(here, "doctor.mjs"), session.url, projectRoot, String(session.pid)],
    { env: { ...process.env, EMVIZ_TOKEN: session.token } });
  await writeFile(join(evidence, "doctor.json"), redact(doctor.stdout));
  const snapshot = await (await fetch(new URL("/api/session?view=current", session.url), { headers: { "X-Emviz-Token": session.token } })).json();
  const byLabel = (project, label) => project.nodes.find((candidate) => candidate.label === label && ["screen", "processor"].includes(candidate.type));
  for (const name of Object.keys(finalUrls)) {
    const expected = invalid.includes(name) ? undefined : finalUrls[name];
    assert.equal(byLabel(snapshot.project, name)?.url, expected, name + " graph url");
  }
  assert.equal(byLabel(snapshot.project, "System")?.url, undefined);
  const issues = snapshot.project.modelIssues.filter((issue) => issue.check === "L10");
  assert.deepEqual(issues.map((issue) => issue.path).sort(), [...invalid, "System"].map(slicePath).sort(), "one L10 finding per invalid or system URL");
  assert.ok(issues.every((issue) => issue.message.includes("screen.url")));
  await writeFile(join(evidence, "l10-findings.json"), JSON.stringify(issues, null, 2));
  pass("parser: valid URLs kept; javascript:, credential, relative and system-screen URLs produce L10 and are omitted");

  browser = await chromium.launch({ headless });
  const viewer = await newViewer(session.url, "current");
  const { page, context } = viewer;
  assert.equal(destinationRequests.length, 0, "opening the viewer must not fetch destinations");
  await capture(page, "01-current");

  for (const name of validAfter) assert.equal(await node(page, name).getByRole("link").count(), 1, name + " node link");
  for (const name of [...invalid, "System", "Retired"]) assert.equal(await node(page, name).getByRole("link").count(), 0, name + " has no node link");
  const link = node(page, "Register").getByRole("link");
  assert.equal(await link.getAttribute("href"), figmaNew);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await page.locator("iframe").count(), 0, "the viewer creates no Figma iframe");
  pass("viewer: icon only on screens with a valid URL; target and rel set; no iframe");

  await search(page, "Checkout", "screen");
  assert.equal(destinationRequests.length, 0, "selection must not fetch the destination");
  await capture(page, "02-checkout-selected");
  const selectedBefore = await state(page);
  assert.deepEqual(selectedBefore.selected, ["Checkout"]);
  await context.route("https://www.figma.com/**", (route) => route.fulfill({ body: "Figma stand-in", contentType: "text/html" }));
  await assertOpensExternally(page, () => link.click(), figmaNew, "node icon mouse");
  assert.deepEqual((await state(page)).selected, ["Checkout"], "clicking another screen's icon keeps the selected node");
  const checkoutPopup = await popupFrom(page, () => node(page, "Checkout").getByRole("link").click());
  assert.equal(checkoutPopup.url(), origin + "/checkout");
  await checkoutPopup.close();
  await waitFor(() => destinationRequests.some((entry) => entry.url === "/checkout"), "the controlled destination must receive the click");
  assert.equal(destinationRequests.find((entry) => entry.url === "/checkout").referer, undefined, "noreferrer strips Referer");
  pass("mouse: node icon opens the exact URL in a new tab with opener null; selection and viewport unchanged; no Referer");

  const tabs = await focusByTab(page, '[data-id] .screen-link-compact[href="' + figmaNew + '"]');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + " " + getComputedStyle(document.activeElement).outlineWidth);
  assert.ok(!outline.startsWith("none"), "keyboard focus indicator: " + outline);
  await capture(page, "03-keyboard-focus");
  await assertOpensExternally(page, () => page.keyboard.press("Enter"), figmaNew, "node icon keyboard");
  pass("keyboard: Tab reaches the icon after " + tabs + " presses, shows a focus ring, Enter opens a new tab without moving the canvas");

  await search(page, "Register", "screen");
  const detailsLink = page.locator("#inspector-details").getByRole("link", { name: /Open reference/ });
  assert.equal(await detailsLink.getAttribute("href"), figmaNew);
  assert.equal(await detailsLink.getAttribute("rel"), "noopener noreferrer");
  await capture(page, "04-details-link");
  await assertOpensExternally(page, () => detailsLink.click(), figmaNew, "details mouse");
  await detailsLink.focus();
  await assertOpensExternally(page, () => page.keyboard.press("Enter"), figmaNew, "details keyboard");
  pass("details: reference link opens the same URL by mouse and keyboard without camera movement");

  await search(page, "Javascript", "screen");
  assert.equal(await page.locator("#inspector-details").getByRole("link", { name: /Open reference/ }).count(), 0);
  await search(page, "System", "processor");
  assert.equal(await page.locator("#inspector-details").getByRole("link", { name: /Open reference/ }).count(), 0);
  assert.equal(await page.locator('a[href^="javascript:" i]').count(), 0);
  pass("details: no link for rejected URLs or the system processor; no javascript: anchor anywhere");

  for (const width of [1280, 680]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await page.locator(".react-flow__node").first().waitFor();
    await page.waitForTimeout(500);
    const target = node(page, "Register").getByRole("link");
    await assertOpensExternally(page, () => target.click({ timeout: 5000 }), figmaNew, "normal click at " + width + "px");
    await capture(page, "05-width-" + width);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator(".react-flow__node").first().waitFor();
  await page.locator(".actor-filter summary").click();
  await page.waitForTimeout(1000);
  const opened = await state(page);
  await page.waitForTimeout(1000);
  assert.deepEqual(await state(page), opened, "opening Actors must settle before the link is clicked");
  await assertOpensExternally(page, () => node(page, "Register").getByRole("link").click({ timeout: 5000 }), figmaNew, "normal click with Actors expanded");
  pass("narrow, wrapped-toolbar and Actors-open layouts: unforced clicks reach the icon");

  const exportMenu = async (target) => {
    await target.getByRole("button", { name: "Open menu" }).click();
    const download = target.waitForEvent("download");
    await target.getByRole("menuitem", { name: "Export" }).click();
    return download;
  };
  await page.reload();
  await page.locator(".react-flow__node").first().waitFor();
  const download = await exportMenu(page);
  const exported = join(evidence, "export", "links.emviz.html");
  await mkdir(dirname(exported), { recursive: true });
  await download.saveAs(exported);
  const html = await readFile(exported, "utf8");
  assert.ok(html.includes(figmaNew));
  assert.ok(!html.includes("DESTINATION-PAGE-MARKER"), "the destination page is not bundled");
  await context.close();
  pass("export: file keeps the valid URL and never bundles the destination");

  const diff = await startDiff();
  diffServer = diff.child;
  await writeFile(join(evidence, "diff-server.txt"), diff.output());
  const diffView = await newViewer(diff.url, "diff");
  const d = diffView.page;
  await capture(d, "06-diff");
  for (const name of ["Register", "Profile", "Retired"]) {
    const links = node(d, name).getByRole("link");
    const badge = node(d, name).locator(".diff-badge");
    assert.equal(await badge.count(), 1, name + " is changed");
    if (await links.count()) {
      const linkBox = await links.boundingBox();
      const badgeBox = await badge.boundingBox();
      assert.ok(badgeBox.y + badgeBox.height <= linkBox.y || badgeBox.x + badgeBox.width <= linkBox.x, name + " diff badge overlaps the link target");
      const centerX = linkBox.x + linkBox.width / 2;
      const centerY = linkBox.y + linkBox.height / 2;
      const top = await d.evaluate(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return { link: element?.closest("a.screen-link") != null, badge: element?.closest(".diff-badge") != null };
      }, [centerX, centerY]);
      assert.equal(top.badge, false, name + " diff badge sits over the link centre");
    }
  }
  const expectedOld = { Register: figmaOld, Profile: undefined, Retired: origin + "/retired" };
  const expectedNew = { Register: figmaNew, Profile: origin + "/profile", Retired: undefined };
  for (const name of Object.keys(expectedOld)) {
    await search(d, name, "screen");
    const reference = d.locator("#inspector-details").getByRole("link", { name: /Open reference/ });
    const read = async () => await reference.count() ? reference.getAttribute("href") : undefined;
    assert.equal(await read(), expectedNew[name], name + " new version");
    await d.getByRole("button", { name: "Old version", exact: true }).click();
    assert.equal(await read(), expectedOld[name], name + " old version");
    await capture(d, "07-diff-old-" + name.toLowerCase());
    await d.getByRole("button", { name: "New version", exact: true }).click();
  }
  const diffLink = node(d, "Register").getByRole("link");
  await search(d, "Register", "screen");
  await d.getByRole("button", { name: "Focus selected node", exact: true }).click();
  await d.waitForTimeout(800);
  await node(d, "Profile").locator(".node-label").click();
  await assertOpensExternally(d, () => diffLink.click(), figmaNew, "diff icon");
  pass("diff: old and new versions keep their own URLs (changed, added, removed); badge clear of the link; link click leaves selection");
  await diffView.context.close();
  diffServer.kill("SIGTERM");
  diffServer = undefined;

  await closeSession();
  pass("session closed before opening the standalone file");

  const standalone = await newViewer(pathToFileURL(exported).href, "standalone");
  const s = standalone.page;
  await standalone.context.setOffline(true);
  for (const name of validAfter) assert.equal(await node(s, name).getByRole("link").count(), 1, name + " standalone link");
  for (const name of [...invalid, "System"]) assert.equal(await node(s, name).getByRole("link").count(), 0, name + " standalone has no link");
  const exportedUrls = await s.evaluate(() => Object.fromEntries(window.__EMVIZ_EXPORT__.project.nodes
    .filter((candidate) => ["screen", "processor"].includes(candidate.type)).map((candidate) => [candidate.label, candidate.url])));
  for (const name of Object.keys(finalUrls)) {
    assert.equal(exportedUrls[name], invalid.includes(name) ? undefined : finalUrls[name], name + " exported node url");
  }
  assert.equal(exportedUrls.System, undefined, "system processors export no url");
  await capture(s, "08-standalone");
  await standalone.context.setOffline(false);
  await standalone.context.route("https://www.figma.com/**", (route) => route.fulfill({ body: "Figma stand-in", contentType: "text/html" }));
  await assertOpensExternally(s, () => node(s, "Register").getByRole("link").click(), figmaNew, "standalone icon");
  await search(s, "Register", "screen");
  await assertOpensExternally(s, () => s.locator("#inspector-details").getByRole("link", { name: /Open reference/ }).click(), figmaNew, "standalone details");
  pass("standalone: links survive, open in new tabs, and rejected links stay absent");

  await new Promise((closed) => destination.close(closed));
  const unavailable = await popupFrom(s, () => node(s, "Checkout").getByRole("link").click());
  await unavailable.close();
  await search(s, "Profile", "screen");
  assert.ok((await state(s)).selected.includes("Profile"), "the viewer stays usable when the destination is down");
  await capture(s, "09-destination-down");
  pass("destination unavailable: the new tab fails on its own, the viewer remains usable");
  await standalone.context.close();

  const tampered = html.replaceAll(figmaNew, "javascript:alert(1)");
  assert.notEqual(tampered, html);
  const tamperedPath = join(evidence, "export", "tampered.emviz.html");
  await writeFile(tamperedPath, tampered);
  const hostile = await newViewer(pathToFileURL(tamperedPath).href, "tampered");
  assert.equal(await node(hostile.page, "Register").getByRole("link").count(), 0, "a tampered export must not render a javascript: link");
  assert.equal(await hostile.page.locator('a[href^="javascript:" i]').count(), 0);
  await capture(hostile.page, "10-tampered-export");
  await hostile.context.close();
  pass("tampered standalone payload: javascript: URL renders no link");

  assert.deepEqual(pageErrors, []);
  passed = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  await browser?.close().catch((error) => cleanupErrors.push("browser: " + error.message));
  if (diffServer) diffServer.kill("SIGTERM");
  await closeSession().catch((error) => cleanupErrors.push("server: " + error.message));
  if (destination.listening) await new Promise((closed) => destination.close(closed));
  if (!cleanupErrors.length) await rm(projectRoot, { recursive: true, force: true });
  await writeFile(join(evidence, "terminal.json"), JSON.stringify(transcript, null, 2));
  await writeFile(join(evidence, "verification.json"), JSON.stringify({
    runId, revision: (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), passed, checks, pageErrors,
    destinationRequests: destinationRequests.length, cleanupErrors, projectRoot: cleanupErrors.length ? projectRoot : "removed", failure: failure && String(failure.stack ?? failure)
  }, null, 2));
  console.log("evidence: " + evidence);
  if (failure) { console.error(failure); process.exitCode = 1; }
  if (cleanupErrors.length) { console.error(cleanupErrors); process.exitCode = 1; }
}
