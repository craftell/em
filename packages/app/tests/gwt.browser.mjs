import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let server;
let browser;
let url;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

function model(count = 100) {
  const stories = ["First", "Second"].map((name, index) => ({ name, description: "", path: `${name}.yaml`, slices: [`slice-${index}.yaml`] }));
  const slices = stories.map((story, index) => ({ title: "Same slice title", path: story.slices[0], storyName: story.name, screen: { actors: [], reads: [], executes: [] }, commands: [], queries: [], gwt: [] }));
  const nodes = stories.flatMap((story, index) => {
    const shared = { sourcePath: slices[index].path, sliceTitle: slices[index].title, storyName: story.name, raw: "title: Same slice title\ngwt: []" };
    return [
      { id: `story-${index}`, type: "story", label: story.name },
      { ...shared, id: `slice-${index}`, type: "slice", label: slices[index].title },
      { ...shared, id: `command-${index}`, type: "command", label: `Command ${index}`, fields: "id: string" },
      ...Array.from({ length: count }, (_, n) => ({ ...shared, id: `gwt-${index}-${n}`, type: "gwt", label: n < 2 ? "Duplicate" : n === 2 ? "Scenario 3" : `Case ${index}-${n}`, description: `Details ${index}-${n}`, given: [{ type: "event", name: "Prior event", fields: "long value ".repeat(200) }], when: [{ type: "command", name: `Action ${index}-${n}` }], then: [] }))
    ];
  });
  return { root: "", config: { paths: {} }, events: [], stories, slices, nodes, edges: [] };
}

function modelWithConnection(count = 100) {
  const project = model(count);
  project.nodes.push({ id: "saved-event", type: "event", label: "Saved event", fields: "value: string", raw: "value: string" });
  project.edges.push({ id: "saved-edge", source: "command-0", target: "saved-event", kind: "command-event", label: "publishes" });
  return project;
}

async function open(count = 100, transform = (project) => project, diff) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.copiedText = value; } } });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/*", (route) => route.fulfill({ json: route.request().url().endsWith("/model") ? transform(model(count)) : { findings: [], errors: 0, warnings: 0 } }));
  // Prevent treating the validation payload as a diff.
  await page.route("**/api/diff", (route) => route.fulfill(diff ? { json: diff } : { status: 404, body: "" }));
  await page.goto(url);
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(600); // Allow initial fit-to-view animation to settle.
  return { page, errors };
}

