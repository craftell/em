import fs from "node:fs";
import path from "node:path";
import type { EventModelProject, GraphEdge, GraphNode, GraphNodeType } from "@emviz/parser";

export type GraphSidecarNode = {
  type: GraphNodeType;
  selector: Record<string, string>;
};

export type GraphSidecar = {
  schemaVersion: 1;
  model: {
    id: string;
    name: string;
  };
  sources: {
    events: string;
    stories: string[];
    slices: string[];
  };
  nodes: Record<string, GraphSidecarNode>;
};

export type WriteGraphResult = {
  path: string;
  added: string[];
  preserved: string[];
  stale: string[];
};

export type GraphDiffStatus = "added" | "removed" | "changed" | "unchanged";

export type GraphDiffSummary = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
};

export type GraphDiff = {
  base: {
    label: string;
  };
  target: {
    label: string;
  };
  nodeStatus: Record<string, GraphDiffStatus>;
  edgeStatus: Record<string, GraphDiffStatus>;
  summary: {
    nodes: GraphDiffSummary;
    edges: GraphDiffSummary;
  };
};

export type GraphDiffResult = {
  project: EventModelProject;
  diff: GraphDiff;
};

function selectorForNode(node: GraphNode): Record<string, string> {
  switch (node.type) {
    case "story":
      return { name: node.label };
    case "slice":
      return { slice: node.label };
    case "screen":
    case "processor":
      return { slice: node.sliceTitle ?? node.label };
    case "command":
    case "query":
      return { slice: node.sliceTitle ?? "", name: node.sourceName ?? node.label };
    case "gwt":
      return { slice: node.sliceTitle ?? "", name: node.sourceName ?? node.label };
    case "event":
      return { name: node.sourceName ?? node.label };
  }

  return {};
}

function sourceTypeForNode(node: GraphNode): GraphNodeType {
  return node.type === "processor" ? "screen" : node.type;
}

function defaultModelId(projectRoot: string): string {
  return path.basename(projectRoot).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "event_model";
}

function nodeSelectorKey(node: GraphSidecarNode): string {
  return JSON.stringify({ type: node.type, selector: node.selector });
}

function generatedNodes(project: EventModelProject): Record<string, GraphSidecarNode> {
  return Object.fromEntries(
    project.nodes.map((node) => [
      node.id,
      {
        type: sourceTypeForNode(node),
        selector: selectorForNode(node)
      }
    ])
  );
}

function semanticNodeType(node: GraphNode): GraphNodeType {
  return node.type === "processor" ? "screen" : node.type;
}

