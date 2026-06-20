import YAML from "yaml";
import { commandId, edgeId, eventId, queryId, screenId, sliceId, storyId } from "./id.js";
import type {
  CommandModel,
  EventModelProject,
  EventRegistryEntry,
  GraphEdge,
  GraphNode,
  GwtScenario,
  QueryModel,
  ScreenModel,
  SliceModel,
  StoryModel
} from "./types.js";

export type InMemoryEventModelFile = {
  path: string;
  content: string;
};

export type InMemoryLoadOptions = {
  root?: string;
};

type RawEventsFile = {
  events?: Record<string, { fields?: unknown; description?: unknown }>;
} & Record<string, unknown>;

type RawStory = {
  name?: unknown;
  description?: unknown;
  slices?: unknown;
};

type RawSlice = {
  slice?: unknown;
  screen?: {
    type?: unknown;
    name?: unknown;
    actors?: unknown;
    reads?: unknown;
    executes?: unknown;
  };
  commands?: unknown;
  queries?: unknown;
  gwt?: unknown;
};

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function basename(filePath: string, extension = ""): string {
  const name = normalizeRelativePath(filePath).split("/").at(-1) ?? filePath;
  return extension && name.endsWith(extension) ? name.slice(0, -extension.length) : name;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseEventsText(sourcePath: string, content: string): EventRegistryEntry[] {
  const raw = YAML.parse(content) as RawEventsFile | null;
  const eventMap =
    raw?.events && typeof raw.events === "object"
      ? raw.events
      : (raw as Record<string, { fields?: unknown; description?: unknown }> | null) ?? {};

  return Object.entries(eventMap).map(([name, entry]) => ({
    name,
    fields: typeof entry?.fields === "string" ? entry.fields : undefined,
    description: typeof entry?.description === "string" ? entry.description : undefined,
    sourcePath
  }));
}

function parseStoryText(storyPath: string, content: string): StoryModel {
  const raw = YAML.parse(content) as RawStory | null;
  return {
    name: typeof raw?.name === "string" ? raw.name : basename(storyPath, ".yaml"),
    description: typeof raw?.description === "string" ? raw.description : "",
    path: storyPath,
    slices: asStringArray(raw?.slices).map(normalizeRelativePath)
  };
}

function parseCommands(value: unknown): CommandModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      fields: typeof item.fields === "string" ? item.fields : undefined,
      notes: typeof item.notes === "string" ? item.notes : undefined,
      produces: asStringArray(item.produces)
    }));
}

function parseQueries(value: unknown): QueryModel[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      fields: typeof item.fields === "string" ? item.fields : undefined,
      notes: typeof item.notes === "string" ? item.notes : undefined,
      fromEvents: asStringArray(item.from_events)
    }));
}

function parseGwt(value: unknown): GwtScenario[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      given: Array.isArray(item.given) ? item.given : [],
      when: Array.isArray(item.when) ? item.when : [],
      then: Array.isArray(item.then) ? item.then : []
    }));
}

function parseScreen(raw: RawSlice["screen"]): ScreenModel {
  return {
    type: raw?.type === "system" ? "system" : "user",
    name: typeof raw?.name === "string" ? raw.name : undefined,
    actors: asStringArray(raw?.actors),
    reads: asStringArray(raw?.reads),
    executes: asStringArray(raw?.executes)
  };
}

function parseSliceText(slicePath: string, content: string, storyBySlice: Map<string, string>): SliceModel {
  const raw = YAML.parse(content) as RawSlice | null;
  return {
    title: typeof raw?.slice === "string" ? raw.slice : basename(slicePath),
    path: slicePath,
    storyName: storyBySlice.get(slicePath),
    screen: parseScreen(raw?.screen),
    commands: parseCommands(raw?.commands),
    queries: parseQueries(raw?.queries),
    gwt: parseGwt(raw?.gwt),
    raw: content
  };
}

