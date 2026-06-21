import { MarkerType, type Edge, type Node, Position } from "@xyflow/react";
import type { EventModelProject, ProjectNode } from "./types";

const STORY_X = 180;
const STORY_Y = 80;
const STORY_GAP_Y = 80;
const MIN_SLICE_WIDTH = 430;
const MIN_SLICE_HEIGHT = 390;
const SLICE_GAP_X = 130;
const NODE_WIDTH = 178;
const NODE_HEIGHT = 92;
const GWT_WIDTH = 300;
const GWT_HEIGHT = 170;
const ROW_GAP_X = 18;
const MAIN_BAND_GAP_X = 48;
const SLICE_PADDING_X = 30;
const STORY_HEADER_HEIGHT = 92;
const STORY_PADDING_BOTTOM = 38;
const SCREEN_Y = 42;
const MAIN_ROW_Y = 154;
const EVENT_ROW_Y = 278;
const GWT_ROW_Y = 408;

type NodeData = {
  projectNode: ProjectNode;
  selected: boolean;
  connected: boolean;
};

function edgeColor(kind: string): string {
  if (kind === "slice-screen" || kind === "story-slice") return "#cbd5e1";
  return "#64748b";
}

function nodeDefaults(node: ProjectNode) {
  if (node.type === "event") {
    return {
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    };
  }
  return {
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top
  };
}

function storyIndex(project: EventModelProject): Map<string, number> {
  return new Map(project.stories.map((story, index) => [story.name, index]));
}

function sliceIndex(project: EventModelProject): Map<string, number> {
  const byPath = new Map(project.slices.map((slice) => [slice.path, slice.title]));
  const indexes = new Map<string, number>();

  for (const story of project.stories) {
    story.slices.forEach((slicePath, index) => {
      const title = byPath.get(slicePath);
      if (title) indexes.set(title, index);
    });
  }

  return indexes;
}

type SliceMetrics = {
  width: number;
  height: number;
  queryIds: string[];
  commandIds: string[];
  eventIds: string[];
  gwtIds: string[];
};

type StoryLayout = {
  y: number;
  width: number;
  height: number;
};

function rowWidth(count: number, nodeWidth: number): number {
  return count === 0 ? 0 : count * nodeWidth + (count - 1) * ROW_GAP_X;
}

function sliceNodes(project: EventModelProject, sliceTitle: string, type: ProjectNode["type"]): ProjectNode[] {
  return project.nodes.filter((node) => node.sliceTitle === sliceTitle && node.type === type);
}

function eventNodesForSlice(project: EventModelProject, nodeById: Map<string, ProjectNode>, sliceTitle: string): ProjectNode[] {
  const eventIds = new Set(
    project.edges
      .filter((edge) => edge.kind === "command-event" && nodeById.get(edge.source)?.sliceTitle === sliceTitle)
      .map((edge) => edge.target)
  );

  return [...eventIds].map((id) => nodeById.get(id)).filter((node): node is ProjectNode => Boolean(node));
}

function buildSliceMetrics(project: EventModelProject, nodeById: Map<string, ProjectNode>): Map<string, SliceMetrics> {
  return new Map(
    project.slices.map((slice) => {
      const queries = sliceNodes(project, slice.title, "query");
      const commands = sliceNodes(project, slice.title, "command");
      const events = eventNodesForSlice(project, nodeById, slice.title);
      const gwts = sliceNodes(project, slice.title, "gwt");
      const queryBandWidth = rowWidth(queries.length, NODE_WIDTH);
      const commandBandWidth = rowWidth(commands.length, NODE_WIDTH);
      const mainRowWidth = queryBandWidth + commandBandWidth + (queryBandWidth > 0 && commandBandWidth > 0 ? MAIN_BAND_GAP_X : 0);
      const eventRowWidth = rowWidth(events.length, NODE_WIDTH);
      const gwtRowWidth = rowWidth(gwts.length, GWT_WIDTH);
      const width = Math.max(MIN_SLICE_WIDTH, mainRowWidth + SLICE_PADDING_X * 2, eventRowWidth + SLICE_PADDING_X * 2, gwtRowWidth + SLICE_PADDING_X * 2);
      const height = gwts.length > 0 ? GWT_ROW_Y + GWT_HEIGHT + 36 : MIN_SLICE_HEIGHT;

      return [
        slice.title,
        {
          width,
          height,
          queryIds: queries.map((node) => node.id),
          commandIds: commands.map((node) => node.id),
          eventIds: events.map((node) => node.id),
          gwtIds: gwts.map((node) => node.id)
        }
      ];
    })
  );
}

