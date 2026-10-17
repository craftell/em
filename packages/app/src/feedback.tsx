import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GraphDiff, ProjectNode } from "./types";
import { apiFetch, createClientRequestId } from "./api";
import {
  feedbackUnavailableReason,
  feedbackDraftKey,
  type FeedbackDraft,
  isFeedbackSession,
  type FeedbackSession,
  type FeedbackView
} from "./feedbackState";

type Connection = "checking" | "live" | "offline" | "unavailable";
type SessionCommand = "request" | "stop" | "start";

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
      if (!response.ok) throw new Error(await responseError(response));
    } catch (caught) {
      if (mounted.current) setPending(false);
      throw controller.signal.aborted ? new Error("The server did not confirm the request. The session is refreshing before you retry.") : caught;
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

export function FeedbackSessionBar({
  session,
  view,
  onView,
  drafts
}: {
  session: SessionController;
  view: FeedbackView;
  onView: (view: FeedbackView) => void;
  drafts: FeedbackDraft[];
}) {
  const [commandError, setCommandError] = useState<string>();
  const bar = useRef<HTMLElement | null>(null);
  const snapshot = session.snapshot;
  useLayoutEffect(() => {
    const element = bar.current;
    const shell = element?.closest<HTMLElement>(".app-shell");
    if (!element || !shell) return;
    const measure = () => shell.style.setProperty("--feedback-bottom", (element.offsetTop + element.offsetHeight + 12) + "px");
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      shell.style.removeProperty("--feedback-bottom");
    };
  }, [snapshot?.sessionId]);
  if (!snapshot) return null;
  const feedback = snapshot.feedback;
  const connected = session.connection === "live" && session.snapshotView === view;
  const changeSession = (action: "stop" | "start") => {
    setCommandError(undefined);
    void session.command(action, {}).catch((caught) => setCommandError(errorMessage(caught)));
  };
  const currentRequest = feedback.request;
  const history = feedback.history.filter((request) => request.id !== currentRequest?.id);
  const requests = currentRequest ? [...history, currentRequest] : history;

  return (
    <section ref={bar} className="feedback-session" aria-label="Feedback session">
      <div className="feedback-session-row">
        <div className="segmented" role="group" aria-label="Model view">
          {([["current", "Current"], ["session", "Session diff"], ["turn", "Turn diff"]] as const).map(([mode, label]) => (
            <button type="button" key={mode} aria-pressed={view === mode} onClick={() => onView(mode)}>{label}</button>
          ))}
        </div>
        <span className={"feedback-state feedback-state-" + feedback.status} role="status">
          {statusLabels[feedback.status]} · {feedback.agent.connected ? "Agent connected" : "Agent disconnected"}
        </span>
        <span className="feedback-baseline">Baseline {snapshot.baseline.kind === "startup" ? "startup snapshot" : "Git"} · {snapshot.baseline.label}</span>
        <button type="button" onClick={session.refresh} disabled={session.pending}>Refresh</button>
        {feedback.status === "stopped" ? (
          <button type="button" onClick={() => changeSession("start")} disabled={!connected || session.pending}>Resume session</button>
        ) : (
          <button type="button" onClick={() => changeSession("stop")} disabled={!connected || session.pending}>Stop session</button>
        )}
        <FeedbackDraftRecovery drafts={drafts} snapshot={snapshot} />
        {requests.length ? (
          <details className="feedback-history">
            <summary>Feedback history ({requests.length})</summary>
            <ol aria-label="Feedback history">
              {requests.map((request) => (
                <li key={request.id} data-request-id={request.id}>
                  <code>{request.reference}</code>
                  <p>{request.message}</p>
                  {request.reply ? <p className="feedback-reply">{request.reply}</p> : <p className="muted">{request.id === currentRequest?.id ? statusLabels[feedback.status] : "No reply recorded."}</p>}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      {session.connection === "checking" ? <p role="status">Refreshing the model...</p> : null}
      {session.error || snapshot.error || feedback.error || commandError ? <p className="feedback-error" role="alert">{commandError ?? session.error ?? snapshot.error ?? feedback.error}</p> : null}
      {snapshot.stale || session.connection === "offline" ? <p className="feedback-warning">Showing the last available model. Feedback is disabled until the project reconnects and loads valid files.</p> : null}
      {session.changedSession ? <p className="feedback-warning">The project server restarted. The previous session history is no longer available.</p> : null}
      {feedback.status === "stopped" ? (
        <p className="feedback-warning">The session is stopped. Stop your external editor before resuming. Stop session cannot stop an external process or undo its file writes.</p>
      ) : (
        <p className="feedback-note">Stop session cancels feedback. It cannot stop an external agent process or its file writes.</p>
      )}
    </section>
  );
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

export function FeedbackComposer({
  session,
  view,
  node,
  diff,
  showingBefore,
  message,
  onMessageChange,
  onSent
}: {
  session: SessionController;
  view: FeedbackView;
  node: ProjectNode;
  diff?: GraphDiff;
  showingBefore: boolean;
  message: string;
  onMessageChange: (message: string) => void;
  onSent: (message: string) => void;
}) {
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);
  const submission = useRef<{ key: string; clientRequestId: string } | undefined>(undefined);
  const connected = session.connection === "live" && session.snapshotView === view;
  const reason = feedbackUnavailableReason(session.snapshot, view, connected, session.pending, node, diff, showingBefore);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (reason || !message.trim() || message.length > 4000 || !session.snapshot) return;
    setError(undefined);
    setSent(false);
    const body = { nodeId: node.id, revision: session.snapshot.revision, message: message.trim() };
    const key = JSON.stringify(body);
    if (submission.current?.key !== key) submission.current = { key, clientRequestId: createClientRequestId() };
    try {
      await session.command("request", { ...body, clientRequestId: submission.current.clientRequestId });
      onSent(message);
      submission.current = undefined;
      setSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <form className="feedback-composer" aria-label="Node feedback" onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
      <h3>Send feedback to your agent</h3>
      <label htmlFor="feedback-message">Feedback message</label>
      <textarea
        id="feedback-message"
        value={message}
        maxLength={4000}
        rows={4}
        disabled={Boolean(reason)}
        aria-describedby="feedback-help"
        placeholder="Describe the change you want for this node."
        onChange={(event) => { onMessageChange(event.target.value); setSent(false); }}
      />
      <p className="muted" id="feedback-help">{reason ?? "The external agent receives this node's current source, connections, and validation findings."}</p>
      <div className="feedback-composer-actions">
        <small>{message.length}/4000</small>
        <button type="submit" disabled={Boolean(reason) || !message.trim() || message.length > 4000}>Send feedback</button>
      </div>
      {error ? <p className="feedback-error" role="alert">{error}</p> : null}
      {sent ? <p role="status">Feedback queued for your external agent.</p> : null}
    </form>
  );
}
