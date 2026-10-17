import { describe, expect, it } from "vitest";
import { actorOptions, actorVisibility, pruneActorFilter, screenActors } from "./actors";
import type { EventModelProject, ProjectNode } from "./types";

function project(): EventModelProject {
  const paths = ["customer", "worker", "next-worker", "admin", "unassigned"];
  const nodes: ProjectNode[] = [{ id: "story", type: "story", label: "Checkout" }];
  for (const path of paths) {
    const shared = { sourcePath: path + ".yaml", sliceTitle: "Same title", storyName: "Checkout" };
    nodes.push(
      { ...shared, id: path, type: "slice", label: "Same title" },
      { ...shared, id: path + "-screen", type: path.includes("worker") ? "processor" : "screen", label: path,
        actors: path === "customer" ? ["customer", "unassigned"] : path === "admin" ? ["admin"] : path.includes("worker") ? ["customer"] : [] },
      { ...shared, id: path + "-query", type: "query", label: "Read" },
      { ...shared, id: path + "-command", type: "command", label: "Write" },
      { ...shared, id: path + "-gwt", type: "gwt", label: "Scenario" }
    );
  }
  nodes.push(...["started", "processed", "finished"].map((id) => ({ id, type: "event" as const, label: id })));
  return {
    root: "test",
    config: { paths: { eventModelDir: "", featuresDir: "", sliceExtension: "", eventsFile: "", storiesDir: "" } },
    actors: [{ id: "customer", name: "Customer", color: "#2563eb" }, { id: "admin", name: "Admin", color: "#b45309" }],
    events: [],
    stories: [{ name: "Checkout", description: "", path: "story.yaml", slices: paths.map((path) => path + ".yaml") }],
    slices: paths.map((path) => ({ title: "Same title", path: path + ".yaml", storyName: "Checkout" })),
    nodes,
    edges: [
      { id: "start", kind: "command-event", source: "customer-command", target: "started" },
      { id: "system-read", kind: "event-query", source: "started", target: "worker-query" },
      { id: "human-read", kind: "event-query", source: "started", target: "admin-query" },
      { id: "processed", kind: "command-event", source: "worker-command", target: "processed" },
      { id: "second-read", kind: "event-query", source: "processed", target: "next-worker-query" },
      { id: "finished", kind: "command-event", source: "next-worker-command", target: "finished" }
    ]
  };
}

