import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

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

async function open() {
  // A new context gives each case fresh storage; reloads within a case retain it.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/*", (route) => route.fulfill({
    json: new URL(route.request().url()).pathname === "/api/model"
      ? model() : { findings: [], errors: 0, warnings: 0 }
  }));
  await page.route("**/api/session?**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/diff", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(url);
  await node(page, "command-0").waitFor();
  await page.waitForTimeout(600); // Initial fit-to-view is allowed to animate.
  return { page, errors };
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
