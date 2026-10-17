import { describe, expect, it } from "vitest";
import { loadEventModelProjectFromFiles, type ActorDefinition } from "@emviz/parser";
import { buildGraphSidecar, diffEventModelProjects } from "./index.js";

const original: ActorDefinition = { id: "customer", name: "Customer", color: "#123456" };
const registryPath = "metadata/people.yaml";

function project(actor: ActorDefinition, includeScreen = true) {
  return loadEventModelProjectFromFiles([
    { path: ".event-modeling/config.yaml", content: "paths:\n  actors_file: metadata/people.yaml\n" },
    { path: "event-model/events.yaml", content: "events: {}\n" },
    { path: registryPath, content: JSON.stringify({ actors: { [actor.id]: { name: actor.name, color: actor.color } } }) },
    ...(includeScreen ? [{
      path: "event-model/features/register.slice.yaml",
      content: "slice: Register\nscreen:\n  name: Registration\n  actors: [customer]\n"
    }] : [])
  ]);
}

describe("actor metadata in graph snapshots", () => {
  it("records the configured actor registry as a sidecar source", () => {
    expect(buildGraphSidecar(project(original)).sources.actors).toBe(registryPath);
  });

  it.each([
    { label: "name", actor: { ...original, name: "Account holder" } },
    { label: "color", actor: { ...original, color: "#ABCDEF" } }
  ])("marks a registry-only $label edit as a screen change and retains the old definition", ({ actor }) => {
    const base = project(original);
    const target = project(actor);
    const screen = target.nodes.find((node) => node.type === "screen")!;
    const result = diffEventModelProjects(base, target);

    expect(base.slices[0].raw).toBe(target.slices[0].raw);
    expect(result.diff.nodeStatus[screen.id]).toBe("changed");
    expect(result.diff.summary.nodes).toEqual({
      added: 0, removed: 0, changed: 1, unchanged: target.nodes.length - 1
    });
    expect(result.diff.summary.edges).toEqual({
      added: 0, removed: 0, changed: 0, unchanged: target.edges.length
    });
    expect(result.project.nodes.find((node) => node.id === screen.id)?.actorDefinitions).toEqual([actor]);
    expect(result.diff.previousNodes?.[screen.id].actorDefinitions).toEqual([original]);
  });

  it("isolates current and historical definitions from later mutations of either input", () => {
    const changed = { ...original, name: "Account holder", color: "#ABCDEF" };
    const base = project(original);
    const target = project(changed);
    const baseScreen = base.nodes.find((node) => node.type === "screen")!;
    const targetScreen = target.nodes.find((node) => node.type === "screen")!;
    const result = diffEventModelProjects(base, target);
    const displayed = result.project.nodes.find((node) => node.id === targetScreen.id)!;

    base.actors![0].name = "Changed after diff";
    baseScreen.actorDefinitions![0].color = "#000000";
    baseScreen.actors!.push("base-only");
    target.actors![0].name = "Changed target";
    targetScreen.actorDefinitions![0].color = "#FFFFFF";
    targetScreen.actors!.push("target-only");

    expect(result.project.actors).toEqual([changed]);
    expect(displayed.actorDefinitions).toEqual([changed]);
    expect(displayed.actors).toEqual(["customer"]);
    expect(result.diff.previousNodes?.[targetScreen.id].actorDefinitions).toEqual([original]);
    expect(result.diff.previousNodes?.[targetScreen.id].actors).toEqual(["customer"]);

    displayed.actorDefinitions![0].name = "Display mutation";
    expect(result.project.actors).toEqual([changed]);
    expect(targetScreen.actorDefinitions![0].name).toBe("Changed target");
    expect(result.diff.previousNodes?.[targetScreen.id].actorDefinitions).toEqual([original]);
  });

  it("keeps a removed screen's old metadata even when the current registry redefines its actor", () => {
    const changed = { ...original, name: "Current customer", color: "#ABCDEF" };
    const base = project(original);
    const target = project(changed, false);
    const baseScreen = base.nodes.find((node) => node.type === "screen")!;
    const result = diffEventModelProjects(base, target);
    const removed = result.project.nodes.find((node) => node.type === "screen")!;

    expect(result.diff.nodeStatus[removed.id]).toBe("removed");
    expect(result.project.actors).toEqual([changed]);
    expect(removed.actorDefinitions).toEqual([original]);
    expect(result.diff.previousNodes?.[removed.id].actorDefinitions).toEqual([original]);

    baseScreen.actorDefinitions![0].color = "#000000";
    baseScreen.actors!.push("late");
    target.actors![0].name = "Later current name";
    expect(removed.actorDefinitions).toEqual([original]);
    expect(removed.actors).toEqual(["customer"]);
    expect(result.project.actors).toEqual([changed]);

    removed.actorDefinitions![0].name = "Ghost mutation";
    expect(result.diff.previousNodes?.[removed.id].actorDefinitions).toEqual([original]);
    expect(baseScreen.actorDefinitions![0].name).toBe("Customer");
  });

  it("keeps unused registry edits out of screen changes", () => {
    const base = project(original);
    const files = [
      { path: ".event-modeling/config.yaml", content: "paths:\n  actors_file: metadata/people.yaml\n" },
      { path: "event-model/events.yaml", content: "events: {}\n" },
      { path: registryPath, content: 'actors:\n  customer:\n    name: Customer\n    color: "#123456"\n  unused:\n    name: New actor\n    color: "#ABCDEF"\n' },
      { path: base.slices[0].path, content: base.slices[0].raw }
    ];
    const target = loadEventModelProjectFromFiles(files);
    const result = diffEventModelProjects(base, target);

    expect(result.project.actors).toHaveLength(2);
    expect(result.diff.summary.nodes).toEqual({
      added: 0, removed: 0, changed: 0, unchanged: target.nodes.length
    });
  });
});
