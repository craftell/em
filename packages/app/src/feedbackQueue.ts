import {
  feedbackDraftKey,
  identityForNode,
  type FeedbackDrafts,
  type FeedbackSession,
  type FeedbackView,
  type NodeIdentity
} from "./feedbackState";
import type { ProjectNode } from "./types";

export const FEEDBACK_QUEUE_LIMIT = 20;
export const FEEDBACK_MESSAGE_LIMIT = 4000;
export const FEEDBACK_TOTAL_LIMIT = 16000;
export const FEEDBACK_BATCH_BYTE_LIMIT = 128 * 1024;

export type FeedbackQueueItem = Readonly<{
  id: string;
  sessionId: string;
  projectRoot: string;
  nodeId: string;
  reference: string;
  revision: string;
  identity: Readonly<NodeIdentity>;
  message: string;
}>;

export type FeedbackBatchItem = Pick<FeedbackQueueItem, "id" | "nodeId" | "reference" | "revision" | "message">;
export type FeedbackBatch = { clientBatchId: string; items: FeedbackBatchItem[] };
export type FeedbackSubmission = {
  sessionId: string;
  projectRoot: string;
  phase: "sending" | "uncertain";
  body: FeedbackBatch;
};

export type FeedbackQueue = {
  items: FeedbackQueueItem[];
  editing?: { id: string; message: string };
  submission?: FeedbackSubmission;
  error?: string;
  notice?: string;
};

export type FeedbackWorkspace = {
  version: 1;
  recoveryWarning?: string;
  drafts: FeedbackDrafts;
  queue: FeedbackQueue;
};

export function emptyFeedbackWorkspace(): FeedbackWorkspace {
  return { version: 1, drafts: {}, queue: { items: [] } };
}

export function captureQueuedFeedback(session: FeedbackSession, node: ProjectNode, message: string, id: string): FeedbackQueueItem {
  const nodeId = session.currentNodeIds?.[node.id] ?? node.id;
  return {
    id,
    sessionId: session.sessionId,
    projectRoot: session.project.root,
    nodeId,
    reference: "em://" + (session.project.graphSidecar?.model?.id ?? "event_model") + "/" + nodeId,
    revision: session.revision,
    identity: identityForNode(node),
    message: message.trim()
  };
}

export function feedbackQueueLimitReason(items: readonly FeedbackQueueItem[]): string | undefined {
  if (items.length > FEEDBACK_QUEUE_LIMIT) return "The Queue can hold up to 20 items. Send or remove an item first.";
  if (items.some((item) => !item.message.trim() || item.message.length > FEEDBACK_MESSAGE_LIMIT)) return "Each queued message must contain 1 to 4000 characters.";
  if (items.reduce((total, item) => total + item.message.length, 0) > FEEDBACK_TOTAL_LIMIT) return "The Queue can contain up to 16000 message characters.";
  if (items.some((item) => !isBatchItem(item))) return "A captured target exceeds the server limits. Copy the feedback before removing it.";
  const body = { clientBatchId: "0".repeat(100), items: items.map(({ id, nodeId, reference, revision, message }) => ({ id, nodeId, reference, revision, message })) };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > FEEDBACK_BATCH_BYTE_LIMIT) return "This Queue exceeds the 128 KiB request limit. Remove an item before sending.";
  return undefined;
}

export function queuedFeedbackLocked(queue: FeedbackQueue, id: string): boolean {
  return Boolean(queue.submission?.body.items.some((item) => item.id === id));
}

export function addQueuedFeedback(queue: FeedbackQueue, item: FeedbackQueueItem): FeedbackQueue {
  if (queue.items.some((existing) => existing.id === item.id)) return queue;
  const items = [...queue.items, item];
  const error = feedbackQueueLimitReason(items);
  return error ? { ...queue, error } : { ...queue, items, error: undefined, notice: undefined };
}

