import { describe, expect, it } from "vitest";
import {
  connectionsAfter,
  connectionsBefore,
  feedbackUnavailableReason,
  feedbackDraftKey,
  updateFeedbackDraft,
  isFeedbackSession,
  previousNodeFor,
  resolveSelection,
  selectionForNode,
  type FeedbackSession
} from "./feedbackState";
import type { EventModelProject, GraphDiff, ProjectNode } from "./types";

function project(nodes: ProjectNode[]): EventModelProject {
  return {
    root: "/project",
    config: { paths: { eventModelDir: "event-model", featuresDir: "event-model/features", sliceExtension: ".slice.yaml", eventsFile: "event-model/events.yaml", storiesDir: "event-model/stories" } },
    events: [],
    stories: [],
    slices: [],
    nodes,
    edges: []
  };
}

const command: ProjectNode = { id: "command-1", type: "command", label: "Save", sourceName: "Save", sourcePath: "save.slice.yaml", sliceTitle: "Save item", fields: "id: string" };

function snapshot(model = project([command])): FeedbackSession {
  return {
    sessionId: "session-1",
    token: "test-session-token",
    revision: "revision-1",
    currentNodeIds: Object.fromEntries(model.nodes.map((node) => [node.id, node.id])),
    project: model,
    validation: { errors: 0, warnings: 0, findings: [] },
    feedback: { status: "idle", history: [], agent: { connected: false } },
    baseline: { kind: "startup", label: "Startup snapshot" },
    stale: false
  };
}

function diff(): GraphDiff {
  const summary = { added: 1, removed: 1, changed: 1, unchanged: 0 };
  return {
    base: { label: "Before" },
    target: { label: "After" },
    nodeStatus: { "command-1": "changed", added: "added", removed: "removed" },
    edgeStatus: { added: "added", removed: "removed", changed: "changed" },
    previousNodes: { "command-1": { ...command, fields: "old: string" } },
    summary: { nodes: summary, edges: summary }
  };
}

describe("semantic selection", () => {
  it("preserves the selected node when its ID changes", () => {
    const before = project([command]);
    const selected = selectionForNode(before, command.id);
    const after = project([{ ...command, id: "new-id" }]);
    expect(resolveSelection(after, selected)?.id).toBe("new-id");
  });

  it("does not follow an ID reused by a different semantic node", () => {
    const before = project([command]);
    const selected = selectionForNode(before, command.id);
    const after = project([{ ...command, label: "Delete", sourceName: "Delete" }]);
    expect(resolveSelection(after, selected)).toBeUndefined();
  });

  it("allows selecting a duplicate in the displayed snapshot but clears ambiguous refreshes", () => {
    const before = project([command, { ...command, id: "duplicate" }]);
    const selected = selectionForNode(before, "duplicate");
    expect(resolveSelection(before, selected)?.id).toBe("duplicate");
    expect(resolveSelection(project(before.nodes.map((node) => ({ ...node }))), selected)).toBeUndefined();
  });

  it("keeps same-named nodes in different source files separate", () => {
    const before = project([command, { ...command, id: "other", sourcePath: "other.slice.yaml" }]);
    const selected = selectionForNode(before, "other");
    const after = project(before.nodes.map((node) => ({ ...node, id: "new-" + node.id })));
    expect(resolveSelection(after, selected)?.id).toBe("new-other");
  });
});

describe("feedback drafts", () => {
  it("keeps drafts attached to the original semantic target after renames and deletion", () => {
    const before = project([command]);
    const selection = selectionForNode(before, command.id);
    const drafts = updateFeedbackDraft({}, "session-1", command, "Keep this unsent change");
    const key = feedbackDraftKey("session-1", command);
    const renamed = { ...command, label: "Rename", sourceName: "Rename" };
    expect(resolveSelection(project([renamed]), selection)).toBeUndefined();
    expect(resolveSelection(project([]), selection)).toBeUndefined();
    expect(drafts[key].identity.label).toBe("Save");
    expect(drafts[key].message).toBe("Keep this unsent change");
    expect(drafts[feedbackDraftKey("session-1", renamed)]).toBeUndefined();
    expect(drafts[feedbackDraftKey("session-2", command)]).toBeUndefined();
    const remapped = { ...command, id: "new-id" };
    expect(drafts[feedbackDraftKey("session-1", remapped)].message).toBe("Keep this unsent change");
  });

  it("keeps drafts separate across targets and sessions, and clears only the submitted message", () => {
    const other = { ...command, id: "other", sourcePath: "other.slice.yaml" };
    let drafts = updateFeedbackDraft({}, "session-1", command, "First draft");
    drafts = updateFeedbackDraft(drafts, "session-1", other, "Other draft");
    drafts = updateFeedbackDraft(drafts, "session-2", command, "Restarted draft");
    drafts = updateFeedbackDraft(drafts, "session-1", command, "Edited draft");
    drafts = updateFeedbackDraft(drafts, "session-1", command, "", "First draft");
    expect(drafts[feedbackDraftKey("session-1", command)].message).toBe("Edited draft");
    drafts = updateFeedbackDraft(drafts, "session-1", command, "", "Edited draft");
    expect(drafts[feedbackDraftKey("session-1", command)]).toBeUndefined();
    expect(drafts[feedbackDraftKey("session-1", other)].message).toBe("Other draft");
    expect(drafts[feedbackDraftKey("session-2", command)].message).toBe("Restarted draft");
  });
});

