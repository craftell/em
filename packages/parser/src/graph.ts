import { commandId, edgeId, eventId, gwtId, queryId, screenId, sliceId, storyId } from "./id.js";
import type { EventModelProject, GraphEdge, GraphNode } from "./types.js";

type Model = Omit<EventModelProject, "nodes" | "edges">;

// Keep existing handles when unambiguous. For collisions, use the exact source
// identity, not a lossy slug or an order-dependent counter. Include missing event
// references so they cannot accidentally resolve to a differently named event.
function graphIds(project: Model) {
  const identities = new Map<string, Set<string>>();
  const register = (base: string, identity: string[]) => {
    const keys = identities.get(base) ?? new Set<string>();
    keys.add(JSON.stringify(identity));
    identities.set(base, keys);
  };
  for (const story of project.stories) register(storyId(story.path), [story.path]);
  for (const event of project.events) register(eventId(event.name), [event.name]);
  for (const slice of project.slices) {
    register(sliceId(slice.path), [slice.path]);
    register(screenId(slice.path), [slice.path]);
    slice.commands.forEach((command, index) => {
      register(commandId(command.name), localIdentity(slice.path, slice.commands, index));
      for (const name of command.produces) register(eventId(name), [name]);
    });
    slice.queries.forEach((query, index) => {
      register(queryId(query.name), localIdentity(slice.path, slice.queries, index));
      for (const name of query.fromEvents) register(eventId(name), [name]);
    });
    slice.gwt.forEach((scenario, index) => {
      register(gwtId(slice.path, index, scenario.name), localIdentity(slice.path, slice.gwt, index));
    });
  }
  return (base: string, identity: string[]) => identities.get(base)!.size === 1
    ? base
    : `${base}~${encodeURIComponent(JSON.stringify(identity))}`;
}

function localIdentity(sourcePath: string, items: { name?: string }[], index: number): string[] {
  const name = items[index].name;
  const occurrence = items.slice(0, index).filter((item) => item.name === name).length;
  return [sourcePath, name ?? "", String(occurrence)];
}

export function buildGraph(project: Model): Pick<EventModelProject, "nodes" | "edges"> {
  const nodes: GraphNode[] = [];
  const edges = new Map<string, GraphEdge>();
  const id = graphIds(project);
  const eventNodeId = (name: string) => id(eventId(name), [name]);
  const storyIdsBySlicePath = new Map<string, string[]>();
  const connect = (kind: GraphEdge["kind"], source: string, target: string, label?: string) => {
    const key = edgeId(kind, source, target);
    edges.set(key, { id: key, kind, source, target, ...(label === undefined ? {} : { label }) });
  };

  for (const story of project.stories) {
    const currentId = id(storyId(story.path), [story.path]);
    for (const slicePath of new Set(story.slices)) {
      storyIdsBySlicePath.set(slicePath, [...(storyIdsBySlicePath.get(slicePath) ?? []), currentId]);
    }
    nodes.push({ id: currentId, type: "story", label: story.name, sourcePath: story.path, description: story.description });
  }
  for (const event of project.events) {
    nodes.push({ id: eventNodeId(event.name), type: "event", label: event.name, sourceName: event.name, sourcePath: event.sourcePath, fields: event.fields, description: event.description });
  }
  for (const slice of project.slices) {
    const currentSliceId = id(sliceId(slice.path), [slice.path]);
    const currentScreenId = id(screenId(slice.path), [slice.path]);
    const shared = { storyName: slice.storyName, sliceTitle: slice.title, sourcePath: slice.path, raw: slice.raw };
    nodes.push({ ...shared, id: currentSliceId, type: "slice", label: slice.title });
    for (const story of storyIdsBySlicePath.get(slice.path) ?? []) {
      connect("story-slice", story, currentSliceId);
    }
    nodes.push({
      ...shared,
      id: currentScreenId,
      type: slice.screen.type === "system" ? "processor" : "screen",
      label: slice.screen.name ?? (slice.screen.type === "system" ? "Processor" : "Screen"),
      actors: slice.screen.actors,
      screenType: slice.screen.type
    });
    connect("slice-screen", currentSliceId, currentScreenId);

    slice.queries.forEach((query, index) => {
      const currentId = id(queryId(query.name), localIdentity(slice.path, slice.queries, index));
      nodes.push({ ...shared, id: currentId, type: "query", label: query.name, sourceName: query.name, fields: query.fields });
      if (slice.screen.reads.includes(query.name)) connect("query-screen", currentId, currentScreenId);
      for (const name of query.fromEvents) connect("event-query", eventNodeId(name), currentId, name);
    });
    slice.commands.forEach((command, index) => {
      const currentId = id(commandId(command.name), localIdentity(slice.path, slice.commands, index));
      nodes.push({ ...shared, id: currentId, type: "command", label: command.name, sourceName: command.name, fields: command.fields });
      if (slice.screen.executes.includes(command.name)) connect("screen-command", currentScreenId, currentId);
      for (const name of command.produces) connect("command-event", currentId, eventNodeId(name), name);
    });
    // GWT references describe test scenarios. They never create graph edges.
    slice.gwt.forEach((scenario, index) => {
      nodes.push({
        ...shared,
        id: id(gwtId(slice.path, index, scenario.name), localIdentity(slice.path, slice.gwt, index)),
        type: "gwt",
        label: scenario.name ?? `Case ${index + 1}`,
        sourceName: scenario.name,
        description: scenario.description,
        given: scenario.given,
        when: scenario.when,
        then: scenario.then
      });
    });
  }
  return { nodes, edges: [...edges.values()] };
}
