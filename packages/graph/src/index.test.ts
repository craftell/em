import { describe, expect, it } from "vitest";
import { loadEventModelProject } from "@emviz/parser";
import { buildGraphSidecar, resolveSidecarNode } from "./index.js";

describe("graph sidecar", () => {
  it("generates resolvable sidecar nodes for the sample model", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const sidecar = buildGraphSidecar(project);

    expect(sidecar.sources.slices).toEqual(["event-model/features/**/*.slice.yaml"]);
    expect(sidecar.nodes.evt_customer_registered).toBeDefined();
    expect(resolveSidecarNode(project, sidecar.nodes.evt_customer_registered)).toHaveLength(1);
  });
});

