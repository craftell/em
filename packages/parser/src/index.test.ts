import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadEventModelProject } from "./index.js";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "./browser.js";

describe("loadEventModelProject", () => {
  it("loads the sample event model and builds a graph", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);

    expect(project.stories).toHaveLength(2);
    expect(project.slices).toHaveLength(6);
    expect(project.events).toHaveLength(7);
    expect(project.nodes.some((node) => node.id === "evt_customer_registered")).toBe(true);
    expect(project.edges.some((edge) => edge.kind === "command-event")).toBe(true);
    expect(project.edges.some((edge) => edge.kind === "event-query")).toBe(true);
  });

  it("loads the sample event model from uploaded file contents", () => {
    const root = new URL("../../..", import.meta.url).pathname;
    const relativePaths = [
      ".event-modeling/config.yaml",
      "event-model/events.yaml",
      "event-model/stories/customer-onboarding.yaml",
      "event-model/stories/subscription-checkout.yaml",
      ...fs
        .readdirSync(path.join(root, "event-model/features"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".slice.yaml"))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join(path.posix.sep))
    ];
    const files: InMemoryEventModelFile[] = relativePaths.map((filePath) => ({
      path: filePath,
      content: fs.readFileSync(path.join(root, filePath), "utf8")
    }));
    const project = loadEventModelProjectFromFiles(files);

    expect(project.stories).toHaveLength(2);
    expect(project.slices).toHaveLength(6);
    expect(project.nodes.some((node) => node.id === "evt_payment_collected")).toBe(true);
  });
});
