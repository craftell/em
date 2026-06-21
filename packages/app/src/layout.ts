import { MarkerType, type Edge, type Node, Position } from "@xyflow/react";
import type { EventModelProject, ProjectNode } from "./types";

const STORY_X = 180;
const STORY_Y = 80;
const STORY_GAP_Y = 540;
const SLICE_WIDTH = 430;
const SLICE_HEIGHT = 390;
const SLICE_GAP_X = 130;
const NODE_WIDTH = 178;
const NODE_HEIGHT = 92;

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
  const sliceIndexes = sliceIndex(project);
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
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

  for (const slice of project.slices) {
    const storyY = STORY_Y + (storyIndexes.get(slice.storyName ?? "") ?? 0) * STORY_GAP_Y;
    const sliceX = STORY_X + (sliceIndexes.get(slice.title) ?? 0) * (SLICE_WIDTH + SLICE_GAP_X);
    const sliceY = storyY + 92;
    sliceOrigins.set(slice.title, { x: sliceX, y: sliceY });
  }

  for (const node of project.nodes) {
    if (node.type === "story") {
      positions.set(node.id, { x: STORY_X - 20, y: STORY_Y + (storyIndexes.get(node.label) ?? 0) * STORY_GAP_Y });
    }
    if (node.type === "slice") {
      const origin = sliceOrigins.get(node.label) ?? { x: STORY_X, y: STORY_Y };
      positions.set(node.id, origin);
    }
    if (node.type === "screen" || node.type === "processor") {
      const origin = sliceOrigins.get(node.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
      positions.set(node.id, { x: origin.x + 126, y: origin.y + 42 });
    }
    if (node.type === "query") {
      const origin = sliceOrigins.get(node.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
      positions.set(node.id, { x: origin.x + 30, y: origin.y + 154 });
    }
    if (node.type === "command") {
      const origin = sliceOrigins.get(node.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
      positions.set(node.id, { x: origin.x + 222, y: origin.y + 154 });
    }
  }

  for (const event of project.nodes.filter((node) => node.type === "event")) {
    const producerEdge = project.edges.find((edge) => edge.kind === "command-event" && edge.target === event.id);
    const producer = producerEdge ? nodeById.get(producerEdge.source) : undefined;
    const origin = sliceOrigins.get(producer?.sliceTitle ?? "") ?? { x: STORY_X, y: STORY_Y };
    positions.set(event.id, { x: origin.x + 222, y: origin.y + 278 });
    event.storyName = producer?.storyName;
  }

  const nodes = project.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 0, y: 0 };
    const isContainer = node.type === "story" || node.type === "slice";
    const width = node.type === "story" ? Math.max(project.stories.find((story) => story.name === node.label)?.slices.length ?? 1, 1) * (SLICE_WIDTH + SLICE_GAP_X) : SLICE_WIDTH;
    const height = node.type === "story" ? 470 : SLICE_HEIGHT;
    const nodeWidth = isContainer ? width : NODE_WIDTH;
    const nodeHeight = isContainer ? height : NODE_HEIGHT;

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
        : { width: NODE_WIDTH, opacity: node.storyName && !visibleStories.has(node.storyName) ? 0.18 : 1 },
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
