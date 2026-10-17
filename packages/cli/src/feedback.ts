import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEventModelProjectFromFiles, findProjectRoot, parseConfig, type EventModelProject, type ModelConfig } from "@emviz/parser";
import { diffEventModelProjects, type GraphSidecar } from "@emviz/graph";
import { validateEventModelProject } from "@emviz/validator";

export class FeedbackError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Snapshot = {
  project: EventModelProject;
  revision: string;
  files: Map<string, string>;
  graphSidecar: GraphSidecar | undefined;
  validation: ReturnType<typeof validateEventModelProject>;
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

function sourceKey(root: string, source: string): string {
  const relative = path.relative(root, path.resolve(root, source));
  if (path.isAbsolute(source) || relative.startsWith("..") || path.isAbsolute(relative)) throw new FeedbackError(400, "Model sources must stay inside the project directory.");
  return relative.split(path.sep).join("/");
}

function withinRoot(root: string, source: string): string {
  const key = sourceKey(root, source);
  const resolved = fs.realpathSync(path.resolve(root, key));
  const relative = path.relative(fs.realpathSync(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new FeedbackError(400, "Model sources must stay inside the project directory.");
  return resolved;
}

function sourceExists(root: string, source: string): boolean {
  try {
    fs.lstatSync(path.resolve(root, sourceKey(root, source)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function normalizedConfig(root: string, text: string): ModelConfig {
  const config = parseConfig(text);
  return { ...config, paths: {
    ...config.paths,
    eventModelDir: sourceKey(root, config.paths.eventModelDir),
    featuresDir: sourceKey(root, config.paths.featuresDir),
    eventsFile: sourceKey(root, config.paths.eventsFile),
    storiesDir: sourceKey(root, config.paths.storiesDir)
  } };
}

function parseFiles(root: string, files: Map<string, string>, config: ModelConfig): EventModelProject {
  const paths = config.paths;
  const normalized = JSON.stringify({ language: config.language, paths: {
    event_model_dir: paths.eventModelDir, features_dir: paths.featuresDir, events_file: paths.eventsFile,
    stories_dir: paths.storiesDir, slice_extension: paths.sliceExtension
  } });
  return loadEventModelProjectFromFiles([...files].map(([name, content]) => ({
    path: name, content: name === ".event-modeling/config.yaml" ? normalized : content
  })), { root });
}

export function readSnapshot(target: string): Snapshot {
  const root = findProjectRoot(target);
  const files = new Map<string, string>();
  let bytes = 0;
  const read = (source: string) => {
    const key = sourceKey(root, source);
    if (files.has(key)) return;
    const file = withinRoot(root, key);
    if (files.size >= 512 || fs.statSync(file).size + bytes > 8 * 1024 * 1024) throw new FeedbackError(413, "Feedback supports at most 512 files and 8 MiB.");
    const content = fs.readFileSync(file, "utf8");
    bytes += Buffer.byteLength(content);
    if (bytes > 8 * 1024 * 1024) throw new FeedbackError(413, "Model grew beyond 8 MiB while reading.");
    files.set(key, content);
  };
  read(".event-modeling/config.yaml");
  const config = normalizedConfig(root, files.get(".event-modeling/config.yaml")!);
  read(config.paths.eventsFile);
  let visitedEntries = 0;
  const walk = (directory: string, recursive: boolean, extension: string, visited = new Set<string>()) => {
    const key = sourceKey(root, directory);
    if (!sourceExists(root, key)) return;
    const resolved = withinRoot(root, key);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (++visitedEntries > 10000) throw new FeedbackError(413, "Model discovery exceeds 10000 directory entries.");
      if (entry.name.startsWith(".") || (key === "" && ["node_modules", "dist", "build"].includes(entry.name))) continue;
      const relative = path.posix.join(key, entry.name);
      const actual = withinRoot(root, relative);
      const stat = fs.statSync(actual);
      if (stat.isDirectory() && recursive) walk(relative, true, extension, visited);
      else if (stat.isFile() && entry.name.endsWith(extension)) read(relative);
    }
  };
  walk(config.paths.storiesDir, false, ".yaml");
  walk(config.paths.featuresDir, true, config.paths.sliceExtension);
  const preliminary = parseFiles(root, files, config);
  for (const source of preliminary.stories.flatMap((story) => story.slices)) {
    const key = sourceKey(root, source);
    if (sourceExists(root, key)) read(key);
  }
  if (sourceExists(root, ".event-modeling/graph.json")) read(".event-modeling/graph.json");
  const project = parseFiles(root, files, config);
  const sidecarText = files.get(".event-modeling/graph.json");
  const graphSidecar = sidecarText === undefined ? undefined : JSON.parse(sidecarText) as GraphSidecar;
  if (graphSidecar !== undefined && (
    !graphSidecar || typeof graphSidecar !== "object" ||
    typeof graphSidecar.model?.id !== "string" ||
    !graphSidecar.nodes || typeof graphSidecar.nodes !== "object" || Array.isArray(graphSidecar.nodes) ||
    Object.values(graphSidecar.nodes).some((node) => !node || typeof node.type !== "string" || !node.selector || typeof node.selector !== "object" || Object.values(node.selector).some((value) => typeof value !== "string"))
  )) throw new FeedbackError(422, "Invalid .event-modeling/graph.json.");
  const validation = validateEventModelProject(project, { sourcePaths: new Set(files.keys()), sidecar: graphSidecar });
  const hash = createHash("sha256");
  for (const [source, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const actual = withinRoot(root, source);
    if (fs.statSync(actual).size > 8 * 1024 * 1024 || fs.readFileSync(actual, "utf8") !== content) throw new FeedbackError(409, "Model changed while reading. Try again.");
    hash.update(JSON.stringify([source, content]));
  }
  return { project, revision: hash.digest("hex"), files, graphSidecar, validation };
}

function gitBaseline(snapshot: Snapshot): { project: EventModelProject; label: string; kind: "git" | "startup" } {
  const root = snapshot.project.root;
  try {
    const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
    const prefix = path.relative(repoRoot, root).split(path.sep).join("/");
    const names = git(["ls-tree", "--full-tree", "-r", "-z", "--name-only", commit, "--", prefix || "."]).split("\0").filter(Boolean);
    const tracked = new Set(names.map((name) => prefix ? name.slice(prefix.length + 1) : name));
    const files = new Map<string, string>();
    let bytes = 0;
    const read = (source: string) => {
      const key = sourceKey(root, source);
      if (files.has(key) || !tracked.has(key)) return;
      if (files.size >= 512) throw new Error("Git baseline exceeds 512 files.");
      const content = git(["show", commit + ":" + (prefix ? prefix + "/" : "") + key]);
      bytes += Buffer.byteLength(content);
      if (bytes > 8 * 1024 * 1024) throw new Error("Git baseline exceeds 8 MiB.");
      files.set(key, content);
    };
    read(".event-modeling/config.yaml");
    const rawConfig = files.get(".event-modeling/config.yaml");
    if (rawConfig === undefined) throw new Error("No model configuration at the baseline commit.");
    const config = normalizedConfig(root, rawConfig);
    read(config.paths.eventsFile);
    for (const key of tracked) {
      const isStory = (path.posix.dirname(key) === "." ? "" : path.posix.dirname(key)) === config.paths.storiesDir && !path.posix.basename(key).startsWith(".") && key.endsWith(".yaml");
      const relative = config.paths.featuresDir ? key.slice(config.paths.featuresDir.length + 1) : key;
      const ignored = relative.split("/").some((part) => part.startsWith(".")) || ["node_modules/", "dist/", "build/"].some((directory) => key.startsWith(directory));
      const isSlice = !ignored && (config.paths.featuresDir === "" || key.startsWith(config.paths.featuresDir + "/")) && key.endsWith(config.paths.sliceExtension);
      if (isStory || isSlice) read(key);
    }
    const preliminary = parseFiles(root, files, config);
    for (const source of preliminary.stories.flatMap((story) => story.slices)) read(source);
    return { project: parseFiles(root, files, config), label: commit, kind: "git" };
  } catch (error) {
    return { project: structuredClone(snapshot.project), label: "Startup snapshot (Git baseline unavailable: " + (error instanceof Error ? error.message.split("\n")[0] : "unknown error") + ")", kind: "startup" };
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
  private generation = 0;

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
      validation: displayed.validation, diff,
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
    const context = JSON.stringify({ node, validationFindings: snapshot.validation.findings.filter((finding) => finding.nodeId === nodeId || finding.path === node.sourcePath), connections: related.map((edge) => ({ ...edge, sourceNode: snapshot.project.nodes.find((item) => item.id === edge.source), targetNode: snapshot.project.nodes.find((item) => item.id === edge.target) })) });
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
    const generation = this.generation;
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
      if (generation !== this.generation || this.state.status === "stopped") return { status: "stopped", next_step: "Stop polling and stop editing. The server cannot stop your process." };
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
    this.generation += 1;
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
