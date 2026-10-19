import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createServer, preview } from "vite";

const evidence = process.env.EMVIZ_EVIDENCE_DIR
  ? resolve(process.env.EMVIZ_EVIDENCE_DIR, "navigation-" + new Date().toISOString().replace(/[:.]/g, "-"))
  : undefined;
let caseNumber = 0;
let caseName;
const captures = [];
beforeEach((context) => { caseName = context.name; });

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch({ headless: process.env.EMVIZ_HEADED !== "1" });
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    console.log("Navigation evidence: " + evidence);
  }
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (evidence) await writeFile(join(evidence, "captures.json"), JSON.stringify(captures, null, 2));
});

const localEdgeIds = [
  "command-event-0", "command-event-1", "event-query-0", "event-query-1",
  "query-screen-0", "query-screen-1", "screen-command-0", "screen-command-1"
].sort();
const allEdgeIds = [...localEdgeIds, "cross-read"].sort();

function model() {
  const stories = ["Alpha", "Beta"].map((name, index) => ({
    name, description: "", path: "stories/" + name + ".yaml",
    slices: ["slices/" + index + ".yaml"]
  }));
  // Matching titles deliberately do not imply matching slice identities.
  const slices = stories.map((story) => ({
    title: "Shared title", path: story.slices[0], storyName: story.name,
    screen: { actors: [], reads: [], executes: [] }, commands: [], queries: [], gwt: []
  }));
  const nodes = stories.flatMap((story, index) => {
    const shared = { sourcePath: slices[index].path, sliceTitle: slices[index].title, storyName: story.name };
    return [
      { id: "story-" + index, type: "story", label: story.name, sourcePath: story.path },
      { ...shared, id: "slice-" + index, type: "slice", label: slices[index].title },
      { ...shared, id: "screen-" + index, type: "screen", label: story.name + " screen", actors: ["member"] },
      { ...shared, id: "command-" + index, type: "command", label: story.name + " command", fields: "id: string" },
      { ...shared, id: "query-" + index, type: "query", label: story.name + " query",
        fields: Array.from({ length: 140 }, (_, n) => "field_" + n + ": string").join("\n") },
      // Events belong to the producer's slice even though their source is the shared registry.
      { id: "event-" + index, type: "event", label: story.name + " saved", sourcePath: "events.yaml", fields: "id: string" }
    ];
  });
  const edges = stories.flatMap((_, index) => [
    { id: "query-screen-" + index, kind: "query-screen", source: "query-" + index, target: "screen-" + index },
    { id: "screen-command-" + index, kind: "screen-command", source: "screen-" + index, target: "command-" + index },
    { id: "command-event-" + index, kind: "command-event", source: "command-" + index, target: "event-" + index },
    { id: "event-query-" + index, kind: "event-query", source: "event-" + index, target: "query-" + index }
  ]);
  edges.push({ id: "cross-read", kind: "event-query", source: "event-0", target: "query-1" });
  return { root: "/navigation-fixture", config: { paths: {} }, events: [], stories, slices, nodes, edges };
}

async function open({ project = model, init, initArg, diff, address = url } = {}) {
  const id = String(++caseNumber).padStart(2, "0");
  captures.push({ id, test: caseName });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...(evidence ? { recordVideo: { dir: join(evidence, id + "-video"), size: { width: 1440, height: 1000 } } } : {})
  });
  if (init) await context.addInitScript(init, initArg);
  const page = await context.newPage();
  if (evidence) {
    const close = page.close.bind(page);
    page.close = async () => {
      try {
        await page.screenshot({ path: join(evidence, id + ".png"), fullPage: true });
        await writeFile(join(evidence, id + ".aria.txt"), await page.locator("body").ariaSnapshot());
        await writeFile(join(evidence, id + "-viewport.json"), JSON.stringify(await viewport(page), null, 2));
      } finally {
        await close();
        await context.close();
      }
    };
  } else {
    page.close = () => context.close();
  }
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/*", (route) => route.fulfill({
    json: new URL(route.request().url()).pathname === "/api/model"
      ? project() : { findings: [], errors: 0, warnings: 0 }
  }));
  await page.route("**/api/session?**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/diff", (route) => route.fulfill(diff ? { json: diff } : { status: 404, body: "" }));
  try {
    await page.goto(address);
    await node(page, "command-0").waitFor();
    await page.waitForTimeout(600);
    assert.deepEqual(errors, [], "the fixture must load without page errors");
    return { page, errors };
  } catch (error) {
    await page.close();
    throw error;
  }
}

