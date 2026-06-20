import fs from "node:fs";
import path from "node:path";
import type { EventModelProject, GraphNode, GraphNodeType } from "@emviz/parser";

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
