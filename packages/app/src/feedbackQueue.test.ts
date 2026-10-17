import { describe, expect, it } from "vitest";
import {
  acknowledgeFeedbackSubmission,
  addQueuedFeedback,
  beginFeedbackSubmission,
  captureQueuedFeedback,
  editQueuedFeedback,
  emptyFeedbackWorkspace,
  failFeedbackSubmission,
  feedbackBatchUnavailableReason,
  feedbackQueueLimitReason,
  queuedFeedbackLocked,
  matchesFeedbackBatchResponse,
  queuedFeedbackUnavailableReason,
  reconcileFeedbackQueue,
  releasePreviousFeedbackSubmission,
  removeQueuedFeedback,
  restoreFeedbackWorkspace,
  serializeFeedbackWorkspace,
  type FeedbackQueue
} from "./feedbackQueue";
import { feedbackDraftKey, feedbackTargetUnavailableReason, updateFeedbackDraft, type FeedbackSession } from "./feedbackState";
import type { ProjectNode } from "./types";

const command: ProjectNode = { id: "save", type: "command", label: "Save", sourceName: "Save", sourcePath: "save.slice.yaml" };
const query: ProjectNode = { id: "load", type: "query", label: "Load", sourceName: "Load", sourcePath: "load.slice.yaml" };

function snapshot(nodes: ProjectNode[] = [command, query]): FeedbackSession {
  return {
    sessionId: "session-1",
    token: "must-not-be-persisted",
    revision: "revision-1",
    currentNodeIds: Object.fromEntries(nodes.map((node) => [node.id, node.id])),
    project: {
      root: "/project",
      config: { paths: { eventModelDir: "event-model", featuresDir: "event-model/features", sliceExtension: ".slice.yaml", eventsFile: "event-model/events.yaml", storiesDir: "event-model/stories" } },
      events: [], stories: [], slices: [], nodes, edges: [],
      graphSidecar: { model: { id: "orders" } }
    },
    validation: { errors: 0, warnings: 0, findings: [] },
    feedback: { status: "idle", history: [], agent: { connected: false } },
    baseline: { kind: "startup", label: "Startup snapshot" },
    stale: false
  };
}

function twoItems(): FeedbackQueue {
  const session = snapshot();
  return addQueuedFeedback(
    addQueuedFeedback({ items: [] }, captureQueuedFeedback(session, command, "Change save", "item-1")),
    captureQueuedFeedback(session, query, "Change load", "item-2")
  );
}

