import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEventModelProject } from "./index.js";
import { loadEventModelProjectFromFiles, type InMemoryEventModelFile } from "./browser.js";

const roots: string[] = [];
const featurePath = "event-model/features/membership.feature.yaml";
const feature = `kind: feature
id: membership
schema_version: 1
name: Membership
stories:
  - id: register
    name: Registration
    slices: [event-model/features/register.slice.yaml]
  - id: profile
    name: Profile
    slices: [event-model/features/profile.slice.yaml]
  - id: leave
    name: Leave
    slices: [event-model/features/leave.slice.yaml]
timelines:
  - id: membership
    name: Membership lifecycle
    steps:
      - id: registration
        story: register
      - id: profile
        story: profile
        after: [registration]
      - id: leave
        story: leave
        after: [registration]
  - id: short
    name: Short lifecycle
    steps:
      - id: registration
        story: register
      - id: leave
        story: leave
        after: [registration]
`;

function files(content = feature): InMemoryEventModelFile[] {
  return [
    { path: ".event-modeling/config.yaml", content: "paths:\n  features_dir: event-model/features\n" },
    { path: "event-model/events.yaml", content: "events:\n  MemberRegistered:\n    fields: 'id: string'\n" },
    { path: featurePath, content },
    { path: "event-model/features/register.slice.yaml", content: "slice: Register\nscreen:\n  executes: [Register]\ncommands:\n  - name: Register\n    produces: [MemberRegistered]\n" },
    { path: "event-model/features/profile.slice.yaml", content: "slice: Profile\nscreen:\n  reads: [MemberForProfile]\nqueries:\n  - name: MemberForProfile\n    from_events: [MemberRegistered]\n" },
    { path: "event-model/features/leave.slice.yaml", content: "slice: Leave\nscreen:\n  reads: [MemberForLeave]\nqueries:\n  - name: MemberForLeave\n    from_events: [MemberRegistered]\n" }
  ];
}

function loadBoth(input: InMemoryEventModelFile[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emviz-feature-"));
  roots.push(root);
  for (const file of input) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
  }
  return [loadEventModelProject(root), loadEventModelProjectFromFiles(input, { root })];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("feature timelines", () => {
  it("loads bundled stories and reusable timelines identically from disk and browser", () => {
    const projects = loadBoth(files());
    expect(projects[0]).toEqual(projects[1]);
    const project = projects[0];
    expect(project.modelIssues).toEqual([]);
    expect(project.stories).toHaveLength(3);
    expect(project.timelines).toHaveLength(2);
    expect(project.timelines![0].steps[1].after).toEqual(["registration"]);
    expect(project.timelines![1].steps[0].storyId).toBe(project.timelines![0].steps[0].storyId);
    expect(project.nodes.filter((node) => node.type === "story")).toHaveLength(3);
    expect(new Set(project.nodes.map((node) => node.id)).size).toBe(project.nodes.length);
    expect(project.nodes.filter((node) => node.type === "story").every((node) => node.sourcePath === featurePath)).toBe(true);
  });

  it("does not turn layout predecessors into semantic edges", () => {
    const base = loadEventModelProjectFromFiles(files(feature));
    const reordered = loadEventModelProjectFromFiles(files(feature.replace("after: [registration]", "after: [leave]")));
    expect(reordered.edges).toEqual(base.edges);
    expect(base.edges.filter((edge) => edge.kind === "event-query")).toHaveLength(2);
    const profile = base.nodes.find((node) => node.type === "slice" && node.label === "Profile")!;
    const leave = base.nodes.find((node) => node.type === "slice" && node.label === "Leave")!;
    expect(base.edges.some((edge) => edge.source === profile.id && edge.target === leave.id)).toBe(false);
  });

  it.each([
    ["unknown version", feature.replace("schema_version: 1", "schema_version: 2"), "schema_version"],
    ["unknown kind", feature.replace("kind: feature", "kind: future"), "kind"],
    ["unknown story", feature.replace("story: profile", "story: missing"), "unknown story"],
    ["unknown predecessor", feature.replace("after: [registration]", "after: [missing]"), "unknown predecessor"],
    ["self cycle", feature.replace("after: [registration]", "after: [profile]"), "layout cycle"],
    ["duplicate step", feature.replace("id: profile\n        story:", "id: registration\n        story:"), "repeats step"],
    ["repeated story", feature.replace("story: profile", "story: register"), "repeats story"],
    ["malformed after", feature.replace("after: [registration]", "after: registration"), "after must be"],
    ["traversal", feature.replace("event-model/features/profile.slice.yaml", "../profile.slice.yaml"), "parent traversal"]
  ])("reports %s in both loaders", (_name, content, message) => {
    const projects = loadBoth(files(content));
    expect(projects[0]).toEqual(projects[1]);
    expect(projects[0].modelIssues!.some((issue) => issue.message.includes(message))).toBe(true);
  });

  it("diagnoses repeated slice paths inside one timeline", () => {
    const input = feature.replace("event-model/features/profile.slice.yaml", "event-model/features/register.slice.yaml");
    const project = loadEventModelProjectFromFiles(files(input));
    expect(project.modelIssues!.some((issue) => issue.message.includes("repeats slice"))).toBe(true);
    expect(project.timelines!.map((timeline) => timeline.name)).toEqual(["Short lifecycle"]);
  });

  it("keeps same-named stories in different feature files distinct", () => {
    const input = files();
    input.push({ path: "event-model/features/other.feature.yaml", content: `kind: feature
id: other
schema_version: 1
name: Other
stories:
  - id: register
    name: Registration
    slices: []
timelines:
  - id: main
    name: Other
    steps:
      - id: start
        story: register
` });
    const project = loadEventModelProjectFromFiles(input);
    const stories = project.nodes.filter((node) => node.type === "story" && node.label === "Registration");
    expect(stories).toHaveLength(2);
    expect(stories[0].id).not.toBe(stories[1].id);
    expect(stories[0].storyId).not.toBe(stories[1].storyId);
  });

  it("retains legacy stories and accepts explicit legacy headers", () => {
    const input = files();
    input.push({ path: "event-model/stories/legacy.yaml", content: "kind: story\nschema_version: 1\nname: Legacy\nslices: []\n" });
    const projects = loadBoth(input);
    expect(projects[0]).toEqual(projects[1]);
    expect(projects[0].stories.find((story) => story.name === "Legacy")?.id).toBeUndefined();
    expect(projects[0].modelIssues).toEqual([]);
  });

  it("reports unsupported metadata on legacy documents", () => {
    const input = files();
    input[3].content = "kind: slice\nschema_version: 9\n" + input[3].content;
    const projects = loadBoth(input);
    expect(projects[0]).toEqual(projects[1]);
    expect(projects[0].modelIssues!.some((issue) => issue.path === input[3].path && issue.message.includes("Unsupported"))).toBe(true);
  });

  it("keeps stable story identifiers when a display name changes", () => {
    const before = loadEventModelProjectFromFiles(files());
    const after = loadEventModelProjectFromFiles(files(feature.replace("name: Registration", "name: Sign up")));
    expect(before.nodes.filter((node) => node.type === "story").map((node) => node.id))
      .toEqual(after.nodes.filter((node) => node.type === "story").map((node) => node.id));
  });
});
