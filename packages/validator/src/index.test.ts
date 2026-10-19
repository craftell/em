import { describe, expect, it } from "vitest";
import { loadEventModelProject, loadEventModelProjectFromFiles, type EventModelProject } from "@emviz/parser";
import { validateEventModelProject } from "./index.js";

describe("validateEventModelProject", () => {
  it("validates the sample event model without errors", () => {
    const project = loadEventModelProject(new URL("../../..", import.meta.url).pathname);
    const report = validateEventModelProject(project);

    expect(report.errors).toBe(0);
  });

  it("accepts past-tense tokens inside compound event names", () => {
    const project = {
      root: new URL("../../..", import.meta.url).pathname,
      config: {
        paths: {
          eventModelDir: "event-model",
          featuresDir: "event-model/features",
          sliceExtension: ".slice.yaml",
          eventsFile: "event-model/events.yaml",
          storiesDir: "event-model/stories"
        }
      },
      events: [{
        name: "BookingNotifiedToSiteController",
        fields: "- bookingId: string",
        sourcePath: "event-model/events.yaml"
      }],
      stories: [],
      slices: [{
        title: "Notify booking",
        path: "event-model/features/notify-booking/notify-booking.slice.yaml",
        screen: {
          type: "system",
          actors: [],
          reads: [],
          executes: []
        },
        commands: [{
          name: "NotifyBooking",
          fields: "- bookingId: string",
          produces: ["BookingNotifiedToSiteController"]
        }],
        queries: [],
        gwt: [{
          given: [],
          when: [{ type: "command", name: "NotifyBooking" }],
          then: [{ type: "event", name: "BookingNotifiedToSiteController" }]
        }],
        raw: ""
      }],
      nodes: [],
      edges: []
    } satisfies EventModelProject;

    const report = validateEventModelProject(project);

    expect(report.findings.some((finding) => finding.check === "C3")).toBe(false);
  });
});

it("reports invalid screen links as validation errors with the source path", () => {
  const sourcePath = "event-model/features/example.slice.yaml";
  const project = loadEventModelProjectFromFiles([
    { path: "event-model/events.yaml", content: "events: {}\n" },
    { path: sourcePath, content: "slice: Example\nscreen:\n  url: javascript:alert(1)\n" }
  ]);
  const report = validateEventModelProject(project, { sourcePaths: new Set([sourcePath]), sidecar: undefined });
  expect(report.errors).toBe(1);
  expect(report.findings.filter((finding) => finding.check === "L10")).toEqual([
    expect.objectContaining({ severity: "error", path: sourcePath, message: expect.stringContaining("screen.url") })
  ]);
});