function node(page, id) {
  return page.locator('.react-flow__node[data-id="' + id + '"]');
}

async function viewport(page) {
  return page.locator(".react-flow__viewport").evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
}

function closeTo(actual, expected, message, tolerance = 0.75) {
  assert.ok(Math.abs(actual - expected) <= tolerance, message + ": " + actual + " versus " + expected);
}

function sameViewport(actual, expected, message) {
  closeTo(actual.x, expected.x, message + " x", 0.01);
  closeTo(actual.y, expected.y, message + " y", 0.01);
  closeTo(actual.zoom, expected.zoom, message + " zoom", 0.00001);
}

async function unchanged(page, action, message) {
  await page.evaluate(() => {
    const element = document.querySelector(".react-flow__viewport");
    const initial = element.style.transform;
    const transforms = [];
    const observer = new MutationObserver(() => transforms.push(element.style.transform));
    observer.observe(element, { attributes: true, attributeFilter: ["style"] });
    window.navigationProbe = { element, initial, transforms, observer };
  });
  await action();
  // Observe the whole old animation interval, not only its final position.
  await page.waitForTimeout(450);
  const observed = await page.evaluate(() => {
    const probe = window.navigationProbe;
    probe.observer.disconnect();
    return {
      initial: probe.initial,
      transforms: [...probe.transforms, probe.element.style.transform],
      sameElement: document.querySelector(".react-flow__viewport") === probe.element
    };
  });
  assert.equal(observed.sameElement, true, message + " must keep the viewport mounted");
  assert.ok(observed.transforms.every((value) => value === observed.initial), message + " must never mutate the viewport transform");
}

async function edges(page, expected) {
  await page.waitForFunction((ids) => {
    const current = [...document.querySelectorAll(".react-flow__edge")].map((edge) => edge.dataset.id).sort();
    return JSON.stringify(current) === JSON.stringify(ids);
  }, [...expected].sort());
  const actual = await page.locator(".react-flow__edge").evaluateAll((elements) =>
    elements.map((element) => ({ id: element.dataset.id, path: element.querySelector("path")?.getAttribute("d") }))
  );
  assert.deepEqual(actual.map((edge) => edge.id).sort(), [...expected].sort());
  assert.ok(actual.every((edge) => edge.path?.startsWith("M")), "visible edges must have rendered SVG paths");
}

async function selectNode(page, id, label) {
  await node(page, id).click();
  await page.getByRole("complementary", { name: "Node details" }).getByRole("heading", { name: label, exact: true }).waitFor();
  assert.equal(await node(page, id).locator(".em-node.selected, .group-node.selected").count(), 1);
}

async function center(locator) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, "interaction target must be rendered");
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