export function editQueuedFeedback(queue: FeedbackQueue, id: string, message: string): FeedbackQueue {
  if (queuedFeedbackLocked(queue, id)) return queue;
  const items = queue.items.map((item) => item.id === id ? { ...item, message: message.trim() } : item);
  const error = feedbackQueueLimitReason(items);
  return error ? { ...queue, error } : { ...queue, items, editing: undefined, error: undefined, notice: undefined };
}

export function removeQueuedFeedback(queue: FeedbackQueue, id: string): FeedbackQueue {
  if (queuedFeedbackLocked(queue, id)) return queue;
  return { ...queue, items: queue.items.filter((item) => item.id !== id), editing: queue.editing?.id === id ? undefined : queue.editing, error: undefined, notice: undefined };
}

export function queuedFeedbackUnavailableReason(item: FeedbackQueueItem, session: FeedbackSession): string | undefined {
  if (item.sessionId !== session.sessionId) return "This item belongs to a previous session. Copy it, then add feedback for a current node.";
  if (item.projectRoot !== session.project.root) return "This item belongs to another project. Copy it, then add feedback for the current project.";
  if (item.revision !== session.revision) return "The model changed after this item was added. Copy it, then review and add it again.";
  const matches = session.project.nodes.filter((node) =>
    feedbackDraftKey(session.sessionId, node) === feedbackDraftKey(item.sessionId, item.identity) &&
    session.diff?.nodeStatus[node.id] !== "removed");
  if (matches.length !== 1 || (session.currentNodeIds?.[matches[0].id] ?? matches[0].id) !== item.nodeId) return "The original node is missing or ambiguous. Copy the text before removing this item.";
  const reference = "em://" + (session.project.graphSidecar?.model?.id ?? "event_model") + "/" + item.nodeId;
  if (item.reference !== reference) return "The model reference changed. Review and add this feedback again.";
  return undefined;
}

export function feedbackBatchUnavailableReason(
  queue: FeedbackQueue,
  session: FeedbackSession | undefined,
  view: FeedbackView,
  connected: boolean,
  pending: boolean
): string | undefined {
  if (!session || !connected) return "Reconnect to the project server before sending the Queue.";
  if (queue.submission?.sessionId !== undefined && (queue.submission.sessionId !== session.sessionId || queue.submission.projectRoot !== session.project.root)) return "The project changed or the server restarted before this batch could be confirmed.";
  if (pending || queue.submission?.phase === "sending") return "Waiting for the server to confirm this batch.";
  if (queue.submission) return undefined;
  if (queue.editing) return "Save or cancel the Queue edit before sending.";
  if (!queue.items.length) return "Add feedback to the Queue before sending.";
  if (session.stale || session.error) return "The model is stale. Fix the model error before sending.";
  if (view === "turn") return "Switch to Current or Session diff before sending.";
  if (session.feedback.status === "stopped") return "Resume the session before sending.";
  if (session.feedback.status === "queued" || session.feedback.status === "working") return "Wait for the current request to finish before sending.";
  if (queue.items.some((item) => queuedFeedbackUnavailableReason(item, session))) return "Review the flagged Queue items before sending. Their captured targets have not been changed.";
  return feedbackQueueLimitReason(queue.items);
}

export function beginFeedbackSubmission(queue: FeedbackQueue, clientBatchId: string): FeedbackQueue {
  if (queue.submission?.phase === "sending") return queue;
  if (queue.submission) return { ...queue, submission: { ...queue.submission, phase: "sending" }, error: undefined };
  if (!queue.items.length || queue.editing || feedbackQueueLimitReason(queue.items)) return queue;
  return {
    ...queue,
    error: undefined,
    notice: undefined,
    submission: {
      sessionId: queue.items[0].sessionId,
      projectRoot: queue.items[0].projectRoot,
      phase: "sending",
      body: {
        clientBatchId,
        items: queue.items.map(({ id, nodeId, reference, revision, message }) => ({ id, nodeId, reference, revision, message }))
      }
    }
  };
}