function nodeKey(node: GraphNode): string {
  return nodeSelectorKey({
    type: semanticNodeType(node),
    selector: selectorForNode(node)
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function comparableNode(node: GraphNode): Record<string, unknown> {
  return {
    type: node.type,
    label: node.label,
    storyName: node.storyName,
    sliceTitle: node.sliceTitle,
    sourceName: node.sourceName,
    actors: node.actors,
    screenType: node.screenType,
    fields: node.fields,
    description: node.description,
    given: node.given,
    when: node.when,
    then: node.then
  };
}

function edgeKey(edge: GraphEdge, nodeKeys: Map<string, string>): string {
  return stableJson({
    kind: edge.kind,
    source: nodeKeys.get(edge.source) ?? edge.source,
    target: nodeKeys.get(edge.target) ?? edge.target,
    label: edge.label
  });
}

function comparableEdge(edge: GraphEdge, nodeKeys: Map<string, string>): Record<string, unknown> {
  return {
    kind: edge.kind,
    source: nodeKeys.get(edge.source) ?? edge.source,
    target: nodeKeys.get(edge.target) ?? edge.target,
    label: edge.label
  };
}

function summarize(statuses: Iterable<GraphDiffStatus>): GraphDiffSummary {
  const summary: GraphDiffSummary = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const status of statuses) summary[status] += 1;
  return summary;
}

function cloneProject(project: EventModelProject): EventModelProject {
  return {
    ...project,
    events: project.events.map((event) => ({ ...event })),
    stories: project.stories.map((story) => ({ ...story, slices: [...story.slices] })),
    slices: project.slices.map((slice) => ({
      ...slice,
      screen: { ...slice.screen, actors: [...slice.screen.actors], reads: [...slice.screen.reads], executes: [...slice.screen.executes] },
      commands: slice.commands.map((command) => ({ ...command, produces: [...command.produces] })),
      queries: slice.queries.map((query) => ({ ...query, fromEvents: [...query.fromEvents] })),
      gwt: slice.gwt.map((scenario) => ({
        ...scenario,
        given: [...scenario.given],
        when: [...scenario.when],
        then: [...scenario.then]
      }))
    })),
    nodes: project.nodes.map((node) => ({ ...node })),
    edges: project.edges.map((edge) => ({ ...edge }))
  };
}

function uniqueNodeId(existingIds: Set<string>, id: string): string {
  if (!existingIds.has(id)) {
    existingIds.add(id);
    return id;
  }
  let index = 1;
  let next = `removed:${id}`;
  while (existingIds.has(next)) {
    index += 1;
    next = `removed:${index}:${id}`;
  }
  existingIds.add(next);
  return next;
}

function uniqueEdgeId(existingIds: Set<string>, id: string): string {
  if (!existingIds.has(id)) {
    existingIds.add(id);
    return id;
  }
  let index = 1;
  let next = `removed:${id}`;
  while (existingIds.has(next)) {
    index += 1;
    next = `removed:${index}:${id}`;
  }
  existingIds.add(next);
  return next;
}

function mergeRemovedModelContainers(merged: EventModelProject, base: EventModelProject): void {
  const storyNames = new Set(merged.stories.map((story) => story.name));
  const slicePaths = new Set(merged.slices.map((slice) => slice.path));
  const eventNames = new Set(merged.events.map((event) => event.name));

  for (const story of base.stories) {
    if (storyNames.has(story.name)) continue;
    merged.stories.push({ ...story, slices: [...story.slices] });
    storyNames.add(story.name);
  }

  for (const slice of base.slices) {
    if (slicePaths.has(slice.path)) continue;
    merged.slices.push({
      ...slice,
      screen: { ...slice.screen, actors: [...slice.screen.actors], reads: [...slice.screen.reads], executes: [...slice.screen.executes] },
      commands: slice.commands.map((command) => ({ ...command, produces: [...command.produces] })),
      queries: slice.queries.map((query) => ({ ...query, fromEvents: [...query.fromEvents] })),
      gwt: slice.gwt.map((scenario) => ({
        ...scenario,
        given: [...scenario.given],
        when: [...scenario.when],
        then: [...scenario.then]
      }))
    });
    slicePaths.add(slice.path);
  }

  for (const event of base.events) {
    if (eventNames.has(event.name)) continue;
    merged.events.push({ ...event });
    eventNames.add(event.name);
  }
}

export function buildGraphSidecar(project: EventModelProject, existing?: GraphSidecar): GraphSidecar {
  const generated = generatedNodes(project);
  const generatedSelectorKeys = new Set(Object.values(generated).map(nodeSelectorKey));
  const mergedNodes: Record<string, GraphSidecarNode> = {};

  if (existing) {
    for (const [id, node] of Object.entries(existing.nodes)) {
      mergedNodes[id] = node;
    }
  }

  for (const [id, node] of Object.entries(generated)) {
    const existingEntry = Object.entries(mergedNodes).find(([, candidate]) => nodeSelectorKey(candidate) === nodeSelectorKey(node));
    if (!existingEntry) {
      mergedNodes[id] = node;
    }
  }

  return {
    schemaVersion: 1,
    model: existing?.model ?? {
      id: defaultModelId(project.root),
      name: defaultModelId(project.root)
    },
    sources: {
      events: project.config.paths.eventsFile,
      stories: [`${project.config.paths.storiesDir}/**/*.yaml`],
      slices: [`${project.config.paths.featuresDir}/**/*${project.config.paths.sliceExtension}`]
    },
    nodes: Object.fromEntries(
      Object.entries(mergedNodes).sort(([a], [b]) => {
        const aIsStale = !generatedSelectorKeys.has(nodeSelectorKey(mergedNodes[a]));
        const bIsStale = !generatedSelectorKeys.has(nodeSelectorKey(mergedNodes[b]));
        if (aIsStale !== bIsStale) return aIsStale ? 1 : -1;
        return a.localeCompare(b);
      })
    )
  };
}

export function diffEventModelProjects(base: EventModelProject, target: EventModelProject, labels: { base?: string; target?: string } = {}): GraphDiffResult {
  const merged = cloneProject(target);
  const existingNodeIds = new Set(merged.nodes.map((node) => node.id));
  const existingEdgeIds = new Set(merged.edges.map((edge) => edge.id));
  const baseNodesByKey = new Map(base.nodes.map((node) => [nodeKey(node), node]));
  const targetNodesByKey = new Map(target.nodes.map((node) => [nodeKey(node), node]));
  const baseNodeKeysById = new Map(base.nodes.map((node) => [node.id, nodeKey(node)]));
  const targetNodeKeysById = new Map(target.nodes.map((node) => [node.id, nodeKey(node)]));
  const nodeStatus: Record<string, GraphDiffStatus> = {};
  const mergedNodeIdByBaseId = new Map<string, string>();

  mergeRemovedModelContainers(merged, base);

  for (const targetNode of target.nodes) {
    const key = nodeKey(targetNode);
    const baseNode = baseNodesByKey.get(key);
    if (!baseNode) {
      nodeStatus[targetNode.id] = "added";
      continue;
    }
    nodeStatus[targetNode.id] = stableJson(comparableNode(baseNode)) === stableJson(comparableNode(targetNode)) ? "unchanged" : "changed";
  }

  for (const baseNode of base.nodes) {
    const key = nodeKey(baseNode);
    if (targetNodesByKey.has(key)) continue;
    const id = uniqueNodeId(existingNodeIds, baseNode.id);
    mergedNodeIdByBaseId.set(baseNode.id, id);
    merged.nodes.push({ ...baseNode, id });
    nodeStatus[id] = "removed";
  }

  const baseEdgesByKey = new Map(base.edges.map((edge) => [edgeKey(edge, baseNodeKeysById), edge]));
  const targetEdgesByKey = new Map(target.edges.map((edge) => [edgeKey(edge, targetNodeKeysById), edge]));
  const edgeStatus: Record<string, GraphDiffStatus> = {};

  for (const targetEdge of target.edges) {
    const key = edgeKey(targetEdge, targetNodeKeysById);
    const baseEdge = baseEdgesByKey.get(key);
    if (!baseEdge) {
      edgeStatus[targetEdge.id] = "added";
      continue;
    }
    edgeStatus[targetEdge.id] =
      stableJson(comparableEdge(baseEdge, baseNodeKeysById)) === stableJson(comparableEdge(targetEdge, targetNodeKeysById))
        ? "unchanged"
        : "changed";
  }

  for (const baseEdge of base.edges) {
    const key = edgeKey(baseEdge, baseNodeKeysById);
    if (targetEdgesByKey.has(key)) continue;
    const source = mergedNodeIdByBaseId.get(baseEdge.source) ?? targetNodesByKey.get(baseNodeKeysById.get(baseEdge.source) ?? "")?.id ?? baseEdge.source;
    const targetId = mergedNodeIdByBaseId.get(baseEdge.target) ?? targetNodesByKey.get(baseNodeKeysById.get(baseEdge.target) ?? "")?.id ?? baseEdge.target;
    const id = uniqueEdgeId(existingEdgeIds, baseEdge.id);
    merged.edges.push({ ...baseEdge, id, source, target: targetId });
    edgeStatus[id] = "removed";
  }

  return {
    project: merged,
    diff: {
      base: { label: labels.base ?? "base" },
      target: { label: labels.target ?? "target" },
      nodeStatus,
      edgeStatus,
      summary: {
        nodes: summarize(Object.values(nodeStatus)),
        edges: summarize(Object.values(edgeStatus))
      }
    }
  };
}

export function readGraphSidecar(projectRoot: string): GraphSidecar | undefined {
  const sidecarPath = path.join(projectRoot, ".event-modeling", "graph.json");
  if (!fs.existsSync(sidecarPath)) return undefined;
  return JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as GraphSidecar;
}

export function writeGraphSidecar(project: EventModelProject): WriteGraphResult {
  const sidecarPath = path.join(project.root, ".event-modeling", "graph.json");
  const existing = readGraphSidecar(project.root);
  const next = buildGraphSidecar(project, existing);
  const generated = generatedNodes(project);
  const generatedSelectorKeys = new Set(Object.values(generated).map(nodeSelectorKey));
  const existingSelectorKeys = new Set(Object.values(existing?.nodes ?? {}).map(nodeSelectorKey));
  const added = Object.entries(generated)
    .filter(([, node]) => !existingSelectorKeys.has(nodeSelectorKey(node)))
    .map(([id]) => id);
  const preserved = Object.entries(existing?.nodes ?? {})
    .filter(([, node]) => generatedSelectorKeys.has(nodeSelectorKey(node)))
    .map(([id]) => id);
  const stale = Object.entries(existing?.nodes ?? {})
    .filter(([, node]) => !generatedSelectorKeys.has(nodeSelectorKey(node)))
    .map(([id]) => id);

  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, `${JSON.stringify(next, null, 2)}\n`);

  return {
    path: sidecarPath,
    added,
    preserved,
    stale
  };
}

export function resolveSidecarNode(project: EventModelProject, node: GraphSidecarNode): GraphNode[] {
  return project.nodes.filter((candidate) => {
    if (node.type === "screen" && candidate.type !== "screen" && candidate.type !== "processor") return false;
    if (node.type !== "screen" && candidate.type !== node.type) return false;

    const selector = selectorForNode(candidate);
    return Object.entries(node.selector).every(([key, value]) => selector[key] === value);
  });
}
