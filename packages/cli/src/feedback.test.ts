import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FeedbackSession, handleFeedback, trustedRequest, readSnapshot } from "./feedback.js";
import { writeGraphSidecar } from "@emviz/graph";
import { parseConnection } from "./agent-cli.js";

const roots: string[] = [];
const servers: http.Server[] = [];
const slice = "event-model/features/register.slice.yaml";
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-feedback-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".event-modeling"), { recursive: true });
  fs.mkdirSync(path.join(root, "event-model/features"), { recursive: true });
  fs.writeFileSync(path.join(root, ".event-modeling/config.yaml"), "paths:\n  features_dir: event-model/features\n");
  fs.writeFileSync(path.join(root, "event-model/events.yaml"), "events:\n  Registered:\n    fields: 'id: string'\n");
  fs.writeFileSync(path.join(root, slice), "slice: Register\nscreen:\n  name: Register form\n  executes: [Register]\ncommands:\n  - name: Register\n    fields: 'id: string'\n    produces: [Registered]\n");
  return root;
}
function request(session: FeedbackSession, clientRequestId = "one") {
  const current = session.snapshot("current");
  return { clientRequestId, nodeId: current.project.nodes.find((node) => node.type === "command")!.id, revision: current.revision, message: "Add email." };
}
function edit(root: string) {
  fs.appendFileSync(path.join(root, slice), "queries:\n  - name: Account\n    fields: 'email: string'\n    from_events: [Registered]\n");
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("external feedback", () => {
  it("delivers selected source and context, freezes a completed turn, and keeps later edits in the session diff", async () => {
    const root = project();
    const session = new FeedbackSession(root);
    const input = request(session);
    const submitted = session.submit(input);
    expect(session.submit(input).id).toBe(submitted.id);
    const polled = await session.poll("agent");
    expect(polled.status).toBe("request");
    if (!("request" in polled) || !polled.request) throw new Error("Missing request");
    expect(polled.request.yaml).toContain("slice: Register");
    expect(polled.request.context).toContain("Registered");
    expect(polled.request.projectRoot).toBe(root);
    edit(root);
    session.reply({ id: submitted.id, agent: "agent", reply: "Added Account query." });
    const turn = session.snapshot("turn");
    expect(turn.diff!.summary.nodes.added).toBe(1);
    fs.appendFileSync(path.join(root, "event-model/events.yaml"), "  Other: {}\n");
    expect(session.snapshot("turn").diff).toEqual(turn.diff);
    expect(session.snapshot("session").diff!.summary.nodes.added).toBe(2);
    expect(session.reply({ id: submitted.id, agent: "agent", reply: "Added Account query." }).reply).toBe("Added Account query.");
    expect(session.snapshot("turn").diff).toEqual(turn.diff);
  });

  it("serializes agents, preserves retry ownership, cancels explicitly, and rejects late replies", async () => {
    const session = new FeedbackSession(project());
    const submitted = session.submit(request(session));
    await session.poll("first");
    await expect(session.poll("second")).rejects.toMatchObject({ status: 409 });
    expect((await session.poll("first")).status).toBe("request");
    expect(() => session.submit(request(session, "two"))).toThrow();
    session.stop();
    expect((await session.poll("first")).status).toBe("stopped");
    expect(() => session.reply({ id: submitted.id, agent: "first", reply: "Late" })).toThrow();
    session.start();
    expect(session.submit(request(session, "two")).id).not.toBe(submitted.id);
  });

  it("rejects raw-file drift before send and claim, including whitespace-only edits", async () => {
    const root = project();
    const session = new FeedbackSession(root);
    const stale = request(session);
    fs.appendFileSync(path.join(root, slice), "\n");
    expect(() => session.submit(stale)).toThrow("Model changed");
    session.submit(request(session));
    fs.appendFileSync(path.join(root, slice), "\n");
    await expect(session.poll("agent")).rejects.toThrow("Model changed before claim");
    expect(session.snapshot("current").feedback.status).toBe("idle");
  });

  it("does not accept a reply against an invalid model or discard the last valid graph", async () => {
    const root = project();
    const session = new FeedbackSession(root);
    const submitted = session.submit(request(session));
    await session.poll("agent");
    fs.writeFileSync(path.join(root, slice), "slice: [unterminated");
    expect(() => session.reply({ id: submitted.id, agent: "agent", reply: "Done" })).toThrow();
    const stale = session.snapshot("current");
    expect(stale.stale).toBe(true);
    expect(stale.error).toBeTruthy();
    expect(stale.project.nodes.some((node) => node.type === "command")).toBe(true);
    expect(stale.feedback.status).toBe("working");
  });

  it("long-polls until a request arrives and releases a disconnected waiter", async () => {
    const session = new FeedbackSession(project());
    const waiting = session.poll("agent");
    await expect(session.poll("agent")).rejects.toMatchObject({ status: 409 });
    session.submit(request(session));
    expect((await waiting).status).toBe("request");
    session.stop();
    session.start();
    const controller = new AbortController();
    const disconnected = session.poll("agent", controller.signal);
    controller.abort();
    expect((await disconnected).status).toBe("disconnected");
    expect((await session.poll("agent", undefined, 0)).status).toBe("timeout");
  });

  it("uses one fixed Git commit and includes untracked YAML", () => {
    const root = project();
    const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base"]);
    const session = new FeedbackSession(root);
    const baseline = session.snapshot("session").baseline;
    expect(baseline.kind).toBe("git");
    fs.writeFileSync(path.join(root, "event-model/features/untracked.slice.yaml"), "slice: Other\nscreen:\n  name: Other\n");
    expect(session.snapshot("session").diff!.summary.nodes.added).toBeGreaterThan(0);
    git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Later"]);
    expect(session.snapshot("session").baseline).toEqual(baseline);
    expect(session.snapshot("current").project.nodes.some((node) => node.label === "Other")).toBe(true);
  });

  it.each([".", "nested"])("reads the fixed Git baseline through a directory alias at %s", (directory) => {
    const root = project();
    // Keep the nested fixture in its own repository, outside any existing checkout.
    const gitRoot = directory === "." ? root : fs.mkdtempSync(path.join(os.tmpdir(), "emviz-baseline-repo-"));
    if (directory !== ".") {
      roots.push(gitRoot);
      fs.cpSync(root, path.join(gitRoot, directory), { recursive: true });
    }
    const git = (args: string[]) => execFileSync("git", ["-C", gitRoot, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Alias baseline"]);
    const commit = git(["rev-parse", "HEAD"]).toString().trim();
    const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-baseline-alias-"));
    roots.push(aliasParent);
    const alias = path.join(aliasParent, "project");
    fs.symlinkSync(gitRoot, alias, "dir");
    const target = path.join(alias, directory);
    edit(target);

    const snapshot = new FeedbackSession(target).snapshot("session");
    expect(snapshot.baseline).toEqual({ kind: "git", label: commit });
    expect(snapshot.diff!.summary.nodes.added).toBe(1);
    expect(snapshot.diff!.summary.nodes.removed).toBe(0);
  });

  it("rejects oversized or conflicting messages", () => {
    const session = new FeedbackSession(project());
    const input = request(session);
    expect(() => session.submit({ ...input, message: "x".repeat(4001) })).toThrow();
    session.submit(input);
    expect(() => session.submit({ ...input, message: "Different" })).toThrow();
  });
});

describe("HTTP boundary", () => {
  it("requires the exact loopback Host and same-origin Origin", () => {
    const req = (host: string, origin?: string) => ({ headers: { host, origin } }) as http.IncomingMessage;
    expect(trustedRequest(req("127.0.0.1:5173"), 5173)).toBe(true);
    expect(trustedRequest(req("localhost:5173", "http://localhost:5173"), 5173)).toBe(true);
    expect(trustedRequest(req("evil.example:5173"), 5173)).toBe(false);
    expect(trustedRequest(req("localhost:5173", "https://evil.example"), 5173)).toBe(false);
    expect(trustedRequest(req("localhost:5174"), 5173)).toBe(false);
  });

  it("requires the session capability and bounds JSON at the real HTTP endpoint", async () => {
    const session = new FeedbackSession(project());
    const server = http.createServer((req, res) => { void handleFeedback(req, res, session, () => {}).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } }); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    expect((await fetch(url + "/api/feedback/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request(session)) })).status).toBe(403);
    const headers = { "Content-Type": "application/json", "X-Emviz-Token": session.token };
    expect((await fetch(url + "/api/feedback/request", { method: "POST", headers, body: JSON.stringify({ ...request(session), message: "x".repeat(40000) }) })).status).toBe(413);
    expect((await fetch(url + "/api/feedback/request", { method: "POST", headers, body: "null" })).status).toBe(400);
    expect((await fetch(url + "/api/feedback/request", { method: "POST", headers, body: JSON.stringify(request(session)) })).status).toBe(200);
  });

  it("never sends a capability to an external CLI destination", () => {
    expect(() => parseConnection(["--url", "https://example.com/", "--token", "token"])).toThrow();
    expect(() => parseConnection(["--url", "http://localhost.evil/", "--token", "token"])).toThrow();
    expect(parseConnection(["--url", "http://127.0.0.1:5173/", "--token", "token"]).url.hostname).toBe("127.0.0.1");
  });
});

describe("snapshot source boundary", () => {
  it("rejects a dangling sidecar symlink before initial sync can create an external file", () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-outside-test-"));
    roots.push(outside);
    const destination = path.join(outside, "graph.json");
    fs.symlinkSync(destination, path.join(root, ".event-modeling/graph.json"));
    expect(() => {
      const initial = readSnapshot(root);
      if (!initial.graphSidecar) writeGraphSidecar(initial.project);
    }).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rejects out-of-root story paths and source symlinks before parsing their contents", () => {
    const root = project();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-outside-test-"));
    roots.push(outside);
    fs.writeFileSync(path.join(outside, "private.yaml"), "secret: [invalid");
    fs.mkdirSync(path.join(root, "event-model/stories"));
    fs.writeFileSync(path.join(root, "event-model/stories/unsafe.yaml"), "name: Unsafe\nslices:\n  - " + path.relative(root, path.join(outside, "private.yaml")) + "\n");
    expect(() => readSnapshot(root)).toThrow("inside the project");
    fs.rmSync(path.join(root, "event-model/stories/unsafe.yaml"));
    fs.symlinkSync(path.join(outside, "private.yaml"), path.join(root, "event-model/features/unsafe.slice.yaml"));
    expect(() => readSnapshot(root)).toThrow("inside the project");
  });

  it("retains frozen validation and last-good data when live sidecar or files change", async () => {
    const root = project();
    const session = new FeedbackSession(root);
    const submitted = session.submit(request(session));
    await session.poll("agent");
    session.reply({ id: submitted.id, agent: "agent", reply: "No edit needed." });
    const turn = session.snapshot("turn");
    fs.writeFileSync(path.join(root, ".event-modeling/graph.json"), "{bad json");
    const stale = session.snapshot("current");
    expect(stale.stale).toBe(true);
    expect(stale.validation).toEqual(turn.validation);
    expect(session.snapshot("turn").validation).toEqual(turn.validation);
    fs.rmSync(path.join(root, ".event-modeling/graph.json"));
    fs.rmSync(path.join(root, slice));
    expect(session.snapshot("turn").project).toEqual(turn.project);
    expect(session.snapshot("turn").validation).toEqual(turn.validation);
  });

  it("keeps normalized custom paths and explicit story slices in a nested Git baseline", async () => {
    const repo = project();
    fs.rmSync(path.join(repo, ".event-modeling"), { recursive: true });
    fs.rmSync(path.join(repo, "event-model"), { recursive: true });
    const root = path.join(repo, "nested");
    fs.mkdirSync(path.join(root, ".event-modeling"), { recursive: true });
    fs.mkdirSync(path.join(root, "models/stories"), { recursive: true });
    fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".event-modeling/config.yaml"), "paths:\n  events_file: ./models/registry.yaml\n  stories_dir: ./models/stories\n  features_dir: ./models/features\n");
    fs.writeFileSync(path.join(root, "models/registry.yaml"), "events:\n  Saved:\n    fields: 'id: string'\n");
    fs.writeFileSync(path.join(root, "models/stories/main.yaml"), "name: Main\nslices:\n  - ./workflows/save.yaml\n");
    fs.writeFileSync(path.join(root, "workflows/save.yaml"), "slice: Save\ncommands:\n  - name: Save\n    produces: [Saved]\n");
    const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Nested"]);
    const session = new FeedbackSession(root);
    const snapshot = session.snapshot("session");
    expect(snapshot.baseline.kind).toBe("git");
    expect(snapshot.diff!.summary.nodes.added).toBe(0);
    expect(snapshot.diff!.summary.nodes.removed).toBe(0);
    const event = snapshot.project.nodes.find((node) => node.type === "event")!;
    session.submit({ clientRequestId: "event", revision: snapshot.revision, nodeId: event.id, message: "Inspect" });
    const result = await session.poll("agent");
    if (!("request" in result) || !result.request) throw new Error("Missing request");
    expect(result.request.yaml).toContain("events:");
    expect(result.request.sourcePath).toBe("models/registry.yaml");
  });

  it("bounds file bytes before YAML parsing", () => {
    const root = project();
    fs.writeFileSync(path.join(root, slice), "x".repeat(8 * 1024 * 1024 + 1));
    expect(() => readSnapshot(root)).toThrow("8 MiB");
  });
});

it("does not revive an old waiting poll when stop and resume arrive together", async () => {
  const session = new FeedbackSession(project());
  const waiting = session.poll("agent");
  session.stop();
  session.start();
  expect((await waiting).status).toBe("stopped");
  expect((await session.poll("new-agent", undefined, 0)).status).toBe("timeout");
});
