import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { createServer, preview } from "vite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEventModelProjectFromFiles } from "@emviz/parser/browser";

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
  await page.route("**/api/session?**", (route) => route.fulfill({ status: 404, body: "" }));
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

test("real YAML keeps same-named nodes and their connections separate in live and exported views", async () => {
  const names = Array.from({ length: 12 }, (_, index) => `Slice${index}`);
  const paths = names.map((name) => `event-model/features/${name}.slice.yaml`);
  const project = loadEventModelProjectFromFiles([
    { path: "event-model/events.yaml", content: `events:\n${names.map((name) => `  ${name}Saved: {}`).join("\n")}` },
    { path: "event-model/stories/main.yaml", content: `name: Main\nslices:\n${paths.map((path) => `  - ${path}`).join("\n")}` },
    ...names.map((name, index) => ({ path: paths[index], content: `slice: Same title
screen:
  name: ${name} screen
  reads: [Status]
  executes: [Save]
commands:
  - name: Save
    produces: [${name}Saved, ${name}Saved]
queries:
  - name: Status
    from_events: [${name}Saved, ${name}Saved]
gwt:
  - name: Same scenario
    given: [{type: event, name: ${name}Saved}]
    when: [{type: command, name: Save}]
    then: [{type: event, name: ${name}Saved}]
  - name: Same scenario
    given: []
    when: []
    then: []
` }))
  ]);
  const live = await open(0, () => project);
  const saved = await openSaved(await savedHtml(project));
  try {
    for (const page of [live.page, saved.page]) {
      const panel = page.getByRole("complementary", { name: "Node details" });
      for (const name of ["Slice1", "Slice11"]) {
        const command = project.nodes.find((node) => node.type === "command" && node.sourcePath === `event-model/features/${name}.slice.yaml`);
        await page.locator(`[data-id="${command.id}"]`).click({ force: true });
        assert.deepEqual(await panel.locator(".connection-button").allTextContents(), [`${name} screen`, `${name}Saved`]);
        await panel.getByRole("button", { name: `${name}Saved`, exact: true }).click();
        assert.deepEqual(await panel.locator(".connection-button").allTextContents(), ["Save", "Status"]);
        await panel.getByRole("button", { name: "Status", exact: true }).click();
        assert.deepEqual(await panel.locator(".connection-button").allTextContents(), [`${name}Saved`, `${name} screen`]);
        assert.ok((await panel.textContent()).includes(`event-model/features/${name}.slice.yaml`));
        await panel.locator("summary").filter({ hasText: "Copy for LLM" }).click();
        await panel.locator(".copy-action").filter({ hasText: "Reference plus incoming" }).click();
        const context = await page.evaluate(() => window.copiedText);
        assert.ok(context.includes(`Incoming:\n- ${name}Saved -> Status\n\nOutgoing:\n- Status -> ${name} screen`));
        const scenario = project.nodes.find((node) => node.type === "gwt" && node.sourcePath === `event-model/features/${name}.slice.yaml`);
        await page.locator(`[data-id="${scenario.id}"] .gwt-summary button`).first().click({ force: true });
        assert.equal(await panel.locator(".connection-button").count(), 0);
      }
      const ids = await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
      assert.equal(new Set(ids).size, ids.length);
    }
    assert.deepEqual(live.errors, []);
    assert.deepEqual(saved.requests, []);
  } finally { await live.page.close(); await saved.page.close(); }
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
    await result.scrollIntoViewIfNeeded();
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
      if (endpoint === "/api/session") return route.fulfill({ status: 404, body: "" });
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
  assert.equal(diff.edgeStatus.edge, "changed");
  assert.equal(diff.previousEdges.edge.label, "old");
  assert.deepEqual(project.edges.filter((edge) => edge.source === "command-0" && edge.target === "event").map((edge) => [edge.id, edge.label]), [["edge", "new"]]);
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
      await page.locator('.react-flow__edge[data-id="edge"].edge-diff-changed').waitFor();
      assert.equal(await page.locator('.react-flow__edge[data-id="edge"].edge-diff-added, .react-flow__edge[data-id="edge"].edge-diff-removed').count(), 0);
      for (const status of ["added", "removed"]) await page.locator(`.react-flow__edge[data-id="${status}-edge"].edge-diff-${status}`).waitFor();
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

async function openFeedbackSession(project, diff) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const requests = [];
  const snapshot = {
    sessionId: "browser-feedback-session",
    token: "browser-test-only-token",
    revision: "revision-1",
    project,
    currentNodeIds: Object.fromEntries(project.nodes.map((node) => [node.id, node.id])),
    validation: { findings: [], errors: 0, warnings: 0 },
    diff,
    feedback: { status: "idle", history: [], agent: { connected: true } },
    baseline: { kind: "startup", label: "Startup snapshot" },
    stale: false
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.copiedText = value; } } });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: snapshot });
    requests.push({ path, method: route.request().method() });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(url);
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(600);
  let revision = 1;
  const refresh = async (nextProject = snapshot.project) => {
    snapshot.project = nextProject;
    snapshot.currentNodeIds = Object.fromEntries(nextProject.nodes.map((node) => [node.id, node.id]));
    snapshot.revision = "revision-" + ++revision;
    const response = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/session" || !response.ok()) return false;
      return (await response.json()).revision === snapshot.revision;
    });
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await response;
  };
  return { page, errors, requests, snapshot, refresh };
}

