import { describe, expect, it } from "vitest";
import { loadEventModelProjectFromFiles } from "@emviz/parser";
import { validateEventModelProject as validateNode } from "./index.js";
import { validateEventModelProject as validateBrowser } from "./browser.js";

describe("feature diagnostics", () => {
  it("surfaces invalid timeline references in both validators", () => {
    const project = loadEventModelProjectFromFiles([
      { path: "event-model/events.yaml", content: "events: {}" },
      { path: "event-model/features/account.feature.yaml", content: JSON.stringify({
        kind: "feature", id: "account", schema_version: 1, name: "Account",
        stories: [{ id: "a", name: "A", slices: [] }],
        timelines: [{ id: "main", name: "Main", steps: [{ id: "a", story: "a", after: ["missing"] }] }]
      }) }
    ]);
    const node = validateNode(project, { sourcePaths: new Set(), sidecar: undefined });
    const browser = validateBrowser(project);
    expect(node).toEqual(browser);
    expect(node.errors).toBeGreaterThan(0);
    expect(node.findings.some((finding) => finding.check === "F1" && finding.message.includes("unknown predecessor"))).toBe(true);
    expect(project.timelines).toEqual([]);
  });
});
