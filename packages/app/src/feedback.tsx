import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GraphDiff, ProjectNode } from "./types";
import { apiFetch, createClientRequestId } from "./api";
import {
  feedbackTargetUnavailableReason,
  feedbackDraftKey,
  type FeedbackDraft,
  isFeedbackSession,
  type FeedbackSession,
  type FeedbackView
} from "./feedbackState";
import {
  FEEDBACK_MESSAGE_LIMIT,
  FEEDBACK_QUEUE_LIMIT,
  acknowledgeFeedbackSubmission,
  addQueuedFeedback,
  beginFeedbackSubmission,
  captureQueuedFeedback,
  editQueuedFeedback,
  failFeedbackSubmission,
  feedbackBatchUnavailableReason,
  feedbackQueueLimitReason,
  queuedFeedbackLocked,
  matchesFeedbackBatchResponse,
  queuedFeedbackUnavailableReason,
  removeQueuedFeedback,
  releasePreviousFeedbackSubmission,
  type FeedbackQueue
} from "./feedbackQueue";

type Connection = "checking" | "live" | "offline" | "unavailable";
type SessionCommand = "request" | "batch" | "stop" | "start";

export type SessionController = {
  snapshot?: FeedbackSession;
  snapshotView?: FeedbackView;
  connection: Connection;
  error?: string;
  changedSession: boolean;
  pending: boolean;
  refresh: () => void;
  command: (action: SessionCommand, body: Record<string, unknown>) => Promise<void>;
};

export class FeedbackCommandError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
    this.name = "FeedbackCommandError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof payload?.error === "string" ? payload.error : "Request failed (" + response.status + ").";
}

export function useFeedbackSession(enabled: boolean, view: FeedbackView): SessionController {
  const [snapshot, setSnapshot] = useState<FeedbackSession>();
  const [snapshotView, setSnapshotView] = useState<FeedbackView>();
  const [connection, setConnection] = useState<Connection>("checking");
  const [error, setError] = useState<string>();
  const [changedSession, setChangedSession] = useState(false);
  const [pending, setPending] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const sessionId = useRef<string | undefined>(undefined);
  const commandBusy = useRef(false);
  const mounted = useRef(true);
  const commandController = useRef<AbortController | null>(null);
  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      commandController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | undefined;
    setConnection("checking");

    const poll = async () => {
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      let unavailable = false;
      try {
        const response = await apiFetch("/api/session?view=" + view, { signal: controller.signal, cache: "no-store" });
        if (response.status === 404 && !sessionId.current) {
          unavailable = true;
          if (!disposed) setConnection("unavailable");
          return;
        }
        if (!response.ok) throw new Error(await responseError(response));
        if (!response.headers.get("content-type")?.includes("application/json") && !sessionId.current) {
          unavailable = true;
          if (!disposed) setConnection("unavailable");
          return;
        }
        const next: unknown = await response.json();
        if (!isFeedbackSession(next)) throw new Error("The project server returned an invalid session snapshot.");
        if (disposed) return;
        if (sessionId.current && sessionId.current !== next.sessionId) {
          setChangedSession(true);
          commandController.current?.abort();
          commandBusy.current = false;
        }
        sessionId.current = next.sessionId;
        setSnapshot(next);
        setSnapshotView(view);
        setConnection("live");
        setError(undefined);
        if (!commandBusy.current) setPending(false);
      } catch (caught) {
        if (disposed) return;
        setConnection("offline");
        setError(controller.signal.aborted ? "The project server did not respond. Retrying..." : errorMessage(caught));
        if (!commandBusy.current) setPending(false);
      } finally {
        clearTimeout(timeout);
        if (!disposed && !unavailable) timer = setTimeout(() => void poll(), 1000);
      }
    };

    void poll();
    return () => {
      disposed = true;
      activeController?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, view, refreshVersion]);

  const command = useCallback(async (action: SessionCommand, body: Record<string, unknown>) => {
    if (!snapshot || !enabled || connection !== "live" || snapshotView !== view) {
      throw new Error("Wait for the current session to reconnect.");
    }
    if (commandBusy.current || pending) throw new Error("A request is already in progress.");
    const controller = new AbortController();
    commandController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    commandBusy.current = true;
    setPending(true);
    try {
      const response = await apiFetch("/api/feedback/" + action, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Emviz-Token": snapshot.token },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) throw new FeedbackCommandError(await responseError(response), response.status >= 500);
      if (action === "batch") {
        const accepted: unknown = await response.json().catch(() => undefined);
        if (!matchesFeedbackBatchResponse(accepted, body)) throw new FeedbackCommandError("The server did not return a matching batch confirmation. Refresh to check delivery, or retry the same batch.", true);
      }
    } catch (caught) {
      if (mounted.current) setPending(false);
      if (caught instanceof FeedbackCommandError) throw caught;
      throw new FeedbackCommandError("The server did not confirm the request. Refresh to check its status, or retry the same batch.", true);
    } finally {
      clearTimeout(timeout);
      commandBusy.current = false;
      if (mounted.current) refresh();
    }
  }, [connection, enabled, pending, refresh, snapshot, snapshotView, view]);

  return { snapshot, snapshotView, connection, error, changedSession, pending, refresh, command };
}

