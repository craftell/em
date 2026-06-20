import { describe, expect, it } from "vitest";
import { loadEventModelProject } from "@emviz/parser";
import { validateEventModelProject } from "./index.js";

describe("validateEventModelProject", () => {
  it("validates the sample event model without errors", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const report = validateEventModelProject(project);

    expect(report.errors).toBe(0);
  });
});

