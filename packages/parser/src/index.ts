import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import YAML from "yaml";
import { commandId, edgeId, eventId, queryId, screenId, sliceId, storyId } from "./id.js";
import { findProjectRoot, readConfig } from "./config.js";
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

export * from "./config.js";
export * from "./id.js";
export * from "./types.js";

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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\/+/, "");
}

function rel(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join(path.posix.sep);
}

function resolveProjectPath(projectRoot: string, relativePath: string): string {
  return path.resolve(projectRoot, relativePath);
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

function parseEvents(projectRoot: string, eventsPath: string): EventRegistryEntry[] {
  const absolutePath = resolveProjectPath(projectRoot, eventsPath);
  return parseEventsText(rel(projectRoot, absolutePath), fs.readFileSync(absolutePath, "utf8"));
}

function parseStoryText(storyPath: string, content: string): StoryModel {
  const raw = YAML.parse(content) as RawStory | null;
  return {
    name: typeof raw?.name === "string" ? raw.name : path.basename(storyPath, ".yaml"),
    description: typeof raw?.description === "string" ? raw.description : "",
    path: storyPath,
    slices: asStringArray(raw?.slices).map(normalizeRelativePath)
  };
}

function parseStories(projectRoot: string, storiesDir: string): StoryModel[] {
  const pattern = path.posix.join(storiesDir, "*.yaml");
  return fg
    .sync(pattern, { cwd: projectRoot, onlyFiles: true, ignore: ["node_modules/**", ".git/**", "dist/**"] })
    .sort()
    .map((storyPath) => parseStoryText(storyPath, fs.readFileSync(resolveProjectPath(projectRoot, storyPath), "utf8")));
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
    title: typeof raw?.slice === "string" ? raw.slice : path.basename(slicePath),
    path: slicePath,
    storyName: storyBySlice.get(slicePath),
    screen: parseScreen(raw?.screen),
    commands: parseCommands(raw?.commands),
    queries: parseQueries(raw?.queries),
    gwt: parseGwt(raw?.gwt),
    raw: content
  };
}

function parseSlices(projectRoot: string, stories: StoryModel[], sliceGlob: string): SliceModel[] {
  const storyBySlice = new Map<string, string>();
  for (const story of stories) {
    for (const slicePath of story.slices) {
      storyBySlice.set(slicePath, story.name);
    }
  }

  const storySlices = stories.flatMap((story) => story.slices);
  const discoveredSlices = fg.sync(sliceGlob, {
    cwd: projectRoot,
    onlyFiles: true,
    ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"]
  });

  const paths = [...new Set([...storySlices, ...discoveredSlices])].sort();
  return paths
    .filter((slicePath) => fs.existsSync(resolveProjectPath(projectRoot, slicePath)))
    .map((slicePath) => parseSliceText(slicePath, fs.readFileSync(resolveProjectPath(projectRoot, slicePath), "utf8"), storyBySlice));
}

function buildGraph(project: Omit<EventModelProject, "nodes" | "edges">): Pick<EventModelProject, "nodes" | "edges"> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const eventNodeIds = new Map<string, string>();

  for (const story of project.stories) {
    nodes.push({
      id: storyId(story.name),
      type: "story",
      label: story.name,
      sourcePath: story.path,
      description: story.description
    });
  }

  for (const event of project.events) {
    const id = eventId(event.name);
    eventNodeIds.set(event.name, id);
    nodes.push({
      id,
      type: "event",
      label: event.name,
      sourceName: event.name,
      sourcePath: event.sourcePath,
      fields: event.fields,
      description: event.description
    });
  }

  for (const slice of project.slices) {
    const currentSliceId = sliceId(slice.title);
    const currentScreenId = screenId(slice.title, slice.screen.name);
    const screenType = slice.screen.type === "system" ? "processor" : "screen";

    nodes.push({
      id: currentSliceId,
      type: "slice",
      label: slice.title,
      storyName: slice.storyName,
      sliceTitle: slice.title,
      sourcePath: slice.path,
      raw: slice.raw
    });

    if (slice.storyName) {
      edges.push({
        id: edgeId("story-slice", storyId(slice.storyName), currentSliceId),
        kind: "story-slice",
        source: storyId(slice.storyName),
        target: currentSliceId
      });
    }

    nodes.push({
      id: currentScreenId,
      type: screenType,
      label: slice.screen.name ?? (slice.screen.type === "system" ? "Processor" : "Screen"),
      storyName: slice.storyName,
      sliceTitle: slice.title,
      sourcePath: slice.path,
      actors: slice.screen.actors,
      screenType: slice.screen.type,
      raw: slice.raw
    });
    edges.push({
      id: edgeId("slice-screen", currentSliceId, currentScreenId),
      kind: "slice-screen",
      source: currentSliceId,
      target: currentScreenId
    });

    for (const query of slice.queries) {
      const currentQueryId = queryId(query.name);
      nodes.push({
        id: currentQueryId,
        type: "query",
        label: query.name,
        storyName: slice.storyName,
        sliceTitle: slice.title,
        sourceName: query.name,
        sourcePath: slice.path,
        fields: query.fields,
        raw: slice.raw
      });
      if (slice.screen.reads.includes(query.name)) {
        edges.push({
          id: edgeId("query-screen", currentQueryId, currentScreenId),
          kind: "query-screen",
          source: currentQueryId,
          target: currentScreenId
        });
      }
      for (const eventName of query.fromEvents) {
        const currentEventId = eventNodeIds.get(eventName) ?? eventId(eventName);
        edges.push({
          id: edgeId("event-query", currentEventId, currentQueryId),
          kind: "event-query",
          source: currentEventId,
          target: currentQueryId,
          label: eventName
        });
      }
    }

    for (const command of slice.commands) {
      const currentCommandId = commandId(command.name);
      nodes.push({
        id: currentCommandId,
        type: "command",
        label: command.name,
        storyName: slice.storyName,
        sliceTitle: slice.title,
        sourceName: command.name,
        sourcePath: slice.path,
        fields: command.fields,
        raw: slice.raw
      });
      if (slice.screen.executes.includes(command.name)) {
        edges.push({
          id: edgeId("screen-command", currentScreenId, currentCommandId),
          kind: "screen-command",
          source: currentScreenId,
          target: currentCommandId
        });
      }
      for (const eventName of command.produces) {
        const currentEventId = eventNodeIds.get(eventName) ?? eventId(eventName);
        edges.push({
          id: edgeId("command-event", currentCommandId, currentEventId),
          kind: "command-event",
          source: currentCommandId,
          target: currentEventId,
          label: eventName
        });
      }
    }
  }

  return { nodes, edges };
}

export function loadEventModelProject(startDir: string): EventModelProject {
  const root = findProjectRoot(startDir);
  const config = readConfig(root);
  const events = parseEvents(root, config.paths.eventsFile);
  const stories = parseStories(root, config.paths.storiesDir);
  const slices = parseSlices(root, stories, path.posix.join(config.paths.featuresDir, `**/*${config.paths.sliceExtension}`));
  const projectWithoutGraph = { root, config, events, stories, slices };
  const graph = buildGraph(projectWithoutGraph);

  return {
    ...projectWithoutGraph,
    ...graph
  };
}

export { loadEventModelProjectFromFiles } from "./browser.js";
export type { InMemoryEventModelFile, InMemoryLoadOptions } from "./browser.js";
