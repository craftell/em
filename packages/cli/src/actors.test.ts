import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FeedbackSession, readSnapshot } from "./feedback.js";

const roots: string[] = [];
const defaultRegistry = "event-model/actors.yaml";
const slicePath = "event-model/features/register.slice.yaml";
const original = { id: "customer", name: "Customer", color: "#123456" };

function write(root: string, source: string, content: string) {
  const target = path.join(root, source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function registry(name = original.name, color = original.color) {
  return JSON.stringify({ actors: { customer: { name, color } } });
}

function project(actorsFile = defaultRegistry, includeRegistry = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-actors-feedback-"));
  roots.push(root);
  write(root, ".event-modeling/config.yaml",
    "paths:\n  features_dir: event-model/features\n" +
    (actorsFile === defaultRegistry ? "" : "  actors_file: " + actorsFile + "\n"));
  write(root, "event-model/events.yaml", "events: {}\n");
  write(root, slicePath, "slice: Register\nscreen:\n  name: Registration\n  actors: [customer]\n");
  if (includeRegistry) write(root, actorsFile, registry());
  return root;
}

function request(session: FeedbackSession) {
  const current = session.snapshot("current");
  return {
    clientRequestId: "actor-edit",
    nodeId: current.project.nodes.find((node) => node.type === "screen")!.id,
    revision: current.revision,
    message: "Update the actor display name and color."
  };
}

function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });
}

