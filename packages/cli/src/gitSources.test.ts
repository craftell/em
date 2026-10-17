import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadEventModelProject } from "@emviz/parser";
import { materializeGitRef } from "./gitSources.js";

const roots: string[] = [];
const oldActor = { id: "customer", name: "Old customer", color: "#123456" };
const newActor = { id: "customer", name: "New customer", color: "#ABCDEF" };

function write(root: string, source: string, content: string) {
  const target = path.join(root, source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function registry(actor: typeof oldActor) {
  return JSON.stringify({ actors: { customer: { name: actor.name, color: actor.color } } });
}

function fixture(actorsFile: string, includeRegistry = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-actors-git-"));
  roots.push(root);
  write(root, ".event-modeling/config.yaml", JSON.stringify({
    paths: { features_dir: "event-model/features", actors_file: actorsFile }
  }));
  write(root, "event-model/events.yaml", "events: {}\n");
  write(root, "event-model/features/register.slice.yaml", "slice: Register\nscreen:\n  actors: [customer]\n");
  if (includeRegistry) write(root, actorsFile, registry(oldActor));
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git(["init"]);
  git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Actor registry baseline"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("actor registries in materialized Git refs", () => {
  it.each([
    "event-model/actors.yaml",
    "./metadata/役割.yaml",
    "./metadata/role\nnames.yaml"
  ])("copies historical metadata from %j rather than the working tree", (actorsFile) => {
    const root = fixture(actorsFile);
    write(root, actorsFile, registry(newActor));
    const copied = materializeGitRef("HEAD", root);
    roots.push(copied);
    const historical = loadEventModelProject(copied);
    const current = loadEventModelProject(root);

    expect(fs.readFileSync(path.join(copied, actorsFile), "utf8")).toBe(registry(oldActor));
    expect(historical.actors).toEqual([oldActor]);
    expect(historical.nodes.find((node) => node.type === "screen")?.actorDefinitions).toEqual([oldActor]);
    expect(historical.actorIssues).toEqual([]);
    expect(current.actors).toEqual([newActor]);
  });

  it.each(["event-model/actors.yaml", "./metadata/役割.yaml"])("keeps a missing optional %s registry compatible with legacy references", (actorsFile) => {
    const root = fixture(actorsFile, false);
    write(root, actorsFile, registry(newActor));
    const copied = materializeGitRef("HEAD", root);
    roots.push(copied);
    const historical = loadEventModelProject(copied);

    expect(fs.existsSync(path.join(copied, actorsFile))).toBe(false);
    expect(historical.actors).toEqual([{
      id: "customer", name: "customer", color: expect.stringMatching(/^#[0-9A-F]{6}$/)
    }]);
    expect(historical.actorIssues).toEqual([]);
  });
});