test("unsent feedback survives target rename and deletion without transferring to another node or session", async () => {
  for (const change of ["rename", "delete"]) {
    const initial = model(4);
    const { page, errors, requests, snapshot, refresh } = await openFeedbackSession(initial);
    try {
      await page.locator('[data-id="command-0"]').click();
      await page.getByRole("tab", { name: "Agent", exact: true }).click();
      await page.getByLabel("Feedback message", { exact: true }).fill("Keep this draft about Command 0.");
      const next = structuredClone(initial);
      if (change === "rename") next.nodes.find((node) => node.id === "command-0").label = "Renamed command";
      else next.nodes = next.nodes.filter((node) => node.id !== "command-0");
      await refresh(next);
      await page.waitForFunction(() => !document.querySelector(".feedback-composer"));
      const toggle = page.locator("summary").filter({ hasText: "Unsent feedback drafts" });
      await toggle.click();
      const recovery = page.getByRole("list", { name: "Unsent feedback drafts" });
      const original = recovery.getByRole("listitem").filter({ hasText: "Keep this draft about Command 0." });
      assert.equal(await original.locator("strong").textContent(), "Command 0");
      assert.match(await original.textContent(), /original node is no longer available/);
      await original.getByRole("button", { name: "Copy draft", exact: true }).click();
      assert.equal(await page.evaluate(() => window.copiedText), "Keep this draft about Command 0.");
      await toggle.click();
      await page.locator('[data-id="command-1"]').click({ force: true });
      assert.equal(await page.getByLabel("Feedback message", { exact: true }).inputValue(), "");
      await page.getByLabel("Feedback message", { exact: true }).fill("Separate draft for Command 1.");
      await page.keyboard.press("Escape");
      await page.locator('[data-id="command-1"]').click({ force: true });
      assert.equal(await page.getByLabel("Feedback message", { exact: true }).inputValue(), "Separate draft for Command 1.");
      snapshot.sessionId = "restarted-feedback-session";
      await refresh();
      await page.waitForFunction(() => !document.querySelector(".feedback-composer"));
      await page.locator('[data-id="command-1"]').click({ force: true });
      assert.equal(await page.getByLabel("Feedback message", { exact: true }).inputValue(), "");
      await toggle.click();
      assert.match(await recovery.textContent(), /previous session/);
      assert.ok((await recovery.textContent()).includes("Keep this draft about Command 0."));
      assert.ok((await recovery.textContent()).includes("Separate draft for Command 1."));
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("GWT Old version disables queueing while preserving the current-node draft", async () => {
  const { diffEventModelProjects } = await server.ssrLoadModule("../graph/src/index.ts");
  const base = model(4);
  const target = structuredClone(base);
  target.nodes.find((node) => node.id === "gwt-0-2").description = "Updated scenario";
  const { project, diff } = diffEventModelProjects(base, target);
  const { page, errors, requests } = await openFeedbackSession(project, diff);
  const tab = (name) => page.getByRole("tab", { name, exact: true }).click();
  try {
    await tab("Agent");
    await page.getByRole("button", { name: "Session diff", exact: true }).click();
    await page.locator('[data-id="gwt-0-0"] .gwt-summary button').filter({ hasText: "Scenario 3" }).click();
    const panel = page.getByRole("complementary", { name: "Node details" });
    const message = page.getByLabel("Feedback message", { exact: true });
    const queue = page.getByRole("button", { name: "Add to Queue", exact: true });
    await message.fill("Review the current scenario.");
    assert.equal(await queue.isEnabled(), true);
    await tab("Details");
    await panel.getByRole("button", { name: "Old version", exact: true }).click();
    await tab("Agent");
    assert.equal(await queue.isDisabled(), true);
    assert.equal(await message.inputValue(), "Review the current scenario.");
    assert.match(await page.getByRole("complementary", { name: "Agent", exact: true }).textContent(), /Switch to New version/);
    await tab("Details");
    await panel.getByRole("button", { name: "New version", exact: true }).click();
    await tab("Agent");
    assert.equal(await queue.isEnabled(), true);
    assert.equal(await message.inputValue(), "Review the current scenario.");
    await tab("Details");
    await panel.getByRole("button", { name: "All scenarios", exact: true }).click();
    await page.getByRole("complementary", { name: "GWT scenarios" }).getByRole("button", { name: "Scenario 3 · changed", exact: true }).click();
    await tab("Agent");
    assert.equal(await message.inputValue(), "Review the current scenario.");
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Agent queue preserves targets, edits, drafts, and unsent items across selection and reload", async () => {
  const { page, errors, requests, snapshot, refresh } = await openFeedbackSession(model(4));
  const agentTab = () => page.getByRole("tab", { name: "Agent", exact: true }).click();
  const queue = page.getByRole("region", { name: "Feedback Queue", exact: true });
  const selectCommand = async (name) => {
    await page.getByLabel("Search event model", { exact: true }).fill(name);
    await page.locator(".search-results").getByRole("button", { name: name + " command", exact: true }).click();
    await agentTab();
    assert.equal(await page.getByRole("form", { name: "Node feedback" }).getByRole("heading").textContent(), "Feedback for " + name);
  };
  try {
    assert.equal(await page.getByRole("tab", { name: "Details", exact: true }).getAttribute("aria-selected"), "true");
    await page.locator('[data-id="command-0"]').click();
    assert.equal(await page.getByRole("form", { name: "Node feedback" }).count(), 0);
    await agentTab();
    await page.getByLabel("Feedback message", { exact: true }).fill("First node feedback.");
    await page.getByRole("button", { name: "Add to Queue", exact: true }).click();
    await selectCommand("Command 1");
    await page.getByLabel("Feedback message", { exact: true }).fill("Second node feedback.");
    await page.getByRole("button", { name: "Add to Queue", exact: true }).click();
    assert.equal(await queue.getByRole("listitem").count(), 2);
    assert.deepEqual(requests, [], "Queue must not send any command");
    await queue.getByRole("button", { name: "Edit queued feedback for Command 0", exact: true }).click();
    await queue.getByRole("textbox", { name: "Edit queued feedback for Command 0", exact: true }).fill("Edited first node feedback.");
    await queue.getByRole("button", { name: "Save", exact: true }).click();
    await queue.getByRole("button", { name: "Remove queued feedback for Command 1", exact: true }).click();
    assert.equal(await queue.getByRole("listitem").count(), 1);
    assert.match(await queue.textContent(), /Command 0/);
    assert.match(await queue.textContent(), /Edited first node feedback/);
    await page.getByLabel("Feedback message", { exact: true }).fill("Unqueued second-node draft.");
    await page.reload();
    await page.locator(".react-flow__node").first().waitFor();
    await agentTab();
    assert.equal(await queue.getByRole("listitem").count(), 1);
    assert.match(await queue.textContent(), /Edited first node feedback/);
    await selectCommand("Command 1");
    assert.equal(await page.getByLabel("Feedback message", { exact: true }).inputValue(), "Unqueued second-node draft.");
    snapshot.feedback.status = "stopped";
    await refresh();
    assert.equal(await page.getByRole("button", { name: "Send to Agent", exact: true }).isDisabled(), true);
    assert.equal(await queue.getByRole("listitem").count(), 1);
    assert.deepEqual(requests, [], "Reload and Stop must not dispatch unsent feedback");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("Agent retries an uncertain batch with identical IDs and contents after reload", async () => {
  const { page, errors } = await openFeedbackSession(model(4));
  const batches = [];
  const queue = page.getByRole("region", { name: "Feedback Queue", exact: true });
  try {
    await page.route("**/api/feedback/batch", async (route) => {
      const body = route.request().postDataJSON();
      batches.push(body);
      if (batches.length === 1) return route.fulfill({ status: 503, json: { error: "Temporary batch failure." } });
      return route.fulfill({ json: { id: "confirmed-browser-batch", ...body } });
    });
    await page.getByLabel("Search event model", { exact: true }).fill("Command 0");
    await page.locator(".search-results").getByRole("button", { name: "Command 0 command", exact: true }).click();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByLabel("Feedback message", { exact: true }).fill("Keep the original target and message.");
    await page.getByRole("button", { name: "Add to Queue", exact: true }).click();
    await page.getByRole("button", { name: "Send to Agent", exact: true }).click();
    await page.getByRole("button", { name: "Retry same batch", exact: true }).waitFor();
    assert.equal(await queue.getByRole("button", { name: "Edit queued feedback for Command 0", exact: true }).isDisabled(), true);
    assert.equal(await queue.getByRole("button", { name: "Remove queued feedback for Command 0", exact: true }).isDisabled(), true);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].items[0].nodeId, "command-0");
    assert.equal(batches[0].items[0].message, "Keep the original target and message.");
    await page.reload();
    await page.locator(".react-flow__node").first().waitFor();
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    assert.equal(await queue.getByRole("listitem").count(), 1);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    assert.equal(batches.length, 1, "reload and refresh must not retry automatically");
    await page.getByRole("button", { name: "Retry same batch", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".feedback-queue li").length === 0);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1], batches[0], "retry must preserve the batch ID, item IDs, targets, revisions, and messages");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

function actorModel() {
  const project = model(4);
  project.root = "actor-model";
  project.actors = [
    { id: "customer", name: "Customer", color: "#2563eb" },
    { id: "auditor", name: "Auditor", color: "#7c3aed" },
    { id: "admin", name: "Admin", color: "#b45309" }
  ];
  for (const [index, ids] of [[0, ["customer", "auditor"]], [1, ["admin"]]]) {
    project.nodes.push({
      id: "screen-" + index, type: "screen", label: "Screen " + index,
      sourcePath: "slice-" + index + ".yaml", storyName: project.stories[index].name,
      actors: ids, actorDefinitions: project.actors.filter((actor) => ids.includes(actor.id))
    });
  }
  for (const id of ["system", "system-next", "unassigned"]) {
    const path = id + ".yaml";
    project.slices.push({
      title: id, path, storyName: "First",
      screen: { type: id === "unassigned" ? "user" : "system", actors: [], reads: [], executes: [] },
      commands: [], queries: [], gwt: [], raw: ""
    });
    project.stories[0].slices.push(path);
    const shared = { sourcePath: path, sliceTitle: id, storyName: "First" };
    project.nodes.push(
      { ...shared, id, type: "slice", label: id },
      { ...shared, id: id + "-screen", type: id === "unassigned" ? "screen" : "processor", label: id, actors: id === "unassigned" ? [] : ["customer"], actorDefinitions: project.actors.slice(0, 1) },
      { ...shared, id: id + "-query", type: "query", label: "Read " + id },
      { ...shared, id: id + "-command", type: "command", label: "Run " + id },
      { ...shared, id: id + "-gwt", type: "gwt", label: "Check " + id }
    );
  }
  project.nodes.push(...["actor-started", "actor-processed", "actor-finished"].map((id) => ({ id, type: "event", label: id })));
  project.edges.push(
    { id: "actor-start", kind: "command-event", source: "command-0", target: "actor-started" },
    { id: "actor-read", kind: "event-query", source: "actor-started", target: "system-query" },
    { id: "actor-process", kind: "command-event", source: "system-command", target: "actor-processed" },
    { id: "actor-next-read", kind: "event-query", source: "actor-processed", target: "system-next-query" },
    { id: "actor-finish", kind: "command-event", source: "system-next-command", target: "actor-finished" }
  );
  return project;
}

test("actor chips and OR filters retain one neighboring system flow in live and saved views", async () => {
  const project = actorModel();
  const live = await open(4, () => project);
  const saved = await openSaved(await savedHtml(project));
  try {
    for (const page of [live.page, saved.page]) {
      const screen = page.locator('[data-id="screen-0"]');
      assert.deepEqual(await screen.locator(".actor-name").allTextContents(), ["Customer", "Auditor"]);
      assert.equal(await screen.locator('[data-actor-id="customer"]').evaluate((element) => getComputedStyle(element).borderColor), "rgb(37, 99, 235)");
      assert.equal(await screen.locator(".em-node-screen").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(248, 250, 252)");
      const processor = page.locator('[data-id="system-screen"]');
      assert.equal(await processor.locator(".actor-chip").count(), 0);
      assert.equal(await processor.locator(".em-node-processor").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(31, 41, 55)");
      const initial = new Map((await geometry(page)).nodes.map(([id, transform]) => [id, transform]));
      const filter = page.locator(".actor-filter");
      await filter.locator("summary").click();
      await filter.getByRole("checkbox", { name: "Customer (customer)", exact: true }).check();
      await page.locator('[data-id="screen-1"]').waitFor({ state: "detached" });
      for (const id of ["screen-0", "command-0", "gwt-0-0", "system-screen", "system-query", "system-command", "system-gwt", "actor-started", "actor-processed"]) {
        assert.equal(await page.locator('[data-id="' + id + '"]').count(), 1, id + " remains visible");
      }
      for (const id of ["system-next-screen", "system-next-command", "actor-finished", "unassigned-screen"]) {
        assert.equal(await page.locator('[data-id="' + id + '"]').count(), 0, id + " stays outside bounded context");
      }
      assert.equal(await page.locator('[data-id="system"] .actor-related-badge').textContent(), "Related");
      assert.equal(await processor.locator(".actor-chip").count(), 0);
      assert.equal(await page.locator('[data-id="system-command"]').evaluate((element) => element.style.opacity), "0.72");
      for (const [id, transform] of (await geometry(page)).nodes) assert.equal(transform, initial.get(id), id + " keeps its position");
      const visibleIds = new Set(await page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.dataset.id)));
      const edgeIds = await page.locator(".react-flow__edge").evaluateAll((edges) => edges.map((edge) => edge.dataset.id));
      for (const edge of project.edges.filter((edge) => edgeIds.includes(edge.id))) {
        assert.ok(visibleIds.has(edge.source) && visibleIds.has(edge.target), edge.id + " has two visible endpoints");
      }
      await filter.getByRole("checkbox", { name: "Admin (admin)", exact: true }).check();
      await page.locator('[data-id="screen-1"]').waitFor();
      assert.equal(await page.locator('[data-id="screen-0"]').count(), 1);
      await filter.getByRole("button", { name: "Clear actors", exact: true }).click();
      await page.locator('[data-id="system-next-screen"]').waitFor();
      assert.equal(await filter.locator("summary").textContent(), "Actors · All");
      await filter.getByRole("checkbox", { name: "Unassigned screens", exact: true }).check();
      await page.locator('[data-id="screen-0"]').waitFor({ state: "detached" });
      assert.equal(await page.locator('[data-id="unassigned-screen"]').count(), 1);
      assert.equal(await page.locator('[data-id="system-screen"]').count(), 0);
      await filter.getByRole("button", { name: "Clear actors", exact: true }).click();
      await filter.locator("summary").focus();
      await page.keyboard.press("Escape");
      assert.equal(await filter.evaluate((element) => element.open), false);
    }
    assert.deepEqual(live.errors, []);
    assert.deepEqual(saved.requests, []);
  } finally { await live.page.close(); await saved.page.close(); }
});

test("actor selections survive refresh, prune vanished actors and reset for a new project root", async () => {
  const { page, errors, refresh } = await openFeedbackSession(actorModel());
  try {
    const filter = page.locator(".actor-filter");
    await filter.locator("summary").click();
    await filter.getByRole("checkbox", { name: "Customer (customer)", exact: true }).check();
    await filter.getByRole("checkbox", { name: "Admin (admin)", exact: true }).check();
    await refresh(actorModel());
    assert.equal(await filter.getByRole("checkbox", { name: "Customer (customer)", exact: true }).isChecked(), true);
    const next = actorModel();
    next.actors = next.actors.filter((actor) => actor.id !== "customer");
    for (const node of next.nodes) {
      node.actors = node.actors?.filter((id) => id !== "customer");
      node.actorDefinitions = node.actorDefinitions?.filter((actor) => actor.id !== "customer");
    }
    await refresh(next);
    await filter.getByRole("checkbox", { name: "Customer (customer)", exact: true }).waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector(".actor-filter summary").textContent === "Actors · 1");
    assert.equal(await filter.getByRole("checkbox", { name: "Admin (admin)", exact: true }).isChecked(), true);
    assert.equal(await page.locator('[data-id="screen-0"]').count(), 0);
    await refresh({ ...actorModel(), root: "another-project" });
    await page.waitForFunction(() => document.querySelector(".actor-filter summary").textContent === "Actors · All");
    await page.locator('[data-id="screen-0"]').waitFor();
    assert.equal(await filter.getByRole("checkbox", { name: "Admin (admin)", exact: true }).isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("diff actor filtering preserves former membership and frozen Old version chips", async () => {
  const { diffEventModelProjects } = await server.ssrLoadModule("../graph/src/index.ts");
  const base = actorModel();
  const target = structuredClone(base);
  target.actors = target.actors.filter((actor) => actor.id !== "customer");
  const screen = target.nodes.find((node) => node.id === "screen-0");
  screen.actors = ["admin"];
  screen.actorDefinitions = [target.actors.find((actor) => actor.id === "admin")];
  const { project, diff } = diffEventModelProjects(base, target);
  const { page, errors } = await open(4, () => project, diff);
  try {
    const filter = page.locator(".actor-filter");
    await filter.locator("summary").click();
    await filter.getByRole("checkbox", { name: "Customer (customer)", exact: true }).check();
    await page.locator('[data-id="screen-1"]').waitFor({ state: "detached" });
    const displayed = page.locator('[data-id="screen-0"]');
    assert.deepEqual(await displayed.locator(".actor-name").allTextContents(), ["Admin"]);
    // The diff summary can cover the canvas node. Select it through the visible search control.
    await page.getByLabel("Search event model", { exact: true }).fill("Screen 0");
    await page.locator(".search-results").getByRole("button", { name: "Screen 0 screen", exact: true }).click();
    const details = page.getByRole("complementary", { name: "Node details" });
    await details.getByRole("button", { name: "Old version", exact: true }).click();
    assert.deepEqual(await details.locator(".actor-name").allTextContents(), ["Customer", "Auditor"]);
    assert.equal(await details.locator('[data-actor-id="customer"]').evaluate((element) => getComputedStyle(element).borderColor), "rgb(37, 99, 235)");
    await details.getByRole("button", { name: "New version", exact: true }).click();
    assert.deepEqual(await details.locator(".actor-name").allTextContents(), ["Admin"]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
