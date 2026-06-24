import { describe, expect, it } from "vitest";
import { loadEventModelProject, type EventModelProject } from "@emviz/parser";
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