export function failFeedbackSubmission(queue: FeedbackQueue, clientBatchId: string, message: string, uncertain: boolean): FeedbackQueue {
  if (queue.submission?.body.clientBatchId !== clientBatchId) return queue;
  return {
    ...queue,
    submission: uncertain ? { ...queue.submission, phase: "uncertain" } : undefined,
    error: message
  };
}

export function acknowledgeFeedbackSubmission(queue: FeedbackQueue, clientBatchId: string): FeedbackQueue {
  if (queue.submission?.body.clientBatchId !== clientBatchId) return queue;
  const sent = new Set(queue.submission.body.items.map((item) => item.id));
  return {
    items: queue.items.filter((item) => !sent.has(item.id)),
    editing: queue.editing && !sent.has(queue.editing.id) ? queue.editing : undefined,
    notice: "Feedback sent as one request to your external agent."
  };
}

export function releasePreviousFeedbackSubmission(queue: FeedbackQueue, currentSession: FeedbackSession): FeedbackQueue {
  if (!queue.submission || (queue.submission.sessionId === currentSession.sessionId && queue.submission.projectRoot === currentSession.project.root)) return queue;
  return { ...queue, submission: undefined, error: "The previous send remains unconfirmed. Its Queue items are preserved for review and cannot be sent to the new session." };
}

export function matchesFeedbackBatchResponse(value: unknown, expected: Record<string, unknown>): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
    typeof expected.clientBatchId !== "string" || value.clientBatchId !== expected.clientBatchId ||
    !Array.isArray(value.items) || !Array.isArray(expected.items) ||
    value.items.length !== expected.items.length || !value.items.every(isBatchItem) || !expected.items.every(isBatchItem)) return false;
  const sentItems = expected.items;
  return value.items.every((item, index) => {
    const sent = sentItems[index];
    return item.id === sent.id && item.nodeId === sent.nodeId && item.reference === sent.reference &&
      item.revision === sent.revision && item.message === sent.message;
  });
}

