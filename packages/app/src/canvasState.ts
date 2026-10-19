import { nodeStoryKey, storyKey } from "./timeline";
import type { EventModelProject, ProjectEdge, ProjectNode, ProjectStory } from "./types";

export type EdgeVisibility = "auto" | "intra-slice" | "all";

/** Legacy story paths are stable across label changes and array reordering. */
export function stableStoryId(story: ProjectStory): string {
  return story.id ?? story.path;
}

export type CanvasMembership = {
  sliceByNode: Map<string, string>;
  storyByNode: Map<string, string>;
  stableStoryByNode: Map<string, string>;
  stableStoryBySlice: Map<string, string>;
};

/** Events belong to their first real producer, never the shared events source file. */
export function canvasMembership(project: EventModelProject, boundaryEvents = false): CanvasMembership {
  const sliceByNode = new Map<string, string>();
  const storyByNode = new Map<string, string>();
  const stableStoryByNode = new Map<string, string>();
  const stableStoryBySlice = new Map<string, string>();
  const byPath = new Map(project.slices.map((slice) => [slice.path, slice]));
  const storiesByStableId = new Map(project.stories.map((story) => [stableStoryId(story), story]));
  const resolveStory = (node: ProjectNode): ProjectStory | undefined => {
    const key = node.storyId ?? (node.type === "story" ? node.label : nodeStoryKey(node));
    const matches = project.stories.filter((story) => storyKey(story) === key);
    if (node.storyId && matches.length === 1) return matches[0];
    // Legacy stories can share a name; their source file identifies each header.
    const sourceMatches = project.stories.filter((story) => story.path === node.sourcePath);
    return sourceMatches.length === 1 ? sourceMatches[0] : matches.length === 1 ? matches[0] : undefined;
  };
  for (const slice of project.slices) {
    const key = slice.storyId ?? slice.storyName;
    const matches = project.stories.filter((story) => storyKey(story) === key);
    // Preserve a canonical owner for shared slices, using membership to disambiguate legacy names.
    const owner = matches.find((story) => story.slices.includes(slice.path)) ??
      (matches.length === 1 ? matches[0] : undefined) ??
      project.stories.find((story) => story.slices.includes(slice.path));
    if (owner) stableStoryBySlice.set(slice.path, stableStoryId(owner));
  }
  const resolveSlice = (node: ProjectNode): string | undefined => {
    if (node.sourcePath && byPath.has(node.sourcePath)) return node.sourcePath;
    const title = node.sliceTitle ?? (node.type === "slice" ? node.label : undefined);
    if (!title) return undefined;
    const owner = nodeStoryKey(node);
    const matches = project.slices.filter((slice) => slice.title === title &&
      (!owner || (slice.storyId ?? slice.storyName) === owner));
    return matches.length === 1 ? matches[0].path : undefined;
  };
  for (const node of project.nodes) {
    if (node.type === "story") {
      const story = resolveStory(node);
      if (story) {
        storyByNode.set(node.id, storyKey(story));
        stableStoryByNode.set(node.id, stableStoryId(story));
      }
      continue;
    }
    if (node.type === "event") continue;
    const path = resolveSlice(node);
    if (path) sliceByNode.set(node.id, path);
    const stableId = path ? stableStoryBySlice.get(path) : undefined;
    const story = stableId ? storiesByStableId.get(stableId) : resolveStory(node);
    const owner = story ? storyKey(story) : path ? byPath.get(path)?.storyId ?? byPath.get(path)?.storyName : nodeStoryKey(node);
    if (owner) storyByNode.set(node.id, owner);
    if (story) stableStoryByNode.set(node.id, stableStoryId(story));
  }
  for (const node of project.nodes) {
    if (node.type !== "event") continue;
    const producer = project.edges.find((edge) => edge.kind === "command-event" && edge.target === node.id);
    const path = producer ? sliceByNode.get(producer.source) : boundaryEvents ? undefined : resolveSlice(node);
    if (path) sliceByNode.set(node.id, path);
    const owner = producer ? storyByNode.get(producer.source) : path ? byPath.get(path)?.storyId ?? byPath.get(path)?.storyName : undefined;
    const stableId = producer ? stableStoryByNode.get(producer.source) : path ? stableStoryBySlice.get(path) : undefined;
    if (owner) storyByNode.set(node.id, owner);
    if (stableId) stableStoryByNode.set(node.id, stableId);
  }
  return { sliceByNode, storyByNode, stableStoryByNode, stableStoryBySlice };
}


/** Filtering does not add dependencies or change any canonical graph endpoint. */
export function visibleDomainEdge(
  edge: ProjectEdge,
  mode: EdgeVisibility,
  selected: ProjectNode | undefined,
  membership: CanvasMembership
): boolean {
  if (mode === "all") return true;
  const sourceSlice = membership.sliceByNode.get(edge.source);
  const targetSlice = membership.sliceByNode.get(edge.target);
  if (sourceSlice && sourceSlice === targetSlice) return true;
  if (mode === "intra-slice" || !selected) return false;
  if (selected.type === "slice") {
    const selectedSlice = membership.sliceByNode.get(selected.id);
    return Boolean(selectedSlice && (sourceSlice === selectedSlice || targetSlice === selectedSlice));
  }
  return edge.source === selected.id || edge.target === selected.id;
}

/** Collision-free project and timeline namespaces; view preferences never enter model YAML. */
export function canvasStorageKey(project: EventModelProject, timelineId?: string): string {
  const modelId = project.graphSidecar?.model?.id;
  const projectIdentity = project.root && project.root !== "browser-import"
    ? ["root", project.root, modelId ?? null]
    : modelId && modelId !== "browser_import"
      ? ["model", modelId]
      : ["sources", ...new Set(project.stories.map((story) => story.path).sort())];
  return "emviz:collapsed-stories:v1:" + encodeURIComponent(JSON.stringify([projectIdentity, timelineId ?? null]));
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

export function readCollapsedStories(key: string, validIds?: ReadonlySet<string>, storage?: ReadStorage): Set<string> {
  try {
    const raw = (storage ?? window.localStorage).getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) return new Set();
    return new Set((parsed as string[]).filter((id) => !validIds || validIds.has(id)));
  } catch {
    return new Set();
  }
}

export function writeCollapsedStories(key: string, ids: ReadonlySet<string>, storage?: WriteStorage): boolean {
  try {
    (storage ?? window.localStorage).setItem(key, JSON.stringify([...ids].sort()));
    return true;
  } catch {
    return false;
  }
}

export function browserImportRoot(modelId: string | undefined, importId: string): string {
  return "browser-import:" + JSON.stringify(modelId && modelId !== "browser_import" ? ["model", modelId] : ["session", importId]);
}