const statusLabels = {
  idle: "Idle",
  queued: "Queued",
  working: "Working",
  completed: "Completed",
  stopped: "Stopped"
} as const;

export function AgentPanel({
  session,
  view,
  onView,
  node,
  diff,
  showingBefore,
  message,
  onMessageChange,
  onAdded,
  drafts,
  queue,
  onQueueChange,
  storageNeedsReview
}: {
  session: SessionController;
  view: FeedbackView;
  onView: (view: FeedbackView) => void;
  node?: ProjectNode;
  diff?: GraphDiff;
  showingBefore: boolean;
  message: string;
  onMessageChange: (message: string) => void;
  onAdded: (message: string) => void;
  drafts: FeedbackDraft[];
  queue: FeedbackQueue;
  onQueueChange: React.Dispatch<React.SetStateAction<FeedbackQueue>>;
  storageNeedsReview: boolean;
}) {
  const [commandError, setCommandError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const sendBusy = useRef(false);
  const snapshot = session.snapshot;
  const connected = session.connection === "live" && session.snapshotView === view;
  const targetReason = node ? feedbackTargetUnavailableReason(snapshot, view, connected, node, diff, showingBefore) : "Select a current node to write feedback.";
  const batchReason = storageNeedsReview ? "Review the damaged saved feedback before sending. A previous batch may already have arrived." : feedbackBatchUnavailableReason(queue, snapshot, view, connected, session.pending);
  const candidate = snapshot && node ? captureQueuedFeedback(snapshot, node, message, "preview") : undefined;
  const addReason = targetReason ?? (candidate && message.trim() ? feedbackQueueLimitReason([...queue.items, candidate]) : undefined);
  const feedback = snapshot?.feedback;
  const agentStatusKnown = connected && !snapshot?.stale && !snapshot?.error;
  const agentConnected = agentStatusKnown && feedback?.agent.connected;
  const currentRequest = feedback?.request;
  const history = feedback?.history.filter((request) => request.id !== currentRequest?.id) ?? [];
  const requests = currentRequest ? [...history, currentRequest] : history;

  const changeSession = (action: "stop" | "start") => {
    setCommandError(undefined);
    void session.command(action, {}).catch((caught) => setCommandError(errorMessage(caught)));
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (addReason || !snapshot || !node || !message.trim()) return;
    const item = captureQueuedFeedback(snapshot, node, message, createClientRequestId());
    onQueueChange((current) => addQueuedFeedback(current, item));
    onAdded(message);
  };

  const send = async () => {
    if (batchReason || sendBusy.current) return;
    const next = beginFeedbackSubmission(queue, queue.submission?.body.clientBatchId ?? createClientRequestId());
    const submission = next.submission;
    if (!submission) return;
    sendBusy.current = true;
    onQueueChange(next);
    try {
      await session.command("batch", submission.body);
      onQueueChange((current) => acknowledgeFeedbackSubmission(current, submission.body.clientBatchId));
    } catch (caught) {
      onQueueChange((current) => failFeedbackSubmission(current, submission.body.clientBatchId, errorMessage(caught), caught instanceof FeedbackCommandError && caught.uncertain));
    } finally {
      sendBusy.current = false;
    }
  };

  const copyItem = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Copied queued feedback.");
    } catch {
      setCopyStatus("Copy is unavailable. Select the message text and copy it manually.");
    }
  };

  return <>
    <div className="agent-content">
      <section className="feedback-session" aria-label="Feedback session">
        <div className="feedback-session-heading">
          <h2>Agent</h2>
          <span className={"feedback-state feedback-state-" + (feedback?.status ?? "idle")} role="status">{feedback ? statusLabels[feedback.status] : "No session"}</span>
        </div>
        <p className="agent-presence"><span aria-hidden="true" className={agentConnected ? "presence-dot connected" : "presence-dot"} />{!agentStatusKnown ? "Agent status unavailable" : agentConnected ? "Agent connected" : "Agent disconnected"}</p>
        <div className="feedback-session-actions">
          <button type="button" onClick={session.refresh} disabled={session.pending}>Refresh</button>
          {feedback ? feedback.status === "stopped" ? (
            <button type="button" onClick={() => changeSession("start")} disabled={!connected || session.pending}>Resume session</button>
          ) : (
            <button type="button" onClick={() => changeSession("stop")} disabled={!connected || session.pending}>Stop session</button>
          ) : null}
        </div>
        {snapshot ? <>
          <div className="segmented feedback-views" role="group" aria-label="Model view">
            {([["current", "Current"], ["session", "Session diff"], ["turn", "Turn diff"]] as const).map(([mode, label]) => (
              <button type="button" key={mode} aria-pressed={view === mode} onClick={() => onView(mode)}>{label}</button>
            ))}
          </div>
          <p className="feedback-baseline">Baseline {snapshot.baseline.kind === "startup" ? "startup snapshot" : "Git"} · {snapshot.baseline.label}</p>
        </> : <p className="muted">Feedback is available when a project session is running.</p>}
        {session.connection === "checking" ? <p role="status">Refreshing the model...</p> : null}
        {session.error || snapshot?.error || feedback?.error || commandError ? <p className="feedback-error" role="alert">{commandError ?? session.error ?? snapshot?.error ?? feedback?.error}</p> : null}
        {snapshot?.stale || session.connection === "offline" ? <p className="feedback-warning">Showing the last available model and agent status. Feedback stays local until the project reconnects and loads valid files.</p> : null}
        {session.changedSession ? <p className="feedback-warning">The project server restarted. The previous session history is no longer available.</p> : null}
        {feedback?.status === "stopped" ? (
          <p className="feedback-warning">The session is stopped. Stop your external editor before resuming. Stop session cannot stop an external process or undo its file writes.</p>
        ) : feedback ? (
          <p className="feedback-note">Stop session cancels feedback. It cannot stop an external agent process or its file writes.</p>
        ) : null}
      </section>

      {node && snapshot ? <form className="feedback-composer" aria-label="Node feedback" onSubmit={add}>
        <h3>Feedback for {node.label}</h3>
        <p className="feedback-target"><span>{node.type}</span><code>{candidate?.reference}</code></p>
        <label htmlFor="feedback-message">Feedback message</label>
        <textarea id="feedback-message" value={message} maxLength={FEEDBACK_MESSAGE_LIMIT} rows={4}
          disabled={Boolean(targetReason)} aria-describedby="feedback-help"
          placeholder="Describe the change you want for this node."
          onChange={(event) => onMessageChange(event.target.value)} />
        <p className="muted" id="feedback-help">{addReason ?? "Add this note to your local Queue. Send to Agent sends the whole Queue as one request."}</p>
        <div className="feedback-composer-actions">
          <small>{message.length}/{FEEDBACK_MESSAGE_LIMIT}</small>
          <button type="submit" disabled={Boolean(addReason) || !message.trim()}>Add to Queue</button>
        </div>
      </form> : <p className="agent-empty">Select a current node to write feedback. Your Queue stays here as you move around the model.</p>}

      <section className="feedback-queue" aria-label="Feedback Queue">
        <div className="feedback-queue-heading"><h3>Queue</h3><span>{queue.items.length}/{FEEDBACK_QUEUE_LIMIT} · Unsent</span></div>
        {!queue.items.length ? <p className="muted">No queued feedback. Add notes from the nodes you want to change, then send them together.</p> : <ol>
          {queue.items.map((item) => {
            const locked = queuedFeedbackLocked(queue, item.id);
            const reason = snapshot ? queuedFeedbackUnavailableReason(item, snapshot) : undefined;
            const editing = queue.editing?.id === item.id;
            return <li key={item.id} data-queue-id={item.id} className={reason ? "feedback-queue-item needs-review" : "feedback-queue-item"}>
              <div className="feedback-queue-item-heading"><strong>{item.identity.label}</strong><small>{locked ? queue.submission?.phase === "sending" ? "Sending..." : "Awaiting confirmation" : "Unsent"}</small></div>
              <code>{item.reference}</code>
              <p className="feedback-captured">{item.identity.type} · Revision {item.revision.slice(0, 12)}</p>
              {reason ? <p className="feedback-warning">{reason}</p> : null}
              {editing ? <>
                <label className="sr-only" htmlFor={"queue-edit-" + item.id}>Edit queued feedback for {item.identity.label}</label>
                <textarea id={"queue-edit-" + item.id} value={queue.editing?.message ?? ""} maxLength={FEEDBACK_MESSAGE_LIMIT} rows={4}
                  onChange={(event) => onQueueChange((current) => ({ ...current, editing: { id: item.id, message: event.target.value } }))} />
                <div className="feedback-queue-actions">
                  <button type="button" onClick={() => onQueueChange((current) => editQueuedFeedback(current, item.id, current.editing?.message ?? item.message))} disabled={!queue.editing?.message.trim()}>Save</button>
                  <button type="button" onClick={() => onQueueChange((current) => ({ ...current, editing: undefined }))}>Cancel</button>
                </div>
              </> : <>
                <p className="feedback-message">{item.message}</p>
                <div className="feedback-queue-actions">
                  <button type="button" aria-label={"Edit queued feedback for " + item.identity.label} disabled={locked || Boolean(queue.editing)} onClick={() => onQueueChange((current) => ({ ...current, editing: { id: item.id, message: item.message } }))}>Edit</button>
                  <button type="button" aria-label={"Remove queued feedback for " + item.identity.label} disabled={locked} onClick={() => onQueueChange((current) => removeQueuedFeedback(current, item.id))}>Remove</button>
                  <button type="button" aria-label={"Copy queued feedback for " + item.identity.label} onClick={() => void copyItem(item.message)}>Copy</button>
                </div>
              </>}
            </li>;
          })}
        </ol>}
        {copyStatus ? <p role="status">{copyStatus}</p> : null}
      </section>

      {snapshot ? <FeedbackDraftRecovery drafts={drafts} snapshot={snapshot} /> : null}
      {requests.length ? <details className="feedback-history">
        <summary>Feedback history ({requests.length})</summary>
        <ol aria-label="Feedback history">
          {requests.map((request) => <li key={request.id} data-request-id={request.id}>
            {request.items?.length ? <ul className="feedback-request-items">{request.items.map((item) => <li key={item.id}>
              <code>{item.reference}</code><p>{item.message}</p>
            </li>)}</ul> : <><code>{request.reference}</code><p>{request.message}</p></>}
            {request.reply ? <p className="feedback-reply">{request.reply}</p> : <p className="muted">{request.id === currentRequest?.id && feedback ? statusLabels[feedback.status] : "No reply recorded."}</p>}
          </li>)}
        </ol>
      </details> : null}
    </div>
    <footer className="feedback-send">
      {queue.submission?.phase === "uncertain" ? <p className="feedback-warning">The send is not confirmed. These items are locked so a retry uses the same batch ID and contents. Refresh can confirm delivery without sending again.</p> : null}
      {queue.error ? <p className="feedback-error" role="alert">{queue.error}</p> : null}
      {snapshot && queue.submission && (queue.submission.sessionId !== snapshot.sessionId || queue.submission.projectRoot !== snapshot.project.root) ? <button type="button" onClick={() => onQueueChange((current) => releasePreviousFeedbackSubmission(current, snapshot))}>Release previous-session batch</button> : null}
      {queue.notice ? <p role="status">{queue.notice}</p> : null}
      {batchReason && queue.items.length > 0 ? <p className="muted" id="feedback-send-help">{batchReason}</p> : null}
      <button type="button" className="feedback-send-button" onClick={() => void send()} disabled={Boolean(batchReason)} aria-describedby={batchReason && queue.items.length ? "feedback-send-help" : undefined}>
        {queue.submission?.phase === "sending" ? "Sending..." : queue.submission ? "Retry same batch" : "Send to Agent"}
      </button>
      <small>{queue.items.length} queued {queue.items.length === 1 ? "item" : "items"} · One agent request</small>
    </footer>
  </>;
}

