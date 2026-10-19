import type { EventModelProject, ProjectNode, ProjectStory, TimelineModel } from "./types";

export const storyKey = (story: ProjectStory): string => story.id ?? story.name;
export const nodeStoryKey = (node: ProjectNode): string | undefined => node.storyId ?? node.storyName;

/** A view projection only: canonical IDs, source paths, raw source and edges survive unchanged. */
export function projectTimeline(project: EventModelProject, timeline?: TimelineModel): EventModelProject {
  if (!timeline) return project;
  const storiesById = new Map(project.stories.map((story) => [storyKey(story), story]));
  const stories = timeline.steps.flatMap((step) => {
    const story = storiesById.get(step.storyId);
    return story ? [story] : [];
  });
  const storyIds = new Set(stories.map(storyKey));
  const owners = new Map(stories.flatMap((story) => story.slices.map((path) => [path, story] as const)));
  const slices = project.slices.filter((slice) => owners.has(slice.path)).map((slice) => {
    const owner = owners.get(slice.path)!;
    return { ...slice, storyName: owner.name, storyId: storyKey(owner) };
  });
  const slicePath = (node: ProjectNode) => node.sourcePath ?? project.slices.find((slice) => slice.title === (node.sliceTitle ?? node.label))?.path;
  const members = project.nodes.filter((node) => node.type !== "event" && (
    node.type === "story" ? storyIds.has(node.storyId ?? node.label) : owners.has(slicePath(node) ?? "")
  ));
  const ids = new Set(members.map((node) => node.id));
  // Keep boundary events for reads from outside this timeline, without importing unrelated slices.
  for (const edge of project.edges) {
    if (edge.kind === "command-event" && ids.has(edge.source)) ids.add(edge.target);
    if (edge.kind === "event-query" && ids.has(edge.target)) ids.add(edge.source);
  }
  const nodes = project.nodes.filter((node) => ids.has(node.id)).map((node) => {
    if (node.type === "story" || node.type === "event") return node;
    const owner = owners.get(slicePath(node) ?? "");
    return owner ? { ...node, storyName: owner.name, storyId: storyKey(owner) } : node;
  });
  return { ...project, stories, slices, nodes, edges: project.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}

/** Invalid/cyclic steps do not hang the viewer; validation reports them separately. */
export function timelineRanks(timeline: TimelineModel): Map<string, number> {
  const steps = new Map(timeline.steps.map((step) => [step.id, step]));
  const ranks = new Map<string, number>();
  const pending = new Set(steps.keys());
  while (pending.size) {
    let advanced = false;
    for (const id of pending) {
      const step = steps.get(id)!;
      if (step.after.some((previous) => steps.has(previous) && !ranks.has(previous))) continue;
      ranks.set(id, Math.max(0, ...step.after.map((previous) => (ranks.get(previous) ?? -1) + 1)));
      pending.delete(id);
      advanced = true;
    }
    if (!advanced) {
      for (const id of pending) ranks.set(id, 0);
      break;
    }
  }
  return new Map(timeline.steps.map((step) => [step.storyId, ranks.get(step.id) ?? 0]));
}

/** Diff snapshots retain deleted graph elements outside current timeline membership. */
export function timelineForView(timelineId: string | undefined, isDiff: boolean): string | undefined {
  return isDiff ? undefined : timelineId;
}