describe("local feedback Queue", () => {
  it("captures ordered notes without creating an agent request", () => {
    const queue = twoItems();
    expect(queue.items.map((item) => [item.id, item.nodeId, item.message])).toEqual([
      ["item-1", "save", "Change save"],
      ["item-2", "load", "Change load"]
    ]);
    expect(queue.submission).toBeUndefined();
    expect(feedbackBatchUnavailableReason(queue, snapshot(), "current", true, false)).toBeUndefined();
  });

  it("captures canonical IDs and copies identity instead of following later selection changes", () => {
    const displayed = { ...command, id: "current:save" };
    const session = snapshot([displayed]);
    session.currentNodeIds = { "current:save": "save" };
    const item = captureQueuedFeedback(session, displayed, "  Keep the fields  ", "item-1");
    displayed.label = "Renamed";
    session.revision = "revision-2";
    expect(item).toMatchObject({
      nodeId: "save",
      reference: "em://orders/save",
      revision: "revision-1",
      identity: { label: "Save" },
      message: "Keep the fields"
    });
    const unchanged = snapshot([{ ...command, id: "current:save" }]);
    unchanged.currentNodeIds = { "current:save": "save" };
    expect(queuedFeedbackUnavailableReason(item, unchanged)).toBeUndefined();
  });

  it("edits only words, removes by item ID, and keeps same-target notes separate", () => {
    const original = twoItems();
    const duplicate = captureQueuedFeedback(snapshot(), command, "Change save", "item-3");
    let queue = addQueuedFeedback(original, duplicate);
    queue = editQueuedFeedback({ ...queue, editing: { id: "item-1", message: "Updated" } }, "item-1", "Updated");
    expect(queue.items[0]).toEqual({ ...original.items[0], message: "Updated" });
    expect(queue.editing).toBeUndefined();
    queue = removeQueuedFeedback(queue, "item-1");
    expect(queue.items.map((item) => item.id)).toEqual(["item-2", "item-3"]);
    expect(original.items[0].message).toBe("Change save");
  });

  it("enforces item, message, aggregate-character, and encoded-body limits without dropping items", () => {
    const item = captureQueuedFeedback(snapshot(), command, "x", "item");
    const twenty = Array.from({ length: 20 }, (_, index) => ({ ...item, id: "item-" + index }));
    expect(feedbackQueueLimitReason(twenty)).toBeUndefined();
    const full = { items: twenty };
    expect(addQueuedFeedback(full, { ...item, id: "extra" }).items).toEqual(twenty);
    expect(feedbackQueueLimitReason([{ ...item, message: "x".repeat(4001) }])).toBeDefined();
    expect(feedbackQueueLimitReason(Array.from({ length: 5 }, (_, index) => ({ ...item, id: String(index), message: "x".repeat(4000) })))).toBeDefined();
    const unicode = twenty.map((entry) => ({ ...entry, nodeId: "界".repeat(500), reference: "界".repeat(1000), message: "界".repeat(800) }));
    expect(feedbackQueueLimitReason(unicode)).toMatch(/128 KiB/);
  });

  it("requires explicit review after revision, reference, target, or session changes", () => {
    const queue = twoItems();
    const session = snapshot();
    expect(queuedFeedbackUnavailableReason(queue.items[0], { ...session, revision: "revision-2" })).toMatch(/model changed/);
    expect(queuedFeedbackUnavailableReason(queue.items[0], { ...session, sessionId: "session-2" })).toMatch(/previous session/);
    expect(queuedFeedbackUnavailableReason(queue.items[0], { ...session, project: { ...session.project, root: "/other-project" } })).toMatch(/another project/);
    expect(queuedFeedbackUnavailableReason(queue.items[0], snapshot([query]))).toMatch(/missing or ambiguous/);
    expect(queuedFeedbackUnavailableReason(queue.items[0], snapshot([{ ...command, sourceName: "Renamed" }, query]))).toMatch(/missing or ambiguous/);
    expect(queuedFeedbackUnavailableReason(queue.items[0], snapshot([command, { ...command, id: "duplicate" }]))).toMatch(/missing or ambiguous/);
    expect(queuedFeedbackUnavailableReason({ ...queue.items[0], reference: "em://wrong/save" }, session)).toMatch(/reference changed/);
    expect(queue.items[0].revision).toBe("revision-1");
  });

  it("blocks historical, unmapped, and ambiguous targets before they enter the Queue", () => {
    const session = snapshot();
    expect(feedbackTargetUnavailableReason(session, "session", true, command, undefined, true)).toMatch(/New version/);
    expect(feedbackTargetUnavailableReason(session, "turn", true, command)).toMatch(/Current or Session/);
    expect(feedbackTargetUnavailableReason({ ...session, currentNodeIds: undefined }, "session", true, command)).toMatch(/Refresh/);
    expect(feedbackTargetUnavailableReason({ ...session, currentNodeIds: {} }, "current", true, command)).toMatch(/unique current target/);
    expect(feedbackTargetUnavailableReason(snapshot([command, { ...command, id: "duplicate" }]), "current", true, command)).toMatch(/ambiguous/);
    expect(feedbackTargetUnavailableReason(session, "current", false, command)).toMatch(/Reconnect/);
  });

  it("blocks a first send when stale, busy, stopped, historical, or still editing", () => {
    const queue = twoItems();
    const session = snapshot();
    expect(feedbackBatchUnavailableReason(queue, { ...session, stale: true }, "current", true, false)).toBeDefined();
    expect(feedbackBatchUnavailableReason(queue, { ...session, revision: "new-revision" }, "current", true, false)).toBeDefined();
    expect(feedbackBatchUnavailableReason(queue, { ...session, feedback: { ...session.feedback, status: "working" } }, "current", true, false)).toBeDefined();
    expect(feedbackBatchUnavailableReason(queue, { ...session, feedback: { ...session.feedback, status: "stopped" } }, "current", true, false)).toBeDefined();
    expect(feedbackBatchUnavailableReason(queue, session, "turn", true, false)).toBeDefined();
    const editing = { ...queue, editing: { id: "item-1", message: "Unfinished" } };
    expect(feedbackBatchUnavailableReason(editing, session, "current", true, false)).toMatch(/Save or cancel/);
    expect(beginFeedbackSubmission(editing, "batch")).toBe(editing);
  });
});

