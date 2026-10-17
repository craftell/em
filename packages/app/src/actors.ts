import { actorColor } from "@emviz/parser/browser";
import type { ActorDefinition, EventModelProject, ProjectNode } from "./types";

export type ActorFilter = {
  actorIds: string[];
  includeUnassigned: boolean;
};

export type ActorVisibility = {
  nodeIds: Set<string>;
  relatedNodeIds: Set<string>;
};

export function screenActors(node: ProjectNode): ActorDefinition[] {
  if (node.type !== "screen") return [];
  const definitions = new Map(node.actorDefinitions?.map((actor) => [actor.id, actor]));
  return [...new Set(node.actors ?? [])].map((id) => definitions.get(id) ?? { id, name: id, color: actorColor(id) });
}

export function actorOptions(project: EventModelProject, previousNodes: Record<string, ProjectNode> = {}): ActorDefinition[] {
  const actors = new Map(project.actors?.map((actor) => [actor.id, actor]));
  for (const node of [...project.nodes, ...Object.values(previousNodes)]) {
    for (const actor of screenActors(node)) {
      if (!actors.has(actor.id)) actors.set(actor.id, actor);
    }
  }
  return [...actors.values()];
}

export function pruneActorFilter(project: EventModelProject, filter: ActorFilter, previousNodes: Record<string, ProjectNode> = {}): ActorFilter {
  const available = new Set(actorOptions(project, previousNodes).map((actor) => actor.id));
  const actorIds = filter.actorIds.filter((id) => available.has(id));
  const includeUnassigned = filter.includeUnassigned && [...project.nodes, ...Object.values(previousNodes)].some((node) => node.type === "screen" && !node.actors?.length);
  return actorIds.length === filter.actorIds.length && includeUnassigned === filter.includeUnassigned
    ? filter
    : { actorIds, includeUnassigned };
}

export function actorVisibility(project: EventModelProject, filter: ActorFilter, previousNodes: Record<string, ProjectNode> = {}): ActorVisibility {
  if (filter.actorIds.length === 0 && !filter.includeUnassigned) {
    return { nodeIds: new Set(project.nodes.map((node) => node.id)), relatedNodeIds: new Set() };
  }

  const selected = new Set(filter.actorIds);
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const sliceByNode = new Map<string, string>();
  for (const node of project.nodes) {
    if (node.type === "story" || node.type === "event") continue;
    if (node.sourcePath) sliceByNode.set(node.id, node.sourcePath);
  }
  const localEdges = project.edges.filter((edge) => ["slice-screen", "query-screen", "screen-command"].includes(edge.kind));
  const connectSliceMembers = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of localEdges) {
        const source = sliceByNode.get(edge.source);
        const target = sliceByNode.get(edge.target);
        if (source && !target) {
          sliceByNode.set(edge.target, source);
          changed = true;
        } else if (target && !source) {
          sliceByNode.set(edge.source, target);
          changed = true;
        }
      }
    }
  };
  connectSliceMembers();
  for (const node of project.nodes) {
    if (node.type === "slice" && !sliceByNode.has(node.id)) sliceByNode.set(node.id, node.id);
  }
  connectSliceMembers();
  for (const node of project.nodes) {
    if ((node.type === "screen" || node.type === "processor") && !sliceByNode.has(node.id)) sliceByNode.set(node.id, node.id);
  }
  connectSliceMembers();

  const matches = (node: ProjectNode | undefined) => node?.type === "screen" &&
    ((node.actors ?? []).some((id) => selected.has(id)) || (filter.includeUnassigned && !node.actors?.length));
  const matchedScreens = project.nodes.filter((node) => matches(node) || matches(previousNodes[node.id]));
  const matchedSlices = new Set(matchedScreens.flatMap((node) => {
    const path = sliceByNode.get(node.id);
    return path ? [path] : [];
  }));
  const directIds = new Set(matchedScreens.map((node) => node.id));
  for (const [id, path] of sliceByNode) {
    if (matchedSlices.has(path)) directIds.add(id);
  }

  const eventLinks = project.edges.filter((edge) => edge.kind === "command-event" || edge.kind === "event-query");
  const endpointEvents = (ids: Set<string>): Set<string> => {
    const events = new Set<string>();
    for (const edge of eventLinks) {
      if (ids.has(edge.source) && byId.get(edge.target)?.type === "event") events.add(edge.target);
      if (ids.has(edge.target) && byId.get(edge.source)?.type === "event") events.add(edge.source);
    }
    return events;
  };
  const directEvents = endpointEvents(directIds);
  const relatedSlices = new Set<string>();
  const processorSlices = new Set(project.nodes.filter((node) => node.type === "processor").map((node) => sliceByNode.get(node.id)));
  for (const edge of eventLinks) {
    const neighbor = directEvents.has(edge.source) ? edge.target : directEvents.has(edge.target) ? edge.source : undefined;
    const path = neighbor ? sliceByNode.get(neighbor) : undefined;
    if (path && processorSlices.has(path) && !matchedSlices.has(path)) relatedSlices.add(path);
  }

  const relatedNodeIds = new Set<string>();
  for (const [id, path] of sliceByNode) {
    if (relatedSlices.has(path)) relatedNodeIds.add(id);
  }
  for (const id of endpointEvents(relatedNodeIds)) {
    if (!directEvents.has(id)) relatedNodeIds.add(id);
  }
  const nodeIds = new Set([...directIds, ...directEvents, ...relatedNodeIds]);
  const stories = new Set(project.nodes.filter((node) => nodeIds.has(node.id) && node.type !== "event").map((node) => node.storyName));
  for (const node of project.nodes) {
    if (node.type === "story" && stories.has(node.label)) nodeIds.add(node.id);
  }
  return { nodeIds, relatedNodeIds };
}
