import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEventModelProject } from "./index.js";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "./browser.js";

const roots: string[] = [];
const slicePath = "event-model/features/register.slice.yaml";
const registryPath = "event-model/actors.yaml";

function files(options: { registry?: string; actorsFile?: string; screen?: string; config?: string } = {}): InMemoryEventModelFile[] {
  return [
    { path: ".event-modeling/config.yaml", content: options.config ?? "paths:\n  features_dir: event-model/features\n" },
    { path: "event-model/events.yaml", content: "events: {}\n" },
    { path: slicePath, content: "slice: Register\nscreen:\n" + (options.screen ?? "  actors: [customer]\n") },
    ...(options.registry === undefined ? [] : [{ path: options.actorsFile ?? registryPath, content: options.registry }])
  ];
}

function loadBoth(input: InMemoryEventModelFile[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-actors-parser-"));
  roots.push(root);
  for (const file of input) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  return [loadEventModelProject(root), loadEventModelProjectFromFiles(input, { root })];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("actor registry parsing", () => {
  it("loads the same explicit definitions and user-screen metadata from disk and browser files", () => {
    const projects = loadBoth(files({
      registry: 'actors:\n  customer:\n    name: "  Customer  "\n    color: "#12abef"\n  staff: {}\n',
      screen: "  type: user\n  actors: [customer, staff]\n"
    }));

    expect(projects[0]).toEqual(projects[1]);
    for (const project of projects) {
      expect(project.config.paths.actorsFile).toBe(registryPath);
      expect(project.actors).toEqual([
        { id: "customer", name: "Customer", color: "#12ABEF" },
        { id: "staff", name: "staff", color: expect.stringMatching(/^#[0-9A-F]{6}$/) }
      ]);
      expect(project.actorIssues).toEqual([]);
      expect(project.nodes.find((node) => node.type === "screen")).toMatchObject({
        actors: ["customer", "staff"],
        actorDefinitions: project.actors
      });
    }
  });

  it.each(["metadata/people.yaml", "./metadata/people.yaml"])("honors paths.actors_file %s on both loading surfaces", (actorsFile) => {
    const projects = loadBoth(files({
      config: "paths:\n  features_dir: event-model/features\n  actors_file: " + actorsFile + "\n",
      actorsFile: "metadata/people.yaml",
      registry: 'actors:\n  customer:\n    name: Account holder\n    color: "#123456"\n'
    }));
    for (const project of projects) {
      expect(project.actors).toEqual([{ id: "customer", name: "Account holder", color: "#123456" }]);
      expect(project.actorIssues).toEqual([]);
    }
  });

  it("defaults the registry path from event_model_dir", () => {
    const projects = loadBoth([
      { path: ".event-modeling/config.yaml", content: "paths:\n  event_model_dir: models\n  features_dir: models/features\n" },
      { path: "models/events.yaml", content: "events: {}\n" },
      { path: "models/actors.yaml", content: 'actors:\n  customer:\n    color: "#654321"\n' },
      { path: "models/features/register.slice.yaml", content: "slice: Register\nscreen:\n  actors: [customer]\n" }
    ]);
    for (const project of projects) {
      expect(project.config.paths.actorsFile).toBe("models/actors.yaml");
      expect(project.actors).toEqual([{ id: "customer", name: "customer", color: "#654321" }]);
    }
  });

  it("infers legacy actors only when the optional registry is absent", () => {
    for (const project of loadBoth(files())) {
      expect(project.actors).toEqual([{ id: "customer", name: "customer", color: expect.stringMatching(/^#[0-9A-F]{6}$/) }]);
      expect(project.actorIssues).toEqual([]);
    }
    for (const project of loadBoth(files({ registry: "actors: {}\n" }))) {
      expect(project.actorIssues).toContainEqual({
        message: expect.stringContaining('undefined actor "customer"'),
        path: slicePath
      });
    }
  });

  it("keeps fallback colors stable across registry, file, and reference ordering", () => {
    const firstFiles = files({
      registry: "actors:\n  customer: {}\n  staff: {}\n",
      screen: "  actors: [customer, staff]\n"
    });
    const reorderedFiles = files({
      registry: "actors:\n  unused: {}\n  staff: {}\n  customer: {}\n",
      screen: "  actors: [staff, customer]\n"
    }).reverse();
    const legacyFiles = files({ screen: "  actors: [staff, customer]\n" });
    const projects = [...loadBoth(firstFiles), ...loadBoth(reorderedFiles), ...loadBoth(legacyFiles)];
    for (const id of ["customer", "staff"]) {
      const colors = projects.map((project) => project.actors!.find((actor) => actor.id === id)!.color);
      expect(colors[0]).toMatch(/^#[0-9A-F]{6}$/);
      expect(new Set(colors).size).toBe(1);
    }
  });

  it.each([
    { label: "empty ID", registry: 'actors:\n  "": {}\n', message: /Actor IDs/ },
    { label: "padded ID", registry: 'actors:\n  " customer ": {}\n', message: /Actor IDs/ },
    { label: "nonmapping entry", registry: "actors:\n  customer: 1\n", message: /must be a mapping/ },
    { label: "empty name", registry: 'actors:\n  customer:\n    name: " "\n', message: /name must be a nonempty string/ },
    { label: "numeric name", registry: "actors:\n  customer:\n    name: 7\n", message: /name must be a nonempty string/ },
    { label: "short color", registry: 'actors:\n  customer:\n    color: "#abc"\n', message: /color must be/ },
    { label: "named color", registry: "actors:\n  customer:\n    color: red\n", message: /color must be/ },
    { label: "unquoted color", registry: "actors:\n  customer:\n    color: #123456\n", message: /color must be/ },
    { label: "nonmapping registry", registry: "actors: []\n", message: /actors mapping/ },
    { label: "missing actors mapping", registry: "{}\n", message: /actors mapping/ },
    { label: "empty registry document", registry: "", message: /actors mapping/ },
    { label: "duplicate YAML ID", registry: "actors:\n  customer: {}\n  customer: {}\n", message: /Invalid actor registry/ }
  ])("reports $label without throwing on either loading surface", ({ registry, message }) => {
    const projects = loadBoth(files({ registry, screen: "  actors: []\n" }));
    expect(projects[0].actorIssues).toEqual(projects[1].actorIssues);
    for (const project of projects) {
      expect(project.actorIssues).toContainEqual({ path: registryPath, message: expect.stringMatching(message) });
    }
  });

  it.each([
    { label: "scalar references", screen: "  actors: customer\n", message: /must be an array/, actors: [] },
    { label: "nonstring reference", screen: "  actors: [customer, 7, null]\n", message: /nonempty strings/, actors: ["customer"] },
    { label: "empty reference", screen: '  actors: [""]\n', message: /nonempty strings/, actors: [] },
    { label: "padded reference", screen: '  actors: [" customer "]\n', message: /nonempty strings/, actors: [] },
    { label: "duplicate reference", screen: "  actors: [customer, customer]\n", message: /more than once/, actors: ["customer"] }
  ])("reports $label at the slice and retains only valid unique IDs", ({ screen, message, actors }) => {
    const projects = loadBoth(files({ screen }));
    expect(projects[0].actorIssues).toEqual(projects[1].actorIssues);
    for (const project of projects) {
      expect(project.slices[0].screen.actors).toEqual(actors);
      expect(project.actorIssues).toContainEqual({ path: slicePath, message: expect.stringMatching(message) });
    }
  });

  it.each([undefined, "actors: {}\n"])("does not infer system-only actors or attach actor definitions to processors", (registry) => {
    for (const project of loadBoth(files({ registry, screen: "  type: system\n  actors: [scheduler]\n" }))) {
      expect(project.slices[0].screen.actors).toEqual(["scheduler"]);
      expect(project.actors).toEqual([]);
      expect(project.actorIssues).toEqual([]);
      const processor = project.nodes.find((node) => node.type === "processor")!;
      expect(processor.actors).toEqual(["scheduler"]);
      expect(processor).not.toHaveProperty("actorDefinitions");
    }
  });
});
