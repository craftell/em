export type ActorDefinition = { id: string; name: string; color: string };

export type GraphNodeType = "story" | "slice" | "screen" | "processor" | "command" | "event" | "query" | "gwt";

export type GwtItemRef = {
  name?: string;
  type?: string;
  fields?: string;
};

export type ProjectNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  storyName?: string;
  storyId?: string;
  sliceTitle?: string;
  sourcePath?: string;
  sourceName?: string;
  actors?: string[];
  actorDefinitions?: ActorDefinition[];
  screenType?: "user" | "system";
  url?: string;
  fields?: string;
  description?: string;
  given?: GwtItemRef[];
  when?: GwtItemRef[];
  then?: GwtItemRef[];
  raw?: string;
};

export type ProjectEdge = {
  id: string;
  kind: string;
  source: string;
  target: string;
  label?: string;
};

export type FieldFlow = {
  sourceFieldNames: string[];
  targetFieldNames: string[];
  sharedFieldNames: string[];
  derivedFieldNames: string[];
  visibleFieldNames: string[];
  remainingCount: number;
  sourceMissingFields: boolean;
  targetMissingFields: boolean;
};

export type ProjectStory = {
  id?: string;
  localId?: string;
  featureName?: string;
  name: string;
  description: string;
  path: string;
  slices: string[];
};

export type ProjectEvent = {
  name: string;
  fields?: string;
  description?: string;
  sourcePath: string;
};

export type ProjectConfig = {
  language?: string;
  paths: {
    eventModelDir: string;
    featuresDir: string;
    sliceExtension: string;
    eventsFile: string;
    actorsFile?: string;
    storiesDir: string;
  };
};

export type ProjectSlice = {
  storyId?: string;
  title: string;
  path: string;
  storyName?: string;
};

export type TimelineModel = {
  id: string;
  name: string;
  path: string;
  steps: { id: string; storyId: string; after: string[] }[];
};

export type EventModelProject = {
  timelines?: TimelineModel[];
  modelIssues?: { check: string; message: string; path: string }[];
  root: string;
  config: ProjectConfig;
  events: ProjectEvent[];
  actors?: ActorDefinition[];
  stories: ProjectStory[];
  slices: ProjectSlice[];
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  graphSidecar?: {
    model?: {
      id?: string;
      name?: string;
    };
    nodes?: Record<string, unknown>;
  };
};

export type ValidationFinding = {
  id: string;
  severity: "error" | "warning" | "info";
  check: string;
  message: string;
  path?: string;
  nodeId?: string;
};

export type ValidationReport = {
  errors: number;
  warnings: number;
  findings: ValidationFinding[];
};

export type GraphDiffStatus = "added" | "removed" | "changed" | "unchanged";

export type GraphDiffSummary = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
};

export type GraphDiff = {
  previousTimelines?: TimelineModel[];
  timelinesChanged?: boolean;
  base: {
    label: string;
  };
  target: {
    label: string;
  };
  previousNodes?: Record<string, ProjectNode>;
  previousEdges?: Record<string, ProjectEdge>;
  previousGwtNodes?: Record<string, ProjectNode>;
  nodeStatus: Record<string, GraphDiffStatus>;
  edgeStatus: Record<string, GraphDiffStatus>;
  summary: {
    nodes: GraphDiffSummary;
    edges: GraphDiffSummary;
  };
};
