import YAML from "yaml";
import { parseScreenLink } from "./screen-link.js";
export { safeScreenUrl } from "./screen-link.js";
import { documentIssues, parseFeatureFiles } from "./features.js";
import { loadActors, parseActorReferences } from "./actors.js";
export { actorColor } from "./actors.js";
import { buildGraph } from "./graph.js";
import type {
  CommandModel,
  EventModelProject,
  EventRegistryEntry,
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
    url?: unknown;
    actors?: unknown;
    reads?: unknown;
    executes?: unknown;
  };
  commands?: unknown;
  queries?: unknown;
  gwt?: unknown;
};

function normalizeRelativePath(filePath: string): string {
  const parts: string[] = [];
  for (const part of filePath.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
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
    ...parseActorReferences(raw?.actors),
    ...parseScreenLink(raw).link,
    reads: asStringArray(raw?.reads),
    executes: asStringArray(raw?.executes)
  };
}

function parseSliceText(slicePath: string, content: string, storyBySlice: Map<string, StoryModel>): SliceModel {
  const raw = YAML.parse(content) as RawSlice | null;
  return {
    title: typeof raw?.slice === "string" ? raw.slice : basename(slicePath),
    path: slicePath,
    storyName: storyBySlice.get(slicePath)?.name,
    storyId: storyBySlice.get(slicePath)?.id,
    screen: parseScreen(raw?.screen),
    commands: parseCommands(raw?.commands),
    queries: parseQueries(raw?.queries),
    gwt: parseGwt(raw?.gwt),
    raw: content
  };
}

export function loadEventModelProjectFromFiles(files: InMemoryEventModelFile[], options: InMemoryLoadOptions = {}): EventModelProject {
  const normalizedFiles = new Map(files.map((file) => [normalizeRelativePath(file.path), file.content]));
  const configContent = normalizedFiles.get(".event-modeling/config.yaml");
  const configRaw = configContent ? (YAML.parse(configContent) as { language?: string; paths?: Record<string, string> } | null) : null;
  const eventModelDir = configRaw?.paths?.event_model_dir ?? "event-model";
  const featuresDir = configRaw?.paths?.features_dir ?? "event-model/features";
  const sliceExtension = configRaw?.paths?.slice_extension ?? ".slice.yaml";
  const eventsFile = configRaw?.paths?.events_file ?? `${eventModelDir}/events.yaml`;
  const actorsFile = normalizeRelativePath(configRaw?.paths?.actors_file ?? `${eventModelDir}/actors.yaml`);
  const storiesDir = configRaw?.paths?.stories_dir ?? `${eventModelDir}/stories`;
  const eventsContent = normalizedFiles.get(eventsFile);
  if (eventsContent === undefined) throw new Error(`Missing events file: ${eventsFile}`);

  const events = parseEventsText(eventsFile, eventsContent);
  const featureData = parseFeatureFiles([...normalizedFiles.entries()]
    .filter(([filePath]) => (featuresDir === "" || filePath.startsWith(`${featuresDir}/`)) && filePath.endsWith(".feature.yaml"))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, content]) => ({ path, content })));
  const stories = [...normalizedFiles.entries()]
    .filter(([filePath]) => filePath.split("/").slice(0, -1).join("/") === storiesDir && filePath.endsWith(".yaml"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, content]) => parseStoryText(filePath, content));
  stories.push(...featureData.stories);
  const storyBySlice = new Map<string, StoryModel>();
  for (const story of stories) for (const slicePath of story.slices) storyBySlice.set(normalizeRelativePath(slicePath), story);
  const storySlicePaths = stories.flatMap((story) => story.slices.map(normalizeRelativePath));
  const discoveredSlicePaths = [...normalizedFiles.keys()].filter((filePath) => (featuresDir === "" || filePath.startsWith(`${featuresDir}/`)) && filePath.endsWith(sliceExtension));
  const slicePaths = [...new Set([...storySlicePaths, ...discoveredSlicePaths])].sort();
  const slices = slicePaths.filter((filePath) => normalizedFiles.has(filePath)).map((filePath) => parseSliceText(filePath, normalizedFiles.get(filePath) ?? "", storyBySlice));
  const actorData = loadActors(normalizedFiles.get(actorsFile), actorsFile, slices);
  const sourceDocuments = [
    { path: eventsFile, kind: "events" },
    ...stories.filter((story) => !story.id).map((story) => ({ path: story.path, kind: "story" })),
    ...slices.map((slice) => ({ path: slice.path, kind: "slice" })),
    ...(normalizedFiles.has(actorsFile) ? [{ path: actorsFile, kind: "actors" }] : [])
  ];
  const modelIssues = [
    ...featureData.modelIssues,
    ...sourceDocuments.flatMap((source) => documentIssues(normalizedFiles.get(source.path) ?? "", source.path, source.kind))
  ];
  const projectWithoutGraph = {
    root: options.root ?? "browser-import",
    config: {
      language: configRaw?.language,
      paths: { eventModelDir, featuresDir, sliceExtension, eventsFile, actorsFile, storiesDir }
    },
    events,
    stories,
    timelines: featureData.timelines,
    modelIssues,
    slices,
    ...actorData
  };
  const graph = buildGraph(projectWithoutGraph);
  return { ...projectWithoutGraph, ...graph };
}