test("wrapped toolbars leave sidebar tabs and actions reachable at desktop and narrow widths", async () => {
  const { page, errors } = await open({ project: scopedModel });
  try {
    for (const width of [1440, 1280, 1024, 680]) {
      await page.setViewportSize({ width, height: 900 });
      const toolbar = await page.locator(".toolbar").boundingBox();
      const panel = await page.getByRole("complementary", { name: "Node details" }).boundingBox();
      assert.ok(panel.y >= toolbar.y + toolbar.height, "sidebar must begin below the toolbar at width " + width);
      await page.getByRole("tab", { name: "Agent", exact: true }).click();
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      await page.getByLabel("Search event model", { exact: true }).fill("Alpha command");
      await page.locator(".search-results").getByRole("button", { name: "Alpha command command", exact: true }).click();
      await page.getByRole("button", { name: "Focus selected node", exact: true }).click();
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("open Actors stays usable without covering sidebar controls or moving the viewport", async () => {
  const { page, errors } = await open();
  try {
    const filter = page.locator(".actor-filter");
    await unchanged(page, async () => {
      await filter.locator("summary").click();
      await filter.getByRole("checkbox", { name: "member", exact: true }).check();
    }, "opening and choosing Actors");
    const popover = await page.locator(".actor-filter-popover").boundingBox();
    const panel = await page.getByRole("complementary", { name: "Node details" }).boundingBox();
    assert.ok(panel.y >= popover.y + popover.height, "sidebar actions must remain below the open Actors controls");
    await unchanged(page, async () => {
      await page.getByRole("tab", { name: "Agent", exact: true }).click();
      await page.getByRole("tab", { name: "Details", exact: true }).click();
      assert.equal(await filter.getByRole("checkbox", { name: "member", exact: true }).isChecked(), true);
      await filter.locator("summary").click();
    }, "sidebar access with Actors open");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("canvas selection, sidebar hover, search and history never move the viewport", async () => {
  const { page, errors } = await open();
  try {
    await unchanged(page, () => selectNode(page, "query-1", "Beta query"), "canvas selection");
    const panel = page.getByRole("complementary", { name: "Node details" });
    const connection = panel.getByRole("button", { name: "Alpha saved", exact: true });
    await unchanged(page, async () => {
      await connection.hover();
      await page.locator('.react-flow__edge[data-id="cross-read"] .edge-path-active').waitFor();
      await panel.getByRole("heading", { name: "Beta query", exact: true }).hover();
    }, "sidebar connection preview");
    await unchanged(page, async () => {
      await page.getByLabel("Search event model", { exact: true }).fill("Alpha command");
      await page.locator(".search-results").getByRole("button", { name: "Alpha command command", exact: true }).click();
      assert.equal(await node(page, "command-0").locator(".selected").count(), 1);
    }, "search selection");
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await panel.getByRole("heading", { name: "Beta query", exact: true }).waitFor();
      await page.getByRole("button", { name: "Forward", exact: true }).click();
      await panel.getByRole("heading", { name: "Alpha command", exact: true }).waitFor();
    }, "selection history");
    const beforeFocus = await viewport(page);
    await panel.getByRole("button", { name: "Focus selected node", exact: true }).click();
    await page.waitForTimeout(450);
    assert.notDeepEqual(await viewport(page), beforeFocus, "explicit focus remains an intentional navigation action");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Auto reveals only selected cross-slice edges and Intra-slice and All stay explicit", async () => {
  const { page, errors } = await open();
  try {
    const visibility = page.getByLabel("Edge visibility", { exact: true });
    assert.equal(await visibility.inputValue(), "auto");
    await edges(page, localEdgeIds);
    // A producer is not itself incident to its event's outgoing read.
    await selectNode(page, "command-0", "Alpha command");
    await edges(page, localEdgeIds);
    await selectNode(page, "query-1", "Beta query");
    await edges(page, allEdgeIds);
    await visibility.selectOption("intra-slice");
    await edges(page, localEdgeIds);
    const connection = page.getByRole("complementary", { name: "Node details" }).getByRole("button", { name: "Alpha saved", exact: true });
    await connection.hover();
    await edges(page, localEdgeIds); // Hover must not override the chosen visibility mode.
    await visibility.selectOption("all");
    await page.keyboard.press("Escape");
    await edges(page, allEdgeIds);
    await visibility.selectOption("auto");
    await page.keyboard.press("Escape");
    await edges(page, localEdgeIds);
    // Selecting a slice reveals the cross-slice reads incident to its owned nodes.
    await node(page, "slice-1").locator(".group-title").click();
    await edges(page, allEdgeIds);
    await page.keyboard.press("Escape");
    await edges(page, localEdgeIds);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("story collapse summarizes owned contents and proxies cross-story edges without camera jumps, and survives reload", async () => {
  const { page, errors } = await open();
  try {
    await page.getByLabel("Edge visibility", { exact: true }).selectOption("all");
    await edges(page, allEdgeIds);
    const expandedHeight = (await node(page, "story-0").boundingBox()).height;
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Collapse Alpha", exact: true }).click();
      await node(page, "command-0").waitFor({ state: "detached" });
    }, "collapsing one story");
    for (const id of ["slice-0", "screen-0", "command-0", "query-0", "event-0"]) {
      assert.equal(await node(page, id).count(), 0, id + " must be hidden with its story");
    }
    assert.ok((await node(page, "story-0").boundingBox()).height < expandedHeight, "collapsed story must have a compact rendered summary");
    await node(page, "command-1").waitFor();
    await edges(page, [...localEdgeIds.filter((id) => id.endsWith("-1")), "cross-read"]);
    assert.match(await page.locator('.react-flow__edge[data-id="cross-read"]').getAttribute("aria-label"), /story-0.*query-1/, "collapsed story must proxy its actual outgoing edge");
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Collapse all stories", exact: true }).click();
      await node(page, "command-1").waitFor({ state: "detached" });
    }, "collapsing all stories");
    assert.deepEqual((await page.locator(".react-flow__node").evaluateAll((elements) => elements.map((element) => element.dataset.id))).sort(), ["story-0", "story-1"]);
    await edges(page, ["cross-read"]);
    assert.match(await page.locator('.react-flow__edge[data-id="cross-read"]').getAttribute("aria-label"), /story-0.*story-1/, "two collapsed endpoints must retain the real cross-story edge");
    await page.reload();
    await page.getByRole("button", { name: "Expand Alpha", exact: true }).waitFor();
    await page.getByRole("button", { name: "Expand Beta", exact: true }).waitFor();
    assert.equal(await node(page, "command-0").count(), 0);
    assert.equal(await node(page, "command-1").count(), 0);
    await page.waitForTimeout(600);
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Expand Alpha", exact: true }).click();
      await node(page, "command-0").waitFor();
    }, "expanding one story");
    assert.equal(await node(page, "command-1").count(), 0, "expansion must not expand the other story");
    await page.reload();
    await node(page, "command-0").waitFor();
    await page.getByRole("button", { name: "Expand Beta", exact: true }).waitFor();
    assert.equal(await node(page, "command-1").count(), 0);
    await page.waitForTimeout(600);
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Expand all stories", exact: true }).click();
      await node(page, "command-1").waitFor();
    }, "expanding all stories");
    assert.equal(await page.locator(".react-flow__node").count(), model().nodes.length);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Space drag starts over a node and releases cleanly on keyup and window blur", async () => {
  const { page, errors } = await open();
  try {
    const canvas = page.locator(".canvas");
    await selectNode(page, "command-0", "Alpha command");
    await node(page, "command-0").focus();
    const start = await center(node(page, "command-0"));
    const before = await viewport(page);
    await page.mouse.move(start.x, start.y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y + 45, { steps: 5 });
    await page.waitForTimeout(50);
    const dragged = await viewport(page);
    closeTo(dragged.x - before.x, 70, "Space drag x");
    closeTo(dragged.y - before.y, 45, "Space drag y");
    closeTo(dragged.zoom, before.zoom, "Space drag must not zoom", 0.00001);
    assert.equal(await node(page, "command-0").locator(".selected").count(), 1, "panning preserves the selection that preceded Space");
    assert.equal(await page.locator(".em-node.selected").count(), 1, "panning must not select another node");
    await page.keyboard.up("Space");
    await page.mouse.move(start.x + 100, start.y + 70, { steps: 3 });
    await page.waitForTimeout(50);
    sameViewport(await viewport(page), dragged, "keyup ends the active drag immediately");
    await page.mouse.up();
    await unchanged(page, () => selectNode(page, "command-0", "Alpha command"), "normal click after Space release");

    await canvas.focus();
    const next = await center(node(page, "command-1"));
    await page.mouse.move(next.x, next.y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(next.x - 35, next.y - 25, { steps: 3 });
    await page.waitForTimeout(50);
    const beforeBlur = await viewport(page);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.move(next.x - 70, next.y - 55, { steps: 3 });
    await page.waitForTimeout(50);
    sameViewport(await viewport(page), beforeBlur, "window blur ends the active drag");
    await page.mouse.up();
    await page.keyboard.up("Space");
    await unchanged(page, () => selectNode(page, "command-1", "Beta command"), "normal click after blur");
    assert.deepEqual(errors, []);
  } finally {
    await page.mouse.up().catch(() => {});
    await page.keyboard.up("Space").catch(() => {});
    await page.close();
  }
});

test("wheel pans, Shift-wheel pans horizontally, and Ctrl-wheel zooms about the cursor", async () => {
  const { page, errors } = await open();
  try {
    const canvas = await page.locator(".canvas").boundingBox();
    const cursor = { x: canvas.x + canvas.width * 0.28, y: canvas.y + canvas.height * 0.38 };
    await page.mouse.move(cursor.x, cursor.y);
    const before = await viewport(page);
    await page.mouse.wheel(24, 80);
    await page.waitForTimeout(150);
    const panned = await viewport(page);
    closeTo(panned.x - before.x, -24, "plain wheel x pan");
    closeTo(panned.y - before.y, -80, "plain wheel y pan");
    closeTo(panned.zoom, before.zoom, "plain wheel must not zoom", 0.00001);
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 70);
    await page.keyboard.up("Shift");
    await page.waitForTimeout(150);
    const shifted = await viewport(page);
    closeTo(shifted.x - panned.x, -70, "Shift-wheel horizontal pan");
    closeTo(shifted.y, panned.y, "Shift-wheel must not pan vertically");
    closeTo(shifted.zoom, before.zoom, "Shift-wheel must not zoom", 0.00001);

    const world = { x: (cursor.x - canvas.x - shifted.x) / shifted.zoom, y: (cursor.y - canvas.y - shifted.y) / shifted.zoom };
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120); // Browsers deliver a trackpad pinch as a Ctrl-wheel gesture.
    await page.keyboard.up("Control");
    await page.waitForTimeout(150);
    const zoomed = await viewport(page);
    assert.ok(zoomed.zoom > shifted.zoom, "Ctrl-wheel must zoom in");
    closeTo((cursor.x - canvas.x - zoomed.x) / zoomed.zoom, world.x, "cursor anchored world x", 1);
    closeTo((cursor.y - canvas.y - zoomed.y) / zoomed.zoom, world.y, "cursor anchored world y", 1);
    assert.deepEqual(errors, []);
  } finally {
    await page.keyboard.up("Shift").catch(() => {});
    await page.keyboard.up("Control").catch(() => {});
    await page.close();
  }
});

test("sidebar wheel scroll remains local and Space in a text field does not activate panning", async () => {
  const { page, errors } = await open();
  try {
    await selectNode(page, "query-1", "Beta query");
    const panel = page.getByRole("complementary", { name: "Node details" });
    assert.ok(await panel.evaluate((element) => element.scrollHeight > element.clientHeight), "fixture must create genuine sidebar overflow");
    await panel.evaluate((element) => { element.scrollTop = 0; });
    await unchanged(page, async () => {
      const bounds = await panel.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('[aria-label="Node details"]').scrollTop > 0);
    }, "scrolling the sidebar");
    const search = page.getByLabel("Search event model", { exact: true });
    await unchanged(page, async () => {
      await search.fill("Alpha");
      await search.press("Space");
      await page.keyboard.type("command");
      assert.equal(await search.inputValue(), "Alpha command", "Space must type normally inside search");
      await search.fill("");
    }, "typing in search");
    assert.equal(await page.locator(".canvas").getAttribute("data-navigation-mode"), "idle", "typing Space must not leave a latent pan state");
    await unchanged(page, () => selectNode(page, "command-0", "Alpha command"), "normal click after editing");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Space drag captures an edge-label button without triggering field selection", async () => {
  const { page, errors } = await open();
  try {
    await selectNode(page, "command-0", "Alpha command");
    const label = page.locator(".edge-field-label").getByRole("button", { name: "id", exact: true }).first();
    await label.waitFor();
    await page.locator(".canvas").focus();
    const start = await center(label);
    const before = await viewport(page);
    await page.mouse.move(start.x, start.y);
    await page.keyboard.down("Space");
    assert.equal(await page.locator(".canvas").getAttribute("data-navigation-mode"), "ready");
    await page.mouse.down();
    await page.mouse.move(start.x + 45, start.y + 30, { steps: 4 });
    await page.waitForTimeout(50);
    const dragged = await viewport(page);
    closeTo(dragged.x - before.x, 45, "edge-label drag x");
    closeTo(dragged.y - before.y, 30, "edge-label drag y");
    assert.equal(await page.locator(".canvas").getAttribute("data-navigation-mode"), "dragging");
    await page.mouse.up();
    await page.keyboard.up("Space");
    assert.equal(await page.locator(".canvas").getAttribute("data-navigation-mode"), "idle");
    assert.equal(await page.getByRole("button", { name: "Clear field focus", exact: true }).count(), 0, "dragging must not activate the field button");
    await unchanged(page, async () => {
      await label.click();
      await page.getByRole("button", { name: "Clear field focus", exact: true }).waitFor();
    }, "normal field-button click after dragging");
    assert.deepEqual(errors, []);
  } finally {
    await page.mouse.up().catch(() => {});
    await page.keyboard.up("Space").catch(() => {});
    await page.close();
  }
});

test("Space preserves native keyboard button activation and contenteditable input", async () => {
  const { page, errors } = await open();
  try {
    const canvas = page.locator(".canvas");
    await unchanged(page, async () => {
      await page.getByRole("button", { name: "Collapse Alpha", exact: true }).focus();
      await page.keyboard.down("Space");
      assert.equal(await canvas.getAttribute("data-navigation-mode"), "idle", "Space on a keyboard button must not start navigation");
      await page.keyboard.up("Space");
      await page.getByRole("button", { name: "Expand Alpha", exact: true }).waitFor();
      await node(page, "command-0").waitFor({ state: "detached" });
    }, "keyboard collapse button");
    await page.getByRole("button", { name: "Expand Alpha", exact: true }).focus();
    await page.keyboard.press("Space");
    await node(page, "command-0").waitFor();

    // A DOM fixture exercises the generic editable guard without changing application state.
    await page.getByRole("complementary", { name: "Node details" }).evaluate((panel) => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.setAttribute("role", "textbox");
      editor.setAttribute("aria-label", "Navigation contenteditable fixture");
      editor.style.minHeight = "30px";
      panel.prepend(editor);
    });
    const editor = page.getByRole("textbox", { name: "Navigation contenteditable fixture", exact: true });
    await unchanged(page, async () => {
      await editor.focus();
      await page.keyboard.type("editable");
      await page.keyboard.press("Space");
      await page.keyboard.type("text");
      assert.equal(await editor.textContent(), "editable text");
      assert.equal(await canvas.getAttribute("data-navigation-mode"), "idle", "Space in contenteditable must stay an editing key");
    }, "contenteditable input");
    await unchanged(page, () => selectNode(page, "command-0", "Alpha command"), "normal selection after contenteditable input");
    assert.deepEqual(errors, []);
  } finally {
    await page.keyboard.up("Space").catch(() => {});
    await page.close();
  }
});