describe("batch acknowledgement and retry", () => {
  it("accepts only a confirmed batch ID and the exact ordered response items", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    const body = sending.submission!.body;
    const response = { id: "server-request", ...body };
    expect(matchesFeedbackBatchResponse(response, body)).toBe(true);
    expect(matchesFeedbackBatchResponse("<html>Not the server</html>", body)).toBe(false);
    expect(matchesFeedbackBatchResponse({ ...response, id: "" }, body)).toBe(false);
    expect(matchesFeedbackBatchResponse({ ...response, clientBatchId: "other" }, body)).toBe(false);
    expect(matchesFeedbackBatchResponse({ ...response, items: [...body.items].reverse() }, body)).toBe(false);
    expect(matchesFeedbackBatchResponse({ ...response, items: body.items.slice(0, 1) }, body)).toBe(false);
    expect(matchesFeedbackBatchResponse({ ...response, items: body.items.map((item) => ({ ...item, message: "different" })) }, body)).toBe(false);
  });

  it("freezes one ordered payload and locks its items across uncertain failures", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    expect(sending.submission?.body).toEqual({
      clientBatchId: "batch-1",
      items: [
        { id: "item-1", nodeId: "save", reference: "em://orders/save", revision: "revision-1", message: "Change save" },
        { id: "item-2", nodeId: "load", reference: "em://orders/load", revision: "revision-1", message: "Change load" }
      ]
    });
    expect(beginFeedbackSubmission(sending, "duplicate-click")).toBe(sending);
    const uncertain = failFeedbackSubmission(sending, "batch-1", "Timed out", true);
    expect(queuedFeedbackLocked(uncertain, "item-1")).toBe(true);
    expect(editQueuedFeedback(uncertain, "item-1", "Changed")).toBe(uncertain);
    expect(removeQueuedFeedback(uncertain, "item-1")).toBe(uncertain);
    const retry = beginFeedbackSubmission(uncertain, "do-not-use-this-id");
    expect(retry.submission?.body).toEqual(sending.submission?.body);
  });

  it("allows same-session retry after the agent changed files or the session stopped", () => {
    const uncertain = failFeedbackSubmission(beginFeedbackSubmission(twoItems(), "batch-1"), "batch-1", "Timed out", true);
    const session = snapshot();
    const changed = { ...session, revision: "new-revision", stale: true, feedback: { ...session.feedback, status: "stopped" as const } };
    expect(feedbackBatchUnavailableReason(uncertain, changed, "turn", true, false)).toBeUndefined();
    expect(feedbackBatchUnavailableReason(uncertain, changed, "turn", false, false)).toMatch(/Reconnect/);
  });

  it("accepts future local notes but acknowledges only the frozen batch", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    const withFuture = addQueuedFeedback(sending, captureQueuedFeedback(snapshot(), query, "Next turn", "future"));
    expect(withFuture.submission?.body.items).toHaveLength(2);
    expect(acknowledgeFeedbackSubmission(withFuture, "different-batch")).toBe(withFuture);
    const acknowledged = acknowledgeFeedbackSubmission(withFuture, "batch-1");
    expect(acknowledged.items.map((item) => item.id)).toEqual(["future"]);
    expect(acknowledged.submission).toBeUndefined();
  });

  it("preserves the Queue and unlocks edits after a confirmed rejection", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    const rejected = failFeedbackSubmission(sending, "batch-1", "Stale revision", false);
    expect(rejected.items).toEqual(sending.items);
    expect(rejected.submission).toBeUndefined();
    expect(editQueuedFeedback(rejected, "item-1", "Revised").items[0].message).toBe("Revised");
  });

  it("reconciles a lost response against exact items in request or history", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    const session = snapshot();
    const request = {
      id: "request-1", clientRequestId: "batch-1", clientBatchId: "batch-1",
      nodeId: "save", reference: "em://orders/save", message: "Combined", createdAt: 1,
      items: sending.submission!.body.items
    };
    expect(reconcileFeedbackQueue(sending, { ...session, feedback: { ...session.feedback, request } }).items).toEqual([]);
    expect(reconcileFeedbackQueue(sending, { ...session, feedback: { ...session.feedback, history: [request] } }).items).toEqual([]);
    const mismatch = { ...request, items: request.items.map((item) => ({ ...item, message: "Unexpected" })) };
    const preserved = reconcileFeedbackQueue(sending, { ...session, feedback: { ...session.feedback, request: mismatch } });
    expect(preserved.items).toEqual(sending.items);
    expect(preserved.submission?.phase).toBe("uncertain");
  });

  it("requires explicit release after restart and never retargets the old batch", () => {
    const sending = beginFeedbackSubmission(twoItems(), "batch-1");
    const restarted = { ...snapshot(), sessionId: "session-2" };
    const queue = reconcileFeedbackQueue(sending, restarted);
    expect(queue.submission?.body).toEqual(sending.submission?.body);
    expect(feedbackBatchUnavailableReason(queue, restarted, "current", true, false)).toMatch(/restarted/);
    expect(releasePreviousFeedbackSubmission(queue, snapshot())).toBe(queue);
    const released = releasePreviousFeedbackSubmission(queue, restarted);
    expect(released.submission).toBeUndefined();
    expect(released.items).toEqual(sending.items);
    expect(feedbackBatchUnavailableReason(released, restarted, "current", true, false)).toMatch(/flagged/);
  });
});

