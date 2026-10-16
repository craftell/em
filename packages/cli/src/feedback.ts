import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEventModelProject, findProjectRoot, readConfig, type EventModelProject } from "@emviz/parser";
import { diffEventModelProjects, readGraphSidecar } from "@emviz/graph";
import { validateEventModelProject } from "@emviz/validator";

export class FeedbackError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Snapshot = {
  project: EventModelProject;
  revision: string;
  files: Map<string, string>;
  graphSidecar: ReturnType<typeof readGraphSidecar>;
};

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

type RequestContext = {
  request: FeedbackRequest;
  revision: string;
  sourcePath?: string;
  yaml: string;
  context: string;
};

type RequestState =
  | { status: "idle" }
  | { status: "queued"; context: RequestContext }
  | { status: "working"; context: RequestContext; agentId: string; before: Snapshot }
  | { status: "completed"; context: RequestContext; agentId: string; before: Snapshot; after: Snapshot }
  | { status: "stopped"; context?: RequestContext };

function withinRoot(root: string, file: string): string {
  const resolved = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new FeedbackError(400, "Model sources must stay inside the project directory.");
  return resolved;
}

function validateConfiguredPaths(root: string): void {
  const config = readConfig(root);
  for (const value of [config.paths.eventModelDir, config.paths.featuresDir, config.paths.eventsFile, config.paths.storiesDir]) {
    const relative = path.relative(root, path.resolve(root, value));
    if (path.isAbsolute(value) || relative.startsWith("..") || path.isAbsolute(relative)) throw new FeedbackError(400, "Model configuration paths must stay inside the project directory.");
    if (fs.existsSync(path.resolve(root, value))) withinRoot(root, value);
  }
}

export function readSnapshot(target: string): Snapshot {
  validateConfiguredPaths(findProjectRoot(target));
  const project = loadEventModelProject(target);
  const sources = new Set([
    ".event-modeling/config.yaml", project.config.paths.eventsFile,
    ...project.stories.map((story) => story.path), ...project.slices.map((slice) => slice.path)
  ]);
  if (fs.existsSync(path.join(project.root, ".event-modeling/graph.json"))) sources.add(".event-modeling/graph.json");
  if (sources.size > 512) throw new FeedbackError(413, "Feedback supports at most 512 model files.");
  let bytes = 0;
  const files = new Map<string, string>();
  const hash = createHash("sha256");
  for (const source of [...sources].sort()) {
    const file = withinRoot(project.root, source);
    if (fs.statSync(file).size + bytes > 8 * 1024 * 1024) throw new FeedbackError(413, "Feedback supports at most 8 MiB of model files.");
    const content = fs.readFileSync(file, "utf8");
    bytes += Buffer.byteLength(content);
    files.set(source, content);
    hash.update(JSON.stringify([source, content]));
  }
  if (JSON.stringify(loadEventModelProject(target)) !== JSON.stringify(project)) throw new FeedbackError(409, "Model changed while reading. Try again.");
  return { project, revision: hash.digest("hex"), files, graphSidecar: readGraphSidecar(project.root) };
}

