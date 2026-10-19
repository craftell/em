import { describe, expect, it } from "vitest";
import { toFlow } from "./layout";
import { projectTimeline, timelineRanks } from "./timeline";
import type { EventModelProject } from "./types";

function fixture(): EventModelProject {
  const story = (id: string, slices = [id]) => ({ id, name: "Shared label", description: "", path: "members.feature.yaml", slices: slices.map((name) => name + ".slice.yaml") });
  const stories = [story("register", ["register", "confirm"]), story("profile"), story("leave"), story("finish"), story("other", ["profile"])];
  const sliceIds = ["register", "confirm", "profile", "leave", "finish"];
  return {
    root: "", config: { paths: { eventModelDir: "model", featuresDir: "model", sliceExtension: ".slice.yaml", eventsFile: "events.yaml", storiesDir: "stories" } },
    events: [], stories,
    slices: sliceIds.map((id) => ({ title: id, path: id + ".slice.yaml", storyName: "Shared label", storyId: id === "profile" ? "other" : id === "confirm" ? "register" : id })),
    nodes: [
      ...stories.map((story) => ({ id: "story_" + story.id, type: "story" as const, label: story.name, storyId: story.id, sourcePath: story.path })),
      ...sliceIds.flatMap((id) => [
        { id: "slice_" + id, type: "slice" as const, label: id, sliceTitle: id, sourcePath: id + ".slice.yaml", storyName: "Shared label", storyId: id === "profile" ? "other" : id === "confirm" ? "register" : id },
        { id: "screen_" + id, type: "screen" as const, label: id, sliceTitle: id, sourcePath: id + ".slice.yaml", actors: ["member"], storyName: "Shared label", storyId: id === "profile" ? "other" : id === "confirm" ? "register" : id },
        { id: "command_" + id, type: "command" as const, label: id, sliceTitle: id, sourcePath: id + ".slice.yaml" },
        { id: "event_" + id, type: "event" as const, label: id, sourcePath: "events.yaml" }
      ]),
      { id: "case_profile", type: "gwt", label: "Case", sourcePath: "profile.slice.yaml", sliceTitle: "profile" },
      { id: "external", type: "event", label: "External", sourcePath: "events.yaml" },
      { id: "query_profile", type: "query", label: "Profile", sourcePath: "profile.slice.yaml" }
    ],
    edges: [
      ...sliceIds.map((id) => ({ id: "emit_" + id, kind: "command-event", source: "command_" + id, target: "event_" + id })),
      { id: "read_external", kind: "event-query", source: "external", target: "query_profile" }
    ],
    timelines: [
      { id: "member", name: "Members", path: "members.feature.yaml", steps: [
        { id: "a", storyId: "register", after: [] }, { id: "b", storyId: "profile", after: ["a"] },
        { id: "c", storyId: "leave", after: ["a"] }, { id: "d", storyId: "finish", after: ["b", "c"] }
      ] },
      { id: "alternate", name: "Alternate", path: "members.feature.yaml", steps: [{ id: "z", storyId: "other", after: [] }] }
    ]
  };
}

describe("timeline projection and layout", () => {
  it("places fork siblings in one column and joins beyond complete predecessor widths", () => {
    const flow = toFlow(fixture(), undefined, { timelineId: "member" });
    const node = (id: string) => flow.nodes.find((item) => item.id === "story_" + id)!;
    expect(node("profile").position.x).toBe(node("leave").position.x);
    expect(node("profile").position.x).toBeGreaterThan(node("register").position.x + Number(node("register").style?.width));
    expect(node("leave").position.y).toBeGreaterThan(node("profile").position.y + Number(node("profile").style?.height));
    expect(node("finish").position.x).toBeGreaterThan(node("leave").position.x + Number(node("leave").style?.width));
    expect(flow.nodes.some((item) => item.id === "story_other")).toBe(false);
  });

  it("projects shared slice ownership from the active timeline, with stable IDs and no new edges", () => {
    const project = fixture();
    const before = JSON.stringify(project);
    const selected = projectTimeline(project, project.timelines![0]);
    expect(selected.slices.find((slice) => slice.title === "profile")?.storyId).toBe("profile");
    expect(selected.nodes.find((node) => node.id === "screen_profile")?.storyId).toBe("profile");
    expect(selected.nodes.find((node) => node.id === "screen_profile")?.sourcePath).toBe("profile.slice.yaml");
    expect(selected.nodes.some((node) => node.id === "external")).toBe(true);
    expect(selected.edges.every((edge) => project.edges.includes(edge))).toBe(true);
    expect(JSON.stringify(project)).toBe(before);
    const alternate = projectTimeline(project, project.timelines![1]);
    expect(alternate.nodes.find((node) => node.id === "screen_profile")?.storyId).toBe("other");
  });

  it("keeps actor and diff filtering within the timeline without reflowing its coordinates", () => {
    const project = fixture();
    const base = toFlow(project, undefined, { timelineId: "member" });
    const filtered = toFlow(project, undefined, { timelineId: "member", actorFilter: { actorIds: ["member"], includeUnassigned: false } });
    expect(filtered.nodes.map(({ id, position }) => ({ id, position }))).toEqual(base.nodes.map(({ id, position }) => ({ id, position })));
    expect(filtered.nodes.find((node) => node.id === "story_profile")?.hidden).toBe(false);
    const diff = toFlow(project, undefined, { timelineId: "member", diffFilter: "changed", diffNodeStatus: { command_profile: "changed", event_profile: "changed" }, diffEdgeStatus: { emit_profile: "changed" } });
    expect(diff.edges.map((edge) => edge.id)).toEqual(["emit_profile"]);
  });

  it("keeps all-stories mode and handles out-of-order declarations and cycles without hanging", () => {
    const project = fixture();
    expect(projectTimeline(project)).toBe(project);
    expect(toFlow(project).nodes).toHaveLength(project.nodes.length);
    const timeline = project.timelines![0];
    expect(timelineRanks({ ...timeline, steps: [...timeline.steps].reverse() }).get("finish")).toBe(2);
    expect(timelineRanks({ ...timeline, steps: [{ id: "x", storyId: "register", after: ["y"] }, { id: "y", storyId: "profile", after: ["x"] }] }).size).toBe(2);
  });
});