export function reconcileFeedbackQueue(queue: FeedbackQueue, session: FeedbackSession): FeedbackQueue {
  const submission = queue.submission;
  if (!submission) return queue;
  if (submission.sessionId !== session.sessionId || submission.projectRoot !== session.project.root) {
    const error = "The project changed or its server restarted. The previous send could not be confirmed. Release the previous-session batch to review its preserved items.";
    return queue.error === error && submission.phase === "uncertain" ? queue : { ...queue, submission: { ...submission, phase: "uncertain" }, error };
  }
  const requests = [...session.feedback.history, ...(session.feedback.request ? [session.feedback.request] : [])];
  const match = requests.find((request) => request.clientBatchId === submission.body.clientBatchId);
  if (!match) return queue;
  if (!matchesFeedbackBatchResponse(match, submission.body)) {
    return { ...queue, submission: { ...submission, phase: "uncertain" }, error: "The server returned different items for this batch ID. The original Queue is preserved." };
  }
  return acknowledgeFeedbackSubmission(queue, submission.body.clientBatchId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isIdentity(value: unknown): value is NodeIdentity {
  return isRecord(value) &&
    ["story", "slice", "screen", "processor", "command", "event", "query", "gwt"].includes(String(value.type)) &&
    typeof value.label === "string" &&
    ["sourcePath", "sourceName", "sliceTitle"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isBatchItem(value: unknown): value is FeedbackBatchItem {
  return isRecord(value) &&
    typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100 &&
    typeof value.nodeId === "string" && value.nodeId.length > 0 && value.nodeId.length <= 500 &&
    typeof value.reference === "string" && value.reference.length > 0 && value.reference.length <= 1000 &&
    typeof value.revision === "string" && value.revision.length > 0 && value.revision.length <= 100 &&
    typeof value.message === "string" && Boolean(value.message.trim()) && value.message.length <= FEEDBACK_MESSAGE_LIMIT;
}

const recoveryWarning = "Some saved feedback could not be recovered. A previous send may already have arrived. The original saved data has been kept. Review the agent history before replacing the damaged saved copy and sending again.";

function damagedFeedbackWorkspace(): FeedbackWorkspace {
  return { ...emptyFeedbackWorkspace(), recoveryWarning };
}

export function restoreFeedbackWorkspace(serialized: string | null): FeedbackWorkspace {
  if (!serialized) return emptyFeedbackWorkspace();
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.drafts) || !isRecord(value.queue) || !Array.isArray(value.queue.items)) return damagedFeedbackWorkspace();
    const drafts: FeedbackDrafts = {};
    for (const draft of Object.values(value.drafts)) {
      if (!isRecord(draft) || typeof draft.sessionId !== "string" || !isIdentity(draft.identity) || typeof draft.message !== "string" || draft.message.length > FEEDBACK_MESSAGE_LIMIT) continue;
      drafts[feedbackDraftKey(draft.sessionId, draft.identity)] = { sessionId: draft.sessionId, identity: identityForNode(draft.identity), message: draft.message };
    }
    const items: FeedbackQueueItem[] = [];
    for (const item of value.queue.items) {
      if (!isBatchItem(item) || !isRecord(item) || typeof item.sessionId !== "string" || typeof item.projectRoot !== "string" || !isIdentity(item.identity)) continue;
      if (items.some((existing) => existing.id === item.id)) continue;
      items.push({
        id: item.id, sessionId: item.sessionId, projectRoot: item.projectRoot, nodeId: item.nodeId, reference: item.reference,
        revision: item.revision, message: item.message, identity: identityForNode(item.identity)
      });
    }
    const queue: FeedbackQueue = { items };
    const editing = value.queue.editing;
    if (isRecord(editing) && typeof editing.id === "string" && typeof editing.message === "string" && items.some((item) => item.id === editing.id)) {
      queue.editing = { id: editing.id, message: editing.message };
    }
    const raw = value.queue.submission;
    if (isRecord(raw) && typeof raw.sessionId === "string" && typeof raw.projectRoot === "string" && isRecord(raw.body) &&
      typeof raw.body.clientBatchId === "string" && raw.body.clientBatchId.length > 0 && raw.body.clientBatchId.length <= 100 &&
      Array.isArray(raw.body.items) && raw.body.items.length > 0 && raw.body.items.length <= FEEDBACK_QUEUE_LIMIT &&
      raw.body.items.every(isBatchItem)) {
      const batchItems = raw.body.items.map(({ id, nodeId, reference, revision, message }) => ({ id, nodeId, reference, revision, message }));
      if (new Set(batchItems.map((item) => item.id)).size === batchItems.length &&
        batchItems.every((sent) => items.some((item) => item.id === sent.id && item.sessionId === raw.sessionId && item.projectRoot === raw.projectRoot &&
          item.nodeId === sent.nodeId && item.reference === sent.reference && item.revision === sent.revision && item.message === sent.message))) {
        queue.editing = queue.editing && !batchItems.some((item) => item.id === queue.editing?.id) ? queue.editing : undefined;
        queue.submission = { sessionId: raw.sessionId, projectRoot: raw.projectRoot, phase: "uncertain", body: { clientBatchId: raw.body.clientBatchId, items: batchItems } };
        queue.error = "A previous send was not confirmed. Refresh to check its status, or retry the same batch.";
      }
    }
    const damaged = Object.keys(drafts).length !== Object.keys(value.drafts).length || items.length !== value.queue.items.length || Boolean(feedbackQueueLimitReason(items)) || (raw !== undefined && !queue.submission);
    return { version: 1, drafts, queue, recoveryWarning: damaged ? recoveryWarning : undefined };
  } catch {
    return damagedFeedbackWorkspace();
  }
}

export function serializeFeedbackWorkspace(workspace: FeedbackWorkspace): string {
  return JSON.stringify({ version: 1, drafts: workspace.drafts, queue: { items: workspace.queue.items, editing: workspace.queue.editing, submission: workspace.queue.submission } });
}