function gitBaseline(snapshot: Snapshot): { project: EventModelProject; label: string; kind: "git" | "startup" } {
  const root = snapshot.project.root;
  let temp: string | undefined;
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
    const prefix = path.relative(repoRoot, root).split(path.sep).join("/");
    const names = git(["ls-tree", "--full-tree", "-r", "-z", "--name-only", commit, "--", prefix || "."]).split("\0").filter(Boolean);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-baseline-"));
    fs.mkdirSync(path.join(temp, ".event-modeling"));
    const configPath = (prefix ? prefix + "/" : "") + ".event-modeling/config.yaml";
    fs.writeFileSync(path.join(temp, ".event-modeling/config.yaml"), git(["show", commit + ":" + configPath]));
    validateConfiguredPaths(temp);
    const config = readConfig(temp);
    const modelFiles = names.map((name) => ({ name, local: prefix ? name.slice(prefix.length + 1) : name }))
      .filter(({ local }) => local === ".event-modeling/config.yaml" || local === config.paths.eventsFile || local.endsWith(config.paths.sliceExtension) || (local.startsWith(config.paths.storiesDir + "/") && local.endsWith(".yaml")));
    if (modelFiles.length > 512) throw new Error("Git baseline exceeds 512 files.");
    let bytes = 0;
    for (const { name, local } of modelFiles) {
      const output = path.resolve(temp, local);
      if (path.relative(temp, output).startsWith("..")) throw new Error("Invalid Git path.");
      const content = git(["show", commit + ":" + name]);
      bytes += Buffer.byteLength(content);
      if (bytes > 8 * 1024 * 1024) throw new Error("Git baseline exceeds 8 MiB.");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, content);
    }
    const project = loadEventModelProject(temp);
    return { project: { ...project, root }, label: commit, kind: "git" };
  } catch (error) {
    return { project: structuredClone(snapshot.project), label: "Startup snapshot (Git baseline unavailable: " + (error instanceof Error ? error.message.split("\n")[0] : "unknown error") + ")", kind: "startup" };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

function textField(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new FeedbackError(400, name + " must contain 1 to " + max + " characters.");
  return value;
}

export class FeedbackSession {
  readonly id = randomUUID();
  readonly token = randomUUID();
  private current: Snapshot;
  private baseline: ReturnType<typeof gitBaseline>;
  private state: RequestState = { status: "idle" };
  private history: FeedbackRequest[] = [];
  private lastSeen?: number;
  private error?: string;
  private waiter?: () => void;
  private polling = false;

  constructor(private target: string) {
    this.current = readSnapshot(target);
    this.baseline = gitBaseline(this.current);
  }

  refresh(): Snapshot {
    try {
      this.current = readSnapshot(this.target);
      this.error = undefined;
      return this.current;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw new FeedbackError(422, this.error);
    }
  }

  private archive(request: FeedbackRequest): void {
    this.history = [...this.history.filter((entry) => entry.id !== request.id), { ...request }].slice(-20);
  }

  snapshot(view: string) {
    try { this.refresh(); } catch {}
    let displayed = this.current;
    let project = displayed.project;
    let diff: ReturnType<typeof diffEventModelProjects>["diff"] | undefined;
    if (view === "session") {
      const result = diffEventModelProjects(this.baseline.project, project, { base: this.baseline.label, target: "Working tree (all edits)" });
      project = result.project;
      diff = result.diff;
    } else if (view === "turn" && (this.state.status === "working" || this.state.status === "completed")) {
      const after = this.state.status === "completed" ? this.state.after : this.current;
      displayed = after;
      const result = diffEventModelProjects(this.state.before.project, after.project, { base: "Request " + this.state.context.request.id + " start", target: this.state.status === "completed" ? "Request reply (all edits)" : "Working tree (all edits)" });
      project = result.project;
      diff = result.diff;
    }
    return {
      sessionId: this.id, token: this.token, revision: this.current.revision,
      project: { ...project, graphSidecar: displayed.graphSidecar },
      validation: validateEventModelProject(displayed.project), diff,
      baseline: { kind: this.baseline.kind, label: this.baseline.label },
      error: this.error, stale: Boolean(this.error),
      feedback: {
        status: this.state.status,
        request: "context" in this.state ? this.state.context?.request : undefined,
        history: this.history,
        agent: { connected: this.lastSeen !== undefined && Date.now() - this.lastSeen < 60000, lastSeen: this.lastSeen }
      }
    };
  }

  submit(body: Record<string, unknown>): FeedbackRequest {
    const clientRequestId = textField(body.clientRequestId, "clientRequestId", 100);
    const message = textField(body.message, "message", 4000);
    const nodeId = textField(body.nodeId, "nodeId", 500);
    const revision = textField(body.revision, "revision", 100);
    const active = "context" in this.state ? this.state.context?.request : undefined;
    const known = active?.clientRequestId === clientRequestId ? active : this.history.find((item) => item.clientRequestId === clientRequestId);
    if (known?.clientRequestId === clientRequestId) {
      if (known.message !== message || known.nodeId !== nodeId) throw new FeedbackError(409, "Request ID already used with different content.");
      return known;
    }
    if (this.state.status === "stopped") throw new FeedbackError(409, "Feedback is stopped.");
    if (this.state.status === "working" || this.state.status === "queued") throw new FeedbackError(409, "Finish or stop the active request first.");
    const snapshot = this.refresh();
    if (revision !== snapshot.revision) throw new FeedbackError(409, "Model changed. Refresh and select the element again.");
    const node = snapshot.project.nodes.find((item) => item.id === nodeId);
    if (!node) throw new FeedbackError(409, "This element is no longer in the current model.");
    const request: FeedbackRequest = {
      id: randomUUID(), clientRequestId, message, nodeId, createdAt: Date.now(),
      reference: "em://" + (snapshot.graphSidecar?.model.id ?? "event_model") + "/" + nodeId
    };
    const yaml = (node.sourcePath && snapshot.files.get(node.sourcePath)) || node.raw || node.fields || node.description || node.label;
    if (yaml.length > 64000) throw new FeedbackError(413, "Selected source exceeds 64000 characters.");
    const related = snapshot.project.edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
    const context = JSON.stringify({ node, connections: related.map((edge) => ({ ...edge, sourceNode: snapshot.project.nodes.find((item) => item.id === edge.source), targetNode: snapshot.project.nodes.find((item) => item.id === edge.target) })) });
    if (context.length > 128000) throw new FeedbackError(413, "Connected context exceeds 128000 characters.");
    this.state = { status: "queued", context: { request, revision, sourcePath: node.sourcePath, yaml, context } };
    this.waiter?.();
    return request;
  }

  async poll(agent: unknown, signal?: AbortSignal, waitMs = 25000) {
    const agentId = textField(agent, "agent", 100);
    if (this.polling) throw new FeedbackError(409, "Only one poll may wait at a time.");
    if (this.state.status === "working" && this.state.agentId !== agentId) throw new FeedbackError(409, "Another agent owns the active request.");
    this.polling = true;
    this.lastSeen = Date.now();
    try {
      if (this.state.status !== "queued" && this.state.status !== "working" && this.state.status !== "stopped") {
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); this.waiter = undefined; resolve(); };
          const timer = setTimeout(finish, Math.min(25000, Math.max(0, waitMs)));
          this.waiter = finish;
          signal?.addEventListener("abort", finish, { once: true });
          if (signal?.aborted) finish();
        });
      }
      if (signal?.aborted) return { status: "disconnected", next_step: "Reconnect only if this session is still wanted." };
      this.lastSeen = Date.now();
      if (this.state.status === "stopped") return { status: "stopped", next_step: "Stop polling and stop editing. The server cannot stop your process." };
      if (this.state.status === "queued") {
        const before = this.refresh();
        if (before.revision !== this.state.context.revision) {
          this.archive({ ...this.state.context.request, reply: "Model changed before the agent started. Select the element and send again." });
          this.state = { status: "idle" };
          throw new FeedbackError(409, "Model changed before claim. Request cancelled.");
        }
        this.state.context.request.agentId = agentId;
        this.state = { status: "working", context: this.state.context, agentId, before };
      }
      if (this.state.status === "working") {
        return { status: "request", request: { ...this.state.context.request, sourcePath: this.state.context.sourcePath, yaml: this.state.context.yaml, context: this.state.context.context, projectRoot: this.current.project.root, revision: this.state.context.revision }, next_step: "Edit canonical YAML directly, validate it, then run emviz reply with this request ID and the same --url, --token, and --agent. Do not start a second request or commit/reset files automatically." };
      }
      return { status: "timeout", next_step: "Run emviz poll again with the same --url, --token, and --agent. Wait in the foreground." };
    } finally { this.polling = false; }
  }

  reply(body: Record<string, unknown>): FeedbackRequest {
    const id = textField(body.id, "id", 100);
    const agentId = textField(body.agent, "agent", 100);
    const reply = textField(body.reply, "reply", 8000);
    const recorded = this.history.find((entry) => entry.id === id && entry.agentId === agentId && entry.reply !== undefined);
    if (recorded) {
      if (recorded.reply !== reply) throw new FeedbackError(409, "Reply already recorded with different content.");
      return recorded;
    }
    if (this.state.status !== "working" || this.state.context.request.id !== id || this.state.agentId !== agentId) throw new FeedbackError(409, "No matching request owned by this agent.");
    const after = this.refresh();
    const request = { ...this.state.context.request, reply };
    this.state = { ...this.state, status: "completed", context: { ...this.state.context, request }, after };
    this.lastSeen = Date.now();
    this.archive(request);
    return request;
  }

  stop(): void {
    const context = "context" in this.state ? this.state.context : undefined;
    if (context) this.archive(context.request);
    this.state = { status: "stopped", context };
    this.lastSeen = undefined;
    this.waiter?.();
  }

  start(): void {
    if (this.state.status !== "stopped") throw new FeedbackError(409, "Session is already running.");
    this.state = { status: "idle" };
  }
}