test("same-name legacy headers collapse independently and explicit focus centers the selected node's summary", async () => {
  const project = () => {
    const result = model();
    for (const story of result.stories) story.name = "Same";
    for (const slice of result.slices) slice.storyName = "Same";
    for (const item of result.nodes) {
      if (item.storyName) item.storyName = "Same";
      if (item.type === "story") item.label = "Same";
    }
    return result;
  };
  const { page, errors } = await open({ project });
  try {
    await page.getByLabel("Edge visibility", { exact: true }).selectOption("all");
    await selectNode(page, "command-0", "Alpha command");
    await unchanged(page, async () => {
      await node(page, "story-0").getByRole("button", { name: "Collapse Same", exact: true }).click();
      await node(page, "command-0").waitFor({ state: "detached" });
    }, "same-name legacy collapse");
    await node(page, "command-1").waitFor();
    await edges(page, [...localEdgeIds.filter((id) => id.endsWith("-1")), "cross-read"]);
    const panel = page.getByRole("complementary", { name: "Node details" });
    await panel.getByRole("heading", { name: "Alpha command", exact: true }).waitFor();
    await panel.getByRole("button", { name: "Focus selected node", exact: true }).click();
    await page.waitForTimeout(450);
    const summary = await node(page, "story-0").boundingBox();
    const canvas = await page.locator(".canvas").boundingBox();
    closeTo(summary.x + summary.width / 2, canvas.x + canvas.width / 2, "focus summary x", 1);
    closeTo(summary.y + summary.height / 2, canvas.y + canvas.height / 2, "focus summary y", 1);
    await page.reload();
    await node(page, "story-0").getByRole("button", { name: "Expand Same", exact: true }).waitFor();
    await node(page, "command-1").waitFor();
    assert.equal(await node(page, "command-0").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

function scopedModel() {
  const result = model();
  result.stories.forEach((story, index) => { story.id = "stable-" + index; });
  result.slices.forEach((slice, index) => { slice.storyId = "stable-" + index; });
  for (const item of result.nodes) {
    const index = item.id.endsWith("-0") ? 0 : 1;
    item.storyId = "stable-" + index;
  }
  result.timelines = ["one", "two"].map((id) => ({
    id, name: id, path: id + ".timeline.yaml", steps: result.stories.map((story, index) => ({
      id: "step-" + index, storyId: story.id, after: index ? ["step-0"] : []
    }))
  }));
  return result;
}

test("collapse preferences stay scoped to project and timeline IDs across rename and reload", async () => {
  let current = scopedModel();
  const { page, errors } = await open({ project: () => current });
  try {
    await page.getByRole("button", { name: "Collapse Alpha", exact: true }).click();
    await node(page, "command-0").waitFor({ state: "detached" });
    const timeline = page.getByLabel("Timeline", { exact: true });
    await timeline.selectOption("one");
    await node(page, "command-0").waitFor();
    await page.getByRole("button", { name: "Collapse Beta", exact: true }).click();
    await node(page, "command-1").waitFor({ state: "detached" });
    await timeline.selectOption("two");
    await node(page, "command-0").waitFor();
    await node(page, "command-1").waitFor();
    await timeline.selectOption("one");
    await node(page, "command-0").waitFor();
    assert.equal(await node(page, "command-1").count(), 0);
    await timeline.selectOption("");
    await node(page, "command-1").waitFor();
    assert.equal(await node(page, "command-0").count(), 0);
    current.stories[0].name = "Renamed";
    current.nodes.find((item) => item.id === "story-0").label = "Renamed";
    await page.reload();
    await page.getByRole("button", { name: "Expand Renamed", exact: true }).waitFor();
    await node(page, "command-1").waitFor();
    current = { ...current, root: "/second-project" };
    await page.reload();
    await node(page, "command-0").waitFor();
    await node(page, "command-1").waitFor();
    current = { ...current, root: "/navigation-fixture" };
    await page.reload();
    await page.getByRole("button", { name: "Expand Renamed", exact: true }).waitFor();
    await node(page, "command-1").waitFor();
    assert.equal(await node(page, "command-0").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const fault of ["malformed", "invalid-value", "unavailable"]) {
  test("story controls remain usable with " + fault + " localStorage", async () => {
    const { page, errors } = await open({ initArg: fault, init: (fault) => {
      if (fault === "unavailable") {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Fixture denies storage", "SecurityError"); } });
      } else {
        Storage.prototype.getItem = function (key) {
          return key.startsWith("emviz:collapsed-stories:") ? (fault === "malformed" ? "{" : '{"not":"an array"}') : null;
        };
      }
    } });
    try {
      await page.getByRole("button", { name: "Collapse Alpha", exact: true }).click();
      await node(page, "command-0").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Expand Alpha", exact: true }).click();
      await node(page, "command-0").waitFor();
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("synthetic Meta-wheel and native pinch events preserve the cursor's graph coordinate", async () => {
  const { page, errors } = await open();
  try {
    for (const kind of ["meta-wheel", "gesture"]) {
      const before = await viewport(page);
      const anchor = await page.locator(".canvas").evaluate((canvas, kind) => {
        const rect = canvas.getBoundingClientRect();
        const x = rect.width * 0.7;
        const y = rect.height * 0.3;
        const properties = { clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true };
        if (kind === "meta-wheel") {
          canvas.dispatchEvent(new WheelEvent("wheel", { ...properties, deltaY: -100, metaKey: true }));
        } else {
          for (const [type, scale] of [["gesturestart", 1], ["gesturechange", 1.2], ["gesturechange", 1.4], ["gestureend", 1.4]]) {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.assign(event, { clientX: properties.clientX, clientY: properties.clientY, scale });
            canvas.dispatchEvent(event);
          }
        }
        return { x, y };
      }, kind);
      await page.waitForTimeout(100);
      const after = await viewport(page);
      assert.ok(after.zoom > before.zoom, kind + " zooms in");
      closeTo((anchor.x - after.x) / after.zoom, (anchor.x - before.x) / before.zoom, kind + " anchored x", 1);
      closeTo((anchor.y - after.y) / after.zoom, (anchor.y - before.y) / before.zoom, kind + " anchored y", 1);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("slice selection reveals every incoming and outgoing cross edge but no unrelated dependency", async () => {
  const project = () => {
    const result = model();
    result.nodes.push(
      { ...result.nodes.find((item) => item.id === "query-1"), id: "second-query", label: "Second query" },
      { id: "external-event", type: "event", label: "Boundary", sourcePath: "events.yaml" },
      { id: "unrelated-query", type: "query", label: "Unrelated", sourcePath: "external.yaml" }
    );
    result.edges.push(
      { id: "second-read", kind: "event-query", source: "event-0", target: "second-query" },
      { id: "reverse-read", kind: "event-query", source: "event-1", target: "query-0" },
      { id: "unrelated-read", kind: "event-query", source: "external-event", target: "unrelated-query" }
    );
    return result;
  };
  const { page, errors } = await open({ project });
  try {
    await edges(page, localEdgeIds);
    await node(page, "slice-1").locator(".group-title").click();
    await edges(page, [...allEdgeIds, "second-read", "reverse-read"]);
    await selectNode(page, "query-1", "Beta query");
    await edges(page, allEdgeIds);
    const panel = page.getByRole("complementary", { name: "Node details" });
    for (const mode of ["auto", "intra-slice", "all"]) {
      await page.getByLabel("Edge visibility", { exact: true }).selectOption(mode);
      await panel.getByRole("button", { name: "Alpha saved", exact: true }).waitFor();
    }
    await unchanged(page, async () => {
      await panel.getByRole("button", { name: "Alpha saved", exact: true }).click();
      await panel.getByRole("heading", { name: "Alpha saved", exact: true }).waitFor();
    }, "canonical sidebar connection navigation");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("offline export and diff inputs retain navigation, proxies and local input ownership", async () => {
  const host = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
  const address = "http://127.0.0.1:" + host.httpServer.address().port;
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "emviz-navigation-export-"));
  try {
    for (const isDiff of [false, true]) {
      const project = model();
      const diff = isDiff ? {
        nodeStatus: Object.fromEntries(project.nodes.map((item) => [item.id, "changed"])),
        edgeStatus: Object.fromEntries(project.edges.map((item) => [item.id, "changed"])),
        base: { label: "Before" }, target: { label: "After" }, previousNodes: {},
        summary: {
          nodes: { added: 0, removed: 0, changed: project.nodes.length, unchanged: 0 },
          edges: { added: 0, removed: 0, changed: project.edges.length, unchanged: 0 }
        }
      } : undefined;
      const { page, errors } = await open({ address, diff });
      let file;
      try {
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
        const download = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Export", exact: true }).click();
        file = join(scratch, isDiff ? "diff.html" : "current.html");
        await (await download).saveAs(file);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
      const saved = await open({ address: pathToFileURL(file).href });
      const requests = [];
      saved.page.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
      try {
        await saved.page.reload();
        await node(saved.page, "command-0").waitFor();
        await saved.page.waitForTimeout(600);
        await saved.page.getByLabel("Edge visibility", { exact: true }).selectOption("all");
        await edges(saved.page, allEdgeIds);
        await unchanged(saved.page, async () => {
          await saved.page.getByRole("button", { name: "Collapse all stories", exact: true }).click();
          await node(saved.page, "command-0").waitFor({ state: "detached" });
        }, "offline collapse");
        await edges(saved.page, ["cross-read"]);
        await saved.page.getByRole("button", { name: "Expand all stories", exact: true }).click();
        await edges(saved.page, allEdgeIds);
        await selectNode(saved.page, "query-1", "Beta query");
        const before = await viewport(saved.page);
        const cursor = await center(saved.page.locator(".canvas"));
        await saved.page.mouse.move(cursor.x, cursor.y);
        await saved.page.mouse.wheel(12, 35);
        await saved.page.waitForTimeout(100);
        const panned = await viewport(saved.page);
        closeTo(panned.x - before.x, -12, "offline x pan");
        closeTo(panned.y - before.y, -35, "offline y pan");
        assert.deepEqual(requests, [], "offline navigation must not request network resources");
        assert.deepEqual(saved.errors, []);
      } finally { await saved.page.close(); }
    }
  } finally {
    await new Promise((resolveClose, reject) => host.httpServer.close((error) => error ? reject(error) : resolveClose()));
  }
});

test("matching actor filters keep collapsed story summaries without a false empty state", async () => {
  const { page, errors } = await open();
  try {
    await page.locator(".actor-filter summary").click();
    await page.getByRole("checkbox", { name: "member", exact: true }).check();
    await page.locator(".actor-filter summary").click();
    await node(page, "screen-0").waitFor();
    await page.getByRole("button", { name: "Collapse all stories", exact: true }).click();
    await node(page, "screen-0").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Expand Alpha", exact: true }).waitFor();
    assert.equal(await page.locator(".actor-empty").count(), 0, "matched collapsed stories are not an empty actor result");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
