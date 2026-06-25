import { describe, expect, it } from "vitest";
import { loadEventModelProject } from "@emviz/parser";
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
