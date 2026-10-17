import type { EventModelProject, GraphDiff, ProjectEdge, ProjectNode, ValidationReport } from "./types";

export type FeedbackView = "current" | "session" | "turn";
export type FeedbackStatus = "idle" | "queued" | "working" | "completed" | "stopped";

export type FeedbackRequest = {
  id: string;
  clientRequestId: string;
  message: string;
  reference: string;
  nodeId: string;
  createdAt: number;
  agentId?: string;
  reply?: string;
};

export type FeedbackSession = {
  sessionId: string;
  token: string;
  revision: string;
  project: EventModelProject;
  validation: ValidationReport;
  diff?: GraphDiff;
  feedback: {
    status: FeedbackStatus;
    request?: FeedbackRequest;
    history: FeedbackRequest[];
    agent: { connected: boolean; lastSeen?: number };
    error?: string;
  };
  baseline: { kind: "git" | "startup"; label: string };
  error?: string;
  stale: boolean;
};

export type NodeIdentity = Pick<ProjectNode, "type" | "sourcePath" | "sourceName" | "label" | "sliceTitle">;

export type FeedbackDraft = {
  sessionId: string;
  identity: NodeIdentity;
  message: string;
};

export type FeedbackDrafts = Record<string, FeedbackDraft>;

export function feedbackDraftKey(sessionId: string, identity: NodeIdentity): string {
  return JSON.stringify([sessionId, identity.type, identity.sourcePath, identity.sourceName, identity.label, identity.sliceTitle]);
}

export function updateFeedbackDraft(
  drafts: FeedbackDrafts,
  sessionId: string,
  node: ProjectNode,
  message: string,
  expectedMessage?: string
): FeedbackDrafts {
  const key = feedbackDraftKey(sessionId, node);
  if (expectedMessage !== undefined && drafts[key]?.message !== expectedMessage) return drafts;
  if (message) return { ...drafts, [key]: { sessionId, identity: identityForNode(node), message } };
  const next = { ...drafts };
  delete next[key];
  return next;
}

export type NodeSelection = {
  identity: NodeIdentity;
  nodeId: string;
  snapshotNodes: ProjectNode[];
};

export function identityForNode(node: ProjectNode): NodeIdentity {
  return {
    type: node.type,
    sourcePath: node.sourcePath,
    sourceName: node.sourceName,
    label: node.label,
    sliceTitle: node.sliceTitle
  };
}

function matchesIdentity(node: ProjectNode, identity: NodeIdentity): boolean {
  return node.type === identity.type &&
    node.sourcePath === identity.sourcePath &&
    node.sourceName === identity.sourceName &&
    node.label === identity.label &&
    node.sliceTitle === identity.sliceTitle;
}

export function selectionForNode(project: EventModelProject, nodeId: string): NodeSelection | undefined {
  const node = project.nodes.find((candidate) => candidate.id === nodeId);
  return node ? { identity: identityForNode(node), nodeId, snapshotNodes: project.nodes } : undefined;
}

export function resolveSelection(project: EventModelProject | undefined, selection: NodeSelection | undefined): ProjectNode | undefined {
  if (!project || !selection) return undefined;
  if (project.nodes === selection.snapshotNodes) {
    return project.nodes.find((node) => node.id === selection.nodeId && matchesIdentity(node, selection.identity));
  }
  const matches = project.nodes.filter((node) => matchesIdentity(node, selection.identity));
  return matches.length === 1 ? matches[0] : undefined;
}

export function uniqueCurrentNode(project: EventModelProject, node: ProjectNode): boolean {
  return project.nodes.filter((candidate) => matchesIdentity(candidate, identityForNode(node))).length === 1;
}

export function previousNodeFor(diff: GraphDiff | undefined, node: ProjectNode | undefined): ProjectNode | undefined {
  if (!node || diff?.nodeStatus[node.id] !== "changed") return undefined;
  return diff.previousNodes?.[node.id] ?? diff.previousGwtNodes?.[node.id];
}

export function connectionsBefore(project: EventModelProject, diff: GraphDiff | undefined): EventModelProject {
  if (!diff) return project;
  const nodes = project.nodes
    .filter((node) => diff.nodeStatus[node.id] !== "added")
    .map((node) => {
      const previous = previousNodeFor(diff, node);
      return previous ? { ...previous, id: node.id } : node;
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ProjectEdge[] = project.edges
    .filter((edge) => diff.edgeStatus[edge.id] !== "added")
    .map((edge) => diff.previousEdges?.[edge.id] ? { ...diff.previousEdges[edge.id], id: edge.id, source: edge.source, target: edge.target } : edge)
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { ...project, nodes, edges };
}

export function connectionsAfter(project: EventModelProject, diff: GraphDiff | undefined): EventModelProject {
  if (!diff) return project;
  const nodes = project.nodes.filter((node) => diff.nodeStatus[node.id] !== "removed");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = project.edges.filter((edge) => diff.edgeStatus[edge.id] !== "removed" && nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { ...project, nodes, edges };
}

export function isFeedbackSession(value: unknown): value is FeedbackSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<FeedbackSession>;
  return typeof session.sessionId === "string" && typeof session.token === "string" &&
    typeof session.revision === "string" && Array.isArray(session.project?.nodes) &&
    Array.isArray(session.project?.edges) && Array.isArray(session.validation?.findings) &&
    typeof session.stale === "boolean" && Boolean(session.baseline) &&
    Boolean(session.feedback && ["idle", "queued", "working", "completed", "stopped"].includes(session.feedback.status) &&
      Array.isArray(session.feedback.history) && typeof session.feedback.agent?.connected === "boolean");
}

export function feedbackUnavailableReason(
  session: FeedbackSession | undefined,
  view: FeedbackView,
  connected: boolean,
  pending: boolean,
  node: ProjectNode,
  diff?: GraphDiff,
  showingBefore = false
): string | undefined {
  if (!session) return "Feedback is available when a project session is running.";
  if (!connected) return "Reconnect to the project server before sending feedback.";
  if (session.stale || session.error) return "The model is stale. Fix the model error before sending feedback.";
  if (view === "turn") return "Switch to Current or Session diff to send feedback about the current model.";
  if (diff?.nodeStatus[node.id] === "removed") return "This node was removed. Select a current node to send feedback.";
  if (showingBefore) return "Switch to New version to send feedback about the current node. Your draft is preserved.";
  if (!uniqueCurrentNode(session.project, node)) return "This node is ambiguous. Give same-named nodes distinct names before sending feedback.";
  if (session.feedback.status === "stopped") return "The session is stopped. Stop the external editor before resuming.";
  if (pending || session.feedback.status === "queued" || session.feedback.status === "working") return "Wait for the current request to finish before sending another.";
  return undefined;
}
