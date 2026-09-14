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
  url = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

function model(count = 100) {
  const stories = ["First", "Second"].map((name, index) => ({ name, description: "", path: `${name}.yaml`, slices: [`slice-${index}.yaml`] }));
  const slices = stories.map((story, index) => ({ title: "Same slice title", path: story.slices[0], storyName: story.name }));
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

async function open(count = 100, transform = (project) => project) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.copiedText = value; } } });
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/*", (route) => route.fulfill({ json: route.request().url().endsWith("/model") ? transform(model(count)) : { findings: [], errors: 0, warnings: 0 } }));
  // Prevent treating the validation payload as a diff.
  await page.route("**/api/diff", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto(url);
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(600); // Allow initial fit-to-view animation to settle.
  return { page, errors };
}

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