function buildStoryLayouts(project: EventModelProject, sliceMetrics: Map<string, SliceMetrics>): Map<string, StoryLayout> {
  const layouts = new Map<string, StoryLayout>();
  let nextY = STORY_Y;

  for (const story of project.stories) {
    const storySlices = project.slices.filter((slice) => slice.storyName === story.name);
    const totalSliceWidth = storySlices.reduce((sum, slice) => sum + (sliceMetrics.get(slice.title)?.width ?? MIN_SLICE_WIDTH), 0);
    const width = Math.max(totalSliceWidth + Math.max(storySlices.length - 1, 0) * SLICE_GAP_X, MIN_SLICE_WIDTH);
    const maxSliceHeight = Math.max(...storySlices.map((slice) => sliceMetrics.get(slice.title)?.height ?? MIN_SLICE_HEIGHT), MIN_SLICE_HEIGHT);
    const height = STORY_HEADER_HEIGHT + maxSliceHeight + STORY_PADDING_BOTTOM;
    layouts.set(story.name, { y: nextY, width, height });
    nextY += height + STORY_GAP_Y;
  }

  return layouts;
}

function positionRow(ids: string[], positions: Map<string, { x: number; y: number }>, origin: { x: number; y: number }, sliceWidth: number, rowY: number, nodeWidth: number): void {
  const width = rowWidth(ids.length, nodeWidth);
  const startX = origin.x + (sliceWidth - width) / 2;
  ids.forEach((id, index) => {
    positions.set(id, { x: startX + index * (nodeWidth + ROW_GAP_X), y: origin.y + rowY });
  });
}

export type VisibilityScope = "story" | "neighborhood" | "all";
export type EdgeDetail = "essential" | "normal" | "verbose";

function edgeKindsForDetail(detail: EdgeDetail): Set<string> {
  if (detail === "essential") return new Set(["command-event", "event-query"]);
  if (detail === "normal") return new Set(["query-screen", "screen-command", "command-event", "event-query"]);
  return new Set(["story-slice", "slice-screen", "query-screen", "screen-command", "command-event", "event-query"]);
}

function visibleStoryNames(project: EventModelProject, focusedStory?: string, scope: VisibilityScope = "all"): Set<string> {
  if (!focusedStory || scope === "all") return new Set(project.stories.map((story) => story.name));
  if (scope === "story") return new Set([focusedStory]);

  const visible = new Set([focusedStory]);
  const focusedNodeIds = new Set(project.nodes.filter((node) => node.storyName === focusedStory).map((node) => node.id));
  const connectedEventIds = new Set(
    project.edges
      .filter((edge) => focusedNodeIds.has(edge.source) || focusedNodeIds.has(edge.target))
      .flatMap((edge) => [edge.source, edge.target])
      .filter((id) => project.nodes.find((node) => node.id === id)?.type === "event")
  );

  for (const edge of project.edges) {
    if (!connectedEventIds.has(edge.source) && !connectedEventIds.has(edge.target)) continue;
    const source = project.nodes.find((node) => node.id === edge.source);
    const target = project.nodes.find((node) => node.id === edge.target);
    if (source?.storyName) visible.add(source.storyName);
    if (target?.storyName) visible.add(target.storyName);
  }

  return visible;
}

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Side = "top" | "right" | "bottom" | "left";
type RouteKind = "semantic" | "same-slice-read" | "event-read";

function semanticSides(edgeKind: string): { sourceSide: Side; targetSide: Side } {
  if (edgeKind === "event-query") return { sourceSide: "top", targetSide: "bottom" };
  if (edgeKind === "query-screen") return { sourceSide: "top", targetSide: "bottom" };
  if (edgeKind === "screen-command") return { sourceSide: "bottom", targetSide: "top" };
  if (edgeKind === "command-event") return { sourceSide: "bottom", targetSide: "top" };
  if (edgeKind === "slice-screen") return { sourceSide: "bottom", targetSide: "top" };
  return { sourceSide: "right", targetSide: "left" };
}

