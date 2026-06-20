export type ScreenType = "user" | "system";

export type ModelConfig = {
  language?: string;
  paths: {
    eventModelDir: string;
    featuresDir: string;
    sliceExtension: string;
    eventsFile: string;
    storiesDir: string;
  };
};

export type EventRegistryEntry = {
  name: string;
  fields?: string;
  description?: string;
  sourcePath: string;
};

export type StoryModel = {
  name: string;
  description: string;
  path: string;
  slices: string[];
};

export type ScreenModel = {
  type: ScreenType;
  name?: string;
  actors: string[];
  reads: string[];
  executes: string[];
};

export type CommandModel = {
  name: string;
  fields?: string;
  notes?: string;
  produces: string[];
};

export type QueryModel = {
  name: string;
  fields?: string;
  notes?: string;
  fromEvents: string[];
};

export type GwtItemRef = {
  name?: string;
  type?: string;
  fields?: string;
};

export type GwtScenario = {
  name?: string;
  description?: string;
  given: GwtItemRef[];
  when: GwtItemRef[];
  then: GwtItemRef[];
};

export type SliceModel = {
  title: string;
  path: string;
  storyName?: string;
  screen: ScreenModel;
  commands: CommandModel[];
  queries: QueryModel[];
  gwt: GwtScenario[];
  raw: string;
};

export type GraphNodeType =
  | "story"
  | "slice"
  | "screen"
  | "processor"
  | "command"
  | "event"
  | "query";

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  storyName?: string;
  sliceTitle?: string;
  sourcePath?: string;
  sourceName?: string;
  actors?: string[];
  screenType?: ScreenType;
  fields?: string;
  description?: string;
  raw?: string;
};

export type GraphEdgeKind =
  | "story-slice"
  | "slice-screen"
  | "query-screen"
  | "screen-command"
  | "command-event"
  | "event-query";

export type GraphEdge = {
  id: string;
  kind: GraphEdgeKind;
  source: string;
  target: string;
  label?: string;
};

export type EventModelProject = {
  root: string;
  config: ModelConfig;
  events: EventRegistryEntry[];
  stories: StoryModel[];
  slices: SliceModel[];
  nodes: GraphNode[];
  edges: GraphEdge[];
};