function buildGraph(project: Omit<EventModelProject, "nodes" | "edges">): Pick<EventModelProject, "nodes" | "edges"> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const eventNodeIds = new Map<string, string>();

  for (const story of project.stories) {
    nodes.push({ id: storyId(story.name), type: "story", label: story.name, sourcePath: story.path, description: story.description });
  }

  for (const event of project.events) {
    const id = eventId(event.name);
    eventNodeIds.set(event.name, id);
    nodes.push({ id, type: "event", label: event.name, sourceName: event.name, sourcePath: event.sourcePath, fields: event.fields, description: event.description });
  }

  for (const slice of project.slices) {
    const currentSliceId = sliceId(slice.title);
    const currentScreenId = screenId(slice.title, slice.screen.name);
    const screenType = slice.screen.type === "system" ? "processor" : "screen";
    nodes.push({ id: currentSliceId, type: "slice", label: slice.title, storyName: slice.storyName, sliceTitle: slice.title, sourcePath: slice.path, raw: slice.raw });
    if (slice.storyName) edges.push({ id: edgeId("story-slice", storyId(slice.storyName), currentSliceId), kind: "story-slice", source: storyId(slice.storyName), target: currentSliceId });
    nodes.push({ id: currentScreenId, type: screenType, label: slice.screen.name ?? (slice.screen.type === "system" ? "Processor" : "Screen"), storyName: slice.storyName, sliceTitle: slice.title, sourcePath: slice.path, actors: slice.screen.actors, screenType: slice.screen.type, raw: slice.raw });
    edges.push({ id: edgeId("slice-screen", currentSliceId, currentScreenId), kind: "slice-screen", source: currentSliceId, target: currentScreenId });

    for (const query of slice.queries) {
      const currentQueryId = queryId(query.name);
      nodes.push({ id: currentQueryId, type: "query", label: query.name, storyName: slice.storyName, sliceTitle: slice.title, sourceName: query.name, sourcePath: slice.path, fields: query.fields, raw: slice.raw });
      if (slice.screen.reads.includes(query.name)) edges.push({ id: edgeId("query-screen", currentQueryId, currentScreenId), kind: "query-screen", source: currentQueryId, target: currentScreenId });
      for (const eventName of query.fromEvents) {
        const currentEventId = eventNodeIds.get(eventName) ?? eventId(eventName);
        edges.push({ id: edgeId("event-query", currentEventId, currentQueryId), kind: "event-query", source: currentEventId, target: currentQueryId, label: eventName });
      }
    }

    for (const command of slice.commands) {
      const currentCommandId = commandId(command.name);
      nodes.push({ id: currentCommandId, type: "command", label: command.name, storyName: slice.storyName, sliceTitle: slice.title, sourceName: command.name, sourcePath: slice.path, fields: command.fields, raw: slice.raw });
      if (slice.screen.executes.includes(command.name)) edges.push({ id: edgeId("screen-command", currentScreenId, currentCommandId), kind: "screen-command", source: currentScreenId, target: currentCommandId });
      for (const eventName of command.produces) {
        const currentEventId = eventNodeIds.get(eventName) ?? eventId(eventName);
        edges.push({ id: edgeId("command-event", currentCommandId, currentEventId), kind: "command-event", source: currentCommandId, target: currentEventId, label: eventName });
      }
    }
  }

  return { nodes, edges };
}

export function loadEventModelProjectFromFiles(files: InMemoryEventModelFile[], options: InMemoryLoadOptions = {}): EventModelProject {
  const normalizedFiles = new Map(files.map((file) => [normalizeRelativePath(file.path), file.content]));
  const configContent = normalizedFiles.get(".event-modeling/config.yaml");
  const configRaw = configContent ? (YAML.parse(configContent) as { language?: string; paths?: Record<string, string> } | null) : null;
  const eventModelDir = configRaw?.paths?.event_model_dir ?? "event-model";
  const featuresDir = configRaw?.paths?.features_dir ?? "event-model/features";
  const sliceExtension = configRaw?.paths?.slice_extension ?? ".slice.yaml";
  const eventsFile = configRaw?.paths?.events_file ?? `${eventModelDir}/events.yaml`;
  const storiesDir = configRaw?.paths?.stories_dir ?? `${eventModelDir}/stories`;
  const eventsContent = normalizedFiles.get(eventsFile);
  if (!eventsContent) throw new Error(`Missing events file: ${eventsFile}`);

  const events = parseEventsText(eventsFile, eventsContent);
  const stories = [...normalizedFiles.entries()]
    .filter(([filePath]) => filePath.startsWith(`${storiesDir}/`) && filePath.endsWith(".yaml"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, content]) => parseStoryText(filePath, content));
  const storyBySlice = new Map<string, string>();
  for (const story of stories) for (const slicePath of story.slices) storyBySlice.set(normalizeRelativePath(slicePath), story.name);
  const storySlicePaths = stories.flatMap((story) => story.slices.map(normalizeRelativePath));
  const discoveredSlicePaths = [...normalizedFiles.keys()].filter((filePath) => filePath.startsWith(`${featuresDir}/`) && filePath.endsWith(sliceExtension));
  const slicePaths = [...new Set([...storySlicePaths, ...discoveredSlicePaths])].sort();
  const slices = slicePaths.filter((filePath) => normalizedFiles.has(filePath)).map((filePath) => parseSliceText(filePath, normalizedFiles.get(filePath) ?? "", storyBySlice));
  const projectWithoutGraph = {
    root: options.root ?? "browser-import",
    config: {
      language: configRaw?.language,
      paths: { eventModelDir, featuresDir, sliceExtension, eventsFile, storiesDir }
    },
    events,
    stories,
    slices
  };
  const graph = buildGraph(projectWithoutGraph);
  return { ...projectWithoutGraph, ...graph };
}