describe("actor visibility", () => {
  it("includes a matched Slice, its GWT and one complete neighboring processor Slice without recursion", () => {
    const input = project();
    const before = structuredClone(input);
    const result = actorVisibility(input, { actorIds: ["customer"], includeUnassigned: false });
    expect([...result.nodeIds].sort()).toEqual([
      "story", "customer", "customer-screen", "customer-query", "customer-command", "customer-gwt",
      "started", "worker", "worker-screen", "worker-query", "worker-command", "worker-gwt", "processed"
    ].sort());
    expect([...result.relatedNodeIds].sort()).toEqual(["worker", "worker-screen", "worker-query", "worker-command", "worker-gwt", "processed"].sort());
    expect(input).toEqual(before);
  });

  it("combines actors with OR and leaves empty selection unfiltered", () => {
    const input = project();
    const result = actorVisibility(input, { actorIds: ["customer", "admin"], includeUnassigned: false });
    expect(result.nodeIds.has("customer-screen")).toBe(true);
    expect(result.nodeIds.has("admin-screen")).toBe(true);
    expect(result.nodeIds.has("unassigned-screen")).toBe(false);
    expect(actorVisibility(input, { actorIds: [], includeUnassigned: false }).nodeIds.size).toBe(input.nodes.length);
  });

  it("keeps Unassigned independent from a real actor ID and never matches processor actor metadata", () => {
    const input = project();
    const unassigned = actorVisibility(input, { actorIds: [], includeUnassigned: true });
    expect([...unassigned.nodeIds].sort()).toEqual(["story", "unassigned", "unassigned-screen", "unassigned-query", "unassigned-command", "unassigned-gwt"].sort());
    const named = actorVisibility(input, { actorIds: ["unassigned"], includeUnassigned: false });
    expect(named.nodeIds.has("customer-screen")).toBe(true);
    expect(named.nodeIds.has("unassigned-screen")).toBe(false);
    const processor = input.nodes.find((node) => node.id === "next-worker-screen")!;
    processor.actors = ["robot"];
    expect(actorVisibility(input, { actorIds: ["robot"], includeUnassigned: false }).nodeIds.size).toBe(0);
  });

  it("uses structural connections for legacy nodes without paths instead of same-named Slice titles", () => {
    const input = project();
    for (const node of input.nodes.filter((node) => node.id.startsWith("customer"))) delete node.sourcePath;
    input.edges.push(
      { id: "slice-screen", kind: "slice-screen", source: "customer", target: "customer-screen" },
      { id: "screen-command", kind: "screen-command", source: "customer-screen", target: "customer-command" },
      { id: "query-screen", kind: "query-screen", source: "customer-query", target: "customer-screen" }
    );
    const result = actorVisibility(input, { actorIds: ["customer"], includeUnassigned: false });
    expect(result.nodeIds.has("customer")).toBe(true);
    expect(result.nodeIds.has("customer-command")).toBe(true);
    expect(result.nodeIds.has("admin-command")).toBe(false);
  });

  it("matches either old or new actor membership in a diff without assigning actors to a Processor", () => {
    const input = project();
    const screen = input.nodes.find((node) => node.id === "customer-screen")!;
    const previousNodes = { [screen.id]: { ...screen, actors: ["former"] } };
    expect(actorVisibility(input, { actorIds: ["former"], includeUnassigned: false }, previousNodes).nodeIds.has("customer-command")).toBe(true);
    expect(actorVisibility(input, { actorIds: ["customer"], includeUnassigned: false }, previousNodes).nodeIds.has("customer-command")).toBe(true);
    screen.type = "processor";
    expect(actorVisibility(input, { actorIds: ["former"], includeUnassigned: false }, previousNodes).nodeIds.has(screen.id)).toBe(true);
    expect(screenActors(screen)).toEqual([]);
  });
});

describe("actor labels and filter refresh", () => {
  it("uses frozen labels and colors and keeps legacy IDs readable", () => {
    const node: ProjectNode = { id: "screen", type: "screen", label: "Screen", actors: ["a", "legacy", "a"], actorDefinitions: [{ id: "a", name: "Original name", color: "#123456" }] };
    expect(screenActors(node)[0]).toEqual({ id: "a", name: "Original name", color: "#123456" });
    expect(screenActors(node).map((actor) => actor.name)).toEqual(["Original name", "legacy"]);
    expect(screenActors(node)[1].color).toBe(screenActors({ ...node, actors: ["legacy"] })[0].color);
    expect(screenActors({ ...node, type: "processor" })).toEqual([]);
  });

  it("offers removed and previous actors alongside the current registry and prunes only vanished selections", () => {
    const input = project();
    const old: ProjectNode = { id: "customer-screen", type: "screen", label: "Screen", actors: ["former"], actorDefinitions: [{ id: "former", name: "Former actor", color: "#abcdef" }] };
    const previous = { [old.id]: old };
    expect(actorOptions(input, previous).find((actor) => actor.id === "former")).toEqual(old.actorDefinitions![0]);
    expect(actorOptions(input, previous).find((actor) => actor.id === "customer")?.name).toBe("Customer");
    expect(pruneActorFilter(input, { actorIds: ["customer", "former", "gone"], includeUnassigned: true }, previous)).toEqual({ actorIds: ["customer", "former"], includeUnassigned: true });
    expect(pruneActorFilter(input, { actorIds: ["former"], includeUnassigned: false })).toEqual({ actorIds: [], includeUnassigned: false });
  });
});
