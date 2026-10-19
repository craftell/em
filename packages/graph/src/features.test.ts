import { describe, expect, it } from "vitest";
import { loadEventModelProjectFromFiles } from "@emviz/parser";
import { buildGraphSidecar, diffEventModelProjects, resolveSidecarNode } from "./index.js";

function project(after: string[] = []) {
  return loadEventModelProjectFromFiles([
    { path: "event-model/events.yaml", content: "events: {}" },
    { path: "event-model/features/account.feature.yaml", content: JSON.stringify({
      kind: "feature", id: "account", schema_version: 1, name: "Account",
      stories: [{ id: "a", name: "Story", slices: [] }, { id: "b", name: "Story", slices: [] }],
      timelines: [{ id: "main", name: "Main", steps: [{ id: "a", story: "a" }, { id: "b", story: "b", after }] }]
    }) }
  ]);
}

describe("feature timeline diff and sidecar", () => {
  it("keeps same-name story selectors unambiguous", () => {
    const model = project();
    const sidecar = buildGraphSidecar(model);
    const stories = Object.values(sidecar.nodes).filter((node) => node.type === "story");
    expect(stories).toHaveLength(2);
    for (const story of stories) expect(resolveSidecarNode(model, story)).toHaveLength(1);
    expect(sidecar.sources.features).toEqual(["event-model/features/**/*.feature.yaml"]);
  });

  it("retains timeline-only edits and their previous version without inventing edges", () => {
    const base = project();
    const target = project(["a"]);
    const result = diffEventModelProjects(base, target);
    expect(result.diff.timelinesChanged).toBe(true);
    expect(result.diff.previousTimelines).toEqual(base.timelines);
    expect(result.project.timelines).toEqual(target.timelines);
    expect(result.project.edges).toEqual(target.edges);
    expect(result.diff.summary.edges.added).toBe(0);
    target.timelines![0].steps[1].after.push("later");
    expect(result.project.timelines![0].steps[1].after).toEqual(["a"]);
  });

  it("does not flag identical timeline definitions as changed", () => {
    expect(diffEventModelProjects(project(), project()).diff.timelinesChanged).toBe(false);
  });
});
