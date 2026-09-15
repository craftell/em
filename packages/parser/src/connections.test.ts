import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEventModelProject } from "./index.js";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "./browser.js";
import type { EventModelProject } from "./types.js";

function fixture(names = ["First", "Second"]): InMemoryEventModelFile[] {
  return [
    { path: ".event-modeling/config.yaml", content: "paths:\n  event_model_dir: event-model\n  features_dir: event-model/features\n" },
    { path: "event-model/events.yaml", content: `events:\n${names.map((name) => `  ${name}Saved: {}`).join("\n")}\n` },
    ...names.map((name) => ({
      path: `event-model/features/${name}.slice.yaml`,
      content: `slice: ${name}
screen:
  name: ${name} screen
  reads: [Status]
  executes: [Save]
commands:
  - name: Save
    produces: [${name}Saved]
queries:
  - name: Status
    from_events: [${name}Saved]
gwt:
  - name: Saved
    given: [{type: event, name: ${name}Saved}]
    when: [{type: command, name: Save}]
    then: [{type: event, name: ${name}Saved}]
`
    }))
  ];
}

function peers(project: EventModelProject, id: string, direction: "incoming" | "outgoing") {
  return project.edges
    .filter((edge) => direction === "incoming" ? edge.target === id : edge.source === id)
    .map((edge) => project.nodes.find((node) => node.id === (direction === "incoming" ? edge.source : edge.target))?.label);
}

function expectIsolatedSlices(project: EventModelProject) {
  for (const slice of project.slices) {
    const command = project.nodes.find((node) => node.type === "command" && node.sourcePath === slice.path)!;
    const query = project.nodes.find((node) => node.type === "query" && node.sourcePath === slice.path)!;
    expect(peers(project, command.id, "incoming")).toEqual([slice.screen.name]);
    expect(peers(project, command.id, "outgoing")).toEqual([...new Set(slice.commands[0].produces)]);
    expect(peers(project, query.id, "incoming")).toEqual([...new Set(slice.queries[0].fromEvents)]);
    expect(peers(project, query.id, "outgoing")).toEqual([slice.screen.name]);
  }
  expect(new Set(project.nodes.map((node) => node.id)).size).toBe(project.nodes.length);
  expect(new Set(project.edges.map((edge) => edge.id)).size).toBe(project.edges.length);
  for (const node of project.nodes.filter((node) => node.type === "gwt")) {
    expect(peers(project, node.id, "incoming")).toEqual([]);
    expect(peers(project, node.id, "outgoing")).toEqual([]);
  }
}

for (const loader of ["browser", "disk"] as const) {
  const load = (files: InMemoryEventModelFile[]) => {
    if (loader === "browser") return loadEventModelProjectFromFiles(files);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-connections-"));
    try {
      for (const file of files) {
        const target = path.join(root, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content);
      }
      return loadEventModelProject(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  describe(`${loader} graph connections`, () => {
    it("does not mix same-named commands or queries from separate slices", () => {
      expectIsolatedSlices(load(fixture()));
    });

    it("keeps one incoming and outgoing neighbor with 40 same-named definitions", () => {
      expectIsolatedSlices(load(fixture(Array.from({ length: 40 }, (_, index) => `Slice${index}`))));
    });

    it("keeps exact names and paths distinct when their slugs collide", () => {
      const files = fixture(["First-A", "First_A"]).map((file) => ({
        ...file,
        content: file.path.includes("First_A") ? file.content.replaceAll("Save", "save").replaceAll("Status", "status") : file.content
      }));
      // Keep event registry spellings aligned with the references in each slice.
      files[1].content = files[1].content.replace("First_ASaved", "First_Asaved");
      expectIsolatedSlices(load(files));
    });

    it("deduplicates repeated references without changing the source model", () => {
      const project = load(fixture().map((file) => ({
        ...file,
        content: file.content.replaceAll(/\[(FirstSaved|SecondSaved)\]/g, "[$1, $1]")
      })));
      expectIsolatedSlices(project);
      expect(project.slices[0].commands[0].produces).toHaveLength(2);
      expect(project.slices[0].queries[0].fromEvents).toHaveLength(2);
    });

    it("keeps repeated GWT names separate and disconnected", () => {
      const project = load(fixture().map((file) => ({
        ...file,
        content: file.path.endsWith(".slice.yaml") ? `${file.content}  - name: Saved\n    given: []\n    when: []\n    then: []\n` : file.content
      })));
      expect(project.nodes.filter((node) => node.type === "gwt")).toHaveLength(4);
      expectIsolatedSlices(project);
    });

    it("does not resolve an unregistered event to another event with the same slug", () => {
      const project = load(fixture().map((file) => ({
        ...file,
        content: file.path.endsWith("First.slice.yaml") ? file.content.replaceAll("[FirstSaved]", "[First Saved]") : file.content
      })));
      const event = project.nodes.find((node) => node.label === "FirstSaved")!;
      expect(peers(project, event.id, "incoming")).toEqual([]);
      expect(peers(project, event.id, "outgoing")).toEqual([]);
      const command = project.nodes.find((node) => node.type === "command" && node.sliceTitle === "First")!;
      expect(peers(project, command.id, "outgoing")).toEqual([undefined]);
    });

    it("preserves legitimate connections through canonical events across slices", () => {
      const project = load(fixture().map((file) => ({
        ...file,
        content: file.path.endsWith("Second.slice.yaml") ? file.content.replace("from_events: [SecondSaved]", "from_events: [FirstSaved]") : file.content
      })));
      const event = project.nodes.find((node) => node.label === "FirstSaved")!;
      const outgoing = project.edges.filter((edge) => edge.source === event.id);
      expect(outgoing).toHaveLength(2);
      expect(new Set(outgoing.map((edge) => edge.target)).size).toBe(2);
    });

    it("uses slice paths, not shared story names, for story membership", () => {
      const project = load([
        ...fixture(),
        ...["First", "Second"].map((name) => ({
          path: `event-model/stories/${name}.yaml`,
          content: `name: Same story\nslices:\n  - event-model/features/${name}.slice.yaml\n`
        }))
      ]);
      for (const name of ["First", "Second"]) {
        const story = project.nodes.find((node) => node.type === "story" && node.sourcePath === `event-model/stories/${name}.yaml`)!;
        expect(peers(project, story.id, "outgoing")).toEqual([name]);
      }
    });

    it("keeps handles stable when files reorder or unrelated definitions are inserted", () => {
      const files = fixture();
      const original = load(files);
      const changed = load([...files].reverse().map((file) => ({
        ...file,
        content: file.content.replace("commands:\n", "commands:\n  - name: Unrelated\n    produces: []\n")
      })));
      for (const node of original.nodes) {
        const match = changed.nodes.find((candidate) => candidate.type === node.type && candidate.sourcePath === node.sourcePath && candidate.sourceName === node.sourceName);
        expect(match?.id).toBe(node.id);
      }
    });
  });
}
