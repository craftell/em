import { describe, expect, it } from "vitest";
import { loadEventModelProject, loadEventModelProjectFromFiles } from "@emviz/parser";
import { buildGraphSidecar, diffEventModelProjects, resolveSidecarNode } from "./index.js";

describe("graph sidecar", () => {
  it("generates resolvable sidecar nodes for the sample model", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const sidecar = buildGraphSidecar(project);

    expect(sidecar.sources.slices).toEqual(["event-model/features/**/*.slice.yaml"]);
    expect(sidecar.nodes.evt_customer_registered).toBeDefined();
    expect(resolveSidecarNode(project, sidecar.nodes.evt_customer_registered)).toHaveLength(1);
  });
});

describe("graph diff", () => {
  it("keeps removed connections on their original slice when titles and node names repeat", () => {
    const files = [
      { path: "event-model/events.yaml", content: "events:\n  FirstSaved: {}\n  SecondSaved: {}\n" },
      ...["First", "Second"].map((name) => ({
        path: `event-model/features/${name}.slice.yaml`,
        content: `slice: Same title\nscreen:\n  executes: [Save]\ncommands:\n  - name: Save\n    produces: [${name}Saved]\n`
      }))
    ];
    const base = loadEventModelProjectFromFiles(files);
    const target = loadEventModelProjectFromFiles(files.map((file) => ({
      ...file,
      content: file.path.endsWith("First.slice.yaml") ? file.content.replace("[FirstSaved]", "[]") : file.content
    })));
    const firstCommand = target.nodes.find((node) => node.type === "command" && node.sourcePath?.endsWith("First.slice.yaml"))!;
    const result = diffEventModelProjects(base, target);
    const removedConnection = result.project.edges.find((edge) => result.diff.edgeStatus[edge.id] === "removed")!;
    expect(removedConnection.source).toBe(firstCommand.id);
    expect(result.project.nodes.find((node) => node.id === removedConnection.target)?.label).toBe("FirstSaved");
    expect(result.diff.summary.nodes).toEqual({ added: 0, removed: 0, changed: 0, unchanged: target.nodes.length });
    expect(new Set(result.project.edges.map((edge) => edge.id)).size).toBe(result.project.edges.length);
  });

  it("remaps connections correctly when adding a name collision changes an existing handle", () => {
    const files = [
      { path: "event-model/events.yaml", content: "events:\n  FirstSaved: {}\n  SecondSaved: {}\n" },
      { path: "event-model/features/First.slice.yaml", content: "slice: Same title\ncommands:\n  - name: Save\n    produces: [FirstSaved]\n" }
    ];
    const base = loadEventModelProjectFromFiles(files);
    const target = loadEventModelProjectFromFiles([
      ...files.map((file) => ({ ...file, content: file.content.replace("[FirstSaved]", "[]") })),
      { path: "event-model/features/Second.slice.yaml", content: "slice: Same title\ncommands:\n  - name: Save\n    produces: [SecondSaved]\n" }
    ]);
    const firstCommand = target.nodes.find((node) => node.type === "command" && node.sourcePath?.endsWith("First.slice.yaml"))!;
    expect(firstCommand.id).not.toBe(base.nodes.find((node) => node.type === "command")!.id);
    for (const [previous, next] of [[base, target], [target, base]]) {
      const result = diffEventModelProjects(previous, next);
      for (const edge of result.project.edges.filter((edge) => edge.kind === "command-event")) {
        const source = result.project.nodes.find((node) => node.id === edge.source)!;
        const event = result.project.nodes.find((node) => node.id === edge.target)!;
        expect(source.sourcePath).toBe(`event-model/features/${event.label.replace("Saved", "")}.slice.yaml`);
      }
    }
  });

  it("marks target-only graph elements as added", () => {
    const base = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const target = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "evt_trial_started",
          type: "event" as const,
          label: "TrialStarted",
          sourceName: "TrialStarted",
          sourcePath: "event-model/events.yaml"
        }
      ],
      edges: [
        ...base.edges,
        {
          id: "command-event:cmd_start_subscription->evt_trial_started",
          kind: "command-event" as const,
          source: "cmd_start_subscription",
          target: "evt_trial_started",
          label: "TrialStarted"
        }
      ]
    };

    const result = diffEventModelProjects(base, target);

    expect(result.diff.nodeStatus.evt_trial_started).toBe("added");
    expect(result.diff.edgeStatus["command-event:cmd_start_subscription->evt_trial_started"]).toBe("added");
    expect(result.diff.summary.nodes.added).toBe(1);
  });

  it("adds base-only graph elements to the merged project as removed ghosts", () => {
    const base = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const target = {
      ...base,
      nodes: base.nodes.filter((node) => node.id !== "evt_customer_registered"),
      edges: base.edges.filter((edge) => edge.source !== "evt_customer_registered" && edge.target !== "evt_customer_registered")
    };

    const result = diffEventModelProjects(base, target);

    expect(result.project.nodes.find((node) => node.id === "evt_customer_registered")).toBeDefined();
    expect(result.diff.nodeStatus.evt_customer_registered).toBe("removed");
    expect(result.diff.summary.nodes.removed).toBe(1);
  });

  it("marks semantic matches with changed content as changed", () => {
    const base = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const target = {
      ...base,
      nodes: base.nodes.map((node) => node.id === "evt_customer_registered" ? { ...node, fields: `${node.fields ?? ""}\nchangedAt: ISO timestamp` } : node)
    };

    const result = diffEventModelProjects(base, target);

    expect(result.diff.nodeStatus.evt_customer_registered).toBe("changed");
    expect(result.diff.summary.nodes.changed).toBe(1);
  });
});


it("keeps GWT old bodies, repeated names, slice identity and removed ID collisions separate", () => {
  const base = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
  const scenario = base.nodes.find((node) => node.type === "gwt")!;
  base.nodes = [
    { ...scenario, id: "one", sourcePath: "a.yaml", label: "Same", sourceName: "Same", description: "old first" },
    { ...scenario, id: "two", sourcePath: "a.yaml", label: "Same", sourceName: "Same", description: "old second" },
    { ...scenario, id: "three", sourcePath: "b.yaml", label: "Same", sourceName: "Same", description: "other slice" },
    { ...scenario, id: "collision", sourcePath: "a.yaml", label: "Removed", sourceName: "Removed", description: "deleted body" }
  ];
  base.edges = [];
  const target = structuredClone(base);
  target.nodes[1].description = "new second";
  target.nodes[3] = { ...target.nodes[3], label: "Added", sourceName: "Added", description: "added body" };
  const result = diffEventModelProjects(base, target);
  expect(result.diff.nodeStatus).toEqual({ one: "unchanged", two: "changed", three: "unchanged", collision: "added", "removed:collision": "removed" });
  expect(result.diff.previousGwtNodes?.two.description).toBe("old second");
  expect(result.project.nodes.map((node) => node.id)).toEqual(["one", "two", "three", "collision", "removed:collision"]);
  expect(result.project.nodes.at(-1)?.description).toBe("deleted body");
  expect(base.nodes[1].description).toBe("old second");
});