function routedSides(
  edgeKind: string,
  source?: ProjectNode,
  target?: ProjectNode,
  sourceRect?: Rect,
  targetRect?: Rect
): { sourceSide: Side; targetSide: Side; route: RouteKind } {
  const semantic = semanticSides(edgeKind);
  const isSameSlice = source?.sliceTitle && source.sliceTitle === target?.sliceTitle;
  if (edgeKind === "event-query" && isSameSlice) {
    return { ...semantic, route: "same-slice-read" };
  }

  const isCrossSliceEventRead = edgeKind === "event-query" && source?.sliceTitle !== target?.sliceTitle;
  if (!isCrossSliceEventRead || !sourceRect || !targetRect) return { ...semantic, route: "semantic" };

  const sourceCenterX = sourceRect.x + sourceRect.width / 2;
  const sourceCenterY = sourceRect.y + sourceRect.height / 2;
  const targetCenterX = targetRect.x + targetRect.width / 2;
  const targetCenterY = targetRect.y + targetRect.height / 2;
  const isSameStory = source?.storyName && source.storyName === target?.storyName;

  return {
    sourceSide: isSameStory || targetCenterY >= sourceCenterY ? "bottom" : "top",
    targetSide: targetCenterX >= sourceCenterX ? "left" : "right",
    route: "event-read"
  };
}