function FeedbackDraftRecovery({ drafts, snapshot }: { drafts: FeedbackDraft[]; snapshot: FeedbackSession }) {
  const [copyStatus, setCopyStatus] = useState<string>();
  if (!drafts.length) return null;
  const copy = async (draft: FeedbackDraft) => {
    try {
      await navigator.clipboard.writeText(draft.message);
      setCopyStatus("Copied draft for " + draft.identity.label + ".");
    } catch {
      setCopyStatus("Copy is unavailable. Select the draft text below and copy it manually.");
    }
  };
  return (
    <details className="feedback-history">
      <summary>Unsent feedback drafts ({drafts.length})</summary>
      <ol aria-label="Unsent feedback drafts">
        {drafts.map((draft) => {
          const key = feedbackDraftKey(draft.sessionId, draft.identity);
          const matches = snapshot.project.nodes.filter((node) => feedbackDraftKey(snapshot.sessionId, node) === key && snapshot.diff?.nodeStatus[node.id] !== "removed");
          const note = draft.sessionId !== snapshot.sessionId
            ? "Saved from a previous session. Copy the text before starting new feedback."
            : matches.length === 1
              ? "Saved for the original node. Select that node to continue, or copy the text."
              : "The original node is no longer available or is ambiguous. Copy this draft to recover it.";
          return <li key={key}>
            <strong>{draft.identity.label}</strong>
            <p className="muted">{draft.identity.type} · {draft.identity.sourcePath ?? "No source path"}</p>
            <p className="feedback-warning">{note}</p>
            <p>{draft.message}</p>
            <button type="button" onClick={() => void copy(draft)}>Copy draft</button>
          </li>;
        })}
        {copyStatus ? <li role="status">{copyStatus}</li> : null}
      </ol>
    </details>
  );
}