export function trustedRequest(req: IncomingMessage, port: number): boolean {
  const allowed = new Set(["localhost:" + port, "127.0.0.1:" + port]);
  const host = req.headers.host;
  if (!host || !allowed.has(host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === "http://" + host;
}

export function validToken(req: IncomingMessage, expected: string): boolean {
  const token = req.headers["x-emviz-token"];
  if (typeof token !== "string") return false;
  const actual = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new FeedbackError(415, "Use application/json.");
  const content = await new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    let failed = false;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > 32768) {
        failed = true;
        parts.length = 0;
        reject(new FeedbackError(413, "Request exceeds 32 KiB."));
      } else parts.push(chunk);
    });
    req.once("end", () => { if (!failed) resolve(Buffer.concat(parts)); });
    req.once("error", reject);
    req.once("aborted", () => reject(new FeedbackError(400, "Request disconnected.")));
  });
  try {
    const value: unknown = JSON.parse(content.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new FeedbackError(400, "Expected a JSON object."); }
}

export async function handleFeedback(req: IncomingMessage, res: ServerResponse, session: FeedbackSession, close: () => void): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/session" && !url.pathname.startsWith("/api/feedback/")) return false;
  const send = (value: unknown) => { res.setHeader("content-type", "application/json; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === "/api/session" && req.method === "GET") {
      const view = url.searchParams.get("view") ?? "current";
      if (!["current", "session", "turn"].includes(view)) throw new FeedbackError(400, "Unknown view.");
      send(session.snapshot(view));
      return true;
    }
    if (!validToken(req, session.token)) throw new FeedbackError(403, "Invalid session token.");
    if (url.pathname === "/api/feedback/poll" && req.method === "GET") {
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const result = await session.poll(url.searchParams.get("agent"), controller.signal);
      if (!res.destroyed) send(result);
      return true;
    }
    if (req.method !== "POST") throw new FeedbackError(405, "Method not allowed.");
    const body = await readJson(req);
    switch (url.pathname) {
      case "/api/feedback/request": send(session.submit(body)); break;
      case "/api/feedback/reply": send({ request: session.reply(body), next_step: "Run emviz poll with the same connection options." }); break;
      case "/api/feedback/stop": session.stop(); send({ status: "stopped" }); break;
      case "/api/feedback/start": session.start(); send({ status: "idle" }); break;
      case "/api/feedback/close": session.stop(); send({ status: "closed" }); close(); break;
      default: throw new FeedbackError(404, "Unknown feedback endpoint.");
    }
  } catch (error) {
    if (!res.destroyed) { res.statusCode = error instanceof FeedbackError ? error.status : 500; send({ error: error instanceof Error ? error.message : String(error) }); }
  }
  return true;
}
