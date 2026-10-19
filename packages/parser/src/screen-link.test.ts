import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadEventModelProject, safeScreenUrl as nodeSafeUrl } from "./index.js";
import { loadEventModelProjectFromFiles, safeScreenUrl } from "./browser.js";

const slicePath = "event-model/features/example.slice.yaml";

function parseBoth(screen: Record<string, unknown>) {
  const files = [
    { path: ".event-modeling/config.yaml", content: "paths:\n  features_dir: event-model/features\n" },
    { path: "event-model/events.yaml", content: "events: {}\n" },
    { path: slicePath, content: YAML.stringify({ slice: "Example", screen }) }
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-link-"));
  try {
    for (const file of files) {
      const target = path.join(root, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    return [loadEventModelProjectFromFiles(files), loadEventModelProject(root)];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("screen links", () => {
  it.each([
    "https://www.figma.com/design/example/Design?node-id=1-2",
    "http://localhost:3000/checkout"
  ])("preserves links through both parsers and graph construction (%s)", (url) => {
    const [browser, disk] = parseBoth({ type: "user", name: "Checkout", url });
    for (const project of [browser, disk]) {
      expect(project.slices[0].screen.url).toBe(url);
      expect(project.nodes.find((node) => node.type === "screen")?.url).toBe(url);
      expect(project.modelIssues).toEqual([]);
    }
    expect(browser.slices).toEqual(disk.slices);
    expect(browser.nodes).toEqual(disk.nodes);
    expect(safeScreenUrl(url)).toBe(url);
    expect(nodeSafeUrl(url)).toBe(url);
  });

  it("leaves old screens without a link field", () => {
    for (const project of parseBoth({ name: "Checkout" })) {
      expect(project.slices[0].screen).not.toHaveProperty("url");
      expect(project.nodes.find((node) => node.type === "screen")).not.toHaveProperty("url");
      expect(project.modelIssues).toEqual([]);
    }
  });

  it.each([
    "", 42, false, null, [], {},
    "javascript:alert(1)", "data:text/html,hello", "file:///tmp/example",
    "/prototype", "//example.com", "https:example.com",
    "https:///example.com", "https://", "https://[invalid",
    "https://user:pass@example.com", "https://@example.com",
    " https://example.com", "https://example.com/a b",
    "https://exa\tmple.com", "https://example.com/a\n",
    "https://example.com/\u0000", "https://example.com/\u007f",
    "https://example.com\\prototype"
  ].map((value) => [value]))("rejects unsafe or malformed links in both parsers (%j)", (value) => {
    for (const project of parseBoth({ url: value })) {
      expect(project.modelIssues).toEqual([
        expect.objectContaining({ check: "L10", path: slicePath, message: expect.stringContaining("screen.url") })
      ]);
      expect(project.slices[0].screen).not.toHaveProperty("url");
      expect(project.nodes.find((node) => node.type === "screen")).not.toHaveProperty("url");
    }
    expect(safeScreenUrl(value)).toBeUndefined();
    expect(nodeSafeUrl(value)).toBeUndefined();
  });

  it.each(["https://example.com", null])("reports links on system screens (%j)", (url) => {
    for (const project of parseBoth({ type: "system", url })) {
      expect(project.modelIssues).toEqual([
        expect.objectContaining({ check: "L10", message: expect.stringContaining("only supported on user screens") })
      ]);
      expect(project.nodes.find((node) => node.type === "processor")).not.toHaveProperty("url");
    }
  });
});