function commit(root: string) {
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Actor baseline"]);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("actor snapshot sources", () => {
  it.each([defaultRegistry, "./metadata/people.yaml"])("collects and hashes the registry at %s", (actorsFile) => {
    const root = project(actorsFile);
    const source = actorsFile.replace(/^\.\//, "");
    const before = readSnapshot(root);

    expect(before.files.get(source)).toBe(registry());
    expect(before.project.config.paths.actorsFile).toBe(source);
    expect(before.project.actors).toEqual([original]);

    write(root, actorsFile, registry("Account holder", "#ABCDEF"));
    const changed = readSnapshot(root);
    expect(changed.revision).not.toBe(before.revision);
    expect(changed.project.actors).toEqual([{ id: "customer", name: "Account holder", color: "#ABCDEF" }]);

    fs.appendFileSync(path.join(root, actorsFile), "\n");
    const whitespace = readSnapshot(root);
    expect(whitespace.revision).not.toBe(changed.revision);
    expect(whitespace.project.actors).toEqual(changed.project.actors);
    expect(before.project.actors).toEqual([original]);
  });

  it("allows a missing registry and tracks later creation and removal", () => {
    const root = project(defaultRegistry, false);
    const absent = readSnapshot(root);
    expect(absent.files.has(defaultRegistry)).toBe(false);
    expect(absent.project.actors).toEqual([{
      id: "customer", name: "customer", color: expect.stringMatching(/^#[0-9A-F]{6}$/)
    }]);
    expect(absent.validation.findings.filter((finding) => finding.check === "A1")).toEqual([]);

    write(root, defaultRegistry, "actors: {}\n");
    const present = readSnapshot(root);
    expect(present.revision).not.toBe(absent.revision);
    expect(present.validation.findings).toContainEqual(expect.objectContaining({
      check: "A1", severity: "error", path: slicePath
    }));

    fs.rmSync(path.join(root, defaultRegistry));
    const removed = readSnapshot(root);
    expect(removed.revision).toBe(absent.revision);
    expect(removed.project.actors).toEqual(absent.project.actors);
    expect(removed.validation.findings.filter((finding) => finding.check === "A1")).toEqual([]);
  });

  it("reports malformed registry YAML without losing the rest of the snapshot", () => {
    const root = project();
    write(root, defaultRegistry, "actors:\n  customer: {}\n  customer: {}\n");
    const snapshot = readSnapshot(root);

    expect(snapshot.files.get(defaultRegistry)).toContain("actors:");
    expect(snapshot.project.nodes.some((node) => node.type === "screen")).toBe(true);
    expect(snapshot.validation.findings).toContainEqual(expect.objectContaining({
      check: "A1",
      severity: "error",
      path: defaultRegistry,
      message: expect.stringContaining("Invalid actor registry")
    }));
  });

  it("rejects an actor registry symlink outside the project", () => {
    const root = project(defaultRegistry, false);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-actors-outside-"));
    roots.push(outside);
    write(outside, "private.yaml", registry());
    fs.symlinkSync(path.join(outside, "private.yaml"), path.join(root, defaultRegistry));

    expect(() => readSnapshot(root)).toThrow("inside the project");
  });
});

describe("actor metadata in feedback sessions", () => {
  it.each([defaultRegistry, "./metadata/people.yaml"])("reads the old %s registry from the fixed Git baseline", (actorsFile) => {
    const root = project(actorsFile);
    git(root, ["init"]);
    commit(root);
    const baselineCommit = git(root, ["rev-parse", "HEAD"]).trim();
    write(root, actorsFile, registry("Account holder", "#ABCDEF"));

    const session = new FeedbackSession(root);
    const snapshot = session.snapshot("session");
    const screen = snapshot.project.nodes.find((node) => node.type === "screen")!;

    expect(snapshot.baseline).toEqual({ kind: "git", label: baselineCommit });
    expect(snapshot.diff!.nodeStatus[screen.id]).toBe("changed");
    expect(snapshot.diff!.summary.nodes.changed).toBe(1);
    expect(snapshot.diff!.previousNodes?.[screen.id].actorDefinitions).toEqual([original]);
    expect(screen.actorDefinitions).toEqual([{ id: "customer", name: "Account holder", color: "#ABCDEF" }]);

    commit(root);
    write(root, actorsFile, registry("Later name", "#654321"));
    const later = session.snapshot("session");
    expect(later.baseline).toEqual(snapshot.baseline);
    expect(later.diff!.previousNodes?.[screen.id].actorDefinitions).toEqual([original]);
  });

  it("freezes a completed turn's registry and old definitions across later edits", async () => {
    const root = project("./metadata/people.yaml");
    const session = new FeedbackSession(root);
    const submitted = session.submit(request(session));
    expect((await session.poll("test-agent")).status).toBe("request");

    write(root, "metadata/people.yaml", registry("Account holder", "#ABCDEF"));
    session.reply({ id: submitted.id, agent: "test-agent", reply: "Updated the actor." });
    const turn = session.snapshot("turn");
    const screen = turn.project.nodes.find((node) => node.type === "screen")!;
    const completed = { id: "customer", name: "Account holder", color: "#ABCDEF" };

    expect(turn.project.actors).toEqual([completed]);
    expect(screen.actorDefinitions).toEqual([completed]);
    expect(turn.diff!.nodeStatus[screen.id]).toBe("changed");
    expect(turn.diff!.previousNodes?.[screen.id].actorDefinitions).toEqual([original]);

    write(root, "metadata/people.yaml", registry("Later name", "#654321"));
    const current = session.snapshot("current");
    const frozen = session.snapshot("turn");
    expect(current.project.actors).toEqual([{ id: "customer", name: "Later name", color: "#654321" }]);
    expect(frozen.project).toEqual(turn.project);
    expect(frozen.diff).toEqual(turn.diff);
    expect(frozen.validation).toEqual(turn.validation);

    const sessionDiff = session.snapshot("session");
    expect(sessionDiff.diff!.previousNodes?.[screen.id].actorDefinitions).toEqual([original]);
    expect(sessionDiff.project.nodes.find((node) => node.id === screen.id)?.actorDefinitions).toEqual(current.project.actors);
  });

  it("rejects registry-only drift before a request is submitted or claimed", async () => {
    const root = project();
    const session = new FeedbackSession(root);
    const stale = request(session);

    fs.appendFileSync(path.join(root, defaultRegistry), "\n");
    expect(() => session.submit(stale)).toThrow("Model changed");
    session.submit(request(session));
    write(root, defaultRegistry, registry("Changed before claim", "#ABCDEF"));
    await expect(session.poll("test-agent")).rejects.toThrow("Model changed before claim");
    expect(session.snapshot("current").feedback.status).toBe("idle");
  });
});