describe("node versions", () => {
  it("uses previousNodes for ordinary nodes and keeps the GWT fallback", () => {
    expect(previousNodeFor(diff(), command)?.fields).toBe("old: string");
    const scenario: ProjectNode = { id: "gwt", type: "gwt", label: "Example" };
    expect(previousNodeFor({ ...diff(), nodeStatus: { gwt: "changed" }, previousGwtNodes: { gwt: scenario } }, scenario)).toEqual(scenario);
  });

  it("uses the matching before and after connections", () => {
    const model = project([command, { id: "added", type: "event", label: "New event" }, { id: "removed", type: "event", label: "Old event" }]);
    model.edges = [
      { id: "added", source: command.id, target: "added", kind: "command-event" },
      { id: "removed", source: command.id, target: "removed", kind: "command-event" }
    ];
    const before = connectionsBefore(model, diff());
    expect(before.nodes.map((node) => node.id)).toEqual(["command-1", "removed"]);
    expect(before.nodes[0].fields).toBe("old: string");
    expect(before.edges.map((edge) => edge.id)).toEqual(["removed"]);
    expect(connectionsAfter(model, diff()).edges.map((edge) => edge.id)).toEqual(["added"]);
    expect(model.nodes[0].fields).toBe("id: string");
  });

  it("preserves merged edge endpoints when raw base IDs collide or change", () => {
    const model = project([
      { ...command, id: "merged-command" },
      { id: "event", type: "event", label: "Replacement event" },
      { id: "current:event", type: "event", label: "Original event" }
    ]);
    model.edges = [{ id: "merged-edge", source: "merged-command", target: "current:event", kind: "command-event", label: "new label" }];
    const changes = {
      ...diff(),
      nodeStatus: { "merged-command": "unchanged" as const, event: "added" as const, "current:event": "unchanged" as const },
      edgeStatus: { "merged-edge": "changed" as const },
      previousEdges: { "merged-edge": { id: "old-edge", source: "command-1", target: "event", kind: "command-event", label: "old label" } }
    };
    const before = connectionsBefore(model, changes);
    expect(before.edges).toEqual([{ id: "merged-edge", source: "merged-command", target: "current:event", kind: "command-event", label: "old label" }]);
    expect(before.nodes.find((node) => node.id === before.edges[0].target)?.label).toBe("Original event");
    expect(model.edges[0].label).toBe("new label");
  });
});

describe("feedback availability", () => {
  it("allows a unique current node even when the agent has not connected yet", () => {
    expect(feedbackUnavailableReason(snapshot(), "current", true, false, command)).toBeUndefined();
  });

  it("blocks removed, stale, disconnected, ambiguous, busy, stopped, and historical targets", () => {
    const current = snapshot();
    const removed = { ...diff(), nodeStatus: { [command.id]: "removed" as const } };
    expect(feedbackUnavailableReason(current, "session", true, false, command, removed)).toMatch(/removed/);
    expect(feedbackUnavailableReason({ ...current, stale: true }, "current", true, false, command)).toMatch(/stale/);
    expect(feedbackUnavailableReason(current, "current", false, false, command)).toMatch(/Reconnect/);
    expect(feedbackUnavailableReason(snapshot(project([command, { ...command, id: "duplicate" }])), "current", true, false, command)).toMatch(/ambiguous/);
    expect(feedbackUnavailableReason({ ...current, feedback: { ...current.feedback, status: "working" } }, "current", true, false, command)).toMatch(/Wait/);
    expect(feedbackUnavailableReason({ ...current, feedback: { ...current.feedback, status: "stopped" } }, "current", true, false, command)).toMatch(/stopped/);
    expect(feedbackUnavailableReason(current, "turn", true, false, command)).toMatch(/Switch/);
    expect(feedbackUnavailableReason(current, "session", true, false, command, diff(), true)).toMatch(/New version/);
    expect(feedbackUnavailableReason(current, "session", true, false, command, diff(), false)).toBeUndefined();
  });

  it("rejects unrelated legacy payloads at the session boundary", () => {
    expect(isFeedbackSession(snapshot())).toBe(true);
    expect(isFeedbackSession({ findings: [], errors: 0, warnings: 0 })).toBe(false);
    expect(isFeedbackSession({ ...snapshot(), revision: 2 })).toBe(false);
  });
});