test("connections list only direct neighbor nodes, without field rows or GWT references", async () => {
  const { page, errors } = await open(3, () => {
    const project = modelWithConnection(3);
    project.nodes.find((node) => node.id === "saved-event").fields = "id: string";
    project.nodes.push({ id: "query", type: "query", label: "Saved query", sourcePath: "slice-0.yaml", sliceTitle: "Same slice title", fields: "id: string" });
    project.edges.push({ id: "read", source: "saved-event", target: "query", kind: "event-query" });
    return project;
  });
  try {
    const panel = page.getByRole("complementary", { name: "Node details" });
    await page.locator('[data-id="command-0"]').click();
    assert.deepEqual(await panel.locator(".connection-button").allTextContents(), ["Saved event"]);
    await panel.getByRole("button", { name: "Saved event", exact: true }).click();
    assert.deepEqual(await panel.locator(".connection-button").allTextContents(), ["Command 0", "Saved query"]);
    await panel.getByRole("button", { name: "Saved query", exact: true }).click();
    assert.deepEqual(await panel.locator(".connection-button").allTextContents(), ["Saved event"]);
    await page.locator('[data-id="gwt-0-0"] .gwt-summary button').first().click();
    assert.equal(await panel.locator(".connection-button").count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

async function geometry(page) {
  return page.evaluate(() => ({
    viewport: document.querySelector(".react-flow__viewport").getAttribute("style"),
    nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => [node.dataset.id, node.style.transform, node.style.width, node.style.height])
  }));
}

test("compact counts, fixed dimensions, direct details, keyboard, lists, copies and normal nodes", async () => {
  let baseline;
  for (const count of [0, 1, 3, 4, 100]) {
    const { page, errors } = await open(count);
    try {
      assert.equal(await page.locator(".gwt-summary").count(), count ? 2 : 0);
      if (!count) continue;
      const summary = page.locator('[data-id="gwt-0-0"]');
      assert.equal(await summary.locator(".gwt-summary button").count(), Math.min(count, 3));
      assert.match(await summary.textContent(), new RegExp(`GWT · ${count} cases`));
      assert.equal(await summary.locator(".gwt-more button").count(), count > 3 ? 1 : 0);
      if (count > 3) assert.equal(await summary.locator(".gwt-more button").textContent(), `+${count - 3} more`);
      const initial = await geometry(page);
      if (baseline) assert.deepEqual(initial, baseline);
      else baseline = initial;
      const first = summary.locator(".gwt-summary button").first();
      await first.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByRole("complementary", { name: "Node details" });
      await panel.waitFor();
      assert.match(await panel.textContent(), /Details 0-0/);
      assert.deepEqual(await panel.locator(".gwt-step-title").allTextContents(), ["Given", "When", "Then"]);
      assert.match(await panel.textContent(), /long value/);
      assert.match(await panel.textContent(), /empty/);
      await panel.getByRole("button", { name: "All scenarios", exact: true }).click();
      const list = page.getByRole("complementary", { name: "GWT scenarios" });
      assert.equal(await list.locator(".gwt-all-list button").count(), count);
      await list.locator(".gwt-all-list button").last().click();
      assert.match(await panel.textContent(), new RegExp(`Details 0-${count - 1}`));
      await panel.locator("summary").filter({ hasText: "Copy for LLM" }).click();
      assert.match(await panel.textContent(), /Source YAML for the whole slice/);
      assert.match(await panel.textContent(), /em:\/\/event_model\/gwt-0-/);
      await panel.locator(".copy-action").filter({ hasText: "Stable em://" }).click();
      assert.equal(await page.evaluate(() => window.copiedText), `em://event_model/gwt-0-${count - 1}`);
      await panel.locator(".copy-action").filter({ hasText: "Source YAML" }).click();
      assert.equal(await page.evaluate(() => window.copiedText), "title: Same slice title\ngwt: []");
      await panel.locator(".copy-action").filter({ hasText: "Reference plus incoming" }).click();
      assert.match(await page.evaluate(() => window.copiedText), /Incoming:/);
      await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      assert.deepEqual(await geometry(page), initial);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-id="gwt-0-0"] .gwt-summary button'));
      assert.deepEqual(await geometry(page), initial);
      if (count > 3) {
        await summary.getByRole("button", { name: `+${count - 3} more`, exact: true }).click();
        await list.waitFor();
        assert.equal(await page.getByLabel("Scenario details").count(), 0);
        await list.getByRole("button", { name: "Close", exact: true }).click();
        assert.deepEqual(await geometry(page), initial);
      }
      await page.locator('[data-id="command-0"]').click();
      assert.match(await panel.textContent(), /Command 0/);
      assert.match(await panel.textContent(), /Connections/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("long names and content stay readable in a narrow panel without moving the diagram", async () => {
  const longName = "A long scenario name ".repeat(30);
  const { page } = await open(100, (project) => {
    project.nodes.find((node) => node.id === "gwt-0-0").label = longName;
    return project;
  });
  try {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(100);
    const initial = await geometry(page);
    const summary = page.locator('[data-id="gwt-0-0"]');
    await summary.locator(".gwt-more button").focus();
    await page.keyboard.press("Space");
    const list = page.getByRole("complementary", { name: "GWT scenarios" });
    await list.waitFor();
    await list.locator(".gwt-all-list button").first().focus();
    await page.keyboard.press("Enter");
    const panel = page.getByRole("complementary", { name: "Node details" });
    assert.equal(await panel.locator("h2").textContent(), longName);
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 600);
    assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await panel.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(100);
    assert.ok(await panel.evaluate((element) => element.scrollTop > 0));
    assert.deepEqual(await geometry(page), initial);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement === document.querySelector('[data-id="gwt-0-0"] .gwt-more button'));
    assert.deepEqual(await geometry(page), initial);
  } finally { await page.close(); }
});

test("hidden search results, history and same-named cases keep identity and viewport", async () => {
  const { page, errors } = await open();
  try {
    const initial = await geometry(page);
    await page.locator('[data-id="gwt-0-0"] .gwt-summary button').nth(1).click();
    const panel = page.getByRole("complementary", { name: "Node details" });
    assert.match(await panel.textContent(), /Details 0-1/);
    const search = page.locator(".search-box input");
    await search.fill("Case 1-99");
    await page.locator(".search-results button").click();
    assert.match(await panel.textContent(), /Details 1-99/);
    assert.deepEqual(await geometry(page), initial);
    await page.locator(".toolbar-history button").first().click();
    assert.match(await panel.textContent(), /Details 0-1/);
    await page.locator(".toolbar-history button").last().click();
    assert.match(await panel.textContent(), /Details 1-99/);
    assert.deepEqual(await geometry(page), initial);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("slice name filtering, no results, duplicate identities and keyboard round trips preserve the diagram", async () => {
  const { page, errors } = await open();
  try {
    const initial = await geometry(page);
    const summary = page.locator('[data-id="gwt-0-0"]');
    const summaryText = await summary.textContent();
    const unchanged = async () => {
      assert.deepEqual(await geometry(page), initial);
      assert.equal(await summary.textContent(), summaryText);
    };
    await summary.locator(".gwt-more button").focus();
    await page.keyboard.press("Enter");
    const list = page.getByRole("complementary", { name: "GWT scenarios" });
    const input = list.getByRole("searchbox", { name: "Filter by scenario name" });
    const results = list.locator(".gwt-all-list button");
    // From the opening focus (Close), Tab reaches the labelled search input.
    await page.keyboard.press("Tab");
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    assert.equal(await input.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
    await page.keyboard.type("  cAsE 0-9  ");
    assert.deepEqual(await results.allTextContents(), ["Case 0-9", ...Array.from({ length: 10 }, (_, n) => `Case 0-${90 + n}`)]);
    await unchanged();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await unchanged();
    for (const query of ["Prior event", "Action 0", "Details 0", "Case 1-99", "missing"]) {
      await input.fill(query);
      assert.equal(await results.count(), 0);
      assert.equal(await list.getByRole("status").textContent(), "No scenarios match this name.");
      await unchanged();
    }
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "");
    assert.equal(await results.count(), 100);
    assert.deepEqual((await results.allTextContents()).slice(0, 3), ["Duplicate", "Duplicate", "Scenario 3"]);
    await unchanged();
    await input.fill("   ");
    assert.equal(await results.count(), 100);
    await input.fill(" pLiCa ");
    assert.deepEqual(await results.allTextContents(), ["Duplicate", "Duplicate"]);
    const panel = page.getByRole("complementary", { name: "Node details" });
    for (let n = 0; n < 2; n++) {
      await input.focus();
      await page.keyboard.press("Tab"); // Clear
      await page.keyboard.press("Tab"); // first result
      if (n) await page.keyboard.press("Tab");
      assert.equal(await results.nth(n).evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press("Enter");
      assert.match(await panel.textContent(), new RegExp(`Details 0-${n}`));
      assert.match(await panel.textContent(), new RegExp(`Action 0-${n}`));
      assert.ok((await panel.textContent()).includes("long value ".repeat(200).trim()));
      await unchanged();
      await page.keyboard.press("Enter"); // automatically focused All scenarios
      assert.equal(await input.inputValue(), " pLiCa ");
      assert.equal(await results.nth(n).getAttribute("aria-current"), "true");
      await unchanged();
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("filtered long lists restore scroll and reset on same-titled slice switches", async () => {
  const longName = "Matching long scenario name ".repeat(30);
  const { page, errors } = await open(100, (project) => {
    for (const node of project.nodes) {
      if (node.type === "gwt") node.label = `${longName}${node.id}`;
    }
    return project;
  });
  try {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(100);
    const initial = await geometry(page);
    const list = page.getByRole("complementary", { name: "GWT scenarios" });
    const input = list.getByRole("searchbox");
    const panel = page.getByRole("complementary", { name: "Node details" });
    await page.locator('[data-id="gwt-0-0"] .gwt-more button').focus();
    await page.keyboard.press("Enter");
    await input.fill("matching");
    assert.equal(await list.locator(".gwt-all-list button").count(), 100);
    assert.equal(await list.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await list.hover();
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(100);
    assert.ok(await list.evaluate((element) => element.scrollTop > 0));
    assert.deepEqual(await geometry(page), initial);
    const result = list.locator(".gwt-all-list button").nth(20);
    await result.focus();
    const scroll = await list.evaluate((element) => element.scrollTop);
    await page.keyboard.press("Enter");
    assert.equal(await panel.locator("h2").textContent(), `${longName}gwt-0-20`);
    await panel.hover();
    await page.mouse.wheel(0, 10000);
    await page.waitForTimeout(100);
    await panel.getByRole("button", { name: "All scenarios", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "matching");
    assert.equal(await list.evaluate((element) => element.scrollTop), scroll);
    assert.equal(await result.evaluate((element) => element === document.activeElement), true);
    assert.equal(await result.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
    assert.deepEqual(await geometry(page), initial);
    // Open another slice through its canvas control, without closing the panel.
    await page.locator('[data-id="gwt-1-0"] .gwt-more button').focus();
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "");
    assert.equal(await list.evaluate((element) => element.scrollTop), 0);
    assert.equal(await list.locator(".gwt-all-list button").first().textContent(), `${longName}gwt-1-0`);
    assert.equal(await list.locator("[aria-current]").count(), 0);
    await input.fill("gwt-1-99");
    await list.locator(".gwt-all-list button").click();
    assert.match(await panel.textContent(), /Details 1-99/);
    await page.locator('[data-id="gwt-0-0"] .gwt-summary button').first().focus();
    await page.keyboard.press("Enter");
    assert.match(await panel.textContent(), /Details 0-0/);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "");
    assert.equal(await list.evaluate((element) => element.scrollTop), 0);
    assert.deepEqual(await geometry(page), initial);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});


async function savedHtml(project, diff) {
  const host = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
  const page = await browser.newPage();
  try {
    await page.route("**/api/*", (route) => {
      const endpoint = new URL(route.request().url()).pathname;
      return route.fulfill(endpoint === "/api/model" ? { json: project } : endpoint === "/api/diff" ? (diff ? { json: diff } : { status: 404, body: "" }) : { json: { findings: [], errors: 0, warnings: 0 } });
    });
    await page.goto(`http://127.0.0.1:${host.httpServer.address().port}`);
    await page.locator(".gwt-summary").first().waitFor();
    await page.getByRole("button", { name: "Open menu" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Export", exact: true }).click();
    const file = join(await mkdtemp(join(tmpdir(), "emviz-export-")), "model.html");
    await (await download).saveAs(file);
    return file;
  } finally {
    await page.close();
    await new Promise((resolve, reject) => host.httpServer.close((error) => error ? reject(error) : resolve()));
  }
}

async function openSaved(file) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const requests = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.copiedText = value; } } });
  });
  page.on("request", (request) => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  await page.goto(pathToFileURL(file).href);
  await page.locator(".gwt-summary").first().waitFor();
  await page.waitForTimeout(600);
  return { page, requests };
}

// Run the same user-visible accessibility contract against exported and diff inputs.
async function keyboardPanelRoundTrip(page, summary, query, body, scrollList) {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.waitForTimeout(100);
  const initial = await geometry(page);
  const summaryText = await summary.textContent();
  const unchanged = async () => {
    assert.deepEqual(await geometry(page), initial);
    assert.equal(await summary.textContent(), summaryText);
  };
  const focused = async (control) => {
    await page.waitForFunction((element) => element === document.activeElement, await control.elementHandle());
    assert.equal(await control.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
    assert.ok(await control.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth) > 0));
  };
  const more = summary.locator(".gwt-more button");
  await more.focus();
  await page.keyboard.press("Enter");
  const list = page.getByRole("complementary", { name: "GWT scenarios" });
  const input = list.getByRole("searchbox");
  await page.keyboard.press("Tab");
  await focused(input);
  await unchanged();
  if (scrollList) {
    await list.hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => document.querySelector('[aria-label="GWT scenarios"]').scrollTop > 0);
    await unchanged();
  }
  await page.keyboard.type(query);
  const result = list.locator(".gwt-all-list button");
  assert.equal(await result.count(), 1);
  await unchanged();
  await page.keyboard.press("Tab"); // Clear filter
  await page.keyboard.press("Tab"); // result
  await focused(result);
  await page.keyboard.press("Enter");
  const detail = page.getByRole("complementary", { name: "Node details" });
  assert.ok((await detail.textContent()).includes(body));
  const back = detail.getByRole("button", { name: "All scenarios", exact: true });
  await focused(back);
  await unchanged();
  // Wheel over the panel padding, outside nested scrollable code blocks.
  await detail.hover({ position: { x: 8, y: 100 } });
  await page.mouse.wheel(0, 1200);
  await page.waitForFunction(() => document.querySelector('[aria-label="Node details"]').scrollTop > 0);
  await unchanged();
  await page.keyboard.press("Enter"); // focused All scenarios
  await focused(result);
  assert.equal(await input.inputValue(), query);
  await unchanged();
  await page.keyboard.press("Shift+Tab"); // Clear filter
  await page.keyboard.press("Enter");
  assert.equal(await input.inputValue(), "");
  await unchanged();
  await page.keyboard.press("Escape");
  await focused(more);
  await unchanged();
}

test("saved HTML retains every scenario and works after its server stops", async () => {
  for (const count of [4, 100]) {
    const exportedProject = modelWithConnection(count);
    const { page, requests } = await openSaved(await savedHtml(exportedProject));
    try {
      const summary = page.locator('[data-id="gwt-0-0"]');
      await keyboardPanelRoundTrip(page, summary, `Case 0-${count - 1}`, `Details 0-${count - 1}`, count === 100);
      const initial = await geometry(page);
      assert.match(await summary.textContent(), new RegExp(`GWT · ${count} cases`));
      assert.equal(await summary.locator(".gwt-summary button").count(), 3);
      await summary.locator(".gwt-summary button").first().focus();
      await page.keyboard.press("Enter");
      const detail = page.getByRole("complementary", { name: "Node details" });
      assert.match(await detail.textContent(), /Details 0-0/);
      await page.keyboard.press("Escape");
      await summary.getByRole("button", { name: `+${count - 3} more`, exact: true }).click();
      const list = page.getByRole("complementary", { name: "GWT scenarios" });
      await list.getByLabel("Filter by scenario name").fill(` Case 0-${count - 1} `);
      assert.equal(await list.locator(".gwt-all-list button").count(), 1);
      await list.locator(".gwt-all-list button").focus();
      await page.keyboard.press("Enter");
      assert.match(await detail.textContent(), new RegExp(`Details 0-${count - 1}`));
      assert.match(await detail.textContent(), new RegExp(`gwt-0-${count - 1}`));
      assert.match(await detail.textContent(), /slice-0.yaml/);
      assert.ok(await detail.evaluate((node) => node.scrollHeight > node.clientHeight));
      await detail.getByRole("button", { name: "All scenarios", exact: true }).click();
      await list.getByRole("button", { name: "Clear filter" }).click();
      assert.equal(await list.locator(".gwt-all-list button").count(), count);
      assert.deepEqual(await geometry(page), initial);
      await list.getByRole("button", { name: "Close", exact: true }).click();
      await page.locator(".search-box input").fill(`Case 0-${count - 1}`);
      await page.locator(".search-results button").click();
      assert.match(await detail.textContent(), new RegExp(`Details 0-${count - 1}`));
      await detail.locator("summary").filter({ hasText: "Copy for LLM" }).click();
      await detail.getByRole("button", { name: "YAML Source YAML for the whole slice", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copiedText), model(count).nodes.find((node) => node.id === `gwt-0-${count - 1}`).raw);
      assert.deepEqual(await geometry(page), initial);
      await page.keyboard.press("Escape");
      await page.locator('[data-id="saved-event"]').click();
      const eventDetail = page.getByRole("complementary", { name: "Node details" });
      assert.equal(await eventDetail.locator("h2").textContent(), "Saved event");
      assert.match(await eventDetail.textContent(), /value: string/);
      assert.match(await eventDetail.textContent(), /Connections/);
      assert.match(await eventDetail.textContent(), /Command 0/);
      const savedEdge = page.locator('.react-flow__edge[data-id="saved-edge"]');
      await savedEdge.waitFor();
      const edgePath = savedEdge.locator("path.react-flow__edge-path");
      assert.equal(await edgePath.count(), 1);
      assert.ok(await edgePath.getAttribute("d"));
      assert.equal(await savedEdge.isVisible(), true);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  }
});

test("real diff survives export: filtered summaries, hidden changes and old content", async () => {
  const { diffEventModelProjects } = await server.ssrLoadModule("../graph/src/index.ts");
  const base = model(16);
  base.nodes.push({ id: "event", type: "event", label: "Event", fields: "old: string" });
  base.edges.push({ id: "edge", source: "command-0", target: "event", kind: "command-event", label: "old" });
  base.nodes.push({ id: "removed-event", type: "event", label: "Removed event", fields: "removed: string" });
  base.edges.push({ id: "removed-edge", source: "command-0", target: "removed-event", kind: "command-event" });
  const target = structuredClone(base);
  target.nodes = target.nodes.filter((node) => ![5, 6, 7, 8].some((n) => node.id === `gwt-0-${n}`));
  for (const n of [9, 10, 11, 12]) {
    const changed = target.nodes.find((node) => node.id === `gwt-0-${n}`);
    changed.description = `New changed body ${n}`;
    changed.when = [{ type: "command", name: `New action ${n}` }];
    changed.raw = `new slice YAML ${n}`;
    target.nodes.push({ ...structuredClone(changed), id: `added-gwt-${n}`, label: `Added hidden ${n}`, description: `Added body ${n}` });
  }
  target.nodes = target.nodes.filter((node) => node.storyName !== "Second" && node.id !== "story-1");
  target.slices = target.slices.filter((slice) => slice.path !== "slice-1.yaml");
  target.stories = target.stories.filter((story) => story.name !== "Second");
  target.nodes.find((node) => node.id === "event").fields = "new: string";
  target.edges[0].label = "new";
  target.nodes = target.nodes.filter((node) => node.id !== "removed-event");
  target.edges = target.edges.filter((edge) => edge.id !== "removed-edge");
  target.nodes.push({ id: "added-event", type: "event", label: "Added event", fields: "added: string" });
  target.edges.push({ id: "added-edge", source: "command-0", target: "added-event", kind: "command-event" });
  const { project, diff } = diffEventModelProjects(base, target);
  // Expectations come from the input definitions, independently of the merged output.
  const currentIds = [0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15].map((n) => `gwt-0-${n}`);
  const expectedIds = {
    added: [9, 10, 11, 12].map((n) => `added-gwt-${n}`),
    removed: [5, 6, 7, 8].map((n) => `gwt-0-${n}`),
    changed: [9, 10, 11, 12].map((n) => `gwt-0-${n}`)
  };
  expectedIds.all = [...currentIds, ...expectedIds.added, ...expectedIds.removed];
  const file = await savedHtml(project, diff);
  for (const mode of ["live", "saved"]) {
    const { page, requests = [] } = mode === "saved" ? await openSaved(file) : await open(16, () => project, diff);
    try {
      await keyboardPanelRoundTrip(page, page.locator('[data-id="gwt-0-0"]'), "Case 0-8", "Details 0-8", true);
      for (const filter of ["all", "added", "removed", "changed"]) {
        if (filter !== "all") await page.locator(".diff-counts").getByRole("button", { name: new RegExp(filter, "i") }).click();
        await page.waitForTimeout(100);
        const expected = project.nodes.filter((node) => node.type === "gwt" && node.sourcePath === "slice-0.yaml" && (filter === "all" || diff.nodeStatus[node.id] === filter));
        assert.deepEqual(expected.map((node) => node.id), expectedIds[filter]);
        const summary = page.locator(`.react-flow__node[data-id="${expected[0].id}"]`);
        const summaryText = await summary.textContent();
        assert.equal(await summary.locator(".gwt-more button").textContent(), `+${expected.length - 3} more`);
        assert.match(await summary.textContent(), new RegExp(`GWT · ${expected.length} cases`));
        for (const status of ["added", "removed", "changed"]) assert.match(await summary.textContent(), new RegExp(`${status}: ${expected.filter((node) => diff.nodeStatus[node.id] === status).length}`));
        assert.deepEqual(await summary.locator(".gwt-summary button").allTextContents(), expected.slice(0, 3).map((node) => `${node.label} · ${diff.nodeStatus[node.id]}`));
        const initial = await geometry(page);
        if (filter === "all") await summary.locator(".gwt-more button").click();
        else {
          await summary.locator(".gwt-summary button").first().click();
          await page.getByRole("button", { name: "All scenarios", exact: true }).click();
        }
        const list = page.getByRole("complementary", { name: "GWT scenarios" });
        assert.deepEqual(await list.locator(".gwt-all-list button").allTextContents(), expected.map((node) => `${node.label} · ${diff.nodeStatus[node.id]}`));
        for (const node of expected.filter((node) => diff.nodeStatus[node.id] !== "unchanged")) {
          await list.getByLabel("Filter by scenario name").fill(node.label);
          await list.getByRole("button", { name: `${node.label} · ${diff.nodeStatus[node.id]}`, exact: true }).focus();
          await page.keyboard.press("Enter");
          const detail = page.getByRole("complementary", { name: "Node details" });
          assert.match(await detail.textContent(), new RegExp(node.description));
          assert.ok((await detail.textContent()).includes(`em://event_model/${node.id}`));
          assert.ok((await detail.textContent()).includes(node.sourcePath));
          assert.deepEqual(await detail.locator(".gwt-step-title").allTextContents(), ["Given", "When", "Then"]);
          assert.ok((await detail.textContent()).includes(node.when[0].name));
          assert.equal(await summary.textContent(), summaryText);
          assert.deepEqual(await geometry(page), initial);
          if (diff.nodeStatus[node.id] === "changed") {
            await detail.getByRole("button", { name: "Old version", exact: true }).click();
            const oldNode = base.nodes.find((candidate) => candidate.id === node.id);
            assert.ok((await detail.textContent()).includes(oldNode.description));
            assert.ok((await detail.textContent()).includes(oldNode.when[0].name));
            assert.equal((await detail.textContent()).includes(node.when[0].name), false);
            await detail.locator("summary").filter({ hasText: "Copy for LLM" }).click();
            await detail.getByRole("button", { name: "YAML Source YAML for the whole slice", exact: true }).click();
            assert.equal(await page.evaluate(() => window.copiedText), diff.previousGwtNodes[node.id].raw);
            await detail.locator("summary").filter({ hasText: "Copy for LLM" }).click();
            await detail.getByRole("button", { name: "New version", exact: true }).click();
            assert.ok((await detail.textContent()).includes(node.description));
            assert.ok((await detail.textContent()).includes(node.when[0].name));
          }
          if (diff.nodeStatus[node.id] === "removed") assert.match(await detail.textContent(), /Old version/);
          await detail.getByRole("button", { name: "All scenarios", exact: true }).click();
          await list.getByRole("button", { name: "Clear filter" }).click();
        }
        assert.deepEqual(await geometry(page), initial);
        await list.getByRole("button", { name: "Close", exact: true }).click();
        if (filter !== "all") await page.getByRole("button", { name: "Show full graph" }).click();
      }
      await page.locator('[data-id="gwt-1-0"] .gwt-summary').waitFor();
      assert.match(await page.locator('[data-id="gwt-1-0"]').textContent(), /removed: 16/);
      await page.locator(".search-box input").fill("Case 1-15");
      await page.locator(".search-results button").click();
      const hiddenGwtDetail = page.getByRole("complementary", { name: "Node details" });
      assert.match(await hiddenGwtDetail.textContent(), /Details 1-15/);
      assert.match(await hiddenGwtDetail.textContent(), /em:\/\/event_model\/gwt-1-15/);
      assert.match(await hiddenGwtDetail.textContent(), /slice-1\.yaml/);
      await hiddenGwtDetail.locator("summary").filter({ hasText: "Copy for LLM" }).click();
      await hiddenGwtDetail.getByRole("button", { name: "Reference Stable em:// node handle", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copiedText), "em://event_model/gwt-1-15");
      await hiddenGwtDetail.getByRole("button", { name: "YAML Source YAML for the whole slice", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copiedText), base.nodes.find((node) => node.id === "gwt-1-15").raw);
      // The existing engine treats an edge label change as removal + addition.
      for (const status of ["added", "removed"]) await page.locator(`.react-flow__edge.edge-diff-${status}`).first().waitFor();
      for (const status of ["added", "removed"]) {
        await page.locator(`[data-id="${status}-event"]`).click();
        assert.match(await page.getByRole("complementary", { name: "Node details" }).textContent(), new RegExp(`${status}: string`));
      }
      await page.locator(".search-box input").fill("Event");
      await page.locator(".search-results").getByRole("button", { name: "Event event", exact: true }).click();
      assert.match(await page.getByRole("complementary", { name: "Node details" }).textContent(), /new: string/);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  }
});


test("diff duplicate names and removed ID collisions select the correct source in live and saved views", async () => {
  const { diffEventModelProjects } = await server.ssrLoadModule("../graph/src/index.ts");
  const base = model(6);
  const target = structuredClone(base);
  target.nodes.find((node) => node.id === "gwt-0-1").description = "Changed second duplicate";
  const replacement = target.nodes.find((node) => node.id === "gwt-0-5");
  replacement.label = "Replacement case";
  replacement.description = "Replacement body";
  const { project, diff } = diffEventModelProjects(base, target);
  const file = await savedHtml(project, diff);
  for (const mode of ["live", "saved"]) {
    const { page, requests = [] } = mode === "saved" ? await openSaved(file) : await open(6, () => project, diff);
    try {
      const initial = await geometry(page);
      await page.locator('[data-id="gwt-0-0"] .gwt-more button').click();
      const list = page.getByRole("complementary", { name: "GWT scenarios" });
      const detail = page.getByRole("complementary", { name: "Node details" });
      await list.getByRole("searchbox").fill("Duplicate");
      assert.deepEqual(await list.locator(".gwt-all-list button").allTextContents(), ["Duplicate · unchanged", "Duplicate · changed"]);
      for (const [label, id, body] of [
        ["Duplicate · unchanged", "gwt-0-0", "Details 0-0"],
        ["Duplicate · changed", "gwt-0-1", "Changed second duplicate"]
      ]) {
        await list.getByRole("button", { name: label, exact: true }).click();
        assert.ok((await detail.textContent()).includes(body));
        assert.ok((await detail.textContent()).includes(`em://event_model/${id}`));
        if (id === "gwt-0-1") {
          await detail.getByRole("button", { name: "Old version", exact: true }).click();
          assert.ok((await detail.textContent()).includes("Details 0-1"));
          assert.equal((await detail.textContent()).includes("Details 0-0"), false);
        }
        await detail.getByRole("button", { name: "All scenarios", exact: true }).click();
      }
      await list.getByRole("searchbox").fill("Case 0-5");
      await list.getByRole("button", { name: "Case 0-5 · removed", exact: true }).click();
      assert.ok((await detail.textContent()).includes("Details 0-5"));
      assert.ok((await detail.textContent()).includes("em://event_model/removed:gwt-0-5"));
      await detail.locator("summary").filter({ hasText: "Copy for LLM" }).click();
      await detail.getByRole("button", { name: "Reference Stable em:// node handle", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copiedText), "em://event_model/removed:gwt-0-5");
      await detail.getByRole("button", { name: "All scenarios", exact: true }).click();
      await list.getByRole("searchbox").fill("Replacement");
      await list.getByRole("button", { name: "Replacement case · added", exact: true }).click();
      assert.ok((await detail.textContent()).includes("Replacement body"));
      assert.ok((await detail.textContent()).includes("em://event_model/gwt-0-5"));
      assert.deepEqual(await geometry(page), initial);
      assert.deepEqual(requests, []);
    } finally { await page.close(); }
  }
});