describe("reload recovery", () => {
  it("restores drafts, Queue edits, and frozen IDs without persisting the session token", () => {
    const session = snapshot();
    const workspace = {
      ...emptyFeedbackWorkspace(),
      drafts: updateFeedbackDraft({}, session.sessionId, command, "Draft survives"),
      queue: { ...twoItems(), editing: { id: "item-2", message: "Unfinished edit" } }
    };
    const serialized = serializeFeedbackWorkspace(workspace);
    expect(serialized).not.toContain(session.token);
    const recovered = restoreFeedbackWorkspace(serialized);
    expect(recovered.drafts[feedbackDraftKey(session.sessionId, command)].message).toBe("Draft survives");
    expect(recovered.queue).toEqual(workspace.queue);
    const sending = { ...workspace, queue: beginFeedbackSubmission(twoItems(), "batch-1") };
    const recoveredSend = restoreFeedbackWorkspace(serializeFeedbackWorkspace(sending));
    expect(recoveredSend.queue.submission?.phase).toBe("uncertain");
    expect(recoveredSend.queue.submission?.body).toEqual(sending.queue.submission?.body);
    expect(recoveredSend.recoveryWarning).toBeUndefined();
  });

  it("flags damaged storage for review instead of silently presenting it as an empty saved Queue", () => {
    expect(restoreFeedbackWorkspace(null)).toEqual(emptyFeedbackWorkspace());
    expect(restoreFeedbackWorkspace("{broken").recoveryWarning).toBeDefined();
    const partial = JSON.stringify({ version: 1, drafts: {}, queue: { items: [twoItems().items[0], { message: "Lost target" }] } });
    const recovered = restoreFeedbackWorkspace(partial);
    expect(recovered.queue.items.map((item) => item.id)).toEqual(["item-1"]);
    expect(recovered.recoveryWarning).toBeDefined();
  });
});
