import { describe, expect, it } from "vitest";
import { canvasMembership, canvasStorageKey, readCollapsedStories, stableStoryId, visibleDomainEdge, writeCollapsedStories } from "./canvasState";
import type { EventModelProject } from "./types";

function project(root = "/project"): EventModelProject {
  return {
    root,
    config: { paths: { eventModelDir: "model", featuresDir: "model", sliceExtension: ".slice.yaml", eventsFile: "events.yaml", storiesDir: "stories" } },
    events: [],
    stories: [
      { id: "first", name: "Same", path: "first.yaml", description: "", slices: ["first.slice.yaml"] },
      { id: "second", name: "Same", path: "second.yaml", description: "", slices: ["second.slice.yaml"] }
    ],
    slices: [
      { title: "Same", path: "first.slice.yaml", storyId: "first" },
      { title: "Same", path: "second.slice.yaml", storyId: "second" }
    ],
    nodes: [
      { id: "first_story", type: "story", label: "Same", storyId: "first" },
      { id: "first_slice", type: "slice", label: "Same", sourcePath: "first.slice.yaml" },
      { id: "command", type: "command", label: "Command", sourcePath: "first.slice.yaml" },
      { id: "event", type: "event", label: "Event", sourcePath: "events.yaml" },
      { id: "query", type: "query", label: "Query", sourcePath: "second.slice.yaml" }
    ],
    edges: [
      { id: "emit", kind: "command-event", source: "command", target: "event" },
      { id: "read", kind: "event-query", source: "event", target: "query" }
    ]
  };
}

describe("canvas membership", () => {
  it("derives missing owner metadata from source paths and producer edges", () => {
    const membership = canvasMembership(project());
    expect(membership.sliceByNode.get("event")).toBe("first.slice.yaml");
    expect(membership.storyByNode.get("event")).toBe("first");
    expect(membership.storyByNode.get("query")).toBe("second");
    expect(membership.sliceByNode.get("first_story")).toBeUndefined();
  });

  it("never mistakes two unknown slices for an intra-slice edge", () => {
    const model = project();
    model.nodes = model.nodes.map((node) => ({ ...node, sourcePath: undefined }));
    const membership = canvasMembership(model);
    expect(visibleDomainEdge(model.edges[1], "auto", undefined, membership)).toBe(false);
    expect(visibleDomainEdge(model.edges[1], "intra-slice", model.nodes[4], membership)).toBe(false);
    expect(visibleDomainEdge(model.edges[1], "auto", model.nodes[4], membership)).toBe(true);
  });

  it("does not assign boundary events to a timeline story from stale metadata", () => {
    const model = project();
    model.edges = model.edges.filter((edge) => edge.kind !== "command-event");
    const event = model.nodes.find((node) => node.type === "event")!;
    event.sliceTitle = "Same";
    event.storyId = "first";
    const membership = canvasMembership(model, true);
    expect(membership.sliceByNode.get(event.id)).toBeUndefined();
    expect(membership.storyByNode.get(event.id)).toBeUndefined();
  });

  it("keeps first-producer ownership deterministic for shared events", () => {
    const model = project();
    model.nodes.push({ id: "second_command", type: "command", label: "Second", sourcePath: "second.slice.yaml" });
    model.edges.push({ id: "second_emit", kind: "command-event", source: "second_command", target: "event" });
    expect(canvasMembership(model).sliceByNode.get("event")).toBe("first.slice.yaml");
  });
});

describe("collapsed story preferences", () => {
  it("separates projects and timelines without delimiter collisions", () => {
    const a = project("/a");
    const b = project("/b");
    expect(canvasStorageKey(a)).not.toBe(canvasStorageKey(b));
    expect(canvasStorageKey(a, "x")).not.toBe(canvasStorageKey(a, "y"));
    expect(canvasStorageKey(a)).not.toBe(canvasStorageKey(a, ""));
    expect(canvasStorageKey(project("/a:b"), "c")).not.toBe(canvasStorageKey(project("/a"), "b:c"));
  });

  it("uses stable IDs or legacy paths across reordering and title changes", () => {
    const model = project();
    const initial = canvasStorageKey(model, "timeline");
    model.stories.reverse();
    model.stories[0].name = "Renamed";
    expect(canvasStorageKey(model, "timeline")).toBe(initial);
    expect(stableStoryId(model.stories[0])).toBe("second");
    expect(stableStoryId({ ...model.stories[0], id: undefined })).toBe("second.yaml");
    expect(canvasStorageKey({ ...model, root: "", graphSidecar: { model: { id: "stable" } } })).toBe(
      canvasStorageKey({ ...model, root: "", stories: [], graphSidecar: { model: { id: "stable" } } })
    );
  });

  it("round-trips only valid stable story IDs and drops stale saved entries", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(writeCollapsedStories("key", new Set(["second", "first", "removed"]), storage)).toBe(true);
    expect(values.get("key")).toBe('["first","removed","second"]');
    expect([...readCollapsedStories("key", new Set(["first", "second"]), storage)]).toEqual(["first", "second"]);
    expect(readCollapsedStories("other", undefined, storage).size).toBe(0);
  });

  it("survives malformed, unavailable and quota-limited storage", () => {
    for (const raw of ["{", "null", "{}", '["first",1]', '"first"']) {
      expect(readCollapsedStories("key", undefined, { getItem: () => raw }).size).toBe(0);
    }
    expect(readCollapsedStories("key", undefined, { getItem: () => { throw new Error("denied"); } }).size).toBe(0);
    expect(writeCollapsedStories("key", new Set(["first"]), { setItem: () => { throw new Error("quota"); } })).toBe(false);
  });
});
