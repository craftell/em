import { describe, expect, it } from "vitest";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "@emviz/parser";
import { validateEventModelProject as validateCli } from "./index.js";
import { validateEventModelProject as validateBrowser } from "./browser.js";

const slicePath = "event-model/features/register.slice.yaml";
const registryPath = "metadata/people.yaml";

function validate(registry: string | undefined, screen = "  actors: []\n") {
  const files: InMemoryEventModelFile[] = [
    { path: ".event-modeling/config.yaml", content: "paths:\n  features_dir: event-model/features\n  actors_file: metadata/people.yaml\n" },
    { path: "event-model/events.yaml", content: "events: {}\n" },
    { path: slicePath, content: "slice: Register\nscreen:\n" + screen },
    ...(registry === undefined ? [] : [{ path: registryPath, content: registry }])
  ];
  const project = loadEventModelProjectFromFiles(files);
  return {
    project,
    reports: [
      validateCli(project, { sourcePaths: new Set(files.map((file) => file.path)), sidecar: undefined }),
      validateBrowser(project)
    ]
  };
}

describe("actor validation", () => {
  it.each([
    { label: "invalid ID", registry: 'actors:\n  " customer ": {}\n', message: /Actor IDs/ },
    { label: "invalid definition", registry: "actors:\n  customer: []\n", message: /must be a mapping/ },
    { label: "invalid name", registry: 'actors:\n  customer:\n    name: ""\n', message: /name must be/ },
    { label: "invalid color", registry: 'actors:\n  customer:\n    color: "#xyzxyz"\n', message: /color must be/ },
    { label: "invalid registry", registry: "actors: []\n", message: /actors mapping/ },
    { label: "duplicate YAML ID", registry: "actors:\n  customer: {}\n  customer: {}\n", message: /Invalid actor registry/ }
  ])("reports $label as an A1 error at the configured registry in CLI and browser", ({ registry, message }) => {
    const { reports } = validate(registry);
    expect(reports[0]).toEqual(reports[1]);
    for (const report of reports) {
      expect(report.errors).toBeGreaterThan(0);
      expect(report.findings).toContainEqual(expect.objectContaining({
        check: "A1",
        severity: "error",
        path: registryPath,
        message: expect.stringMatching(message)
      }));
    }
  });

  it.each([
    { label: "unknown ID", screen: "  actors: [missing]\n", message: /undefined actor "missing"/ },
    { label: "scalar reference", screen: "  actors: customer\n", message: /must be an array/ },
    { label: "nonstring reference", screen: "  actors: [7]\n", message: /nonempty strings/ },
    { label: "empty reference", screen: '  actors: [""]\n', message: /nonempty strings/ },
    { label: "padded reference", screen: '  actors: [" customer "]\n', message: /nonempty strings/ },
    { label: "duplicate reference", screen: "  actors: [customer, customer]\n", message: /more than once/ }
  ])("reports $label as an A1 error at the slice in CLI and browser", ({ screen, message }) => {
    const { reports } = validate("actors:\n  customer: {}\n", screen);
    expect(reports[0]).toEqual(reports[1]);
    for (const report of reports) {
      expect(report.errors).toBe(1);
      expect(report.findings).toContainEqual(expect.objectContaining({
        check: "A1",
        severity: "error",
        path: slicePath,
        message: expect.stringMatching(message)
      }));
    }
  });

  it("accepts legacy references without a registry but rejects them with a present empty registry", () => {
    const legacy = validate(undefined, "  actors: [customer]\n");
    const empty = validate("actors: {}\n", "  actors: [customer]\n");
    for (const report of legacy.reports) {
      expect(report.errors).toBe(0);
      expect(report.findings.filter((finding) => finding.check === "A1")).toEqual([]);
    }
    for (const report of empty.reports) {
      expect(report.errors).toBe(1);
      expect(report.findings).toContainEqual(expect.objectContaining({ check: "A1", path: slicePath }));
    }
  });

  it("accepts optional metadata and explicit valid names and colors", () => {
    const { reports } = validate('actors:\n  customer: {}\n  staff:\n    name: Staff member\n    color: "#abcdef"\n', "  actors: [customer, staff]\n");
    expect(reports[0]).toEqual(reports[1]);
    for (const report of reports) {
      expect(report.errors).toBe(0);
      expect(report.findings.filter((finding) => finding.check === "A1")).toEqual([]);
    }
  });

  it.each([undefined, "actors: {}\n"])("preserves L5 for system actors without adding user-actor diagnostics or metadata", (registry) => {
    const { project, reports } = validate(registry, "  type: system\n  actors: [scheduler]\n");
    expect(reports[0]).toEqual(reports[1]);
    for (const report of reports) {
      expect(report.errors).toBe(1);
      expect(report.findings).toContainEqual(expect.objectContaining({ check: "L5", severity: "error", path: slicePath }));
      expect(report.findings.filter((finding) => finding.check === "A1")).toEqual([]);
    }
    expect(project.actors).toEqual([]);
    expect(project.nodes.find((node) => node.type === "processor")).not.toHaveProperty("actorDefinitions");
  });
});
