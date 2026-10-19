import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

let server;
let browser;
let address;
const evidence = process.env.EMVIZ_EVIDENCE_DIR ? resolve(process.env.EMVIZ_EVIDENCE_DIR, "screen-links") : undefined;
before(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  address = "http://127.0.0.1:" + server.httpServer.address().port;
  browser = await chromium.launch({ headless: process.env.EMVIZ_HEADED !== "1" });
  if (evidence) await mkdir(evidence, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

const reference = "https://www.figma.com/design/example/screen";

function model(media = { url: reference }) {
  const sourcePath = "event-model/features/register.slice.yaml";
  return {
    root: "/media-fixture", config: { paths: {} }, events: [],
    stories: [{ name: "Account", path: "stories/account.yaml", description: "", slices: [sourcePath] }],
    slices: [{ title: "Register", path: sourcePath, storyName: "Account" }],
    nodes: [
      { id: "story", type: "story", label: "Account", sourcePath: "stories/account.yaml" },
      { id: "slice", type: "slice", label: "Register", sourcePath, storyName: "Account" },
      { id: "screen", type: "screen", screenType: "user", label: "Registration", sourcePath, storyName: "Account", sliceTitle: "Register", ...media }
    ], edges: []
  };
}

async function open(name, { media, diff } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...(evidence ? { recordVideo: { dir: join(evidence, name + "-video") } } : {})
  });
  await context.addInitScript((payload) => { window.__EMVIZ_EXPORT__ = payload; }, {
    project: model(media), report: { findings: [], errors: 0, warnings: 0 }, diff, exportedAt: new Date().toISOString()
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(address);
  await page.locator('.react-flow__node[data-id="screen"]').waitFor();
  await page.waitForTimeout(500);
  return { page, close: async () => {
    try {
      if (evidence) {
        await page.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
        await writeFile(join(evidence, name + ".aria.txt"), await page.locator("body").ariaSnapshot());
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  } };
}

function screen(page) { return page.locator('.react-flow__node[data-id="screen"]'); }
async function transform(page) { return page.locator(".react-flow__viewport").evaluate((element) => element.style.transform); }

test("reference opens separately with safe rel and does not select or move the diagram", async () => {
  const fixture = await open("reference");
  const { page } = fixture;
  try {
    const link = screen(page).getByRole("link");
    assert.equal(await link.getAttribute("href"), reference);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
    const before = await transform(page);
    await page.context().route("https://www.figma.com/**", (route) => route.fulfill({ body: "Reference" }));
    const popupPromise = page.waitForEvent("popup");
    await link.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), reference);
    assert.equal(await transform(page), before);
    assert.equal(await page.locator("#inspector-details h2").textContent(), "Selection");
    await popup.close();
  } finally { await fixture.close(); }
});


test("untrusted standalone payload cannot render unsafe links", async () => {
  const fixture = await open("unsafe", { media: { url: "javascript:alert(1)" } });
  try { assert.equal(await screen(fixture.page).getByRole("link").count(), 0); }
  finally { await fixture.close(); }
});

test("keyboard activation opens a reference without selecting or moving the diagram", async () => {
  const fixture = await open("keyboard");
  const { page } = fixture;
  try {
    const link = screen(page).getByRole("link");
    await link.focus();
    const before = await transform(page);
    await page.context().route("https://www.figma.com/**", (route) => route.fulfill({ body: "Reference" }));
    const popupPromise = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), reference);
    assert.equal(await transform(page), before);
    assert.equal(await page.locator("#inspector-details h2").textContent(), "Selection");
    await popup.close();
  } finally { await fixture.close(); }
});

test("old version keeps its own link instead of linking to new version", async () => {
  const oldReference = "https://www.figma.com/design/example/old";
  const diff = {
    base: { label: "base" }, target: { label: "target" },
    previousNodes: { screen: { ...model().nodes[2], url: oldReference } },
    nodeStatus: { story: "unchanged", slice: "unchanged", screen: "changed" }, edgeStatus: {},
    summary: { nodes: { added: 0, removed: 0, changed: 1, unchanged: 2 }, edges: { added: 0, removed: 0, changed: 0, unchanged: 0 } }
  };
  const fixture = await open("old-version", { diff });
  try {
    const linkBox = await screen(fixture.page).getByRole("link").boundingBox();
    const badgeBox = await screen(fixture.page).locator(".diff-badge").boundingBox();
    assert.ok(linkBox && badgeBox);
    assert.ok(badgeBox.y + badgeBox.height <= linkBox.y, "diff badge must not overlap the link target");
    await screen(fixture.page).locator(".node-label").click();
    await fixture.page.getByRole("button", { name: "Old version", exact: true }).click();
    assert.equal(await fixture.page.locator("#inspector-details").getByRole("link", { name: /Open reference/ }).getAttribute("href"), oldReference);
  } finally { await fixture.close(); }
});
