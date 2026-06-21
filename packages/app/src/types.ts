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
  sliceTitle?: string;
  sourcePath?: string;
  sourceName?: string;
  actors?: string[];
  screenType?: "user" | "system";
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
    storiesDir: string;
  };
};

export type ProjectSlice = {
  title: string;
  path: string;
  storyName?: string;
};

export type EventModelProject = {
  root: string;
  config: ProjectConfig;
  events: ProjectEvent[];
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