export function toFlow(
  project: EventModelProject,
  selectedId?: string,
  options: { scope?: VisibilityScope; focusedStory?: string; edgeDetail?: EdgeDetail; focusedEdgeIds?: Set<string> } = {}
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const storyIndexes = storyIndex(project);
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const sliceMetrics = buildSliceMetrics(project, nodeById);
  const storyLayouts = buildStoryLayouts(project, sliceMetrics);
  const positions = new Map<string, { x: number; y: number }>();
  const rects = new Map<string, Rect>();
  const sliceOrigins = new Map<string, { x: number; y: number }>();
  const connectedIds = new Set<string>();
  const visibleStories = visibleStoryNames(project, options.focusedStory, options.scope ?? "all");
  const visibleEdgeKinds = edgeKindsForDetail(options.edgeDetail ?? "normal");

  if (selectedId) {
    connectedIds.add(selectedId);
    for (const edge of project.edges) {
      if (edge.source === selectedId) {
        connectedIds.add(edge.target);
      }
      if (edge.target === selectedId) {
        connectedIds.add(edge.source);
      }
    }
  }

  const nextSliceXByStory = new Map<string, number>();
  for (const story of project.stories) {
    nextSliceXByStory.set(story.name, STORY_X);
  }

  for (const story of project.stories) {
    for (const slicePath of story.slices) {
      const slice = project.slices.find((candidate) => candidate.path === slicePath);
      if (!slice) continue;
      const storyLayout = storyLayouts.get(story.name) ?? { y: STORY_Y, width: MIN_SLICE_WIDTH, height: MIN_SLICE_HEIGHT };
      const sliceX = nextSliceXByStory.get(story.name) ?? STORY_X;
      sliceOrigins.set(slice.title, { x: sliceX, y: storyLayout.y + STORY_HEADER_HEIGHT });
      nextSliceXByStory.set(story.name, sliceX + (sliceMetrics.get(slice.title)?.width ?? MIN_SLICE_WIDTH) + SLICE_GAP_X);
    }
  }

  for (const slice of project.slices) {
    if (sliceOrigins.has(slice.title)) continue;
    const storyY = STORY_Y + (storyIndexes.get(slice.storyName ?? "") ?? 0) * (MIN_SLICE_HEIGHT + STORY_HEADER_HEIGHT + STORY_PADDING_BOTTOM + STORY_GAP_Y);
    const sliceX = STORY_X;
    sliceOrigins.set(slice.title, { x: sliceX, y: storyY + STORY_HEADER_HEIGHT });
  }

  for (const node of project.nodes) {
    if (node.type === "story") {
      positions.set(node.id, { x: STORY_X - 20, y: storyLayouts.get(node.label)?.y ?? STORY_Y });
    }
    if (node.type === "slice") {
      const origin = sliceOrigins.get(node.label) ?? { x: STORY_X, y: STORY_Y };
      positions.set(node.id, origin);
    }
    if (node.type === "screen" || node.type === "processor") {
      const origin = sliceOrigins.get(node.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
      const metrics = sliceMetrics.get(node.sliceTitle ?? "");
      const sliceWidth = metrics?.width ?? MIN_SLICE_WIDTH;
      positions.set(node.id, { x: origin.x + (sliceWidth - NODE_WIDTH) / 2, y: origin.y + SCREEN_Y });
    }
  }

  for (const slice of project.slices) {
    const origin = sliceOrigins.get(slice.title) ?? { x: STORY_X, y: STORY_Y };
    const metrics = sliceMetrics.get(slice.title);
    const sliceWidth = metrics?.width ?? MIN_SLICE_WIDTH;
    if (!metrics) continue;

    const queryBandWidth = rowWidth(metrics.queryIds.length, NODE_WIDTH);
    const commandBandWidth = rowWidth(metrics.commandIds.length, NODE_WIDTH);
    const mainRowWidth = queryBandWidth + commandBandWidth + (queryBandWidth > 0 && commandBandWidth > 0 ? MAIN_BAND_GAP_X : 0);
    let currentX = origin.x + (sliceWidth - mainRowWidth) / 2;

    metrics.queryIds.forEach((id, index) => {
      positions.set(id, { x: currentX + index * (NODE_WIDTH + ROW_GAP_X), y: origin.y + MAIN_ROW_Y });
    });
    if (queryBandWidth > 0) currentX += queryBandWidth + (commandBandWidth > 0 ? MAIN_BAND_GAP_X : 0);
    metrics.commandIds.forEach((id, index) => {
      positions.set(id, { x: currentX + index * (NODE_WIDTH + ROW_GAP_X), y: origin.y + MAIN_ROW_Y });
    });

    positionRow(metrics.eventIds, positions, origin, sliceWidth, EVENT_ROW_Y, NODE_WIDTH);
    positionRow(metrics.gwtIds, positions, origin, sliceWidth, GWT_ROW_Y, GWT_WIDTH);
  }

  for (const event of project.nodes.filter((node) => node.type === "event")) {
    const producerEdge = project.edges.find((edge) => edge.kind === "command-event" && edge.target === event.id);
    const producer = producerEdge ? nodeById.get(producerEdge.source) : undefined;
    if (!positions.has(event.id)) {
      const origin = sliceOrigins.get(producer?.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
      const metrics = sliceMetrics.get(producer?.sliceTitle ?? "");
      positions.set(event.id, { x: origin.x + ((metrics?.width ?? MIN_SLICE_WIDTH) - NODE_WIDTH) / 2, y: origin.y + EVENT_ROW_Y });
    }
    event.storyName = producer?.storyName;
  }

  const nodes = project.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const isContainer = node.type === "story" || node.type === "slice";
    const width = node.type === "story" ? storyLayouts.get(node.label)?.width ?? MIN_SLICE_WIDTH : sliceMetrics.get(node.label)?.width ?? MIN_SLICE_WIDTH;
    const height = node.type === "story" ? storyLayouts.get(node.label)?.height ?? MIN_SLICE_HEIGHT : sliceMetrics.get(node.label)?.height ?? MIN_SLICE_HEIGHT;
    const nodeWidth = isContainer ? width : node.type === "gwt" ? GWT_WIDTH : NODE_WIDTH;
    const nodeHeight = isContainer ? height : node.type === "gwt" ? GWT_HEIGHT : NODE_HEIGHT;

    rects.set(node.id, {
      x: position.x,
      y: position.y,
      width: nodeWidth,
      height: nodeHeight
    });

    return {
      id: node.id,
      type: isContainer ? "groupNode" : "eventModelNode",
      position,
      selectable: true,
      draggable: false,
      data: {
        projectNode: node,
        selected: node.id === selectedId,
        connected: connectedIds.has(node.id)
      },
      hidden: Boolean(node.storyName && !visibleStories.has(node.storyName)),
      style: isContainer
        ? { width, height, zIndex: node.type === "story" ? -20 : -10, opacity: node.storyName && !visibleStories.has(node.storyName) ? 0.18 : 1 }
        : { width: nodeWidth, height: node.type === "gwt" ? GWT_HEIGHT : undefined, opacity: node.storyName && !visibleStories.has(node.storyName) ? 0.18 : 1 },
      ...nodeDefaults(node)
    };
  });

  const visibleEdges = project.edges
    .filter((edge) => visibleEdgeKinds.has(edge.kind))
    .filter((edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      const sourceVisible = !source?.storyName || visibleStories.has(source.storyName);
      const targetVisible = !target?.storyName || visibleStories.has(target.storyName);
      return sourceVisible && targetVisible;
  });
  const edges = visibleEdges.map((edge) => {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const active = Boolean(options.focusedEdgeIds?.has(edge.id));
    const { sourceSide, targetSide, route } = routedSides(
      edge.kind,
      sourceNode,
      targetNode,
      rects.get(edge.source),
      rects.get(edge.target)
    );

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "eventModelEdge",
      sourceHandle: `${sourceSide}-source`,
      targetHandle: `${targetSide}-target`,
      data: { kind: edge.kind, route, active },
      markerEnd: { type: MarkerType.ArrowClosed, color: active ? "#111827" : edgeColor(edge.kind) },
      label: options.edgeDetail === "verbose" ? edge.label : undefined,
      className: active ? "edge edge-active" : "edge",
      animated: active
    };
  });

  return { nodes, edges };
}
